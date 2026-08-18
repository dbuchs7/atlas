package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Process documentation (ADR-0138): a BPMN process published as one structured
// PDF — the diagram plus every element's documentation text and the annotations
// attached to it — so a reader outside Atlas can be handed the whole process.
//
// This is design-time state. Producing a document puts nothing in the event log
// and never participates in replay; the per-processId version counter is rebuilt
// from these records at startup, the discipline loadDeployments and
// loadReleaseVersions already follow.

// processDocElement is one BPMN element as it was documented: the prose a reader
// needs about it, snapshotted at publish time so a later edit to the model cannot
// rewrite what an already-published version says.
type processDocElement struct {
	ID   string `json:"id"`
	Type string `json:"type"` // the BPMN type, e.g. "bpmn:ServiceTask"
	Name string `json:"name,omitempty"`
	// Documentation is the element's <bpmn:documentation> text.
	Documentation string `json:"documentation,omitempty"`
	// Annotations are the <bpmn:textAnnotation> notes associated with this element,
	// in the order they were found. An annotation attached to nothing is documented
	// against the process itself rather than dropped.
	Annotations []string `json:"annotations,omitempty"`
	// Lane names the swimlane the element sits in, empty when the model has none
	// (ADR-0121).
	Lane string `json:"lane,omitempty"`
}

// processDoc is one published documentation version of a process: immutable
// metadata describing what was documented, with the PDF stored beside it.
type processDoc struct {
	ID string `json:"id"`
	// ProcessID is the BPMN process id the document describes. It binds to the id,
	// not a deployment, because a process is documented whether or not it is
	// currently deployed.
	ProcessID   string `json:"processId"`
	ProcessName string `json:"processName,omitempty"`
	// Version is a per-processId counter, 1-based — the ADR-0128 layering above the
	// ADR-0019 per-process deployment version. It answers "which documented state of
	// this process is that?", not "which deployment".
	Version   int32  `json:"version"`
	Title     string `json:"title,omitempty"`
	Note      string `json:"note,omitempty"`
	CreatedAt int64  `json:"createdAt"`
	CreatedBy string `json:"createdBy,omitempty"`
	// DeploymentKey and DeploymentVersion record which deployment was live when the
	// document was produced, zero when the model was documented from a draft.
	DeploymentKey     uint64 `json:"deploymentKey,omitempty"`
	DeploymentVersion int32  `json:"deploymentVersion,omitempty"`
	PDFSize           int64  `json:"pdfSize"`
	// Elements is the documented element prose, snapshotted by value.
	Elements []processDocElement `json:"elements,omitempty"`
	// XML is the BPMN source the document was produced from, so a reader of the
	// history can recover the exact model a version describes.
	XML string `json:"xml,omitempty"`
	// ShareToken is the opaque handle that serves this version's PDF without a
	// login (ADR-0029's mechanism). Empty means unshared, which is the default —
	// the artifact leaves the system only when someone says so.
	ShareToken string `json:"shareToken,omitempty"`
}

// newProcessDocID mints a version id. 16 bytes of crypto randomness hex-encoded
// is filename-safe (so the id is its own store key) and collision-free in
// practice.
func newProcessDocID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("processdocstore: random: %w", err)
	}
	return hex.EncodeToString(b[:]), nil
}

// processDocStore is a durable sidecar store for documentation versions: one
// JSON record per version with the PDF beside it under the same id. It mirrors
// the release and public-link stores (ADR-0019/0021/0128) and, like them, is
// owned solely by the server's run-loop goroutine, so it needs no locking.
type processDocStore struct {
	dir string
}

func newProcessDocStore(dir string) (*processDocStore, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("processdocstore: create dir: %w", err)
	}
	return &processDocStore{dir: dir}, nil
}

// fileFor maps a version id to its record path, pdfFileFor to its document. The
// id is bare hex, so it is already a safe filename; every entry point validates
// that before touching the filesystem.
func (s *processDocStore) fileFor(id string) string {
	return filepath.Join(s.dir, id+".json")
}

func (s *processDocStore) pdfFileFor(id string) string {
	return filepath.Join(s.dir, id+".pdf")
}

// save writes a version durably: the PDF first, then the record. The order
// matters — a record is the thing readers discover, so it must never point at a
// document that is not yet on disk (I2).
func (s *processDocStore) save(rec processDoc, pdf []byte) error {
	if !isHexToken(rec.ID) {
		return fmt.Errorf("processdocstore: refusing unsafe id %q", rec.ID)
	}
	if err := atomicWriteFile(s.dir, s.pdfFileFor(rec.ID), pdf); err != nil {
		return err
	}
	return s.saveRecord(rec)
}

// saveRecord rewrites only the metadata sidecar, leaving the stored PDF alone.
// Minting or revoking a share token is such an update: the document is immutable,
// who may read it is not.
func (s *processDocStore) saveRecord(rec processDoc) error {
	if !isHexToken(rec.ID) {
		return fmt.Errorf("processdocstore: refusing unsafe id %q", rec.ID)
	}
	return atomicWriteJSON(s.dir, s.fileFor(rec.ID), rec)
}

func (s *processDocStore) get(id string) (processDoc, bool, error) {
	if !isHexToken(id) {
		return processDoc{}, false, nil
	}
	data, err := os.ReadFile(s.fileFor(id))
	if err != nil {
		if os.IsNotExist(err) {
			return processDoc{}, false, nil
		}
		return processDoc{}, false, fmt.Errorf("processdocstore: read: %w", err)
	}
	var rec processDoc
	if err := json.Unmarshal(data, &rec); err != nil {
		return processDoc{}, false, fmt.Errorf("processdocstore: decode: %w", err)
	}
	return rec, true, nil
}

// pdf returns a version's document bytes. An unknown or unsafe id is an error
// rather than an empty document, so a handler cannot serve a zero-byte PDF as if
// it were real.
func (s *processDocStore) pdf(id string) ([]byte, error) {
	if !isHexToken(id) {
		return nil, fmt.Errorf("processdocstore: refusing unsafe id %q", id)
	}
	data, err := os.ReadFile(s.pdfFileFor(id))
	if err != nil {
		return nil, fmt.Errorf("processdocstore: read pdf: %w", err)
	}
	return data, nil
}

// loadAll reads every version, grouped by process id with the newest version
// first — the order the history view wants. Files that are not records are
// ignored; a record that is present but undecodable is an error, because losing
// history silently is worse than reporting a fault.
func (s *processDocStore) loadAll() ([]processDoc, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, fmt.Errorf("processdocstore: read dir: %w", err)
	}
	var out []processDoc
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".json") {
			continue
		}
		if !isHexToken(strings.TrimSuffix(name, ".json")) {
			continue
		}
		data, err := os.ReadFile(filepath.Join(s.dir, name))
		if err != nil {
			return nil, fmt.Errorf("processdocstore: read %s: %w", name, err)
		}
		var rec processDoc
		if err := json.Unmarshal(data, &rec); err != nil {
			return nil, fmt.Errorf("processdocstore: decode %s: %w", name, err)
		}
		out = append(out, rec)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ProcessID != out[j].ProcessID {
			return out[i].ProcessID < out[j].ProcessID
		}
		if out[i].Version != out[j].Version {
			return out[i].Version > out[j].Version
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

// forProcess returns one process's documentation history, newest version first.
func (s *processDocStore) forProcess(processID string) ([]processDoc, error) {
	all, err := s.loadAll()
	if err != nil {
		return nil, err
	}
	out := []processDoc{}
	for _, rec := range all {
		if rec.ProcessID == processID {
			out = append(out, rec)
		}
	}
	return out, nil
}

// byShareToken finds the version a public token addresses. An empty token never
// matches, so the many unshared records — which carry no token — stay private.
func (s *processDocStore) byShareToken(token string) (processDoc, bool, error) {
	if !isHexToken(token) {
		return processDoc{}, false, nil
	}
	all, err := s.loadAll()
	if err != nil {
		return processDoc{}, false, err
	}
	for _, rec := range all {
		if rec.ShareToken == token {
			return rec, true, nil
		}
	}
	return processDoc{}, false, nil
}

// delete removes a version and its document. A missing file is not an error, so
// cleanup is idempotent.
func (s *processDocStore) delete(id string) error {
	if !isHexToken(id) {
		return nil
	}
	for _, path := range []string{s.fileFor(id), s.pdfFileFor(id)} {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("processdocstore: remove: %w", err)
		}
	}
	return fsyncDir(s.dir)
}

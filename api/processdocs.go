package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Process documentation export (ADR-0138). The document itself is produced in the
// browser, where bpmn-js already holds the authoritative picture; this file is the
// server half — it validates what arrives, numbers it as the next version of that
// process, stores it durably, and serves it back, optionally through a revocable
// public link.
//
// Design-time only: nothing here reaches the event log, the processor, or
// recovery.

// maxProcessDocBytes caps a documentation upload. A document is a diagram raster
// plus its element prose; this is a sanity bound on the base64-carrying request
// body, not a tuning knob.
const maxProcessDocBytes = 24 << 20 // 24 MiB

// pdfMagic is the header every PDF opens with. The server stores opaque bytes,
// but it refuses to store something that is plainly not a document — otherwise a
// mistaken upload only reveals itself to the reader who opens the share link.
var pdfMagic = []byte("%PDF-")

// processDocResp is one documentation version as the API renders it. Elements and
// XML are carried only by the single-version fetch: a history listing is a
// summary, and hauling every version's whole BPMN source through it would make
// the common read the expensive one.
type processDocResp struct {
	ID                string `json:"id"`
	ProcessID         string `json:"processId"`
	ProcessName       string `json:"processName,omitempty"`
	Version           int32  `json:"version"`
	Title             string `json:"title,omitempty"`
	Note              string `json:"note,omitempty"`
	CreatedAt         int64  `json:"createdAt"`
	CreatedBy         string `json:"createdBy,omitempty"`
	DeploymentKey     uint64 `json:"deploymentKey,omitempty"`
	DeploymentVersion int32  `json:"deploymentVersion,omitempty"`
	PDFSize           int64  `json:"pdfSize"`
	ElementCount      int    `json:"elementCount"`
	PDFURL            string `json:"pdfUrl"`
	// ShareToken and ShareURL are present only while the version is shared, so
	// their absence is the UI's signal that it is private.
	ShareToken string              `json:"shareToken,omitempty"`
	ShareURL   string              `json:"shareUrl,omitempty"`
	Elements   []processDocElement `json:"elements,omitempty"`
	XML        string              `json:"xml,omitempty"`
}

// toProcessDocResp renders a stored version. detail asks for the element prose
// and the BPMN source; a listing passes false.
func toProcessDocResp(rec processDoc, detail bool) processDocResp {
	out := processDocResp{
		ID: rec.ID, ProcessID: rec.ProcessID, ProcessName: rec.ProcessName,
		Version: rec.Version, Title: rec.Title, Note: rec.Note,
		CreatedAt: rec.CreatedAt, CreatedBy: rec.CreatedBy,
		DeploymentKey: rec.DeploymentKey, DeploymentVersion: rec.DeploymentVersion,
		PDFSize: rec.PDFSize, ElementCount: len(rec.Elements),
		PDFURL: "/api/v1/documentation/" + rec.ID + "/pdf",
	}
	if rec.ShareToken != "" {
		out.ShareToken = rec.ShareToken
		out.ShareURL = publicProcessDocPath + rec.ShareToken
	}
	if detail {
		out.Elements = rec.Elements
		out.XML = rec.XML
	}
	return out
}

// publicProcessDocPath is the prefix of the unauthenticated share URL. It lives
// in one place so the minted URL and the served route cannot drift.
const publicProcessDocPath = "/public/process-docs/"

// loadProcessDocVersions rebuilds the per-process documentation counter from the
// durable records, so an export after a restart continues the sequence rather than
// restarting it at v1 and overwriting history. It runs before the loop serves
// traffic, so touching the map directly here respects the single-writer invariant.
func (s *Server) loadProcessDocVersions() error {
	recs, err := s.processDocs.loadAll()
	if err != nil {
		return err
	}
	for _, rec := range recs {
		if rec.Version > s.docVersions[rec.ProcessID] {
			s.docVersions[rec.ProcessID] = rec.Version
		}
	}
	return nil
}

// createProcessDocReq is the upload: the document plus what it documents. The PDF
// arrives base64-encoded inside the JSON body so the whole publication — prose,
// source, and document — is one atomic request rather than a multi-step upload
// that can half-fail.
type createProcessDocReq struct {
	Title       string              `json:"title"`
	Note        string              `json:"note"`
	ProcessName string              `json:"processName"`
	XML         string              `json:"xml"`
	Elements    []processDocElement `json:"elements"`
	PDFBase64   string              `json:"pdfBase64"`
}

// handleCreateProcessDoc records the next documentation version of a process
// (ADR-0138). Body: the produced PDF plus the element prose it describes.
func (s *Server) handleCreateProcessDoc(w http.ResponseWriter, r *http.Request) {
	processID := r.PathValue("processId")
	body, err := io.ReadAll(io.LimitReader(r.Body, maxProcessDocBytes))
	if err != nil {
		writeError(w, http.StatusBadRequest, "read body: "+err.Error())
		return
	}
	var payload createProcessDocReq
	if err := json.Unmarshal(body, &payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body: "+err.Error())
		return
	}
	if payload.PDFBase64 == "" {
		writeError(w, http.StatusBadRequest, "pdfBase64 is required")
		return
	}
	pdf, err := base64.StdEncoding.DecodeString(payload.PDFBase64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "pdfBase64 is not valid base64: "+err.Error())
		return
	}
	if !bytes.HasPrefix(pdf, pdfMagic) {
		writeError(w, http.StatusBadRequest, "the uploaded bytes are not a PDF document")
		return
	}

	id, err := newProcessDocID()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "mint documentation id: "+err.Error())
		return
	}
	title := strings.TrimSpace(payload.Title)
	if title == "" {
		title = processID
	}
	actor := ""
	if p := principalFrom(r.Context()); p != nil {
		actor = p.Username
	}

	rec := processDoc{
		ID: id, ProcessID: processID, ProcessName: payload.ProcessName,
		Title: title, Note: payload.Note,
		CreatedAt: time.Now().Unix(), CreatedBy: actor,
		PDFSize: int64(len(pdf)), Elements: payload.Elements, XML: payload.XML,
	}

	var opErr error
	s.do(func() {
		// A documented process that is deployed records which deployment it
		// described, so a reader of the history can tell which running version a
		// document belongs to. Read on the loop, which owns the registry.
		if d := s.latestDeploymentByProcessID(processID); d != nil {
			rec.DeploymentKey = d.Key
			rec.DeploymentVersion = d.Version
		}
		rec.Version = s.docVersions[processID] + 1
		if opErr = s.processDocs.save(rec, pdf); opErr != nil {
			return
		}
		// The counter advances only once the record is durable, so a failed save
		// cannot burn a version number.
		s.docVersions[processID] = rec.Version
	})
	if opErr != nil {
		writeError(w, http.StatusInternalServerError, "save documentation: "+opErr.Error())
		return
	}
	writeJSON(w, http.StatusOK, toProcessDocResp(rec, false))
}

// handleListProcessDocs returns one process's documentation history, newest
// version first.
func (s *Server) handleListProcessDocs(w http.ResponseWriter, r *http.Request) {
	processID := r.PathValue("processId")
	out := []processDocResp{}
	var loadErr error
	s.do(func() {
		recs, e := s.processDocs.forProcess(processID)
		if e != nil {
			loadErr = e
			return
		}
		for _, rec := range recs {
			out = append(out, toProcessDocResp(rec, false))
		}
	})
	if loadErr != nil {
		writeError(w, http.StatusInternalServerError, "list documentation: "+loadErr.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// lookupProcessDoc reads one version on the run loop. It is the shared prologue
// of every route that addresses a version by id.
func (s *Server) lookupProcessDoc(id string) (processDoc, bool, error) {
	var (
		rec   processDoc
		found bool
		err   error
	)
	s.do(func() { rec, found, err = s.processDocs.get(id) })
	return rec, found, err
}

// handleGetProcessDoc returns one version in full: its metadata, the element
// prose, and the BPMN source it was produced from.
func (s *Server) handleGetProcessDoc(w http.ResponseWriter, r *http.Request) {
	rec, found, err := s.lookupProcessDoc(r.PathValue("id"))
	switch {
	case err != nil:
		writeError(w, http.StatusInternalServerError, "read documentation: "+err.Error())
	case !found:
		writeError(w, http.StatusNotFound, "no documentation version with that id")
	default:
		writeJSON(w, http.StatusOK, toProcessDocResp(rec, true))
	}
}

// handleGetProcessDocPDF downloads a version's document.
func (s *Server) handleGetProcessDocPDF(w http.ResponseWriter, r *http.Request) {
	rec, found, err := s.lookupProcessDoc(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read documentation: "+err.Error())
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "no documentation version with that id")
		return
	}
	s.serveProcessDocPDF(w, rec)
}

// serveProcessDocPDF writes a version's document to the response. Shared by the
// authenticated download and the public share link so both serve identical bytes
// under identical headers.
func (s *Server) serveProcessDocPDF(w http.ResponseWriter, rec processDoc) {
	var (
		pdf []byte
		err error
	)
	s.do(func() { pdf, err = s.processDocs.pdf(rec.ID) })
	if err != nil {
		writeError(w, http.StatusNotFound, "the document for that version is not available")
		return
	}
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", "inline; filename=\""+processDocFilename(rec)+"\"")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(pdf)
}

// processDocFilename names the downloaded file after the process and version.
// Everything outside a conservative allowlist becomes '-', so the name cannot
// carry a quote, a path separator, or a header-splitting byte into the
// Content-Disposition header.
func processDocFilename(rec processDoc) string {
	var b strings.Builder
	for _, r := range rec.ProcessID {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	name := b.String()
	if name == "" {
		name = "process"
	}
	return name + "-v" + strconv.Itoa(int(rec.Version)) + ".pdf"
}

// handleShareProcessDoc mints (or returns the existing) public link for one
// version. Idempotent by design: re-sharing must not rotate a URL that readers
// already hold.
func (s *Server) handleShareProcessDoc(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var (
		rec   processDoc
		found bool
		opErr error
	)
	s.do(func() {
		rec, found, opErr = s.processDocs.get(id)
		if opErr != nil || !found || rec.ShareToken != "" {
			return
		}
		token, e := newPublicToken()
		if e != nil {
			opErr = e
			return
		}
		rec.ShareToken = token
		opErr = s.processDocs.saveRecord(rec)
	})
	switch {
	case opErr != nil:
		writeError(w, http.StatusInternalServerError, "share documentation: "+opErr.Error())
	case !found:
		writeError(w, http.StatusNotFound, "no documentation version with that id")
	default:
		writeJSON(w, http.StatusOK, toProcessDocResp(rec, false))
	}
}

// handleUnshareProcessDoc revokes a version's public link, killing the URL.
func (s *Server) handleUnshareProcessDoc(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var (
		rec   processDoc
		found bool
		opErr error
	)
	s.do(func() {
		rec, found, opErr = s.processDocs.get(id)
		if opErr != nil || !found || rec.ShareToken == "" {
			return
		}
		rec.ShareToken = ""
		opErr = s.processDocs.saveRecord(rec)
	})
	switch {
	case opErr != nil:
		writeError(w, http.StatusInternalServerError, "revoke documentation link: "+opErr.Error())
	case !found:
		writeError(w, http.StatusNotFound, "no documentation version with that id")
	default:
		writeJSON(w, http.StatusOK, toProcessDocResp(rec, false))
	}
}

// handleDeleteProcessDoc prunes a version, taking its public URL with it. A
// missing version is not an error, so pruning is idempotent.
func (s *Server) handleDeleteProcessDoc(w http.ResponseWriter, r *http.Request) {
	var delErr error
	s.do(func() { delErr = s.processDocs.delete(r.PathValue("id")) })
	if delErr != nil {
		writeError(w, http.StatusInternalServerError, "delete documentation: "+delErr.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- public, unauthenticated endpoint (ADR-0138, ADR-0029's mechanism) ---

// handlePublicProcessDoc serves a shared version's PDF to a reader with no
// account. An unknown, malformed, or revoked token is one indistinguishable 404:
// the response must not reveal whether a document ever existed behind it.
func (s *Server) handlePublicProcessDoc(w http.ResponseWriter, r *http.Request) {
	if !s.publicRate.allow(clientIP(r)) {
		writeError(w, http.StatusTooManyRequests, "too many requests")
		return
	}
	var (
		rec   processDoc
		found bool
		opErr error
	)
	s.do(func() { rec, found, opErr = s.processDocs.byShareToken(r.PathValue("token")) })
	if opErr != nil || !found {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	s.serveProcessDocPDF(w, rec)
}

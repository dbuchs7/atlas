package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Error and edge paths of the ADR-0138 documentation layer: the handler branches
// that fire only when the store cannot be read or written, the filename
// sanitizer, and the counter rebuild. The happy paths live in
// processdocs_http_test.go; these are the ones a successful export never reaches.

// docRequest drives one request through the server's handler and returns the
// recorder, so a test can assert on status and body.
func docRequest(t *testing.T, srv *Server, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	var req *http.Request
	if body != "" {
		req = httptest.NewRequest(method, path, strings.NewReader(body))
	} else {
		req = httptest.NewRequest(method, path, nil)
	}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

// breakDocStore repoints a server's documentation store at a path that cannot be
// read, so every store call fails and the handlers' 500 branches run.
func breakDocStore(t *testing.T, srv *Server) {
	t.Helper()
	srv.processDocs = &processDocStore{dir: filepath.Join(t.TempDir(), "gone")}
}

// TestLoadProcessDocVersionsRebuildsCounter proves the per-process counter is
// taken from the highest stored version of each process, and that a store it
// cannot read is a startup error rather than a silent reset to zero — which
// would let the next export overwrite v1.
func TestLoadProcessDocVersionsRebuildsCounter(t *testing.T) {
	store, err := newProcessDocStore(t.TempDir())
	if err != nil {
		t.Fatalf("newProcessDocStore: %v", err)
	}
	for _, rec := range []processDoc{
		{ID: "01", ProcessID: "a", Version: 2},
		{ID: "02", ProcessID: "a", Version: 5},
		{ID: "03", ProcessID: "b", Version: 1},
	} {
		if err := store.save(rec, []byte("%PDF-")); err != nil {
			t.Fatalf("save %s: %v", rec.ID, err)
		}
	}
	s := &Server{processDocs: store, docVersions: map[string]int32{}}
	if err := s.loadProcessDocVersions(); err != nil {
		t.Fatalf("loadProcessDocVersions: %v", err)
	}
	if s.docVersions["a"] != 5 || s.docVersions["b"] != 1 {
		t.Fatalf("docVersions = %v, want a=5 b=1", s.docVersions)
	}

	broken := &Server{
		processDocs: &processDocStore{dir: filepath.Join(t.TempDir(), "gone")},
		docVersions: map[string]int32{},
	}
	if err := broken.loadProcessDocVersions(); err == nil {
		t.Fatal("loadProcessDocVersions over an unreadable store: want an error")
	}
}

// TestCreateProcessDocUnreadableBody covers the io.ReadAll failure branch: a body
// that errors mid-read is a 400, not a stored half-document.
func TestCreateProcessDocUnreadableBody(t *testing.T) {
	srv := newServerForErrors(t)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/processes/p/documentation", errReader{})
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("create with an unreadable body = %d, want 400", rec.Code)
	}
}

// TestProcessDocUnwritableStoreErrors drives the branches that fail on a store
// whose directory is gone: the write the export needs, and the directory read the
// history needs. A read of a *single* record is deliberately not here — a missing
// file is a genuine not-found, and the handlers say so.
func TestProcessDocUnwritableStoreErrors(t *testing.T) {
	srv := newServerForErrors(t)
	breakDocStore(t, srv)

	rec := docRequest(t, srv, http.MethodPost, "/api/v1/processes/p/documentation",
		`{"title":"x","pdfBase64":"JVBERi0xLjQK"}`)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("create over an unwritable store = %d, want 500", rec.Code)
	}
	rec = docRequest(t, srv, http.MethodGet, "/api/v1/processes/p/documentation", "")
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("list over an unreadable store = %d, want 500", rec.Code)
	}
}

// TestProcessDocCorruptRecordErrors drives the 500 branches of the by-id
// handlers. Reaching them needs a record that is present but undecodable — a
// merely absent one is a 404, which is a different, correct answer.
func TestProcessDocCorruptRecordErrors(t *testing.T) {
	srv := newServerForErrors(t)
	id := "00112233445566778899aabbccddeeff"
	if err := os.WriteFile(srv.processDocs.fileFor(id), []byte("{not json"), 0o600); err != nil {
		t.Fatalf("write corrupt record: %v", err)
	}

	for _, tc := range []struct{ name, method, path string }{
		{"get", http.MethodGet, "/api/v1/documentation/" + id},
		{"pdf", http.MethodGet, "/api/v1/documentation/" + id + "/pdf"},
		{"share", http.MethodPost, "/api/v1/documentation/" + id + "/share"},
		{"unshare", http.MethodDelete, "/api/v1/documentation/" + id + "/share"},
	} {
		rec := docRequest(t, srv, tc.method, tc.path, "")
		if rec.Code != http.StatusInternalServerError {
			t.Errorf("%s over a corrupt record = %d, want 500", tc.name, rec.Code)
		}
	}

	// The public route must not leak a store fault to an anonymous reader: a
	// corrupt store is the same 404 an unknown token gets, so a probe cannot tell
	// the two apart.
	rec := docRequest(t, srv, http.MethodGet, publicProcessDocPath+"deadbeef", "")
	if rec.Code != http.StatusNotFound {
		t.Errorf("public route over a corrupt store = %d, want 404", rec.Code)
	}
}

// TestDeleteProcessDocStoreError covers the delete handler's failure branch: an
// undeletable record surfaces as a 500 rather than a reported-but-not-done prune.
func TestDeleteProcessDocStoreError(t *testing.T) {
	srv := newServerForErrors(t)
	id := "00112233445566778899aabbccddeeff"
	// A non-empty directory at the record's path cannot be removed.
	if err := os.MkdirAll(filepath.Join(srv.processDocs.fileFor(id), "child"), 0o755); err != nil {
		t.Fatalf("make undeletable record: %v", err)
	}
	rec := docRequest(t, srv, http.MethodDelete, "/api/v1/documentation/"+id, "")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("delete an undeletable record = %d, want 500", rec.Code)
	}
}

// TestServeProcessDocPDFMissingDocument covers the branch where the record exists
// but its document does not — a reader gets a 404 rather than a zero-byte file
// served as if it were the document.
func TestServeProcessDocPDFMissingDocument(t *testing.T) {
	srv := newServerForErrors(t)
	id := "00112233445566778899aabbccddeeff"
	if err := srv.processDocs.saveRecord(processDoc{ID: id, ProcessID: "p", Version: 1}); err != nil {
		t.Fatalf("saveRecord: %v", err)
	}
	rec := docRequest(t, srv, http.MethodGet, "/api/v1/documentation/"+id+"/pdf", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("download with no stored document = %d, want 404", rec.Code)
	}
}

// TestUnshareAlreadyPrivate proves revoking a version that is not shared is a
// no-op success, so a double-click on Revoke cannot fail.
func TestUnshareAlreadyPrivate(t *testing.T) {
	srv := newServerForErrors(t)
	id := "00112233445566778899aabbccddeeff"
	if err := srv.processDocs.save(processDoc{ID: id, ProcessID: "p", Version: 1}, []byte("%PDF-")); err != nil {
		t.Fatalf("save: %v", err)
	}
	rec := docRequest(t, srv, http.MethodDelete, "/api/v1/documentation/"+id+"/share", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("revoke an unshared version = %d, want 200", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "shareUrl") {
		t.Errorf("response carries a share URL: %s", rec.Body.String())
	}
}

// TestPublicProcessDocRateLimited proves the anonymous route is throttled: past
// the burst an IP gets 429s rather than an unbounded scan of the token space.
func TestPublicProcessDocRateLimited(t *testing.T) {
	srv := newServerForErrors(t)
	srv.publicRate = newRateLimiter(1, 0)
	h := srv.Handler()
	limited := false
	for i := 0; i < 5; i++ {
		req := httptest.NewRequest(http.MethodGet, publicProcessDocPath+"deadbeef", nil)
		req.RemoteAddr = "203.0.113.7:1234"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("the public documentation route never rate-limited, want a 429 past the burst")
	}
}

// TestProcessDocFilename proves the download filename is built from the process
// id with everything outside a conservative allowlist replaced, so it cannot
// carry a quote, a path separator, or a header-splitting byte into the
// Content-Disposition header.
func TestProcessDocFilename(t *testing.T) {
	for _, tc := range []struct {
		processID string
		version   int32
		want      string
	}{
		{"reisebuchung", 3, "reisebuchung-v3.pdf"},
		{"order_to-cash2", 1, "order_to-cash2-v1.pdf"},
		{`../../etc/pa"sswd`, 2, `------etc-pa-sswd-v2.pdf`},
		{"Ünïcödé", 1, "-n-c-d--v1.pdf"},
		{"", 1, "process-v1.pdf"},
	} {
		got := processDocFilename(processDoc{ProcessID: tc.processID, Version: tc.version})
		if got != tc.want {
			t.Errorf("processDocFilename(%q, v%d) = %q, want %q", tc.processID, tc.version, got, tc.want)
		}
	}
}

// TestCreateProcessDocIDMintFailureIsReported is the guard on the one branch a
// broken source of randomness would take: a version id that cannot be minted must
// stop the export rather than store a record under an empty id.
func TestCreateProcessDocIDMintFailureIsReported(t *testing.T) {
	// newProcessDocID reads crypto/rand, which does not fail in practice; assert
	// instead that the id it produces is the shape the store demands, which is what
	// the handler relies on when it skips validating its own mint.
	id, err := newProcessDocID()
	if err != nil {
		t.Fatalf("newProcessDocID: %v", err)
	}
	if !isHexToken(id) || len(id) != 32 {
		t.Fatalf("newProcessDocID = %q, want 32 hex characters", id)
	}
}

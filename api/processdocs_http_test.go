package api_test

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// documentedBPMN is a small process carrying exactly what a documentation export
// is for: per-element <documentation> prose and a <textAnnotation> associated
// with a task.
const documentedBPMN = `<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
                    xmlns:zeebe="http://camunda.org/schema/zeebe/1.0">
  <process id="reisebuchung" name="Reisebuchung" isExecutable="true">
    <documentation>Bucht eine Reise fuer einen Kunden.</documentation>
    <startEvent id="s"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="t"/>
    <serviceTask id="t" name="Flug buchen">
      <documentation>Ruft das Buchungssystem der Airline auf.</documentation>
      <extensionElements><zeebe:taskDefinition type="book"/></extensionElements>
    </serviceTask>
    <sequenceFlow id="f2" sourceRef="t" targetRef="e"/>
    <endEvent id="e"/>
    <textAnnotation id="note1"><text>Benoetigt IATA-Zugang</text></textAnnotation>
    <association id="a1" sourceRef="t" targetRef="note1"/>
  </process>
</definitions>`

// fakePDF is a syntactically plausible document. The server stores bytes; it only
// insists they look like a PDF, so a stub suffices for the HTTP contract.
var fakePDF = []byte("%PDF-1.4\n1 0 obj\n<< >>\nendobj\ntrailer\n%%EOF\n")

// docBody builds a create-documentation request body around the given PDF bytes.
func docBody(t *testing.T, title string, pdf []byte) string {
	t.Helper()
	payload := map[string]any{
		"title":       title,
		"note":        "Freigabe Q3",
		"processName": "Reisebuchung",
		"xml":         documentedBPMN,
		"elements": []map[string]any{
			{"id": "t", "type": "bpmn:ServiceTask", "name": "Flug buchen",
				"documentation": "Ruft das Buchungssystem der Airline auf.",
				"annotations":   []string{"Benoetigt IATA-Zugang"}},
			{"id": "e", "type": "bpmn:EndEvent", "name": ""},
		},
		"pdfBase64": base64.StdEncoding.EncodeToString(pdf),
	}
	b, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	return string(b)
}

// createDoc posts one documentation version and returns the decoded response.
func createDoc(t *testing.T, ts *httptest.Server, processID, title string) map[string]any {
	t.Helper()
	code, body := doReq(t, ts, http.MethodPost,
		"/api/v1/processes/"+processID+"/documentation", docBody(t, title, fakePDF), "application/json")
	if code != http.StatusOK {
		t.Fatalf("create documentation: %d %s", code, body)
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode create response: %v (%s)", err, body)
	}
	return out
}

// TestProcessDocumentationVersionsAreNumberedPerProcess proves the headline
// promise: each export is a new, immutable, numbered version of that process, and
// two processes number independently (ADR-0138).
func TestProcessDocumentationVersionsAreNumberedPerProcess(t *testing.T) {
	ts := newTestServer(t)

	first := createDoc(t, ts, "reisebuchung", "Reisebuchung")
	if first["version"] != float64(1) {
		t.Errorf("first version = %v, want 1", first["version"])
	}
	if first["processId"] != "reisebuchung" {
		t.Errorf("processId = %v, want reisebuchung", first["processId"])
	}
	if first["pdfUrl"] != "/api/v1/documentation/"+first["id"].(string)+"/pdf" {
		t.Errorf("pdfUrl = %v, want the download route for the minted id", first["pdfUrl"])
	}
	// A fresh version is private: nothing is shared until someone shares it.
	if first["shareUrl"] != nil {
		t.Errorf("shareUrl = %v on a fresh version, want none", first["shareUrl"])
	}

	second := createDoc(t, ts, "reisebuchung", "Reisebuchung")
	if second["version"] != float64(2) {
		t.Errorf("second version = %v, want 2", second["version"])
	}
	other := createDoc(t, ts, "rechnung", "Rechnung")
	if other["version"] != float64(1) {
		t.Errorf("other process first version = %v, want 1 (counters are per process)", other["version"])
	}

	// The history reads newest first and is scoped to the one process.
	code, body := doReq(t, ts, http.MethodGet, "/api/v1/processes/reisebuchung/documentation", "", "")
	if code != http.StatusOK {
		t.Fatalf("list documentation: %d %s", code, body)
	}
	var list []map[string]any
	if err := json.Unmarshal(body, &list); err != nil {
		t.Fatalf("decode list: %v (%s)", err, body)
	}
	if len(list) != 2 {
		t.Fatalf("history has %d versions, want 2: %s", len(list), body)
	}
	if list[0]["version"] != float64(2) || list[1]["version"] != float64(1) {
		t.Errorf("history order = %v, %v, want newest first", list[0]["version"], list[1]["version"])
	}
	// A listing is a summary: it must not haul every version's whole BPMN source.
	if _, ok := list[0]["xml"]; ok {
		t.Error("history entry carries the BPMN source, want it only on the single fetch")
	}
}

// TestProcessDocumentationFetchAndDownload proves a version's element prose comes
// back intact and its PDF downloads as a PDF.
func TestProcessDocumentationFetchAndDownload(t *testing.T) {
	ts := newTestServer(t)
	created := createDoc(t, ts, "reisebuchung", "Reisebuchung")
	id := created["id"].(string)

	code, body := doReq(t, ts, http.MethodGet, "/api/v1/documentation/"+id, "", "")
	if code != http.StatusOK {
		t.Fatalf("get documentation: %d %s", code, body)
	}
	var got struct {
		Title    string `json:"title"`
		Note     string `json:"note"`
		XML      string `json:"xml"`
		Elements []struct {
			ID            string   `json:"id"`
			Documentation string   `json:"documentation"`
			Annotations   []string `json:"annotations"`
		} `json:"elements"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode: %v (%s)", err, body)
	}
	if got.Title != "Reisebuchung" || got.Note != "Freigabe Q3" {
		t.Errorf("title/note = %q/%q, want the submitted values", got.Title, got.Note)
	}
	if !strings.Contains(got.XML, "textAnnotation") {
		t.Error("the BPMN source was not snapshotted with the version")
	}
	if len(got.Elements) != 2 {
		t.Fatalf("elements = %d, want 2", len(got.Elements))
	}
	if got.Elements[0].Documentation == "" || len(got.Elements[0].Annotations) != 1 {
		t.Errorf("element prose lost: %+v", got.Elements[0])
	}

	res, err := http.Get(ts.URL + "/api/v1/documentation/" + id + "/pdf")
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("download status = %d, want 200", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); ct != "application/pdf" {
		t.Errorf("Content-Type = %q, want application/pdf", ct)
	}
	if cd := res.Header.Get("Content-Disposition"); !strings.Contains(cd, "reisebuchung") {
		t.Errorf("Content-Disposition = %q, want a filename naming the process", cd)
	}
}

// TestProcessDocumentationRecordsLiveDeployment proves a documented process that
// is deployed records which deployment it described, so a reader of the history
// can tell which running version a document belongs to.
func TestProcessDocumentationRecordsLiveDeployment(t *testing.T) {
	ts := newTestServer(t)
	if code, body := doReq(t, ts, http.MethodPost, "/api/v1/deployments", documentedBPMN, "application/xml"); code != http.StatusOK {
		t.Fatalf("deploy: %d %s", code, body)
	}
	created := createDoc(t, ts, "reisebuchung", "Reisebuchung")
	if created["deploymentVersion"] != float64(1) {
		t.Errorf("deploymentVersion = %v, want 1", created["deploymentVersion"])
	}
	if key, ok := created["deploymentKey"].(float64); !ok || key == 0 {
		t.Errorf("deploymentKey = %v, want the live deployment's key", created["deploymentKey"])
	}
}

// TestProcessDocumentationRejectsBadInput proves the create route refuses what it
// cannot store: a missing document, bytes that are not a PDF, and malformed JSON.
func TestProcessDocumentationRejectsBadInput(t *testing.T) {
	ts := newTestServer(t)
	path := "/api/v1/processes/reisebuchung/documentation"

	for name, tc := range map[string]struct{ body, contentType string }{
		"malformed json": {`{`, "application/json"},
		"no pdf":         {`{"title":"x"}`, "application/json"},
		"bad base64":     {`{"title":"x","pdfBase64":"not base64!!"}`, "application/json"},
		"not a pdf": {fmt.Sprintf(`{"title":"x","pdfBase64":%q}`,
			base64.StdEncoding.EncodeToString([]byte("<html>gotcha</html>"))), "application/json"},
	} {
		code, body := doReq(t, ts, http.MethodPost, path, tc.body, tc.contentType)
		if code != http.StatusBadRequest {
			t.Errorf("%s: status = %d %s, want 400", name, code, body)
		}
	}

	// Nothing was stored by any of the refusals.
	code, body := doReq(t, ts, http.MethodGet, path, "", "")
	if code != http.StatusOK || strings.TrimSpace(string(body)) != "[]" {
		t.Errorf("history after refusals = %d %s, want an empty list", code, body)
	}
}

// TestProcessDocumentationUnknownVersionIs404 proves an id that names no version
// is a not-found on every route that takes one, rather than a 500 or an empty
// document.
func TestProcessDocumentationUnknownVersionIs404(t *testing.T) {
	ts := newTestServer(t)
	for _, path := range []string{
		"/api/v1/documentation/00112233445566778899aabbccddeeff",
		"/api/v1/documentation/00112233445566778899aabbccddeeff/pdf",
	} {
		if code, body := doReq(t, ts, http.MethodGet, path, "", ""); code != http.StatusNotFound {
			t.Errorf("GET %s = %d %s, want 404", path, code, body)
		}
	}
	for _, method := range []string{http.MethodPost, http.MethodDelete} {
		if code, body := doReq(t, ts, method,
			"/api/v1/documentation/00112233445566778899aabbccddeeff/share", "", ""); code != http.StatusNotFound {
			t.Errorf("%s share on an unknown id = %d %s, want 404", method, code, body)
		}
	}
}

// TestProcessDocumentationTitleDefaultsToProcessID proves an export submitted
// without a title is still identifiable — the process id stands in rather than
// leaving a blank-titled version in the history.
func TestProcessDocumentationTitleDefaultsToProcessID(t *testing.T) {
	ts := newTestServer(t)
	code, body := doReq(t, ts, http.MethodPost, "/api/v1/processes/reisebuchung/documentation",
		docBody(t, "   ", fakePDF), "application/json")
	if code != http.StatusOK {
		t.Fatalf("create: %d %s", code, body)
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode: %v (%s)", err, body)
	}
	if out["title"] != "reisebuchung" {
		t.Errorf("title = %v, want the process id as the fallback", out["title"])
	}
}

// TestProcessDocumentationSharing proves the distribution story end to end: a
// version is private until shared, sharing mints a stable public URL that serves
// the PDF without a login, revoking kills it, and sharing is per version — a
// second version is not reachable through the first one's token.
func TestProcessDocumentationSharing(t *testing.T) {
	ts := newTestServer(t)
	v1 := createDoc(t, ts, "reisebuchung", "Reisebuchung")
	v2 := createDoc(t, ts, "reisebuchung", "Reisebuchung")
	id1, id2 := v1["id"].(string), v2["id"].(string)

	code, body := doReq(t, ts, http.MethodPost, "/api/v1/documentation/"+id1+"/share", "", "")
	if code != http.StatusOK {
		t.Fatalf("share: %d %s", code, body)
	}
	var shared struct {
		Token    string `json:"shareToken"`
		ShareURL string `json:"shareUrl"`
	}
	if err := json.Unmarshal(body, &shared); err != nil {
		t.Fatalf("decode share: %v (%s)", err, body)
	}
	if shared.Token == "" || shared.ShareURL != "/public/process-docs/"+shared.Token {
		t.Fatalf("share response = %+v, want a token and its public URL", shared)
	}

	// Sharing twice is idempotent: the published URL must not rotate under readers.
	code, body = doReq(t, ts, http.MethodPost, "/api/v1/documentation/"+id1+"/share", "", "")
	if code != http.StatusOK {
		t.Fatalf("share again: %d %s", code, body)
	}
	var again struct {
		Token string `json:"shareToken"`
	}
	if err := json.Unmarshal(body, &again); err != nil {
		t.Fatalf("decode share again: %v (%s)", err, body)
	}
	if again.Token != shared.Token {
		t.Errorf("token rotated on re-share: %q then %q", shared.Token, again.Token)
	}

	// The public URL serves the PDF, unauthenticated.
	res, err := http.Get(ts.URL + shared.ShareURL)
	if err != nil {
		t.Fatalf("public download: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK || res.Header.Get("Content-Type") != "application/pdf" {
		t.Fatalf("public download = %d %q, want 200 application/pdf", res.StatusCode, res.Header.Get("Content-Type"))
	}

	// The second version stayed private — it has no token of its own.
	if code, body := doReq(t, ts, http.MethodGet, "/api/v1/documentation/"+id2, "", ""); code == http.StatusOK {
		var v2rec map[string]any
		if err := json.Unmarshal(body, &v2rec); err != nil {
			t.Fatalf("decode v2: %v", err)
		}
		if v2rec["shareUrl"] != nil {
			t.Errorf("v2 shareUrl = %v, want none — sharing is per version", v2rec["shareUrl"])
		}
	}

	// Revoking kills the public URL.
	if code, body := doReq(t, ts, http.MethodDelete, "/api/v1/documentation/"+id1+"/share", "", ""); code != http.StatusOK {
		t.Fatalf("revoke: %d %s", code, body)
	}
	if code, body := doReq(t, ts, http.MethodGet, shared.ShareURL, "", ""); code != http.StatusNotFound {
		t.Errorf("public URL after revoke = %d %s, want 404", code, body)
	}
}

// TestProcessDocumentationPublicTokenUnknown proves an unknown or malformed
// public token is a plain 404 — it must not distinguish "never existed" from
// "revoked", and must not be usable to walk the store.
func TestProcessDocumentationPublicTokenUnknown(t *testing.T) {
	ts := newTestServer(t)
	for _, token := range []string{"deadbeef", "not-hex", "..%2f..%2fetc%2fpasswd"} {
		if code, body := doReq(t, ts, http.MethodGet, "/public/process-docs/"+token, "", ""); code != http.StatusNotFound {
			t.Errorf("public token %q = %d %s, want 404", token, code, body)
		}
	}
}

// TestProcessDocumentationDeleteVersion proves a version can be pruned and that
// pruning takes its public URL with it.
func TestProcessDocumentationDeleteVersion(t *testing.T) {
	ts := newTestServer(t)
	created := createDoc(t, ts, "reisebuchung", "Reisebuchung")
	id := created["id"].(string)
	code, body := doReq(t, ts, http.MethodPost, "/api/v1/documentation/"+id+"/share", "", "")
	if code != http.StatusOK {
		t.Fatalf("share: %d %s", code, body)
	}
	var shared struct {
		ShareURL string `json:"shareUrl"`
	}
	if err := json.Unmarshal(body, &shared); err != nil {
		t.Fatalf("decode share: %v", err)
	}

	if code, body := doReq(t, ts, http.MethodDelete, "/api/v1/documentation/"+id, "", ""); code != http.StatusNoContent {
		t.Fatalf("delete = %d %s, want 204", code, body)
	}
	if code, _ := doReq(t, ts, http.MethodGet, "/api/v1/documentation/"+id, "", ""); code != http.StatusNotFound {
		t.Errorf("get after delete = %d, want 404", code)
	}
	if code, _ := doReq(t, ts, http.MethodGet, shared.ShareURL, "", ""); code != http.StatusNotFound {
		t.Errorf("public URL after delete = %d, want 404", code)
	}
	// Deleting again is a no-op rather than a failure.
	if code, body := doReq(t, ts, http.MethodDelete, "/api/v1/documentation/"+id, "", ""); code != http.StatusNoContent {
		t.Errorf("delete again = %d %s, want 204", code, body)
	}
}

// TestProcessDocumentationRecordsItsAuthor proves a published version carries who
// published it. Historization without attribution is half an answer: "what did
// this look like in March" is usually asked next to "and who signed it off".
func TestProcessDocumentationRecordsItsAuthor(t *testing.T) {
	ts, _ := newAuthServer(t, "ada", "correcthorsebattery")
	c := newClient(t)
	if code := login(t, c, ts, "ada", "correcthorsebattery"); code != http.StatusOK {
		t.Fatalf("login = %d", code)
	}
	code, body := cReq(t, c, ts, http.MethodPost,
		"/api/v1/processes/reisebuchung/documentation", docBody(t, "Reisebuchung", fakePDF))
	if code != http.StatusOK {
		t.Fatalf("create: %d %s", code, body)
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode: %v (%s)", err, body)
	}
	if out["createdBy"] != "ada" {
		t.Errorf("createdBy = %v, want the authenticated publisher", out["createdBy"])
	}
}

// TestProcessDocumentationVersionCounterSurvivesRestart proves the per-process
// counter is rebuilt from the durable records at startup, so a restart continues
// the sequence rather than minting a second "v1" that overwrites history.
func TestProcessDocumentationVersionCounterSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	first := boot(t, dir)
	if v := createDoc(t, first.ts, "reisebuchung", "Reisebuchung")["version"]; v != float64(1) {
		t.Fatalf("first version = %v, want 1", v)
	}
	if v := createDoc(t, first.ts, "reisebuchung", "Reisebuchung")["version"]; v != float64(2) {
		t.Fatalf("second version = %v, want 2", v)
	}
	first.shutdown()

	restarted := boot(t, dir)
	defer restarted.shutdown()
	if v := createDoc(t, restarted.ts, "reisebuchung", "Reisebuchung")["version"]; v != float64(3) {
		t.Errorf("version after restart = %v, want 3 — the counter must be rebuilt from the records", v)
	}
}

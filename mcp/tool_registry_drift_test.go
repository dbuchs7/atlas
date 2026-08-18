package mcp_test

import (
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"strings"
	"testing"
)

// The MCP server is a pure adapter over the Atlas HTTP API (ADR-0016): every
// advertised tool proxies to exactly one /api/v1 operation, and MCP is strictly
// a subset of HTTP. Unlike the HTTP↔OpenAPI surface — which cannot drift because
// TestOpenAPICoversEveryRoute reads one route table — nothing structurally stops
// the MCP surface from silently falling behind the API as new endpoints land.
//
// This test is that missing guard. It classifies every HTTP operation as either
// covered by a named tool or deliberately omitted, and fails when a new route is
// neither — so adding an endpoint forces a conscious decision (expose it, or
// record why not) instead of an unnoticed capability gap. The maps below are the
// single source of that decision; keep them honest and this test keeps the two
// surfaces from drifting apart the way issue #198's follow-up warned they could.

// mcpToolRoutes maps each advertised MCP tool to the "METHOD /pattern" HTTP
// operation it proxies to. Every entry must be a real API route and every
// advertised tool must appear here (both asserted below).
var mcpToolRoutes = map[string]string{
	"atlas_info":                    "GET /api/v1/info",
	"atlas_stats":                   "GET /api/v1/stats",
	"atlas_deploy":                  "POST /api/v1/deployments",
	"atlas_list_processes":          "GET /api/v1/processes",
	"atlas_get_process_xml":         "GET /api/v1/processes/{key}/xml",
	"atlas_delete_process":          "DELETE /api/v1/processes/{key}",
	"atlas_process_runtime":         "GET /api/v1/processes/{key}/runtime",
	"atlas_call_activities":         "GET /api/v1/call-activities",
	"atlas_create_instance":         "POST /api/v1/processes/{key}/instances",
	"atlas_list_instances":          "GET /api/v1/instances",
	"atlas_cancel_instance":         "DELETE /api/v1/instances/{key}",
	"atlas_cancel_instances":        "POST /api/v1/processes/{key}/cancel-instances",
	"atlas_create_project":          "POST /api/v1/projects",
	"atlas_list_projects":           "GET /api/v1/projects",
	"atlas_delete_project":          "DELETE /api/v1/projects/{id}",
	"atlas_create_application":      "POST /api/v1/applications",
	"atlas_list_applications":       "GET /api/v1/applications",
	"atlas_delete_application":      "DELETE /api/v1/applications/{id}",
	"atlas_save_draft":              "POST /api/v1/drafts",
	"atlas_save_form":               "POST /api/v1/forms",
	"atlas_upload_decision_model":   "POST /api/v1/dmn-models",
	"atlas_register_decision":       "POST /api/v1/dmnrefs",
	"atlas_deploy_project":          "POST /api/v1/projects/{id}/deploy",
	"atlas_deploy_application":      "POST /api/v1/applications/{id}/deploy",
	"atlas_publish_application":     "POST /api/v1/applications/{id}/publish",
	"atlas_application_releases":    "GET /api/v1/applications/{id}/releases",
	"atlas_application_deployments": "GET /api/v1/applications/{id}/deployments",
	"atlas_list_tasks":              "GET /api/v1/tasks",
	"atlas_get_task":                "GET /api/v1/tasks/{key}",
	"atlas_complete_task":           "POST /api/v1/tasks/{key}/complete",
	"atlas_claim_task":              "POST /api/v1/tasks/{key}/claim",
	"atlas_unclaim_task":            "POST /api/v1/tasks/{key}/unclaim",
	"atlas_publish_message":         "POST /api/v1/messages",
	"atlas_complete_job":            "POST /api/v1/jobs/{key}/complete",
	"atlas_fail_job":                "POST /api/v1/jobs/{key}/fail",
	"atlas_list_incidents":          "GET /api/v1/incidents",
	"atlas_resolve_incident":        "POST /api/v1/incidents/{key}/resolve",
	"atlas_instance_variables":      "GET /api/v1/instances/{key}/variables",
	"atlas_instance_jobs":           "GET /api/v1/instances/{key}/jobs",
	"atlas_instance_timeline":       "GET /api/v1/instances/{key}/timeline",
	"atlas_instances_summary":       "GET /api/v1/instances/summary",
	"atlas_search_instances":        "GET /api/v1/instances/search",
	"atlas_instance_data_objects":   "GET /api/v1/instances/{key}/data-objects",
	"atlas_terminate_instances":     "POST /api/v1/instances/terminate",
	"atlas_instance_decisions":      "GET /api/v1/instances/{key}/decisions",
	"atlas_deployed_decisions":      "GET /api/v1/decisions/deployed",
	"atlas_dmnref_graph":            "GET /api/v1/dmnrefs/{id}/graph",
	"atlas_get_decision_model":      "GET /api/v1/dmn-models/{ref}/xml",
	"atlas_collaboration_runtime":   "GET /api/v1/collaborations/{key}/runtime",
	"atlas_list_drafts":             "GET /api/v1/drafts",
	"atlas_get_draft_xml":           "GET /api/v1/drafts/{id}/xml",
	"atlas_delete_draft":            "DELETE /api/v1/drafts/{id}",
	"atlas_join_session":            "POST /api/v1/drafts/{id}/session/join",
	"atlas_session_poll":            "POST /api/v1/drafts/{id}/session/poll",
	"atlas_session_lock":            "POST /api/v1/drafts/{id}/session/lock",
	"atlas_session_change":          "POST /api/v1/drafts/{id}/session/change",
	"atlas_session_presence":        "POST /api/v1/drafts/{id}/session/presence",
	"atlas_leave_session":           "POST /api/v1/drafts/{id}/session/leave",
	"atlas_list_forms":              "GET /api/v1/forms",
	"atlas_get_form":                "GET /api/v1/forms/{id}",
	"atlas_list_decision_refs":      "GET /api/v1/dmnrefs",
	"atlas_list_decisions":          "GET /api/v1/decisions",
	"atlas_decision_evaluations":    "GET /api/v1/decisions/{id}/evaluations",
	"atlas_variable_audit":          "GET /api/v1/instances/{key}/variable-audit",
	"atlas_assignable_users":        "GET /api/v1/users/assignable",
}

// mcpOmittedRoutes lists HTTP operations intentionally not exposed as MCP tools,
// each with the reason. A route is either here or a value in mcpToolRoutes; the
// test rejects any operation that is in neither. When you add an /api/v1 route,
// add a matching tool (and an entry above) or record here why an agent should
// not have it.
var mcpOmittedRoutes = map[string]string{
	// Server introspection / diagnostics an agent does not drive scenarios with.
	"GET /api/v1/logs": "admin diagnostics, not an agent authoring/runtime action",

	// Backup/restore: an admin file-transfer of the data directory (ADR-0107 design-
	// time, ADR-0109 whole-instance snapshot), not an agent authoring/runtime action.
	"GET /api/v1/backup":        "admin data backup download, not an agent action",
	"POST /api/v1/restore":      "admin data restore upload, not an agent action",
	"GET /api/v1/backup/full":   "admin whole-instance snapshot download, not an agent action",
	"POST /api/v1/restore/full": "admin whole-instance snapshot upload, not an agent action",

	// Per-server call-activity target overrides (ADR-0105): admin operator config,
	// like connectors — an agent reads the resolution via atlas_call_activities but
	// does not set server-local routing. requireAdmin-gated.
	"PUT /api/v1/call-activities/overrides/{processId}":    "per-server call-activity override is admin config, not an agent action",
	"DELETE /api/v1/call-activities/overrides/{processId}": "per-server call-activity override is admin config, not an agent action",

	// Deactivating/activating a deployed process (ADR-0119): operator config that pauses
	// automatic (timer/message/signal) starts, the same category as a call-activity
	// override — an operator action from the Console, not an agent scenario step.
	"PUT /api/v1/processes/{key}/active": "process deactivation is operator config, not an agent action",

	// Dry-run BPMN validation for the Modeler's Problems panel (ADR-0026): an MCP
	// agent deploys directly via atlas_deploy, which already compiles and validates.
	"POST /api/v1/validate": "modeler-time dry-run validation; atlas_deploy already compiles+validates",

	// Diagram-layout regeneration for the Modeler's Auto-layout button: a pure
	// rendering transform of BPMN-DI coordinates. An MCP agent authors BPMN-DI
	// directly (or relies on server-side ensureDiagramLayout on read), so it does
	// not drive a scenario through this.
	"POST /api/v1/layout": "modeler-time diagram layout regeneration; a rendering concern, not a scenario action",

	// Expression/script sandboxes: authored inside BPMN, not called standalone.
	"POST /api/v1/feel/validate": "modeler-time expression check, not a scenario action",
	"POST /api/v1/feel/evaluate": "modeler-time expression check, not a scenario action",
	"POST /api/v1/scripts/run":   "modeler-time script check, not a scenario action",

	// CSV batch start: driven from a user task inside the process (ADR-0084).
	"POST /api/v1/processes/{key}/instances-from-csv": "in-process CSV ingestion, not a direct agent start",

	// Admin-gated operator correction to live state (ADR-0095): the MCP service
	// principal is deliberately non-admin, so overwriting an instance's variables
	// by hand is not an MCP capability. (terminate, in contrast, is exposed.)
	"POST /api/v1/instances/{key}/variables": "admin-gated live-state correction; the MCP service principal is deliberately non-admin",

	// Design-time edit: agents create artifacts and can read them back (list/get
	// are exposed), but mutating existing ones is the UI's job. Deleting a draft is
	// the one exception (atlas_delete_draft): an agent can *create* drafts, so
	// leaving it no way to remove one makes every generated or throwaway diagram
	// permanent litter that only a human can clear.
	"PATCH /api/v1/drafts/{id}":          "artifact editing is a UI concern",
	"DELETE /api/v1/forms/{id}":          "artifact editing is a UI concern",
	"PATCH /api/v1/dmnrefs/{id}":         "artifact editing is a UI concern",
	"DELETE /api/v1/dmnrefs/{id}":        "artifact editing is a UI concern",
	"POST /api/v1/dmnrefs/{id}/validate": "modeler-time validation is a UI concern",

	// The SSE join stream is a browser transport: an MCP agent cannot hold an
	// event stream, so it joins via the non-streaming atlas_join_session and reads
	// with atlas_session_poll instead. The stream endpoint itself carries no tool.
	"GET /api/v1/drafts/{id}/session": "live SSE co-editing transport for browsers; agents use atlas_join_session + atlas_session_poll (ADR-0103)",

	// Public start links: a human-sharing feature, not an agent action.
	"POST /api/v1/public-links":           "human share links, not an agent action",
	"GET /api/v1/public-links":            "human share links, not an agent action",
	"DELETE /api/v1/public-links/{token}": "human share links, not an agent action",

	// Project edit/membership: grouping metadata and access control, UI-owned.
	"PATCH /api/v1/projects/{id}":                   "project metadata edit is a UI concern",
	"PUT /api/v1/projects/{id}/members/{userId}":    "access control is an admin/UI concern",
	"DELETE /api/v1/projects/{id}/members/{userId}": "access control is an admin/UI concern",
	"POST /api/v1/projects/{id}/validate":           "modeler-time validation is a UI concern",

	// Process application edit/membership (ADR-0128): the canonical /applications
	// surface. Create/list/delete/deploy are exposed as atlas_*_application tools
	// (see mcpToolRoutes); the rest mirror the omission of their /projects twins —
	// metadata edit, access control, and modeler-time validation are UI concerns.
	"PATCH /api/v1/applications/{id}":                   "application metadata edit is a UI concern",
	"PUT /api/v1/applications/{id}/members/{userId}":    "access control is an admin/UI concern",
	"DELETE /api/v1/applications/{id}/members/{userId}": "access control is an admin/UI concern",
	"POST /api/v1/applications/{id}/validate":           "modeler-time validation is a UI concern",

	// Connectors + inbound subscriptions: infrastructure config, admin-owned.
	"GET /api/v1/connectors":                             "connector infrastructure is admin config",
	"POST /api/v1/connectors":                            "connector infrastructure is admin config",
	"PATCH /api/v1/connectors/{id}":                      "connector infrastructure is admin config",
	"DELETE /api/v1/connectors/{id}":                     "connector infrastructure is admin config",
	"GET /api/v1/connectors/{id}/inbound-subscriptions":  "connector infrastructure is admin config",
	"POST /api/v1/connectors/{id}/inbound-subscriptions": "connector infrastructure is admin config",
	"PATCH /api/v1/inbound-subscriptions/{id}":           "connector infrastructure is admin config",
	"DELETE /api/v1/inbound-subscriptions/{id}":          "connector infrastructure is admin config",
	"POST /api/v1/connectors/{id}/provision-clio-key":    "connector infrastructure is admin config",

	// Marketplace: package management, an admin/UI concern.
	"GET /api/v1/marketplace/packages":               "marketplace management is a UI concern",
	"GET /api/v1/marketplace/packages/{id}":          "marketplace management is a UI concern",
	"POST /api/v1/marketplace/packages/{id}/install": "marketplace management is a UI concern",
	"GET /api/v1/marketplace/installed":              "marketplace management is a UI concern",
	"DELETE /api/v1/marketplace/installed/{id}":      "marketplace management is a UI concern",

	// Peer deploy tokens and bundle import (ADR-0129): issuing a machine credential
	// is credential storage (admin-gated, same category as secrets), and the import
	// endpoint is a server-to-server transport authenticated by a deploy token — an
	// MCP agent publishes through atlas_publish_application, never by hand-posting a
	// bundle. Exposing either as a tool would hand an agent a capability the ADR
	// deliberately scoped to peers and admins.
	"POST /api/v1/deploy-tokens":        "issuing a peer credential is admin-only credential management, not an agent action",
	"GET /api/v1/deploy-tokens":         "credential listing is admin-only, not an agent action",
	"DELETE /api/v1/deploy-tokens/{id}": "credential revocation is admin-only, not an agent action",
	"POST /api/v1/applications/import":  "server-to-server bundle transport authenticated by a deploy token; agents publish via atlas_publish_application",

	// Deployment targets and promotion (ADR-0129, sending side): a target names
	// another server and the credential to reach it — admin config in the same
	// category as connectors. Promotion ships work to a *different* engine, often a
	// production one; that is an operator's decision with consequences outside this
	// server, not a step an agent drives while building a scenario. An agent
	// publishes locally via atlas_publish_application and stops there.
	"POST /api/v1/targets":                                      "peer target configuration is admin config, not an agent action",
	"GET /api/v1/targets":                                       "peer target configuration is admin config, not an agent action",
	"DELETE /api/v1/targets/{id}":                               "peer target configuration is admin config, not an agent action",
	"POST /api/v1/applications/{id}/releases/{version}/promote": "shipping a release to another server is an operator decision with off-server consequences, not an agent action",
	"GET /api/v1/applications/{id}/targets":                     "per-peer status of admin-configured targets; an agent reads this server's own state via atlas_application_deployments",

	// Source-tree export/import (ADR-0134): a gzip-tar file transfer of an
	// application's whole working set, in the same category as backup/restore. An
	// agent authors through the granular tools it already has (atlas_save_draft,
	// atlas_save_form, atlas_register_decision), where each change is one legible
	// step; handing it an archive that silently rewrites every artifact of an
	// application at once is neither reviewable nor something an agent needs.
	"GET /api/v1/applications/{id}/source": "bulk source-tree download; an agent reads artifacts individually via atlas_get_draft_xml / atlas_get_form",
	"POST /api/v1/applications/source":     "bulk source-tree upload that rewrites a whole application; an agent authors via atlas_save_draft / atlas_save_form",

	// Process documentation (ADR-0138): the document is *produced in the browser*,
	// where bpmn-js holds the authoritative picture — an agent has no rendered
	// diagram to publish, so the create route is not a capability it can exercise.
	// The reads are of the produced artifact rather than of the model: an agent
	// that wants to know what a process does reads the model itself via
	// atlas_get_draft_xml / atlas_get_process_xml. Sharing is a publication
	// decision — it puts a process in front of an audience outside Atlas — and
	// belongs to the human making it.
	"POST /api/v1/processes/{processId}/documentation": "the document is rendered in the browser; an agent has no diagram raster to publish",
	"GET /api/v1/processes/{processId}/documentation":  "history of a published artifact; an agent reads the model itself via atlas_get_process_xml",
	"GET /api/v1/documentation/{id}":                   "a published artifact's record; an agent reads the model itself via atlas_get_process_xml",
	"GET /api/v1/documentation/{id}/pdf":               "binary document download is not an agent capability",
	"POST /api/v1/documentation/{id}/share":            "publishing a process to an audience outside Atlas is a human decision, not an agent action",
	"DELETE /api/v1/documentation/{id}/share":          "revoking a publication is a human decision, not an agent action",
	"DELETE /api/v1/documentation/{id}":                "pruning published history is a human decision, not an agent action",

	// Secrets: credential storage; an agent must never read or write it.
	"GET /api/v1/secrets":           "credential storage is not an agent capability",
	"PUT /api/v1/secrets/{name}":    "credential storage is not an agent capability",
	"DELETE /api/v1/secrets/{name}": "credential storage is not an agent capability",

	// UI theme: org-wide branding config for the Console, an admin/UI concern.
	"GET /api/v1/settings/theme":    "UI branding is a Console concern, not an agent action",
	"PUT /api/v1/settings/theme":    "UI branding is a Console concern, not an agent action",
	"DELETE /api/v1/settings/theme": "UI branding is a Console concern, not an agent action",

	// Self-service registration config (ADR-0126): a login-screen/admin concern,
	// not an agent action.
	"GET /api/v1/settings/registration":    "registration config is a Console/login concern, not an agent action",
	"PUT /api/v1/settings/registration":    "registration config is a Console/login concern, not an agent action",
	"DELETE /api/v1/settings/registration": "registration config is a Console/login concern, not an agent action",

	// Auth + user administration: security surface, deliberately off-limits.
	"POST /api/v1/auth/login":          "auth flow is not an agent capability",
	"POST /api/v1/auth/logout":         "auth flow is not an agent capability",
	"GET /api/v1/auth/me":              "auth flow is not an agent capability",
	"GET /api/v1/users":                "user administration is not an agent capability",
	"GET /api/v1/principals":           "user administration is not an agent capability",
	"POST /api/v1/users":               "user administration is not an agent capability",
	"GET /api/v1/users/{id}":           "user administration is not an agent capability",
	"PATCH /api/v1/users/{id}":         "user administration is not an agent capability",
	"POST /api/v1/users/{id}/password": "user administration is not an agent capability",
	"DELETE /api/v1/users/{id}":        "user administration is not an agent capability",
}

// httpOperations fetches the live OpenAPI document from a running Atlas server
// and returns the set of "METHOD /pattern" operations it documents. That
// document is the API's single source of truth: TestOpenAPICoversEveryRoute
// guarantees it lists exactly the registered routes, so reading it here means
// this test tracks the real served surface without duplicating the route table.
func httpOperations(t *testing.T, atlasURL string) map[string]bool {
	t.Helper()
	resp, err := http.Get(atlasURL + "/api/v1/openapi.json")
	if err != nil {
		t.Fatalf("fetch openapi.json: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("openapi.json status = %d, want 200 (is docs enabled?)", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read openapi.json: %v", err)
	}
	var doc struct {
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		t.Fatalf("decode openapi.json: %v", err)
	}
	ops := map[string]bool{}
	for pattern, methods := range doc.Paths {
		for method := range methods {
			ops[strings.ToUpper(method)+" "+pattern] = true
		}
	}
	if len(ops) == 0 {
		t.Fatal("openapi.json documented no operations")
	}
	return ops
}

// TestMCPToolSurfaceMatchesHTTPClassification is the drift guard: every HTTP
// operation is either covered by a tool or explicitly omitted, and the two
// classification maps reference only real, non-overlapping routes.
func TestMCPToolSurfaceMatchesHTTPClassification(t *testing.T) {
	atlas := newAtlas(t)
	ops := httpOperations(t, atlas.URL)

	covered := map[string]string{} // route -> tool
	for tool, route := range mcpToolRoutes {
		if !ops[route] {
			t.Errorf("tool %q maps to %q, which is not a documented HTTP operation", tool, route)
		}
		if other, dup := covered[route]; dup {
			t.Errorf("route %q is claimed by both %q and %q", route, other, tool)
		}
		covered[route] = tool
	}

	// A route cannot be both covered and omitted.
	for route := range mcpOmittedRoutes {
		if !ops[route] {
			t.Errorf("omitted route %q is not a documented HTTP operation (stale entry?)", route)
		}
		if tool, both := covered[route]; both {
			t.Errorf("route %q is both covered by %q and listed as omitted", route, tool)
		}
	}

	// The core assertion: no unclassified operation. A new /api/v1 route lands
	// here until it is exposed as a tool or recorded as omitted.
	var unclassified []string
	for route := range ops {
		if _, isCovered := covered[route]; isCovered {
			continue
		}
		if _, isOmitted := mcpOmittedRoutes[route]; isOmitted {
			continue
		}
		unclassified = append(unclassified, route)
	}
	if len(unclassified) > 0 {
		sort.Strings(unclassified)
		t.Fatalf("%d HTTP operation(s) are neither exposed as an MCP tool nor listed as intentionally omitted:\n\t%s\n"+
			"Add a tool (and an mcpToolRoutes entry) or record the reason in mcpOmittedRoutes.",
			len(unclassified), strings.Join(unclassified, "\n\t"))
	}
}

// TestEveryAdvertisedToolHasARouteMapping ties the tool registry to the
// classification: every tool the server advertises must appear in mcpToolRoutes,
// so a new tool cannot be added without also classifying the route it proxies.
func TestEveryAdvertisedToolHasARouteMapping(t *testing.T) {
	atlas := newAtlas(t)
	listed := run(t, atlas, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if len(listed) != 1 {
		t.Fatalf("tools/list returned %d responses, want 1", len(listed))
	}

	advertised := map[string]bool{}
	for _, name := range listedToolNames(t, listed[0]) {
		advertised[name] = true
		if _, ok := mcpToolRoutes[name]; !ok {
			t.Errorf("advertised tool %q has no mcpToolRoutes entry (classify the route it proxies)", name)
		}
	}
	// Reverse: no stale mapping for a tool that is no longer advertised.
	for name := range mcpToolRoutes {
		if !advertised[name] {
			t.Errorf("mcpToolRoutes maps %q, which tools/list does not advertise (stale entry?)", name)
		}
	}
}

// Package api is the single-binary server surface for Atlas: it embeds one
// engine.Processor behind an HTTP API and serves an embedded web UI, so a single
// self-contained binary can deploy BPMN models, run instances, and (as the UI
// grows) view them in a browser. See ADR-0011.
//
// # Respecting the single-writer invariant
//
// The engine is a single-writer partition (invariant I3): exactly one goroutine
// may touch a partition's processor and state. HTTP handlers, by contrast, run
// concurrently. The Server bridges the two by owning a run loop goroutine that is
// the sole toucher of the processor; handlers submit closures to it via do and
// block for the result. No processor method is ever called from a handler
// goroutine directly.
//
// # Scope of the skeleton
//
// This is the Milestone S skeleton (ROADMAP.md): deploy XML, create an instance,
// read stats, health, and a static UI shell. Deployments are durable via an
// on-disk sidecar store (ADR-0019) reloaded on startup, so diagrams, versions,
// and recovered instances survive a restart; the eventual event-sourced
// deployment path arrives with the Milestone 4 public API. One honest limitation
// remains: there is no streaming job-worker transport yet (that follows the gRPC
// job protocol, ADR-0007), so an instance parks at its service task — exactly the
// "waiting token" the live viewer shows. Such a parked job can be finished by
// hand over HTTP (POST /jobs/{key}/complete, the operator mirror of .../fail from
// the incident model), but that is a synchronous operator affordance, not the
// leased, at-least-once worker protocol.
package api

import (
	"bytes"
	"context"
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/pblumer/atlas/checkpoint"
	"github.com/pblumer/atlas/clio"
	"github.com/pblumer/atlas/compiler"
	"github.com/pblumer/atlas/dmn"
	"github.com/pblumer/atlas/engine"
	"github.com/pblumer/atlas/job"
	"github.com/pblumer/atlas/mail"
	"github.com/pblumer/atlas/model"
	"github.com/pblumer/atlas/opensearch"
	"github.com/pblumer/atlas/remedy"
	"github.com/pblumer/atlas/rest"
	"github.com/pblumer/atlas/script"
	"github.com/pblumer/atlas/sharepoint"
	"github.com/pblumer/atlas/state"
	"github.com/pblumer/atlas/temis"
	"github.com/pblumer/atlas/webscrape"
)

// dmnResolverFromEnv picks the DMN model source. When ATLAS_DMN_RESOLVER_URL is
// set, models are fetched from that temis model service (with an optional bearer
// token from ATLAS_DMN_RESOLVER_TOKEN); otherwise the zero-config on-disk folder
// dir is used. Both satisfy dmn.Resolver (ADR-0034/0014).
func dmnResolverFromEnv(dir string) dmn.Resolver {
	if base := strings.TrimSpace(os.Getenv("ATLAS_DMN_RESOLVER_URL")); base != "" {
		return dmn.ServiceResolver{
			BaseURL: base,
			Token:   strings.TrimSpace(os.Getenv("ATLAS_DMN_RESOLVER_TOKEN")),
		}
	}
	return dmn.DirResolver{Dir: dir}
}

// temisRegistryFromEnv builds a temis decision-connector registry from the
// environment alone (the pre-managed mechanism, ADR-0041's env secret model):
// ATLAS_TEMIS_CONNECTORS lists names, and per name N, ATLAS_TEMIS_<N>_URL /
// ATLAS_TEMIS_<N>_TOKEN configure it. Managed connector instances are layered on
// top of this by [Server.buildTemisClients]; this helper is the env-only base.
func temisRegistryFromEnv() *temis.Registry {
	reg := temis.NewRegistry()
	reg.Replace(envTemisClients())
	return reg
}

// connectorEnvKey normalizes a connector name into its environment-variable
// fragment: upper-case, with each run of non-alphanumeric characters collapsed to
// a single underscore and leading/trailing underscores trimmed.
func connectorEnvKey(name string) string {
	var b strings.Builder
	pendingSep := false
	for _, r := range strings.ToUpper(name) {
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			if pendingSep && b.Len() > 0 {
				b.WriteByte('_')
			}
			pendingSep = false
			b.WriteRune(r)
		} else {
			pendingSep = true
		}
	}
	return b.String()
}

//go:embed web
var webFS embed.FS

// Version is the Atlas product version reported to the UI and the CLI. It is
// UI/display metadata only and unrelated to a deployment's process version.
//
// It is a var, not a const, so a release build can stamp the tag into it with
//
//	go build -ldflags "-X github.com/pblumer/atlas/api.Version=0.1.0"
//
// A plain checkout build keeps the "-dev" suffix; the exact commit is always
// available from the embedded VCS metadata (see buildInfo).
var Version = "0.1.0-dev"

// deployment is the server-side record of a deployed definition. The compiled
// process itself lives in the processor; here we keep the metadata the UI needs
// plus the original XML so the viewer can render it. DeployedAt is server-side
// display metadata (wall-clock at deploy time), not engine state.
type deployment struct {
	Key        uint64
	ProcessID  string
	Name       string // human-readable <process name="…">, for display
	Version    int32
	DeployedAt int64  // unix seconds, for the UI's "last changed" column
	ProjectID  string // project the deployment's draft belonged to, "" when none
	xml        []byte
	cp         *compiler.CompiledProcess // for the live overlay's element-id mapping
	// inactive mirrors the persisted deactivation flag (ADR-0119) so the process
	// listing can report it without re-reading the sidecar. The processor holds the
	// authoritative gate; this is the display copy, kept in sync on toggle and load.
	inactive bool
}

// Server hosts the engine behind an HTTP surface. Construct it with New, mount
// Handler on an http.Server, and call Close to stop the run loop.
type Server struct {
	proc  *engine.Processor
	store *state.Store

	// dataDir is the root under which every durable store lives (the WAL, the
	// state store, and the design-time sidecar directories). The backup/restore
	// endpoints (ADR-0107) read and write the design-time subtree of it; nothing
	// else needs it, so it is set once at construction and read-only thereafter.
	dataDir string

	// tasks carries closures to the single run-loop goroutine that owns the
	// processor; quit stops that goroutine.
	tasks chan func()
	quit  chan struct{}
	wg    sync.WaitGroup

	// The fields below are touched only on the run-loop goroutine (via do), so
	// they need no locking — the same single-owner discipline as process state.
	deployments      map[uint64]*deployment
	order            []uint64 // deployment keys in registration order, for stable listing
	nextKey          uint64
	versions         map[string]int32     // bpmnProcessId → highest version deployed
	deploys          *deployStore         // durable sidecar for deployments (ADR-0019)
	drafts           *draftStore          // durable sidecar for saved-but-not-deployed diagrams
	forms            *formStore           // durable sidecar for form definitions (ADR-0028)
	publicLinks      *publicLinkStore     // durable sidecar for public start links (ADR-0029)
	publicRate       *rateLimiter         // throttles the unauthenticated public endpoints
	projects         *projectStore        // durable sidecar for projects grouping artifacts (ADR-0034)
	releases         *releaseStore        // durable sidecar for application releases (ADR-0128)
	deployTokenStore *deployTokenStore    // durable sidecar for peer deploy tokens (ADR-0129)
	deployTokens     *deployTokenIndex    // in-memory hash->token index, read on the handler goroutine
	targets          *targetStore         // durable sidecar for peer deployment targets (ADR-0129)
	appVersions      map[string]int32     // applicationId → highest release version published (ADR-0128)
	processDocs      *processDocStore     // durable sidecar for process documentation versions (ADR-0138)
	docVersions      map[string]int32     // bpmnProcessId → highest documentation version published (ADR-0138)
	systemPIDs       map[string]bool      // process ids of the bootstrap-deployed platform processes, protected from deletion (ADR-0122)
	deploySysProcs   bool                 // opt-in: bootstrap-deploy the embedded platform processes at startup (ADR-0122)
	userProvisioning bool                 // opt-in: enable the user-provisioning connector for system processes (ADR-0123)
	dmnrefs          *dmnRefStore         // durable sidecar for DMN reference artifacts (ADR-0034)
	connectors       *connectorStore      // durable sidecar for managed connector instances (ADR-0041)
	callOverrides    *callOverrideStore   // durable sidecar for per-server call-activity target overrides (ADR-0105)
	marketplace      []marketplacePackage // curated, bundled marketplace catalog, immutable after New (ADR-0081)
	marketplaceStore *marketplaceStore    // durable sidecar for installed marketplace templates (ADR-0081)
	settings         *settingsStore       // durable sidecar for org-wide UI settings, e.g. the brand theme (ADR-0113)
	vault            *secretVault         // engine-internal encrypted secret store, nil when disabled (ADR-0069/0070)
	vaultEnabled     bool                 // whether to build the vault; on by default, off via WithoutVault (ADR-0070)
	users            *userStore           // durable sidecar for user accounts (ADR-0044)

	// sessions holds live login sessions in memory. Unlike the sidecar stores it
	// is touched from concurrent handler goroutines, so it guards itself with a
	// mutex; it is not engine state and does not persist (ADR-0044).
	sessions *sessionStore

	// collab holds live collaborative-editing sessions on drafts in memory
	// (ADR-0103). Like sessions it is reached from concurrent handler goroutines
	// (SSE streams and POSTs), guards itself with a mutex, and never persists or
	// touches the engine — it is design-time coordination around a draft, not
	// engine state.
	collab *collabRegistry

	// collabKeepalive is how often an idle SSE session stream writes a keepalive
	// comment. net/http only learns a client vanished when a write fails, so these
	// periodic writes are what detect a half-open (zombie) browser connection and
	// let its participant be reaped; they also keep proxies from timing out an idle
	// stream. WithCollabKeepaliveInterval overrides it (tests use a short value).
	collabKeepalive time.Duration

	// authEnabled gates authentication enforcement. Off by default: the server
	// stays fully open (single-user) until an operator opts in with WithAuth,
	// mirroring how docsEnabled gates the API explorer (ADR-0044/0043). Set once
	// before Handler is mounted; read-only thereafter.
	authEnabled bool

	// internalToken is a random secret minted at startup when auth is enabled. A
	// trusted in-process component (the MCP adapter) presents it as a bearer token
	// so its loopback API calls authenticate without a login (ADR-0049). It
	// resolves to a non-admin service principal. Empty when auth is off.
	internalToken string

	// dmnResolver turns a DMN reference handle into model XML; dmnValidator wraps
	// it with a temis compile for the deploy-time validation gate (ADR-0034).
	dmnResolver  dmn.Resolver
	dmnValidator *dmn.Validator

	// dmnRegistry holds the compiled DMN model for each deployed process (keyed by
	// def key); jobRunner drives the in-process DMN worker that evaluates business
	// rule tasks (ADR-0014). Both are touched only on the run-loop goroutine.
	dmnRegistry *dmn.Registry
	jobRunner   *job.Runner

	// scriptWorkers maps a script language's reserved job-type index to the
	// interpreter that runs it (ADR-0047). An operator registers each language with
	// WithScriptWorker; a language with no worker parks its tasks. Set once before
	// Handler is mounted; read-only thereafter.
	scriptWorkers map[int32]script.Exec

	// temisRegistry resolves a connector name to a temis service client for
	// *central* business rule tasks (ADR-0050), built from the environment at
	// startup (ADR-0041 secret model). Read only while driving jobs on the run loop.
	temisRegistry *temis.Registry

	// clioRegistry resolves a connector name to a clio event-store client for clio
	// connector tasks (write/query/read, ADR-0036), built from the managed
	// connector store at startup and rebuilt on every connector change, with each
	// endpoint token resolved from the vault (ADR-0041). Read only while driving
	// jobs on the run loop, so it needs no lock.
	clioRegistry *clio.Registry

	// mailRegistry resolves a connector name to a mail-provider client for outbound
	// mail connector tasks (ADR-0079), built from the managed connector store at
	// startup and rebuilt on every connector change, with each provider's credential
	// resolved from the vault (ADR-0041). Read only while driving jobs on the run
	// loop, so it needs no lock.
	mailRegistry *mail.Registry

	// sharePointRegistry resolves a connector name to the Microsoft Graph client for
	// SharePoint connector tasks (ADR-0105), built from the managed connector store at
	// startup and rebuilt on every connector change, with each connector's OAuth
	// credential resolved from the vault (ADR-0041). Read only while driving jobs on
	// the run loop, so it needs no lock.
	sharePointRegistry *sharepoint.Registry

	// remedyRegistry resolves a connector name to a BMC Remedy AR System client for
	// Remedy connector tasks (ADR-0106), built from the managed connector store at
	// startup and rebuilt on every connector change, with each instance's credential
	// bundle resolved from the vault (ADR-0041). Read only while driving jobs on the
	// run loop, so it needs no lock.
	remedyRegistry *remedy.Registry

	// inboundSubs holds the operator-configured clio inbound subscriptions the
	// inbound bridge polls (ADR-0075). Owned by the run-loop goroutine. inboundPoll
	// is that bridge's poll cadence (WithInboundPollInterval; 0 disables the bridge).
	inboundSubs *inboundSubStore
	inboundPoll time.Duration
	// inboundBatch caps how many clio events one poll of a subscription reads and
	// republishes (the ReadEvents Limit). It bounds the burst a single poll can hand
	// the run loop so a large backlog drains as bounded catch-up across ticks rather
	// than monopolizing the single writer with one unbounded publish storm (ADR-0075).
	inboundBatch int

	// osExportCfg is the OpenSearch event-exporter configuration (ADR-0114); it is
	// enabled only when a URL is set (WithOpenSearchExporter). exporter is the built
	// WAL-tailing sink, nil when disabled, and exporterPoll is its poll cadence. The
	// exporter runs on its own goroutine off the run loop — it only reads the durable
	// WAL files and the state store's applied-position watermark, never the processor
	// — so it never touches the single-writer invariant (I3).
	osExportCfg  opensearch.Config
	exporter     *opensearch.Exporter
	exporterPoll time.Duration
	// exporterTicks, when non-nil, replaces the exporter loop's real ticker so a test
	// drives each export pass explicitly rather than racing a wall-clock cadence.
	// exporterTicked, when non-nil, receives once after each triggered pass completes,
	// so a test awaits the pass it triggered without polling. Both are nil in
	// production (a real ticker drives the loop, nothing observes it). Set together by
	// withExporterTrigger — the same deterministic-test seam as the retention sweep.
	exporterTicks  <-chan time.Time
	exporterTicked chan struct{}

	// Retention (ADR-0115): hard-delete finished-instance history older than
	// retentionMaxAge, gated on the safe (exported, else durable) position so nothing
	// is deleted before it is archived. Off unless retentionMaxAge > 0 (WithRetention).
	// The sweep is bounded (retentionBatch per tick) and resumable (retentionCursor);
	// all three are touched only on the run-loop goroutine (via do), so no lock.
	retentionMaxAge   time.Duration
	retentionInterval time.Duration
	retentionBatch    int
	retentionCursor   uint64

	// now reads wall-clock time (unix nanoseconds) for the retention sweep's
	// eligibility cutoff. It is injected so a test can drive the cutoff
	// deterministically instead of tuning durations against real time — the same
	// discipline the engine applies to event timestamps (invariant I4). It defaults
	// to the system clock; a test overrides it with withClock, sharing one clock
	// with the engine so a finished instance's CompletedAt and the sweep's "now"
	// come from a single controllable source.
	now func() int64
	// retentionTicks, when non-nil, replaces the retention sweep's real ticker so a
	// test triggers each sweep explicitly rather than racing a wall-clock cadence.
	// retentionSwept, when non-nil, receives once after each triggered sweep
	// completes, so a test awaits the sweep it triggered without polling. Both are
	// nil in production (a real ticker drives the sweep, nothing observes it). Set
	// together by withRetentionTrigger.
	retentionTicks <-chan time.Time
	retentionSwept chan struct{}

	// Recovery checkpoints (ADR-0131): on a fixed cadence, snapshot the applied state
	// so a restart replays only the WAL suffix past it instead of the whole log — the
	// bounded-recovery-time property. Off unless checkpointInterval > 0
	// (WithCheckpoints); checkpointKeep bounds how many published checkpoints survive,
	// since each one hard-links the SSTables it captured and so pins their disk.
	// checkpointRoot is derived from the data dir through checkpoint.Dir, the same
	// function startup recovery resolves, so the two can never disagree.
	//
	// The snapshot itself runs on the run loop (via do), which is what makes its
	// position exact: no batch can be half-applied while it is taken (invariant I3).
	// Pruning runs off the loop — it only removes directories this goroutine published.
	checkpointRoot     string
	checkpointInterval time.Duration
	checkpointKeep     int
	// checkpointTicks, when non-nil, replaces the checkpoint loop's real ticker so a
	// test takes each checkpoint explicitly rather than racing a wall-clock cadence.
	// checkpointDone, when non-nil, receives once after each triggered pass completes.
	// Both are nil in production. Set together by withCheckpointTrigger — the same
	// deterministic-test seam as the retention sweep and the exporter.
	checkpointTicks <-chan time.Time
	checkpointDone  chan struct{}

	// docsEnabled gates the OpenAPI spec and the Scalar API explorer. On by
	// default (opt-out), consistent with the already-open web UI and MCP
	// endpoint; an operator who does not want the interactive surface disables
	// it with --docs=false / WithoutDocs (ADR-0043). Set once before Handler is
	// mounted; read-only thereafter.
	docsEnabled bool

	// logs is the recent-process-log tail exposed at GET /api/v1/logs, so an
	// operator can read server logs from the web UI without shell access. Nil when
	// the command did not wire a buffer (WithLogBuffer), in which case the endpoint
	// reports no lines. Set once at construction; read-only thereafter.
	logs *LogBuffer
}

// Option configures a Server at construction. Options are applied in New before
// the run loop starts, so they set fields that are read-only afterwards.
type Option func(*Server)

// WithLogBuffer wires the server's recent-log tail, exposed at GET /api/v1/logs,
// so an operator can read server logs from the web UI. The command builds the
// buffer, tees the standard logger into it, and passes it here.
func WithLogBuffer(b *LogBuffer) Option { return func(s *Server) { s.logs = b } }

// WithoutDocs disables the OpenAPI document at /api/v1/openapi.json and the
// Scalar API explorer at /api/docs, which are otherwise served by default. Pass
// it when the interactive, mutating "Try it out" surface should not be exposed
// (ADR-0043).
func WithoutDocs() Option { return func(s *Server) { s.docsEnabled = false } }

// WithSystemProcesses bootstrap-deploys Atlas's own embedded platform processes
// (user intake, access review, offboarding) into the protected system project at
// startup (ADR-0122). Opt-in — the installed binary (cmd/atlas) enables it, while
// the engine tests construct servers without it so a fresh instance still starts
// with no deployments.
func WithSystemProcesses() Option { return func(s *Server) { s.deploySysProcs = true } }

// WithUserProvisioning enables the in-process user-provisioning connector
// (create/set-password/disable Atlas logins) for the protected system project's
// processes (ADR-0123). Opt-in and off by default: it deliberately, and narrowly,
// reopens the ADR-0044/0049 boundary that no automated identity may manage users —
// so an instance keeps the human-in-the-loop ADR-0122 behavior until an operator
// turns this on. When off, a userConnector job has no worker and parks.
func WithUserProvisioning() Option { return func(s *Server) { s.userProvisioning = true } }

// WithInboundPollInterval sets the clio inbound bridge's poll cadence (ADR-0075).
// A non-positive interval disables the bridge (useful in tests that drive it
// directly). The default is 2s.
func WithInboundPollInterval(d time.Duration) Option {
	return func(s *Server) { s.inboundPoll = d }
}

// WithCollabKeepaliveInterval sets how often an idle collaboration SSE stream
// writes a keepalive comment, the mechanism that detects a half-open browser
// connection so its session participant is reaped (ADR-0103). A non-positive
// value restores the default (15s). Tests pass a short interval to exercise it.
func WithCollabKeepaliveInterval(d time.Duration) Option {
	return func(s *Server) {
		if d > 0 {
			s.collabKeepalive = d
		}
	}
}

// WithInboundBatchLimit caps how many clio events one poll of a subscription reads
// and republishes (ADR-0075). A non-positive value restores the default. It bounds
// the burst a single poll hands the run loop; a large backlog then drains as
// bounded catch-up across ticks instead of one unbounded publish storm.
func WithInboundBatchLimit(n int) Option {
	return func(s *Server) {
		if n > 0 {
			s.inboundBatch = n
		}
	}
}

// WithoutVault disables the engine-internal encrypted secret vault, which is
// otherwise on by default (ADR-0070). With it disabled the secret endpoints
// return 503 and connector credentials resolve only from the environment
// (ADR-0041 A2). Pass it when Atlas must not custody a key or ciphertext at all.
func WithoutVault() Option { return func(s *Server) { s.vaultEnabled = false } }

// WithScriptWorker registers the interpreter for one script language (identified
// by its reserved job-type index, e.g. compiler.PwshJobTypeIndex), so a deployed
// script task in that language actually runs instead of parking on its job
// (ADR-0047). It executes arbitrary interpreter code on the server host, so
// register only the languages whose trust boundary is acceptable (the eventual
// isolation boundary is an external worker in the customer's environment). exec is
// the interpreter seam — pass script.New(script.Python) etc., or a fake in tests.
func WithScriptWorker(jobType int32, exec script.Exec) Option {
	return func(s *Server) {
		if s.scriptWorkers == nil {
			s.scriptWorkers = map[int32]script.Exec{}
		}
		s.scriptWorkers[jobType] = exec
	}
}

// WithOpenSearchExporter enables the OpenSearch event exporter (ADR-0114): a
// WAL-tailing sink that mirrors the durable event log into an OpenSearch index so
// history stays searchable and can outlive engine-side retention. It is opt-in —
// a config with an empty URL leaves the exporter off. The endpoint, credentials,
// and index live in server config, never in a model.
func WithOpenSearchExporter(cfg opensearch.Config) Option {
	return func(s *Server) { s.osExportCfg = cfg }
}

// WithOpenSearchExportInterval sets how often the exporter polls the log for newly
// durable records (ADR-0114). A non-positive value restores the default (5s).
// Tests pass a short interval to exercise the loop.
func WithOpenSearchExportInterval(d time.Duration) Option {
	return func(s *Server) {
		if d > 0 {
			s.exporterPoll = d
		}
	}
}

// withExporterTrigger replaces the exporter loop's real ticker with an explicit tick
// channel and, optionally, a completion channel signaled after each triggered export
// pass. It is unexported — a test seam, not an operator knob — so a test drives export
// passes deterministically: send on ticks, receive on ticked, then assert, with no
// wall-clock cadence or polling (ADR-0114). Mirrors withRetentionTrigger.
func withExporterTrigger(ticks <-chan time.Time, ticked chan struct{}) Option {
	return func(s *Server) {
		s.exporterTicks = ticks
		s.exporterTicked = ticked
	}
}

const (
	// retentionSweepInterval is the default cadence of the history-retention sweep.
	retentionSweepInterval = time.Minute
	// retentionBatchDefault bounds how many finished instances one sweep tick evaluates,
	// so the scan never blocks the run loop (ADR-0115 / ADR-0085 no-full-scan rule).
	retentionBatchDefault = 1000
)

// WithRetention enables history retention (ADR-0115): a finished instance whose
// terminal event is older than maxAge and whose events are already exported (its
// terminal position is at or below the safe position) is hard-deleted from the state
// store. A non-positive maxAge leaves retention off — the opt-in default.
func WithRetention(maxAge time.Duration) Option {
	return func(s *Server) {
		if maxAge > 0 {
			s.retentionMaxAge = maxAge
		}
	}
}

// WithRetentionInterval sets the retention sweep cadence (ADR-0115). A non-positive
// value restores the default. Tests pass a short interval to exercise the sweep.
func WithRetentionInterval(d time.Duration) Option {
	return func(s *Server) {
		if d > 0 {
			s.retentionInterval = d
		}
	}
}

// WithRetentionBatch caps how many finished instances one retention sweep tick
// evaluates and purges (ADR-0115), bounding the work a single tick does on the run
// loop; a larger backlog then drains as bounded catch-up across ticks. A non-positive
// value restores the default.
func WithRetentionBatch(n int) Option {
	return func(s *Server) {
		if n > 0 {
			s.retentionBatch = n
		}
	}
}

// withClock overrides the server clock the retention sweep reads for its eligibility
// cutoff (unix nanoseconds). It is unexported — a test seam, not an operator knob — so
// a test can share one deterministic clock with the engine and make a finished
// instance's age exact rather than tuned against real time (invariant I4).
func withClock(now func() int64) Option {
	return func(s *Server) {
		if now != nil {
			s.now = now
		}
	}
}

// withRetentionTrigger replaces the retention sweep's real ticker with an explicit
// tick channel and, optionally, a completion channel signaled after each triggered
// sweep. It is unexported — a test seam — so a test drives sweeps deterministically:
// send on ticks, receive on swept, then assert, with no wall-clock cadence or polling.
func withRetentionTrigger(ticks <-chan time.Time, swept chan struct{}) Option {
	return func(s *Server) {
		s.retentionTicks = ticks
		s.retentionSwept = swept
	}
}

const (
	// checkpointKeepDefault is how many published checkpoints survive a prune. More
	// than one so a checkpoint found to be corrupt at restore time still has an older
	// one behind it; few enough that the SSTables they pin stay bounded (ADR-0131).
	checkpointKeepDefault = 3
)

// WithCheckpoints enables periodic recovery checkpoints at the given cadence
// (ADR-0131). Each one snapshots the applied state, so a restart replays only the log
// past it rather than from genesis — recovery time becomes a function of the cadence
// instead of the log's whole length.
//
// It is purely additive: nothing is deleted, the WAL stays the source of truth, and a
// missing, failed, or corrupt checkpoint only makes the next recovery slower (invariant
// I2). A non-positive cadence leaves checkpointing off.
func WithCheckpoints(every time.Duration) Option {
	return func(s *Server) {
		if every > 0 {
			s.checkpointInterval = every
		}
	}
}

// WithCheckpointRetention sets how many published checkpoints are kept (ADR-0131). A
// checkpoint hard-links the SSTables it captured, so keeping every one would pin every
// file the store ever wrote; keeping a few leaves a fallback if the newest is corrupt.
// A non-positive value restores the default.
func WithCheckpointRetention(keep int) Option {
	return func(s *Server) {
		if keep > 0 {
			s.checkpointKeep = keep
		}
	}
}

// withCheckpointTrigger replaces the checkpoint loop's real ticker with an explicit
// tick channel and, optionally, a completion channel signaled after each triggered
// pass. It is unexported — a test seam, not an operator knob — so a test takes
// checkpoints deterministically: send on ticks, receive on done, then assert, with no
// wall-clock cadence or polling. Mirrors withRetentionTrigger.
func withCheckpointTrigger(ticks <-chan time.Time, done chan struct{}) Option {
	return func(s *Server) {
		s.checkpointTicks = ticks
		s.checkpointDone = done
	}
}

// New builds a Server over an already-recovered processor and its store and
// starts the run-loop goroutine. dataDir is the base data directory; the durable
// deployment and draft sidecar stores live in its "deployments" and "drafts"
// subdirectories (ADR-0019). New reloads any deployments found there,
// re-registering them with the processor so recovered instances resolve their
// definition and the UI can render diagrams again. The caller retains ownership
// of proc and store (Close here stops only the loop, not the engine).
func New(proc *engine.Processor, store *state.Store, dataDir string, opts ...Option) (*Server, error) {
	ds, err := newDeployStore(filepath.Join(dataDir, "deployments"))
	if err != nil {
		return nil, err
	}
	drafts, err := newDraftStore(filepath.Join(dataDir, "drafts"))
	if err != nil {
		return nil, err
	}
	forms, err := newFormStore(filepath.Join(dataDir, "forms"))
	if err != nil {
		return nil, err
	}
	publicLinks, err := newPublicLinkStore(filepath.Join(dataDir, "public-links"))
	if err != nil {
		return nil, err
	}
	projects, err := newProjectStore(filepath.Join(dataDir, "projects"))
	if err != nil {
		return nil, err
	}
	processDocs, err := newProcessDocStore(filepath.Join(dataDir, "process-docs"))
	if err != nil {
		return nil, err
	}
	releases, err := newReleaseStore(filepath.Join(dataDir, "releases"))
	if err != nil {
		return nil, err
	}
	deployTokenStore, err := newDeployTokenStore(filepath.Join(dataDir, "deploy-tokens"))
	if err != nil {
		return nil, err
	}
	targets, err := newTargetStore(filepath.Join(dataDir, "targets"))
	if err != nil {
		return nil, err
	}
	dmnrefs, err := newDmnRefStore(filepath.Join(dataDir, "dmnrefs"))
	if err != nil {
		return nil, err
	}
	users, err := newUserStore(filepath.Join(dataDir, "users"))
	if err != nil {
		return nil, err
	}
	connectors, err := newConnectorStore(filepath.Join(dataDir, "connectors"))
	if err != nil {
		return nil, err
	}
	callOverrides, err := newCallOverrideStore(filepath.Join(dataDir, "call-overrides"))
	if err != nil {
		return nil, err
	}
	marketplaceStore, err := newMarketplaceStore(filepath.Join(dataDir, "marketplace"))
	if err != nil {
		return nil, err
	}
	// The marketplace catalog is curated and compiled into the binary (ADR-0081);
	// an invalid bundled package is a build error, so it fails construction here.
	marketplaceCatalog, err := loadBundledCatalog()
	if err != nil {
		return nil, err
	}
	inboundSubs, err := newInboundSubStore(filepath.Join(dataDir, "inbound-subscriptions"))
	if err != nil {
		return nil, err
	}
	settings, err := newSettingsStore(filepath.Join(dataDir, "settings"))
	if err != nil {
		return nil, err
	}
	// DMN reference models are resolved either from a temis model service (when
	// configured) or the zero-config <data-dir>/dmn-models folder. Both satisfy the
	// Resolver interface, so the rest of the server is unaffected (ADR-0034/0014).
	resolver := dmnResolverFromEnv(filepath.Join(dataDir, "dmn-models"))
	s := &Server{
		proc:        proc,
		store:       store,
		dataDir:     dataDir,
		tasks:       make(chan func()),
		quit:        make(chan struct{}),
		deployments: map[uint64]*deployment{},
		nextKey:     1,
		versions:    map[string]int32{},
		deploys:     ds,
		drafts:      drafts,
		forms:       forms,
		publicLinks: publicLinks,
		// A public start link tolerates a modest burst then ~1 start/sec per IP;
		// generous for a human intake form, throttling for a script (ADR-0029).
		publicRate:        newRateLimiter(20, 1),
		projects:          projects,
		releases:          releases,
		deployTokenStore:  deployTokenStore,
		deployTokens:      newDeployTokenIndex(),
		targets:           targets,
		appVersions:       map[string]int32{},
		processDocs:       processDocs,
		docVersions:       map[string]int32{},
		dmnrefs:           dmnrefs,
		connectors:        connectors,
		callOverrides:     callOverrides,
		marketplace:       marketplaceCatalog,
		marketplaceStore:  marketplaceStore,
		inboundSubs:       inboundSubs,
		settings:          settings,
		inboundPoll:       2 * time.Second,        // default cadence; WithInboundPollInterval overrides, 0 disables
		inboundBatch:      defaultInboundBatch,    // per-poll ReadEvents cap; WithInboundBatchLimit overrides
		exporterPoll:      5 * time.Second,        // OpenSearch export cadence; WithOpenSearchExportInterval overrides (ADR-0114)
		retentionInterval: retentionSweepInterval, // history-retention sweep cadence; WithRetentionInterval overrides (ADR-0115)
		retentionBatch:    retentionBatchDefault,  // finished instances evaluated per sweep tick
		checkpointKeep:    checkpointKeepDefault,  // published checkpoints kept; WithCheckpointRetention overrides (ADR-0131)
		vaultEnabled:      true,                   // opt-out: built unless WithoutVault is passed (ADR-0070)
		users:             users,
		sessions:          newSessionStore(defaultSessionTTL),
		collab:            newCollabRegistry(),
		collabKeepalive:   collabKeepaliveInterval,
		dmnResolver:       resolver,
		dmnValidator:      dmn.NewValidator(resolver),
		dmnRegistry:       dmn.NewRegistry(),
		docsEnabled:       true, // opt-out: served unless WithoutDocs is passed (ADR-0043)
	}
	// The retention sweep reads its eligibility cutoff from the system clock by
	// default; the options below may replace it (withClock) for a deterministic
	// test. Set here rather than in the literal above to keep the literal's comment
	// alignment intact (invariant I4).
	s.now = func() int64 { return time.Now().UnixNano() }
	// The checkpoint root is derived, not configurable: recovery resolves the same
	// path through checkpoint.Dir, and a knob here could only make them disagree
	// (ADR-0131). Set outside the literal for the same alignment reason as above.
	s.checkpointRoot = checkpoint.Dir(dataDir)
	for _, opt := range opts {
		opt(s)
	}
	// The encrypted secret vault (ADR-0069) is on by default (ADR-0070) unless
	// WithoutVault disabled it. An operator key from the environment is preferred
	// and never persisted; absent one, a key is loaded from — or generated into —
	// <data-dir>/vault.key so the vault works with no provisioning. Built after the
	// options so WithoutVault takes effect before any key file is touched.
	if s.vaultEnabled {
		key, source, err := resolveVaultKey(filepath.Join(dataDir, "vault.key"))
		if err != nil {
			return nil, err
		}
		if s.vault, err = newSecretVault(filepath.Join(dataDir, "vault"), key); err != nil {
			return nil, err
		}
		if source == "generated" {
			log.Printf("vault: generated a master key at %s (mode 0600); set ATLAS_VAULT_KEY "+
				"for a stronger at-rest posture or pass --vault=false to disable (ADR-0070)",
				filepath.Join(dataDir, "vault.key"))
		}
	}
	// When enforcement is on, make sure a fresh instance has an admin to log in
	// with (ADR-0044) and mint the internal service token the in-process MCP
	// adapter uses to authenticate its loopback calls (ADR-0049). Both run before
	// the loop serves traffic, so touching the user store directly here respects
	// the single-writer discipline.
	if s.authEnabled {
		if err := s.bootstrapAdmin(time.Now().Unix()); err != nil {
			return nil, err
		}
		token, err := randomHex(32)
		if err != nil {
			return nil, err
		}
		s.internalToken = token
	}
	// Ensure the protected system project exists (ADR-0122). Like bootstrapAdmin,
	// this runs on the constructing goroutine before the loop serves traffic, so it
	// touches the project store directly within the single-writer discipline. It is
	// idempotent, so it is safe on every start regardless of auth.
	if err := s.ensureSystemProject(time.Now().Unix()); err != nil {
		return nil, err
	}
	// The in-process DMN worker evaluates business rule tasks off no separate
	// goroutine (the single-binary server drives jobs synchronously on the run
	// loop). One handler serves every process: it resolves each job's decision,
	// inputs, and result variable from the compiled process the job belongs to
	// (ProcessLookup), so it registers once under the reserved DMN job type
	// (compiler.DMNJobTypeIndex). It registers via HandleCompleting because a
	// decision's completion both writes its result back as a process variable and
	// retains the evaluation (inputs, outputs, trace) for debugging (ADR-0066).
	s.jobRunner = job.NewRunner(store, proc)
	s.jobRunner.HandleCompleting(compiler.DMNJobTypeIndex, dmn.Handler(store, s.processLookup, s.dmnRegistry, nil))
	// Script-language workers (PowerShell, Python, JavaScript) each register under
	// their reserved job type and resolve each job's script from the compiled
	// process via processLookup, exactly like the DMN worker (ADR-0047). They run
	// arbitrary interpreter code, so only the languages an operator registered with
	// WithScriptWorker subscribe; the rest park.
	for jobType, exec := range s.scriptWorkers {
		s.jobRunner.HandleWithOutput(jobType, script.Handler(store, s.processLookup, exec))
	}
	// Managed connector job workers (temis, clio, mail, sharepoint, remedy): one
	// registry plus job worker(s) per kind, all driven from the managedConnectorKinds
	// registry so adding a kind needs no new block here. Each registry is created and
	// built before the loop serves traffic and rebuilt on every connector change; a
	// task whose connector is not configured parks until it is.
	if err := s.setupManagedConnectors(store); err != nil {
		return nil, err
	}
	// An HTTP-REST connector task calls a model-authored endpoint (ADR-0067). One
	// worker serves every process under the reserved REST job type; it resolves each
	// job's method/url/headers/query/result-variable from the compiled process, calls
	// the API off the run loop and after fsync, and writes the JSON response into the
	// task's result variable. The endpoint and headers live in the model; a request's
	// authentication secret is a *reference* the worker resolves at call time from the
	// environment (resolveConnectorSecret, ADR-0041), so a token never lives in a model.
	s.jobRunner.HandleWithOutput(compiler.RestJobTypeIndex, rest.Handler(store, s.processLookup, rest.NewHTTPClient(), s.resolveConnectorSecret))
	// A CSV-import service task parses an uploaded CSV (a `csvText` variable) against
	// a `columnConfig` layout into a `rows` collection, in-process, so a batch of
	// records is ingested and validated on the engine with the file arriving through a
	// user-task form rather than a side-channel endpoint (ADR-0087). One worker serves
	// every process under the reserved CSV-import job type.
	s.jobRunner.HandleWithOutput(compiler.CsvImportJobTypeIndex, csvImportHandler(store, s.processLookup))
	// A web-scraping service task fetches a model-authored URL and extracts the
	// elements matching a CSS selector, in-process, off the run loop and after fsync,
	// writing the extracted values into the task's result variable as a JSON array.
	// The URL and selector live in the model, like REST (ADR-0118). One worker serves
	// every process under the reserved web-scrape job type.
	s.jobRunner.HandleWithOutput(compiler.WebScrapeJobTypeIndex, webscrape.Handler(store, s.processLookup, webscrape.NewHTTPClient()))
	// User-provisioning connector (ADR-0123), opt-in. The handler mutates the
	// run-loop-owned user store, so it is a closure over s and runs on the loop (the
	// server drives jobs synchronously); it is gated at runtime to the system project.
	if s.userProvisioning {
		s.jobRunner.Handle(compiler.UserConnectorJobTypeIndex, s.userConnectorHandler(s.store))
	}
	if err := s.loadDeployments(); err != nil {
		return nil, err
	}
	// Rebuild the per-application release counter from the durable release records,
	// so the next publish after a restart continues the sequence (ADR-0128).
	if err := s.loadReleaseVersions(); err != nil {
		return nil, err
	}
	// Same discipline for the per-process documentation counter, so an export after
	// a restart continues the sequence instead of minting a second v1 (ADR-0138).
	if err := s.loadProcessDocVersions(); err != nil {
		return nil, err
	}
	// Peer deploy tokens (ADR-0129) into the in-memory index the auth middleware
	// reads, so a peer's credential keeps working across a restart.
	if err := s.loadDeployTokens(); err != nil {
		return nil, err
	}
	// Push per-server call-activity overrides into the processor. Runs after
	// loadDeployments so a pin's version resolves to a definition key, and before the
	// loop serves traffic so touching the processor directly is single-writer-safe
	// (ADR-0105).
	if err := s.loadCallOverrides(); err != nil {
		return nil, err
	}
	// Bootstrap-deploy Atlas's own platform processes into the protected system
	// project (ADR-0122), when enabled. Runs after loadDeployments so its
	// idempotency check sees the recovered deployments (a restart adds no versions),
	// and before the loop serves traffic so the deploy path is single-writer-safe —
	// the same discipline loadDeployments itself uses.
	if s.deploySysProcs {
		if err := s.ensureSystemProcesses(time.Now().Unix()); err != nil {
			return nil, err
		}
		// Mint the public start link for the self-service registration process so a
		// fresh instance's login screen offers a "Registrieren" link out of the box
		// (ADR-0126). Runs after ensureSystemProcesses so the default process is
		// deployed, and before the loop serves so the mint is single-writer-safe.
		if err := s.ensureRegistrationLink(time.Now().Unix()); err != nil {
			return nil, err
		}
	}
	// Build the OpenSearch exporter when configured (ADR-0114). It tails the durable
	// WAL under dataDir and is bounded by the state store's applied-position
	// watermark (LastAppliedPosition), so it only ever indexes records that are on
	// disk — durable-before-visible (I2) — while never touching the processor.
	if s.osExportCfg.Enabled() {
		exp, err := opensearch.New(
			filepath.Join(dataDir, "wal"),
			s.store.LastAppliedPosition,
			opensearch.NewHTTPClient(s.osExportCfg),
			s.osExportCfg.Index,
			opensearch.NewPositionStore(filepath.Join(dataDir, "exporter")),
		)
		if err != nil {
			return nil, err
		}
		s.exporter = exp
	}

	s.wg.Add(3)
	go s.loop()
	go s.timerScheduler(time.Second)
	// The collaboration reaper evicts idle detached session participants (MCP
	// agents that stopped polling) and releases their locks (ADR-0103). It runs off
	// the run loop — the collab registry is its own mutex-guarded, engine-independent
	// state — so it never touches the processor or the invariants.
	go s.collabReaper(collabReapInterval)
	// The clio inbound bridge polls configured subscriptions and republishes new
	// clio events as Atlas messages (ADR-0075). It is a separate goroutine like the
	// timer scheduler — it does its network reads off the run loop and hands only the
	// resulting publish onto it (invariant I3). A non-positive interval disables it.
	if s.inboundPoll > 0 {
		s.wg.Add(1)
		go s.inboundBridge(s.inboundPoll)
	}
	// The OpenSearch exporter tails the durable log and bulk-indexes new records
	// (ADR-0114). Like the timer scheduler and inbound bridge it is a separate
	// goroutine doing its I/O off the run loop; it reads only the durable WAL files
	// and the concurrent-safe applied-position watermark, so it never funnels
	// through do() and never touches the processor (invariant I3).
	if s.exporter != nil {
		s.wg.Add(1)
		go s.exporterLoop(s.exporterPoll)
	}
	// History retention hard-deletes finished instances past the max age, gated on the
	// exported (else durable) position (ADR-0115). Off unless a max age is configured.
	// Like the other pollers it computes wall-clock time off the run loop and hops onto
	// it via do() to touch the processor and its bounded, resumable cursor.
	if s.retentionMaxAge > 0 {
		s.wg.Add(1)
		go s.retentionSweeper(s.retentionInterval)
	}
	// Recovery checkpoints bound restart time (ADR-0131). Off unless a cadence is
	// configured. Unlike the pollers above, this one's actual work happens *on* the run
	// loop — a snapshot is only exact at a batch boundary (invariant I3) — so the
	// goroutine exists to own the cadence and the off-loop pruning, not the snapshot.
	if s.checkpointInterval > 0 {
		s.wg.Add(1)
		go s.checkpointLoop(s.checkpointInterval)
	}
	return s, nil
}

// exporterLoop polls the durable log on a fixed cadence and hands each newly
// durable batch of records to the OpenSearch exporter (ADR-0114). A tick error
// (OpenSearch unreachable, a transient index failure) is logged and retried on the
// next tick — the exporter leaves its high-water mark unadvanced on failure, so no
// record is skipped and delivery stays at-least-once.
//
// The trigger is a seam for deterministic tests: production runs a real ticker,
// while a test injects an explicit tick channel (withExporterTrigger) so an export
// pass runs exactly when the test says — no cadence to race, no polling. When
// exporterTicked is set the loop signals it after each triggered pass so the test can
// await completion. This mirrors the retention sweep's clock/ticker seam.
func (s *Server) exporterLoop(every time.Duration) {
	defer s.wg.Done()
	ticks := s.exporterTicks
	if ticks == nil {
		t := time.NewTicker(every)
		defer t.Stop()
		ticks = t.C
	}
	for {
		select {
		case <-s.quit:
			return
		case <-ticks:
			if n, err := s.exporter.Tick(context.Background()); err != nil {
				log.Printf("opensearch exporter: %v (will retry next tick)", err)
			} else if n > 0 {
				log.Printf("opensearch exporter: indexed %d record(s)", n)
			}
			if s.exporterTicked != nil {
				select {
				case s.exporterTicked <- struct{}{}:
				case <-s.quit:
					return
				}
			}
		}
	}
}

// retentionSweeper runs the history-retention sweep on a fixed cadence (ADR-0115).
// Wall-clock "now" is read from s.now() off the run loop; the sweep itself hops onto
// the loop via do() so its scan, purge commands, and cursor are single-writer-safe.
//
// The trigger and clock are seams for deterministic tests (invariant I4): production
// runs a real ticker and the system clock, while a test injects an explicit tick
// channel and a fixed clock (withRetentionTrigger/withClock) so a sweep fires exactly
// when the test says and evaluates a time the test controls — no scheduling luck, no
// wall-clock-tuned durations. When retentionSwept is set the sweeper signals it after
// each triggered sweep so the test can await completion.
func (s *Server) retentionSweeper(every time.Duration) {
	defer s.wg.Done()
	ticks := s.retentionTicks
	if ticks == nil {
		t := time.NewTicker(every)
		defer t.Stop()
		ticks = t.C
	}
	for {
		select {
		case <-s.quit:
			return
		case <-ticks:
			now := s.now()
			s.do(func() { s.sweepRetention(now) })
			if s.retentionSwept != nil {
				select {
				case s.retentionSwept <- struct{}{}:
				case <-s.quit:
					return
				}
			}
		}
	}
}

// sweepRetention evaluates one bounded, resumable window of finished instances and
// hard-deletes those eligible: finished before now-maxAge AND provably exported (a
// non-zero terminal position at or below the safe position). It runs inside a do()
// turn, so the scan, the purge commands it enqueues, and the cursor advance are one
// atomic single-writer step (ADR-0115). Errors are logged and retried next tick.
func (s *Server) sweepRetention(now int64) {
	// A transient read error just skips this tick (retried on the next), matching the
	// silent, best-effort style of the other run-loop pollers (timerScheduler).
	safePos, err := s.retentionSafePosition()
	if err != nil {
		return
	}
	cutoff := now - s.retentionMaxAge.Nanoseconds()
	type target struct {
		key uint64
		pi  model.ProcessInstanceValue
	}
	var targets []target
	next, more, err := s.store.CompletedProcessInstancesFrom(s.retentionCursor, s.retentionBatch,
		func(key uint64, v *model.ProcessInstanceValue) error {
			// Eligible only when old enough AND export-provable: a zero CompletedPosition
			// (a record written before this feature) is never provably exported, so it is
			// conservatively skipped rather than deleted (ADR-0115).
			if v.CompletedAt <= cutoff && v.CompletedPosition != 0 && v.CompletedPosition <= safePos {
				targets = append(targets, target{key, *v})
			}
			return nil
		})
	if err != nil {
		return
	}
	for i := range targets {
		s.proc.PurgeInstance(targets[i].key, &targets[i].pi)
	}
	if len(targets) > 0 {
		_ = s.jobRunner.Drive() // durable purge events; a drive error is retried next tick
		log.Printf("retention: purged %d finished instance(s) past %s", len(targets), s.retentionMaxAge)
	}
	// Advance the cursor; wrap to genesis at the end so the next pass re-evaluates
	// instances that have since aged past the cutoff or become exported.
	if more {
		s.retentionCursor = next
	} else {
		s.retentionCursor = 0
	}
}

// retentionSafePosition is the highest log position safe to hard-delete up to: the
// exporter's high-water mark when the exporter is enabled (delete only what OpenSearch
// already holds — the operator's export-before-delete requirement), otherwise the
// state store's durable applied position (retention still works standalone, with the
// WAL as the archive of record). See ADR-0115.
func (s *Server) retentionSafePosition() (uint64, error) {
	if s.exporter != nil {
		return s.exporter.HighWaterMark(), nil
	}
	return s.store.LastAppliedPosition()
}

// checkpointLoop publishes a recovery checkpoint on a fixed cadence and prunes the
// ones it makes redundant (ADR-0131). A failed pass is logged and retried on the next
// tick: a checkpoint is an optimization over the WAL, never a durability step, so
// losing one costs a slower recovery and nothing else (invariant I2).
//
// The trigger is the same seam the retention sweep and exporter use — production runs
// a real ticker, a test injects an explicit channel (withCheckpointTrigger) so a
// checkpoint is taken exactly when the test says. When checkpointDone is set the loop
// signals it after each triggered pass so the test can await completion.
func (s *Server) checkpointLoop(every time.Duration) {
	defer s.wg.Done()
	ticks := s.checkpointTicks
	if ticks == nil {
		t := time.NewTicker(every)
		defer t.Stop()
		ticks = t.C
	}
	// last is the position most recently reported as published. An idle server
	// re-publishes nothing (Publish is a no-op at an existing position), so tracking it
	// keeps the cadence from logging the same line forever. Only this goroutine reads
	// or writes it, so it stays a local.
	var last uint64
	for {
		select {
		case <-s.quit:
			return
		case <-ticks:
			if pos := s.takeCheckpoint(); pos != 0 && pos != last {
				last = pos
				log.Printf("checkpoint: published at log position %d (recovery replays only past it)", pos)
			}
			if s.checkpointDone != nil {
				select {
				case s.checkpointDone <- struct{}{}:
				case <-s.quit:
					return
				}
			}
		}
	}
}

// takeCheckpoint publishes one checkpoint and prunes older ones, returning the position
// it captured (zero when nothing was published — an idle server or a failed pass).
//
// The snapshot hops onto the run loop via do(): between batches, the store's applied
// position and the state it holds agree exactly, which is precisely what makes a
// checkpoint's consistency boundary meaningful (invariant I3). Pruning then runs off
// the loop, keeping directory removal and an fsync out of the writer's way; it is safe
// there because only this goroutine ever publishes into the root.
func (s *Server) takeCheckpoint() uint64 {
	var pos uint64
	var err error
	s.do(func() {
		var applied uint64
		if applied, err = s.store.LastAppliedPosition(); err != nil || applied == 0 {
			return // nothing durable yet: there is no state worth snapshotting
		}
		pos, err = s.proc.Checkpoint(s.checkpointRoot)
	})
	if err != nil {
		log.Printf("checkpoint: %v (will retry next tick)", err)
		return 0
	}
	if pos == 0 {
		return 0
	}
	if err := checkpoint.Prune(s.checkpointRoot, s.checkpointKeep); err != nil {
		log.Printf("checkpoint: prune: %v (will retry next tick)", err)
	}
	return pos
}

// processLookup resolves a def key to its compiled process for the DMN worker. It
// is called only while driving jobs on the run-loop goroutine, so reading the
// deployment registry here needs no locking.
func (s *Server) processLookup(defKey uint64) *compiler.CompiledProcess {
	if d, ok := s.deployments[defKey]; ok {
		return d.cp
	}
	return nil
}

// loadDeployments rebuilds the in-memory deployment registry and re-registers
// each definition with the processor from the durable store, so a restart
// restores diagrams, names, versions, and the ability to advance recovered
// instances (ADR-0019). It runs before the loop serves traffic, so touching the
// registry and the processor directly here respects the single-writer invariant.
func (s *Server) loadDeployments() error {
	recs, err := s.deploys.loadAll()
	if err != nil {
		return err
	}
	for _, rec := range recs {
		// Recompile exactly the process this record represents (a collaboration's
		// XML holds several), keyed as originally assigned (ADR-0019/0022).
		cp, err := compiler.ParseNamed(rec.Key, rec.Version, bytes.NewReader([]byte(rec.XML)), rec.ProcessID)
		if err != nil {
			// A stored model that no longer compiles is a hard, actionable error
			// rather than a silently dropped definition (ADR-0019).
			return fmt.Errorf("api: reload deployment %d (%s v%d): %w", rec.Key, rec.ProcessID, rec.Version, err)
		}
		cp.Version = rec.Version
		s.proc.Deploy(cp)
		// Re-register the process's DMN models so its business rule tasks evaluate
		// after a restart, exactly as they did when first deployed (ADR-0014). The
		// models are snapshotted in the deployment record (a legacy record carries a
		// single model), so no temis reference has to be re-resolved here.
		for _, dmnXML := range rec.dmnModels() {
			if err := s.dmnRegistry.Deploy(rec.Key, []byte(dmnXML)); err != nil {
				return fmt.Errorf("api: reload dmn model for def %d (%s): %w", rec.Key, rec.ProcessID, err)
			}
		}
		// Restore the deactivation flag (ADR-0119) before the loop serves traffic and
		// before timers tick, so a start timer restored from the log finds the definition
		// inactive and skips instantiation. loadDeployments does not re-arm timers (they
		// come back from the WAL), so this is the only place recovery re-applies the gate.
		if rec.Inactive {
			s.proc.SetProcessActive(rec.Key, false)
		}
		s.deployments[rec.Key] = &deployment{
			Key:        rec.Key,
			ProcessID:  rec.ProcessID,
			Name:       rec.Name,
			Version:    rec.Version,
			DeployedAt: rec.DeployedAt,
			ProjectID:  rec.ProjectID,
			xml:        []byte(rec.XML),
			cp:         cp,
			inactive:   rec.Inactive,
		}
		s.order = append(s.order, rec.Key)
		if rec.Version > s.versions[rec.ProcessID] {
			s.versions[rec.ProcessID] = rec.Version
		}
		if rec.Key >= s.nextKey {
			s.nextKey = rec.Key + 1
		}
	}
	return nil
}

// timerScheduler fires due timers on the run-loop goroutine at a fixed cadence,
// so intermediate timer events wake up without any external command. The tick is
// coarse (whole seconds) — timers are "fire at or after due", not real-time.
func (s *Server) timerScheduler(every time.Duration) {
	defer s.wg.Done()
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-s.quit:
			return
		case <-t.C:
			// Fire due timers, then drive any jobs they unblocked (e.g. a timer
			// leading into a business rule task) to completion.
			s.do(func() {
				if err := s.proc.TickTimers(); err != nil {
					return
				}
				_ = s.jobRunner.Drive()
			})
		}
	}
}

// collabReaper periodically evicts detached collaboration-session participants
// (AI agents that joined over MCP and stopped polling) that have gone silent past
// the TTL, releasing their locks so a crashed or forgotten agent never holds an
// element forever (ADR-0103). Browser SSE participants are reaped on disconnect
// instead and are exempt. It runs off the run loop — the collab registry is its
// own mutex-guarded, engine-independent state — so it never touches the processor.
func (s *Server) collabReaper(every time.Duration) {
	defer s.wg.Done()
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-s.quit:
			return
		case <-t.C:
			if n := s.collab.reap(); n > 0 {
				log.Printf("collab: reaped %d idle session participant(s) past the %s TTL (ADR-0103)", n, collabParticipantTTL)
			}
		}
	}
}

// loop is the single owner of the processor. Every processor and registry access
// funnels through here, so the single-writer invariant holds even though HTTP
// handlers are concurrent.
func (s *Server) loop() {
	defer s.wg.Done()
	for {
		select {
		case <-s.quit:
			return
		case fn := <-s.tasks:
			fn()
		}
	}
}

// do runs fn on the run-loop goroutine and blocks until it completes. If the
// server is closing, fn does not run and do returns immediately; callers must
// treat their result variables' zero values as "not produced".
func (s *Server) do(fn func()) {
	done := make(chan struct{})
	select {
	case s.tasks <- func() { defer close(done); fn() }:
		<-done
	case <-s.quit:
	}
}

// Close stops the run-loop goroutine. It does not close the processor, log, or
// store — the caller owns those.
func (s *Server) Close() {
	close(s.quit)
	s.wg.Wait()
}

// Handler returns the HTTP handler: JSON API under /api/v1, /healthz, the
// embedded web UI at the root, and — when docs are enabled (WithDocs) — the
// OpenAPI document at /api/v1/openapi.json and the Scalar API explorer at
// /api/docs.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok\n"))
	})

	// Every /api/v1 route is registered from the single-source-of-truth route
	// table, the same list openapiDoc describes, so the served surface and its
	// OpenAPI spec cannot drift (ADR-0043).
	for _, r := range s.apiRoutes() {
		mux.HandleFunc(r.method+" "+r.pattern, r.handler)
	}

	// The OpenAPI document and the Scalar API explorer are gated behind --docs:
	// the explorer's "Try it out" exercises the same unauthenticated, mutating
	// surface as the API, so an operator opts in explicitly (ADR-0043). The
	// vendored Scalar asset is served by the file server below at /vendor/scalar/.
	if s.docsEnabled {
		mux.HandleFunc("GET /api/v1/openapi.json", s.handleOpenAPI)
		mux.HandleFunc("GET /api/docs", s.handleDocs)
		mux.HandleFunc("GET /api/docs/", s.handleDocs)
	}

	// Public, unauthenticated start links (ADR-0029). These live under /public/,
	// outside the /api/v1 surface auth gates, and expose exactly one thing: the
	// start form for one token. They are rate-limited in the handlers.
	mux.HandleFunc("GET "+publicProcessDocPath+"{token}", s.handlePublicProcessDoc)
	mux.HandleFunc("GET /public/forms/{token}", s.handlePublicFormPage)
	mux.HandleFunc("GET /public/forms/{token}/schema", s.handlePublicFormSchema)
	mux.HandleFunc("POST /public/forms/{token}/start", s.handlePublicFormStart)

	// The embedded UI is the catch-all; the more specific API patterns above win
	// under net/http's precedence rules.
	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		// webFS is compiled in, so this only fails on a broken build.
		panic("api: embedded web assets missing: " + err.Error())
	}
	mux.Handle("/", http.FileServerFS(sub))

	// Resolve a Principal for every request and, when enforcement is on, gate the
	// mutating /api/v1 surface behind a valid session (ADR-0044). With auth off
	// (the default) this is a transparent pass-through.
	return s.withAuth(mux)
}

// readStats reads the live instance counts. It must be called on the run-loop
// goroutine (inside do).
func (s *Server) readStats() (statsResp, error) {
	pi, err := s.store.ActiveProcessInstanceCount()
	if err != nil {
		return statsResp{}, err
	}
	ei, err := s.store.ActiveElementInstanceCount()
	if err != nil {
		return statsResp{}, err
	}
	return statsResp{ActiveProcessInstances: pi, ActiveElementInstances: ei}, nil
}

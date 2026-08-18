# ADR-0138: Process documentation export

- **Status:** Accepted
- **Date:** 2026-08-18
- **Deciders:** Atlas maintainers

## Context and problem statement

A BPMN model in Atlas is readable only inside Atlas. The people who most need to
read a process — auditors, a compliance officer, a new employee, the business
owner signing off on it — are exactly the people who do not have a Modeler open
and often do not have an account at all. Today the only way to hand them a
process is a screenshot plus a verbal walkthrough, which loses the very thing
that makes the model authoritative: the per-element `documentation` text and the
`textAnnotation` notes the modellers wrote *into* the diagram.

Three needs come together:

1. **One artifact for the whole process** — the graphic and the prose about every
   element in a single document, not a picture and a wiki page that drift apart.
2. **Historization** — "what did this process look like when we signed it off in
   March?" must be answerable. That means an immutable, numbered version, not a
   file that is regenerated and overwritten.
3. **Distribution to a wider audience** — a reader without an Atlas login must be
   able to open it, and that access must be revocable.

The question this ADR answers: where does the document get produced, and what is
the durable shape of a produced version?

## Decision drivers

- **The diagram must look like the diagram.** A reader comparing the PDF against
  the Modeler must not find a different picture. Rendering divergence is a
  correctness problem here, not a cosmetic one.
- **Operational simplicity.** Atlas ships as a single CGO-free Go binary
  (ADR-0124, ADR-0134). Anything that adds a runtime dependency to the *server*
  costs every operator, forever.
- **Design-time only.** A document describes a model; it is not an engine fact.
  It must not touch the WAL, `applyToState`, or recovery (I2, I4).
- **Reuse the established durable-record pattern** rather than inventing a new
  one — the deployment, draft, form, project, release, and public-link stores all
  already agree on how a design-time record is persisted.

## Considered options

1. **Render in the browser, store on the server.** The UI already runs bpmn-js
   and draws the authoritative picture; it produces the PDF and uploads it.
2. **Render server-side with a headless browser.** The server drives Chromium
   over the same web page and prints it to PDF.
3. **Render server-side in pure Go.** The server parses BPMN-DI and re-draws the
   diagram into a Go PDF library.

## Decision outcome

Chosen option: **"Render in the browser, store on the server"**, because it is
the only option that gets the picture right for free. The browser is already
holding the exact rendered diagram — the same bpmn-js canvas the modeller is
looking at — so exporting it cannot diverge from what the Modeler shows. Options
2 and 3 both re-derive the picture and would need continuous work to stay
faithful, and each buys that at the price of a permanent server-side dependency
(a Chromium binary in the container; or a hand-written BPMN renderer in Go on top
of the layout generator ADR-0124 already owns).

The PDF is written by a small, dependency-free PDF writer that ships with the web
UI (`api/web/pdf.js`) rather than a vendored PDF library. What this document
needs — pages, the standard Helvetica faces, wrapped paragraphs, tables of
element prose, and one embedded raster of the diagram — is a small subset of PDF,
and the vendored JS assets in this repository are already megabytes each. A
focused writer we understand is cheaper to own than a general one we do not. The
diagram raster is a JPEG produced from the bpmn-js SVG via a canvas, embedded
with the `DCTDecode` filter so its bytes go into the file untranscoded.

### The durable shape

A **process documentation version** (`processDoc`) is an immutable record:

- `Version` is a **per-`processId` counter, 1-based** — the same layering
  ADR-0128 uses for application releases above ADR-0019 per-process deployment
  versions. It answers "which documented state of this process is that?"
- The record is a **JSON sidecar** (`<hex-id>.json`) with the **PDF stored beside
  it** as `<hex-id>.pdf`, both written with the ADR-0019/0021 atomic-write +
  directory-fsync discipline (`api/sidecar.go`). The PDF is bytes, not JSON, so
  it gets `atomicWriteFile`; `atomicWriteJSON` becomes a thin caller of it.
- The record **snapshots by value** what it documented: the process id, the
  deployment key and version if the model was deployed, the element summaries,
  and the BPMN XML the document was produced from. Later edits to the model
  cannot rewrite the history of what was already documented.
- Like releases, the counter is **rebuilt from the records at startup**
  (`loadProcessDocVersions`), so a restart continues the sequence rather than
  restarting it at v1 — the same discipline `loadDeployments` and
  `loadReleaseVersions` follow.

### Sharing

A version may be shared by minting an **opaque, revocable token** that serves the
PDF at `/public/process-docs/{token}`, reusing ADR-0029's public-link mechanism
verbatim: 32 bytes of crypto randomness, hex-encoded, validated as bare hex so a
crafted token cannot traverse the store directory. The token lives on the version
record, so sharing is per-version — publishing v3 to an audience does not
retroactively expose v1, and revoking is a single `DELETE`.

Sharing is **off by default**. A version is private until someone explicitly
shares it, because the whole point of the artifact is that it leaves the system.

### Consequences

- **Positive:** the exported picture is by construction the picture the Modeler
  draws; no new server dependency; no new value type, event, or recovery path;
  the version history is immutable and answerable; the public link is revocable
  and per-version.
- **Negative / trade-offs accepted:** producing a document requires the web UI
  (there is no server-side `POST /documentation/generate` that renders on its
  own), so an unattended nightly export is not possible without a browser.
  Accepted: the artifact is a deliberate act of publication with a note and an
  author, not a cron job. The diagram in the PDF is a raster, not vector text, so
  it does not reflow or select — accepted, because the element prose that a
  reader actually searches is rendered as real text in the structured section
  below it.
- **Follow-ups / risks to watch:** the store grows without bound (each version
  keeps a PDF); ADR-0115's retention discipline should eventually cover it. A
  future slice could diff two versions.

## Pros and cons of the options

### Option 1 — render in the browser
- Good: the rendered diagram is the authoritative one, at zero cost.
- Good: no server-side dependency; the server only validates and stores bytes.
- Bad: export needs an open browser; no headless/scheduled generation.

### Option 2 — headless browser on the server
- Good: faithful rendering *and* server-side generation.
- Bad: puts a Chromium binary (hundreds of MB, its own CVE stream, its own
  sandbox requirements) into every Atlas deployment, contradicting the
  single-binary posture.

### Option 3 — pure Go renderer
- Good: no foreign runtime; fits ADR-0124's "Atlas owns its layout in Go".
- Bad: re-implements BPMN shape and edge rendering, which then has to be kept in
  step with bpmn-js forever. The picture *will* drift, and the drift is silent.

## Links

- relates to [ADR-0019](0019-durable-deployments.md) — per-processId versioning
- relates to [ADR-0029](0029-public-process-start-links.md) — the revocable public-token mechanism reused here
- relates to [ADR-0124](0124-server-side-diagram-auto-layout.md) — why Atlas does not take a foreign rendering runtime
- relates to [ADR-0128](0128-process-applications.md) — the release counter layered above deployment versions

# Multi-source scheduling: options for the rdm kernel

Status: **design/options note**, 2026-11-09. Scope: one logical object with N
candidate sources (mirrors, CDN endpoints, HF/ModelScope equivalents, later
cross-protocol sources). Not in scope: BitTorrent swarms (a different engine),
DNS/CDN anycast (transparent already), and server-side mirror selection.

Companion decision note: [protocol-extension-priorities.md](protocol-extension-priorities.md).
Code-seam evidence: [protocol-extension/repo-seams.md](protocol-extension/repo-seams.md).

---

## 0. TL;DR

There are four *levels* of multi-source, and they should not be conflated:

1. **Select one source at start** (probe all, pick the best).
2. **Fail over** to the next source when the active one fails.
3. **Switch mid-transfer** (at a chunk boundary) when the active source stalls
   or collapses.
4. **Assign/race chunks across sources** (aria2-style adaptive scheduling).

The measured pain in this project — the same object at **0.13 MiB/s on HF vs
106 MiB/s on ModelScope** — is solved by **level 1 alone**. Level 2 adds
robustness. Levels 3–4 add throughput but multiply correctness, rate-limit and
abuse risk. Recommended sequence:

| Wave | Scope | Effort | Why |
|---|---|---|---|
| **v1** | Explicit `sources[]` → parallel probe → select one → failover on fatal/stall | **S/M** | Captures the measured 800× selection case with the least risk; HTTP-only; no byte mixing. |
| **v2** | Hedged start (top-2 for the first N MB) + mid-transfer switch at a chunk boundary; per-source health/EWMA | **M** | Handles bad probes and mid-transfer throttling; still one source per byte range. |
| **v3** | Per-chunk dynamic assignment across a source pool (aria2 `feedback`/`adaptive`-class), per-source caps | **M/L** | Maximum aggregate throughput; only with a content-identity proof and quarantine/refetch. |
| **v4** | Metalink/HTTP `Link rel=duplicate` discovery, `.meta4` files, cross-protocol sources | **S + protocol work** | Standards-based discovery + hashes; depends on FTP/S3/torrent sources existing. |

**The hard gate is content identity, not scheduling.** Never mix bytes from
different sources unless they are proven byte-identical (`expectedSha256`, or
same size + same strong validator). Today the kernel's identity is URL-based
(`ResumeState.url` / `url_identity`, `kernel/src/state.rs:39-63`,
`kernel/src/protocol.rs:847-853`); multi-source requires a source-independent
**content key** first. Without it, levels 3–4 can silently corrupt a file that
only the final SHA-256 catches — after the whole download.

---

## 1. Why this is not just "try the next URL"

The current kernel is single-source by construction:

* one `url` in the request (`RequestSpec.url`, `kernel/src/protocol.rs:110-124`)
  and one `Spec.url` (`:126-141`);
* one probe result (`ServerFacts`) and one `Meta.final_url`
  (`kernel/src/protocol.rs:104-108`);
* one `reqwest::Client`, one URL and one `If-Range` validator in the chunked
  engine (`kernel/src/engine/chunked.rs:27-63`), and one request site in the
  single-stream engine (`kernel/src/engine/single.rs:99-121`);
* one target/path in `TaskView`/`TaskDetail` (`kernel/src/protocol.rs:521-574`);
* resume compatibility keyed on URL identity (`kernel/src/state.rs:39-63`);
* a per-host origin ledger (`kernel/src/origins.rs:122-147`) that already
  records completed/failed attempts and median/best throughput — a useful prior,
  but only per host, not per URL/object.

Multi-source also stays a documented non-goal today
([README.md:286](../../README.md), [PROTOCOL.md:770-772](../../PROTOCOL.md)), so
this is a product decision as much as an engineering one.

Three properties of the problem decide the design:

1. **Discovery** — where do the candidate URLs come from? The agent, a
   provider API, a Metalink/HTTP header, or a torrent web seed?
2. **Identity** — how do we know every source serves the same bytes? A wrong
   mirror (different revision, gzip/HTML error page, malicious host) is worse
   than a slow mirror.
3. **Work assignment** — one source at a time, a priority chain, a hedge, or a
   per-chunk pool? Each level buys throughput at a different risk.

---

## 2. Option catalogue

### 2.1 O0 — Agent-level manual selection (status quo, zero kernel change)

The agent calls `rdm_probe` for two URLs, compares `sampleBps` / origin facts,
then calls `rdm_download` on the faster one.

* **Buys:** nothing to build; full agent control; works today.
* **Costs:** 2+ model steps per download; no failover; no mid-transfer switch;
  the agent must know the mirror list; the two facts are not in one comparable
  result.
* **Use:** stopgap, not a product feature.

### 2.2 O1 — Pre-flight selection (`sources[]`, probe all, pick one)

`rdm_download` (and optionally `rdm_probe`) accepts an explicit candidate list.
The kernel probes all candidates concurrently (bounded, e.g. 4–8, per-source
timeout), ranks them, picks one, and keeps the rest as ranked alternates.

* **Ranking inputs:** measured probe sample (`sampleBps`), origin-ledger median
  and failure rate for the host, proven range support, validator strength,
  signed-URL expiry vs expected transfer time, `Retry-After`, TLS validity,
  size/identity agreement.
* **Transfer:** exactly one source; no byte mixing; existing engine unchanged
  except for source construction.
* **Buys:** directly fixes the HF-vs-ModelScope case; the agent sees one task
  with `selectedSource` + `alternates` in one result instead of N probes.
* **Costs:** N probes before the transfer (HEAD + 64-byte range each); a short
  probe can be unrepresentative (a source may look fast then throttle); no
  failover after start.
* **Effort:** **S/M** (HTTP-only; no `Source` seam strictly required).
* **Verdict:** **recommended v1.**

### 2.3 O2 — Failover chain (one active source at a time)

Sources are ranked (explicit priority or O1 score). If the active source returns
a fatal error after retries (404/403/410, repeated timeouts, TLS failure) or its
signed URL expires, switch to the next candidate, validate identity, and resume
from the existing chunk table.

* **Buys:** robustness; a dead mirror no longer fails the task; the origin
  ledger learns which hosts are bad.
* **Costs:** a switch is only discovered after failure; the alternate may have
  expired credentials; no speed gain while the active source works.
* **Effort:** **S** on top of O1.
* **Verdict:** include in v1 if capacity allows.

### 2.4 O3 — Hedged start (race the first bytes)

Start the top-2 (or top-3) sources concurrently for the first N MB (or the first
K chunks). The first source to deliver a complete, validated chunk wins; the
others are cancelled/kept as standby, and the transfer sticks to the winner.

* **Buys:** protects against an unrepresentative probe; quickly finds the truly
  faster source; bounded downside.
* **Costs:** duplicate bytes (N MB × losers); cancellation/TLS teardown;
  per-source credentials; identity must be proven before accepting bytes.
* **Effort:** **M**.
* **Verdict:** v2.

### 2.5 O4 — Mid-transfer switching (stall / collapse)

Keep one active source, but monitor its own EWMA and stall time. When it stalls
or its throughput collapses versus its own peak (the existing controller already
detects the collapse case and rebuilds the HTTP pool,
`kernel/src/controller.rs:91-100`), switch to the best alternate at the next
chunk boundary instead of only rebuilding the same pool.

* **Buys:** handles CDN throttling, HF flakiness, per-connection degradation;
  makes the controller's `RebuildPool` effect smarter ("switch source first,
  then rebuild").
* **Costs:** switch overhead (new TCP/TLS/auth); oscillation if the alternate is
  also slow; resume identity must be content-based; tail chunks are a bad place
  to switch.
* **Effort:** **M**.
* **Verdict:** v2.

### 2.6 O5 — Per-chunk dynamic assignment (aria2-like)

All sources live in a pool. Each claim picks a source by measured EWMA
throughput/latency/health, with per-source connection caps and weights; the
global worker target is split proportionally. A bad source is quarantined.

* **Buys:** maximum aggregate throughput; uses every mirror; handles
  heterogeneous sources (one fast, several slow).
* **Costs:** requires content-identity proof and per-source validation; per-source
  rate limits/`Retry-After`; more connections and more load on mirrors;
  malicious-mirror risk; two-level controller (global target × per-source
  weights); harder telemetry.
* **Prior art:** aria2's `--uri-selector=inorder|feedback|adaptive`,
  `--reuse-uri`, server-stat profiles, Metalink multi-source; Metalink/HTTP
  (RFC 6249) explicitly allows parallel range requests across mirrors.
* **Effort:** **M/L** after the `Source` seam.
* **Verdict:** v3, **only** with `expectedSha256` or a trusted mirror list.

### 2.7 O6 — Region partitioning

Split the byte range into contiguous regions and assign regions to sources by
capacity; each source owns its region; rebalance when one slows.

* **Buys:** deterministic, fewer switches, good for stable heterogeneous
  mirrors; easy to reason about per-source progress.
* **Costs:** capacity estimation and rebalancing are the hard part; long-tail
  chunks still need work stealing; not obviously better than O5.
* **Effort:** **M/L**.
* **Verdict:** later; O5 subsumes it for long transfers.

### 2.8 O7 — Redundant fetch / hash race

Fetch the same chunk from two sources; accept the first response that matches
the expected bytes/hash; discard the duplicate.

* **Buys:** latency/SLA, or safety when mirrors are untrusted.
* **Costs:** double bandwidth; only sensible for small critical files or when
  trust is low.
* **Effort:** **M** (needs per-chunk verification).
* **Verdict:** niche, not default.

### 2.9 O8 — Cross-protocol / Metalink sources

One logical object is available over HTTP, FTP, S3, and later a torrent web
seed. Metalink (RFC 5854) lists mirror URIs, priority, size and hashes;
Metalink/HTTP (RFC 6249) advertises mirrors/hashes via `Link: rel=duplicate` and
`Digest` on the response, and explicitly permits parallel range requests across
selected mirrors.

* **Buys:** standard discovery + strong identity (hashes); mirrors across
  protocols; ideal fit for the `Source` abstraction.
* **Costs:** few servers emit Metalink/HTTP; `.meta4` files are rare outside
  distros; full value needs FTP/BT sources to exist.
* **Effort:** **S** parse + existing engines, after protocol work.
* **Verdict:** v4.

---

## 3. Discovery options

| Option | How | Trust / identity | When |
|---|---|---|---|
| **Explicit `sources[]`** | Agent/user passes ranked URLs with per-source headers/auth | Caller asserts equivalence; kernel still verifies size/validators/hash | **v1** |
| **Host-side provider resolver** (HF ↔ ModelScope) | Host maps repo/file/revision to candidate URLs; compares provider metadata (LFS SHA-256, size) | Strong if hashes match; wrong-repo risk without confirmation | v2, host-side |
| **Metalink/HTTP `Link rel=duplicate`** | Probe parses `Link` headers + `Digest`/`Content-Digest` | Standards-based; hash if present | v2/v3 |
| **Metalink `.meta4` file** | Parse RFC 5854 XML into a source list + hashes | Strong (hash + size) | v3 |
| **Torrent web seeds / magnet** | BitTorrent engine later | Piece hashes; different object model | v4 |
| **Auto-scraped mirrors** | Search/registry heuristics | Weak; wrong-model/revision risk | **do not** |

Practical rule: the kernel accepts a **candidate list**; discovery outside the
kernel is allowed only if it can attach a content hash or an explicit user
confirmation. Do not auto-mix mirrors the caller did not ask for.

---

## 4. Identity and correctness — the gate

### 4.1 Content-identity levels

| Level | Proof | Allowed |
|---|---|---|
| **A** | `expectedSha256` supplied (HF LFS oid, distro checksum, Metalink hash) | full mixing/racing; final SHA-256 verifies; on mismatch, quarantine and (v3) refetch suspect ranges |
| **B** | Same `totalBytes` + same strong ETag | HTTP mirrors; selection + per-chunk mixing with ETag check per response |
| **C** | Same size + Last-Modified only | selection/failover only; **no byte mixing**; final hash recommended |
| **D** | Same filename/size only | **refuse multi-source mixing**; selection allowed with a warning |

Add a stable error `source_identity_unproven` when the caller asks for racing
without proof. This is the single most important safety rule in the feature.

### 4.2 Resume identity

`ResumeState` currently stores `url`, `final_url`, `etag`, `last_modified`,
`url_identity`, `final_url_identity` (`kernel/src/state.rs:39-63`). For
multi-source:

* add a source-independent **content key** (`sha256:<hex>` when known, else
  `size:<n>;etag:<strong>` or a conservative `weak:<size>`);
* compatibility is decided on the content key, not the URL;
* keep per-source facts for display/telemetry, but the chunk table must be
  source-independent;
* on resume after a restart, re-probe the selected source and any alternate
  until one matches the content key.

### 4.3 Per-source validators

Each source has its own `If-Range`/ETag. The engine must not reuse one source's
validator against another. `Shared.if_range` becomes per-source (or per active
source) and is re-derived when switching.

### 4.4 Signed URLs, auth, rate limits

* Each source can carry different credentials and a different signed-URL
  expiry. Never send source A's `Authorization`/cookie to source B.
* Selection must penalise a URL whose expiry is shorter than the expected
  remaining transfer, and must not pause a transfer on an expiring URL.
* Per-source rate limits: respect `Retry-After`; add per-source connection caps
  and split the global `speedLimitBps` across active sources.
* Redaction must cover every source URL, not just the requested one; userinfo is
  currently **not** redacted (`kernel/src/protocol.rs:810-839`) — fix before
  credential-bearing sources.

### 4.5 Final verification

Always verify `expectedSha256` when supplied. On mismatch in a multi-source
transfer, mark the task failed and report which sources contributed which byte
ranges; v3 can re-fetch suspect ranges from another source. A final hash that
fails after a 30 GiB download is expensive — this is the argument for level A
proof before racing, not after.

---

## 5. Kernel design sketch

### 5.1 Request shape

```rustc
struct SourceSpec {
    url: String,
    headers: BTreeMap<String, String>,   // per source
    cookie: Option<String>,
    priority: Option<u32>,               // explicit ordering
    weight: Option<u32>,                 // optional capacity hint
}

enum SourcePolicy { Select, Failover, Race } // default: Single
```

`RequestSpec.url` stays as the primary/compat field; `RequestSpec.sources`
is additive. `sourcePolicy` defaults to `single`; multi-source is opt-in.

### 5.2 Probe and select

* Probe candidates concurrently, bounded (e.g. 4), per-source timeout (e.g. 5 s).
* Apply hard filters: scheme supported, identity compatible, size known (for
  segmented), signed URL not already expired, TLS valid (unless `insecure`).
* Score:
  `score = w1·log(1+predicted_bps) + w2·range_support + w3·validator_strength − w4·risk − w5·expiry_penalty`
  where `predicted_bps` is a shrunk combination of the probe sample and the
  origin-ledger median (the ledger already exists, `kernel/src/origins.rs:122-147`).
* Persist `selectedSource`, `alternates[]`, per-source facts, and a
  `sourceSelection` reason on the task.
* `rdm_probe` with `sources[]` returns all facts + a recommendation, so the
  agent can see the comparison in one call.

### 5.3 Transfer

* v1/v2: `Shared` holds a `SourcePool` with one active index; claims use the
  active source; on failure/stall switch at a chunk boundary.
* v3: `Shared` holds all sources; per-claim selection by EWMA/health; per-source
  connection caps; global target split by weights; quarantine on repeated
  errors; requeue claims from a quarantined source.
* `RebuildPool` becomes "switch source if a healthy alternate exists, else
  rebuild the active pool" (`kernel/src/controller.rs:91-100`).

### 5.4 Wire / tool / UI

* `rdm_download`: `sources?` (array), `sourcePolicy?`, `expectedSha256?` (already
  exists; stronger recommendation in multi-source mode).
* `rdm_probe`: `sources?` returns per-source facts + a recommendation.
* `TaskView`: `selectedSource`, `sources` summary (id/host/state/bps), `sourceSwitches`.
* `TaskDetail`: full per-source facts, health, bytes/wasted bytes.
* Events: `source-selected`, `source-switched`, `source-quarantined`,
  `source-identity-mismatch`.
* Receipts: `source=… alt=…` and `switch=…` lines; the model reads the render.
* UI: source chips, per-source throughput, active source, switch markers.
* Protocol: additive fields first; **PROTOCOL 3** with the full source model if
  `ServerFacts`/`TaskView` gain discriminators (see the protocol note).

### 5.5 Config

* `multiSource` (default `false` / opt-in), `maxSources`, `sourceRaceBytes`,
  `maxConnectionsPerSource`, `sourceSwitchCooldown`, `sourcePolicyDefault`.
* Per-source speed share: split the global token bucket; never exceed the
  global cap.

---

## 6. Selection and switching policy (v1/v2)

1. **Probe:** all candidates; record facts.
2. **Filter:** identity, scheme, expiry, size, TLS, status.
3. **Rank:** score above; keep top N.
4. **Start:** top source; optionally hedge the first `raceBytes` across top-2.
5. **Switch:** on fatal error, or stall > 10 s, or throughput < 50 % of the
   source's own peak for 10 s; only at a chunk boundary; max 3 switches with a
   30 s cooldown; never during tail drain.
6. **Learn:** write the outcome to the origin ledger (completed/failed/bps) so
   the next selection is better; record per-source switches in history.
7. **Verify:** final SHA-256; on mismatch, fail with source attribution.

Explicitly do **not** switch on a single slow chunk or a transient 5xx before
the existing retry budget is exhausted; the current retry/backoff already
handles those.

---

## 7. Options comparison

| Option | Throughput gain | Robustness | Correctness risk | Effort | Verdict |
|---|---|---|---|---|---|
| O0 manual | 0 | low | low | 0 | stopgap |
| O1 select-one | **high** (fixes the 800× case) | low | low | S/M | **v1** |
| O2 failover | low | **high** | low | S | **v1** |
| O3 hedged start | medium | medium | medium | M | v2 |
| O4 mid-switch | medium | **high** | medium | M | v2 |
| O5 per-chunk race | **highest** | medium | **high** | M/L | v3 (hash required) |
| O6 regions | high | medium | medium | M/L | later |
| O7 redundant | 0 (2× bytes) | high (trust) | low | M | niche |
| O8 Metalink | discovery | — | low (hashes) | S + protocols | v4 |

---

## 8. Recommended plan

**v1 (the next multi-source release):** explicit `sources[]` + parallel probe +
select-one + failover; content key in resume state; per-source facts and one
receipt line. HTTP-only; no engine rewrite; no byte mixing. This is the highest
value per week and directly addresses the measured HF-vs-ModelScope case.

**v2:** hedged start + mid-transfer switch; per-source EWMA/health; controller
`RebuildPool` prefers a source switch when a healthy alternate exists.

**v3:** per-chunk dynamic assignment (aria2 `feedback`/`adaptive` class) with
per-source caps, quarantine/refetch, and a mandatory `expectedSha256` (or
trusted mirror list).

**v4:** Metalink/HTTP discovery, `.meta4`, cross-protocol sources after FTP/S3
exist.

**Sequencing vs protocols:** this track is HTTP-only and orthogonal to HLS/FTP/
S3. If the user-visible complaint is *speed*, v1 should ship before the Tier-2
protocols (and possibly before HLS); if it is *coverage*, HLS stays first. They
can share the Phase 0 `Source` seam, but v1 does not depend on it.

---

## 9. Open questions

1. Does the agent pass sources explicitly, or does the host resolve known
   mirrors (HF↔ModelScope)? Recommend explicit first; resolver later with
   hash confirmation.
2. Is `expectedSha256` required for v3 racing, or is a trusted-mirror list
   enough? Recommend required unless all sources share a strong ETag.
3. What is the default policy — `single`, `select`, or `failover`? Recommend
   `single` (no behaviour change without opt-in).
4. How to split the global speed limit across sources, and what per-source
   connection cap is polite enough for public mirrors?
5. How to attribute corrupt bytes to a source: per-chunk source log (memory
   cost) vs per-range event at switch boundaries?
6. Do we auto-resume a multi-source task after a kernel restart? Which source
   is re-probed first?
7. Does `rdm_probe` return all source facts, or a separate `rdm_sources` tool?
8. How does this interact with HLS (segment-level CDN mirrors) and Metalink
   (source list + hashes)?
9. UI: show per-source throughput only in the drawer, or also a compact source
   chip in the task row?
10. Protocol 3 timing: source fields are additive, but `TaskView`/`ServerFacts`
    shape changes may force the bump with HLS anyway.

---

## 10. Prior art and sources

* aria2 URI selection: `--uri-selector=inorder|feedback|adaptive`,
  `--reuse-uri`, `--server-stat-of/--server-stat-if` performance profiles,
  Metalink multi-source support:
  <https://man.archlinux.org/man/aria2c.1.en>
  (see also <https://deepwiki.com/aria2/aria2/3.4-metalink-support>).
* Metalink/HTTP mirrors and hashes (RFC 6249), including `Link: rel=duplicate`
  and parallel range requests across mirrors:
  <https://datatracker.ietf.org/doc/rfc6249/>
* Metalink XML (RFC 5854):
  <https://www.rfc-editor.org/rfc/rfc5854.html>
* HTTP `Link` header (RFC 8288) and `Content-Digest` (RFC 9530):
  <https://www.rfc-editor.org/rfc/rfc8288.html>,
  <https://www.rfc-editor.org/rfc/rfc9530.html>
* Local measured source spread (HF 0.13 MiB/s vs ModelScope 106 MiB/s):
  [demand-evidence.md §4](protocol-extension/demand-evidence.md).
* Kernel coupling: `kernel/src/{protocol,state,origins,controller}.rs`,
  `kernel/src/engine/{chunked,single}.rs`, `src/tools.ts`.

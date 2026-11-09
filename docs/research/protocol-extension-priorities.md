# Protocol extension priorities for the rdm kernel

Status: **decision note**, 2026-11-09. Scope: the *network/application
protocols* the resident Rust kernel can download from. The kernel's internal
NDJSON wire protocol (currently v2) is a separate concern: it must bump to v3
when the first non-file source family ships, but that bump is a consequence of this
decision, not the goal.

Evidence base (three parallel research notes):

* [`protocol-extension/repo-seams.md`](protocol-extension/repo-seams.md) — where
  HTTP is assumed in the kernel/host, a minimal `Source` seam, wire/test/build
  impact, per-family effort from the code.
* [`protocol-extension/demand-evidence.md`](protocol-extension/demand-evidence.md)
  — external demand, competitor support, failure modes, demand tiers, ~90 links.
* [`protocol-extension/rust-landscape.md`](protocol-extension/rust-landscape.md)
  — crates/engines, licenses, binary-size and cross-platform cost, security.

---

## 0. Decision (short)

**Build HLS VOD first; make the current dishonest successes impossible first.**

| Order | Item | Scope | Effort | Why |
|---|---|---|---|---|
| **P0** | **Recognition + honest refusal** (not a protocol) | `.m3u8` / `.mpd` / `.torrent` content sniffing and `magnet:` handling: typed `unsupported` + next step, never save the manifest/metadata as the payload | **1–2 days** | Today an HTTP-only kernel returns a 1–10 KB "successful" file for these; this is the worst failure class for the agent loop. Cheapest demand win in the whole study. |
| **P1** | **HLS VOD** | Direct `.m3u8` (master/media), VOD only (`EXT-X-ENDLIST`), TS + fMP4 concatenation, AES-128, variant selection. No live, no DRM, no site extraction. | **L** (≈2–3 weeks) | Highest demand (media is where HTTP-only fails), single output file fits the existing task model, no new credential class. |
| **P2** | **S3-compatible object stores** | `s3://bucket/key`, SigV4 header/query signing, region redirect, `ListObjectsV2`; presigned HTTPS already works. Single object first; prefix/multi-file later. | **S/M** | Cheapest reach for ML buckets; reuses the HTTP stack; only signing + XML are new. |
| **P3** | **WebDAV** | File GET already works; add `PROPFIND` probe (size/etag/mtime/collection), Basic/Digest auth, optional `Depth: 1` listing. | **S** | Cheapest unlock for Nextcloud/NAS/self-hosted; pure HTTP + one XML parser. |
| **P4** | **FTP / FTPS** | `ftp://`/`ftps://`, passive/EPSV, `SIZE`/`MDTM`, `REST` resume, explicit `AUTH TLS` (`PROT P` mandatory), binary only. | **M** | First real non-HTTP transport; enterprise/legacy/mirror reach; proves the transport seam SFTP later needs. No HTTP proxy support — document it. |
| **P5** | **SFTP** | Random-read over SSH, key/password auth, host-key policy, known_hosts/TOFU. | **L** | NAS/devops handoffs, but demand is unmeasured and the security work (host-key verification, key storage) is the real cost. Ship only after the credential policy. |
| **Not now** | **BitTorrent / magnet** | **Recognize and hand off/refuse**; no native client. If ever native: optional sidecar (`rqbit`, Apache-2.0), explicit opt-in, uploads off, no DHT by default. | XL in-kernel | Demand is real (distro ISOs, DSH plugins already wrap aria2/Motrix) but fit is wrong: listeners/DHT, multi-file output, piece-level resume, legal/abuse surface, +8–14 MB. |
| **Defer** | **DASH, OCI, Metalink, HTTP/3, HF Xet, IPFS, rsync, gRPC, ed2k/MMS/RTSP** | See §2.7 | — | DASH is expensive before HLS and needs audio/video muxing; HTTP/3 is not a reach gap; Xet is throughput, not access; rsync/gRPC/ed2k are the wrong job. |

**Prerequisites, in order:** Phase 0 `Source` seam (HTTP-only, no wire change) →
PROTOCOL 3 with the first new source → credential canonicalization before any
credential-bearing protocol → multi-file `outputs[]` before prefixes/folders/
torrents → a maximum binary-size gate in the five-target build.

Why HLS before the cheaper S3/WebDAV: the demand evidence puts HLS alone in
Tier 1 for protocols that are actually buildable in-kernel (BitTorrent is also
Tier 1 but is not a good in-kernel fit), and its current failure is a *silent
wrong success*, which is worse than a hard error. S3/WebDAV are cheap but
narrow: presigned S3 GET and WebDAV file GET already work today; only
discovery/auth/multi-file are missing. The cost-adjusted order below puts them
second, not first.

---

## 1. What the evidence says

### 1.1 The kernel has three failure classes today, and the worst is silent

The kernel's only scheme gate is `Spec::resolve` (`kernel/src/protocol.rs:149-153`,
`http|https` only); the host has a second gate in `assertHttpUrl`
(`src/kernel-client.ts:527-546`), and probe refuses redirects to other schemes
(`kernel/src/probe.rs:68-69`). Behind those gates, probe is an HTTP
header/status state machine (`kernel/src/probe.rs`), `ServerFacts` is HTTP
vocabulary (`kernel/src/protocol.rs:457-482`), and both transfer loops speak
`reqwest`/`Content-Range` directly (`kernel/src/engine/chunked.rs:585-692`,
`kernel/src/engine/single.rs:99-198`).

That produces three distinct failure classes:

1. **Hard rejection** — `ftp://`, `sftp://`, `magnet:`, `rsync://` are rejected at
   the scheme gate. Honest, at least.
2. **Accidental success** — presigned S3 GETs and WebDAV file GETs are plain
   HTTPS and already work; only discovery/auth/multi-file are missing.
3. **Silent wrong success** — a `.m3u8`/`.mpd`/`.torrent` URL is a small text/
   bencode file. The kernel downloads it with a `200`, ranges are irrelevant, and
   the task completes. The agent's decision loop has **no negative fact to branch
   on**. A grep of `kernel/src` finds no `m3u8`, `mpegurl`, `dash`, `mpd`,
   `torrent`, `bencode` or `magnet` handling.

Class 3 is the reason P0 recognition precedes any protocol work: it converts a
plausible success into a typed, actionable value at almost no cost.

### 1.2 Demand: HLS is the one Tier-1 protocol that is a clean in-kernel fit

| Candidate | Demand tier | Evidence highlights |
|---|---|---|
| **HLS / DASH** | **1 — must-have soon** | HLS 61 % / DASH 46 % of distribution formats (Bitmovin 9th Video Developer Report 2025/26, industry survey — *not* traffic share); JDownloader's KB says "a lot of websites nowadays are using HLS"; Gopeed added native HLS in Sep 2026; yt-dlp has 206 k stars and exists mostly to turn pages into manifests; DSH already ships a separate video-downloader plugin. Today an HTTP downloader saves the manifest as the payload. |
| **BitTorrent / magnet** | **1 — must-have soon** (demand), poor fit | Ubuntu/Debian/Mint officially ship torrents; ≥ 2 DSH plugins already hand URL/magnet/`.torrent` to a local aria2/Motrix. `magnet:` is hard-rejected; `.torrent` URLs are silently saved as metadata. But a native client is XL (peer wire, DHT/trackers, piece verification, seeding policy, multi-file, legal exposure). |
| **S3 / object stores** | 2 — valuable niche | Presigned GET already works; gap is SigV4 signing + `ListObjectsV2` (discovery) and multi-file results. ML datasets/checkpoints live here. |
| **FTP / FTPS** | 2 — valuable niche | Enterprise drops, manufacturing/suppliers, some distro mirrors. Chrome removed FTP in 88, but that is *human browsing*; machine-to-machine drops persist. Small protocol. |
| **WebDAV** | 2 — valuable niche (cheap) | Nextcloud/ownCloud/self-hosted. File GET already works; only `PROPFIND`/Digest/multi-file missing. |
| **SFTP / SCP** | 2 — unmeasured | NAS/devops; curl/aria2/rclone support it, but no public usage data. Credential/approval-shaped (host keys). |
| **OCI registry** | 2 — watch | Ollama/KServe model images; `oras pull`; digest-verified layers. Growing, not yet a download-manager expectation. |
| **HF Xet** | 2 — perf, not reach | HF's default CAS backend, but plain HTTP is the documented fallback and "does properly resume, just slower per connection". Not an access gap. |
| **HTTP/3** | 3 — low | 41.1 % of sites offer it, but same HTTP semantics; no reach gap; no download manager markets it as compatibility. |
| **Metalink, rsync, IPFS, ed2k, MMS/RTSP, gRPC, China netdisk APIs** | 3 — low / out of scope | Mirror plumbing (not file requests), gateway-HTTP workaround, legacy P2P, or provider APIs rather than protocols. |

Two local facts sharpen this: the product's live session measured the same
object at **0.13 MiB/s on HF vs 106 MiB/s on ModelScope**, and a DSH plugin
author self-reports ≈ 90× between aria2 and a single-connection Node download
([demand note §4](protocol-extension/demand-evidence.md)). The biggest measured
lever is still **HTTP source selection**, not a Tier-2 protocol; that is a
separate roadmap item (currently a documented non-goal) and should not be
displaced by FTP/S3 work if the goal is perceived speed.

### 1.3 Cost: the cheap protocols are HTTP-adjacent; the demanding one is media

| Candidate | Engine fit | Direct deps / engine | Effort | Est. binary delta | Main risk |
|---|---|---|---|---|---|
| HLS | **segment/virtual-stream engine** (single-stream body + playlist/segment logic) | `m3u8-rs` 6.0.1 (MIT), `aes`+`cbc` for AES-128; segment fetch reuses `reqwest` | **L** per repo-seams (2–3 weeks incl. resume; **M** for a narrower sequential/no-resume v1 per rust-landscape) | +0.1–0.5 MB | Optional tags, per-CDN quirks, init map, TS vs fMP4 naming, resume model |
| S3-compatible | **existing HTTP engine** + signing | hand-rolled SigV4 (~150 lines; `hmac` small) + `quick-xml` (MIT) | **S** single object / **M** listing | +0.2–0.3 MB | Region redirects, encodings, MinIO/R2 deviations, ETag ≠ hash for multipart |
| WebDAV | **existing HTTP engine** | `quick-xml` only | **S** | +0.2–0.3 MB | Digest auth, 207 namespaces, self-signed NAS certs |
| FTP / FTPS | **byte-range engine behind a new transport** | `suppaftp` 12.2.1 (MIT/Apache, tokio + rustls, `REST`, `retr_as_stream`) | **M** | +0.5–1.0 MB | No HTTP proxy; passive ports/firewalls; FTPS `PROT P`; server conn limits |
| SFTP | **byte-range engine behind SSH** | `russh` 0.65.1 + `russh-sftp` 3.0.1 (Apache-2.0, pure Rust) | **L** | +2.5–4 MB | Host-key verification not provided; pre-release crypto pins; hermetic test server is hard |
| BitTorrent | **new engine + multi-file** | `librqbit` 9.1.0 (Apache-2.0) or sidecar | **XL** | +8–14 MB | Listeners/DHT/UPnP, legal/abuse, piece model, multi-file |
| DASH | HLS engine + MPD | hand-rolled MPD (`quick-xml`); **reject `dash-mpd`** (non-optional ffprobe + `reqwest` 0.13) | **XL** before HLS, **M** after | +0.2–0.6 MB | Separate A/V streams need muxing; DRM impossible without CDM |
| HTTP/3 | transport swap under HTTP engine | `reqwest` experimental http3 + `RUSTFLAGS` cfg, or `quinn`/`h3` 0.0.x | **M** | +0.5–1.5 MB | UDP/proxy/sandbox issues; no reach gain |
| Metalink | orchestration over existing engines | `quick-xml` | **S** | +0.2–0.3 MB | Value demand-gated on ISO/mirror workflows |
| OCI | HTTP engine + token/manifest/blob logic | hand-rolled registry-v2; avoid `oci-client` (reqwest 0.13/sha2 0.11) | **M** | +0.2 MB hand-rolled | Watch item; auth flow + media types |
| HF Xet | new CAS engine | `hf-xet` 1.8.0 (Apache-2.0) | **L** after spike | +2–5 MB (low confidence) | Perf only; measure against segmented HTTP first |
| rsync, IPFS-native, gRPC, SCP | — | no honest maintained Rust implementation / no generic contract / legacy | — | — | Reject for this kernel |

Binary baseline: the five shipped kernels are 4.03–4.86 MiB today
(`bin/<target>/rdm-kernel[.exe]`), built natively on five runners, and
`scripts/verify-kernels.mjs` enforces only a **minimum** size — there is no
maximum. A practical per-wave budget is **≤ +2 MB per binary**; add a maximum
size gate before the first new dependency lands.

### 1.4 Decision rule used here

Priority = **severity of the failure class × addressable share ÷ cost**, with
prerequisites enforced. Consequences:

* P0 recognition is nearly free and removes the worst failure class; it goes
  first regardless of protocol order.
* HLS wins the protocol ranking on demand × severity even though it costs more
  than S3/WebDAV. Its addressable share is bounded (direct manifests only), but
  no other buildable protocol has comparable demand.
* S3/WebDAV win on cost but are narrow because their transfer path already
  works; they belong immediately after HLS, not before it.
* FTP is the cheapest *true* second transport and validates the seam SFTP
  needs; it is ranked after the HTTP-adjacent pair because it costs more and
  its demand is narrower.
* SFTP is gated on credential/host-key policy, which is product/security work,
  not protocol work.
* BitTorrent is a routing/handoff problem first; native support is rejected for
  this wave on fit and risk, not on demand.

---

## 2. Priority detail

### 2.0 P0 — recognition and honest refusal (do this week)

**What:** after probe (or on the first bytes), classify a source as one of
`file | hls | dash | torrent | magnet`:

* `.m3u8` / `application/vnd.apple.mpegurl` / `#EXTM3U` body → HLS;
* `.mpd` / `application/dash+xml` / `<MPD` body → DASH;
* `.torrent` / `application/x-bittorrent` / bencode `d…` body → torrent;
* `magnet:` → torrent (scheme gate, before any request).

**Behaviour:** `rdm_probe` reports the classification as a fact
(`mediaType`/`protocol` plus a stable warning), and `rdm_download` refuses
unsupported types with `unsupported` and a `next` hint (`magnet/torrent: use a
local BitTorrent client or a dedicated DSH plugin; DASH: not supported — see
next`). Never return `completed` with a 2 KB manifest.

**Why first:** it is the only change that fixes the *silent* class for all three
media/metadata types at once, and it is useful even if HLS slips. It also gives
the HLS work a place to hang its `protocol` discriminator.

**Wire:** additive optional fields are enough for P0; no protocol bump required
if shipped alone.

### 2.1 P1 — HLS VOD (first real protocol)

**Scope for v1:**

* direct `.m3u8` URLs only (master or media playlist); no page/site extraction,
  no YouTube/Bilibili extractors, no cookies-capture UI;
* VOD only (`EXT-X-ENDLIST` present); live playlists are refused with a typed
  reason;
* TS and fMP4/CMAF: concatenate media segments in order; for fMP4 prepend
  `EXT-X-MAP` init segment. TS output is named `.ts` (honest); fMP4 output may be
  `.mp4`. Do not claim MP4 for TS without a remux (ffmpeg is not in the kernel);
* `EXT-X-KEY:METHOD=AES-128` supported (fetch key URI, AES-CBC decrypt);
  `SAMPLE-AES` and DRM (Widevine/PlayReady/FairPlay) refused explicitly;
* variant selection: default highest `BANDWIDTH` with a configurable cap /
  explicit choice; record the chosen variant in facts;
* one output file, so the existing single-output task model is unchanged.

**Engine shape:** a new `HlsSource` whose `open_stream` yields the concatenated
bytes (segments fetched over the existing `reqwest` client, so headers, cookies,
`Referer`, UA, proxy, TLS/insecure and rate limiting keep working). Reuse the
single-stream loop, reporter, token bucket, pause/cancel and finalize. Keep a
segment-index sidecar so a resume can skip completed segments (v1 can restart at
a segment boundary; byte-level `.part.json` random access is not required). A
later optimisation can fetch N segments concurrently with a bounded reorder
buffer; v1 correctness first.

**Facts:** `protocol: "hls"`, variant list (bandwidth/resolution/codecs),
selected variant, duration, segment count, encryption method, VOD/live, init map
present, total bytes unknown-or-estimated (never faked). `status` must become
nullable/`reply`-shaped because an HLS transfer has per-segment statuses, not one
HTTP status.

**Non-goals:** live, DRM, site extraction, separate audio renditions without a
muxed variant, multi-file outputs.

**Why not DASH in the same wave:** DASH is mostly separate audio/video
representations; producing a usable file needs muxing (ffmpeg) or a product
decision to deliver separate files. The HLS engine is the prerequisite; DASH is
a later increment (and Bilibili-style DASH is a site-extraction problem, not a
protocol one).

### 2.2 P2 — S3-compatible object stores

**Scope:** `s3://bucket/key` plus the existing HTTPS presigned path. SigV4
header/query signing (`hmac` + existing `sha2`), region redirect
(`PermanentRedirect`), `ListObjectsV2` with `ContinuationToken` (quick-xml),
virtual-host and path-style endpoints, MinIO/R2 coverage. Download one object
first; prefix → `outputs[]` is a follow-up that depends on the multi-file model.

**Security:** credentials are access key/secret/session token — they must come
from env/profile/key-file references, never be projected into receipts, and
never be written to `tasks/*.json` in plaintext. ETag is not a checksum for
multipart objects; do not claim verification from it.

**Why after HLS:** demand is real in ML workflows but narrower; the transfer
path already works for presigned URLs, so the marginal reach is discovery/auth.

### 2.3 P3 — WebDAV

**Scope:** HTTPS file URLs already work; add `PROPFIND` (Depth 0/1) for
size/etag/mtime/collection, Basic and Digest auth, and report the collection /
auth facts. Folder → multi-file is a follow-up behind the same `outputs[]` gate.
Refuse Basic auth over plaintext HTTP with a warning; self-signed NAS certs use
the existing `insecure` flag.

### 2.4 P4 — FTP / FTPS

**Scope:** `ftp://` and explicit `ftps://` (`AUTH TLS`; `PROT P` mandatory —
never silently downgrade to `PROT C`), passive/EPSV first, `SIZE`/`MDTM`,
`REST`-based resume (weak safety — honest `resume=weak`, no fake `If-Range`),
binary `TYPE I` only, UTF-8 paths. Multiple sessions for segmented transfer,
with a graceful fallback to one stream when the server limits connections.
No HTTP proxy support: state it in the receipt/diagnosis rather than failing
obscurely.

**Why here:** it is the first non-HTTP transport; it proves `open_range` for
real and is the template for SFTP. The demand is enterprise/legacy and some
mirrors, not mass consumer.

### 2.5 P5 — SFTP (after policy)

**Scope:** random-read over SSH (`russh` + `russh-sftp`), password and key-file
auth (key *paths*, not key material), known_hosts/TOFU verification with a
visible warning, no passphrase persistence, no ssh-agent dependency in v1.
Build with `ring`, not the default C crypto backend; avoid the pre-release
crypto pins if they are still pinned at integration time (re-check).

**Gate:** do not ship before (a) userinfo/redaction is scheme-agnostic and
credentials are references, (b) a host-key approval/TOFU policy exists. The
hermetic test server is the largest test cost in the whole programme.

### 2.6 BitTorrent — recognition and handoff now, native later (if ever)

**Now:** classify `.torrent`/`magnet:` (P0) and return `unsupported` with a
next step. Do not download the metadata and call it complete.

**If native is demanded later:** do it as an **optional sidecar** (`rqbit`,
Apache-2.0) with explicit per-task opt-in, uploads disabled, DHT/LSD off by
default, and never auto-resume on kernel start. In-process is rejected for this
wave: listeners in a resident process, +8–14 MB, multi-file task model, piece
resume, and legal/abuse exposure.

### 2.7 Explicitly deferred / rejected

| Item | Decision | Why |
|---|---|---|
| **DASH** | Defer until HLS ships | Mostly separate A/V; muxing (ffmpeg) or separate-file product decision; DRM impossible. Not a first protocol. |
| **OCI registry** | Watch | Model distribution is moving there (Ollama/KServe), but the CLI (`oras`) covers it today and auth/token flow is extra work. Revisit when a DSH workflow needs `oci://`. |
| **Metalink** | Opportunistic | Cheap (`quick-xml`) and aligns with checksums, but demand is distro-mirror plumbing; add it when FTP/mirrors exist, not before. |
| **HTTP/3** | Defer | Same reach as h1/h2; experimental `reqwest` cfg; no proxy; UDP/sandbox risk; marginal bulk-download gain. |
| **HF Xet** | Perf spike, not protocol | Plain HTTP is the documented fallback; if a spike shows Xet materially beats the segmented HTTP path on model repos, integrate the crate — otherwise do not pay for a CAS engine. |
| **IPFS** | Gateway only | A gateway URL is plain HTTP and already works; native libp2p/bitswap is a different product. |
| **SMB / NFS** | Not assessed / defer | NAS-native alternatives to WebDAV/SFTP, but no mature pure-Rust client at the required quality; WebDAV and SFTP cover the same NAS use case with less risk. |
| **rsync / gRPC / ed2k / MMS / RTSP / SCP** | Reject | No honest Rust wire implementation (rsync), no generic file contract (gRPC), legacy/live capture (ed2k/MMS/RTSP), SCP folded into SFTP. |
| **China netdisk APIs** | Out of scope | Provider APIs behind cookies/tokens (115/Quark/Baidu), not protocols; the underlying magnet/ed2k demand is handled by handoff. |

---

## 3. Prerequisites and architecture

### 3.1 Phase 0 — the `Source` seam (HTTP-only)

The transfer machinery is already ~80 % transport-neutral: `scheduler.rs`,
`plan.rs`, `rate.rs`, `telemetry.rs`, `controller.rs`, `history.rs`,
`engine/mod.rs::finalize` and `.part`/`.part.json` never touch HTTP. The
coupling is confined to: `chunked.rs` (seven HTTP sites: `reqwest::Client` in
`Shared`, `Range`/`If-Range` request, `206`/`Content-Range` validation,
`200`-downgrade, `416`, `429/503` + `Retry-After`, body streaming) and
`single.rs` (one request + status/length + body loop).

Phase 0 introduces:

```rust
pub trait Source: Send + Sync {
    fn scheme(&self) -> Scheme;
    fn probe(&self, spec: &Spec, origin: Option<OriginFacts>) -> BoxFut<'_, EngineResult<ProbeOutcome>>;
    fn open_range(&self, req: RangeRequest<'_>) -> BoxFut<'_, EngineResult<RangeReply>>;
    fn open_stream(&self) -> BoxFut<'_, EngineResult<RangeReply>>;
    fn resource_identity(&self, meta: &Meta) -> String; // default: url_identity
    fn rebuild(&self) -> EngineResult<()> { Ok(()) }
}
```

with `RangeReply::{Partial, Full, Unsatisfiable, Retry}` and a `BodyStream`
that is either a `reqwest::Response` (HTTP) or `tokio::io::AsyncRead` (FTP/SFTP/
file). The provider proves the range; the engine keeps the same invariant by
comparing `Partial.start/end/total` to the claim. This preserves every existing
guarantee (byte correctness, finalize, resume safety, telemetry, bounded
memory, stdout-only protocol) **without a wire change while HTTP is the only
implementation**. It is an M-sized refactor, not a redesign: scheduler/plan/
state/finalize are untouched.

### 3.2 PROTOCOL 3

`ServerFacts` currently requires `status: u16` and `httpVersion`, and its
`range`/`probedBy`/`acceptRanges`/`fileNameSource`/`signedUrl`/`tls` fields are
HTTP vocabulary. New sources need:

* a `protocol` discriminator (`http|hls|s3|webdav|ftp|sftp|…`, default `http`
  for old records);
* nullable/`reply`-shaped status (HLS/FTP/SFTP do not have one HTTP status);
* a tagged union of protocol facts (playlist variants/duration/segments/
  encryption; FTP reply/size/mdtm/rest/tls; S3 bucket/key/region/etag/checksum;
  WebDAV collection/auth);
* new stable warning/error codes (`playlist-encrypted`, `live-unsupported`,
  `plaintext-ftp`, `unknown-host-key`, `auth-failed`, …);
* capability advertisement in the ready frame/`initialize`/`stats`
  (`protocols: [...]`) so the host and tool descriptions can be capability-driven;
* host/tool schema, receipt renderers, locale labels and the closed output
  schema (`objectNode(..., false)`) updated in lockstep.

Bump `PROTOCOL` 2 → **3** with the first new source family (HLS is the natural
trigger). The plugin and kernel ship together; the cost is mechanical test
churn, and it is the honest option because `status`/enum/outputs semantics
change.

### 3.3 Credential canonicalization (before any credentialed protocol)

Three code-level gaps must close before any credentialed protocol:

1. `redact_url` splits on `?` only and never touches URL **userinfo**
   (`kernel/src/protocol.rs:810-839`), so `ftp://user:pass@host/…` would be
   projected verbatim into `ServerFacts.url`, task views and the review UI.
2. `redact_text` returns early unless the text contains `"http"`
   (`kernel/src/protocol.rs:864-867`), so a transport error echoing
   `ftp://user:pass@…` or `ssh://…` is not scrubbed before it becomes an event
   and a `history/*.events.jsonl` line.
3. `TaskRecord` persists the whole `Spec`, including `headers`/`cookie`
   (`kernel/src/protocol.rs` `Spec` serialization), so a new `Authorization` or
   S3 credential would land in `<data-dir>/tasks/*.json` in plaintext.

Also keep `insecure` honest: it currently means "accept invalid TLS certificates"
for HTTPS (`kernel/src/http.rs`). It must **not** be reinterpreted as "skip SSH
host-key verification" for SFTP or "downgrade FTPS to plaintext" — those need a
distinct field and a visible warning.

Recommended fixes: scrub userinfo; make `redact_text` scheme-agnostic (scan
`://` tokens); keep `AuthSpec` out of every projection and out of
serialization; prefer secret *references* (env var / key-file path) over
material; add a redaction test matrix per scheme. This is a small,
independently testable change that de-risks every later protocol.

### 3.4 Multi-file outputs (only when prefixes/folders/BT land)

The current model is one task → one file in four places: `TaskView.path/
fileName/dir`, `TaskDetail.target`, `finalize`'s single rename, and
`remove/deletePart`. S3 prefixes, WebDAV folders and BitTorrent need an additive
`outputs[]` (`path`, `bytes`, `sha256`, `role`, `verified`) plus optional
`progress {filesDone, filesTotal}`, with `path` retained as the primary file for
back-compat. HLS/FTP/SFTP single-file sources do **not** need this, which is why
scoping P2/P3 to single objects first is worth it.

### 3.5 Build, tests, binary size

* Five native prebuilt targets, no cross-compilation; any new crate must build
  on ubuntu-24.04 x64/arm64, Windows, macOS x64/arm64. Avoid system libraries
  (OPENSSL/libssh2); prefer pure Rust + `ring`.
* The release asserts exactly five kernels; use compile-time features on one
  binary, never extra artifacts.
* Add a **maximum** binary-size gate (e.g. fail above the agreed budget per
  target) next to the existing minimum; log the release sizes from
  `build-kernel.mjs`.
* Fixtures: HTTP fixture extends to `/playlist.m3u8`, `/seg-N.ts`, optional AES
  key; a std-only FTP control/data server (~200–300 lines) for FTP; signing
  vectors for S3; `PROPFIND` routes for WebDAV. SFTP needs a real in-process SSH
  server or non-hermetic CI — the weakest test story.

---

## 4. Release plan (proposed)

| Version | Content | Exit criteria |
|---|---|---|
| **0.2.3** | P0 recognition/refusal (`.m3u8`/`.mpd`/`.torrent`/`magnet:`), scheme errors with next-step hints. No new protocol. | A fixture serving a manifest/torrent never reports `completed`; receipts name the classification and next step; existing tests stay green. |
| **0.3.0** | Phase 0 `Source` seam + **PROTOCOL 3** + **HLS VOD** (TS/fMP4/AES-128, direct manifests, VOD only). | Fixture downloads produce a playable file; variant/duration/segment/encryption facts correct; pause/resume at segment boundary; live/DRM refused with typed reasons; binary size gate; all five targets build; e2e + receipt contract green. |
| **0.4.0** | Credential canonicalization + **S3-compatible** (single object; optional listing) + **WebDAV** (PROPFIND/auth). | SigV4 vectors + MinIO/R2 smoke; PROPFIND fixture; no credential appears in any projection/history/task record; Basic-over-HTTP warned. |
| **0.5.0** | **FTP/FTPS** (REST resume, passive/EPSV, explicit TLS, no-proxy diagnosis). | Std-only FTP fixture; resume matrix; FTPS `PROT P`; weak-resume honesty; `ftp://user:pass@…` redacted everywhere. |
| **0.6.0** | **SFTP** (after host-key/credential policy) and optionally **DASH** (single-representation, muxed; no DRM). | Host-key TOFU test; key-path auth; DASH fixture only if the segment engine can produce a usable output. |
| Any time | BitTorrent **handoff/refusal** (already P0); native sidecar only if demand becomes blocking. | `.torrent`/`magnet:` always produce an honest, actionable value. |

Do not put two new transfer paths in one release: HLS (0.3.0) and FTP (0.5.0) are
the two riskiest steps and should be separated by the HTTP-adjacent work.

---

## 5. What would change this decision

* **Audience is enterprise/NAS, not general agents** → swap P1 and P4/P3: FTP/
  FTPS and WebDAV/S3 before HLS. The ranking is stable only if "download web
  media" is a real user job.
* **Site extraction is required** (YouTube/Bilibili, cookies, signatures,
  separate A/V) → that is a yt-dlp-handoff/extractor product, not an HLS
  protocol feature. Decide it separately; do not grow the kernel into a site
  extractor.
* **BitTorrent becomes blocking** → implement handoff/sidecar, not a native
  client; do not put a listener in the resident kernel.
* **HF Xet proves materially faster than segmented HTTP** on model repos → run
  the 2–3 day spike and consider it a throughput feature, not a protocol.
* **Source selection is the real complaint** (0.13 vs 106 MiB/s) → mirror/
  multi-source scheduling is a competing priority that may be worth more than
  any Tier-2 protocol; keep it a separate track and do not silently substitute
  protocol breadth for speed. Options and sequencing:
  [multi-source-scheduling.md](multi-source-scheduling.md).

---

## 6. Open questions

1. **HLS resume model**: segment-index sidecar vs byte-offset virtual map;
   v1 may restart at a segment boundary. Parallel segment fetch (bounded reorder
   buffer) is a follow-up, not a correctness requirement.
2. **HLS output naming**: `.ts` for TS playlists (honest) vs a remux promise;
   recommend `.ts` and document that fMP4 yields `.mp4`.
3. **Variant selection default**: highest bandwidth vs a cap; needs a config
   key and a receipt line.
4. **S3 scope**: single object + signing only, or listing/multi-file in the
   same release? Listing is the real ML value but triggers `outputs[]`.
5. **Credentials**: per-call secrets vs env/key-file references; the latter is
   strongly preferred because `TaskRecord` persists the `Spec`.
6. **Protocol 3 timing**: with HLS (recommended) or as an additive protocol-2
   HLS with a fake `status` (not recommended — dishonest).
7. **SFTP host-key UX**: TOFU under the data dir vs explicit approval; this is
   an approval-shaped product decision.
8. **BitTorrent handoff**: refuse with a hint vs detect a local engine and
   delegate; the latter adds an external dependency and is not proposed here.

---

## 7. Sources

Local evidence:

* [repo-seams.md](protocol-extension/repo-seams.md) — HTTP coupling map,
  `Source` seam, PROTOCOL 3 changes, test/build/size impact, effort table.
* [demand-evidence.md](protocol-extension/demand-evidence.md) — competitor
  matrix, per-protocol failure modes, agent-workflow table, adoption data,
  tiers, ~90 links.
* [rust-landscape.md](protocol-extension/rust-landscape.md) — crate/version/
  license/weights, engine fit, security/compliance, feasibility order.
* Kernel code: `kernel/src/protocol.rs` (scheme gate, redaction),
  `kernel/src/probe.rs` (HTTP probe), `kernel/src/facts.rs`,
  `kernel/src/engine/{mod,chunked,single}.rs`, `kernel/src/state.rs`,
  `kernel/src/task.rs`, `src/kernel-client.ts`, `src/tools.ts`.
* Product contract: [PROTOCOL.md](../../PROTOCOL.md),
  [ARCHITECTURE.md](../ARCHITECTURE.md), [OPTIMIZATION.md](../OPTIMIZATION.md),
  [README.md](../../README.md).

External (selection; full links in the demand note):

* Bitmovin 9th Video Developer Report 2025/2026 — HLS 61 % / DASH 46 %
  distribution-format survey (not traffic share):
  <https://bitmovin.com/downloads/bitmovin-9th-video-developer-report-2025-2026.pdf>
* JDownloader HLS knowledge base — "a lot of websites nowadays are using HLS";
  resume/multi-chunk not possible:
  <https://support.jdownloader.org/de/knowledgebase/article/hls-streaming-downloads-and-related-problems>
* Gopeed native HLS release (Sep 2026):
  <https://newreleases.io/project/github/GopeedLab/gopeed/release/v2.0.0-beta.3>
* yt-dlp — 206 k stars, ffmpeg required to merge separate A/V:
  <https://github.com/yt-dlp/yt-dlp>
* Ubuntu / Debian / Mint torrent distribution:
  <https://ubuntu.com/download/alternative-downloads>,
  <https://www.debian.org/CD/torrent-cd/>,
  <https://www.linuxmint.com/edition.php?id=319>
* AWS presigned URLs (presigned GET is just HTTPS):
  <https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html>;
  ListObjectsV2:
  <https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html>
* Nextcloud WebDAV:
  <https://docs.nextcloud.com/server/latest/user_manual/en/files/access_webdav.html>
* Chrome 88 FTP removal (human browsing, not machine drops):
  <https://developer.chrome.com/blog/chrome-88-deps-rems>
* W3Techs HTTP/3 adoption (41.1 % of sites):
  <https://w3techs.com/technologies/details/ce-http3>
* HF Xet storage / HTTP fallback:
  <https://huggingface.co/docs/hub/main/xet/using-xet-storage>
* aria2 protocol set, rclone backend matrix:
  <https://github.com/aria2/aria2>, <https://rclone.org/overview/>

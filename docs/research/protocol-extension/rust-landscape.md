# Rust implementation landscape: what each candidate protocol costs in the rdm kernel

Research note for the protocol-extension decision. Answers one question: **if
dsh-rdm added protocol X, what would it take in Rust, in bytes, in build risk,
and in compliance surface?** It is deliberately feasibility-only; demand and
product priority live in `demand-evidence.md`, and the code seams live in
`repo-seams.md`.

- **Facts checked 2026-11-09** against crates.io's API (crate + version +
  dependency endpoints), docs.rs, the supplied GitHub repository/API pages, and
  the upstream repositories linked under §6. Every version, date and license in
  §1–§2 was read from that metadata on that date.
- **No cargo build was run and no dependency was added** (task constraint). All
  binary-size deltas are therefore *estimates* derived from dependency
  manifests and current binary sizes; they are labelled **est.** and carry a
  range. Do not quote them as measurements.
- The kernel under discussion is `rdm-kernel` 0.2.2
  ([kernel/Cargo.toml](../../../kernel/Cargo.toml)): `tokio`, `reqwest` 0.12.28
  (`rustls-tls`, `http2`, `stream`, no default features), `serde`/`serde_json`,
  `sha2` 0.10, `hex`, `url`, `httpdate`, `percent-encoding`. 152 packages in
  `kernel/Cargo.lock`, no C toolchain dependency (rustls + `ring` 0.17.14).

---

## 0. Baseline that makes the estimates meaningful

| baseline fact | value | source |
|---|---|---|
| prebuilt kernels shipped per release | `linux-x64`, `linux-arm64`, `win32-x64`, `darwin-x64`, `darwin-arm64` | [ARCHITECTURE.md:332](../../ARCHITECTURE.md), [prebuilt-kernels.yml:55-66](../../../.github/workflows/prebuilt-kernels.yml) |
| current binary size (measured in tree) | darwin-arm64 4.03 MB · linux-arm64 4.20 MB · darwin-x64 4.28 MB · linux-x64 4.63 MB · win32-x64 4.86 MB | `bin/<target>/rdm-kernel[.exe]` |
| historical size reference | 4.60 MB | [OPTIMIZATION.md:239](../../OPTIMIZATION.md) |
| Rust toolchain | CI uses `dtolnay/rust-toolchain@stable` (no pin); local rustc 1.99.1, edition 2021 | [prebuilt-kernels.yml:79](../../../.github/workflows/prebuilt-kernels.yml) |
| release profile | `opt-level=3`, `lto="thin"`, `codegen-units=1`, `strip=true` | [Cargo.toml:30-34](../../../kernel/Cargo.toml) |
| transports today | HTTP/1.1 + HTTP/2 only; scheme allow-list rejects everything else | [protocol.rs:152](../../../kernel/src/protocol.rs), [http.rs:24-59](../../../kernel/src/http.rs) |
| segmented engine | byte-range `GET` per claim, `If-Range`, `.part` + `.part.json` resume, SHA-256 finalize | [engine/mod.rs:227-229](../../../kernel/src/engine/mod.rs), [engine/chunked.rs:585-640](../../../kernel/src/engine/chunked.rs) |
| single-stream fallback | one stream when ranges are absent/ignored | [engine/single.rs](../../../kernel/src/engine/single.rs) |
| proxy support | HTTP(S) proxy only (`reqwest::Proxy`); no SOCKS, no CONNECT tunnel for other protocols | [http.rs:51-53](../../../kernel/src/http.rs) |
| process posture | resident process, no listening sockets, NDJSON on stdio | [ARCHITECTURE.md:28-42](../../ARCHITECTURE.md) |

Two consequences drive everything below:

1. **Anything that speaks HTTP inherits a large amount of kernel machinery for
   free** — retries/backoff/`Retry-After`, proxy, cookies/headers/UA, TLS leaf
   facts, `insecure`, rate limiting, telemetry/controller, resume, checksum,
   `.part`/rename, task records. That is the cheap lane (S3, WebDAV, OCI,
   Metalink, gateway IPFS, HLS/DASH segments).
2. **Anything that does not speak HTTP needs a transport abstraction and a
   second engine**, because `reqwest::Client` is threaded through probe,
   chunked, single, controller pool rebuild and resume identity
   (`engine/chunked.rs` `Shared.client: Mutex<Client>`). That is the expensive
   lane (FTP, SFTP, BitTorrent, Xet).

The binary budget implied by the brief ("under 20 MB ideally") is generous for
one binary but not for five: today the release carries ~22 MB of kernels, and
+10 MB each would make it ~72 MB. A practical planning ceiling for a *single
wave* of additions is **≤ +2 MB per binary (≈ ≤ +10 MB across the matrix)**,
which is the filter applied in §4.

---

## 1. Comparison matrix

Crate/engine facts are from crates.io metadata fetched **2026-11-09**; weight is
**est.** (see §0). "Engine fit" says what the protocol needs inside the kernel:
*HTTP engine* = reuse probe/chunked/single as-is; *segment engine* = new
playlist-driven downloader that reuses task/telemetry/rate/verify but not
`chunked.rs`; *transport* = new byte-range source behind a trait replacing
`reqwest::Client`; *new engine* = protocol owns scheduling; *sidecar* = external
binary.

| # | candidate | crate / engine (checked 2026-11-09) | license | last release | tokio fit | dep / binary weight | platform & build risk | engine fit | effort | verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **S3-compatible objects** | hand-rolled SigV4 + ListObjectsV2 on `reqwest` (alt: `object_store` 0.14.2, `aws-sdk-s3` 1.157.0) | own code; `object_store` MIT/Apache-2.0; `aws-sdk-s3` Apache-2.0 | 2026-09-15 / 2026-10-30 | native | presigned+GET: **0**; +listing (`quick-xml` 0.42.0, MIT, 2026-08-22): **+0.2–0.3 MB est.**; `object_store`: +2–3 MB est.; `aws-sdk-s3`: +12–20 MB est. | none (pure Rust) | HTTP engine | **S** | **implement now** |
| 2 | **WebDAV** | no crate needed: `PROPFIND`/`GET` on `reqwest`; `webdav` 0.1.0 is types-only | own code; crate MIT (not re-verified) | 2025-10-15 | native | `quick-xml` **+0.2–0.3 MB est.** | none | HTTP engine | **S** | **implement now** |
| 3 | **HLS** | `m3u8-rs` 6.0.1 (parser; alt `hls_m3u8` 0.4.2 unmaintained) | MIT | 2026-07-30 | sync parser, transport via existing `reqwest` | `nom` 7 + `chrono`; **+0.2–0.4 MB est.** (+AES ~+0.1 MB if encrypted segments) | none (pure Rust) | **segment engine** (new) | **M** | **implement now** |
| 4 | **FTP / FTPS** | `suppaftp` 12.2.1 (`tokio` + `tokio-rustls-ring`) | MIT OR Apache-2.0 | 2026-10-15 | native (`tokio` backend; `REST`, `EPSV`, `retr_as_stream`) | `chrono`, `lazy-regex`→`regex`, `thiserror`; **+0.5–1.0 MB est.** | pure Rust; edition 2024 / rustc 1.88; avoid `native-tls` feature | **transport** (new) | **M** | **implement now** (after S3/WebDAV) |
| 5 | **MPEG-DASH** | `dash-mpd` 0.21.0 (download path needs external ffmpeg/ffprobe) or hand-rolled MPD parse | MIT | 2026-10-04 | partial (own `reqwest` 0.13) | crate: ~40 normal deps incl. `ffprobe`, `mp4-atom`, `pssh-box`, `regex`, `reqwest` 0.13; **+2–4 MB est.** + ffmpeg binary | `native-tls` default (OpenSSL on Linux); external ffmpeg/ffprobe; DRM streams undecryptable | **segment engine** (share with HLS) | **M** | **defer**; do not adopt the crate |
| 6 | **OCI registry** | `oci-client` 0.18.0, or hand-rolled registry-v2 on `reqwest` | Apache-2.0 | 2026-09-18 | native | crate: `reqwest` 0.13, `sha2` 0.11, `oci-spec`, `regex`, `chrono`; **+1.5–2.5 MB est.**; hand-rolled: ~+0.2 MB | none; but duplicate HTTP/crypto majors | HTTP engine (hand-rolled) | **M** | **defer** (demand-gated) |
| 7 | **Metalink** | `quick-xml` 0.42.0 parser + mirror failover over existing engines | MIT | 2026-08-22 | n/a (parse only) | **+0.2–0.3 MB est.** | none | orchestration over HTTP/FTP | **S** | **defer** (demand-gated; cheap when demand appears) |
| 8 | **HTTP/3** | `quinn` 0.11.12 + `h3` 0.0.8, or `reqwest` `http3` (experimental, needs `--cfg reqwest_unstable`) | MIT OR Apache-2.0 / MIT | 2026-09-14 / 2025-05-06 | native (`runtime-tokio`, `rustls-ring` default) | **+0.8–1.5 MB est.**; `quinn` is already in `Cargo.lock` as an optional reqwest dep | RUSTFLAGS cfg on all 5 targets; UDP egress; **no proxy**; `h3` still 0.0.x | transport swap under HTTP engine | **M** | **defer** |
| 9 | **SFTP / SCP** | `russh` 0.65.1 + `russh-sftp` 3.0.1 | Apache-2.0 / Apache-2.0 | 2026-11-03 / 2026-09-28 | native (`tokio`) | ~60 crypto crates (aes/cbc/ctr, curve25519-dalek 5, ed25519-dalek 3, p256/384/521, ml-kem, sha1/sha2/sha3, rsa, ssh-key); **+2.5–4 MB est.** | default `aws-lc-rs` (C + CMake/NASM on Windows) — must switch to `ring`; **pinned pre-release crypto** (`ssh-key =0.7.0-rc.11`, `rsa =0.10.0-rc.18`, `pkcs1 =0.8.0-rc.4`); rustc 1.89; `pageant` on Windows | **transport** (random reads) | **L** | **defer** |
| 10 | **BitTorrent v1/v2 + magnet** | `librqbit` 9.1.0 (only maintained embeddable client; `cratetorrent` last push 2022-03) | Apache-2.0 | 2026-10-29 | yes, but owns its runtime shape | ~60 normal deps: `axum-extra`, `dashmap`, `governor`, `bitvec`, `memmap2`, `nix`, `windows`, `reqwest` 0.13, `tokio-socks`, DHT/LSD/UPnP/μTP crates; **+8–14 MB est.** | binds TCP/UDP listeners, UPnP port mapping, DHT; `native-tls` default | **new engine** or sidecar; multi-file output | **XL** | **sidecar or defer** |
| 11 | **HF Xet** | `hf-xet` 1.8.0 (+ `xet-client`/`xet-data`/`xet-runtime` 1.8.0) | Apache-2.0 | 2026-10-29 | native (`tokio`) | unknown transitive set; **+2–5 MB est.** (low confidence) | no C deps visible in top-level manifest; transitive crypto unverified | **new engine** (CAS/chunk dedup), own cache | **L** | **spike then defer** |
| 12 | **rsync** | no Rust wire-protocol implementation; `fast_rsync` 0.2.0 is librsync *algorithm* only | Apache-2.0 | 2023-03-31 | n/a | small, but needs `rsync` binary + ssh | no Windows `rsync`; remote-shell dependency | **sidecar** | n/a | **reject** |
| 13 | **IPFS** | `ipfs-api` 0.17.0 abandoned (last release 2022-12-31); native p2p would be `iroh` 1.4.1 | Apache-2.0 (iroh MIT/Apache-2.0, not re-verified) | 2022-12-31 / 2026-10-21 | gateway = HTTP today | gateway: **0**; `iroh` p2p: very heavy | none for gateway | HTTP engine (gateway URLs) | **S** (docs only) | **reject native; document gateway** |
| 14 | **gRPC streaming** | `tonic` 0.14.9 (+`prost`, schema/codegen) | MIT | 2026-10-29 | native | `h2`/`hyper`/`tower`/`axum`; **+2–3 MB est.** + per-service `.proto` | needs `protoc`/build-time codegen; no generic "download a file" service | none (per-API) | n/a | **reject** |

Notes: `aws-sdk-s3` and `object_store` are listed only as the "don't" and
"maybe" for row 1 — the recommended S3 path needs **no new network crate**. SCP
is folded into SFTP (row 9) because the SCP protocol is legacy and the same SSH
session can do SFTP random reads; implementing SCP separately is not worth it.

---

## 2. Per-candidate analysis

### 2.1 S3-compatible object stores — *implement now (S)*

**What exists.** Presigned/SAS/signed-URL GET already works end-to-end: the
probe recognises AWS/GCS/Azure/generic signatures, extracts expiry, warns when a
URL is about to expire, and the chunked engine fetches it like any other range
source ([ARCHITECTURE.md:102](../../ARCHITECTURE.md),
`facts::signed_url_facts`). What is missing is (a) treating a bucket/prefix as a
first-class source, (b) listing objects, and (c) signing requests for private
buckets.

**Integration shape.** In-process, **same HTTP engine**. Listing is
`GET /?list-type=2&prefix=…&continuation-token=…` returning XML — `quick-xml`
0.42.0 (MIT, 2026-08-22, `default = []`, rustc 1.86) is enough and adds no
transport. SigV4 is ~150 lines over crates the kernel already has (`sha2` +
`hmac`; `hmac` would be the one small addition) for header/query signing and
`UNSIGNED-PAYLOAD` presigning. Do **not** take `aws-sdk-s3` 1.157.0 (full
Smithy stack, >100 crates) or `object_store` 0.14.2 (brings its own
`reqwest`/`hyper`/`chrono`/`aws-lc-rs` feature set, i.e. a second HTTP stack and
a C crypto provider for some configurations).

**Edge cases to budget.** 301 `PermanentRedirect` on wrong region endpoint;
`x-amz-…` and `X-Goog-…` encodings; pagination (1000 keys/page); URL-encoded
keys; multipart-vs-single-object is irrelevant for download; virtual-host vs
path-style endpoints; MinIO/R2/B2 deviations. Multi-file selection needs a
task-model decision (repo-seams covers the wire side).

**Risk.** Low. No new socket, no new TLS provider, inherits proxy/cookies/
`insecure`/rate-limit/telemetry. **Effort S** for presigned + listing, **M** for
full SigV4 + region redirects + tests against MinIO.

### 2.2 WebDAV — *implement now (S)*

**What exists.** WebDAV download is HTTP: `GET` (ranges work, so the chunked
engine applies unchanged) plus `PROPFIND` with `Depth: 1` and a Multi-Status
XML response for directory listing, Basic/Digest auth, and optional
`If`/`If-None-Match` semantics. The `webdav` crate on crates.io is 0.1.0
(2025-10-15, one version, "Types for WebDAV") — too immature to depend on; the
XML is simple enough to parse with `quick-xml`.

**Integration shape.** In-process, **same HTTP engine**; add a
`PROPFIND`-based "directory" probe variant and reuse `chunked.rs` per file. This
is the cheapest way to get "download a folder from a NAS/Nextcloud" without a
new transport.

**Edge cases.** Digest auth challenge handling (reqwest does not do it
automatically — hand-roll or use Basic only), self-signed NAS certificates
(`insecure` exists), `207 Multi-Status` namespaces, percent-encoded hrefs,
servers that return `403` for `PROPFIND` but allow `GET`.

**Risk.** Low. **Effort S.**

### 2.3 HLS — *implement now (M)*

**What exists.** `m3u8-rs` 6.0.1 (MIT, 2026-07-30) is a small, maintained
parser (deps: `chrono`; `nom` 7 behind the default `parser` feature; crate
description: "A library for parsing m3u8 files (Apple's HTTP Live Streaming
(HLS) protocol)"). What it does *not* do is download, decrypt or remux — that is
our work. Tag-level coverage (`EXT-X-KEY`, `EXT-X-MAP`, `EXT-X-BYTERANGE`,
`EXT-X-STREAM-INF`) should be re-checked against its docs when integrating; the
alternative `hls_m3u8` 0.4.2 shows 0 commits/0 issues in the last 90 days on
deps.dev and no dependents, so avoid it either way.

**Integration shape. New segment engine, in-process.** Reuse the existing
`reqwest::Client` for playlist and segment GETs, which means headers, cookies,
`Referer`, UA, proxy, TLS/insecure and rate limiting all keep working — important
because many CDNs require `Referer`/`Origin`. New pieces: variant selection,
ordered segment download with N workers (reusing `Counters`, `Reporter`,
`TokenBucket`, retry/`Retry-After`), byte-concatenation into `.part`, and a
segment-indexed resume record (the current `.part.json` is byte-range based;
`state.rs` needs a second mode or the segment engine keeps its own state file).
`EXT-X-ENDLIST`-less (live) playlists should be rejected in v1.

**Output fidelity.** fMP4/CMAF concatenation (init segment + media segments) is
a valid byte stream — no muxer needed. MPEG-TS concatenation yields a playable
`.ts`, not `.mp4`; honest naming or an ffmpeg sidecar for remux. Do not promise
MP4 for TS playlists in v1. AES-128 (`EXT-X-KEY:METHOD=AES-128`) needs
key fetch + AES-CBC decrypt (`aes` + `cbc` crates, small) or the segment fails;
SAMPLE-AES/DRM is out of scope.

**Risk.** Medium-low; the protocol has many optional tags and per-CDN quirks
(relative URIs, redirecting playlists, 302 on segments, byte-range segments).
**Effort M** (order of 8–12 dev-days including fixtures).

### 2.4 FTP / FTPS — *implement now, after S3/WebDAV (M)*

**What exists.** `suppaftp` 12.2.1 (MIT OR Apache-2.0, 2026-10-15, edition
2024, rustc 1.88) is the maintained choice: sync + async (tokio/smol), FTPS via
`native-tls` **or** `rustls` (`tokio-rustls-ring` feature), `REST` resume,
`EPSV`/`EPRT`, passive + active, stream transfers (`retr_as_stream`), and a
`LIST` parser. The sync `ftp` crate is deprecated; `async-ftp` exists but is far
less used.

**Integration shape. New transport behind a range-source seam.** FTP has a
control connection plus a data connection, so N parallel ranges need N logged-in
connections (or one stream with `REST` resume). The scheduler/plan/counters/
telemetry/verify all apply; the byte-fetch call must stop assuming
`reqwest::Client`. This is the *first non-HTTP transport*, so it pays the
abstraction cost once for SFTP later. FTPS must force `PROT P` (data channel
encryption); silently falling back to `PROT C` is a downgrade vulnerability.

**Edge cases.** Server-specific `LIST` formats; `REST` offsets with ASCII mode
(refuse non-binary `TYPE I`); concurrent-connection limits on cheap FTPS
servers (needs graceful downgrade to a single stream, mirroring the existing
`Downgrade` path); passive-mode data ports blocked by firewalls/NAT; UTF-8
paths; TLS session reuse requirements on some servers (vsftpd/IIS).

**Risk.** Medium. No proxy support (HTTP proxy only today), so FTP does not work
behind a corporate proxy. **Effort M** (8–12 dev-days incl. an in-process test
server fixture).

### 2.5 MPEG-DASH — *defer; do not adopt `dash-mpd` (M)*

**What exists.** `dash-mpd` 0.21.0 (MIT, 2026-10-04) is a downloader, not just
a parser. Its normal dependencies include a **non-optional `ffprobe` 0.4**,
`mp4-atom`, `pssh-box`, `file-format`, `regex`, `xmlparser`/`xot`, and
**`reqwest` 0.13**, plus optional `ac-ffmpeg` (libav) and `landlock`. The
companion CLI documents that [ffmpeg and the ffprobe binary are required for
muxing/concatenation](https://docs.rs/crate/dash-mpd-cli/0.2.12/source/doc/src/installation.md).
Adopting it would put a second HTTP stack and an external media binary inside a
4.9 MB resident kernel.

**Integration shape.** Prefer: hand-rolled MPD parsing with `quick-xml` feeding
the **same segment engine built for HLS** (`SegmentTemplate`/`SegmentList`/
`SegmentBase`, `Period` → `AdaptationSet` → `Representation`, `@mediaPresentationDuration`,
`@availabilityStartTime`). Without HLS, DASH is a much bigger first step.
DRM-protected streams (`ContentProtection`/Widevine/PlayReady) cannot be
downloaded without a CDM — out of scope and must be reported as such, not
failed obscurely.

**Risk.** Medium (manifest variants, template arithmetic, live edge). **Effort
M** *conditional on the HLS segment engine existing*; otherwise L.

### 2.6 OCI registry — *defer, demand-gated (M)*

**What exists.** `oci-client` 0.18.0 (Apache-2.0, 2026-09-18) works but pulls
`reqwest` 0.13 and `sha2` 0.11 — duplicate HTTP and hash crates next to the
kernel's 0.12/0.10 — plus `regex`, `chrono`, `oci-spec`, `olpc-cjson`.

**Integration shape.** If implemented, hand-roll registry-v2 on the existing
HTTP engine: `GET /v2/<name>/manifests/<ref>` with the OCI `Accept` list, Bearer
token flow from `WWW-Authenticate` (`realm`/`service`/`scope`), then
`GET /v2/<name>/blobs/sha256:…` per layer with digest verification via the
existing `sha2` 0.10, and save the blob as a `.tar`/`.tar.gz` (extraction is a
separate concern; do not add `tar` to the kernel for v1). Range support on
blob GETs is server-dependent but the chunked engine's downgrade path handles it.

**Risk.** Low-medium; auth flow and manifest media types are the only subtle
parts. **Effort M.**

### 2.7 Metalink — *defer, cheap when demand appears (S)*

**What exists.** RFC 5854 Metalink4 (`.meta4`) XML: mirror URIs
(http/https/ftp/rsync/torrent), per-file `<size>`, `<hash type="sha-256">`,
`<priority>`/`<preference>`. `quick-xml` 0.42.0 suffices; hashes verify with the
existing `sha2`/`finalize()` path.

**Integration shape.** Orchestration layer: parse → verify size/hash → pick
mirror by priority/preference → hand the chosen URL to the existing engine →
on failure, next mirror. ftp:// and torrent mirrors only become real when FTP
and BitTorrent exist; in a first release Metalink means "HTTP mirrors with
integrity verification", which is still useful (distro ISOs).

**Risk.** Low. **Effort S** (2–4 dev-days). Its value is demand-driven, not
feasibility-driven.

### 2.8 HTTP/3 — *defer (M)*

**What exists.** `quinn` 0.11.12 (MIT OR Apache-2.0, 2026-09-14, rustc 1.85;
default features `runtime-tokio`, `rustls-ring`, `platform-verifier`, `bloom`)
is mature, and `h3` 0.0.8 (MIT, 2025-05-06) — note the **0.0.x** version — is
the application layer. `reqwest`'s `http3` feature exists but is
[explicitly experimental and requires `RUSTFLAGS=--cfg reqwest_unstable`](https://github.com/seanmonstar/reqwest/commit/df09c9ea50290ec1d68d314cfa7b9e3c41f04f93);
`quinn` is already present in `kernel/Cargo.lock` as reqwest's optional
dependency, so enabling it would not change the lock file but *would* add the
code.

**Integration shape.** Either compile reqwest with `http3` + the unstable cfg
(easiest, but a build configuration change for all five prebuilt targets and an
unstable API) or drive `quinn`+`h3` behind the existing HTTP call sites
(large). **Do not** replace the chunked engine with h3: the mapping rejects
HTTP/2 multiplexing for ranges because a single flow-control window couples
ranges ([OPTIMIZATION.md §6](../../OPTIMIZATION.md)), and the same argument
applies to QUIC streams on one connection.

**Risk.** UDP egress is blocked on many corporate/mobile networks; the kernel's
`proxy` option cannot carry QUIC; CDN h3 adoption is partial; benefit for bulk
parallel-range downloads is marginal. **Effort M**, value low. Defer until a
source actually requires it.

### 2.9 SFTP / SCP — *defer (L), security-sensitive*

**What exists.** `russh` 0.65.1 (Apache-2.0, 2026-11-03, edition 2024, rustc
1.89) + `russh-sftp` 3.0.1 (Apache-2.0, 2026-09-28). Pure Rust, tokio-native,
no OpenSSL. But the dependency set is large (~60 crypto crates) and the current
release **pins pre-release crypto crates**: `ssh-key =0.7.0-rc.11`,
`rsa =0.10.0-rc.18`, `pkcs1 =0.8.0-rc.4`. Its **default** crypto backend is
`aws-lc-rs` (C/assembly; needs CMake and NASM on Windows) — for this repo the
`ring` feature must replace it (ring is already in the tree via rustls).

**Integration shape. New transport, random-access reads.** SFTP `read` takes
offset+length, so it maps cleanly onto the existing byte-range scheduler; the
cost is the same range-source seam as FTP plus SSH session handling. SCP is not
worth implementing separately.

**Security work that is *not* in the crate.** Host-key verification: `russh`
exposes a `check_server_key` callback but ships no `known_hosts` store, so
accepting keys blindly is the default failure mode — a MITM hole. Key formats
(OpenSSH/PEM/PuTTY `.ppk`), passphrase prompts, `ssh-agent`/`pageant`, and
`~/.ssh/config` aliases are all caller problems. Credentials must never be
copied into `<data-dir>/tasks/*.json`; the kernel already persists the raw
`Spec` (including `headers`) to disk, which is a pre-existing exposure that SFTP
keys would make much worse.

**Risk.** High (crypto supply chain + host-key verification + key storage).
**Effort L** (3–5 weeks incl. fixtures). Implement only after the credential
model is decided.

### 2.10 BitTorrent v1/v2 + magnet — *sidecar or defer (XL)*

**What exists.** `librqbit` 9.1.0 (Apache-2.0, 2026-10-29) is the only
actively maintained embeddable Rust client; `cratetorrent` has not been pushed
since 2022-03. The manifest is heavy: ~60 normal dependencies including
`axum-extra` (not optional), `dashmap`, `governor`, `bitvec`, `memmap2`,
`nix`, a `windows` Win32 crate, `reqwest` 0.13, `tokio-socks`, plus
`librqbit-{dht,lsd,upnp,utp,tracker-comms,peer-protocol}`. Default features pull
`native-tls`; a `rust-tls` feature exists. `disable-upload` is available.

**Why in-process is the wrong default.**
1. **Posture**: it binds TCP/UDP listeners, speaks DHT/LSD and *asks the router
   to open ports* via UPnP. The kernel is a resident process with no listening
   sockets today ([ARCHITECTURE.md:28-42](../../ARCHITECTURE.md)); adding
   listeners to every agent session is a security-review and sandbox problem.
2. **Output model**: a torrent is a file *tree*, while a task today is one
   target file with `.part`/rename/finalize. Multi-file output is a task-model
   change (repo-seams).
3. **Resume**: piece-level resume with hashing, not byte-range `.part.json`.
4. **Size**: +8–14 MB est. across five binaries, and its own `reqwest` 0.13.
5. **Legal/abuse**: seeding advertises the user's IP; copyright exposure of an
   always-on agent process is a product risk, not just a code risk.

**Recommendation.** If BitTorrent is demanded, ship the **rqbit binary
(Apache-2.0) as an optional sidecar** with explicit user opt-in and
`disable-upload`, and never start it implicitly. In-process integration is an
XL project and should be rejected for the next release.

### 2.11 HF Xet — *spike, then decide (L)*

**What exists.** Contrary to a common assumption, there **is** a Rust crate:
`hf-xet` 1.8.0 (Apache-2.0, 2026-10-29; first published 2026-03-31), with
`xet-client`/`xet-data`/`xet-runtime`/`xet-core-structures` 1.8.0 and an
`xtool` binary. It is tokio-based, `rustls-tls` by default, and its own code is
small (~6.7k lines) — the protocol work lives in the workspace crates.

**Integration shape. New engine.** Xet is content-defined chunking + a CAS
(xorb/chunk) with dedup and a local cache; it is not "GET a file by ranges", so
the chunked engine cannot be reused. The crate would bring its own runtime
assumptions, cache directory (must live under the kernel's data dir, which is
already subject to sandbox `ACCESS_DENIED` fallbacks) and HF-token handling.

**Uncertainty.** I did not inspect `xet-client`'s transitive dependency tree,
its actual binary cost, or whether current Hugging Face `resolve` URLs still
serve whole files over plain HTTP when Xet is enabled. Before committing, run a
2–3 day spike: measure HF download throughput through plain HTTP `resolve`
today, then through `hf-xet`, and compare with the kernel's existing segmented
HTTP path. If Xet's parallel-chunk path is materially faster on model repos, it
becomes a real option; otherwise the existing HTTP engine already wins.

### 2.12 rsync — *reject*

No Rust implementation of the rsync **wire** protocol exists on crates.io;
`fast_rsync` 0.2.0 (Apache-2.0, last release 2023-03-31) implements the
librsync *algorithm* (signature/delta) only, which is not what rsync servers
speak. A real integration needs the `rsync` binary on the host — absent on
Windows — plus a remote shell. **Reject** for a resident cross-platform kernel;
a user-invoked sidecar is the only honest option.

### 2.13 IPFS — *reject native, document gateway (S)*

`ipfs-api` 0.17.0 has had no release since 2022-12-31 and its backend-wrapper
design is deprecated; native IPFS (libp2p, bitswap) would be `iroh`-sized or
worse. Practical IPFS downloads are HTTP gateway URLs
(`https://ipfs.io/ipfs/<cid>`, `http://127.0.0.1:8080/ipfs/<cid>`) which the
kernel **already downloads today**. Recommendation: document the gateway path,
add a `ipfs://` → gateway rewrite in the host if desired, and spend no kernel
bytes on it.

### 2.14 gRPC streaming — *reject*

`tonic` 0.14.9 (MIT, 2026-10-29) is solid, but gRPC has no generic
"download a file" contract: every source defines its own `.proto` (service,
messages, auth metadata), so the kernel would need per-source codegen and a
protobuf runtime (`prost`) plus `h2`/`hyper`/`tower`. It is not a *protocol* to
add; it is an API to integrate per service. **Reject** in a protocol-extension
program.

---

## 3. Security and compliance

### 3.1 Credential redaction has gaps that new schemes will expose

The kernel's redaction is query-string based and HTTP-only:

- `CREDENTIAL_QUERY_PARAMS` covers 18 parameter names (AWS/GCS/Azure/OSS/
  `auth_key`, …) and `redact_url` rewrites matching values to `<redacted>`
  ([protocol.rs:797-830](../../../kernel/src/protocol.rs)).
- **Userinfo is not redacted.** `ftp://user:pass@host/file` (and `ssh://`,
  `sftp://`) would be projected verbatim into `ServerFacts.url`, task views and
  the review UI. Any scheme that carries credentials in the authority needs a
  userinfo pass in `redact_url`.
- **`redact_text` returns early when the text contains no `"http"`**
  ([protocol.rs:864-866](../../../kernel/src/protocol.rs)), so transport errors
  echoing `ftp://user:pass@…` or `ssh://…` are *not* scrubbed before they become
  task events and are appended to `history/*.events.jsonl`.
- **Raw `Spec` is persisted**: task records on disk keep the raw URL and the
  `headers` map ([protocol.rs](../../../kernel/src/protocol.rs) `Spec`
  serialization). Today that mostly leaks signed query tokens; adding S3
  `Authorization` headers, WebDAV Basic tokens or bearer tokens for OCI would
  write long-lived credentials to `<data-dir>/tasks/*.json` in plaintext.

**Recommendation before any credential-bearing protocol**: (a) redact userinfo
in `redact_url`; (b) make `redact_text` scheme-agnostic (scan `://` tokens, not
just `http`); (c) introduce secret *references* (env var / key-file path /
credential id) instead of raw secrets in `Spec.headers`, and redact on task-record
serialization; (d) a redaction test matrix per new scheme. This is a small,
testable change that de-risks every later protocol.

### 3.2 TLS and SSH specifics

- **FTPS**: prefer explicit `AUTH TLS` with rustls (`tokio-rustls-ring`); refuse
  `PROT C` downgrade; the `insecure` flag must map to invalid-cert acceptance
  only for HTTPS/FTPS, not to host-key acceptance for SSH.
- **SFTP**: host-key verification is mandatory-by-design but not provided by
  `russh`; a TOFU `known_hosts` under the data dir (with a visible warning) is
  the minimum acceptable behavior. Never passphrase-log keys or persist private
  keys. Prefer `ring` over `aws-lc-rs` to avoid a C build in the five-target
  matrix.
- **HTTP/3**: QUIC ignores `spec.proxy`; users behind an HTTP proxy would get a
  silent bypass/failure. If h3 is ever added, it must fall back to h2 with a
  recorded reason.
- **`insecure` reuse**: the field today means "accept invalid certs" for HTTPS
  ([http.rs:55-57](../../../kernel/src/http.rs)); do not let a new protocol
  reinterpret it as "skip host-key/hostname verification" without a distinct
  wire field and a warning code.

### 3.3 Licenses

Every crate evaluated for in-process use is permissive and compatible with the
kernel's `MIT OR Apache-2.0`:

| crate | license (crates.io, 2026-11-09) |
|---|---|
| `m3u8-rs` 6.0.1 | MIT |
| `suppaftp` 12.2.1 | MIT OR Apache-2.0 |
| `dash-mpd` 0.21.0 | MIT |
| `quinn` 0.11.12 | MIT OR Apache-2.0 |
| `h3` 0.0.8 | MIT |
| `russh` 0.65.1 / `russh-sftp` 3.0.1 | Apache-2.0 / Apache-2.0 |
| `librqbit` 9.1.0 | Apache-2.0 |
| `object_store` 0.14.2 | MIT/Apache-2.0 |
| `oci-client` 0.18.0 | Apache-2.0 |
| `hf-xet` 1.8.0 | Apache-2.0 |
| `quick-xml` 0.42.0 | MIT |
| `tonic` 0.14.9 | MIT |
| `fast_rsync` 0.2.0 | Apache-2.0 |

No GPL/AGPL crate appears in the candidate set — so the in-process lane is
license-clean. **The risk moves entirely to sidecars**: `aria2c` is GPLv2+,
`ffmpeg` builds are LGPL-2.1+ *or* GPL depending on configuration, and shipping
either inside the plugin/release (npm bundle or GitHub release) triggers
source-offer and (for GPL) derivative-work questions. `rqbit` (Apache-2.0) is
the clean torrent sidecar; `yt-dlp` (Unlicense) is the clean media sidecar. If a
sidecar program is adopted, prefer user-installed tools resolved from `PATH`
with a documented version check over bundling them.

### 3.4 BitTorrent abuse exposure

Beyond dependencies: a torrent client in an always-on agent process (a)
advertises the host's IP to trackers/DHT peers, (b) can be triggered by a model
or a prompt with a magnet link, and (c) makes the product a plausible
copyright-infringement vector. If BitTorrent is ever added it must be
**explicit user opt-in per task**, `disable-upload` by default, no DHT/LSD
unless requested, and never auto-resumed on kernel start.

---

## 4. Feasibility-ranked order and the first-release scope cut

Ranking = (protocol reuse × dependency weight × platform risk) against a
plausible demand tier. The intersection of "cheap in Rust" and "high demand"
is the segment below.

| rank | item | effort | why this position (feasibility side) |
|---|---|---|---|
| **1** | **S3-compatible object stores** (listing + optional SigV4) | S | Presigned GET already works; listing is one XML parser; no new transport, socket, TLS provider or platform risk; inherits proxy/cookies/retry/resume/telemetry. |
| **2** | **WebDAV** (listing + ranged GET) | S | Pure HTTP + one XML parser; reuses the chunked engine verbatim; unlocks NAS/Nextcloud folder downloads with almost no new code. |
| **3** | **HLS** (VOD, one rendition, fMP4/TS concat) | M | Highest-demand media protocol; parser is MIT and tiny; but needs a new segment engine, segment resume, AES-128 and per-CDN edge cases. |
| **4** | **FTP / FTPS** (REST resume, rustls) | M | Cheapest honest non-HTTP transport (MIT/Apache, rustls, tokio); pays the range-source abstraction cost that SFTP later reuses; no proxy support is the main caveat. |
| **5** | **MPEG-DASH** (manifest parse on the HLS segment engine) | M | Almost free *after* HLS, and expensive before it; explicitly avoid `dash-mpd` (ffmpeg/ffprobe + duplicate reqwest). |
| **6** | **Metalink** (HTTP mirrors + hashes) | S | Tiny (one parser), but value is demand-gated on distro/ISO workflows. |
| **7** | **OCI registry** (hand-rolled registry-v2) | M | Small and HTTP-only, but niche demand; do not take `oci-client` (reqwest 0.13 + sha2 0.11 duplication). |
| **8** | **SFTP/SCP** | L | Correctly doing host-key verification, key storage and credential policy is the real work; large crypto dep set with pre-release pins. |
| **9** | **HTTP/3** | M | Experimental reqwest cfg, UDP/proxy/sandbox issues, marginal bulk-download gain; defer until a required source appears. |
| **10** | **HF Xet** | L (after spike) | Real crate exists but is a different transfer model (CAS chunks + cache); measure before paying for it. |
| **11** | **BitTorrent** | XL in-process / M sidecar | Listeners, DHT/UPnP, multi-file output, legal exposure; sidecar with explicit opt-in only. |
| **12** | **rsync / IPFS-native / gRPC / SCP** | — | No maintained Rust implementation with honest semantics (rsync), abandoned crate (IPFS), or no generic protocol at all (gRPC). Reject. |

### Recommended scope cut for a first release

Ship **items 1–3 only** — S3-compatible objects, WebDAV, HLS VOD — and hold FTP
for the wave after. Rationale:

- All three are **in-process, HTTP-carried or HTTP-adjacent**; the kernel keeps
  exactly one network stack, one TLS provider (`rustls` + `ring`), one proxy
  story, no listening sockets, and no new C build step in the five-target
  matrix.
- Estimated binary cost: `quick-xml` + `m3u8-rs`(+`nom`/`chrono`) + AES ≈
  **+0.5–0.8 MB est.** (≈ +10–17 % over today's 4.0–4.9 MB), well inside the
  ≤ +2 MB wave budget and far from the 20 MB per-binary ceiling.
- Multi-file output is required by S3 prefixes and WebDAV folders; that task-
  model change is already the expensive part, so bundling it with HLS (which is
  single-file) balances the release.
- Nothing in this cut requires the credential-redaction fixes of §3.1 to be
  *blocking* (presigned URLs are already redacted), which lets those fixes land
  as a separate, well-tested security change before FTP/SFTP/S3-header-auth.

If a fourth slot is available, add **FTP/FTPS** (it validates the transport
abstraction early and its demand is concrete), and keep **DASH/Metalink** in the
release that follows. Do not add Sidecars (BitTorrent/ffmpeg/rqbit) in this
release.

### What would change this order

- **Demand evidence** putting lossless-media/HLS far above object storage
  (likely if the audience is video workflows) → HLS first, S3/WebDAV second.
- **A requirement to download private buckets with long-lived keys** → the
  credential-indirection work (§3.1) jumps ahead of S3 and becomes rank 0.
- **A requirement for authenticated SFTP drops** → SFTP jumps to 5, but only
  after the credential + host-key design exists; do not ship it earlier.
- **Evidence that HF Xet is materially faster than segmented HTTP resolve** →
  a Xet spike moves up, because model weights are this plugin's demonstrated
  workload (OPTIMIZATION.md) and the plugin already spends its optimisation
  budget on HTTP throughput.

---

## 5. Uncertainty register (what I could not verify)

1. **No builds were run** (task constraint). Every binary-size delta is an
   estimate from dependency manifests and the current 4.03–4.86 MB binaries; the
   true deltas must be measured with `cargo build --release` per target before
   quoting them to users.
2. **Dependency counts are direct dependencies from crates.io metadata**, not
   the transitive closure. For `russh`/`librqbit` the transitive set is the
   expensive part and is larger than the numbers shown.
3. **`dash-mpd` runtime requirement**: the `ffprobe` 0.4 dependency is
   non-optional and the sibling CLI documents ffmpeg/ffprobe as required; I did
   not read the library's download code to confirm exactly when it shells out.
4. **`object_store`'s** exact `reqwest` major and full feature cost were not
   inspected; it is listed only as an alternative to the recommended
   hand-rolled S3 path.
5. **`hf-xet`'s transitive dependencies** (including whether any C crypto backend
   is pulled) were not inspected; its size estimate is the least reliable in
   this note. Whether HF `resolve` URLs still serve whole files over plain HTTP
   when Xet is enabled is also unverified.
6. **`suppaftp` implicit-FTPS API** (port 990) was not verified beyond the
   README's "FTPS with native-tls or rustls" claim; explicit `AUTH TLS` is the
   path covered by its feature list.
7. **`russh` `known_hosts` behavior** is inferred from the crate's
   `check_server_key` handler surface, not from reading the current source; the
   practical conclusion (you must implement host-key verification) is robust but
   the API detail should be re-checked when integrating.
8. **DSH sandbox behavior for UDP sockets and listening ports** is untested for
   the kernel child process; it decides whether HTTP/3 and BitTorrent could work
   at all in sandboxed hosts.
9. **The "20 MB per binary" budget** is taken from the task brief, not from a
   repository policy; the repo only records the 4.60 MB reference in
   OPTIMIZATION.md.
10. `webdav` 0.1.0's license is listed as MIT on crates.io but was not
    separately re-verified, and the crate is not recommended for use anyway
    (types only).
11. `m3u8-rs`'s tag-level coverage (AES-128 key/IV, byte-range segments, init
    maps) was not verified from its documentation in this pass; only the crate
    identity, version, license and dependency set were. Plan for one spike
    against a real encrypted playlist.

---

## 6. Sources

All crate facts were read from the crates.io API on **2026-11-09**:

- crates.io crate/version/dependency endpoints (one per crate):
  [m3u8-rs 6.0.1](https://crates.io/api/v1/crates/m3u8-rs/6.0.1/dependencies),
  [suppaftp 12.2.1](https://crates.io/api/v1/crates/suppaftp/12.2.1),
  [suppaftp deps](https://crates.io/api/v1/crates/suppaftp/12.2.1/dependencies),
  [librqbit 9.1.0](https://crates.io/api/v1/crates/librqbit/9.1.0),
  [librqbit deps](https://crates.io/api/v1/crates/librqbit/9.1.0/dependencies),
  [dash-mpd 0.21.0](https://crates.io/api/v1/crates/dash-mpd/0.21.0),
  [dash-mpd deps](https://crates.io/api/v1/crates/dash-mpd/0.21.0/dependencies),
  [quinn 0.11.12](https://crates.io/api/v1/crates/quinn/0.11.12),
  [quinn deps](https://crates.io/api/v1/crates/quinn/0.11.12/dependencies),
  [russh 0.65.1](https://crates.io/api/v1/crates/russh/0.65.1),
  [russh deps](https://crates.io/api/v1/crates/russh/0.65.1/dependencies),
  [russh-sftp 3.0.1](https://crates.io/api/v1/crates/russh-sftp/3.0.1),
  [oci-client 0.18.0](https://crates.io/api/v1/crates/oci-client/0.18.0),
  [object_store 0.14.2](https://crates.io/api/v1/crates/object_store/0.14.2),
  [aws-sdk-s3 1.157.0](https://crates.io/api/v1/crates?q=aws-sdk-s3&per_page=1),
  [h3 0.0.8](https://crates.io/api/v1/crates/h3/0.0.8),
  [tonic 0.14.9](https://crates.io/api/v1/crates/tonic/0.14.9),
  [quick-xml 0.42.0](https://crates.io/api/v1/crates/quick-xml/0.42.0),
  [fast_rsync 0.2.0](https://crates.io/api/v1/crates/fast_rsync/0.2.0),
  [hf-xet 1.8.0](https://crates.io/api/v1/crates/hf-xet/1.8.0),
  [hf-xet deps](https://crates.io/api/v1/crates/hf-xet/1.8.0/dependencies),
  [iroh 1.4.1](https://crates.io/api/v1/crates?q=iroh&per_page=1),
  [ipfs-api 0.17.0](https://crates.io/api/v1/crates?q=ipfs-api&per_page=1),
  [webdav 0.1.0](https://crates.io/api/v1/crates?q=webdav&per_page=2).
- Upstream/feature documentation:
  [suppaftp repository (FTPS, tokio, `REST`, `EPSV`, `retr_as_stream`)](https://github.com/veeso/suppaftp),
  [dash-mpd-cli installation notes (ffmpeg/ffprobe required)](https://docs.rs/crate/dash-mpd-cli/0.2.12/source/doc/src/installation.md),
  [reqwest commit showing `RUSTFLAGS=--cfg reqwest_unstable` for HTTP/3](https://github.com/seanmonstar/reqwest/commit/df09c9ea50290ec1d68d314cfa7b9e3c41f04f93),
  [reqwest HTTP/2 & HTTP/3 support overview (http3 experimental)](https://deepwiki.com/seanmonstar/reqwest/4.2-http2-and-http3-support),
  [cratetorrent last-push 2022-03 (unmaintained alternative)](https://relatedrepos.com/gh/ikatson/rqbit),
  [hls_m3u8 0.4.2 maintenance score](https://deps.dev/cargo/hls_m3u8/0.4.2).
- Repository evidence:
  [kernel/Cargo.toml](../../../kernel/Cargo.toml),
  [ARCHITECTURE.md](../../ARCHITECTURE.md),
  [OPTIMIZATION.md](../../OPTIMIZATION.md),
  [prebuilt-kernels.yml](../../../.github/workflows/prebuilt-kernels.yml),
  [protocol.rs](../../../kernel/src/protocol.rs),
  [http.rs](../../../kernel/src/http.rs),
  [probe.rs](../../../kernel/src/probe.rs),
  [engine/mod.rs](../../../kernel/src/engine/mod.rs),
  [engine/chunked.rs](../../../kernel/src/engine/chunked.rs),
  [engine/single.rs](../../../kernel/src/engine/single.rs).

Background facts cited without re-fetching in this pass (marked for
re-verification before use): `aria2` is GPLv2+; `ffmpeg` licensing is
LGPL/GPL depending on build configuration ([ffmpeg.org/legal.html](https://ffmpeg.org/legal.html));
`yt-dlp` is Unlicense.

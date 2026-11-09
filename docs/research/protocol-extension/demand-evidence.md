# Protocol extension: demand-side evidence

Status: research note for the "which network protocol next" decision, 2026-11-09.
Scope: **external demand** for non-HTTP(S) protocols — who needs them, what an
HTTP-only downloader does wrong today, what comparable products support, and how
the candidates tier. Implementation cost is out of scope here (see the
rust-landscape note); cost is mentioned only as a coarse label.

Method: web search/fetch of primary docs, feature matrices, release notes,
knowledge bases and issue threads, plus this repo's own kernel source and live
session logs (marked *local*). Every non-obvious claim is linked. Claims are
tagged **measured** (a number observed in the cited source), **survey**
(self-reported sample), **vendor** (a vendor's own marketing/limitations doc) or
**inference** (my reasoning from the cited material). "No data found" is called
out in §7 rather than papered over.

Why the demand question is non-trivial: dsh-rdm's current kernel accepts only
`http`/`https` (`Spec::resolve` rejects any other scheme, [`kernel/src/protocol.rs`](../../../kernel/src/protocol.rs) lines
150–152; redirects to non-HTTP are refused in [`kernel/src/probe.rs`](../../../kernel/src/probe.rs) lines 68–69).
Everything else below is either "reject", "download the wrong bytes and call it
success", or "works because it happens to be HTTP underneath".

---

## 1. What comparable products support

### 1.1 General-purpose downloaders

| Product | HTTP(S) | HLS / DASH | FTP / FTPS | SFTP / SCP | BitTorrent / magnet | Metalink | WebDAV | S3/object | Notes (source) |
|---|---|---|---|---|---|---|---|---|---|
| **aria2** | ✅ | ❌ (not in documented protocol set) | ✅ FTP | ✅ SFTP | ✅ | ✅ | ❌ | ❌ | "Supports HTTP/HTTPS, FTP, SFTP, BitTorrent and Metalink" — [aria2 README](https://github.com/aria2/aria2); 43,446 stars (measured, GitHub API 2026-11-09) |
| **Gopeed** | ✅ | ✅ native HLS since v2.0.0-beta.3 (2026-09-17) | unclear (docs omit; a 2026 comparison calls FTP the gap) | ❌ | ✅ BT, magnet, **ed2k** | ❌ | ❌ | ❌ | [protocol docs](https://docs.gopeed.com/), [HLS release note](https://newreleases.io/project/github/GopeedLab/gopeed/release/v2.0.0-beta.3); 27,543 stars |
| **Motrix** (aria2 front-end) | ✅ | ❌ | ✅ FTP | ❌ | ✅ magnet + `.torrent` | ✅ Metalink | ❌ | ❌ | [features](https://motrix.app/features/); FAQ: handles "http(s), ftp, magnet: links, and .torrent files", proprietary schemes out — [FAQ](https://motrix.app/manual/faq/); 58,029 stars |
| **IDM** | ✅ | ✖ (no BT/HLS in docs) | ✅ FTP | ❌ | ❌ | ❌ | ❌ | ❌ | "supports HTTP, FTP, HTTPS and MMS protocols" — [IDM features](https://www.internetdownloadmanager.com/features2.html); BT ❌ per Gopeed's comparison table |
| **Free Download Manager** | ✅ | site video grab (no manifest protocol documented) | ✅ FTP | ❌ | ✅ + magnet | ❌ | ❌ | ❌ | "supports HTTP/HTTPS/FTP/BitTorrent download protocols" — [FDM extension listing](https://addons.mozilla.org/pt-BR/firefox/addon/free-download-manager-addon/) |
| **JDownloader** | ✅ | ✅ via FFmpeg, with documented limits | not evidenced | ❌ | ❌ | ❌ | ❌ | ❌ | HLS KB: "a lot of websites nowadays are using HLS"; *resume not possible, multi-chunk not possible* — [JDownloader HLS KB](https://support.jdownloader.org/de/knowledgebase/article/hls-streaming-downloads-and-related-problems) |
| **qBittorrent** | ❌ | ❌ | ❌ | ❌ | ✅ (DHT, PEX, BT v2) | ❌ | ❌ | ❌ | [repo](https://github.com/qbittorrent/qBittorrent); 41,461 stars |
| **curl** | ✅ HTTP/1.1, HTTP/2, **HTTP/3** | ❌ | ✅ FTP/FTPS | ✅ SFTP/SCP | ❌ | ❌ | ❌ (generic HTTP verbs only) | ❌ | Protocol table on [curl.se](https://curl.se/) |
| **GNU wget** | ✅ | ❌ | ✅ FTP | ❌ | ❌ | ❌ | ❌ | ❌ | "supports HTTP, HTTPS, and FTP protocols" — [GNU wget manual](https://www.gnu.org/software/wget/manual/html_node/Overview.html) |
| **yt-dlp** | ✅ via extractors | ✅ HLS + DASH (site-specific) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | thousands of sites; `ffmpeg` required to merge separate A/V — [yt-dlp README](https://github.com/yt-dlp/yt-dlp); 206,380 stars (measured, GitHub API 2026-11-09) |
| **rclone** | ✅ (HTTP backend) | ❌ | ✅ FTP | ✅ SFTP | ❌ | ❌ | ✅ WebDAV | ✅ S3 + Azure/GCS/B2/Swift… | backend matrix on [rclone overview](https://rclone.org/overview/); 60,889 stars |
| **dsh-rdm (today)** | ✅ | ❌ manifest saved as a file | ❌ scheme rejected | ❌ | ❌ magnet rejected; `.torrent` saved as a file | ❌ | partial: `GET` works, listing/auth missing | partial: presigned `GET` works, signing/listing missing | local kernel source, §2 |

Stars are popularity proxies, not usage; measured via the GitHub API on
2026-11-09 (e.g. [yt-dlp](https://api.github.com/repos/yt-dlp/yt-dlp)).

### 1.2 What the matrix says

1. **No mainstream product covers everything.** The market splits into three
   groups: HTTP/front-end downloaders (IDM, FDM, Motrix), media extractors
   (yt-dlp, JDownloader), and file-sync/cloud tools (rclone). A downloader
   adding a protocol is picking a *segment*, not closing a universal gap.
2. **HLS/DASH is a media-tool capability, not a general-downloader one.** IDM,
   aria2, Motrix, curl and wget do not natively process manifests; yt-dlp and
   JDownloader do, and Gopeed added native HLS only in September 2026. That is a
   live, still-being-filled gap in the general-downloader class.
3. **BitTorrent is table stakes for general downloaders except the
   Windows-commercial and CLI tools.** aria2, Gopeed, Motrix, FDM, qBittorrent
   have it; IDM, curl, wget do not.
4. **FTP is cheap legacy coverage** (aria2, Motrix, IDM, FDM, curl, wget,
   rclone) while **SFTP/WebDAV/S3 live almost exclusively in rclone** — the
   sync-tool class, not the download-manager class.
5. **HTTP/3 is a curl-only differentiator** in this set; no download manager in
   the matrix advertises it as a compatibility feature.

### 1.3 DSH ecosystem: the gap is already being filled outside the kernel

The DSH plugin index counted **28,621 entries** on 2026-11-08 (measured;
[dsh.so plugin index](https://cdn.dsh.so/plugins-index.json), API documented at
[dsh.so/data](https://www.dsh.so/zh/data/)). Among the small download-related
slice surfaced by search:

| Plugin | What it does | What that implies |
|---|---|---|
| [Siselea/dsh-motrix-download](https://github.com/Siselea/dsh-motrix-download) | routes model `download` calls to local Motrix; **URL / magnet / `.torrent`**; falls back to built-in HTTP | users want magnet/BT from an agent; aria2 is the accepted engine |
| [BeiWay1145/dsh-download-guard](https://github.com/BeiWay1145/dsh-download-guard) / [dsh-ops-guard](https://github.com/BeiWay1145/dsh-ops-guard) | pre-execute hook denies shell downloaders and forces aria2 | agents were bypassing managed downloads with `curl`/`node` |
| [zimai233/dsh-video-downloader](https://github.com/zimai233/dsh-video-downloader) | detects/downloads video from **Bilibili, YouTube, Douyin, Xiaohongshu** | the media/HLS demand exists and is met by a separate plugin |
| [Sama05/dsh-download-progress](https://github.com/Sama05/dsh-download-progress) | progress overlay for DSH downloads | demand for review/telemetry parity |
| [dsh-download-pro](https://deepseekharnessai.com/zh/plugins/dsh-download-pro) (directory listing) | aria2 RPC: magnet / BT / HTTP, five tools | same pattern: delegate non-HTTP to aria2 |

Caveat: these are ecosystem packages, not usage telemetry; star counts are
single/low-double digits, so treat them as *signal that a need is being
patched around*, not as proof of volume. No Gopeed/qBittorrent/Rayburst wrapper
was found in the material I could access (see §7).

The interesting tension: dsh-rdm's own pitch is "one managed kernel, reviewed by
a human", while the ecosystem's workaround is "call the local aria2/Motrix".
Any protocol decision should say explicitly whether dsh-rdm's answer is *native*
or *delegated* — the ecosystem has already voted for delegated once.

---

## 2. Demand evidence per protocol

Summary table first; detail follows.

| Candidate | Who actually needs it | What breaks in an HTTP-only downloader today | Demand tier |
|---|---|---|---|
| **HLS / DASH** (`.m3u8`, `.mpd`) | anyone downloading web video: courses, VOD, YouTube/Bilibili-class sites, JDownloader/Gopeed users | `GET` succeeds and saves a 1–10 KB text manifest as `video.mp4`; no segments, keys, init map or A/V mux; **silent wrong success** | **1 — must-have soon** |
| **BitTorrent / magnet** | Linux distro ISOs, Internet Archive, some datasets; DSH plugins already wrap aria2 for it | `magnet:` rejected as unsupported scheme; an `http(s)` `.torrent` URL downloads the ~50 KB bencode metadata as if it were the file | **1 — must-have soon** (demand; cost is the problem) |
| **FTP / FTPS** | enterprise drops, manufacturing/legacy suppliers, some distro mirrors, old NAS | `ftp://` / `ftps://` rejected outright; no `REST`/`SIZE`/`LIST`; no credential story | **2 — valuable niche** |
| **SFTP / SCP** | NAS, servers, backup boxes, devops handoffs | scheme rejected; no host-key verification model, no key-file credential UX | **2 — valuable niche** |
| **WebDAV** | Nextcloud/ownCloud/self-hosted | file `GET` already works over HTTP; missing `PROPFIND` listing, Digest auth, directory → multi-file result | **2 — valuable niche** (cheap) |
| **S3 / object stores** | ML datasets/checkpoints in buckets, R2/MinIO/OSS-compatible stores | presigned `GET` works today; missing SigV4 signing, `ListObjectsV2`, prefix → multi-file result | **2 — valuable niche** |
| **OCI registry** | model images for Ollama/KServe/edge; container artifacts | no token auth, no manifest → layer resolution, no digest verification; only a guessed blob URL would work | **2 — valuable niche** (watch) |
| **HF Xet** | the product's #1 current source (HF weights) | not an access gap (HTTP fallback exists); Xet-path resume/cancel quirks; HTTP path is slower per connection | **2 — valuable niche** (perf, not reach) |
| **HTTP/3 / QUIC** | nobody *needs* it for access; 41.1% of sites offer it | none — same HTTP semantics, maybe faster/robust | **3 — low priority** |
| **Metalink** | Fedora/DNF mirrors, distro ISO mirrors | saved as XML; no mirror selection/priority/hash use | **3 — low priority** (but very cheap) |
| **rsync** | distro mirror operators, backup/sync | scheme rejected; needs the rsync algorithm + server module protocol | **3 — low priority** |
| **IPFS** | NFT/dataset archives, some public-interest archives | `ipfs://` rejected; but a gateway URL is plain HTTP — workaround exists | **3 — low priority** |
| **ed2k, MMS, RTMP/RTSP, gRPC streaming** | legacy/China P2P, legacy IDM, live capture, RPC | n/a | **3 — low priority / out of scope** |
| **China netdisk APIs** (115/Quark/Baidu) | mainland users' offline-download workflow | provider APIs, not protocols; cookie/token-bound, often unofficial | **3 — out of scope as protocol** |

### 2.1 HLS / DASH — the biggest real gap, and it fails silently

**Who needs it.** HLS (RFC 8216) is the dominant adaptive-streaming format;
DASH is second. Bitmovin's 9th Video Developer Report 2025/2026 (industry survey of video
professionals) reports **HLS 61% and DASH 46% of distribution
formats**, CMAF 23%, LL-HLS 26%, LL-DASH 19%
([report PDF](https://bitmovin.com/downloads/bitmovin-9th-video-developer-report-2025-2026.pdf),
[summary](https://csimagazine.com/csi/birmovin-2025-developer-report.php)). JDownloader's
own knowledge base opens with "a lot of websites nowadays are using HLS
(HTTP Live Streaming) instead of progressive video streaming"
([JDownloader KB](https://support.jdownloader.org/de/knowledgebase/article/hls-streaming-downloads-and-related-problems)).
Gopeed shipped native HLS in September 2026
([release note](https://newreleases.io/project/github/GopeedLab/gopeed/release/v2.0.0-beta.3)),
and yt-dlp — the de-facto reference for media downloads, 206,380 stars — exists
almost entirely to turn site pages into HLS/DASH manifest URLs
([yt-dlp](https://github.com/yt-dlp/yt-dlp)). In the DSH ecosystem the need is
already served by a separate plugin
([dsh-video-downloader](https://github.com/zimai233/dsh-video-downloader)).

**What breaks today (agent-specific).** A manifest is a small text file. An
HTTP downloader will happily `GET` it, see `200`, `content-type:
application/vnd.apple.mpegurl`, a few KB, ranges irrelevant, and report success.
The agent's decision loop has no negative fact to branch on — the result looks
like a completed download. This is worse than an error: it is a plausible
success. Locally, the kernel captures `content_type`
([`kernel/src/probe.rs`](../../../kernel/src/probe.rs) line 98,
[`kernel/src/protocol.rs`](../../../kernel/src/protocol.rs) line 106) but has no manifest or
playlist classifier (grep of `kernel/src` finds no `m3u8`/`mpegurl`/`dash` handling),
and the task model is one URL → one file (tool table in [`README.md`](../../../README.md)).

Even with detection, downloading HLS is not "GET N files":
- the master playlist lists variants by `BANDWIDTH`/`RESOLUTION`, so a choice is
  required (RFC 8216 §4.3.4.2);
- encrypted segments use `EXT-X-KEY` (AES-128 or SAMPLE-AES), so concatenating
  ciphertext gives garbage (RFC 8216 §4.3.2.4); yt-dlp needs `pycryptodomex`
  "for decrypting AES-128 HLS streams" ([dependencies](https://github.com/yt-dlp/yt-dlp));
- fMP4 streams need the `EXT-X-MAP` init segment before segment 1 (RFC 8216
  §4.3.2.5) — a real user-visible bug class, e.g. an HLS downloader saving 100%
  then failing to play because it never fetched the init map
  ([puemos/hls-downloader #400](https://github.com/puemos/hls-downloader/issues/400));
- DASH/YouTube-class sources split audio and video into separate streams that
  must be muxed; yt-dlp makes `ffmpeg` "required for merging separate video and
  audio files" ([yt-dlp README](https://github.com/yt-dlp/yt-dlp)).

**Region note (China).** Bilibili — the platform mainland users most often ask an
agent to download from — returns either `durl` progressive FLV/MP4 segments or a
`dash` object with **separate audio and video** streams; the API doc also notes
the media URL is valid for 120 minutes
([bilibili-API-collect videostream URL](https://raw.githubusercontent.com/msyml/bilibili-API-collect/refs/heads/master/video/videostream_url.md)).
So mainland demand for "download this video" lands on DASH/HLS plus
cookies/`Referer` — not on FTP or S3.

**Demand signal strength: high, and evidenced outside China too.** HLS is the
one candidate where a major comparable product added support *this year*, the
failure is silent, and the DSH ecosystem already ships a workaround.

### 2.2 BitTorrent / magnet — high demand, high cost

**Who needs it.** Distros distribute ISOs as torrents by official policy:

- Ubuntu: "There are several other ways to get Ubuntu including torrents"
  ([alternative downloads](https://ubuntu.com/download/alternative-downloads));
- Debian: an entire CD/USB/DVD page for BitTorrent, and it recommends aria2 as
  one of the clients shipped in Debian
  ([debian.org/CD/torrent-cd](https://www.debian.org/CD/torrent-cd/));
- Linux Mint: "download Linux Mint either directly or via torrent"
  ([edition page](https://www.linuxmint.com/edition.php?id=319)).

aria2, Gopeed, Motrix, FDM and qBittorrent all support it (§1.1). In DSH, the
demand is explicit: one plugin's whole premise is "`download` 工具默认把 URL /
magnet / `.torrent` 交给 Motrix" with an HTTP fallback
([dsh-motrix-download](https://github.com/Siselea/dsh-motrix-download)).

**What breaks today.** Two different failures:
- `magnet:?xt=urn:btih:…` is rejected at scheme validation (local kernel source,
  §0) — a clean, honest error, actually the good case;
- `https://…/file.iso.torrent` is a valid HTTP URL, so the kernel downloads the
  *metadata* (~tens of KB bencode) and reports success. The agent asked for an
  ISO and got a torrent file with a green completion.

**Why this is not automatically "build it".** A conforming client needs the
peer protocol and DHT/trackers (BEP 3, BEP 5) plus piece verification, seeding
policy, port/NAT behaviour and an abuse/legal surface. Neither curl nor wget
implements BitTorrent; the projects that do are dedicated clients or aria2.
The ecosystem's answer is delegation, and that is itself demand evidence —
users keep a local aria2/Motrix for exactly this.

**Demand signal strength: high in the abstract and in the DSH ecosystem; fit for
a managed single-file downloader: low.** The cheapest honest answer is
"recognize and route", not "reimplement aria2".

### 2.3 FTP / FTPS — real but shrinking legacy demand

**Who needs it.** Manufacturing/supplier exchange and enterprise file drops are
still FTP-heavy; vendors sell multi-protocol servers (FTP, SFTP, FTP/S, HTTPS,
SCP) into manufacturing
([Cerberus FTP](https://www.cerberusftp.com/solutions/industries/manufacturing/)),
and a 2026 industry paper still describes factories "rel[ying] on … FTP and
scripts to move critical data"
([Progress](https://www.progress.com/resources/papers/file-transfer-the-missing-layer-in-manufacturing-modernization-strategies)).
Distro mirrors still offer FTP for some images: Debian's installation-media page
lists "HTTP, FTP ou BitTorrent" for live images
([Debian CD page](https://www.debian.org/CD/index.fr.html)).

**Against the demand:** the browser class abandoned it. Chrome removed all FTP
support in Chrome 88, stating FTP usage in the browser was low enough that it
would not keep investing and that stronger clients exist on every affected
platform ([Chrome 88 deprecations](https://developer.chrome.com/blog/chrome-88-deps-rems)).
That is a strong signal that *human* FTP browsing is dead, but not that
*machine-to-machine* FTP drops are.

**What breaks today.** `ftp://host/file` is rejected by scheme; there is no
`REST`-based resume, no `SIZE`/`MDTM` probe, no passive-mode/`EPSV` handling, no
FTPS explicit-TLS upgrade (RFC 4217) and no credential model (user/password in
the URL is the RFC 3986 userinfo form, which today would be a plain URL string
in receipts). curl and aria2 cover FTP/FTPS; the general-downloader class does
too (IDM, FDM, Motrix).

**Demand signal strength: medium; concentrated in enterprise/agent-automation
scenarios, weakly quantified publicly.** Good "valuable niche" candidate because
the protocol is small and the failure is hard.

### 2.4 SFTP / SCP — NAS and server handoffs

**Who needs it.** Anyone whose files live on a NAS, a server or a backup box.
aria2 supports SFTP and curl supports SFTP/SCP with host-key checking and
SHA-256 fingerprints ([curl.se](https://curl.se/)); rclone's SFTP backend is
Tier 1 in its matrix ([rclone overview](https://rclone.org/overview/)).

**What breaks today.** Scheme rejection; no SSH transport (kex, ciphers, host
key), no `known_hosts`/fingerprint UX, no key-file or agent credential UX.
Unlike FTP, the credential is usually a key, and "verify the host key" is a
decision an agent cannot make silently without a policy — this is a
human-approval-shaped problem, not just a protocol one.

**Demand signal strength: low-to-medium and *unmeasured*.** I found no public
statistics on SFTP download volume; the case rests on tool support (aria2/curl/
rclone) and the ubiquity of NAS/devops workflows. Mark as inference.

### 2.5 WebDAV — mostly an HTTP job already done

**Who needs it.** Nextcloud/ownCloud/self-hosted users mount files over WebDAV
at `https://<host>/remote.php/dav/files/<user>/`, typically with an app password
([Nextcloud docs](https://docs.nextcloud.com/server/latest/user_manual/en/files/access_webdav.html),
[tutorial](https://www.centron.de/en/tutorials/mount-nextcloud-webdav-linux-windows-macos)).
rclone supports it as a Tier-1 backend ([rclone](https://rclone.org/overview/)).

**What breaks today — less than it looks.** A WebDAV *file* is a plain HTTPS
`GET`, so dsh-rdm can already download a known file URL (custom headers are in
the spec, so Basic auth via `Authorization` is possible). What is missing is
`PROPFIND`/`Depth` directory listing (RFC 4918 §9.1), Digest auth, and turning a
collection into a multi-file result. So the protocol is *not* required for access
— only for discovery — which makes it a cheap add-on rather than a new
transport.

**Demand signal strength: medium among self-hosted users, low in agent
telemetry.** No public numbers found.

### 2.6 S3 / object stores — presigned URLs already work; listing/signing does not

**Who needs it.** ML/data agents pointed at a bucket or prefix: datasets,
checkpoints, exports. S3-compatible stores (R2, MinIO, OSS, B2) make this a
category, and rclone's most prominent backend is S3
([rclone](https://rclone.org/overview/)).

**What breaks today — again, nuanced.** A presigned URL is a normal HTTP `GET`
("can be entered in a browser or used by a program to download an object",
[AWS docs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)),
so dsh-rdm's probe and segmented transfer already handle it — including the
signed-URL expiry logic the kernel already has. The gap is:
- **discovery**: `ListObjectsV2` (paginated, `ContinuationToken`) to turn
  "bucket + prefix" into a file list ([AWS API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html));
- **auth**: SigV4 signing with access key / secret / session token, for buckets
  the agent has credentials for but no pre-generated URL.

Both are JSON/XML over HTTP — no new transport — which makes this the cheapest
way to unlock multi-file ML downloads.

**Demand signal strength: medium-high in ML workflows, low for single-file
"download this link" tasks.** The presigned path working today is why this is
tier 2, not tier 1.

### 2.7 OCI registries — model distribution is moving into registries

**Who needs it.** Ollama pulls models as registry blobs: manifests list layers
by digest, and "layers are pushed and pulled from the registry as blobs"
([Ollama manifest docs](https://pkg.go.dev/github.com/ollama/ollama@v0.11.4/server/internal/manifest)).
KServe now accepts `oci://` model URIs and serves OCI-packaged models
([OpenEverest, 2026-10-29](https://openeverest.io/new/2026-10-29-provider-kserve-oci-model-images/)),
and tooling exists to package HF models as OCI images
([modelcar-maker](https://pypi.org/project/modelcar-maker/0.4.0/)). `oras pull`
is the generic CLI ([oras docs](https://oras.land/docs/commands/oras_pull)).

**What breaks today.** A registry `GET` needs auth-token handling, a manifest
fetch, then per-digest blob downloads with verification
([OCI distribution spec](https://github.com/opencontainers/distribution-spec));
a plain HTTP downloader cannot resolve `registry/repo:tag` into blobs.

**Demand signal strength: low-to-medium today (the CLI skills exist), but it is
the model-distribution path that grows with K8s/edge inference.** "Watch" item.

### 2.8 Hugging Face Xet — not a reach gap, a performance and resume story

Xet is HF's CAS storage backend: content-defined chunking (~64 KB), chunk-level
dedup, and **Xet is the default for new users and repos since May 2025**
([HF post](https://huggingface.co/posts/jsulz/851142617150819),
[Xet docs](https://huggingface.co/docs/hub/main/xet/using-xet-storage),
[chunking blog](https://huggingface.co/blog/from-chunks-to-blocks)). Clients
choose xet or plain HTTP: Apache OpenDAL's HF service documents
`download_mode: xet (default) | http`, resolved from `HF_HUB_DISABLE_XET`
([OpenDAL HF](https://opendal.incubator.apache.org/services/hf/)), and an HF
forum thread states the HTTP path "does properly resume from existing bytes on
retry, just slower per-connection", while the Xet path has known
resume/`.incomplete` pain ([forum](https://discuss.huggingface.co/t/download-resume-possibility/180468/5)).
So:
- **compatibility**: dsh-rdm's HTTP path is the documented fallback, not a
  dead end — no new protocol required to download weights;
- **performance**: on xet-backed repos the HTTP path is slower per connection,
  and dsh-rdm's whole pitch is multi-connection speed (its live pass measured
  ModelScope at 106 MiB/s vs HF single-connection 0.13 MiB/s — local,
  [0.2.2 note](../../design/0.2.2-live-modelscope-pass.md)).

**Demand signal strength: high for the product's existing #1 use case, but the
right response is likely "integrate the `hf-xet`/CAS path later", not "add a
protocol".**

### 2.9 HTTP/3 — no access gap

HTTP/3 is supported by 41.1% of all websites (measured daily scan, W3Techs,
retrieved 2026-11-09 — [W3Techs](https://w3techs.com/technologies/details/ce-http3)),
and curl supports it including h3-only ([curl.se](https://curl.se/)). But it is
the same HTTP semantics over QUIC: a server that offers HTTP/3 almost always
offers HTTP/1.1/2, so HTTP/3 changes latency/robustness, not reachability. No
download manager in §1.1 markets it as a compatibility feature.

**Demand signal strength: low for access; medium as a perf/lossy-network
optimization on a later horizon.** Browsers' share of HTTP/3 is not evidence
that an agent downloader needs it.

### 2.10 Metalink — cheap, niche, and mostly a repo-mirror mechanism

Metalink (RFC 5854) is an XML description of a file with multiple URLs, sizes,
hashes and optional torrent metaurls; clients pick mirrors by `priority`
([RFC 5854](https://www.rfc-editor.org/rfc/rfc5854.html)). aria2 and Motrix
support it (§1.1). Fedora infra uses Metalink as the *default* mirror-resolver
for DNF repos (`metalink=https://mirrors.fedoraproject.org/metalink?repo=…`) and
users routinely comment it out when it is slow
([Fedora discussion](https://discussion.fedoraproject.org/t/failed-to-download-updates-metadata/191765)).
That is real but it is package-manager plumbing, not "download this file" — an
agent asked to download an ISO receives an https URL, not a `.meta4`.

**Demand signal strength: low. Implementation is cheap and aligns with the
existing checksum story, so it is a candidate for opportunistic support, not a
priority.**

### 2.11 rsync — mirror operations, not file downloads

rsync is how distros mirror; Arch's mirror page exposes
`rsync://mirrors.kernel.org/archlinux/`
([Arch mirrors](https://archlinux.org/mirrors/kernel.org/214/)), and mirror
operators coordinate around rsync shares. But kernel.org explicitly says rsync
is no longer available for its git repositories because it was inefficient and
could corrupt them, pointing mirror operators at grokmirror
([kernel.org scm README](https://www.kernel.org/pub/scm/README)). Neither curl,
aria2 nor rclone implements the rsync protocol. An agent downloading **a file**
has no reason to use rsync; an agent syncing **a tree** is a different product.

**Demand signal strength: low for dsh-rdm's job.**

### 2.12 IPFS — the workaround is HTTP

An IPFS client fetches a CID from a gateway over plain HTTP. The gateway layer
is the weak point: Cloudflare deprecated its public IPFS gateway hostnames
([Cloudflare migration guide](https://developers.cloudflare.com/web3/reference/migration-guide/)),
projects have had to remove the retired `cloudflare-ipfs.com` mirror
([ITK #6754](https://github.com/InsightSoftwareConsortium/ITK/issues/6754)), and
the public gateways are shared, rate-limited infrastructure ([IPFS public
utilities](https://docs.ipfs.tech/concepts/public-utilities/)). That is
evidence of *thin* demand and unreliable infrastructure, not of demand for a
native `ipfs://` transport in a downloader.

**Demand signal strength: low.** A user handing the agent a gateway URL is
already served by HTTP.

### 2.13 Others (deliberately out of scope)

- **ed2k**: Gopeed supports it; mainland file-sharing uses it via netdisk
  offline services. No evidence of agent demand outside that workflow.
- **MMS/RTMP/RTSP**: legacy/live-capture protocols (IDM still lists MMS; yt-dlp
  uses FFmpeg for rtmp). A file downloader is the wrong place.
- **gRPC streaming**: an RPC pattern, not a file-transfer protocol; no file
  ecosystem depends on it.
- **China netdisk APIs (115/Quark/Baidu)**: 115's offline-download is pushed via
  its "official open interface" by browser extensions that scan for
  **magnet / ed2k / `.torrent`** links
  ([115 extension](https://addons.mozilla.org/zh-CN/firefox/addon/115-push-helper/)).
  This is provider integration behind cookies/tokens, not a protocol dsh-rdm
  should implement; the transferable lesson is that the *magnet/ed2k demand*
  exists in China and is currently satisfied by cloud services.

---

## 3. Agent-workflow specifics

The protocol choice changes what the *agent loop* can decide. This table is the
part that differs between a human download manager and dsh-rdm.

| Agent need | HTTP today | HLS/DASH | BitTorrent | FTP/SFTP | WebDAV/S3 | OCI |
|---|---|---|---|---|---|---|
| **Probe → plan before bytes** | `HEAD`/range-GET, size, validators, signed-URL expiry (local kernel) | parse playlists: variant `BANDWIDTH`/`RESOLUTION`, segment count, duration, key method; `HTTP HEAD` on the manifest says nothing useful | need metadata: `.torrent` info dict or magnet metadata exchange; file list/size only after peer metadata | `SIZE`/`MDTM`/`LIST` (FTP); `stat` over SFTP; no single HEAD | `PROPFIND`/`ListObjectsV2`; object `HEAD` for one file | manifest + layer sizes |
| **Credentials** | query token + `Authorization`/cookie headers (spec supports headers/cookie/referer — local `kernel/src/protocol.rs` lines 136–138); **canonical redaction covers query values only** (`README` security section) | per-segment signed URLs/cookies/`Referer`; AES-128 key URI is itself an HTTP fetch (RFC 8216 §4.3.2.4) | none, but DHT/tracker egress + seeding policy are new policy surfaces | URL userinfo (RFC 3986) or separate user/pass; FTPS TLS (RFC 4217); SFTP key + host fingerprint | Basic/Digest, app password, SigV4 access key/secret/session token | registry bearer token / PAT |
| **Multi-file result** | one URL → one file (current task model) | hundreds–thousands of segments → **one** output file after decrypt/mux | one torrent → **directory tree** | one path → one file (listing optional) | collection/prefix → **N files** | one image → N layers |
| **Resume** | `.part` + validator compatibility (strong) | JDownloader documents *resume not possible* for HLS ([KB](https://support.jdownloader.org/de/knowledgebase/article/hls-streaming-downloads-and-related-problems)); acceptable only as segment-level skip | piece-level resume is inherent | `REST` (FTP), offset seek (SFTP); server support varies | range GET per object; signed-URL expiry bounds it | per-blob resume |
| **Verify** | SHA-256 + server digest (local) | no whole-file hash unless the manifest carries one (it usually does not) | per-piece SHA-1/Merkle | server hash rarely available | S3 ETag/checksums (ETag ≠ MD5 for multipart) | per-layer digest (strong) |
| **Live state/telemetry** | measured windows (local) | segments completed as progress; bitrate varies by variant | peer count/seeders, piece map | byte progress only | per-file progress | per-layer progress |

Three consequences for product design:

1. **The silent-success class is the real damage.** For HLS and `.torrent`, an
   HTTP-only downloader returns a 200 and a few KB. The agent's loop (§1 of
   [agent-native-downloader.md](../agent-native-downloader.md)) assumes a
   successful transfer is a successful *download*; both cases violate that. A
   content-type/extension recognizer that returns `unsupported: manifest,
   requires HLS` would fix the decision loop for a day of work, before any
   protocol is implemented.
2. **Multi-file is a prerequisite, not a detail.** HLS (one output file but N
   HTTP fetches with ordering/init/key), torrent (directory tree), S3 prefix
   (N objects), OCI (N layers), WebDAV folder (N files) all stress
   `task = one URL → one file`. The current tool surface renders one file/size
   per task ([`README.md`](../../../README.md) tools table). A `files[]`/directory result with
   per-file verification is needed before most of these protocols can be
   represented honestly.
3. **Credential canonicalization must extend before any credentialed protocol
   ships.** Today redaction is specified for credential-bearing *query* values
   (`README` security section, [`docs/ARCHITECTURE`](../../ARCHITECTURE.md)); FTP userinfo,
   SFTP key material and OCI tokens need the same rule, or receipts leak.

---

## 4. Adoption / usage data

Measured where possible; estimates labelled.

| Signal | Value | Type | Source |
|---|---|---|---|
| yt-dlp GitHub stars | 206,380 | measured (2026-11-09) | [API](https://api.github.com/repos/yt-dlp/yt-dlp) |
| Motrix stars | 58,029 | measured | [repo](https://github.com/agalwood/Motrix) |
| rclone stars | 60,889 | measured | [repo](https://github.com/rclone/rclone) |
| aria2 stars | 43,446 | measured | [repo](https://github.com/aria2/aria2) |
| qBittorrent stars | 41,461 | measured | [repo](https://github.com/qbittorrent/qBittorrent) |
| Gopeed stars | 27,543 | measured | [repo](https://github.com/GopeedLab/gopeed) |
| HLS share of distribution formats | 61% | survey (Bitmovin 9th report, video pros, 49 countries) | [PDF](https://bitmovin.com/downloads/bitmovin-9th-video-developer-report-2025-2026.pdf), [summary](https://csimagazine.com/csi/birmovin-2025-developer-report.php) |
| DASH share of distribution formats | 46% | survey (same) | same |
| Websites supporting HTTP/3 | 41.1% | measured daily scan | [W3Techs](https://w3techs.com/technologies/details/ce-http3) |
| DSH plugin-index entries | 28,621 | measured (2026-11-08) | [dsh.so index](https://cdn.dsh.so/plugins-index.json) |
| DSH download-related plugins found | ≥5, spanning aria2/Motrix wrappers + video downloader | measured by search, not deduplicated by intent | §1.3 |
| dsh-ops-guard's aria2 vs single-connection `node` HTTPS | 11.78 MB/s vs 0.13 MB/s (≈90×) on a 4.76 GB ISO | **self-reported by a plugin author** | [dsh-ops-guard](https://github.com/BeiWay1145/dsh-ops-guard) |
| Our own 2026-11-09 model download | 58.4 GB of GGUF shards + 0.87 GB projector in 3 files; HF single-connection 0.13 MiB/s vs ModelScope 16→102 connections 106 MiB/s; resume 3.68 GB across a kernel restart; SHA-256 verified | **measured, n=1 session** | [session log](../../../session_logs/20261109/README.md), [0.2.2 note](../../design/0.2.2-live-modelscope-pass.md) |
| Protocol share of *download bytes* (consumer or agent) | **no data found** | — | §7 |
| Agent download protocol mix | **no data found** | — | §7 |
| China-specific protocol share | **no data found**; only platform-level evidence (Bilibili DASH, 115 offline, ModelScope HTTP) | inference | §2.1, §2.13 |

What the numbers suggest (inference): the *installed base* of media tooling
(yt-dlp 206k stars) dwarfs the download-manager ecosystem, and the single
biggest measured spread in this project's own data is **source choice on plain
HTTP** (800× between HF and ModelScope). Neither fact argues for FTP, IPFS or
HTTP/3; both argue that HTTP-adjacent work (manifests, mirrors, multi-file) is
where the unmet demand is.

---

## 5. Tiered demand ranking

Tier = *demand* (who is blocked and how badly), not implementation cost. Cost
labels are coarse and defer to the rust-landscape assessment.

### Tier 1 — must-have soon

| Rank | Candidate | One-line reason | Evidence strength | Cost hint |
|---|---|---|---|---|
| 1 | **HLS/DASH manifest handling** (at minimum detect + honest refuse; then unencrypted VOD segment download) | The dominant media format; today a manifest downloads as a 1–10 KB "successful" file; every media tool and even Gopeed (2026) covers it; DSH already ships a video-downloader plugin | strong: Bitmovin 61/46%, JDownloader KB, Gopeed release note, yt-dlp 206k | high for full feature; **very low for detection** |
| 2 | **BitTorrent / magnet** | Official distro ISOs and the DSH ecosystem both demand it; today `magnet:` is rejected and `.torrent` is saved as payload — a bad failure either way | strong demand: Ubuntu/Debian/Mint torrent pages, 5 clients, 2+ DSH plugins | very high (peer/DHT/piece/seeding/legal) — recommend a **route/handoff or recognized-refusal** first, not a native client |

### Tier 2 — valuable niche

| Rank | Candidate | Reason | Evidence strength | Cost hint |
|---|---|---|---|---|
| 3 | **S3 / object stores** (SigV4 + ListObjectsV2; presigned GET already works) | Turns "bucket/prefix" into files; ML-adjacent; all JSON/XML over HTTP so it reuses the stack | medium: AWS docs, rclone S3 backend | medium |
| 4 | **FTP / FTPS** | Legacy enterprise drops and some distro mirrors; `ftp://` is rejected outright; small protocol | medium (vendor/industry evidence; no usage stats) | low |
| 5 | **WebDAV** | File GET already works; only discovery + Digest auth + multi-file missing — cheapest real unlock for self-hosted users | medium: Nextcloud/rclone | very low |
| 6 | **SFTP** | NAS/devops handoffs; needs SSH + host-key UX (an approval-shaped decision) | **weak/unmeasured** | medium |
| 7 | **OCI registry** | Model distribution for Ollama/KServe/edge; digest-verified layers; CLI already exists | medium and growing: Ollama manifest, KServe `oci://`, oras | medium |
| 8 | **HF Xet** | Not a reach gap (HTTP fallback documented); perf + xet-path resume quirks on the product's main source | medium: OpenDAL/forum/HF docs | integrate later, don't reimplement |

### Tier 3 — low priority (demand weak or purpose mismatched)

| Candidate | Why low | Note |
|---|---|---|
| **HTTP/3 / QUIC** | same reach as HTTP/1.1–2; 41.1% of sites offer it but don't require it | revisit if lossy-network throughput becomes a measured complaint |
| **Metalink** | repo-mirror plumbing, not user download requests; aria2/Motrix only | cheap, aligned with checksums; opportunistic |
| **rsync** | mirror/sync job, and kernel.org dropped it for git | different product |
| **IPFS** | gateway HTTP workaround; Cloudflare retired its gateway; rate-limited public infra | a gateway URL is an HTTP URL |
| **ed2k / MMS / RTMP / RTSP / gRPC** | legacy or wrong job | out of scope |
| **115 / Quark / Baidu netdisk APIs** | provider integrations behind cookies/tokens, not protocols; the magnet/ed2k demand behind them is already tier-1/out-of-scope here | region-specific, out of scope as protocol |

### What this implies for priorities

1. **Fix the recognition failure before building protocols.** A manifest /
   `.torrent` / non-HTTP scheme recognizer that returns a typed, actionable
   refusal (or routes it) converts two silent-wrong-success classes into honest
   facts. It is the cheapest demand win in this entire note and it directly
   protects the agent loop.
2. **If one protocol is built, build HLS (unencrypted VOD) — not the whole media
   extractor space.** The addressable subset is "agent was handed an `.m3u8`,
   wants one file": variant selection, segment scheduling, AES-128 key fetch,
   `EXT-X-MAP`, concatenation. Site extraction (YouTube/Bilibili auth, `Referer`,
   signatures), DRM and live streams are a different product; refusing those
   explicitly is better than half-supporting them.
3. **Do not reimplement BitTorrent soon.** The demand is real, but the users who
   need it already run aria2/Motrix (the ecosystem proves it). A scoped
   "recognize `.torrent`/`magnet`, hand to a local engine or refuse with a next
   step" captures most of the demand at a fraction of the cost/liability. If a
   native client is ever chosen, it is a multi-week subsystem, not a protocol
   adapter.
4. **The cheap Tier-2 tier is HTTP-adjacent.** WebDAV listing, S3 listing/signing
   and FTP/FTPS are all small protocols over existing sockets; they add reach
   for enterprise/self-hosted/ML users without a new scheduler. They are also
   the natural place to prove the multi-file result model before HLS/BT need it.
5. **Multi-file and credential canonicalization are gating work.** HLS, BT,
   S3-prefix, OCI and WebDAV all need a `files[]`/directory result, and FTP/SFTP/
   OCI bring credentials the current redaction rule (query values only) was not
   written for. Sequencing a protocol ahead of these produces dishonest
   receipts — the exact failure mode this product exists to avoid.
6. **The biggest measured lever remains HTTP source selection.** In the live
   session, the same object was 0.13 MiB/s on HF and 106 MiB/s on ModelScope
   (local, n=1); a plugin author measured ≈90× between aria2 and a
   single-connection `node` download. Mirror racing / multi-source scheduling
   (currently a documented non-goal) is likely worth more to users than any
   Tier-2 protocol. If the decision is "protocol vs source selection", the
   evidence favors source selection first.
7. **Region-specific demand is real but does not change the protocol ranking.**
   Mainland users need Bilibili DASH/HLS + cookies/`Referer`, ModelScope (plain
   HTTP, already measured working), and 115-style offline magnet/ed2k. Two of
   those are Tier-1/HTTP; the third is a provider integration best delegated.

---

## 6. Direct answers to the brief

- **Which protocols do users actually pick other tools for?** HLS/DASH (yt-dlp,
  JDownloader, Gopeed since 2026) and BitTorrent/magnet (aria2, Motrix, Gopeed,
  FDM, qBittorrent, plus DSH wrappers). FTP/SFTP/WebDAV/S3 are chosen inside
  rclone rather than inside download managers.
- **What breaks today?** Three classes, in increasing nastiness: (a) hard
  rejection (`ftp://`, `magnet:`, `sftp://`, `ipfs://`, `rsync://`); (b) partial
  support that works by accident (presigned S3 GET, WebDAV file GET); (c)
  **silent wrong success** (`.m3u8`, `.mpd`, `.torrent` saved as the payload).
- **What is region-specific and evidenced?** Bilibili DASH + 120-minute signed
  URLs; 115/Quark-style offline download driven by magnet/ed2k/`.torrent`
  scanning; ModelScope as the fast mainland HTTP mirror of HF repos (measured
  106 MiB/s vs 0.13 MiB/s, n=1). No quantified China protocol-share data found.
- **What is the top demand/priority mismatch?** BitTorrent: demand is high but
  fit for a managed single-file downloader is low, and the ecosystem already
  solved it by delegation; HLS: demand high and the fix also improves honesty —
  the best first investment.

## 7. Gaps and failed search paths

- **No protocol-share statistics.** I could not find any measured breakdown of
  consumer or agent download volume by protocol (FTP vs HTTP vs BT etc.); the
  available numbers are product popularity and survey shares of *streaming
  formats*. Do not cite the Bitmovin percentages as traffic share.
- **No agent-specific download telemetry** exists publicly; DSH plugin stars are
  tiny and the index does not expose per-plugin download counts in the feed I
  fetched (it exposes npm weekly downloads only for npm-distributed plugins).
- **SFTP/FTP demand is weakly quantified**; the enterprise evidence is vendor
  content, and Debian's FTP offer is a single data point.
- **Some fetches failed** due to the network environment: `docs.nextcloud.com`
  timed out (used the canonical URL plus a tutorial for the endpoint shape),
  `bitmovin.com/video-developer-report/` returned 404 (used the report PDF and a
  secondary summary), and HF's Xet page returned 404 on one path (used the
  `main/xet/using-xet-storage` doc plus OpenDAL and a forum thread). GitHub
  search with `OR` terms returned a meaningless 70,636 count (tokenized `dsh`),
  so ecosystem plugin counts are named examples, not a census.
- **Rayburst**: no Rayburst wrapper was found in the DSH material I could reach;
  if it exists, it was not in the search results returned to me. Same for a
  Gopeed or qBittorrent wrapper — the wrappers found target aria2/Motrix.
- **Cost is not assessed here.** The "low/medium/high" hints are ordering
  aids only; the rust-landscape teammate's crate/cost analysis should override
  them.

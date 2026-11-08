# Agent-native downloads: evidence and design reasoning for dsh-rdm 0.2.0

This note supports [0.2.0 contract](../design/0.2.0-agent-native.md) §1
(decision loop), §3 (model-facing tools) and §6 (review surfaces). Sources: the
installed package references for `@deepseek-ai/dsh-tools` and
`@deepseek-ai/dsh-client-ui-sidebar-right` (each package's `README.md` under the
installed Harness `node_modules/@deepseek-ai/`), the harness `agent-experience`
skill, primary HTTP/cloud/tool documentation (linked), and this session's tool
contract where marked *observed*; judgements are marked *inference*.

## 1. The decision loop is the product

§1.1 is the set of choices an agent must make in as few model steps as possible.
Extending it with the minimum facts per step:

| Step | Decision | Minimum facts | 0.2.0 surface |
|---|---|---|---|
| discover | use, delay or skip | final URL, size, proven ranges, validators, signed/TLS/rate-limit/checksum state | `rdm_probe` → `ServerFacts` + `warnings` + `recommendation` + `hint` |
| decide | shape and risk | ranges + validators + duration vs URL/cert expiry | `recommendation {connections, chunk, singleStream, verify, reason}` |
| start | begin without a second round trip | all of the above on the task | `rdm_download` → `task` + preflight `server` (`waitProbeMs`) |
| observe | wait or intervene | windows, stall, trend, retries, workers, rate limit | `rdm_wait`; `rdm_tasks taskId` for detail |
| intervene | pause/resume/retry/cancel | diagnosis + stable error + next calls | `diagnosis[]`, `error`, `next`, `rdm_control` |
| verify | trust the bytes | expected vs actual hash, server checksum, validator match | `detail.verification`, `resumeState.validatorsMatched` |
| report | brief the human | bounded receipt with identity, outcome, integrity | render receipt + review surfaces |

Each row is one call and one model step; `dsh-tools` says results are "resent
until compaction", so probe-start-poll-poll pays four times. Hence `rdm_download`
attaches preflight facts and `rdm_probe` returns decision-grade facts — the
cheapest call is the one not made (`agent-experience`'s total-work test).

Facts change strategy. AWS checks presigned-URL expiry **at request time**: a
transfer starting before expiry continues, but a resume after expiry fails — so
"expires in 19m" means *do not pause*. `Retry-After` on 429/503 becomes a wait
duration. Negative facts matter too: unknown size gives ETA `unknown`; no ranges
give unsafe resume; a blocked HEAD gives `probedBy: "range-get"`. Stable warning
codes let the model branch without reading prose.

## 2. Tool surface: two layers, each fact once

### 2.1 Canonical JSON and a line-oriented render

`defineTool` takes an output schema plus `render`: canonical values belong to
execution while the Session records rendered content. Canonical JSON is the
machine contract; the receipt is what the model reads — and what the client card
reads, since the Web Client derives card props from raw arguments and result
content via `tool.call.toolview`. Receipts must carry card fields (task id,
status, size, verdict), not only sentences.

Privacy caveat: "replacing or redacting that content does not remove the
canonical value available to a programmatic caller". Credential-bearing query
strings in canonical `warnings`/`reason` persist in session history despite UI
redaction; scrub them at the execution boundary, as §2.1 requires.

### 2.2 Bounded, and progressive by default

Boundedness is a cost constraint. The hot path is a flat `TaskView`; `TaskDetail`
only from `get`; caps 20/100 tasks and 30 events; unknowns `null`. Two DSH facts
justify it: definitions cost fixed prompt tokens per request (facts belong in
results), and results are append-only for KV cache while schema changes invalidate
the prefix. Expose `truncated`/`total`.

### 2.3 Long-poll, not tight polling

`rdm_wait` is the honest primitive: block until terminal or timeout and return
`timedOut`. But DSH's `timeoutMs` is declarative only and cancellation is
cooperative (the body must observe `exec.signal`), so the host must clamp
`timeoutSec` (≤300), enforce it and return a typed timeout; if a transfer outlasts
the cap, report "still running" and end the turn. Prior art agrees: aria2 has no
wait (`tellStatus` is polled by gid), while Playwright's
`waitForEvent('download')`, agent-browser's `wait --download`, and this harness's
bash jobs (observed: background job ids, `job_output(wait)`, `job_kill`) expose
blocking completion.

### 2.4 Failure shape: canonical value, not thrown error

DSH finalizes "any thrown or denied call" as exactly `Error: <message>` without
structured detail. A recoverable download failure must therefore be a canonical
value rendered as `status=failed error=network message=… next rdm_control …`;
throwing discards the code and actions the agent needs; throw only for invalid
usage.

### 2.5 Policy once, in the system prompt

`agent-experience` says each fact once: policy in the system-prompt section,
behavior in the tool description, rules on the parameter. Duplication costs
twice: definitions are paid every request, and edits invalidate KV reuse from the
first changed token. Five descriptions repeating "use `rdm_*`
instead of curl" is five copies. The ~90-word `dsh-rdm:downloads` section is the
right home; [ARCHITECTURE.md](../ARCHITECTURE.md)'s claim that descriptions state
policy must go, and "policy appears once" should be measured on built
`lib/index.js`.

## 3. Server facts an agent cannot discover by downloading

**Ranges and size.** A HEAD 200 does not prove `Range` handling; some origins
advertise `Accept-Ranges: bytes` yet answer a ranged GET with 200 and the whole
body. Trust `range.supported` only after a 206 with validated `Content-Range`
([RFC 9110 §14](https://www.rfc-editor.org/rfc/rfc9110.html#section-14)).
Content-encoding means ranges cover the encoded representation.

**Validators and resume safety.** RFC 9110 requires strong comparison for
`If-Range`, forbids weak entity tags, and allows an HTTP-date only when no entity
tag exists and the date is strong
([§13.1.5](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.5)). A
Last-Modified value is implicitly weak unless the response Date is at least one
second later and a shared clock can be inferred
([§8.8.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.8.2.2)).
So a `W/` ETag never justifies resume, Last-Modified-only is `weak`, and a
server ignoring If-Range returns a full 200 the client must detect. The kernel
sends If-Range and validates `Content-Range`/length; `resume.safety` exposes that
reasoning.

**Signed-URL families.** SigV4 query auth signs `X-Amz-Date` plus relative
`X-Amz-Expires`, so expiry is generated-at + TTL, not "now + TTL"; the ceiling is
7 days for long-lived IAM user credentials, and temporary role/STS credentials cap
the URL at their lifetime ([AWS presigned
URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)).
SigV2 uses absolute `Expires`; Azure SAS uses absolute `se` (plus optional `st`;
stored policies can revoke) ([Azure
SAS](https://learn.microsoft.com/en-us/rest/api/storageservices/create-service-sas));
GCS V4 uses `X-Goog-Date` + relative `X-Goog-Expires`, older links absolute
`Expires` ([GCS signed
URLs](https://docs.cloud.google.com/storage/docs/access-control/signed-urls)).
Pitfalls: expiry is evaluated on the server clock (skew is a documented
signature failure); credentials can die before the nominal TTL; redirects may
land on a differently signed URL, so the final URL's expiry is authoritative;
and if `Range` is signed, `If-Range` must be signed too or resume fails with a
signature error, not a diagnosable 403 (AWS FAQ `HeadersNotSigned: if-range`).

**TLS.** `notAfter`/issuer bound reconnects and resume windows; a short lifetime
plus `insecure` hints at interception. Expiry does not interrupt an established
transfer and is weak evidence of identity — hostname validation and the trust
chain decide that ([RFC 5280
§4.1.2.5](https://www.rfc-editor.org/rfc/rfc5280.html#section-4.1.2.5)).

**Rate limit and redirects.** `Retry-After` may be delay-seconds or an HTTP-date
on 503/3xx
([§10.2.3](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3)); 429 is
[RFC 6585 §4](https://www.rfc-editor.org/rfc/rfc6585.html#section-4). Apply the
wait per origin, not per chunk, or N workers trigger the next limit. An HTTP-date
needs clock agreement; a 200 carrying rate-limit headers is still success.
Redirects change method semantics (303/307) and drop credentials cross-origin;
`finalUrl` is what must be shown and resumed.

**Checksums.** RFC 9530 makes `Content-Digest` the standard (`sha-256=:base64:`)
and obsoletes RFC 3230's `Digest` ([RFC 9530](https://www.rfc-editor.org/rfc/rfc9530.html));
`Content-MD5` still appears but is weak
([RFC 1864](https://www.rfc-editor.org/rfc/rfc1864.html)). S3 supports many
algorithms including SHA-256, but only when the object was stored with one;
multipart SHA-256 uses a composite type over parts, so "sha256 available" is not
always a whole-file hash ([S3 object
integrity](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity.html)).
S3 ETags are not checksums — the ETag may or may not be MD5 and is not MD5 for
multipart uploads ([S3
Object](https://docs.aws.amazon.com/AmazonS3/latest/API/API_Object.html)). GCS
exposes MD5/CRC32C via `x-goog-hash`; with `x-goog-stored-content-encoding: gzip`
the hash covers stored compressed bytes, so a decompressing client cannot
compare it (inference) ([GCS data
validation](https://docs.cloud.google.com/storage/docs/data-validation)). Expose
"algorithm available"; `verified` means "compared and matched".

## 4. Prior art: the state an agent gets today

| Tool | Exposes | Gap for the loop |
|---|---|---|
| curl/wget | `-w` post-hoc timing, size, `http_code`; `--spider` HEAD; `--continue` resume; human progress on stderr | no live state or server advice; agent parses text |
| aria2 JSON-RPC | `gid`; `tellStatus`/`tellActive` with `completedLength`, `totalLength`, `downloadSpeed`; pause/unpause/remove; decimals as strings | poll-only, no wait; transport facts only |
| yt-dlp | `--dump-json`, `--progress-template`, `progress_hooks`; README warns programs not to parse normal stdout | site-extractor shaped, not general HTTP facts |
| Playwright `Download` | event at start; `path()`/`failure()` at completion; `saveAs` waits; context close deletes files | no byte progress or server facts; lifecycle surprise |
| agent-browser | `download @ref path`, `wait --download --timeout` | no progress/validators; remote endpoints reject local paths |
| MCP tools | one result with content/structured content; optional progress via `progressToken`; filesystem server bounds work (15 s, 100k entries), atomic tools, annotations | no long-running transfer primitive; caller polls |
| harness bash jobs (observed) | `run_in_background` → `jobId`; `job_output(wait)`; `job_kill` | stream-oriented; one result per read |

Three patterns repeat; 0.2.0 follows all three: machine channel vs human
output (yt-dlp; DSH's canonical/render split), blocking wait vs polling
(Playwright, agent-browser, DSH jobs), and bounded facts vs payloads (MCP caps;
`copy_file` keeps content out of the conversation). dsh-rdm's version: canonical
JSON + receipt, `rdm_wait` + `rdm_tasks`, `ServerFacts` + bytes on disk.

## 5. Human review surfaces

The operator/auditor split is why review-only fits. The sidebar-right README
defines a per-session docking surface whose tab types register
`id`/`kind`/`title`/`guide`; its Model Experience is "None … registers nothing
model-facing", so a review tab costs zero prompt tokens and no KV cache. Layout
is keyed by session id and persisted; bodies can be `keepMounted`. Two constraints follow: titles are captured at open, so live counts belong in
the sticky body header (design §6.3); and "no surface without a session" puts
*global* review in main/left, not the right rail — the §6.2/§6.3 split is
structurally correct. Cards derive from raw arguments and result content, so
receipts must expose task id and verdict.

What a human needs: identity (requested vs final URL, host, redirects); server
claims (range, validators, signed/TLS state, rate limit); measured behaviour
(windows, stall, retries, workers); integrity (expected vs actual hash, checksum
availability, validator match); destination and resume state; actions
taken. Keep claimed / measured / verified separable so a seal never means more
than "a hash was compared and matched".

Fake precision is the main review failure mode. A single EWMA and a point ETA
imply knowledge the kernel lacks; four windows, `stalledMs` and an
`etaConfidence` that degrades to `unknown` are honest. aria2 reports only an
instantaneous speed and Playwright no byte counts. Render `-` for unknown, never
0% or "0 B/s" as measured.

## 6. Adopted, deferred, unresolved

Adopted because it shortens the loop: ServerFacts with bounded warnings,
recommendation and reason; resume safety; signed/TLS/checksum/rate-limit facts;
four windows, trend, stall, ETA confidence; diagnosis codes and actions;
long-poll `wait`; flat hot path vs detail; session attribution; review-only
surfaces.

Deferred with reasons: mirrors and multi-source scheduling (needs a trust model);
checksum federation (who signs the hash?); download approval gates (belongs to
the harness permission layer); HTTP/2 tuning for range workers (PROTOCOL v1
removed it for measured reasons); origin memory beyond a bounded 256-host ledger;
auto-opening the review tab; MCP exposure (protocol v1 deliberately has none); `deferLoading` for `rdm_*` (schema
is small; revisit if it grows).

Contract issues found (all six resolved on 2026-11-08; see the final section):

1. §2.1's `range.ifRange` ("a strong validator or Last-Modified exists") is
   wrong under RFC 9110: If-Range forbids weak validators, and Last-Modified is
   implicitly weak (§8.8.2.2). Fix §2.1/§5.3 or `resume.safety` can say `safe`
   when it is not.
2. §2.1 maps `x-goog-hash` to `sha256`; GCS exposes MD5/CRC32C there, and the
   struct has no CRC32C field. Fix and verify in W2.
3. [PROTOCOL.md](../../PROTOCOL.md) v1 calls per-origin learned budgets removed
   while §5.4 reintroduces a bounded ledger; PROTOCOL v2 must state the new scope.
4. `signedUrl.source` is one enum, but SigV4 needs both `X-Amz-Date` and
   `X-Amz-Expires`; encode the rule (`sigv4-query`, `sigv2-expires`,
   `azure-sas-se`, `gcs-v4`, `generic-expires`).
5. The 300 s `wait` cap is a host convention, not a kernel limit; pick an
   enforcement point and type the timeout.
6. Define retention for bearer tokens in canonical values (UI redaction is not
   canonical redaction) and for origin-ledger targets at rest.

## Contract resolutions (2026-11-08)

The Lead resolved all six issues above; the contract now agrees with this note.
Recorded here so the note does not read as stale:

1. **ifRange / resume safety.** §2.1/§5.3 now follow RFC 9110 strong comparison:
   `range.ifRange` is true only when a strong ETag exists; Last-Modified-only is
   `weak` and never sent as `If-Range`. The weak path re-probes the validator,
   validates `Content-Range`/length and falls back to a full body on a 200.
2. **Checksums.** The struct is now
   `contentDigest`/`contentMd5`/`sha256`/`crc32c`; `x-goog-hash` maps only to
   CRC32C/MD5, SHA-256 only from `x-amz-checksum-sha256`, and `verified` stays
   `null` until a hash is actually compared.
3. **Origin ledger.** PROTOCOL v2 scopes `origins.json` as bounded reported
   history (≤256 hosts), not an enforced budget; mirrors and learned concurrency
   remain explicit non-goals.
4. **signedUrl.source.** The enum is now
   `aws-sigv4 | aws-sigv2 | gcs-sigv4 | azure-sas | generic-expires | unknown`;
   expiry is derived from the final URL by each family's own rule, request-time
   semantics are documented, and `signed-url-expiring` means *do not pause*.
5. **wait.** The host clamps `timeoutSec` to ≤300 s and returns a typed
   `timedOut`; the kernel keeps its own 300 s maximum, so the tool cannot outlive
   the kernel contract.
6. **Credentials.** Canonical redaction is now a protocol rule: credential query
   values become `<redacted>` in every projection, request `headers`/`cookie` are
   never projected, and on-disk task records are documented as owner-sensitive
   with raw URLs retained only for resume.

The only remaining items are the deliberate deferrals in §6; no unresolved
contract defect is known as of 2026-11-08.

# System prompt and agent workflow: how dsh-rdm plugs into DSH

> **TL;DR（中文）**：DSH 的系统提示词是一组带数值序号的 section，工具指引占
> `1000–3100` 区间，之后才是 tools-SDK、结构化输出和环境后缀（`10000+`）。
> dsh-rdm 原先把自己挂在 `DEPLOYMENT_PERSONA_SUFFIX + 1`（`10201`），实际渲染在
> 整个提示词最后、环境后缀之后，且代码注释与实际行为不符；它也没有像一等公民
> 工具那样按“工具是否对当前 Agent 可见”决定是否渲染。本次 0.3.3 把下载策略节
> 移到工具指引区（`MCP_SERVERS + 1` = `3101`），改为 tool-aware 渲染，并补上
> 0.3.3 之后必须让模型知道的三件事：**面板操作不会通知 Agent**（要重读
> `rdm_tasks`）、**暂停/取消/重试/移除只在用户要求时执行**、**`rdm_probe` 发现的
> 镜像应作为 `rdm_download` 的 `sources`**。研究同时发现了几处“canonical 值 vs
> 模型可见 receipt”的偏差（`rdm_probe`/`rdm_download` 的 `hint` 未渲染、
> `rdm_history` 的样本/事件对模型不可见、`offset` 翻页只改变 `range` 行），
> 已在 §6 列为后续修复项，本轮不改变工具行为。

## 0. Scope and sources

This note answers two questions: how DeepSeek Harness (DSH) assembles the system
prompt and the model-facing tool surface, and how `dsh-rdm` should attach its
policy/tools/workflow to that machinery. Evidence comes from the installed DSH
`0.2.2-rc.1` packages and from this checkout; the live prompt capture is from a
running `dsh web` session with this plugin linked into the `web` profile.

Primary sources (installed packages):

- `@deepseek-ai/dsh-system-prompt` — section registry, numbered orders, variables,
  contexts, `renderPrompt`, KV-cache notes.
- `@deepseek-ai/dsh-tools` — `defineTool`, model-visible schema projection,
  canonical value vs rendered content, `timeoutMs` declaration, `deferLoading`.
- `@deepseek-ai/dsh-agent-loop` — per-step request shape, retained history,
  tool-call concurrency, cooperative cancellation.
- `@deepseek-ai/dsh-llm` — tool-history/deferred-tool updates, request prefix.
- `@deepseek-ai/dsh-compaction-tool-result-pruner` — 8192-char result-trimming
  behavior (only under compaction pressure).
- `@deepseek-ai/dsh-tool-call-timeout-policy` — enforcement of a tool's declared
  `timeoutMs` (declarative only in the registry otherwise).
- First-party tool plugins (`dsh-tool-fs`, `dsh-tool-bash`, `dsh-tool-web`,
  `dsh-tool-subagent`, …) — the shipped convention for tool-guidance sections.
- The `agent-experience` skill shipped in `@deepseek-ai/dsh-agent-preset/skills/`
  — the harness's own tool/prompt design guidance.
- `dsh-context` (third-party plugin in this profile) — how another extension
  anchors external prompt sections.

This checkout's agent surface: `src/index.ts` (prompt section),
`src/tools.ts` (seven tools, receipts, hints), `src/tool-def.ts` (local
`defineTool` replacement), `src/session-catalog.ts` / `src/host-api.ts` (host
interplay), `tests/tools-receipts.test.mjs` (policy/schema guards).

## 1. How DSH assembles the system prompt

`ctx.systemPrompt` is a registry, and `assemble()` is a cooperative pipeline:

1. Contributions are **named sections with a numeric `order`**, sorted ascending
   (ties by name). Empty sections disappear; `renderPrompt()` joins the rest
   with blank lines.
2. A section's `text` is either a static string or a **function of the assembly
   context** — first-party tool plugins use this to hide guidance whose tool is
   not visible: `({ scope, toolSet }) => ctx.tools.get(name, scope, toolSet)
   === undefined ? '' : '...'`.
3. `interpolate: false` preserves literal `{{…}}`; other sections interpolate
   registered variables (unknown references fail assembly loudly).
4. **Tool schemas are part of the same assembly** even though adapters send them
   as a separate wire field: "what the model is told it can do" is one coherent
   thing.
5. Dynamic **contexts** are separate from sections; they become sourced
   user-role snapshots (e.g. `DSH_SESSION_ID`, runtime cwd, sandbox policy), not
   system-prompt text.

DSH allocates first-party positions centrally (`SECTION_ORDERS`, abridged):

| order | slot | meaning |
|---|---|---|
| −1000 | `HARNESS_IDENTITY` | fixed opener |
| 0 | `DEPLOYMENT_PERSONA_PREFIX` | persona before first-party guidance |
| 500–2900 | `PLAN_POLICY` … `TOOL_SUBAGENT` | first-party policy + tool-guidance bands |
| 3100 | `MCP_SERVERS` | last tool-guidance band (MCP server tools) |
| 5000 | `TOOLS_SDK` | generated tools-SDK guidance |
| 9000 | `DELIVERABLE_FILE_REFERENCES` | deliverable/file references |
| 9900 | `STRUCTURED_OUTPUT` | structured-output guidance |
| 10000/10100 | `HARNESS_SOURCE` / `WEB_SURFACE` | **environment-bearing suffix** |
| 10200 | `DEPLOYMENT_PERSONA_SUFFIX` | deployment suffix, last first-party slot |

External plugins "may use any finite order". The conventions visible in the
installed ecosystem:

- First-party tools register **one short policy section** in their band
  (`tool:read` at `TOOL_READ`, `tool:web_fetch` at `TOOL_WEB_FETCH`, …). The
  section states policy only; behavior lives in the tool description, rules on
  the parameter (`agent-experience`: *say each fact once*).
- Sections are **tool-aware** wherever the tool can be restricted.
- Another third-party extension (`dsh-context`) anchors before
  `HARNESS_IDENTITY` (−1000 offset) and after `DEPLOYMENT_PERSONA_SUFFIX`
  (+1000 offset) for user-configured prefix/suffix text — i.e. offsets from
  named orders are the established extension pattern.

### KV-cache consequences

- Prompt sections and tool schemas are **fixed per-request cost**. They are
  prefix-stable while identity, persona, text, order and the visible schema set
  render identically; a change invalidates reuse from the first changed token.
- Sections placed **before** the environment-bearing suffix stay reusable when
  only the deployment environment changes (source path, Web URL, persona
  suffix).
- Tool results are appended data, resent until compaction; a tool-definition
  change invalidates the request prefix.

## 2. What the model actually receives in this deployment

Captured from a live session (`dsh web`, this plugin linked into the `web`
profile), before the 0.3.3 change:

- The rendered system prompt is **8,390 characters**. It contains the harness
  identity, the deployment persona, the first-party instruction sections, the
  environment suffix — and the `dsh-rdm:downloads` section **as the very last
  block** (after `WEB_SURFACE` and the persona suffix).
- The seven `rdm_*` tools appear as normal tool schemas (name, description,
  JSON-Schema parameters). Their canonical output values are **not** part of
  the prompt and are **not** shown in tool results; the model reads only each
  tool's rendered receipt.

The last-block position contradicts the in-code comment ("directly after the
deployment persona so download routing is read before the main task
instructions"): the persona *prefix* is order `0`, the persona *suffix* is
`10200`. The plugin anchored on the suffix and therefore rendered last.

## 3. Current dsh-rdm agent surface (pre-0.3.3-change inventory)

### Prompt section

| fact | value |
|---|---|
| name | `dsh-rdm:downloads` |
| order | `getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') + 1` = **10201** |
| text | static string, `interpolate: false` |
| size | **111 words / 746 chars** |
| visibility | always rendered; not tool-aware |
| test guard | 70–120 words |

### Tool surface (model-visible schema cost)

Measured with the tests' own metric — `JSON.stringify` of
`{name, description, parameters}` for all seven tools — at **6,925 chars**
(guard: ≤ 7,241). Per tool (description + parameter-schema chars):

| tool | description | parameters | notes |
|---|---:|---:|---|
| `rdm_download` | 187 | 2,107 | 20 parameters incl. `sources`/`sourcePolicy`/`waitSec` |
| `rdm_probe` | 253 | 423 | server facts + recommendation |
| `rdm_tasks` | 251 | 623 | list vs detail by `taskId` |
| `rdm_wait` | 134 | 242 | long-poll |
| `rdm_control` | 326 | 402 | five verbs |
| `rdm_history` | 229 | 443 | recorded telemetry |
| `rdm_search` | 296 | 637 | cross-session records |

Other definition facts:

- `timeoutMs` is **not declared** by any tool. The registry treats it as
  declarative; only `dsh-tool-call-timeout-policy` enforces it, and only for
  tools that declare one. Long calls (`rdm_wait` ≤ 300 s, `rdm_download` with
  `waitSec`) are bounded only by the tool bodies' own cooperative checks and the
  kernel request timeout.
- The local `defineTool` replacement (`src/tool-def.ts`) does not pass
  `deferLoading`. Per the LLM contract, explicitly deferred **baseline** tools
  remain deferred until their first retained addition block — declaring
  `deferLoading` does not by itself make a statically registered tool usable, so
  it is not a usable cost lever for this plugin today.
- Receipts are line-oriented and bounded; canonical JSON stays for programmatic
  callers. The `agent-experience` rules ("describe behavior, not
  implementation"; "parameter rules on the parameter"; "say each fact once")
  are largely followed and enforced by tests (policy-only in descriptions,
  90-word prompt guard, schema-cost guard).

## 4. Workflow: the decision loop vs the actual model surface

The intended loop (`docs/design/0.2.0-agent-native.md` §1) is:

`discover → decide → start → observe → intervene → verify → report`

The tool surface maps cleanly: `rdm_probe` (discover/decide),
`rdm_download` with attached preflight (start), `rdm_wait`/`rdm_tasks`
(observe), `rdm_control` (intervene), `verification`/`rdm_history` (verify),
receipts (report). What the research found is not a missing tool but **a mismatch
between what the canonical value claims and what the model can actually read**,
plus workflow facts that the prompt did not state.

### Findings

**F1 (high, fixed) — section rendered outside the tool-guidance band.**
`10201` put the policy after the environment suffix; the comment described the
opposite intent. Whatever the original plan, it is the only extension policy in
this deployment that renders after the environment facts, and tool guidance is
the harness's own grouping. Fixed in this round (order `MCP_SERVERS + 1`).

**F2 (high, fixed) — section outlived its tools under restriction.**
First-party sections hide themselves when their tool is restricted away
(`ctx.tools.get(name, scope, toolSet) === undefined → ''`). dsh-rdm's static
section kept telling a read-only/plan-mode/subagent agent to call `rdm_*` even
when the mask removed those tools. Fixed: the section is a text function and
renders only while `rdm_download` is admitted for the step.

**F3 (high, fixed) — prompt did not reflect 0.3.3's silent panel actions.**
0.3.3 removed the UI→agent notification. Without a prompt fact, an agent that
saw `running 42%` earlier can act on stale state after the user paused/cancelled/
removed the record from the panel. Fixed: prompt now says the panel actions are
not announced and to re-read `rdm_tasks` before acting on a previously seen
task state.

**F4 (high, fixed) — no consent policy for destructive verbs.**
`rdm_control` described behavior but nothing said the agent should not pause/
cancel/retry/remove on its own initiative. `agent-experience` (§ keep critical
constraints visible) puts this in the system prompt. Fixed.

**F5 (medium, fixed) — multi-source was invisible at policy level.**
0.3.0 shipped `sources`/`sourcePolicy` and `rdm_probe` reports discovered
mirrors, but the prompt never connected them: the model can read `mirrors=N`
and still start a single-host download. Fixed with one clause: pass
`rdm_probe` mirrors as `rdm_download` sources when hedging/failover is wanted.

**F6 (medium, open) — canonical `hint` and rendered receipts drifted apart.**
The model reads only the render. On **success**:

- `rdm_probe` renders a hard-coded `next rdm_download url=…` line even when
  `recommendation.start` is `avoid`/`later`; the canonical `hint` (which does
  say "do not start cleanly" / "start later") is never rendered.
- `rdm_download` renders the generic `next rdm_tasks … | rdm_wait …` line; the
  canonical `hint` with completed/failed/preflight-timeout guidance is never
  rendered.
- `rdm_tasks`, `rdm_wait`, `rdm_control`, `rdm_search`, `rdm_history` append
  `next <hint>` only in error branches; success-path hints are dead values.

The canonical output schema therefore promises a model-visible field that the
renderer drops. Recommended: render the canonical hint on every path that
computes one, or delete the unrendered hint and keep one source of truth; add a
receipt-contract test that the essential recovery/next guidance appears in the
model-visible text.

**F7 (medium, open) — `rdm_history`'s model surface is much smaller than its
description claims.**
`rdm_history` describes "bounded samples/events plus their file paths", and the
receipt test pins a "replay N samples" hint. The render exposes **only** the
summary line, the two JSONL paths, the `range` line and build tags. Samples and
events (the reason `offset`/`limit`/`includeEvents` exist) are in the canonical
value but invisible to the model; changing `offset` only changes the `range`
line. Either render a bounded sample/event page (the design intent of "replay"),
or make the description honest ("summary + paths; JSONL is for programmatic
readers") and stop advertising replay. Add a test that `offset` changes visible
content if paging stays.

**F8 (medium, open) — receipt size vs the 8,192-char pruner.**
The tool-result pruner trims result text over 8,192 chars (head 4,096 + marker +
tail 1,024) **only when compaction pressure triggers**. Defaults are safe
(`rdm_tasks` 20 rows, `rdm_search` 10), but explicit maxima can exceed the
threshold (`rdm_tasks limit=100`, `rdm_search limit=50`). Cheap mitigation:
document the default/max budget in the tool descriptions where not already
stated, and keep the history receipt bounded when F7 is fixed.

**F9 (low, open) — no `timeoutMs` declarations.**
The timeout-policy plugin cannot arm a deadline for tools that declare none.
The bodies check `exec.signal` and the kernel enforces its own request timeouts,
so this is a safety-net gap rather than a known hang. Declaring `timeoutMs`
slightly **above** the tool's internal clamp (e.g. 320 s for `rdm_wait`, and
`waitSec + preflight + margin` for `rdm_download`) would turn a genuinely stuck
call into `Error: tool call timed out after …ms` instead of an open turn.

**F10 (low, open) — `deferLoading` is not a lever here.**
Baseline deferred tools stay unreachable until a retained tool-addition block;
this plugin registers statically. Revisit only if the schema cost approaches the
7,241 guard or DSH adds a supported activation path for statically deferred
tools.

**F11 (info) — the rest of the harness contract mostly helps this plugin.**
Tool-call concurrency defaults to 10, so independent downloads can be started in
one step; `rdm_wait` already accepts up to 20 ids. Results are resent until
compaction, which favors bounded receipts. Tool definitions are fixed cost, so
facts belong in results — the existing design already follows this.

## 5. Compliance audit against `agent-experience`

| guidance | dsh-rdm state (after this round) |
|---|---|
| Start with minimal context | Section is one bounded policy block (~160 words); behavior stays in 7 tool definitions |
| Make discovery explicit | Every tool has a description + parameters; receipts include paths/ids for follow-up |
| Keep critical constraints visible | ✅ consent rule for destructive verbs now in the prompt; tool descriptions state destructive effects |
| Prefer bounded outputs | Defaults bounded; schema guard and receipt tests exist; F7/F8 note the remaining gaps |
| Use locality | Receipts attach preflight facts, telemetry, diagnosis, and `next` hints |
| Evaluate total work | `rdm_wait` long-polls; preflight facts ride on `rdm_download`; F6/F7 would remove wasted calls |
| Delete obvious constraints | Tool descriptions state behavior; parameter rules on parameters |
| Say each fact once | Policy-only in the section (test-enforced); descriptions carry behavior; the one duplicated wait-vs-poll phrase was removed from the `rdm_wait` description in this round |
| Measure the change | Schema-cost guard exists (≤7,241); prompt word guard exists; no per-change token report yet (see P2) |

## 6. Changes landed in this round (0.3.3)

In `src/index.ts` (plus ambient types in `src/types.d.ts` and tests):

1. **Prompt section moved into the tool-guidance band**: order is now
   `getSectionOrder('MCP_SERVERS') + 1` (`3101`), fallback `3101` when the
   harness has no named orders. Rationale: `MCP_SERVERS` is the last first-party
   tool-guidance order; the section now renders with the other tool rules,
   before `TOOLS_SDK`/structured-output/environment suffix. This also keeps it
   out of the cache-sensitive suffix region.
2. **Tool-aware rendering**: the section text is a function and returns `''`
   when `ctx.tools.get('rdm_download', scope, toolSet)` is `undefined`; falls
   back to always-render on harnesses without the registry lookup.
3. **Workflow facts added** (policy only, measured **160 words / 1,045 chars**,
   +49 words vs. the pre-change section): silent panel actions → re-read
   `rdm_tasks`; destructive verbs only on user request; `rdm_probe` mirrors →
   `rdm_download` sources; `retry` added to the control verb list; `rdm_history
   reads back a recorded transfer` replaces the longer implementation sentence.
4. Tests: the policy check now asserts the new workflow facts; the prompt guard
   is now "bounded policy block" (120–200 words) instead of "about 90 words";
   the `apply()` smoke test asserts the section order (`3101`),
   `interpolate: false`, and the visibility toggle.
5. Docs/changelog updated; the research findings F6–F10 are recorded here as
   follow-ups rather than silently changing tool behavior.

Measured after the change: schema cost **6,925 chars** (6,959 before; the only
tool-description change removes the duplicated wait-vs-poll phrase from
`rdm_wait`); prompt section **160 words / 1,045 chars**. A prompt/order change invalidates the
request prefix once; tool parameters and outputs are unchanged.

## 7. Recommended next steps

**P0 (done in this round):** placement, visibility, 0.3.3 workflow facts,
consent rule, mirrored-source policy.

**P1 — model-visible contract repairs (small, testable):**

1. `rdm_probe`: render the canonical hint when `recommendation.start` is
   `avoid`/`later` instead of unconditionally suggesting `rdm_download`.
2. `rdm_download`: render the terminal/failed/preflight-timeout hint (or fold
   it into the existing next line) so the receipt says what to do next.
3. `rdm_history`: render a bounded paged sample/event view (e.g. ≤40 lines,
   `omitted` marker, `offset`/`limit` semantics) **or** correct the description
   and hint and document the JSONL/`rdm_tasks` path; add a paging test.
4. Receipt-contract test: every success value that computes a `hint` must have
   that guidance visible in the rendered content (or the field must be removed).
5. Add the measured first-turn cost table (prompt chars + schema chars) to the
   test output so `agent-experience`'s "measure the change" stays cheap.

**P2 — robustness and future options:**

6. Declare `timeoutMs` on `rdm_wait` and `rdm_download` above their internal
   clamps; add a test asserting the declared deadline exceeds the tool's own
   maximum wait.
7. Document `deferLoading` as deliberately unused here (F10) and revisit if the
   schema cost approaches the guard.
8. Consider stating the parallel-start workflow (`rdm_wait` accepts 20 ids;
   independent downloads can start in one step) in the relevant tool
   descriptions rather than the prompt.
9. Keep monitoring receipt size against the 8,192-char pruner after the F7
   change.

## 8. Reproduction / evidence

```bash
# Model-visible prompt + tool surface sizes (built bundle)
node - <<'EOF'
import('./lib/index.js').then((m) => {
  const fake = { kernelStatus: () => ({}) }
  const tools = m.createRdmTools(fake, null)
  const surface = tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
  console.log('schema chars:', JSON.stringify(surface).length)
  console.log('prompt words:', m.PROMPT_SECTION_TEXT.split(/\s+/).filter(Boolean).length)
  console.log('prompt chars:', m.PROMPT_SECTION_TEXT.length)
})
EOF

# Guards
node tests/tools-receipts.test.mjs
node tests/host-api.test.mjs
```

The live prompt capture used the session's derived-history system message from
`$DSH_HOME/sessions/<workspace>/<session>/session.v4.jsonl.zstd` (decompress and
read the first `system/message`); it contained the `dsh-rdm:downloads` block as
the last section.

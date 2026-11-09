/**
 * Host half of the `dsh-rdm` plugin.
 *
 * Wires the resident RDM kernel service to the three host surfaces:
 *  - seven model-facing `rdm_*` tools ({@link registerRdmTools});
 *  - the review panels' JSON route ({@link registerRdmHostApi});
 *  - one system-prompt section that routes every download through RDM.
 *
 * The kernel starts lazily on first tool/panel use and is stopped when the
 * plugin unloads (`ctx.effect` disposer). One session/workspace catalog is
 * shared by the route and `rdm_search` so both read session titles once.
 *
 * @module dsh-rdm
 */

import { Config, resolveConfig } from './config'
import type { RdmConfig } from './config'
import { registerRdmHostApi } from './host-api'
import { KernelService, toKernelLogger } from './kernel-client'
import { createSessionCatalog } from './session-catalog'
import { registerRdmTools } from './tools'

/** Plugin name used by the Loader row and the diagnostics log. */
export const name = 'dsh-rdm'

/** Host services this plugin requires before `apply` runs. */
export const inject = ['tools', 'connection', 'systemPrompt']

export { Config }

/** Stable name of the prompt section (same name is used across deployments). */
export const PROMPT_SECTION_NAME = 'dsh-rdm:downloads'

/**
 * System-prompt section: download policy, stated once (design §3.1, ~90 words).
 *
 * Tool behavior, return shapes and parameter rules live on the tools
 * themselves; nothing here repeats them.
 */
export const PROMPT_SECTION_TEXT = `## File downloads — use the rdm_* tools

Use the rdm_* tools for every HTTP(S) file download instead of shell downloaders (curl/wget/PowerShell). When the source is unknown, rdm_probe first; rdm_download returns a live task id, rdm_control pauses/resumes/cancels/removes it, and rdm_wait long-polls instead of a tight loop. rdm_search finds existing download records by name or id across sessions. The kernel records per-sample telemetry to disk; read it back with rdm_history to replay a transfer. Their receipts are structured key=value lines — quote them and do not parse human prose; "-" means unknown. Downloads persist across turns, so check rdm_tasks before re-downloading. Use a shell downloader only when the user explicitly demands one.`

// Re-export the tool surface, protocol pin and pure receipt helpers so tests
// and docs can inspect them from the built host bundle (`lib/index.js`).
export { createRdmTools, registerRdmTools } from './tools'
export {
  formatBytes,
  formatClock,
  formatDurationMs,
  formatDurationSecs,
  formatPercent,
  formatProgressPair,
  formatRate,
  renderControlReceipt,
  renderDownloadReceipt,
  renderHistoryReceipt,
  renderProbeReceipt,
  renderSearchReceipt,
  renderTaskDetailReceipt,
  renderTaskEventLine,
  renderTaskRecord,
  renderTasksListReceipt,
  renderWaitReceipt,
  sessionIdFromExec,
} from './tools'
export { handleRdmApiRequest, registerRdmHostApi } from './host-api'
export { SessionCatalog, createSessionCatalog, resolveTaskOpenPath } from './session-catalog'
export {
  KernelError,
  normalizeAggregate,
  normalizeServerFacts,
  normalizeTaskDetail,
  normalizeTaskHistory,
  normalizeTaskView,
  protocolMismatchMessage,
} from './kernel-client'
export { PROTOCOL_VERSION } from './protocol'

/**
 * Register the plugin's prompt section. The `systemPrompt` service is declared
 * in {@link inject}, so Cordis only runs `apply` when it exists; place the
 * section directly after the deployment persona so download routing is read
 * before the main task instructions.
 */
function registerPromptSection(ctx: HostContext): void {
  const systemPrompt = ctx.systemPrompt as HostSystemPromptService | undefined
  if (
    systemPrompt === undefined ||
    systemPrompt === null ||
    typeof systemPrompt.section !== 'function'
  ) {
    return
  }
  const baseOrder =
    typeof systemPrompt.getSectionOrder === 'function'
      ? systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')
      : Number.NaN
  const order = Number.isFinite(baseOrder) ? baseOrder + 1 : 1_000
  ctx.effect(
    () =>
      systemPrompt.section({
        name: PROMPT_SECTION_NAME,
        order,
        interpolate: false,
        text: PROMPT_SECTION_TEXT,
      }),
    'dsh-rdm: downloads prompt section',
  )
}

/**
 * Plugin entry point.
 *
 * @param ctx - Host plugin context (provides `tools` and `connection`).
 * @param config - Validated Loader row config (defaults applied here as well).
 */
export function apply(ctx: HostContext, config?: RdmConfig): void {
  const resolved = resolveConfig(config)
  const logger = toKernelLogger(ctx.logger)
  const kernel = new KernelService({ config: resolved, logger: ctx.logger })
  // One catalog instance for both consumers (route + rdm_search), so session
  // titles and workspace labels come from the same 15 s/30 s caches.
  const catalog = createSessionCatalog(ctx)

  // Own the child process for the plugin's lifetime: kill it on unload.
  ctx.effect(
    () => () => {
      void kernel.stop()
    },
    'dsh-rdm: kernel lifecycle',
  )

  registerRdmTools(ctx, kernel, catalog)
  registerRdmHostApi(ctx, kernel, catalog)
  registerPromptSection(ctx)

  if (!resolved.startOnDemand) {
    void kernel.prewarm().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn(`eager RDM kernel start failed (tools will retry on demand): ${message}`)
    })
  }
  logger.debug(
    `dsh-rdm ready (kernel: ${kernel.binaryPath}, data: ${kernel.dataDir}, startOnDemand: ${resolved.startOnDemand})`,
  )
}

/**
 * Host half of the `dsh-rdm` plugin.
 *
 * Wires the resident RDM kernel service to the three host surfaces:
 *  - five model-facing `rdm_*` tools ({@link registerRdmTools});
 *  - the sidebar panel's JSON route ({@link registerRdmHostApi});
 *  - one system-prompt section that routes every download through RDM.
 *
 * The kernel starts lazily on first tool/panel use and is stopped when the
 * plugin unloads (`ctx.effect` disposer).
 *
 * @module dsh-rdm
 */

import { Config, resolveConfig } from './config'
import type { RdmConfig } from './config'
import { registerRdmHostApi } from './host-api'
import { KernelService, toKernelLogger } from './kernel-client'
import { registerRdmTools } from './tools'

/** Plugin name used by the Loader row and the diagnostics log. */
export const name = 'dsh-rdm'

/** Host services this plugin requires before `apply` runs. */
export const inject = ['tools', 'connection', 'systemPrompt']

export { Config }

/** Stable name of the prompt section (same name is used across deployments). */
export const PROMPT_SECTION_NAME = 'dsh-rdm:downloads'

/**
 * System-prompt section: make RDM the default download path for the model.
 * Kept short (prompt space is shared) but explicit about the fallback rule.
 */
export const PROMPT_SECTION_TEXT = `## File downloads — use the rdm_* tools

Use the \`rdm_*\` tools for every file download (assets, release binaries, archives, datasets, media). They drive the resident RDM download kernel: it stays warm between calls (no per-download CLI start-up) and provides multi-connection segmented transfers, resume/pause/cancel/retry, retries with backoff, bandwidth limits, and optional SHA-256 verification.

- \`rdm_download\` — start an HTTP(S) download and return its task id (pass \`waitSec\` to block up to 300 s).
- \`rdm_probe\` — inspect a URL first: redirects, final file name, size, content type, range/ resume support.
- \`rdm_tasks\` — kernel status, task list, or one task with recent diagnostic events.
- \`rdm_wait\` — block until tasks settle (≤ 300 s) instead of polling in a shell loop.
- \`rdm_control\` — pause, resume, cancel, retry (restart from zero) or remove a task.

Downloads persist across turns. Use \`bash\` with \`curl\`/\`wget\`/PowerShell only when the user explicitly demands a shell download; use ordinary shell commands for non-download work and non-HTTP(S) sources.`

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

  // Own the child process for the plugin's lifetime: kill it on unload.
  ctx.effect(
    () => () => {
      void kernel.stop()
    },
    'dsh-rdm: kernel lifecycle',
  )

  registerRdmTools(ctx, kernel)
  registerRdmHostApi(ctx, kernel)
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

// The evidence drawer: one download's record, expanded.
//
// Order is fixed by docs/design/0.2.0-agent-native.md §6.2: request chain,
// full server facts, timing, telemetry, verification, destination, resume
// state, bounded event log. The two-column arrangement is presentational only
// (left: the request's own trace; right: what the server and kernel reported
// and how it ended).
//
// Rules:
//   * unknown facts render `—`, never a fabricated value and never a row of
//     ten dashes — a block whose source is absent renders one sentence instead;
//   * raw kernel messages appear as their own code row, never appended to a
//     localized label;
//   * the kernel's own trailing windows are listed with their sampling note;
//   * actions are low-risk only: copy.

import React, { useEffect, useRef, useState } from 'react'
import { errorText } from './api'
import { copyText } from './clipboard'
import type { DetailState } from './data'
import { eventDetail, formatBytes, formatClock, formatDuration, formatElapsed, formatSpeed, hashPrefix, shortHash } from './format'
import { taskPath } from './model'
import { LiveRegion, Note, Seal } from './primitives'
import type { MirrorSource, SourceView, TFunction, TaskDetail, TaskEvent, TaskView } from './types'

/** One label/value pair in a fact grid. */
function Fact({ label, value, mono = false, wide = false }: { label: string; value: string; mono?: boolean; wide?: boolean }) {
  return (
    <div className="rdm2-fact" data-wide={wide ? 'true' : 'false'}>
      <dt className="rdm2-fact-label">{label}</dt>
      <dd className={mono ? 'rdm2-fact-value rdm2-mono' : 'rdm2-fact-value'}>{value}</dd>
    </div>
  )
}

/** One titled block of facts. */
function Section({ title, children }: { title: string; children: unknown }) {
  return (
    <section className="rdm2-section">
      <h4 className="rdm2-section-title">{title}</h4>
      {children}
    </section>
  )
}

/** A block whose source is genuinely absent (old host / no probe). */
function Absent({ text }: { text: string }) {
  return <Note>{text}</Note>
}

/** A millisecond duration as readable elapsed copy (`84ms`, `2m 23s`). */
function ms(value: number | null): string {
  if (value === null) return '—'
  return formatElapsed(value)
}

export interface EvidenceDrawerProps {
  t: TFunction
  task: TaskView
  detail: DetailState
  /** Retry a failed detail load. */
  onRetry: () => void
  /** DOM id owned by the row for `aria-controls`. */
  id: string
}

type CopyKind = 'path' | 'hash' | 'id' | null

/** The evidence drawer for one record. */
export function EvidenceDrawer(props: EvidenceDrawerProps) {
  const { t, task, detail, onRetry } = props
  const [copied, setCopied] = useState<CopyKind>(null)
  const [copyFailed, setCopyFailed] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    return () => {
      if (resetTimer.current !== undefined) clearTimeout(resetTimer.current)
    }
  }, [])

  // A different record (or a closing drawer) drops transient feedback.
  useEffect(() => {
    setCopied(null)
    setCopyFailed(false)
  }, [task.id])

  const flash = (kind: CopyKind, ok: boolean): void => {
    if (resetTimer.current !== undefined) clearTimeout(resetTimer.current)
    setCopied(ok ? kind : null)
    setCopyFailed(!ok)
    resetTimer.current = setTimeout(() => {
      setCopied(null)
      setCopyFailed(false)
    }, 2000)
  }

  const path = taskPath(task)
  const hash = task.sha256 ?? task.expectedSha256
  const value = detail.value
  const full: TaskDetail | null = value?.detail ?? null
  const events: TaskEvent[] = value?.events ?? []
  const verification = full?.verification ?? null
  const expected = verification?.expectedSha256 ?? task.expectedSha256
  const actual = verification?.sha256 ?? task.sha256
  const verdict = verification?.verified ?? task.verified

  const copyLabel = copied === 'path' ? t('record.copiedPath') : copied === 'hash' ? t('record.copiedHash') : copied === 'id' ? t('record.idCopied') : copyFailed ? t('common.copyFailed') : ''
  const sealHash = hashPrefix(actual ?? expected)

  const server = full?.server ?? null
  const telemetry = full?.telemetry ?? null
  const target = full?.target ?? null
  const timing = full?.timing ?? null
  const resumeState = full?.resumeState ?? null
  // Multi-source facts (0.3.0). An old host omits them, so every read falls
  // back to the task view and finally to an honest empty state.
  const detailSources = full?.sources ?? []
  const sources: SourceView[] = detailSources.length > 0 ? detailSources : task.sources
  const sourcePolicy = full?.sourcePolicy ?? task.sourcePolicy
  const selectedSource = full?.selectedSource ?? task.selectedSource
  const sourceSwitches = full?.sourceSwitches ?? task.sourceSwitches
  const selectedHost =
    selectedSource === null ? null : sources.find((source) => source.id === selectedSource)?.host ?? null

  return (
    <div className="rdm2-drawer" id={props.id} role="region" aria-label={t('drawer.regionLabel', { name: task.fileName || task.id })}>
      <div className="rdm2-drawer-actions">
        {path !== null ? (
          <button
            type="button"
            className="rdm2-button"
            data-rdm2-action="copy-path"
            onClick={() => {
              void copyText(path).then((ok) => flash('path', ok))
            }}
          >
            {t('record.copyPath')}
          </button>
        ) : null}
        {hash !== null ? (
          <button
            type="button"
            className="rdm2-button"
            data-rdm2-action="copy-hash"
            onClick={() => {
              void copyText(hash).then((ok) => flash('hash', ok))
            }}
          >
            {t('record.copyHash')}
          </button>
        ) : null}
        <button
          type="button"
          className="rdm2-button"
          data-rdm2-action="copy-id"
          onClick={() => {
            void copyText(task.id).then((ok) => flash('id', ok))
          }}
        >
          {t('record.copyId')}
        </button>
        {copyLabel !== '' ? <span className="rdm2-copy-flash">{copyLabel}</span> : null}
        <LiveRegion message={copyLabel} />
      </div>

      {detail.loading && value === null ? <Note>{t('drawer.loading')}</Note> : null}
      {detail.error !== null ? (
        <div className="rdm2-drawer-error" role="alert">
          <span>{errorText(t, detail.error)}</span>
          <button type="button" className="rdm2-button" data-rdm2-action="retry-detail" onClick={onRetry}>
            {t('drawer.retry')}
          </button>
        </div>
      ) : null}

      <div className="rdm2-drawer-cols">
        <div className="rdm2-drawer-col">
          <Section title={t('drawer.request')}>
            <dl className="rdm2-facts">
              <Fact label={t('facts.url')} value={task.url || '—'} mono wide />
              {task.finalUrl !== null && task.finalUrl !== task.url ? (
                <Fact label={t('facts.finalUrl')} value={task.finalUrl} mono wide />
              ) : null}
              {server?.redirects !== undefined && server.redirects.length > 0 ? (
                <Fact
                  label={t('facts.redirects')}
                  value={server.redirects.map((hop) => `${hop.status ?? '—'} ${hop.url}`).join(' → ')}
                  mono
                  wide
                />
              ) : (
                <Fact label={t('facts.redirects')} value={t('drawer.none')} />
              )}
              <Fact label={t('facts.session')} value={task.sessionId ?? t('group.unattributed')} mono wide />
              <Fact label={t('facts.taskId')} value={task.id} mono wide />
            </dl>
          </Section>

          <Section title={t('drawer.timing')}>
            {timing === null && server?.timing == null ? (
              <Absent text={t('drawer.notRecorded')} />
            ) : (
              <dl className="rdm2-facts">
                <Fact label={t('facts.elapsed')} value={ms(task.elapsedMs)} />
                <Fact label={t('facts.probeMs')} value={ms(timing?.probeMs ?? server?.timing?.probeMs ?? null)} />
                <Fact label={t('facts.ttfbMs')} value={ms(server?.timing?.ttfbMs ?? null)} />
                <Fact label={t('facts.queuedMs')} value={ms(timing?.queuedMs ?? null)} />
                <Fact label={t('facts.transferMs')} value={ms(timing?.transferMs ?? null)} />
                <Fact label={t('facts.finalizeMs')} value={ms(timing?.finalizeMs ?? null)} />
                <Fact label={t('facts.started')} value={formatClock(task.startedAt)} />
                <Fact label={t('facts.finished')} value={formatClock(task.finishedAt)} />
              </dl>
            )}
          </Section>

          <Section title={t('drawer.verification')}>
            <dl className="rdm2-facts">
              <Fact label={t('facts.expectedSha256')} value={expected === null ? '—' : (shortHash(expected) ?? '—')} mono wide />
              <Fact label={t('facts.actualSha256')} value={actual === null ? '—' : (shortHash(actual) ?? '—')} mono wide />
              <Fact
                label={t('facts.verdict')}
                value={verdict === null ? t('drawer.notCompared') : verdict ? t('facts.verified') : t('facts.mismatch')}
              />
              <Fact label={t('facts.serverChecksum')} value={serverChecksumText(verification?.serverChecksums ?? server?.checksum ?? null)} mono wide />
            </dl>
            {verdict !== null && sealHash !== null ? (
              <Seal
                seal={{
                  state: verdict ? 'verified' : 'mismatch',
                  hash: sealHash,
                  label: verdict ? t('seal.verified', { hash: sealHash }) : t('seal.mismatch', { hash: sealHash }),
                }}
              />
            ) : null}
          </Section>

          <Section title={t('drawer.destination')}>
            <dl className="rdm2-facts">
              <Fact label={t('facts.dir')} value={target?.dir ?? task.dir ?? '—'} mono wide />
              <Fact label={t('facts.path')} value={target?.path ?? task.path ?? '—'} mono wide />
              <Fact label={t('facts.part')} value={target?.part ?? '—'} mono wide />
              <Fact label={t('facts.resumeStateFile')} value={target?.resumeState ?? '—'} mono wide />
              <Fact label={t('facts.size')} value={formatBytes(task.total)} />
              <Fact label={t('facts.downloaded')} value={formatBytes(task.downloaded)} />
            </dl>
          </Section>

          <Section title={t('drawer.resume')}>
            <dl className="rdm2-facts">
              <Fact label={t('facts.resumeSafety')} value={task.resumeSafety === null ? '—' : t(`resume.safety.${task.resumeSafety}`)} />
              <Fact label={t('facts.rangeSupported')} value={task.rangeSupported === null ? '—' : task.rangeSupported ? t('facts.yes') : t('facts.no')} />
              <Fact label={t('facts.chunksDone')} value={resumeState === null || resumeState.chunksDone === null ? '—' : String(resumeState.chunksDone)} />
              <Fact label={t('facts.bytesDone')} value={resumeState === null ? '—' : formatBytes(resumeState.bytesDone)} />
              <Fact label={t('facts.resumedChunks')} value={task.resumedChunks === null ? '—' : String(task.resumedChunks)} />
              <Fact label={t('facts.resumedBytes')} value={resumeState === null ? '—' : formatBytes(resumeState.resumedBytes)} />
              <Fact
                label={t('facts.validatorsMatched')}
                value={resumeState === null || resumeState.validatorsMatched === null ? '—' : resumeState.validatorsMatched ? t('facts.yes') : t('facts.no')}
              />
              <Fact label={t('facts.workers')} value={task.activeWorkers === null ? '—' : String(task.activeWorkers)} />
              <Fact label={t('facts.workersTarget')} value={task.targetWorkers === null ? '—' : String(task.targetWorkers)} />
              <Fact label={t('facts.workersRequested')} value={task.requestedConnections === null ? '—' : String(task.requestedConnections)} />
              <Fact label={t('facts.workersMax')} value={task.maxConnections === null ? '—' : String(task.maxConnections)} />
              <Fact label={t('facts.peakWorkers')} value={task.peakWorkers === null ? '—' : String(task.peakWorkers)} />
              <Fact label={t('facts.chunkSize')} value={task.chunkSize === null ? '—' : formatBytes(task.chunkSize)} />
              <Fact label={t('facts.retries')} value={task.retries === null ? '—' : String(task.retries)} />
            </dl>
          </Section>

          <Section title={t('drawer.sources')}>
            {sourcePolicy === null && sources.length === 0 ? (
              <Absent text={t('drawer.notRecorded')} />
            ) : (
              <>
                <dl className="rdm2-facts">
                  <Fact
                    label={t('facts.sourcePolicy')}
                    value={sourcePolicy === null ? '—' : sourceLabel(t, 'source.policy', sourcePolicy)}
                  />
                  <Fact
                    label={t('facts.selectedSource')}
                    value={selectedHost !== null && selectedHost !== '' ? selectedHost : selectedSource === null ? '—' : String(selectedSource)}
                    mono
                  />
                  <Fact label={t('facts.sourceSwitches')} value={sourceSwitches === null ? '—' : String(sourceSwitches)} />
                  <Fact label={t('facts.sourceCount')} value={String(sources.length)} />
                </dl>
                {sources.length > 0 ? (
                  <ul className="rdm2-sources" aria-label={t('drawer.sources')}>
                    {sources.map((source) => (
                      <li className="rdm2-source" key={`${source.id}:${source.url}`} data-state={source.state}>
                        <span className="rdm2-source-host rdm2-mono">{source.host !== '' ? source.host : '—'}</span>
                        <span className="rdm2-source-meta">
                          {[
                            sourceLabel(t, 'source.state', source.state),
                            sourceLabel(t, 'source.role', source.role),
                            source.active ? t('facts.sourceSelected') : '',
                            formatBytes(source.bytes),
                            formatSpeed(source.bps),
                          ]
                            .filter((part) => part !== '')
                            .join('   ')}
                        </span>
                        {source.lastError !== null && source.lastError !== '' ? (
                          <span className="rdm2-source-error">{source.lastError}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </Section>
        </div>

        <div className="rdm2-drawer-col">
          <Section title={t('drawer.server')}>
            {server === null ? (
              <Absent text={t('drawer.notRecorded')} />
            ) : (
              <dl className="rdm2-facts">
                <Fact label={t('facts.status')} value={server.status === null ? '—' : String(server.status)} />
                <Fact label={t('facts.http')} value={server.httpVersion ?? '—'} mono />
                <Fact label={t('facts.host')} value={server.host ?? '—'} mono />
                <Fact label={t('facts.contentType')} value={server.contentType ?? '—'} mono />
                <Fact label={t('facts.contentEncoding')} value={server.contentEncoding ?? '—'} mono />
                <Fact label={t('facts.fileNameSource')} value={server.fileNameSource ?? '—'} />
                <Fact label={t('facts.signedUrl')} value={server.signedUrl?.state ?? '—'} />
                <Fact label={t('facts.tls')} value={server.tls?.state ?? '—'} />
                <Fact label={t('facts.rateLimit')} value={rateLimitText(server.rateLimit, t)} wide />
                <Fact label={t('facts.mirrors')} value={mirrorText(server.mirrors, t)} wide />
              </dl>
            )}
          </Section>

          <Section title={t('drawer.telemetry')}>
            {telemetry === null ? (
              <Absent text={t('drawer.notRecorded')} />
            ) : (
              <>
                <dl className="rdm2-facts">
                  <Fact label={t('facts.window1')} value={formatSpeed(telemetry.windows.w1)} />
                  <Fact label={t('facts.window5')} value={formatSpeed(telemetry.windows.w5)} />
                  <Fact label={t('facts.window30')} value={formatSpeed(telemetry.windows.w30)} />
                  <Fact label={t('facts.window300')} value={formatSpeed(telemetry.windows.w300)} />
                  <Fact label={t('facts.peak')} value={formatSpeed(telemetry.peakBps)} />
                  <Fact label={t('facts.average')} value={formatSpeed(telemetry.avgBps)} />
                  <Fact label={t('facts.stalled')} value={telemetry.stalledMs === null ? '—' : formatDuration(telemetry.stalledMs / 1000)} />
                  <Fact label={t('facts.trend')} value={telemetry.trend === null ? '—' : t(`trend.${telemetry.trend}`)} />
                  <Fact label={t('facts.etaConfidence')} value={telemetry.etaConfidence === null ? '—' : t(`confidence.${telemetry.etaConfidence}`)} />
                  <Fact label={t('facts.samples')} value={telemetry.samples === null ? '—' : String(telemetry.samples)} />
                </dl>
                <Note>{t('drawer.sampledNote')}</Note>
              </>
            )}
          </Section>

          <Section title={t('drawer.risk')}>
            {server === null ? (
              <Absent text={t('drawer.notRecorded')} />
            ) : (
              <>
                {server.warnings.length > 0 ? (
                  <p className="rdm2-warning-line">{server.warnings.map((warning) => t(`warning.${warning}`)).join('   ')}</p>
                ) : (
                  <Note>{t('drawer.noWarnings')}</Note>
                )}
                <dl className="rdm2-facts">
                  <Fact label={t('facts.signedState')} value={server.signedUrl?.state ?? '—'} />
                  <Fact
                    label={t('facts.signedExpires')}
                    value={server.signedUrl === null || server.signedUrl.expiresInSecs === null ? '—' : formatDuration(server.signedUrl.expiresInSecs)}
                  />
                  <Fact label={t('facts.tlsState')} value={server.tls?.state ?? '—'} />
                  <Fact label={t('facts.tlsNotAfter')} value={server.tls === null || server.tls.notAfter === null ? '—' : formatClock(server.tls.notAfter)} />
                  <Fact label={t('facts.tlsIssuer')} value={server.tls?.issuer ?? '—'} />
                  <Fact
                    label={t('facts.recommendation')}
                    value={server.recommendation === null || server.recommendation.start === null
                      ? '—'
                      : `${server.recommendation.start} / ${server.recommendation.connections ?? '—'} / ${server.recommendation.reason ?? ''}`}
                    wide
                  />
                  <Fact label={t('facts.origin')} value={originText(server.origin, t)} wide />
                </dl>
              </>
            )}
          </Section>

          <Section title={t('drawer.diagnosis')}>
            {full === null || full.diagnosis.length === 0 ? (
              <Absent text={t('drawer.noDiagnosis')} />
            ) : (
              <ul className="rdm2-diagnosis">
                {full.diagnosis.map((entry, index) => (
                  <li key={`${entry.code}:${index}`} className="rdm2-diagnosis-item">
                    <code className="rdm2-mono rdm2-diagnosis-code">{entry.code}</code>
                    <span className="rdm2-diagnosis-message">{entry.message || t('drawer.noMessage')}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={t('drawer.events')}>
            {detail.loading && value === null ? (
              <Note>{t('drawer.eventsLoading')}</Note>
            ) : events.length === 0 ? (
              <Note>{t('drawer.eventsEmpty')}</Note>
            ) : (
              <ol className="rdm2-events">
                {events.slice(0, 24).map((event) => (
                  <li className="rdm2-event" key={`${event.seq}:${event.at}`}>
                    <span className="rdm2-event-time rdm2-mono">{formatClock(event.at)}</span>
                    <span className="rdm2-event-kind rdm2-mono">{event.kind}</span>
                    <span className="rdm2-event-text">{eventDetail(event) || '—'}</span>
                  </li>
                ))}
              </ol>
            )}
          </Section>
        </div>
      </div>
    </div>
  )
}

/** Localized source vocabulary value, falling back to the raw kernel token. */
function sourceLabel(t: TFunction, prefix: 'source.policy' | 'source.state' | 'source.role', value: string): string {
  const key = `${prefix}.${value}`
  const localized = t(key)
  return localized === key ? value : localized
}

/** Compact mirror list for the server section: hosts plus a hidden count. */
function mirrorText(mirrors: MirrorSource[], t: TFunction): string {
  if (mirrors.length === 0) return '—'
  const shown = mirrors.slice(0, 3)
  const hosts = shown
    .map((mirror) => {
      try {
        return new URL(mirror.url).host
      } catch {
        return ''
      }
    })
    .filter((host) => host !== '')
  const hidden = mirrors.length - shown.length
  const text = hosts.join('   ')
  if (hidden > 0) return text === '' ? t('drawer.mirrorMore', { n: hidden }) : `${text}   ${t('drawer.mirrorMore', { n: hidden })}`
  return text === '' ? String(mirrors.length) : text
}

function rateLimitText(rateLimit: { limit: number | null; remaining: number | null; retryAfterSecs: number | null } | null, t: TFunction): string {
  if (rateLimit === null) return '—'
  if (rateLimit.remaining === null && rateLimit.limit === null && rateLimit.retryAfterSecs === null) return '—'
  const parts: string[] = []
  if (rateLimit.remaining !== null) parts.push(t('facts.remaining', { n: rateLimit.remaining }))
  if (rateLimit.limit !== null) parts.push(t('facts.limit', { n: rateLimit.limit }))
  if (rateLimit.retryAfterSecs !== null) parts.push(t('facts.retryAfter', { n: rateLimit.retryAfterSecs }))
  return parts.join('   ')
}

function serverChecksumText(checksums: { digest: string | null; contentMd5: string | null; sha256: string | null } | null): string {
  if (checksums === null) return '—'
  const parts: string[] = []
  if (checksums.sha256 !== null) parts.push(`sha256 ${shortHash(checksums.sha256)}`)
  if (checksums.digest !== null) parts.push(`digest ${shortHash(checksums.digest)}`)
  if (checksums.contentMd5 !== null) parts.push(`md5 ${shortHash(checksums.contentMd5)}`)
  return parts.length === 0 ? '—' : parts.join('   ')
}

function originText(
  origin: { known: boolean | null; attempts: number | null; completed: number | null; medianBps: number | null; bestBps: number | null; lastError: string | null } | null,
  t: TFunction,
): string {
  if (origin === null) return '—'
  if (origin.known === false) return t('facts.originUnknown')
  const parts: string[] = []
  if (origin.attempts !== null) parts.push(t('facts.originAttempts', { n: origin.attempts }))
  if (origin.completed !== null) parts.push(t('facts.originCompleted', { n: origin.completed }))
  if (origin.medianBps !== null) parts.push(`${t('facts.originMedian')} ${formatSpeed(origin.medianBps)}`)
  if (origin.bestBps !== null) parts.push(`${t('facts.originBest')} ${formatSpeed(origin.bestBps)}`)
  if (origin.lastError !== null) parts.push(`${t('facts.originLastError')} ${origin.lastError}`)
  return parts.length === 0 ? '—' : parts.join('   ')
}

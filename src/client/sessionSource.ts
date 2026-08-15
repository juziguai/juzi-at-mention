/**
 * The '@' session source: a second trigger group listing this workspace's
 * other sessions by title (current and blank sessions are excluded). Picking a
 * row lands a canonical `@[label](dsh-session:…)` plain-text mention; the Host
 * rewrites it to readable `@label` text and injects a read-only snapshot of
 * the referenced session before the step runs. Pure factory over injected
 * deps: the browser bundle wires the real sessions service, tests wire stubs.
 */
import type { InputTriggerCandidate, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { ISessions } from '@deepseek-ai/dsh-client-runtime/client'

declare module '@deepseek-ai/dsh-client-ui-input-trigger/client' {
  interface InputTriggerCandidate {
    /** Source-owned stable value when the visible name is only a display label. */
    readonly value?: string
  }
}

/** Owner source name (the menu group label; unique per '@' trigger). */
export const SESSION_SOURCE_NAME = 'at-session'

/** Design cap on visible session rows. */
export const MAX_SESSION_CANDIDATES = 12

/** The minimal session-list row shape this source reads. */
interface SessionRow {
  readonly id: string
  readonly title?: string
  readonly displayTitle: string
  readonly cwd?: string
  readonly running: boolean
  readonly blank: boolean
  readonly updatedAt: number
}

/** The minimal session-list snapshot shape this source reads. */
interface SessionListSnapshot {
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, SessionRow | undefined>>
  readonly current?: string
}

/** Everything the source needs that the browser bundle supplies (tests stub). */
export interface AtSessionSourceDeps {
  sessions: ISessions
}

/** Canonical `dsh-session:<base64url(JSON.stringify(id))>` URI (mirrors Host). */
function encodeSessionReferenceUri(sessionId: string): string {
  const json = JSON.stringify(sessionId)
  const base64 = btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
  return `dsh-session:${base64}`
}

/** Render the canonical `@[label](uri)` mention the Host parser recognizes. */
function formatSessionMention(sessionId: string, label: string): string {
  const escaped = label.replace(/[\\\]]/gu, (match) => `\\${match}`)
  return `@[${escaped}](${encodeSessionReferenceUri(sessionId)})`
}

/** Working-directory affinity rank: same cwd, then cwd-less, then other cwd. */
function rank(cwd: string | undefined, target: string | undefined): number {
  if (cwd !== undefined && target !== undefined && cwd === target) return 0
  if (cwd === undefined) return 1
  return 2
}

/** Case-insensitive filter over the durable title, id, and cwd. */
function matches(row: SessionRow, needle: string): boolean {
  return row.displayTitle.toLowerCase().includes(needle)
    || row.id.toLowerCase().includes(needle)
    || row.cwd?.toLowerCase().includes(needle) === true
}

/**
 * Build the '@' session source over the injected sessions service.
 * @param deps - the live sessions service face.
 * @returns the source to register with `inputTriggers.registerSource`.
 */
export function createAtSessionSource(deps: AtSessionSourceDeps): InputTriggerSource {
  const { sessions } = deps
  return {
    trigger: '@',
    name: SESSION_SOURCE_NAME,
    order: -1,
    async candidates(session, { query, signal }) {
      const snapshot = sessions.list.getSnapshot() as unknown as SessionListSnapshot
      if (signal.aborted) return []
      const current = session.sessionId as string
      const targetCwd = snapshot.byId[current]?.cwd
      const needle = query.toLowerCase()
      const rows = snapshot.ids
        .map((id) => snapshot.byId[id])
        .filter((row): row is SessionRow => row !== undefined && row.id !== current && !row.blank)
      const filtered = needle === '' ? rows : rows.filter((row) => matches(row, needle))
      const ranked = filtered
        .slice()
        .sort((a, b) => rank(a.cwd, targetCwd) - rank(b.cwd, targetCwd) || b.updatedAt - a.updatedAt)
      return ranked.slice(0, MAX_SESSION_CANDIDATES).map((row): InputTriggerCandidate => ({
        name: row.displayTitle,
        value: row.id,
        description: row.displayTitle === row.id ? (row.cwd ?? undefined) : row.id,
        icon: row.running ? '🟢' : '💬',
      }))
    },
    onPick({ candidate }) {
      const id = candidate.value
      if (id === undefined) return undefined
      return { text: `${formatSessionMention(id, candidate.name)} ` }
    },
  }
}

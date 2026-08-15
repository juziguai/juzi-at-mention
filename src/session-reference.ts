/**
 * Host-side @session reference marker: recognizes the canonical
 * `@[label](dsh-session:…)` mentions the browser picker lands, rewrites them
 * to readable `@label` text, and — through the harness's own
 * SessionReferenceResolver — injects a bounded, read-only snapshot of each
 * referenced session's conversation so a fresh session can catch up on what
 * the referenced sessions did. Only `source.kind === 'user'` text can produce
 * references, so injected text cannot forge the gesture.
 */
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { parseSessionReferenceText, SessionReferenceResolver } from '@deepseek-ai/dsh-session-reference'
import type { SessionReferenceInput } from '@deepseek-ai/dsh-session-reference'

/** The user-message source kind this boundary scans (external text cannot forge it). */
const USER_SOURCE_KIND = 'user'

/**
 * The `agent/pre-step` listener body for session references: collect the
 * claimed user mentions, normalize the downstream batch's readable text, then
 * ask the resolver to snapshot the referenced sessions. Extracted so the
 * boundary logic is unit-testable without an assembled agent scope.
 * @param agent - the addressed agent (its id rejects self-references).
 * @param resolver - the harness session-reference resolver (mounted by this plugin).
 * @param messages - the claimed messages (the user's own words).
 * @param signal - caller lifetime.
 * @param next - the downstream waterfall.
 * @returns the decision with readable text and the snapshot injection appended.
 */
export async function sessionReferencePreStep(
  agent: Agent,
  resolver: SessionReferenceResolver,
  messages: readonly UserMessage[],
  signal: AbortSignal,
  next: () => Promise<PreStepDecision>,
): Promise<PreStepDecision> {
  const decision = await next()
  if (decision.kind === 'reject') return decision

  // Collect references from the claimed user messages only (cannot be forged).
  const references: SessionReferenceInput[] = []
  let found = false
  for (const message of messages) {
    if (message.source.kind !== USER_SOURCE_KIND) continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      const parsed = parseSessionReferenceText(block.text)
      if (parsed.references.length > 0) {
        found = true
        references.push(...parsed.references)
      }
    }
  }
  if (!found) return decision

  // Normalize the downstream batch: readable `@label` text in place of the URI.
  const normalized = decision.messages.map((message) => {
    if (message.source.kind !== USER_SOURCE_KIND) return message
    let changed = false
    const content = message.content.map((block) => {
      if (block.type !== 'text') return block
      const parsed = parseSessionReferenceText(block.text)
      if (parsed.text !== block.text) changed = true
      return parsed.text === block.text ? block : { ...block, text: parsed.text }
    })
    return changed ? { ...message, content } : message
  })

  // `prepare` reads the referenced surfaces and returns a bounded, untrusted
  // snapshot message. Its `content` argument is a carry-through clone; the
  // readable text already lives in `normalized`.
  const textBlocks = normalized.flatMap((message) => message.content).filter((block) => block.type === 'text')
  try {
    const prepared = await resolver.prepare(agent, textBlocks, references, signal)
    const extra = prepared.additionalContext
    if (extra === undefined) return { kind: 'enter', messages: normalized }
    return { kind: 'enter', messages: [...normalized, extra] }
  } catch (error) {
    // Degrade gracefully: keep the readable @label text, drop the snapshot.
    console.error('[juzi-at-mention] session-reference prepare failed:', error)
    return { kind: 'enter', messages: normalized }
  }
}

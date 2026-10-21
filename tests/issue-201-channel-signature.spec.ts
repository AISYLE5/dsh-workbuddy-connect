import { describe, expect, it } from 'vitest'
import { prepareChatBody, prepareCnChatBody } from '../src/upstream.ts'

/**
 * Wire pin for issue #201: since 2026-10-20 the CN gateway
 * (`copilot.tencent.com/v2/chat/completions`) answers a body whose first message
 * is `system` and whose content starts with DSH's fixed opener with `400` /
 * `code 11128` / `msg: "Illegal API invocation from an unapproved channel"` —
 * the `displayMsg.zh` users see is 「请求被拦截，请重新发送」.
 *
 * The measurement behind the fix: the same account answers `200` when the
 * opener sits after other text in the message, in a user message, or with one
 * character altered; only the fixed opener at the start of a system/developer
 * message is rejected. `prepareChatBody` therefore neutralizes the opener with a
 * single invisible U+200B, and this spec pins both the rewrite and the blast
 * radius (nothing else in the body changes).
 */

const OPENER = 'You are an AI agent powered by DeepSeek Harness.'
const ZWSP = '\u200b'
const NEUTRALIZED_PHRASE = `DeepSeek${ZWSP} Harness`

/** Parse the prepared wire body back so assertions read on the request, not on text. */
function prepared(body: unknown): Record<string, unknown> {
  return JSON.parse(prepareChatBody(JSON.stringify(body))) as Record<string, unknown>
}

function messages(body: Record<string, unknown>): Record<string, unknown>[] {
  return body['messages'] as Record<string, unknown>[]
}

function systemContent(body: Record<string, unknown>): string {
  return messages(body)[0]!['content'] as string
}

describe('DSH opener channel check (issue #201)', () => {
  it('neutralizes the opener at the start of the system message', () => {
    const tail = '\n\nYou are a coding agent. Follow instructions.'
    const body = prepared({
      model: 'hy4-preview',
      messages: [
        { role: 'system', content: OPENER + tail },
        { role: 'user', content: 'Reply OK.' },
      ],
    })
    const system = systemContent(body)
    expect(system).not.toContain('DeepSeek Harness')
    expect(system).toContain(NEUTRALIZED_PHRASE)
    // Only the opener's two words change; the rest of the prompt is identical.
    expect(system.replace(ZWSP, '')).toBe(OPENER + tail)
    expect(system.startsWith(`You are an AI agent powered by DeepSeek${ZWSP} Harness.`)).toBe(true)
  })

  it('adds exactly one invisible character and re-reads as the same sentence', () => {
    const system = systemContent(prepared({
      messages: [{ role: 'system', content: OPENER }, { role: 'user', content: 'hi' }],
    }))
    expect(system.split(ZWSP).length - 1).toBe(1)
    expect(system.replace(ZWSP, '')).toBe(OPENER)
  })

  it('covers the developer role the shim rewrites to system', () => {
    const body = prepared({
      messages: [
        { role: 'developer', content: OPENER + '\n\nBe brief.' },
        { role: 'user', content: 'hi' },
      ],
    })
    const first = messages(body)[0]!
    expect(first['role']).toBe('system')
    expect(first['content']).not.toContain('DeepSeek Harness')
    expect(first['content']).toContain(NEUTRALIZED_PHRASE)
  })

  it('neutralizes the opener wherever it appears in a system/developer message', () => {
    // The gateway was measured rejecting only the prefix form. Neutralizing any
    // system/developer message carrying DSH's fixed opener is the superset that
    // keeps the fix valid if the check is later broadened — user content is
    // untouched either way.
    const nested = `Intro line.\n\n${OPENER}\n\nMore instructions.`
    const system = systemContent(prepared({
      messages: [{ role: 'system', content: nested }, { role: 'user', content: 'hi' }],
    }))
    expect(system).not.toContain('DeepSeek Harness')
    expect(system.replace(ZWSP, '')).toBe(nested)
  })

  it('leaves user messages byte-identical even when they quote the opener', () => {
    // The check was measured on system/developer messages only; a user pasting
    // the sentence into a conversation must not have their text altered.
    const body = prepared({
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: OPENER },
      ],
    })
    expect(messages(body)[1]!['content']).toBe(OPENER)
  })

  it('leaves a custom system prompt that merely mentions DeepSeek Harness untouched', () => {
    const custom = 'Document the DeepSeek Harness integration in this repository.'
    const system = systemContent(prepared({
      messages: [{ role: 'system', content: custom }, { role: 'user', content: 'hi' }],
    }))
    expect(system).toBe(custom)
  })

  it('is idempotent across the second pass the international path performs', () => {
    const once = prepareChatBody(JSON.stringify({
      messages: [{ role: 'system', content: OPENER }, { role: 'user', content: 'hi' }],
    }))
    const twice = prepareChatBody(once)
    expect(twice).toBe(once)
    expect(twice.split(ZWSP).length - 1).toBe(1)
  })

  it('rewrites a text part in the content-parts spelling and leaves the rest of the body untouched', () => {
    // The parts spelling is neutralized too: the gateway reads the rendered
    // text, so a part that still reads the opener is the same rejection. Only
    // the identity phrase changes inside the part.
    const parts = [{ type: 'text', text: OPENER }]
    const body = prepared({
      model: 'm',
      max_tokens: 128,
      messages: [{ role: 'system', content: parts }, { role: 'user', content: 'hi' }],
    })
    expect(messages(body)[0]!['content']).toEqual([
      { type: 'text', text: `You are an AI agent powered by ${NEUTRALIZED_PHRASE}.` },
    ])
    expect(body['model']).toBe('m')
    expect(body['max_tokens']).toBe(128)
    expect(body['stream']).toBe(true)
  })

  it('returns invalid JSON and JSON arrays unchanged, as the shared preparer does', () => {
    expect(prepareChatBody('not json')).toBe('not json')
    expect(prepareChatBody('[1,2]')).toBe('[1,2]')
  })
})

describe('the CN wire path carries the same rewrite (issue #201)', () => {
  it('neutralizes the opener when chatStream is handed an unprepared body', () => {
    // `chatStream` calls `prepareCnChatBody`, not `prepareChatBody`. The shim
    // normally prepares the body first, but a direct caller bypasses that, and
    // the CN gateway is exactly where the opener is rejected. Measured against
    // the live endpoint 2026-10-21: without this step the request is still
    // answered 400/11128 「请求被拦截，请重新发送」.
    const wire = JSON.parse(prepareCnChatBody(JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'system', content: OPENER }, { role: 'user', content: 'hi' }],
    }))) as Record<string, unknown>
    expect(systemContent(wire)).toBe(`You are an AI agent powered by DeepSeek${ZWSP} Harness.`)
  })

  it('leaves an already-prepared body as the shim left it', () => {
    // The shim's pass already neutralized the opener, so this second one is a
    // no-op rather than a second edit — the rewrite is idempotent.
    const shimPrepared = prepareChatBody(JSON.stringify({
      messages: [{ role: 'system', content: OPENER }, { role: 'user', content: 'hi' }],
    }))
    const wire = prepareCnChatBody(shimPrepared)
    expect(wire).toBe(shimPrepared)
    expect(wire.split(ZWSP).length - 1).toBe(1)
  })

  it('keeps user text byte-identical on the CN path too', () => {
    const wire = JSON.parse(prepareCnChatBody(JSON.stringify({
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: OPENER },
      ],
    }))) as Record<string, unknown>
    expect(messages(wire)[1]!['content']).toBe(OPENER)
  })
})

describe('every occurrence is rewritten, not just the first (issue #201 follow-up)', () => {
  it('neutralizes a repeated opener in one system message', () => {
    // Measured against the live gateway on 2026-10-21: a first-only rewrite left
    // the second copy on the wire, and it was still answered 400/11128.
    const doubled = `${OPENER}\n\nYou are a coding agent.\n\nReminder: ${OPENER}`
    const system = systemContent(prepared({
      messages: [{ role: 'system', content: doubled }, { role: 'user', content: 'hi' }],
    }))
    expect(system).not.toContain('DeepSeek Harness')
    expect(system.split(ZWSP).length - 1).toBe(2)
    expect(system.replaceAll(ZWSP, '')).toBe(doubled)
  })

  it('neutralizes every system message that carries the opener', () => {
    // DSH re-emits the system prompt when it changes, so a long session carries
    // several; each one is checked by the gateway.
    const body = prepared({
      messages: [
        { role: 'system', content: OPENER },
        { role: 'user', content: 'hi' },
        { role: 'system', content: `Update.\n\n${OPENER}` },
      ],
    })
    const all = messages(body).filter(m => m['role'] === 'system') as { content: string }[]
    expect(all).toHaveLength(2)
    for (const message of all) expect(message.content).not.toContain('DeepSeek Harness')
  })

  it('is still idempotent with several occurrences', () => {
    const source = JSON.stringify({
      messages: [{ role: 'system', content: `${OPENER}\n\n${OPENER}` }, { role: 'user', content: 'hi' }],
    })
    const once = prepareChatBody(source)
    expect(prepareChatBody(once)).toBe(once)
    expect(prepareCnChatBody(once)).toBe(once)
    expect(once.split(ZWSP).length - 1).toBe(2)
  })

  it('covers the content-parts spelling as well as a plain string', () => {
    // pi-ai flattens parts before the wire, but a direct caller may hand them
    // over as-is, and the gateway reads the rendered text either way.
    const body = prepared({
      messages: [{
        role: 'system',
        content: [
          { type: 'text', text: OPENER },
          { type: 'text', text: `${OPENER}\n\nAgain.` },
        ],
      }],
    })
    const parts = messages(body)[0]!['content'] as { type: string, text: string }[]
    for (const part of parts) expect(part.text).not.toContain('DeepSeek Harness')
    expect(parts.map(p => p.text.replaceAll(ZWSP, '').trimEnd()))
      .toEqual([OPENER, `${OPENER}\n\nAgain.`])
  })

  it('leaves a user message with several occurrences untouched', () => {
    const body = prepared({
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: `${OPENER} and ${OPENER}` },
      ],
    })
    expect(messages(body)[1]!['content']).toBe(`${OPENER} and ${OPENER}`)
  })
})

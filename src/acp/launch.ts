import { RequestError } from '@agentclientprotocol/sdk/unstable'

/** invalidParams whose message (not only data) names the problem, so clients show it. */
function invalid(message: string): RequestError {
  return RequestError.invalidParams({ reason: message }, message)
}

/**
 * Per-session launch options a client passes in `_meta` of `session/new`, `session/load`
 * and `session/resume`:
 * - `_meta.piAcp.launch: string[]`: pi CLI flags, checked against an allowlist.
 * - `_meta.piAcp.headless: true`: no startup banner, update probe or queue chatter in the
 *   message stream; notices travel as `_meta` instead of text.
 * - `_meta.systemPrompt`: a string replaces pi's system prompt, `{append}` appends to it.
 */
export type SystemPrompt = { mode: 'append' | 'replace'; text: string }

export type LaunchOptions = {
  args: string[]
  systemPrompt?: SystemPrompt
  headless: boolean
  trustedParent: boolean
}

/** Allowed pi flags; `true` = the flag takes a value. Aliases are the same pi flag. */
const ALLOWED: Record<string, boolean> = {
  '--model': true,
  '--thinking': true,
  '--tools': true,
  '-t': true,
  '--exclude-tools': true,
  '-xt': true,
  '--no-tools': false,
  '-nt': false,
  '-e': true,
  '--extension': true,
  '-ne': false,
  '--no-extensions': false,
  '--no-mcp': false,
  '--skill': true,
  '-ns': false,
  '--no-skills': false,
  '-np': false,
  '--no-prompt-templates': false,
  '-nc': false,
  '--no-context-files': false,
  '--approve': false,
  '-a': false
}

/** Flags pi-acp itself owns (mode, session selection); a client never sets them. */
const ADAPTER_OWNED = new Set([
  '--mode',
  '--session',
  '--session-id',
  '--session-dir',
  '--fork',
  '--no-session',
  '-p',
  '--print',
  '-c',
  '--continue',
  '-r',
  '--resume',
  '--system-prompt',
  '--append-system-prompt'
])

export const LAUNCH_FLAGS = Object.keys(ALLOWED)

export function parseLaunchFlags(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) {
    throw invalid('_meta.piAcp.launch must be an array of strings')
  }
  const args = value as string[]
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!
    if (ADAPTER_OWNED.has(flag)) {
      throw invalid(`_meta.piAcp.launch: ${flag} is owned by pi-acp`)
    }
    const takesValue = ALLOWED[flag]
    if (takesValue === undefined) {
      throw invalid(`_meta.piAcp.launch: ${flag} is not an allowed pi flag`)
    }
    if (takesValue) {
      const next = args[i + 1]
      if (next === undefined || next.length === 0) {
        throw invalid(`_meta.piAcp.launch: ${flag} needs a value`)
      }
      i++
    }
  }
  return [...args]
}

export function parseSystemPrompt(value: unknown): SystemPrompt | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string' && value.trim().length > 0) return { mode: 'replace', text: value }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value)
    if (entries.length === 1) {
      const [mode, text] = entries[0]!
      if ((mode === 'append' || mode === 'replace') && typeof text === 'string' && text.trim().length > 0) {
        return { mode, text }
      }
    }
  }
  throw invalid(
    '_meta.systemPrompt must be a nonempty string or an object with exactly one nonempty append or replace string'
  )
}

export function parseLaunchOptions(meta: unknown): LaunchOptions {
  const record = isRecord(meta) ? meta : {}
  const piAcp = isRecord(record.piAcp) ? record.piAcp : {}
  const systemPrompt = parseSystemPrompt(record.systemPrompt)
  return {
    args: parseLaunchFlags(piAcp.launch),
    ...(systemPrompt ? { systemPrompt } : {}),
    headless: piAcp.headless === true,
    trustedParent: piAcp.trustedParent === true
  }
}

/** `agentCapabilities._meta.piAcp` advertisement. */
export function launchCapabilities(): Record<string, unknown> {
  return {
    launch: { flags: LAUNCH_FLAGS },
    systemPrompt: { modes: ['append', 'replace'] },
    headless: true,
    trustedParent: true
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

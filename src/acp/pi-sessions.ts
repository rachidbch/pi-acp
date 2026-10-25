import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs'
import { open as openAsync, readFile as readFileAsync, readdir as readdirAsync } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, isAbsolute } from 'node:path'
import { promptToSessionTitle } from './translate/prompt.js'

export type PiSessionListItem = {
  sessionId: string
  cwd: string
  title: string | null
  updatedAt: string | null
  sessionFile: string
}

const DEFAULT_TAIL_BYTES = 256 * 1024
const DEFAULT_HEAD_BYTES = 64 * 1024

function getPiAgentDir(): string {
  // pi supports overriding config dir via PI_CODING_AGENT_DIR.
  // See pi README.
  return process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), '.pi', 'agent')
}

function readSessionDirFromSettings(agentDir: string): string | null {
  const settingsPath = join(agentDir, 'settings.json')
  try {
    if (!existsSync(settingsPath)) return null
    const raw = readFileSync(settingsPath, 'utf8')
    const data = JSON.parse(raw) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null

    const sessionDir = (data as Record<string, unknown>).sessionDir
    if (typeof sessionDir !== 'string' || !sessionDir.trim()) return null

    return isAbsolute(sessionDir) ? sessionDir : resolve(agentDir, sessionDir)
  } catch {
    return null
  }
}

function expandTilde(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
}

/** pi's own order (`main.js`): env first, then settings.json `sessionDir`. A set value is one flat directory. */
function getConfiguredSessionDir(agentDir: string): string | null {
  const fromEnv = process.env.PI_CODING_AGENT_SESSION_DIR
  return fromEnv ? resolve(expandTilde(fromEnv)) : readSessionDirFromSettings(agentDir)
}

export function getPiSessionsDir(): string {
  const agentDir = getPiAgentDir()
  return getConfiguredSessionDir(agentDir) ?? join(agentDir, 'sessions')
}

/**
 * The one directory pi writes a cwd's sessions to (`session-manager.js` getDefaultSessionDirPath):
 * the configured directory flat, else `<agentDir>/sessions/--<cwd with separators as ->--`.
 */
export function getPiSessionDirForCwd(cwd: string): string {
  const agentDir = getPiAgentDir()
  const configured = getConfiguredSessionDir(agentDir)
  if (configured) return configured
  return join(
    agentDir,
    'sessions',
    `--${resolve(cwd)
      .replace(/^[/\\]/, '')
      .replace(/[/\\:]/g, '-')}--`
  )
}

/** pi names session files `<timestamp>_<id>.jsonl`; reads one directory, never scans. */
export async function findPiSessionFile(dir: string, sessionId: string): Promise<string | null> {
  try {
    // Async: load/resume sit on the parent-driven hot path and must not block the loop.
    const names = await readdirAsync(dir)
    const name = names.find(f => f.endsWith(`_${sessionId}.jsonl`))
    return name ? join(dir, name) : null
  } catch {
    return null
  }
}

function walkJsonlFiles(dir: string, out: string[]) {
  let entries: import('node:fs').Dirent[]
  try {
    // Force string names.
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' }) as unknown as import('node:fs').Dirent[]
  } catch {
    return
  }

  for (const e of entries) {
    const name = typeof (e as any).name === 'string' ? (e as any).name : String((e as any).name)
    const p = join(dir, name)
    if (e.isDirectory()) walkJsonlFiles(p, out)
    else if (e.isFile() && name.endsWith('.jsonl')) out.push(p)
  }
}

function readFirstLine(path: string): string | null {
  // Avoid reading the whole file.
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(DEFAULT_HEAD_BYTES)
    const n = readSync(fd, buf, 0, buf.length, 0)
    if (n <= 0) return null
    const s = buf.subarray(0, n).toString('utf-8')
    const idx = s.indexOf('\n')
    return idx === -1 ? s.trim() : s.slice(0, idx).trim()
  } catch {
    return null
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore
    }
  }
}

function readTail(path: string, tailBytes = DEFAULT_TAIL_BYTES): string {
  const st = statSync(path)
  const start = Math.max(0, st.size - tailBytes)
  const len = st.size - start

  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(len)
    const n = readSync(fd, buf, 0, buf.length, start)
    return buf.subarray(0, n).toString('utf-8')
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore
    }
  }
}

function parseSessionHeader(firstLine: string): { sessionId: string; cwd: string } | null {
  try {
    const obj = JSON.parse(firstLine) as any
    if (obj?.type !== 'session') return null
    const sessionId = typeof obj?.id === 'string' ? obj.id : null
    const cwd = typeof obj?.cwd === 'string' ? obj.cwd : null
    if (!sessionId || !cwd) return null
    return { sessionId, cwd }
  } catch {
    return null
  }
}

function pickTitleFromTail(tail: string): string | null {
  // Try to find the *latest* session_info entry (stores the user-provided name).
  // We scan backwards line-by-line.
  const lines = tail.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as any
      if (obj?.type === 'session_info' && typeof obj?.name === 'string') {
        return obj.name.trim()
      }
    } catch {
      // ignore
    }
  }
  return null
}

/** The last `session_info.name` in the text, oldest to newest. */
function scanSessionInfoName(text: string): string | null {
  let lastName: string | null = null
  for (const line0 of text.split(/\r?\n/)) {
    const line = line0.trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as any
      if (obj?.type === 'session_info' && typeof obj?.name === 'string') {
        lastName = obj.name.trim()
      }
    } catch {
      // ignore
    }
  }
  return lastName
}

function pickUpdatedAtFromTail(tail: string): string | null {
  // pi's `/resume` effectively orders sessions by last *message* activity.
  // We scan backwards and pick the timestamp of the most recent entry with type === "message".
  const lines = tail.split(/\r?\n/)

  // 1) Prefer the most recent message entry.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as any
      if (obj?.type !== 'message') continue
      const ts = typeof obj?.timestamp === 'string' ? obj.timestamp : null
      if (!ts) continue
      const d = new Date(ts)
      if (Number.isFinite(d.getTime())) return d.toISOString()
    } catch {
      // ignore
    }
  }

  // 2) Fallback: any valid timestamp (covers sessions that somehow have no messages).
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as any
      const ts = typeof obj?.timestamp === 'string' ? obj.timestamp : null
      if (!ts) continue
      const d = new Date(ts)
      if (Number.isFinite(d.getTime())) return d.toISOString()
    } catch {
      // ignore
    }
  }

  return null
}

/** The first user-message-derived title in the text. */
function fallbackTitleFromHeadText(raw: string): string | null {
  const lines = raw.split(/\r?\n/)
  for (const line0 of lines.slice(0, 2000)) {
    const line = line0.trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as any
      if (obj?.type === 'message' && obj?.message?.role === 'user') {
        const content = obj?.message?.content
        if (typeof content === 'string') {
          const title = promptToSessionTitle([{ type: 'text', text: content }])
          if (title) return title
        }
        if (Array.isArray(content)) {
          const title = promptToSessionTitle(
            content.filter(
              (block: unknown): block is { type: 'text'; text: string } =>
                typeof block === 'object' && block !== null && 'type' in block && block.type === 'text' && 'text' in block
            )
          )
          if (title) return title
        }
      }
    } catch {
      // ignore
    }
  }

  return null
}

async function readTailAsync(path: string, tailBytes = DEFAULT_TAIL_BYTES): Promise<string> {
  const handle = await openAsync(path, 'r')
  try {
    const st = await handle.stat()
    const start = Math.max(0, st.size - tailBytes)
    const len = st.size - start
    const buf = Buffer.alloc(len)
    const { bytesRead } = await handle.read(buf, 0, len, start)
    return buf.subarray(0, bytesRead).toString('utf-8')
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * The session's title, from the newest `session_info.name`, else the first user message.
 * Async so the load/resume lookup path never blocks on sync FS.
 */
export async function readPiSessionTitle(path: string, tail?: string): Promise<string | null> {
  try {
    const tailText = tail ?? (await readTailAsync(path))
    const named = pickTitleFromTail(tailText)
    if (named) return named
    const raw = await readFileAsync(path, { encoding: 'utf8' })
    // A cleared name ('') is no title: fall through, matching the sync variant's `||`.
    return scanSessionInfoName(raw) || fallbackTitleFromHeadText(raw)
  } catch {
    return null
  }
}

/** Sync variant for `session/list`, which is off the load and resume path. */
function readPiSessionTitleSync(path: string, tail?: string): string | null {
  try {
    const named = pickTitleFromTail(tail ?? readTail(path))
    if (named) return named
    const raw = readFileSync(path, { encoding: 'utf8' })
    return scanSessionInfoName(raw) || fallbackTitleFromHeadText(raw)
  } catch {
    return null
  }
}

export function listPiSessions(): PiSessionListItem[] {
  const sessionsDir = getPiSessionsDir()
  const files: string[] = []
  walkJsonlFiles(sessionsDir, files)

  const items: PiSessionListItem[] = []

  for (const file of files) {
    const first = readFirstLine(file)
    if (!first) continue
    const header = parseSessionHeader(first)
    if (!header) continue

    let updatedAt: string | null = null

    let title: string | null = null
    try {
      const tail = readTail(file)
      title = readPiSessionTitleSync(file, tail)
      updatedAt = pickUpdatedAtFromTail(tail)
    } catch {
      // ignore
    }

    // Fallback for updatedAt when we couldn't parse timestamps from tail.
    if (!updatedAt) {
      try {
        updatedAt = statSync(file).mtime.toISOString()
      } catch {
        updatedAt = null
      }
    }

    items.push({
      sessionId: header.sessionId,
      cwd: header.cwd,
      title,
      updatedAt,
      sessionFile: file
    })
  }

  // Sort most recent first.
  items.sort((a, b) => {
    const aa = a.updatedAt ?? ''
    const bb = b.updatedAt ?? ''
    return bb.localeCompare(aa)
  })

  return items
}

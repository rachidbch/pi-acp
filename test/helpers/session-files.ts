import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** pi's default session directory for a cwd, spelled out (`session-manager.js` getDefaultSessionDirPath). */
export function piSessionDir(agentDir: string, cwd: string): string {
  return join(agentDir, 'sessions', `--${cwd.replace(/^\//, '').replace(/[/:]/g, '-')}--`)
}

/** Writes `<dir>/<timestamp>_<id>.jsonl` with a session header plus the given entries; returns the path. */
export function writePiSession(dir: string, sessionId: string, cwd: string, entries: unknown[] = []): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`)
  const header = { type: 'session', version: 3, id: sessionId, timestamp: '2026-01-01T00:00:00.000Z', cwd }
  writeFileSync(file, [header, ...entries].map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8')
  return file
}

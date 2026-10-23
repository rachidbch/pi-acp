import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SystemPrompt } from '../acp/launch.js'

/**
 * Writes the system prompt to a private (0600) temp file and returns the pi flag that
 * reads it, plus a dispose that removes the file. Ported from salman1993/buzz-pi-acp.
 */
export function prepareSystemPrompt(prompt?: SystemPrompt): { args: string[]; dispose: () => void } {
  if (!prompt) return { args: [], dispose: () => {} }

  const directory = mkdtempSync(join(tmpdir(), 'pi-acp-prompt-'))
  const dispose = () => {
    rmSync(directory, { recursive: true, force: true })
  }
  try {
    const path = join(directory, 'prompt.md')
    writeFileSync(path, prompt.text, { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
    return { args: [prompt.mode === 'append' ? '--append-system-prompt' : '--system-prompt', path], dispose }
  } catch (error) {
    dispose()
    throw error
  }
}

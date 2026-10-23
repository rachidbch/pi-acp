import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The system prompt file (a private temp dir) must be gone once the standalone adapter has
// exited, on every exit path the adapter controls. The adapter exits in the same tick as it
// signals pi, so removal cannot wait for pi's close event.

const cwd = fileURLToPath(new URL('../../', import.meta.url))
const indexPath = fileURLToPath(new URL('../../src/index.ts', import.meta.url))
const fakePi = fileURLToPath(new URL('../fixtures/fake-pi-turn.mjs', import.meta.url))

for (const trigger of ['stdin end', 'SIGTERM', 'SIGINT'] as const) {
  test(
    `adapter removes the system prompt file on ${trigger}`,
    { timeout: 20_000, skip: process.platform === 'win32' && trigger !== 'stdin end' },
    async t => {
      const scratch = mkdtempSync(join(tmpdir(), 'pi-acp-promptfile-'))
      t.after(() => rmSync(scratch, { recursive: true, force: true }))
      const argvFile = join(scratch, 'argv.json')
      const env: NodeJS.ProcessEnv = { ...process.env, PI_ACP_PI_COMMAND: fakePi, FAKE_PI_ARGV_FILE: argvFile }
      for (const key of Object.keys(env)) if (key.startsWith('PI_ACP_') && key !== 'PI_ACP_PI_COMMAND') delete env[key]

      const adapter = spawn(process.execPath, ['--import', 'tsx', indexPath], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      t.after(() => {
        if (adapter.exitCode === null && adapter.signalCode === null) adapter.kill('SIGKILL')
      })
      let stdout = ''
      adapter.stdout.on('data', chunk => (stdout += String(chunk)))
      adapter.stderr.resume()
      const closed = once(adapter, 'close')
      const rpc = (id: number, method: string, params: unknown) =>
        adapter.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      const reply = async (id: number) => {
        for (let i = 0; i < 1000; i++) {
          if (stdout.split('\n').some(line => line.includes(`"id":${id}`))) return
          await new Promise(r => setTimeout(r, 20))
        }
        assert.fail(`no response ${id}; stdout: ${stdout}`)
      }

      rpc(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} })
      await reply(1)
      rpc(2, 'session/new', { cwd: scratch, mcpServers: [], _meta: { systemPrompt: { append: 'PERSONA-BODY' } } })
      await reply(2)

      const argv: string[] = JSON.parse(readFileSync(argvFile, 'utf8')).argv
      const promptFile = argv[argv.indexOf('--append-system-prompt') + 1]
      assert.equal(readFileSync(promptFile, 'utf8'), 'PERSONA-BODY')

      if (trigger === 'stdin end') adapter.stdin.end()
      else adapter.kill(trigger === 'SIGTERM' ? 'SIGTERM' : 'SIGINT')
      const [code] = await closed
      assert.equal(code, 0)
      assert.equal(existsSync(dirname(promptFile)), false, 'prompt dir survived adapter exit')
    }
  )
}

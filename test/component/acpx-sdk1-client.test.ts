import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAcpRuntime, createAgentRegistry, createRuntimeStore } from 'acpx/runtime'

// pi-acp builds on ACP SDK 2.x; acpx 0.20 (our fork base) speaks through SDK 1.x.
// Both speak ACP v1 on the wire: drive initialize + session/new + one prompt from acpx's
// own client to pi-acp's source, over real stdio, with a scripted fake pi.

const root = fileURLToPath(new URL('../..', import.meta.url))
const tsxLoader = import.meta.resolve('tsx')
const fakePi = join(root, 'test/fixtures/fake-pi-turn.mjs')

function piAcpArgv(): string[] {
  return [process.execPath, '--import', tsxLoader, join(root, 'src/index.ts')]
}

test('acpx 0.20 (SDK 1.x client) runs a turn against pi-acp on SDK 2.x', { timeout: 30_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'pi-acp-sdk1-'))
  const rt = createAcpRuntime({
    cwd: scratch,
    permissionMode: 'deny-all',
    sessionStore: createRuntimeStore({ stateDir: join(scratch, 'state') }),
    agentRegistry: createAgentRegistry({ overrides: { pi: piAcpArgv() } }),
    agentProcessEnv: { HOME: scratch, PI_ACP_PI_COMMAND: fakePi, FAKE_PI_REPLY: 'SDK1-PONG' }
  })
  try {
    const handle = await rt.ensureSession({ sessionKey: 'sdk1', agent: 'pi', mode: 'oneshot' })
    assert.ok(handle.backendSessionId ?? handle.agentSessionId, 'session/new returned a session id')
    const turn = rt.startTurn({ handle, text: 'ping', mode: 'prompt', requestId: 'r1', timeoutMs: 0 })
    let text = ''
    for await (const ev of turn.events) if (ev.type === 'text_delta') text += ev.text ?? ''
    const result = await turn.result
    assert.equal(result.status, 'completed')
    assert.equal(result.stopReason, 'end_turn')
    assert.match(text, /SDK1-PONG/)
  } finally {
    await rt.shutdown()
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { writePiSession } from '../helpers/session-files.js'

// Several sessions share one adapter connection (one per child, one adapter per parent):
// opening a session must never close another one, idle or not.

const scratch = mkdtempSync(join(tmpdir(), 'pi-acp-sweep-'))
process.env.PI_ACP_PI_COMMAND = fileURLToPath(new URL('../fixtures/fake-pi-turn.mjs', import.meta.url))
process.env.PI_CODING_AGENT_SESSION_DIR = join(scratch, 'sessions')

test('session/new, session/load and session/resume leave idle sibling sessions running', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  try {
    const first = await agent.newSession({ cwd: scratch, mcpServers: [] } as any)
    const second = await agent.newSession({ cwd: scratch, mcpServers: [] } as any)
    const sessions = Reflect.get(agent, 'sessions') as { maybeGet(id: string): unknown }
    assert.ok(sessions.maybeGet(first.sessionId), 'new keeps the previous session')

    writePiSession(join(scratch, 'sessions'), 'on-disk', scratch)
    await agent.loadSession({ sessionId: 'on-disk', cwd: scratch, mcpServers: [] } as any)
    assert.ok(sessions.maybeGet(first.sessionId), 'load keeps idle siblings')
    assert.ok(sessions.maybeGet(second.sessionId), 'load keeps idle siblings')

    writePiSession(join(scratch, 'sessions'), 'on-disk-2', scratch)
    await agent.resumeSession({ sessionId: 'on-disk-2', cwd: scratch, mcpServers: [] } as any)
    for (const id of [first.sessionId, second.sessionId, 'on-disk'])
      assert.ok(sessions.maybeGet(id), `resume keeps ${id}`)

    const reply = await agent.prompt({ sessionId: first.sessionId, prompt: [{ type: 'text', text: 'hi' }] } as any)
    assert.equal(reply.stopReason, 'end_turn')
  } finally {
    agent.dispose()
  }
})

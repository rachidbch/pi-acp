import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { piSessionDir, writePiSession } from '../helpers/session-files.js'

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-test-'))
  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  t.after(() => {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  })
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  return { root, agent, cwds: Reflect.get(agent, 'cwds') as Map<string, string> }
}

test('PiAcpAgent: deleteSession removes the file of a session whose cwd the adapter knows', async t => {
  const { root, agent, cwds } = fixture(t)
  const cwd = '/tmp/delete-project'
  const sessionFile = writePiSession(piSessionDir(root, cwd), 'known-session', cwd)
  cwds.set('known-session', cwd)

  assert.deepEqual(await agent.deleteSession({ sessionId: 'known-session' } as any), {})
  assert.equal(existsSync(sessionFile), false)
  assert.equal(cwds.has('known-session'), false)
})

test('PiAcpAgent: deleteSession finds a session this adapter never saw through the listing', async t => {
  const { root, agent } = fixture(t)
  const cwd = '/tmp/delete-discovery'
  const sessionFile = writePiSession(piSessionDir(root, cwd), 'pi-discovered-session', cwd)

  assert.deepEqual(await agent.deleteSession({ sessionId: 'pi-discovered-session' } as any), {})
  assert.equal(existsSync(sessionFile), false)
})

test('PiAcpAgent: deleteSession succeeds idempotently for unknown sessionId', async t => {
  const { agent } = fixture(t)
  assert.deepEqual(await agent.deleteSession({ sessionId: 'non-existent-session' } as any), {})
})

test('PiAcpAgent: deleteSession survives a known session whose file is already gone', async t => {
  const { agent, cwds } = fixture(t)
  cwds.set('missing-file-session', '/tmp/delete-missingfile')
  assert.deepEqual(await agent.deleteSession({ sessionId: 'missing-file-session' } as any), {})
})

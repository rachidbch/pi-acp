import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { findPiSessionFile, getPiSessionDirForCwd } from '../../src/acp/pi-sessions.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { piSessionDir, writePiSession } from '../helpers/session-files.js'

function withEnv(t: test.TestContext, env: Record<string, string | undefined>) {
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

test('session dir: PI_CODING_AGENT_SESSION_DIR, then settings sessionDir (both flat), then <agentDir>/sessions/--cwd--', t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-sessiondir-'))
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ sessionDir: join(root, 'from-settings') }))
  withEnv(t, { PI_CODING_AGENT_DIR: root, PI_CODING_AGENT_SESSION_DIR: join(root, 'from-env') })
  assert.equal(getPiSessionDirForCwd('/work/app'), join(root, 'from-env'))
  withEnv(t, { PI_CODING_AGENT_SESSION_DIR: undefined })
  assert.equal(getPiSessionDirForCwd('/work/app'), join(root, 'from-settings'))
  writeFileSync(join(root, 'settings.json'), '{}')
  assert.equal(getPiSessionDirForCwd('/work/app'), join(root, 'sessions', '--work-app--'))
})

test('findPiSessionFile matches the id suffix in one directory only', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-findfile-'))
  const dir = join(root, 'dir')
  const file = writePiSession(dir, 'abc-123', '/w')
  writePiSession(dir, 'xabc-123', '/w')
  mkdirSync(join(dir, 'nested'))
  writePiSession(join(dir, 'nested'), 'deep', '/w')
  assert.equal(findPiSessionFile(dir, 'abc-123'), file)
  assert.equal(findPiSessionFile(dir, 'deep'), null)
  assert.equal(findPiSessionFile(join(root, 'absent'), 'abc-123'), null)
})

for (const method of ['loadSession', 'resumeSession'] as const) {
  test(`${method} derives the file from id + cwd; a missing file fails naming id and dir without spawning`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'pi-acp-lookup-'))
    withEnv(t, { PI_CODING_AGENT_DIR: root, PI_CODING_AGENT_SESSION_DIR: undefined })
    const cwd = '/tmp/lookup-project'
    const file = writePiSession(piSessionDir(root, cwd), 'present', cwd)
    const spawns: Array<{ sessionPath?: string }> = []
    t.mock.method(PiRpcProcess, 'spawn', async (opts: { sessionPath?: string }) => {
      spawns.push(opts)
      return {
        onEvent: () => () => {},
        getMessages: async () => ({ messages: [] }),
        getAvailableThinkingLevels: async () => ['medium'],
        getAvailableModels: async () => ({ models: [] }),
        getState: async () => ({ thinkingLevel: 'medium' }),
        dispose() {}
      } as unknown as PiRpcProcess
    })
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    t.after(() => agent.dispose())

    await agent[method]({ sessionId: 'present', cwd, mcpServers: [] })
    assert.deepEqual(spawns, [{ cwd, sessionPath: file, piCommand: process.env.PI_ACP_PI_COMMAND }])

    await assert.rejects(
      agent[method]({ sessionId: 'absent', cwd, mcpServers: [] }),
      (err: { code?: number; message?: string; data?: unknown }) =>
        err.code === -32602 &&
        String(err.message).endsWith(`No pi session file for session absent in ${piSessionDir(root, cwd)}`)
    )
    assert.equal(spawns.length, 1)
  })
}

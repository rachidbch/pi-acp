import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

/** Minimal pi process stub matching what loadSession needs after restore. */
function stubProc(): unknown {
  return {
    onEvent: () => () => {},
    getMessages: async () => ({ messages: [] }),
    getAvailableThinkingLevels: async () => ['medium'],
    getSessionStats: async () => ({ contextUsage: { tokens: 1, contextWindow: 100 } }),
    getAvailableModels: async () => ({ models: [] }),
    getState: async () => ({ thinkingLevel: 'medium' })
  }
}

function writeStoredSession(root: string, sessionId: string): void {
  const sessionsDir = join(root, 'sessions', '--tmp-project--')
  mkdirSync(sessionsDir, { recursive: true })
  const sessionFile = join(sessionsDir, `2026-02-11T00-00-00-000Z_${sessionId}.jsonl`)
  writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: 'session',
      version: 3,
      id: sessionId,
      timestamp: '2026-02-11T00:00:00.000Z',
      cwd: '/tmp/project'
    })}\n`,
    'utf8'
  )
}

type EnvBackup = Record<string, string | undefined>

function setRespawnEnv(max: number, windowMs: number): EnvBackup {
  const backup: EnvBackup = {}
  const entries: [string, string][] = [
    ['PI_ACP_RESPAWN_MAX_ATTEMPTS', String(max)],
    ['PI_ACP_RESPAWN_WINDOW_MS', String(windowMs)]
  ]
  for (const [key, value] of entries) {
    backup[key] = process.env[key]
    process.env[key] = value
  }
  return backup
}

function restoreEnv(backup: EnvBackup): void {
  for (const [key, value] of Object.entries(backup)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

/** A request for a session without a live process (closed or crashed): restored on demand, no load/resume. */
async function restoreOnDemand(agent: PiAcpAgent, sessionId: string): Promise<void> {
  Reflect.get(agent, 'cwds').set(sessionId, '/tmp/project')
  await Reflect.get(agent, 'restoreSession').call(agent, sessionId)
  await agent.closeSession({ sessionId })
}

test('on-demand restores are budgeted per session and refuse after exhaustion', { timeout: 5000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-respawn-'))
  writeStoredSession(root, 'sess-crashy')
  writeStoredSession(root, 'sess-healthy')
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  const backup = setRespawnEnv(2, 60_000)
  const originalSpawn = PiRpcProcess.spawn
  let spawnCalls = 0
  ;(PiRpcProcess as { spawn: unknown }).spawn = async () => {
    spawnCalls++
    return stubProc()
  }
  t.after(() => {
    ;(PiRpcProcess as { spawn: unknown }).spawn = originalSpawn
    restoreEnv(backup)
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir
  })

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  await restoreOnDemand(agent, 'sess-crashy')
  await restoreOnDemand(agent, 'sess-crashy')
  assert.equal(spawnCalls, 2)
  await assert.rejects(restoreOnDemand(agent, 'sess-crashy'), /respawn budget exhausted/)

  // Strike isolation: another session is unaffected by the exhausted budget.
  await restoreOnDemand(agent, 'sess-healthy')
  assert.equal(spawnCalls, 3)
})

test('respawn budget recovers after the window clears', { timeout: 5000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-respawn-'))
  writeStoredSession(root, 'sess-window')
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  const backup = setRespawnEnv(1, 400)
  const originalSpawn = PiRpcProcess.spawn
  let spawnCalls = 0
  ;(PiRpcProcess as { spawn: unknown }).spawn = async () => {
    spawnCalls++
    return stubProc()
  }
  t.after(() => {
    ;(PiRpcProcess as { spawn: unknown }).spawn = originalSpawn
    restoreEnv(backup)
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir
  })

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  await restoreOnDemand(agent, 'sess-window')
  await assert.rejects(restoreOnDemand(agent, 'sess-window'), /respawn budget exhausted/)
  await new Promise(resolve => setTimeout(resolve, 450))
  await restoreOnDemand(agent, 'sess-window')
  assert.equal(spawnCalls, 2)
})

test('session/load and session/resume restores never count against the budget', { timeout: 5000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-respawn-'))
  writeStoredSession(root, 'sess-explicit')
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  const backup = setRespawnEnv(1, 60_000)
  const originalSpawn = PiRpcProcess.spawn
  let spawnCalls = 0
  ;(PiRpcProcess as { spawn: unknown }).spawn = async () => {
    spawnCalls++
    return stubProc()
  }
  t.after(() => {
    ;(PiRpcProcess as { spawn: unknown }).spawn = originalSpawn
    restoreEnv(backup)
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir
  })

  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const request = { sessionId: 'sess-explicit', cwd: '/tmp/project', mcpServers: [] } as never
  for (let i = 0; i < 3; i++) {
    await agent.loadSession(request)
    await agent.closeSession({ sessionId: 'sess-explicit' })
    await agent.resumeSession(request)
    await agent.closeSession({ sessionId: 'sess-explicit' })
  }
  assert.equal(spawnCalls, 6)
})

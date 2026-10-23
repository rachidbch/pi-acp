import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { piSessionDir, writePiSession } from '../helpers/session-files.js'

function stubProc(overrides: Record<string, unknown> = {}): unknown {
  return {
    onEvent: () => () => {},
    getMessages: async () => ({ messages: [] }),
    getAvailableThinkingLevels: async () => ['medium'],
    getSessionStats: async () => ({ contextUsage: { tokens: 1, contextWindow: 100 } }),
    getAvailableModels: async () => ({ models: [{ provider: 'test', id: 'model', name: 'model' }] }),
    getState: async () => ({ thinkingLevel: 'medium', sessionId: 'forked-1', sessionFile: '/tmp/forked-1.jsonl' }),
    ...overrides
  }
}

test('session/fork spawns pi with --fork of the session file found by id + cwd', { timeout: 5000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-fork-'))
  const sourceFile = writePiSession(piSessionDir(root, root), 'source', root)
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  const originalSpawn = PiRpcProcess.spawn
  const spawnCalls: Array<Record<string, unknown>> = []
  ;(PiRpcProcess as { spawn: unknown }).spawn = async (params: Record<string, unknown>) => {
    spawnCalls.push(params)
    return stubProc() as never
  }
  t.after(() => {
    ;(PiRpcProcess as { spawn: unknown }).spawn = originalSpawn
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir
  })

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  const response = await agent.forkSession({
    sessionId: 'source',
    cwd: root,
    mcpServers: []
  } as never)

  assert.equal(response.sessionId, 'forked-1')
  assert.ok(response.modes)
  assert.ok(response.configOptions)
  assert.equal(spawnCalls.length, 1)
  assert.equal(spawnCalls[0]?.forkSessionPath, sourceFile)
  assert.equal(spawnCalls[0]?.cwd, root)
})

test('session/fork rejects unknown source sessions and relative cwd', { timeout: 5000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-fork-'))
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  t.after(() => {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir
  })
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  await assert.rejects(agent.forkSession({ sessionId: 'nope', cwd: root, mcpServers: [] } as never), { code: -32602 })
  await assert.rejects(agent.forkSession({ sessionId: 'nope', cwd: 'relative', mcpServers: [] } as never), {
    code: -32602
  })
})

test('additionalDirectories is accepted but ignored with a warning', { timeout: 5000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-fork-'))
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  const originalSpawn = PiRpcProcess.spawn
  const warnings: string[] = []
  const originalWrite = process.stderr.write.bind(process.stderr)
  ;(process.stderr as { write: unknown }).write = (chunk: string) => {
    warnings.push(String(chunk))
    return true
  }
  ;(PiRpcProcess as { spawn: unknown }).spawn = async () => stubProc() as never
  t.after(() => {
    ;(PiRpcProcess as { spawn: unknown }).spawn = originalSpawn
    ;(process.stderr as { write: unknown }).write = originalWrite
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir
  })

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const init = await agent.initialize({ protocolVersion: 1 } as never)
  // The capability must NOT be advertised since pi cannot honor it.
  assert.equal(
    (init.agentCapabilities?.sessionCapabilities as Record<string, unknown> | undefined)?.additionalDirectories,
    undefined
  )
  assert.ok((init.agentCapabilities?.sessionCapabilities as Record<string, unknown>)?.fork)

  await agent.newSession({
    cwd: root,
    mcpServers: [],
    additionalDirectories: ['/other/root']
  } as never)
  assert.ok(
    warnings.some(w => w.includes('session/new: additionalDirectories is not supported')),
    `expected stderr warning, got: ${warnings.join(' | ')}`
  )
})

import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION, RequestError, type McpServer } from '@agentclientprotocol/sdk/unstable'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'
import { writePiSession } from '../helpers/session-files.js'

class LifecycleProcess extends FakePiRpcProcess {
  failConfiguration = false
  historyReads = 0
  fileAtDispose = false

  constructor(private readonly file: string) {
    super()
  }

  override async getState() {
    if (this.failConfiguration) throw new Error('configuration failed')
    return { thinkingLevel: 'medium', model: { provider: 'test', id: 'model' } }
  }

  override async getMessages() {
    this.historyReads++
    return { messages: [{ role: 'user', timestamp: 123, content: [{ type: 'text', text: 'historic prompt' }] }] }
  }

  override async abort() {
    await new Promise<void>(() => {})
  }

  override dispose() {
    this.fileAtDispose = existsSync(this.file)
    super.dispose()
  }
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-lifecycle-'))
  const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR
  process.env.PI_CODING_AGENT_SESSION_DIR = root
  const file = writePiSession(root, 'lifecycle', root)
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const cwds = Reflect.get(agent, 'cwds') as Map<string, string>
  const processes: LifecycleProcess[] = []
  const calls: Parameters<typeof PiRpcProcess.spawn>[0][] = []
  const spawn = t.mock.method(PiRpcProcess, 'spawn', async (opts: Parameters<typeof PiRpcProcess.spawn>[0]) => {
    calls.push(opts)
    const proc = new LifecycleProcess(file)
    processes.push(proc)
    return proc as unknown as PiRpcProcess
  })
  t.after(() => {
    agent.dispose()
    spawn.mock.restore()
    rmSync(root, { recursive: true, force: true })
    if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir
  })
  return { root, file, cwds, conn, agent, processes, calls }
}

test('lifecycle capabilities advertise resume and close', async t => {
  const { agent } = fixture(t)
  const result = await agent.initialize({ protocolVersion: PROTOCOL_VERSION })
  assert.deepEqual(result.agentCapabilities?.sessionCapabilities?.resume, {})
  assert.deepEqual(result.agentCapabilities?.sessionCapabilities?.close, {})
})

test('resume restores with requested cwd/MCP and configuration without history or startup notifications', async t => {
  const { agent, root, file, cwds, calls, processes, conn } = fixture(t)
  const cwd = join(root, 'other')
  mkdirSync(cwd)
  const mcpServers: McpServer[] = [{ name: 'test-server', command: 'echo', args: [], env: [] }]
  const response = await agent.resumeSession({ sessionId: 'lifecycle', cwd, mcpServers })
  assert.equal(response.modes?.currentModeId, 'medium')
  assert.equal(response.configOptions?.find(option => option.id === 'model')?.currentValue, 'test/model')
  assert.equal(calls[0]?.cwd, cwd)
  assert.equal(calls[0]?.sessionPath, file)
  assert.deepEqual(calls[0]?.mcpInjection?.serverNames, ['test-server'])
  assert.equal(cwds.get('lifecycle'), cwd)
  assert.equal(processes[0]?.historyReads, 1)
  assert.deepEqual(conn.updates, [])
  assert.equal('models' in response, false)
  await agent.resumeSession({ sessionId: 'lifecycle', cwd, mcpServers })
  assert.equal(calls.length, 1)
  assert.equal(processes[0]?.historyReads, 1)
  assert.equal(processes[0]?.disposeCount, 0)
})

test('live resume rejects cwd/MCP changes without closing or replacing the process', async t => {
  const { agent, root, calls, processes } = fixture(t)
  await agent.resumeSession({ sessionId: 'lifecycle', cwd: root })
  await assert.rejects(agent.resumeSession({ sessionId: 'lifecycle', cwd: join(root, 'other') }), { code: -32602 })
  await assert.rejects(
    agent.resumeSession({
      sessionId: 'lifecycle',
      cwd: root,
      mcpServers: [{ name: 'changed', command: 'echo', args: [], env: [] }]
    }),
    (err: unknown) => err instanceof RequestError && err.code === -32602
  )
  assert.equal(calls.length, 1)
  assert.equal(processes[0]?.disposeCount, 0)
})

test('resume validates cwd and unknown IDs without spawning', async t => {
  const { agent, root, calls } = fixture(t)
  await assert.rejects(agent.resumeSession({ sessionId: 'lifecycle', cwd: 'relative' }), { code: -32602 })
  await assert.rejects(agent.resumeSession({ sessionId: 'missing-lifecycle', cwd: root }), { code: -32602 })
  assert.equal(calls.length, 0)
})

test('failed resume configuration closes only a newly restored process and preserves persistence', async t => {
  const { agent, root, file, processes, cwds } = fixture(t)
  const first = agent.resumeSession({ sessionId: 'lifecycle', cwd: root })
  processes[0]!.failConfiguration = true
  await assert.rejects(first, /configuration failed/)
  assert.equal(processes[0]?.disposeCount, 1)
  assert.equal(existsSync(file), true)
  assert.ok(cwds.get('lifecycle'))
  await agent.resumeSession({ sessionId: 'lifecycle', cwd: root })
  processes[1]!.failConfiguration = true
  await assert.rejects(agent.resumeSession({ sessionId: 'lifecycle', cwd: root }), /configuration failed/)
  assert.equal(processes[1]?.disposeCount, 0)
})

test(
  'close cancels active and queued turns without waiting for a hung abort, and retains history',
  { timeout: 2000 },
  async t => {
    const { agent, root, file, cwds, processes, calls } = fixture(t)
    await agent.resumeSession({ sessionId: 'lifecycle', cwd: root })
    const first = agent.prompt({ sessionId: 'lifecycle', prompt: [{ type: 'text', text: 'first' }] })
    const queued = agent.prompt({ sessionId: 'lifecycle', prompt: [{ type: 'text', text: 'queued' }] })
    await agent.closeSession({ sessionId: 'lifecycle' })
    assert.equal((await first).stopReason, 'cancelled')
    assert.equal((await queued).stopReason, 'cancelled')
    assert.equal(processes[0]?.disposeCount, 1)
    assert.ok(cwds.get('lifecycle'))
    assert.equal(existsSync(file), true)
    await agent.closeSession({ sessionId: 'lifecycle' })
    await agent.closeSession({ sessionId: 'unknown-lifecycle' })
    assert.equal(calls.length, 1)
    await agent.resumeSession({ sessionId: 'lifecycle', cwd: root })
    assert.equal(calls.length, 2)
  }
)

test(
  'delete disposes before unlinking persistence without waiting for a hung abort and is idempotent',
  { timeout: 2000 },
  async t => {
    const { agent, root, file, cwds, processes } = fixture(t)
    await agent.resumeSession({ sessionId: 'lifecycle', cwd: root })
    assert.deepEqual(await agent.deleteSession({ sessionId: 'lifecycle' }), {})
    assert.equal(processes[0]?.disposeCount, 1)
    assert.equal(processes[0]?.fileAtDispose, true)
    assert.equal(existsSync(file), false)
    assert.equal(cwds.has('lifecycle'), false)
    assert.deepEqual(await agent.deleteSession({ sessionId: 'lifecycle' }), {})
  }
)

test('delete reports unlink failure and keeps mapping for retry after closing process', async t => {
  const { agent, root, file, cwds, processes } = fixture(t)
  await agent.resumeSession({ sessionId: 'lifecycle', cwd: root })
  rmSync(file)
  mkdirSync(file)
  await assert.rejects(agent.deleteSession({ sessionId: 'lifecycle' }), /Failed to delete session/)
  assert.equal(processes[0]?.disposeCount, 1)
  assert.ok(cwds.get('lifecycle'))
  rmSync(file, { recursive: true })
  assert.deepEqual(await agent.deleteSession({ sessionId: 'lifecycle' }), {})
  assert.equal(cwds.has('lifecycle'), false)
})

test('load replays message IDs, thoughts, and failed tool status consistently', async t => {
  const { agent, root, conn } = fixture(t)
  t.mock.method(LifecycleProcess.prototype, 'getMessages', async () => ({
    messages: [
      { role: 'user', timestamp: 10, content: [{ type: 'text', text: 'question' }] },
      {
        role: 'assistant',
        timestamp: 11,
        content: [
          { type: 'thinking', thinking: 'reasoning' },
          { type: 'text', text: 'answer' }
        ]
      },
      {
        role: 'toolResult',
        toolName: 'bash',
        toolCallId: 'failed-tool',
        isError: true,
        content: [{ type: 'text', text: 'failed' }]
      }
    ]
  }))
  await agent.loadSession({ sessionId: 'lifecycle', cwd: root, mcpServers: [] })
  const messages = conn.updates
    .map(u => u.update)
    .filter(
      u =>
        u.sessionUpdate === 'user_message_chunk' ||
        u.sessionUpdate === 'agent_message_chunk' ||
        u.sessionUpdate === 'agent_thought_chunk'
    )
  assert.deepEqual(
    messages.map(u => [u.sessionUpdate, u.messageId]),
    [
      ['user_message_chunk', 'pi-acp:user:10:1'],
      ['agent_thought_chunk', 'pi-acp:assistant:11:1:thought'],
      ['agent_message_chunk', 'pi-acp:assistant:11:1']
    ]
  )
  const calls = conn.updates
    .map(u => u.update)
    .filter(u => u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update')
  assert.deepEqual(
    calls.map(u => u.status),
    ['failed', 'failed']
  )
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession, SessionManager } from '../../src/acp/session.js'
import { maybeAuthRequiredError } from '../../src/acp/auth-required.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function fixture() {
  const proc = new FakePiRpcProcess()
  const conn = new FakeAgentSideConnection()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as never,
    conn: asAgentConn(conn),
    clientCapabilities: { auth: { terminal: true }, session: { compaction: {} } }
  })
  return { session, conn, proc }
}

test('final provider errors fail the prompt instead of returning end_turn', async () => {
  const { session, proc } = fixture()
  const prompt = session.prompt('work')
  const rejected = assert.rejects(prompt, { code: -32603 })
  proc.emit({
    type: 'message_end',
    message: { role: 'assistant', timestamp: 42, stopReason: 'error', errorMessage: 'upstream overloaded' }
  })
  await Promise.resolve()
  proc.emit({ type: 'agent_settled' })
  await rejected
  session.dispose()
})

test('a successful retry replaces the previous error outcome', async () => {
  const { session, proc } = fixture()
  const prompt = session.prompt('work')
  proc.emit({
    type: 'message_end',
    message: { role: 'assistant', timestamp: 42, stopReason: 'error', errorMessage: 'retryable failure' }
  })
  proc.emit({ type: 'message_end', message: { role: 'assistant', timestamp: 43, stopReason: 'stop' } })
  await Promise.resolve()
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  session.dispose()
})

test('pi length stop reason maps to ACP max_tokens', async () => {
  const { session, proc } = fixture()
  const prompt = session.prompt('work')
  proc.emit({ type: 'message_end', message: { role: 'assistant', timestamp: 42, stopReason: 'length' } })
  await Promise.resolve()
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'max_tokens')
  session.dispose()
})

test('dead sessions are evicted so a replacement can be registered', async () => {
  const manager = new SessionManager()
  const proc = new FakePiRpcProcess()
  const conn = asAgentConn(new FakeAgentSideConnection())
  const first = manager.getOrCreate('s1', { cwd: process.cwd(), mcpServers: [], conn, proc: proc as never })
  const prompt = first.prompt('work')
  proc.emit({ type: 'pi_acp_process_error', message: 'pi exited' })
  assert.equal(await prompt, 'error')
  assert.equal(manager.maybeGet('s1'), undefined)
  const replacement = manager.getOrCreate('s1', {
    cwd: process.cwd(),
    mcpServers: [],
    conn,
    proc: new FakePiRpcProcess() as never
  })
  assert.notEqual(replacement, first)
  assert.equal(replacement.isDisposed(), false)
  manager.disposeAll()
})

test('manual compaction cancellation aborts pi and emits cancelled status', async () => {
  const { session, proc, conn } = fixture()
  const controller = new AbortController()
  let rejectCompact!: (error: Error) => void
  Object.assign(proc, {
    compact: () =>
      new Promise((_resolve, reject) => {
        rejectCompact = reject
      })
  })
  const abort = proc.abort.bind(proc)
  proc.abort = async () => {
    await abort()
    rejectCompact(new Error('aborted compaction'))
  }
  const compact = session.compact(undefined, controller.signal)
  controller.abort()
  assert.deepEqual(await compact, { cancelled: true })
  assert.equal(proc.abortCount, 1)
  const updates = conn.updates.map(u => u.update).filter(u => u.sessionUpdate === 'compaction_update')
  assert.deepEqual(
    updates.map(u => u.status),
    ['in_progress', 'cancelled']
  )
  assert.equal(session.isTurnActive(), false)
  session.dispose()
})

test('auth-required errors keep negotiated terminal login methods', () => {
  const error = maybeAuthRequiredError(new Error('missing API key'), { auth: { terminal: true } })
  assert.equal(error?.code, -32000)
  assert.deepEqual(
    (error?.data as { authMethods: Array<{ type?: string; args?: string[] }> }).authMethods.map(m => [m.type, m.args]),
    [['terminal', ['--terminal-login']]]
  )
})

for (const action of ['cancel', 'close'] as const) {
  test(`session ${action} cancels manual compaction without a request signal`, async () => {
    const { session, proc } = fixture()
    let rejectCompact!: (error: Error) => void
    Object.assign(proc, {
      compact: () =>
        new Promise((_resolve, reject) => {
          rejectCompact = reject
        })
    })
    const abort = proc.abort.bind(proc)
    proc.abort = async () => {
      await abort()
      rejectCompact(new Error('compaction aborted'))
    }
    const dispose = proc.dispose.bind(proc)
    proc.dispose = () => {
      dispose()
      rejectCompact(new Error('process closed'))
    }
    const compact = session.compact()
    if (action === 'cancel') await session.cancel()
    else session.dispose()
    assert.deepEqual(await compact, { cancelled: true })
    session.dispose()
  })
}

test('prompts queue behind manual compaction and survive its request cancellation', async () => {
  const { session, proc } = fixture()
  const controller = new AbortController()
  let rejectCompact!: (error: Error) => void
  Object.assign(proc, {
    compact: () =>
      new Promise((_resolve, reject) => {
        rejectCompact = reject
      })
  })
  const abort = proc.abort.bind(proc)
  proc.abort = async () => {
    await abort()
    rejectCompact(new Error('compaction aborted'))
  }
  const compact = session.compact(undefined, controller.signal)
  const prompt = session.prompt('next request')
  assert.equal(proc.prompts.length, 0)
  controller.abort()
  assert.deepEqual(await compact, { cancelled: true })
  assert.equal(proc.prompts.length, 1)
  assert.equal(proc.abortCount, 1)
  await Promise.resolve()
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  session.dispose()
})

test('native compaction cancellation is retained without an ACP cancel signal', async () => {
  const { session, proc } = fixture()
  Object.assign(proc, {
    compact: async () => {
      proc.emit({ type: 'compaction_end', reason: 'manual', aborted: true })
      throw new Error('native compaction aborted')
    }
  })
  assert.deepEqual(await session.compact(), { cancelled: true })
  session.dispose()
})

test('unexpected pi death during compaction is an error, not cancellation', async () => {
  const { session, proc } = fixture()
  let rejectCompact!: (error: Error) => void
  Object.assign(proc, {
    compact: () =>
      new Promise((_resolve, reject) => {
        rejectCompact = reject
      })
  })
  const dispose = proc.dispose.bind(proc)
  proc.dispose = () => {
    dispose()
    rejectCompact(new Error('pi crashed during compaction'))
  }
  const compact = session.compact()
  const rejected = assert.rejects(compact, /pi crashed during compaction/)
  proc.emit({ type: 'pi_acp_process_error', message: 'pi crashed' })
  await rejected
  session.dispose()
})

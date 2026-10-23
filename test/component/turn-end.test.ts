import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession, type TurnSummary, type TurnUsage } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

type TurnOut = { usage?: TurnUsage; summary?: TurnSummary; error?: string }

function setup() {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as never,
    conn: asAgentConn(conn)
  })
  return { conn, proc, session }
}

const started = async (proc: FakePiRpcProcess) => {
  for (let i = 0; i < 20 && proc.prompts.length === 0; i++) await new Promise(resolve => setImmediate(resolve))
}

test('a rejected prompt carries pi reason to the client in the request error', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.promptError = new Error('pi prompt failed: no model selected')
  const agent = new PiAcpAgent(asAgentConn(conn))
  const sessions = Reflect.get(agent, 'sessions') as {
    getOrCreate(id: string, params: unknown): PiAcpSession
    disposeAll(): void
  }
  sessions.getOrCreate('s1', { cwd: process.cwd(), mcpServers: [], conn: asAgentConn(conn), proc })

  await assert.rejects(
    agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'hi' }] } as never),
    (err: { code?: number; message?: string; data?: { reason?: string } }) =>
      err.code === -32603 &&
      String(err.message).includes('pi prompt failed: no model selected') &&
      err.data?.reason === 'pi prompt failed: no model selected'
  )
  sessions.disposeAll()
})

test('a crash mid-turn reports the last message_end error, else the exit report', async () => {
  for (const withLastWords of [true, false]) {
    const { proc, session } = setup()
    const out: TurnOut = {}
    const turn = session.prompt('hi', [], undefined, undefined, out)
    await started(proc)
    if (withLastWords)
      proc.emit({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'error', errorMessage: '529 overloaded', usage: {} }
      })
    proc.emit({ type: 'pi_acp_process_error', message: 'pi process exited (code=1, signal=null)' })
    assert.equal(await turn, 'error')
    assert.equal(out.error, withLastWords ? '529 overloaded' : 'pi process exited (code=1, signal=null)')
  }
})

test('agent_settled with aborted:true and no client cancel ends the turn cancelled, flagged in the summary', async () => {
  const { proc, session } = setup()
  const out: TurnOut = {}
  const turn = session.prompt('hi', [], undefined, undefined, out)
  await started(proc)
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled', aborted: true })
  assert.equal(await turn, 'cancelled')
  assert.equal(out.summary?.aborted, true)
  assert.equal(out.summary?.stopReason, 'cancelled')
})

test('auto_retry_end with success:false reports finalError', async () => {
  const { conn, proc, session } = setup()
  const turn = session.prompt('hi')
  await started(proc)
  proc.emit({ type: 'auto_retry_end', success: false, attempt: 3, finalError: '529 overloaded' })
  proc.emit({ type: 'auto_retry_end', success: true, attempt: 2 })
  proc.emit({ type: 'agent_settled' })
  await turn
  const texts = conn.updates
    .map((u: any) => u.update)
    .filter((u: any) => u.sessionUpdate === 'agent_message_chunk')
    .map((u: any) => u.content.text)
  assert.deepEqual(texts, ['Retry failed: 529 overloaded', 'Retry finished, resuming.'])
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { listPiSessions } from '../../src/acp/pi-sessions.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'
import { piSessionDir } from '../helpers/session-files.js'

class RestoredPiProcess extends FakePiRpcProcess {
  readonly assignedNames: string[] = []

  async setSessionName(name: string): Promise<void> {
    this.assignedNames.push(name)
  }

  override async getState() {
    return { thinkingLevel: 'medium' }
  }

  override async getMessages() {
    return { messages: [{ role: 'user', content: 'Later message after compaction' }] }
  }
}

for (const mode of ['load', 'prompt'] as const) {
  for (const titleState of ['saved', 'fallback', 'cleared', 'cleared-in-tail'] as const) {
    test(`PiAcpAgent: ${mode} restores ${titleState} title without renaming history`, async t => {
      const root = mkdtempSync(join(tmpdir(), 'pi-acp-restored-title-'))
      const sessionsDir = piSessionDir(root, root)
      const sessionFile = join(sessionsDir, '2026-01-01T00-00-00-000Z_restored.jsonl')
      mkdirSync(sessionsDir, { recursive: true })
      const firstContent = [
        { type: 'text', text: '  Original \n' },
        { type: 'image', data: 'ignored' },
        { type: 'text', text: '🚀'.repeat(90) }
      ]
      const history = [
        { type: 'session', version: 3, id: 'restored', cwd: root },
        { type: 'message', message: { role: 'user', content: '  \n' } },
        { type: 'message', message: { role: 'user', content: [{ type: 'image', data: 'ignored' }] } },
        { type: 'message', message: { role: 'user', content: firstContent } },
        ...(titleState !== 'fallback' ? [{ type: 'session_info', name: 'Saved title' }] : []),
        ...(titleState === 'cleared' ? [{ type: 'session_info', name: '' }] : []),
        ...Array.from({ length: 2100 }, () => ({
          type: 'message',
          timestamp: '2026-01-01T00:00:00.000Z',
          message: { role: 'assistant', content: 'x'.repeat(200) }
        })),
        ...(titleState === 'cleared-in-tail' ? [{ type: 'session_info', name: '' }] : [])
      ]
        .map(entry => JSON.stringify(entry))
        .join('\n')
      writeFileSync(sessionFile, history)
      const expectedTitle = titleState === 'saved' ? 'Saved title' : 'Original ' + '🚀'.repeat(71)
      const previousAgentDir = process.env.PI_CODING_AGENT_DIR
      process.env.PI_CODING_AGENT_DIR = root
      t.after(() => {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir
        rmSync(root, { recursive: true, force: true })
      })

      const conn = new FakeAgentSideConnection()
      const agent = new PiAcpAgent(asAgentConn(conn))
      const proc = new RestoredPiProcess()
      t.mock.method(PiRpcProcess, 'spawn', async () => proc as unknown as PiRpcProcess)
      t.after(() => agent.dispose())

      if (mode === 'load') {
        await agent.loadSession({ sessionId: 'restored', cwd: root, mcpServers: [] })
      } else {
        // A prompt restores a session this adapter already knows (loaded, then closed or crashed).
        Reflect.get(agent, 'cwds').set('restored', root)
        const prompt = agent.prompt({ sessionId: 'restored', prompt: [{ type: 'text', text: 'Continue work' }] })
        await new Promise(resolve => setImmediate(resolve))
        proc.emit({ type: 'agent_settled' })
        assert.equal((await prompt).stopReason, 'end_turn')
      }
      await new Promise(resolve => setTimeout(resolve, 0))

      const titleUpdates = conn.updates.filter(update => 'title' in update.update)
      assert.deepEqual(titleUpdates, [
        { sessionId: 'restored', update: { sessionUpdate: 'session_info_update', title: expectedTitle } }
      ])
      assert.equal(listPiSessions().find(session => session.sessionId === 'restored')?.title, expectedTitle)
      assert.deepEqual(proc.assignedNames, [])
      assert.equal(readFileSync(sessionFile, 'utf8'), history)
    })
  }
}

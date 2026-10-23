import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { getPiSessionDirForCwd } from '../../src/acp/pi-sessions.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

// Real pi behind PI_ACP_REAL_PI=1 (spends one tiny model call per test). The suite isolates
// HOME (test/helpers/isolate-home.ts); the argv wrapper hands pi the real one for its
// credentials. Sessions go to a temp PI_CODING_AGENT_SESSION_DIR. Run it through `npm test`.
// Model: PI_ACP_REAL_PI_MODEL (default zai/glm-5.3), thinking off.
const enabled = process.env.PI_ACP_REAL_PI === '1'
const model = process.env.PI_ACP_REAL_PI_MODEL ?? 'zai/glm-5.3'

function piCli(): string {
  if (process.env.PI_ACP_PI_COMMAND) return process.env.PI_ACP_PI_COMMAND
  const dir = execFileSync('mise', ['where', 'npm:@earendil-works/pi-coding-agent'], { encoding: 'utf8' }).trim()
  return join(dir, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js')
}

// Resolved once, before any test points PI_ACP_PI_COMMAND at the argv wrapper.
const realPi = enabled ? piCli() : ''

// pi sets process.title, so ps cannot show its argv; a wrapper records it.
const wrapper = fileURLToPath(new URL('../fixtures/record-argv.sh', import.meta.url))

test(
  'real pi: launch flags reach pi argv and the turn result carries usage',
  { skip: !enabled, timeout: 120_000 },
  async t => {
    const scratch = mkdtempSync(join(tmpdir(), 'pi-acp-real-'))
    const argvFile = join(scratch, 'argv.txt')
    process.env.RECORD_ARGV_TARGET = realPi
    process.env.RECORD_ARGV_FILE = argvFile
    process.env.PI_ACP_PI_COMMAND = wrapper
    process.env.PI_CODING_AGENT_SESSION_DIR = join(scratch, 'sessions')
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    let sessionId: string | undefined
    try {
      await agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as any)
      const created = await agent.newSession({
        cwd: scratch,
        mcpServers: [],
        _meta: {
          piAcp: { launch: ['-ne', '--model', model, '--thinking', 'off', '--no-tools'], headless: true },
          systemPrompt: { append: 'You answer with one word.' }
        }
      } as any)
      sessionId = created.sessionId
      const argv = readFileSync(argvFile, 'utf8').trim().split('\n')
      assert.deepEqual(argv.slice(0, 9), [
        '--mode',
        'rpc',
        '--no-themes',
        '-ne',
        '--model',
        model,
        '--thinking',
        'off',
        '--no-tools'
      ])
      assert.equal(argv[9], '--append-system-prompt')
      assert.match(argv[10]!, /prompt\.md$/)

      const res = await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'Reply with exactly: PONG' }] } as any)
      assert.equal(res.stopReason, 'end_turn')
      const summary = (res._meta as any)?.piAcp
      assert.ok(summary.usage.input > 0, JSON.stringify(summary))
      assert.ok(summary.usage.output > 0, JSON.stringify(summary))
      assert.equal(summary.aborted, false)
      t.diagnostic(`argv: ${argv.join(' ')}`)
      t.diagnostic(`summary: ${JSON.stringify(summary)}`)
      const text = conn.updates
        .map((u: any) => u.update)
        .filter((u: any) => u.sessionUpdate === 'agent_message_chunk')
        .map((u: any) => u.content.text)
        .join('')
      assert.match(text, /PONG/)
    } finally {
      if (sessionId) {
        await agent.closeSession({ sessionId } as any).catch(() => {})
      }
      agent.dispose()
      // Real pi wrote a session file under scratch; remove it with the scratch dir.
      rmSync(scratch, { recursive: true, force: true })
    }
  }
)

function useEnv(env: Record<string, string | undefined>): () => void {
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test(
  'real pi: session file naming matches the adapter derivation (default and flat layout)',
  { skip: !enabled, timeout: 60_000 },
  async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'pi-acp-real-naming-'))
    const cwd = join(scratch, 'work space')
    mkdirSync(cwd)
    try {
      for (const sessionDir of [undefined, join(scratch, 'flat')]) {
        const restore = useEnv({ PI_CODING_AGENT_DIR: join(scratch, 'agent'), PI_CODING_AGENT_SESSION_DIR: sessionDir })
        const proc = await PiRpcProcess.spawn({ cwd, piCommand: realPi, launchArgs: ['-ne'] })
        try {
          const state = (await proc.getState()) as { sessionFile?: string }
          assert.equal(dirname(state.sessionFile!), getPiSessionDirForCwd(cwd), `layout ${sessionDir ?? 'default'}`)
        } finally {
          proc.dispose()
          restore()
        }
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
)

test('real pi: a session created through pi resumes by id + cwd', { skip: !enabled, timeout: 120_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'pi-acp-real-resume-'))
  const restore = useEnv({
    // The wrapper hands pi the real HOME for its credentials.
    PI_ACP_PI_COMMAND: wrapper,
    RECORD_ARGV_TARGET: realPi,
    RECORD_ARGV_FILE: join(scratch, 'argv.txt'),
    PI_CODING_AGENT_SESSION_DIR: join(scratch, 'sessions')
  })
  const launch = ['-ne', '--model', model, '--thinking', 'off', '--no-tools']
  const first = new FakeAgentSideConnection()
  const firstAgent = new PiAcpAgent(asAgentConn(first))
  let sessionId: string | undefined
  try {
    await firstAgent.initialize({ protocolVersion: 1, clientCapabilities: {} } as any)
    const created = await firstAgent.newSession({
      cwd: scratch,
      mcpServers: [],
      _meta: { piAcp: { launch, headless: true } }
    } as any)
    sessionId = created.sessionId
    await firstAgent.prompt({ sessionId, prompt: [{ type: 'text', text: 'Reply with exactly: PONG' }] } as any)
    await firstAgent.closeSession({ sessionId } as any)
    firstAgent.dispose()

    // A fresh adapter has no memory of the session: only id + cwd.
    const second = new FakeAgentSideConnection()
    const secondAgent = new PiAcpAgent(asAgentConn(second))
    try {
      await secondAgent.loadSession({
        sessionId,
        cwd: scratch,
        mcpServers: [],
        _meta: { piAcp: { launch, headless: true } }
      } as any)
      const replayed = second.updates
        .map((u: any) => u.update)
        .filter((u: any) => u.sessionUpdate === 'user_message_chunk')
        .map((u: any) => u.content.text)
      assert.deepEqual(replayed, ['Reply with exactly: PONG'])
      await assert.rejects(
        secondAgent.resumeSession({ sessionId: 'no-such-session', cwd: scratch, mcpServers: [] } as any),
        (err: Error) => err.message.includes('no-such-session') && err.message.includes(join(scratch, 'sessions'))
      )
    } finally {
      secondAgent.dispose()
    }
  } finally {
    firstAgent.dispose()
    restore()
    rmSync(scratch, { recursive: true, force: true })
  }
})

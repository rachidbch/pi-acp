import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

// Agent-level runs against a real pi subprocess (scripted fake pi): launch flags, system
// prompt file, capability advertisement, headless stream and the per-turn summary.

const fakePi = fileURLToPath(new URL('../fixtures/fake-pi-turn.mjs', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'pi-acp-launch-'))
const argvFile = join(scratch, 'argv.json')
// The adapter store lives under HOME; keep it out of the real one.
process.env.HOME = scratch
process.env.PI_ACP_PI_COMMAND = fakePi
process.env.PI_CODING_AGENT_SESSION_DIR = join(scratch, 'sessions')
process.env.FAKE_PI_ARGV_FILE = argvFile

const readArgv = (): string[] => JSON.parse(readFileSync(argvFile, 'utf8')).argv
const flagValue = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1]

const LAUNCH = ['-ne', '-e', '/abs/ext.ts', '--model', 'fake/fake-model', '--thinking', 'low']

async function newAgent(t: TestContext) {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  t.after(() => agent.dispose())
  const init = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as any)
  return { conn, agent, init }
}

test('initialize advertises launch, systemPrompt, headless and trustedParent under agentCapabilities._meta.piAcp', async t => {
  const { init } = await newAgent(t)
  const piAcp = (init.agentCapabilities?._meta as any)?.piAcp
  assert.ok(piAcp.launch.flags.includes('-ne'))
  assert.deepEqual(piAcp.systemPrompt.modes, ['append', 'replace'])
  assert.equal(piAcp.headless, true)
  assert.equal(piAcp.trustedParent, true)
})

test('session/new passes allowlisted flags and the system prompt file to pi; the file goes with the child', async t => {
  const { agent } = await newAgent(t)
  const res = await agent.newSession({
    cwd: scratch,
    mcpServers: [],
    _meta: { piAcp: { launch: LAUNCH, headless: true, trustedParent: true }, systemPrompt: { append: 'PERSONA-BODY' } }
  } as any)
  const argv = readArgv()
  assert.deepEqual(argv.slice(0, 3), ['--mode', 'rpc', '--no-themes'])
  assert.deepEqual(argv.slice(3, 3 + LAUNCH.length), LAUNCH)
  const promptFile = flagValue(argv, '--append-system-prompt')
  assert.equal(readFileSync(promptFile, 'utf8'), 'PERSONA-BODY')
  const session = (Reflect.get(agent, 'sessions') as any).get(res.sessionId)
  assert.equal(session.trustedParent, true)
  await agent.closeSession({ sessionId: res.sessionId } as any)
  for (let i = 0; i < 50 && existsSync(promptFile); i++) await new Promise(r => setTimeout(r, 20))
  assert.equal(existsSync(promptFile), false, 'prompt file removed on child exit')
})

test('session/new rejects an adapter-owned flag before spawning pi', async t => {
  const { agent } = await newAgent(t)
  await assert.rejects(
    agent.newSession({ cwd: scratch, mcpServers: [], _meta: { piAcp: { launch: ['--session', 'x'] } } } as any),
    (err: any) => err?.code === -32602
  )
})

for (const [initial, requested] of [
  [true, false],
  [false, true]
] as const) {
  test(`resume rejects trustedParent change ${initial} -> ${requested} without mutating remembered launch`, async t => {
    const { agent } = await newAgent(t)
    const metadata = { piAcp: { trustedParent: initial } }
    const { sessionId } = await agent.newSession({ cwd: scratch, mcpServers: [], _meta: metadata } as any)
    const launches = Reflect.get(agent, 'launches') as Map<string, { trustedParent: boolean }>

    await assert.rejects(
      agent.resumeSession({
        sessionId,
        cwd: scratch,
        mcpServers: [],
        _meta: { piAcp: { trustedParent: requested } }
      } as any),
      (error: any) =>
        error?.code === -32602 &&
        error?.data === 'Close the session before resuming with a different trustedParent value'
    )
    assert.equal(launches.get(sessionId)?.trustedParent, initial)
  })
}

test('resume and a crash-style restore relaunch pi with the same flags', async t => {
  const { agent } = await newAgent(t)
  const meta = { piAcp: { launch: LAUNCH }, systemPrompt: 'REPLACED' }
  const { sessionId } = await agent.newSession({ cwd: scratch, mcpServers: [], _meta: meta } as any)
  await agent.closeSession({ sessionId } as any)
  // The fake pi writes no session file; resume finds one by id + cwd in the session dir.
  mkdirSync(join(scratch, 'sessions'), { recursive: true })
  writeFileSync(join(scratch, 'sessions', `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`), '')

  await agent.resumeSession({ sessionId, cwd: scratch, mcpServers: [], _meta: meta } as any)
  let argv = readArgv()
  assert.deepEqual(argv.slice(3, 3 + LAUNCH.length), LAUNCH)
  assert.ok(argv.includes('--system-prompt'))
  assert.ok(argv.includes('--session'))

  // Without _meta (prompt on a closed session = on-demand restore), the remembered launch applies.
  await agent.closeSession({ sessionId } as any)
  await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] } as any)
  argv = readArgv()
  assert.deepEqual(argv.slice(3, 3 + LAUNCH.length), LAUNCH)
})

test('headless: no banner or text notices in the stream; prompt result carries the _meta.piAcp summary', async t => {
  const { agent, conn } = await newAgent(t)
  const { sessionId } = await agent.newSession({
    cwd: scratch,
    mcpServers: [],
    _meta: { piAcp: { headless: true } }
  } as any)
  const res = await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] } as any)
  await new Promise(r => setTimeout(r, 50))
  const texts = conn.updates
    .map((u: any) => u.update)
    .filter((u: any) => u.sessionUpdate === 'agent_message_chunk')
    .map((u: any) => u.content.text)
  assert.deepEqual(texts, ['FAKE-REPLY'], 'only model output in the message stream')
  assert.equal(res.stopReason, 'end_turn')
  assert.deepEqual((res._meta as any)?.piAcp, {
    stopReason: 'end_turn',
    aborted: false,
    retries: 0,
    compactions: 0,
    usage: { input: 120, output: 7, cacheRead: 30, cacheWrite: 4, cost: 0.0022 }
  })
})

test('not headless: the startup banner still reaches the stream', async t => {
  // Version probes may find nothing in a sandbox; the banner's content sections carry the signal.
  const promptsDir = join(scratch, '.pi', 'agent', 'prompts')
  mkdirSync(promptsDir, { recursive: true })
  writeFileSync(join(promptsDir, 'demo.md'), 'demo prompt body')
  const { agent, conn } = await newAgent(t)
  await agent.newSession({ cwd: scratch, mcpServers: [] } as any)
  await new Promise(r => setTimeout(r, 50))
  const banner = conn.updates.some(
    (u: any) => u.update.sessionUpdate === 'agent_message_chunk' && /\/demo/.test(u.update.content?.text ?? '')
  )
  assert.ok(banner)
})

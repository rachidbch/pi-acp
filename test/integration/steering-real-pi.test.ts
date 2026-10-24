import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PiAcpSession } from '../../src/acp/session.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

const enabled = process.env.PI_ACP_REAL_PI === '1'
const model = process.env.PI_ACP_REAL_PI_MODEL ?? 'zai/glm-5.3'
const fixture = fileURLToPath(new URL('../fixtures/steering-extension.ts', import.meta.url))
const wrapper = fileURLToPath(new URL('../fixtures/record-argv.sh', import.meta.url))

for (const window of ['start', 'tool', 'settle', 'extension'] as const) {
  test(`real pi steering: ${window} stays inside one ACP turn`, { skip: !enabled, timeout: 120_000 }, async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'steering-real-'))
    const realPi = join(
      execFileSync('mise', ['where', 'npm:@earendil-works/pi-coding-agent'], { encoding: 'utf8' }).trim(),
      'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'
    )
    const env = {
      RECORD_ARGV_TARGET: realPi,
      RECORD_ARGV_FILE: join(scratch, 'argv'),
      PI_CODING_AGENT_SESSION_DIR: join(scratch, 'sessions')
    }
    const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
    Object.assign(process.env, env)
    const proc = await PiRpcProcess.spawn({
      cwd: scratch,
      piCommand: wrapper,
      launchArgs: ['-ne', '-e', fixture, '--model', model, '--thinking', 'off', '--tools', 'bash']
    })
    const conn = new FakeAgentSideConnection()
    const prompts: string[] = []
    const leftovers: string[] = []
    const originalPrompt = proc.prompt.bind(proc)
    proc.prompt = (...args) => {
      prompts.push(args[0])
      return originalPrompt(...args)
    }
    const originalClear = proc.clearQueue.bind(proc)
    proc.clearQueue = async () => {
      const queue = await originalClear()
      leftovers.push(...queue.steering)
      return queue
    }
    const session = new PiAcpSession({
      sessionId: 'steering-real',
      cwd: scratch,
      mcpServers: [],
      proc,
      conn: asAgentConn(conn),
      headless: true
    })
    let injected: Promise<unknown> | undefined
    const unsubscribe = proc.onEvent(event => {
      if (injected) return
      if (
        ((window === 'tool' || window === 'extension') && event.type === 'tool_execution_start') ||
        (window === 'settle' && event.type === 'agent_end')
      ) {
        injected = session.steer(window === 'extension' ? 'EXTENSION_TRIGGER' : 'Reply exactly: STEER_APPLIED')
      }
    })
    try {
      const result = session.prompt(
        window === 'tool' || window === 'extension'
          ? 'Call bash with "sleep 1", then reply ORIGINAL.'
          : 'Reply exactly: ORIGINAL'
      )
      if (window === 'start') injected = session.steer('Reply exactly: STEER_APPLIED')
      assert.equal(await result, 'end_turn')
      assert.deepEqual(await injected, { outcome: 'injected' })
      const text = conn.updates
        .flatMap(update =>
          update.update.sessionUpdate === 'agent_message_chunk' && update.update.content.type === 'text'
            ? [update.update.content.text]
            : []
        )
        .join('')
      assert.match(text, window === 'extension' ? /EXTENSION_REPLAY/ : /STEER_APPLIED/)
      if (window === 'extension') {
        assert.ok(leftovers.includes('Reply exactly: EXTENSION_REPLAY'), JSON.stringify(leftovers))
        assert.ok(prompts.includes('Reply exactly: EXTENSION_REPLAY'), JSON.stringify(prompts))
      }
      assert.deepEqual(await session.steer('idle'), { outcome: 'promptRequired' })
    } finally {
      unsubscribe()
      session.dispose()
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { PiRpcProcess, type PiRpcEvent } from '../../src/pi-rpc/process.js'

const cwd = process.cwd()
const fixture = fileURLToPath(new URL('../fixtures/fake-pi.mjs', import.meta.url))

test('PiRpcProcess forwards pi stderr to the adapter stderr', { skip: process.platform === 'win32' }, async t => {
  const writes: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  t.after(() => {
    process.stderr.write = original
  })

  process.env.FAKE_PI_STDERR = '1'
  t.after(() => {
    delete process.env.FAKE_PI_STDERR
  })

  const proc = await PiRpcProcess.spawn({ cwd, piCommand: fixture })
  t.after(() => proc.dispose())

  assert.ok(
    writes.some(w => w.includes('[pi] fake pi diagnostic')),
    `expected a '[pi] fake pi diagnostic' line on adapter stderr, got: ${JSON.stringify(writes)}`
  )
})

test('PiRpcProcess requests fail fast after the pi child exits', { skip: process.platform === 'win32' }, async t => {
  const proc = await PiRpcProcess.spawn({ cwd, piCommand: fixture })
  t.after(() => proc.dispose())

  // The fixture responds and then exits; the exit event may still be in flight.
  await proc.getMessages()

  let error: unknown
  for (let i = 0; i < 100; i++) {
    try {
      await proc.getCommands()
      await new Promise(r => setTimeout(r, 10))
    } catch (e) {
      error = e
      break
    }
  }
  assert.match(String(error), /pi process exited/)
})

test('PiRpcProcess frames RPC records on LF only, keeping U+2028/U+2029 content intact',
  { skip: process.platform === 'win32' },
  async t => {
    const proc = await PiRpcProcess.spawn({ cwd, piCommand: fixture })
    t.after(() => proc.dispose())

    const events: PiRpcEvent[] = []
    proc.onEvent(ev => events.push(ev))

    // The fixture emits an event whose JSON text contains a raw U+2028; with
    // node's readline this splits into two unparseable fragments.
    await proc.getCommands()

    assert.equal(events.length, 1)
    const delta = (events[0] as { assistantMessageEvent?: { delta?: string } }).assistantMessageEvent?.delta
    assert.equal(delta, 'before\u2028after')
  }
)

test('PiRpcProcess request timeouts are tagged with ETIMEDOUT', { skip: process.platform === 'win32' }, async t => {
  const proc = await PiRpcProcess.spawn({ cwd, piCommand: fixture })
  t.after(() => proc.dispose())

  // The fixture only answers the spawn handshake's get_state; this one hangs.
  await assert.rejects(proc.getState(50), (err: unknown) => {
    const code = (err as { code?: string })?.code
    return code === 'ETIMEDOUT'
  })
})

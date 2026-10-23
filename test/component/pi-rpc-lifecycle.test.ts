import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { CONTROL_TIMEOUT_MS, PiRpcProcess, type PiRpcEvent } from '../../src/pi-rpc/process.js'

function makeFakeChild() {
  const stdout = new PassThrough()
  const child: any = new EventEmitter()
  child.stdout = stdout
  child.stderr = new PassThrough()
  child.killed = false
  child.kill = () => {}
  child.stdin = { write: (_line: string, cb?: (error?: Error | null) => void) => (cb?.(null), true) }
  return { child, stdout }
}

function makeProcess(child: any): PiRpcProcess {
  return new (PiRpcProcess as unknown as new (c: any) => PiRpcProcess)(child)
}

const tick = () => new Promise<void>(resolve => setImmediate(() => setImmediate(resolve)))

test('close detection: the child is reported dead on close, after its last stdout is read', async () => {
  const { child, stdout } = makeFakeChild()
  const proc = makeProcess(child)
  const events: PiRpcEvent[] = []
  proc.onEvent(ev => events.push(ev))

  // 'exit' alone does not end the child: its stdout may still hold the final words.
  child.emit('exit', 1, null)
  await tick()
  assert.equal(events.length, 0)

  const finalMessage = { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: '529' } }
  stdout.write(JSON.stringify(finalMessage)) // no trailing newline: pi died mid-write
  await tick()
  child.emit('close', 1, null)
  await tick()
  assert.deepEqual(
    events.map(ev => ev.type),
    ['message_end', 'pi_acp_process_error']
  )
  assert.match(String(events[1]!.message), /pi process exited \(code=1/)
})

test('control timeouts: control RPCs and the prompt acknowledgement time out', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { child } = makeFakeChild()
  const proc = makeProcess(child)

  const calls = [proc.getMessages(), proc.getCommands(), proc.abort(), proc.prompt('hi')].map(call =>
    assert.rejects(call, { code: 'ETIMEDOUT' })
  )
  t.mock.timers.tick(CONTROL_TIMEOUT_MS)
  await Promise.all(calls)
})

test(
  'group kill: dispose stops pi and its grandchildren, SIGKILL after the grace when SIGTERM is ignored',
  { skip: process.platform === 'win32', timeout: 10_000 },
  async () => {
    const pidsFile = join(mkdtempSync(join(tmpdir(), 'pi-acp-tree-')), 'pids.json')
    process.env.FAKE_PI_PIDS_FILE = pidsFile
    const proc = await PiRpcProcess.spawn({
      cwd: process.cwd(),
      piCommand: fileURLToPath(new URL('../fixtures/fake-pi-tree.mjs', import.meta.url)),
      killGraceMs: 100
    })
    delete process.env.FAKE_PI_PIDS_FILE
    const { pi, grandchild } = JSON.parse(readFileSync(pidsFile, 'utf8')) as { pi: number; grandchild: number }
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    assert.ok(alive(pi) && alive(grandchild))

    proc.dispose()
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(alive(pi), 'pi ignores SIGTERM, still alive inside the grace')
    assert.equal(alive(grandchild), false, 'the group got SIGTERM, so the grandchild is gone')

    const deadline = Date.now() + 3_000
    while (alive(pi) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(alive(pi), false, 'SIGKILL after the grace')
  }
)

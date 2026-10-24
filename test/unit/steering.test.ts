import test from 'node:test'
import assert from 'node:assert/strict'
import { Steering } from '../../src/acp/steering.js'

test('steering stops draining held messages after end or clear while an RPC is pending', async () => {
  for (const transition of ['end', 'clear'] as const) {
    const sent: string[] = []
    let release!: () => void
    const steering = new Steering(text => {
      sent.push(text)
      return new Promise(resolve => { release = () => resolve('queued') })
    })
    steering.start()
    await steering.inject('first')
    await steering.inject('second')
    const running = steering.running()
    if (transition === 'end') steering.ended()
    else steering.clear()
    release()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(sent, ['first'], transition)
    await running
    assert.deepEqual(await steering.leftovers(async () => ({ steering: [], followUp: [] })), transition === 'end' ? ['second'] : [])
  }
})

test('steering windows hold start, inject running, replay settle in pi order and clear cancel', async () => {
  const sent: string[] = []
  const steering = new Steering(async text => {
    sent.push(text)
    return 'queued'
  })
  steering.start()
  await steering.inject('start')
  assert.deepEqual(sent, [])
  await steering.running()
  assert.deepEqual(sent, ['start'])
  await steering.inject('active')
  steering.ended()
  await steering.inject('settle')
  assert.deepEqual(
    await steering.leftovers(async () => ({ steering: ['extension', 'active'], followUp: ['follow'] })),
    ['extension', 'active', 'settle', 'follow']
  )
  steering.clear()
  assert.deepEqual(await steering.leftovers(async () => ({ steering: [], followUp: [] })), [])
})

test('steering handled input is never replayed and delayed clear preserves a concurrent steer', async () => {
  const steering = new Steering(async () => 'handled')
  steering.start()
  await steering.running()
  await steering.inject('handled')
  steering.ended()
  let release!: () => void
  const leftovers = steering.leftovers(
    () =>
      new Promise(resolve => {
        release = () => resolve({ steering: ['extension'], followUp: ['follow'] })
      })
  )
  await new Promise(resolve => setImmediate(resolve))
  await steering.inject('during-clear')
  release()
  assert.deepEqual(await leftovers, ['extension', 'during-clear', 'follow'])
})

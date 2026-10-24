import test from 'node:test'
import assert from 'node:assert/strict'
import { Steering } from '../../src/acp/steering.js'

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

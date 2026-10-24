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

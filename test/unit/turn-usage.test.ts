import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveTurnUsage } from '../../src/acp/session.js'
import type { PiSessionStats } from '../../src/pi-rpc/process.js'

const stats = (tokens: number): PiSessionStats => ({ contextUsage: { tokens, contextWindow: 200 } })

test('deriveTurnUsage attributes context growth to the turn', () => {
  assert.deepEqual(deriveTurnUsage(stats(100), stats(150)), {
    totalTokens: 150,
    inputTokens: 100,
    outputTokens: 50
  })
})

test('deriveTurnUsage reports zero output for unchanged context', () => {
  assert.deepEqual(deriveTurnUsage(stats(120), stats(120)), {
    totalTokens: 120,
    inputTokens: 120,
    outputTokens: 0
  })
})

test('deriveTurnUsage omits when snapshots are missing or malformed', () => {
  assert.equal(deriveTurnUsage(null, stats(10)), null)
  assert.equal(deriveTurnUsage(stats(10), null), null)
  assert.equal(deriveTurnUsage(undefined, undefined), null)
  assert.equal(deriveTurnUsage({}, stats(10)), null)
  assert.equal(deriveTurnUsage(stats(10), { contextUsage: {} }), null)
  assert.equal(deriveTurnUsage({ contextUsage: { tokens: -1 } }, stats(10)), null)
  assert.equal(deriveTurnUsage({ contextUsage: { tokens: 1.5 } }, stats(10)), null)
})

test('deriveTurnUsage omits when the context shrank (compaction reset)', () => {
  assert.equal(deriveTurnUsage(stats(200), stats(100)), null)
})

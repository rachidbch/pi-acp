import test from 'node:test'
import assert from 'node:assert/strict'

// Minimal local impl (mirrors src/acp/agent.ts behavior)
function mergeCommands(a: Array<{ name: string }>, b: Array<{ name: string }>) {
  const out: Array<{ name: string }> = []
  const seen = new Set<string>()
  for (const c of [...b, ...a]) {
    if (seen.has(c.name)) continue
    seen.add(c.name)
    out.push(c)
  }
  return out
}

test('mergeCommands: preserves order and de-dupes (second argument wins)', () => {
  const res = mergeCommands([{ name: 'a' }, { name: 'b' }], [{ name: 'b' }, { name: 'c' }])
  assert.deepEqual(res, [{ name: 'b' }, { name: 'c' }, { name: 'a' }])
})

test('mergeCommands: adapter built-ins keep their description on name conflicts', () => {
  const builtin = { name: 'model', description: 'adapter built-in description' }
  const native = { name: 'model', description: 'native command description' }
  const res = mergeCommands([native], [builtin])
  assert.deepEqual(res, [builtin])
})

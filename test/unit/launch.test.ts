import test from 'node:test'
import assert from 'node:assert/strict'
import { LAUNCH_FLAGS, parseLaunchFlags, parseLaunchOptions, parseSystemPrompt } from '../../src/acp/launch.js'

const invalid = (fn: () => unknown, pattern: RegExp) =>
  assert.throws(fn, (err: any) => err?.code === -32602 && pattern.test(String(err?.message)))

test('launch flags: allowlisted flags pass through in order, values kept', () => {
  const args = ['-ne', '-e', '/x/ext.ts', '--model', 'zai/glm-5.3', '--thinking', 'low', '--tools', 'read,bash', '-nc']
  assert.deepEqual(parseLaunchFlags(args), args)
  assert.deepEqual(parseLaunchFlags(undefined), [])
})

test('launch flags: the SPEC allowlist is accepted', () => {
  for (const flag of [
    '--model',
    '--thinking',
    '--tools',
    '--exclude-tools',
    '--no-tools',
    '-e',
    '-ne',
    '--no-mcp',
    '--skill',
    '-ns',
    '-np',
    '-nc',
    '--approve'
  ]) {
    assert.ok(LAUNCH_FLAGS.includes(flag), flag)
  }
})

test('launch flags: adapter-owned flags fail with invalidParams', () => {
  for (const flag of [
    '--mode',
    '--session',
    '--session-id',
    '--fork',
    '--no-session',
    '-p',
    '-c',
    '-r',
    '--system-prompt'
  ]) {
    invalid(() => parseLaunchFlags([flag, 'x']), /owned by pi-acp/)
  }
})

test('launch flags: unknown flags, bare words, missing values and non-arrays fail', () => {
  invalid(() => parseLaunchFlags(['--api-key', 'k']), /not an allowed pi flag/)
  invalid(() => parseLaunchFlags(['hello']), /not an allowed pi flag/)
  invalid(() => parseLaunchFlags(['--model']), /needs a value/)
  invalid(() => parseLaunchFlags('--model x'), /array of strings/)
})

test('system prompt: string replaces, {append} appends, other shapes fail', () => {
  assert.deepEqual(parseSystemPrompt('Be terse.'), { mode: 'replace', text: 'Be terse.' })
  assert.deepEqual(parseSystemPrompt({ append: 'More.' }), { mode: 'append', text: 'More.' })
  assert.equal(parseSystemPrompt(undefined), undefined)
  invalid(() => parseSystemPrompt({ append: '' }), /systemPrompt/)
  invalid(() => parseSystemPrompt({ append: 'a', replace: 'b' }), /systemPrompt/)
})

test('launch options: read from _meta.piAcp and _meta.systemPrompt', () => {
  assert.deepEqual(parseLaunchOptions({ piAcp: { launch: ['-ne'], headless: true }, systemPrompt: { append: 'X' } }), {
    args: ['-ne'],
    systemPrompt: { mode: 'append', text: 'X' },
    headless: true
  })
  assert.deepEqual(parseLaunchOptions(undefined), { args: [], headless: false })
})

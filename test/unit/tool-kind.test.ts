import test from 'node:test'
import assert from 'node:assert/strict'
import { toToolKind } from '../../src/acp/session.js'

const cases: Array<[string, ReturnType<typeof toToolKind>]> = [
  ['read', 'read'],
  ['write', 'edit'],
  ['edit', 'edit'],
  ['bash', 'execute'],
  ['grep', 'search'],
  ['find', 'search'],
  ['ls', 'search'],
  ['rg', 'search'],
  ['trash', 'delete'],
  ['rm', 'delete'],
  ['mv', 'move'],
  ['move', 'move'],
  ['rename', 'move'],
  ['fetch', 'fetch'],
  ['web_fetch', 'fetch'],
  ['todo', 'think'],
  ['mcp__exa__web_search', 'other'],
  ['codemode', 'other'],
  ['', 'other']
]

test('toToolKind maps pi built-ins onto the ACP ToolKind enum', () => {
  for (const [name, kind] of cases) {
    const mapped = toToolKind(name)
    assert.ok(mapped !== undefined, `mapping for ${JSON.stringify(name)} must never be undefined`)
    assert.equal(mapped, kind)
  }
})

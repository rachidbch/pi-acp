import test from 'node:test'
import assert from 'node:assert/strict'
import { getAuthMethods, PI_SETUP_METHOD_ID } from '../../src/acp/auth.js'

test('getAuthMethods: includes Zed terminal-auth metadata when enabled', () => {
  const methods = getAuthMethods({ supportsTerminalAuthMeta: true })
  assert.equal(methods.length, 1)
  const m: any = methods[0]

  assert.equal(m.id, PI_SETUP_METHOD_ID)
  assert.ok(m._meta)
  assert.ok(m._meta['terminal-auth'])
  assert.ok(typeof m._meta['terminal-auth'].command === 'string')
  assert.deepEqual(m._meta['terminal-auth'].args, ['--terminal-login'])
  assert.equal(m._meta['terminal-auth'].label, 'Launch pi')
})

test('getAuthMethods: stable terminal capability works without legacy metadata', () => {
  const methods = getAuthMethods({ supportsTerminalAuth: true, supportsTerminalAuthMeta: false })
  const m: any = methods[0]
  assert.equal(m.type, 'terminal')
  assert.deepEqual(m.args, ['--terminal-login'])
  assert.ok(!m._meta || !m._meta['terminal-auth'])
})

test('getAuthMethods: unnegotiated terminal authentication is not advertised', () => {
  assert.deepEqual(getAuthMethods(), [])
  assert.deepEqual(getAuthMethods({ supportsTerminalAuth: false, supportsTerminalAuthMeta: false }), [])
})

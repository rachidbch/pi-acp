import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk/unstable'
import { buildMcpDescriptor, prepareMcpInjection } from '../../src/acp/mcp-descriptor.js'

function stdioServer(overrides: Partial<McpServer> & Record<string, unknown> = {}): McpServer {
  return {
    name: 'files',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    env: [{ name: 'LOG_LEVEL', value: 'debug' }],
    ...overrides
  } as McpServer
}

test('buildMcpDescriptor translates stdio servers into pi config shape', () => {
  const { descriptor, warnings } = buildMcpDescriptor([stdioServer()])

  assert.deepEqual(warnings, [])
  assert.deepEqual(descriptor, {
    mcpServers: {
      files: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
        env: { LOG_LEVEL: 'debug' }
      }
    }
  })
})

test('buildMcpDescriptor translates http servers and skips unsupported transports', () => {
  const { descriptor, warnings } = buildMcpDescriptor([
    {
      type: 'http',
      name: 'docs',
      url: 'https://example.com/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer t' }]
    } as McpServer,
    { type: 'sse', name: 'legacy', url: 'http://127.0.0.1:1/sse', headers: [] } as McpServer,
    { type: 'acp', name: 'proxied' } as McpServer,
    stdioServer()
  ])

  assert.deepEqual(descriptor?.mcpServers.docs, {
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer t' }
  })
  assert.equal(descriptor?.mcpServers.legacy, undefined)
  assert.equal(descriptor?.mcpServers.proxied, undefined)
  assert.equal(descriptor?.mcpServers.files.command, 'npx')
  assert.equal(warnings.length, 2)
  assert.match(warnings[0], /"legacy"/)
  assert.match(warnings[1], /"proxied"/)
})

test('buildMcpDescriptor skips unnamed, duplicate, and commandless entries', () => {
  const { descriptor, warnings } = buildMcpDescriptor([
    { command: 'x', args: [], env: [] } as unknown as McpServer,
    stdioServer(),
    stdioServer(),
    { name: 'broken' } as McpServer
  ])

  assert.deepEqual(Object.keys(descriptor?.mcpServers ?? {}), ['files'])
  assert.equal(warnings.length, 3)
})

test('prepareMcpInjection writes the descriptor to a temp file and cleans it up', () => {
  const plan = prepareMcpInjection([stdioServer()])

  assert.notEqual(plan.descriptorPath, null)
  assert.deepEqual(plan.serverNames, ['files'])
  assert.ok(existsSync(plan.descriptorPath!))
  if (process.platform !== 'win32') assert.equal(statSync(plan.descriptorPath!).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(readFileSync(plan.descriptorPath!, 'utf-8')).mcpServers.files.command, 'npx')

  plan.cleanup()
  assert.equal(existsSync(plan.descriptorPath!), false)
  plan.cleanup()
})

test('prepareMcpInjection returns a warning-only plan when the temp directory cannot be written', () => {
  const envName = process.platform === 'win32' ? 'TEMP' : 'TMPDIR'
  const previous = process.env[envName]
  process.env[envName] = join(tmpdir(), 'pi-acp-nonexistent-parent', 'missing')
  try {
    const plan = prepareMcpInjection([stdioServer()])
    assert.equal(plan.descriptorPath, null)
    assert.deepEqual(plan.serverNames, [])
    assert.match(plan.warnings.join('\n'), /descriptor/)
    plan.cleanup()
  } finally {
    if (previous === undefined) delete process.env[envName]
    else process.env[envName] = previous
  }
})

test('buildMcpDescriptor escapes literal env and HTTP header values for pi', () => {
  const values = ['!printf changed', 'abc$UNDEFINED', '${UNDEFINED}', '$$literal', '$!literal', '']
  const pairs = values.map((value, index) => ({ name: `VALUE_${index}`, value }))
  const { descriptor } = buildMcpDescriptor([
    stdioServer({ env: pairs }),
    { type: 'http', name: 'http', url: 'https://example.com/mcp', headers: pairs }
  ])
  const expected = {
    VALUE_0: '$!printf changed',
    VALUE_1: 'abc$$UNDEFINED',
    VALUE_2: '$${UNDEFINED}',
    VALUE_3: '$$$$literal',
    VALUE_4: '$$!literal',
    VALUE_5: ''
  }
  assert.deepEqual(descriptor?.mcpServers.files.env, expected)
  assert.deepEqual(descriptor?.mcpServers.http.headers, expected)
})

test('prepareMcpInjection returns a null plan when nothing is injectable', () => {
  const plan = prepareMcpInjection([{ type: 'sse', name: 'legacy' } as McpServer])

  assert.equal(plan.descriptorPath, null)
  assert.deepEqual(plan.serverNames, [])
  assert.equal(plan.warnings.length, 1)
  plan.cleanup()
})

test('prepareMcpInjection tolerates undefined input', () => {
  const plan = prepareMcpInjection(undefined)
  assert.equal(plan.descriptorPath, null)
  plan.cleanup()

  const root = mkdtempSync(join(tmpdir(), 'pi-acp-mcp-descriptor-'))
  rmSync(root, { recursive: true, force: true })
})

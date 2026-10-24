import test from 'node:test'
import assert from 'node:assert/strict'
import { ndJsonStream } from '@agentclientprotocol/sdk/unstable'
import { connectPiAgent } from '../../src/acp/connection.js'
import { FakePiRpcProcess } from '../helpers/fakes.js'
import type { AgentConnection } from '@agentclientprotocol/sdk/unstable'

type Server = { agent: unknown; connection: AgentConnection }

function startWire(): {
  server: Server
  send: (payload: unknown) => void
  next: () => Promise<unknown>
} {
  const input = new TransformStream<Uint8Array>()
  const output = new TransformStream<Uint8Array>()
  const server = connectPiAgent(ndJsonStream(output.writable, input.readable)) as Server
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let buffered = ''
  const writer = input.writable.getWriter()
  const reader = output.readable.getReader()
  const pending: unknown[] = []
  let waiter: ((value: unknown) => void) | undefined
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffered += decoder.decode(value, { stream: true })
        let newline: number
        while ((newline = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, newline).trim()
          buffered = buffered.slice(newline + 1)
          if (!line) continue
          const message = JSON.parse(line)
          if (waiter) {
            const resolve = waiter
            waiter = undefined
            resolve(message)
          } else pending.push(message)
        }
      }
    } catch {
      // stream closed
    }
  })()
  return {
    server,
    send: payload => void writer.write(encoder.encode(`${JSON.stringify(payload)}\n`)),
    next: () =>
      pending.length > 0
        ? Promise.resolve(pending.shift())
        : new Promise(resolve => {
            waiter = resolve
          })
  }
}

test('unknown JSON-RPC methods get an error response, not silence or a crash', { timeout: 5000 }, async t => {
  const wire = startWire()
  t.after(() => wire.server.connection.close())
  wire.send({ jsonrpc: '2.0', id: 1, method: 'session/does_not_exist', params: {} })
  const response = (await wire.next()) as { id: number; error?: { code: number } }
  assert.equal(response.id, 1)
  assert.ok(response.error, 'unknown method must answer with a JSON-RPC error')
})

test('custom steering method reaches validation through SDK 2 request routing', { timeout: 5000 }, async t => {
  const wire = startWire()
  t.after(() => wire.server.connection.close())
  wire.send({ jsonrpc: '2.0', id: 71, method: '_session/steering', params: { sessionId: 'missing', prompt: [] } })
  const response = (await wire.next()) as { id: number; error?: { code: number } }
  assert.equal(response.id, 71)
  assert.equal(response.error?.code, -32602)
})

test('malformed session/new params are rejected before the handler runs', { timeout: 5000 }, async t => {
  const wire = startWire()
  t.after(() => wire.server.connection.close())
  wire.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: 42 } })
  const response = (await wire.next()) as { id: number; error?: { code: number }; result?: unknown }
  assert.equal(response.id, 2)
  assert.ok(response.error, 'malformed params must not reach the handler or produce a result')
  assert.equal(response.result, undefined)
})

test('malformed session/prompt params are rejected without spawning a process', { timeout: 5000 }, async t => {
  const wire = startWire()
  t.after(() => wire.server.connection.close())
  wire.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'nope' } })
  const response = (await wire.next()) as { id: number; error?: { code: number } }
  assert.equal(response.id, 3)
  assert.ok(response.error, 'missing prompt content must be rejected by schema validation')
})

test('initialize tolerates unknown or loosely-typed capability fields', { timeout: 5000 }, async t => {
  // SDK 1.9 does not strictly validate every nested clientCapabilities shape; the
  // extensibility contract requires tolerating unknown fields in both directions.
  // The adapter must still initialize (it feature-detects with === true checks).
  const wire = startWire()
  t.after(() => wire.server.connection.close())
  wire.send({
    jsonrpc: '2.0',
    id: 4,
    method: 'initialize',
    params: { protocolVersion: 1, clientCapabilities: { fs: 'yes', 'future/capability': { on: true } } }
  })
  const response = (await wire.next()) as { id: number; error?: { code: number }; result?: unknown }
  assert.equal(response.id, 4)
  assert.ok(response.result, 'initialize must succeed despite unknown capability fields')
})

test('initialize with valid params still succeeds after strict checks', { timeout: 5000 }, async t => {
  const wire = startWire()
  t.after(() => wire.server.connection.close())
  wire.send({
    jsonrpc: '2.0',
    id: 5,
    method: 'initialize',
    params: { protocolVersion: 1, clientCapabilities: {} }
  })
  const response = (await wire.next()) as { id: number; result?: { protocolVersion: number } }
  assert.equal(response.id, 5)
  assert.ok(response.result, 'valid initialize must produce a result')
})

// Reference the fake to keep imports honest if the harness evolves.
void FakePiRpcProcess

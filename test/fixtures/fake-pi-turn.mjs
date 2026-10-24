#!/usr/bin/env node
// Scripted fake pi in RPC mode that runs whole turns: answers the session handshake and,
// per prompt, streams one assistant message (reply text from FAKE_PI_REPLY, default
// "FAKE-REPLY") with pi 1.4 usage, then settles.
// FAKE_PI_ARGV_FILE: write {argv, cwd} as JSON there at start (launch-flag assertions).
import { mkdirSync, writeFileSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.env.FAKE_PI_ARGV_FILE) {
  writeFileSync(process.env.FAKE_PI_ARGV_FILE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }))
}

const sessionId = process.env.FAKE_PI_SESSION_ID || randomUUID()
const dir = join(tmpdir(), 'pi-acp-tests', 'fake-turn')
mkdirSync(dir, { recursive: true })
const sessionFile = join(dir, `${sessionId}.jsonl`)
const reply = process.env.FAKE_PI_REPLY ?? 'FAKE-REPLY'
const usage = {
  input: 120,
  output: 7,
  cacheRead: 30,
  cacheWrite: 4,
  totalTokens: 161,
  cost: { input: 0.0012, output: 0.0007, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0022 }
}
let turns = 0

const send = obj => writeSync(1, JSON.stringify(obj) + '\n')
const ok = (msg, data) =>
  send({ type: 'response', id: msg.id, command: msg.type, success: true, ...(data ? { data } : {}) })

function runTurn() {
  turns++
  const message = { role: 'assistant', content: [], stopReason: 'pending', timestamp: Date.now() }
  send({ type: 'agent_start' })
  send({ type: 'turn_start' })
  send({ type: 'message_start', message })
  send({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: reply } })
  const final = { ...message, content: [{ type: 'text', text: reply }], stopReason: 'stop', usage }
  send({ type: 'message_end', message: final })
  send({ type: 'turn_end', message: final, toolResults: [] })
  send({ type: 'agent_end', messages: [final], willRetry: false })
  send({ type: 'agent_settled', aborted: false })
}

let rest = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  rest += chunk
  let nl
  while ((nl = rest.indexOf('\n')) !== -1) {
    const line = rest.slice(0, nl)
    rest = rest.slice(nl + 1)
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    switch (msg.type) {
      case 'get_state':
        ok(msg, {
          sessionId,
          sessionFile,
          model: { provider: 'fake', id: 'fake-model', name: 'Fake Model', contextWindow: 100000 },
          thinkingLevel: 'off',
          isStreaming: false
        })
        break
      case 'get_available_models':
        ok(msg, { models: [{ provider: 'fake', id: 'fake-model', name: 'Fake Model', contextWindow: 100000 }] })
        break
      case 'get_available_thinking_levels':
        ok(msg, { levels: ['off', 'low'] })
        break
      case 'get_commands':
        ok(msg, { commands: [] })
        break
      case 'get_messages':
        ok(msg, { messages: [] })
        break
      case 'get_session_stats':
        ok(msg, {
          sessionFile,
          sessionId,
          userMessages: turns,
          assistantMessages: turns,
          tokens: { input: usage.input * turns, output: usage.output * turns, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: usage.cost.total * turns
        })
        break
      case 'prompt':
        ok(msg)
        setImmediate(runTurn)
        break
      case 'clear_queue':
        ok(msg, { steering: [], followUp: [] })
        break
      default:
        ok(msg, {})
    }
  }
})
process.stdin.on('end', () => process.exit(0))

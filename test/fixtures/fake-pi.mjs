#!/usr/bin/env node
// Minimal fake pi RPC subprocess for PiRpcProcess tests.
import { writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sessionFile = join(tmpdir(), 'pi-acp-tests', 'fake-session.jsonl')

if (process.env.FAKE_PI_STDERR) writeSync(2, 'fake pi diagnostic\n')

// Emits an event before the adapter can attach any event handler.
if (process.env.FAKE_PI_STARTUP_EVENTS) {
  writeSync(1, JSON.stringify({ type: 'session_start', data: 'early' }) + '\n')
}

// Overflows the pre-subscription event buffer (1024 events).
if (process.env.FAKE_PI_FLOOD) {
  for (let i = 0; i < 1025; i++) {
    writeSync(1, JSON.stringify({ type: 'flood', n: i }) + '\n')
  }
}

let answeredState = false
let rest = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  rest += chunk
  let newline
  while ((newline = rest.indexOf('\n')) !== -1) {
    const line = rest.slice(0, newline)
    rest = rest.slice(newline + 1)
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.type === 'get_state') {
      // The spawn handshake gets one answer; later get_state calls hang (timeout path).
      if (answeredState) continue
      answeredState = true
      writeSync(
        1,
        JSON.stringify({
          type: 'response',
          id: msg.id,
          command: 'get_state',
          success: true,
          data: { sessionFile }
        }) + '\n'
      )
    } else if (msg.type === 'get_commands') {
      if (process.env.FAKE_PI_BAD_RESPONSE) {
        writeSync(1, JSON.stringify({ type: 'response', id: msg.id, command: 'get_commands', success: 'sure' }) + '\n')
      } else {
        // JSON.stringify keeps U+2028 raw inside strings and node's readline splits on
        // it; this event exercises LF-only framing.
        writeSync(
          1,
          JSON.stringify({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', delta: 'before\u2028after' }
          }) + '\n'
        )
        writeSync(
          1,
          JSON.stringify({
            type: 'response',
            id: msg.id,
            command: 'get_commands',
            success: true,
            data: { commands: [] }
          }) + '\n'
        )
      }
    } else if (msg.type === 'get_messages') {
      writeSync(
        1,
        JSON.stringify({
          type: 'response',
          id: msg.id,
          command: 'get_messages',
          success: true,
          data: { messages: [] }
        }) + '\n'
      )
      process.exit(3)
    } else {
      writeSync(1, JSON.stringify({ type: 'response', id: msg.id, command: msg.type, success: true, data: {} }) + '\n')
    }
  }
})

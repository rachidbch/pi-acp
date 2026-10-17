#!/usr/bin/env node
// Reproduces the shared-connection "conversation cut off" cascade: creating a second session
// over the same ACP connection must not cancel a turn that is still streaming
// in the first session.
//
// Observed against hosts that share one ACP connection across threads of
// an agent+cwd): session/new for a new thread swept the old thread's pi
// subprocess (stopReason "cancelled", stream cut mid-sentence).
//
// Usage: node scripts/repro-newsession-cascade.mjs
// Exit 0 = adapter keeps the busy session alive; exit 1 = cascade reproduced.
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()

await new Promise((resolve, reject) => {
  const p = spawn('npm', ['run', 'build'], { stdio: 'inherit', cwd: root })
  p.on('exit', code => (code === 0 ? resolve() : reject(new Error(`build failed: ${code}`))))
})

const dir = mkdtempSync(join(tmpdir(), 'pi-acp-cascade-'))

// A fake pi RPC subprocess: streams a slow turn on `prompt`, answers every
// handshake command. Written as CJS so no loader flags are needed.
const fakePi = join(dir, 'fake-pi.cjs')
writeFileSync(
  fakePi,
  `const { writeSync } = require('node:fs')
const { writeFileSync: wfs, mkdirSync } = require('node:fs')
const { dirname } = require('node:path')
if (process.argv.includes('--version')) { console.log('1.5.0'); process.exit(0) }
const sid = 'repro-' + Math.random().toString(36).slice(2, 10)
const sessionFile = process.env.REPRO_SESSION_DIR + '/' + sid + '.jsonl'
mkdirSync(dirname(sessionFile), { recursive: true })
wfs(sessionFile, '')
const send = o => writeSync(1, JSON.stringify(o) + '\\n')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let rest = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  rest += chunk
  let nl
  while ((nl = rest.indexOf('\\n')) !== -1) {
    const line = rest.slice(0, nl); rest = rest.slice(nl + 1)
    let msg; try { msg = JSON.parse(line) } catch { continue }
    if (msg.type === 'get_state') {
      send({ type: 'response', id: msg.id, command: 'get_state', success: true, data: { sessionId: sid, sessionFile, thinkingLevel: 'medium' } })
    } else if (msg.type === 'get_available_models') {
      send({ type: 'response', id: msg.id, command: 'get_available_models', success: true, data: { models: [{ provider: 'repro', id: 'repro-model', name: 'Repro Model' }] } })
    } else if (msg.type === 'get_commands') {
      send({ type: 'response', id: msg.id, command: 'get_commands', success: true, data: { commands: [] } })
    } else if (msg.type === 'get_available_thinking_levels') {
      send({ type: 'response', id: msg.id, command: 'get_available_thinking_levels', success: true, data: { levels: ['low', 'medium', 'high'] } })
    } else if (msg.type === 'get_messages') {
      send({ type: 'response', id: msg.id, command: 'get_messages', success: true, data: { messages: [] } })
    } else if (msg.type === 'prompt') {
      void (async () => {
        send({ type: 'agent_start' })
        for (let i = 1; i <= 15; i++) {
          await sleep(150)
          send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'chunk' + i + ' ' } })
        }
        send({ type: 'turn_end' })
        send({ type: 'agent_end' })
        send({ type: 'agent_settled' })
        send({ type: 'response', id: msg.id, command: 'prompt', success: true, data: { disposition: 'handled' } })
      })()
    } else if (msg.type) {
      send({ type: 'response', id: msg.id, command: msg.type, success: true, data: {} })
    }
  }
})
`
)

const launcher = join(dir, 'pi')
writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${fakePi}" "$@"\n`)
chmodSync(launcher, 0o755)

const child = spawn('node', ['dist/index.js'], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, PI_ACP_PI_COMMAND: launcher, REPRO_SESSION_DIR: join(dir, 'sessions') }
})

let nextId = 1
const pending = new Map()
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })

const state = {
  sessionA: null,
  sessionB: null,
  chunksA: [],
  promptA: null,
  newSessionBSentAt: null,
  chunksAfterB: 0
}

let buffer = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => {
  buffer += chunk
  let nl
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl)
    buffer = buffer.slice(nl + 1)
    if (!line.trim()) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
      continue
    }
    if (msg.method === 'session/update' && msg.params?.sessionId === state.sessionA) {
      const u = msg.params.update
      if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
        state.chunksA.push(u.content.text)
        if (state.newSessionBSentAt) state.chunksAfterB++
      }
    }
  }
})

const t0 = Date.now()
const log = (...a) => console.log(`[+${String(Date.now() - t0).padStart(5)}ms]`, ...a)
let failed = false

try {
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  log('initialized')

  const a = await request('session/new', { cwd: dir, mcpServers: [] })
  state.sessionA = a.sessionId
  log('session A created:', state.sessionA)

  const promptPromise = request('session/prompt', {
    sessionId: state.sessionA,
    prompt: [{ type: 'text', text: 'stream a long answer' }]
  })
  promptPromise.then(
    r => {
      state.promptA = r?.stopReason ?? JSON.stringify(r)
      log('session A prompt resolved, stopReason:', state.promptA)
    },
    e => {
      state.promptA = 'error:' + e.message
      log('session A prompt rejected:', e.message)
    }
  )

  // Wait for the turn to actually start streaming.
  const streamStart = Date.now()
  while (state.chunksA.length === 0 && Date.now() - streamStart < 10_000) {
    await new Promise(r => setTimeout(r, 50))
  }
  if (state.chunksA.length === 0) throw new Error('session A never started streaming')
  log('session A streaming, chunks:', state.chunksA.length)

  // Mid-stream: open a second session over the same connection (client "New Session").
  await new Promise(r => setTimeout(r, 300))
  const b = await request('session/new', { cwd: dir, mcpServers: [] })
  state.sessionB = b.sessionId
  state.newSessionBSentAt = Date.now()
  log('session B created mid-stream:', state.sessionB)

  // Give the old turn plenty of time to finish (~15 chunks * 150ms ~= 2.3s + slack).
  const deadline = Date.now() + 8000
  while (!state.promptA && Date.now() < deadline) await new Promise(r => setTimeout(r, 100))

  log('prompt A outcome:', state.promptA ?? 'still pending')
  log('chunks total:', state.chunksA.length, '| chunks after session B:', state.chunksAfterB)

  if (state.promptA === 'cancelled') {
    failed = true
    log('FAIL: the in-flight turn in session A was cancelled by session/new for session B')
  } else if (state.promptA !== 'end_turn') {
    failed = true
    log(`FAIL: unexpected turn outcome for session A: ${state.promptA}`)
  } else if (state.chunksAfterB === 0) {
    failed = true
    log('FAIL: session A stream stopped right after session B was created')
  } else {
    log('PASS: session A kept streaming through session B creation and completed end_turn')
  }
} catch (err) {
  failed = true
  log('FAIL:', err.message)
} finally {
  child.kill('SIGTERM')
}

process.exit(failed ? 1 : 0)

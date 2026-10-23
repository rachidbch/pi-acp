#!/usr/bin/env node
// Fake pi that leads a process group: starts a long-lived grandchild (a stand-in for a tool or
// MCP server) and ignores SIGTERM. FAKE_PI_PIDS_FILE receives {pi, grandchild} as JSON.
import { spawn } from 'node:child_process'
import { writeFileSync, writeSync } from 'node:fs'

const grandchild = spawn('sleep', ['300'], { stdio: 'ignore' })
writeFileSync(process.env.FAKE_PI_PIDS_FILE, JSON.stringify({ pi: process.pid, grandchild: grandchild.pid }))
process.on('SIGTERM', () => {})

let rest = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  rest += chunk
  let nl
  while ((nl = rest.indexOf('\n')) !== -1) {
    const msg = JSON.parse(rest.slice(0, nl))
    rest = rest.slice(nl + 1)
    if (msg.type === 'get_state')
      writeSync(
        1,
        JSON.stringify({ type: 'response', id: msg.id, command: 'get_state', success: true, data: {} }) + '\n'
      )
  }
})

import { readFileSync } from 'node:fs'

// Loaded by pi via `-e` (spawned by the pi-acp adapter). Registers the client-provided
// MCP servers described in PI_ACP_MCP_DESCRIPTOR using pi's native MCP support.
// Must never throw: a failed extension load is fatal in pi RPC mode, so any error
// degrades to a stderr warning and a session without injected servers.
export default function (pi) {
  try {
    const descriptorPath = process.env.PI_ACP_MCP_DESCRIPTOR
    if (!descriptorPath) return

    let descriptor
    try {
      descriptor = JSON.parse(readFileSync(descriptorPath, 'utf-8'))
    } catch (err) {
      console.warn(`[pi-acp] MCP injection: failed to read descriptor ${descriptorPath}: ${err?.message ?? err}`)
      return
    }

    const servers = descriptor && typeof descriptor === 'object' ? descriptor.mcpServers : null
    if (!servers || typeof servers !== 'object') return

    if (typeof pi?.registerMcpServer !== 'function') {
      const count = Object.keys(servers).length
      console.warn(`[pi-acp] MCP injection: this pi runtime has no registerMcpServer; skipping ${count} server(s)`)
      return
    }

    for (const [name, config] of Object.entries(servers)) {
      try {
        pi.registerMcpServer(name, config)
      } catch (err) {
        console.warn(`[pi-acp] MCP injection: failed to register "${name}": ${err?.message ?? err}`)
      }
    }
  } catch (err) {
    console.warn(`[pi-acp] MCP injection: unexpected error: ${err?.message ?? err}`)
  }
}

import { randomUUID } from 'node:crypto'
import { closeSync, openSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpServer, McpServerStdio } from '@agentclientprotocol/sdk/unstable'

export const PI_ACP_MCP_DESCRIPTOR_ENV = 'PI_ACP_MCP_DESCRIPTOR'

// Also cover descriptors prepared for sessions that are still starting at adapter shutdown.
const descriptorCleanups = new Set<() => void>()
process.once('exit', () => {
  for (const cleanup of descriptorCleanups) cleanup()
})

export type PiMcpServerConfig = {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export type McpDescriptor = {
  mcpServers: Record<string, PiMcpServerConfig>
}

export type McpInjectionPlan = {
  /** Absolute path of the descriptor file, or null when there is nothing to inject. */
  descriptorPath: string | null
  /** Names of the servers that made it into the descriptor. */
  serverNames: string[]
  /** Human-readable reasons for skipped servers; also written to stderr. */
  warnings: string[]
  /** Best-effort removal of the descriptor file. Safe to call more than once. */
  cleanup: () => void
}

function pairsToMap(pairs: Array<{ name: string; value: string }> | undefined): Record<string, string> {
  const map: Record<string, string> = {}
  for (const pair of pairs ?? []) {
    if (typeof pair?.name === 'string' && typeof pair?.value === 'string') {
      // ACP values are literals; pi treats !commands and $references as configuration expressions.
      map[pair.name] = pair.value.replace(/\$/g, () => '$$').replace(/^!/, () => '$!')
    }
  }
  return map
}

/**
 * Translate ACP `session/new` / `session/load` mcpServers into pi's native
 * `mcpServers` entry shape. Skipped entries come back as warnings.
 */
export function buildMcpDescriptor(servers: readonly McpServer[]): {
  descriptor: McpDescriptor | null
  warnings: string[]
} {
  const entries: Record<string, PiMcpServerConfig> = {}
  const warnings: string[] = []

  for (const server of servers ?? []) {
    const name = typeof server?.name === 'string' ? server.name : ''
    if (!name) {
      warnings.push('skipped an MCP server entry without a name')
      continue
    }
    if (entries[name]) {
      warnings.push(`skipped duplicate MCP server "${name}"`)
      continue
    }

    // McpServerStdio is the only union member without a `type` discriminator.
    if ('type' in server && server.type === 'http') {
      entries[name] = { url: server.url, headers: pairsToMap(server.headers) }
      continue
    }

    if ('type' in server && (server.type === 'sse' || server.type === 'acp')) {
      warnings.push(`skipped MCP server "${name}": transport "${server.type}" is not supported`)
      continue
    }

    const stdio = server as McpServerStdio
    if (typeof stdio.command !== 'string' || !stdio.command) {
      warnings.push(`skipped MCP server "${name}": missing command`)
      continue
    }

    entries[name] = {
      command: stdio.command,
      args: [...(stdio.args ?? [])],
      env: pairsToMap(stdio.env)
    }
  }

  const descriptor: McpDescriptor | null = Object.keys(entries).length ? { mcpServers: entries } : null
  return { descriptor, warnings }
}

/**
 * Build the descriptor and write it to a session-scoped temp file for the bundled
 * pi extension (`src/pi-extension/mcp-bootstrap.js`) to read. Warnings are echoed to
 * stderr so ACP hosts that capture agent stderr see them.
 */
export function prepareMcpInjection(servers: readonly McpServer[] | undefined): McpInjectionPlan {
  const { descriptor, warnings } = buildMcpDescriptor(servers ?? [])
  const serverNames = Object.keys(descriptor?.mcpServers ?? {})

  for (const warning of warnings) console.warn(`[pi-acp] MCP injection: ${warning}`)

  if (!descriptor) {
    return { descriptorPath: null, serverNames: [], warnings, cleanup: () => {} }
  }

  const descriptorPath = join(tmpdir(), `pi-acp-mcp-${randomUUID()}.json`)
  let created = false
  const cleanup = () => {
    if (!created) return
    try {
      unlinkSync(descriptorPath)
      created = false
      descriptorCleanups.delete(cleanup)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        created = false
        descriptorCleanups.delete(cleanup)
      }
    }
  }

  try {
    const fd = openSync(descriptorPath, 'wx', 0o600)
    created = true
    descriptorCleanups.add(cleanup)
    try {
      writeFileSync(fd, JSON.stringify(descriptor))
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    cleanup()
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown error'
    const warning = `could not write MCP descriptor (${code}); continuing without client MCP servers`
    warnings.push(warning)
    console.warn(`[pi-acp] MCP injection: ${warning}`)
    return { descriptorPath: null, serverNames: [], warnings, cleanup }
  }

  return { descriptorPath, serverNames, warnings, cleanup }
}

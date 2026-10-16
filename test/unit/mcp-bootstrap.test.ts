import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PI_ACP_MCP_DESCRIPTOR_ENV } from '../../src/acp/mcp-descriptor.js'

const bootstrapHref = pathToFileURL(join(import.meta.dirname ?? '.', '../../src/pi-extension/mcp-bootstrap.js')).href

type RegisteredServer = { name: string; config: Record<string, unknown> }

function fakePi(register?: (name: string, config: Record<string, unknown>) => void) {
  return {
    registerMcpServer: register ?? ((_name: string, _config: Record<string, unknown>) => {})
  }
}

async function loadBootstrap() {
  return import(bootstrapHref)
}

/** Runs `run` with PI_ACP_MCP_DESCRIPTOR set to a temp file holding `contents` (null: env var unset). */
async function withDescriptor(contents: string | null, run: () => void) {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-bootstrap-'))
  const descriptorPath = join(root, 'descriptor.json')
  if (contents !== null) writeFileSync(descriptorPath, contents)

  const previous = process.env[PI_ACP_MCP_DESCRIPTOR_ENV]
  if (contents === null) delete process.env[PI_ACP_MCP_DESCRIPTOR_ENV]
  else process.env[PI_ACP_MCP_DESCRIPTOR_ENV] = descriptorPath

  try {
    run()
  } finally {
    if (previous === undefined) delete process.env[PI_ACP_MCP_DESCRIPTOR_ENV]
    else process.env[PI_ACP_MCP_DESCRIPTOR_ENV] = previous
    rmSync(root, { recursive: true, force: true })
  }
}

test('mcp-bootstrap registers every descriptor entry via pi.registerMcpServer', async () => {
  const bootstrap = await loadBootstrap()
  const registered: RegisteredServer[] = []

  await withDescriptor(
    JSON.stringify({
      mcpServers: {
        files: { command: 'npx', args: ['-y', 'server-filesystem'], env: { A: 'b' } },
        ide: { command: 'ide-bridge', toolExposure: { execute_tool: 'hidden' } }
      }
    }),
    () => {
      bootstrap.default(
        fakePi((name, config) => {
          registered.push({ name, config })
        })
      )
    }
  )

  assert.deepEqual(
    registered.map(entry => entry.name),
    ['files', 'ide']
  )
  assert.deepEqual(registered[0].config, { command: 'npx', args: ['-y', 'server-filesystem'], env: { A: 'b' } })
  assert.deepEqual(registered[1].config.toolExposure, { execute_tool: 'hidden' })
})

test('mcp-bootstrap keeps loading when the descriptor is unreadable', async () => {
  const bootstrap = await loadBootstrap()
  let calls = 0

  await withDescriptor('{not json', () => {
    bootstrap.default(
      fakePi(() => {
        calls += 1
      })
    )
  })

  assert.equal(calls, 0)
})

test('mcp-bootstrap warns and skips servers when pi lacks registerMcpServer', async () => {
  const bootstrap = await loadBootstrap()
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (line: unknown) => {
    warnings.push(String(line))
  }

  try {
    await withDescriptor(JSON.stringify({ mcpServers: { files: { command: 'npx' }, ide: { command: 'ide' } } }), () => {
      bootstrap.default({})
    })
  } finally {
    console.warn = originalWarn
  }

  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /registerMcpServer/)
  assert.match(warnings[0], /2 server/)
})

test('mcp-bootstrap is a no-op without the descriptor env var', async () => {
  const bootstrap = await loadBootstrap()
  let calls = 0

  await withDescriptor(null, () => {
    bootstrap.default(
      fakePi(() => {
        calls += 1
      })
    )
  })

  assert.equal(calls, 0)
})

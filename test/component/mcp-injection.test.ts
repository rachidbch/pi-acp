import test from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crossSpawn from 'cross-spawn'
import { PiRpcProcess, PiRpcSpawnError } from '../../src/pi-rpc/process.js'
import { prepareMcpInjection, type McpInjectionPlan } from '../../src/acp/mcp-descriptor.js'

function writeLauncher(root: string, versionCode = 'console.log("1.0.0")'): string {
  const script = join(root, 'fake-pi.cjs')
  writeFileSync(
    script,
    `if (process.argv.includes('--version')) {
      ${versionCode}
    } else {
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const command = JSON.parse(line)
        if (command.message === 'exit') process.exit(0)
        console.log(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true,
          data: { sessionId: 'fixture', args: process.argv.slice(2), descriptorPath: process.env.PI_ACP_MCP_DESCRIPTOR ?? null } }))
      })
    }`
  )
  const launcher = join(root, process.platform === 'win32' ? 'pi.cmd' : 'pi')
  if (process.platform === 'win32') {
    writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)
  } else {
    writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
    chmodSync(launcher, 0o755)
  }
  return launcher
}

function cleanupFixture(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) cleanupFixture(path)
    else unlinkSync(path)
  }
  rmdirSync(root)
}

function injectionPlan(): McpInjectionPlan {
  return prepareMcpInjection([{ name: 'fixture', command: process.execPath, args: [], env: [] }])
}

function assertNoInjection(state: unknown): void {
  assert.ok(state && typeof state === 'object' && 'args' in state && 'descriptorPath' in state)
  assert.ok(Array.isArray(state.args))
  assert.equal(
    state.args.some(arg => typeof arg === 'string' && arg.endsWith('mcp-bootstrap.js')),
    false
  )
  assert.equal(
    state.args.some(
      arg => typeof arg === 'string' && (arg.endsWith('mcp-bootstrap.js') || arg.endsWith('client-bootstrap.js'))
    ),
    false
  )
  assert.equal(state.descriptorPath, null)
}

test('spawn refuses an incompatible runtime when an actual MCP descriptor exists', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-mcp-floor-'))
  const launcher = writeLauncher(root, 'console.log("0.9.5")')
  const plan = injectionPlan()
  assert.ok(plan.descriptorPath)

  try {
    await assert.rejects(
      () => PiRpcProcess.spawn({ cwd: root, piCommand: launcher, mcpInjection: plan }),
      (err: unknown) => {
        assert.ok(err instanceof PiRpcSpawnError)
        assert.match(err.message, /MCP injection/)
        assert.match(err.message, /pi >= 1\.0\.0/)
        return true
      }
    )
    assert.equal(existsSync(plan.descriptorPath), false)

    const proc = await PiRpcProcess.spawn({ cwd: root, piCommand: launcher })
    proc.dispose()
  } finally {
    plan.cleanup()
    cleanupFixture(root)
  }
})

test('unsupported-only plans skip version checks and bootstrap loading on older pi', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-mcp-empty-'))
  const probeMarker = join(root, 'version-probed')
  const launcher = writeLauncher(
    root,
    `require('node:fs').writeFileSync(${JSON.stringify(probeMarker)}, 'probed'); console.log('0.9.5')`
  )
  const plan = prepareMcpInjection([{ name: 'unsupported', type: 'sse', url: 'http://localhost:1234', headers: [] }])
  assert.equal(plan.descriptorPath, null)
  assert.ok(plan.warnings.length)
  let proc: PiRpcProcess | null = null
  try {
    proc = await PiRpcProcess.spawn({ cwd: root, piCommand: launcher, mcpInjection: plan })
    assertNoInjection(await proc.getState())
    assert.equal(existsSync(probeMarker), false)
  } finally {
    proc?.dispose()
    cleanupFixture(root)
  }
})

for (const [label, versionCode] of [
  ['nonzero exit', 'process.exit(1)'],
  ['invalid output', 'console.log("not a version")'],
  ['excessive output', 'process.stdout.write("x".repeat(128 * 1024))']
]) {
  test(`version probe ${label} warns and starts without injection`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'pi-acp-mcp-probe-'))
    const launcher = writeLauncher(root, versionCode)
    const plan = injectionPlan()
    assert.ok(plan.descriptorPath)
    const warn = t.mock.method(console, 'warn', () => {})
    let proc: PiRpcProcess | null = null
    try {
      proc = await PiRpcProcess.spawn({ cwd: root, piCommand: launcher, mcpInjection: plan })
      assertNoInjection(await proc.getState())
      assert.equal(existsSync(plan.descriptorPath), false)
      assert.ok(warn.mock.calls.some(call => String(call.arguments[0]).includes('skipping client MCP servers')))
    } finally {
      proc?.dispose()
      plan.cleanup()
      cleanupFixture(root)
    }
  })
}

test('version probe timeout is bounded and does not block cancellation in another session', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-mcp-timeout-'))
  const launcher = writeLauncher(root, 'setTimeout(() => process.exit(0), 4000)')
  const plan = injectionPlan()
  assert.ok(plan.descriptorPath)
  const warn = t.mock.method(console, 'warn', () => {})
  const active = await PiRpcProcess.spawn({ cwd: root, piCommand: launcher })
  let proc: PiRpcProcess | null = null
  let spawning: Promise<PiRpcProcess> | null = null
  try {
    const started = Date.now()
    spawning = PiRpcProcess.spawn({ cwd: root, piCommand: launcher, mcpInjection: plan })
    await active.abort()
    assert.ok(Date.now() - started < 1000, 'version check blocked cancellation')
    proc = await spawning
    assert.ok(Date.now() - started < 3500, 'version check did not time out')
    assertNoInjection(await proc.getState())
    assert.equal(existsSync(plan.descriptorPath), false)
    assert.ok(warn.mock.calls.some(call => String(call.arguments[0]).includes('timed out')))
  } finally {
    if (!proc && spawning) proc = await spawning.catch(() => null)
    proc?.dispose()
    active.dispose()
    plan.cleanup()
    cleanupFixture(root)
  }
})

for (const termination of ['timeout', 'adapter exit']) {
  test(
    `version probe ${termination} kills descendants of non-exec launchers`,
    { skip: process.platform !== 'linux' },
    async t => {
      const root = mkdtempSync(join(tmpdir(), 'pi-acp-mcp-probe-tree-'))
      const marker = join(root, 'descendant-pid')
      const parentMarker = join(root, 'parent-pid')
      const descendantCode = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`
      const launcher = writeLauncher(
        root,
        `require('node:fs').writeFileSync(${JSON.stringify(parentMarker)}, String(process.pid)); require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`
      )
      writeFileSync(launcher, `#!/bin/sh\n"${process.execPath}" "${join(root, 'fake-pi.cjs')}" "$@"\nwait\n`)
      const plan = injectionPlan()
      t.mock.method(console, 'warn', () => {})
      let proc: PiRpcProcess | null = null
      const descendantRunning = (): boolean => {
        const pid = Number(readFileSync(marker, 'utf-8'))
        assert.ok(Number.isSafeInteger(pid) && pid > 0)
        try {
          const status = readFileSync(`/proc/${pid}/stat`, 'utf-8').match(/\) ([A-Z])/)
          assert.ok(status, 'could not read descendant process status')
          return status[1] !== 'Z' && status[1] !== 'X'
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
          throw error
        }
      }
      try {
        if (termination === 'adapter exit') {
          const ownerScript = join(root, 'probe-owner.mjs')
          writeFileSync(
            ownerScript,
            `
          import { existsSync } from 'node:fs'
          import { PiRpcProcess } from ${JSON.stringify(new URL('../../src/pi-rpc/process.ts', import.meta.url).href)}
          void PiRpcProcess.spawn({ cwd: ${JSON.stringify(root)}, piCommand: ${JSON.stringify(launcher)},
            mcpInjection: { descriptorPath: ${JSON.stringify(plan.descriptorPath)}, serverNames: [], warnings: [], cleanup() {} } })
          setInterval(() => { if (existsSync(${JSON.stringify(marker)})) process.exit(0) }, 10)
          setTimeout(() => process.exit(2), 5000)
        `
          )
          const owner = crossSpawn(process.execPath, ['--import', import.meta.resolve('tsx'), ownerScript], {
            stdio: 'ignore'
          })
          const exitCode = await new Promise<number | null>((resolve, reject) => {
            owner.once('error', reject)
            owner.once('close', resolve)
          })
          assert.equal(exitCode, 0, 'probe owner did not exit after its descendant started')
        } else {
          proc = await PiRpcProcess.spawn({ cwd: root, piCommand: launcher, mcpInjection: plan })
          assertNoInjection(await proc.getState())
        }
        for (let waited = 0; descendantRunning() && waited < 500; waited += 10) {
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        assert.equal(descendantRunning(), false, 'version probe left a descendant process running')
      } finally {
        proc?.dispose()
        plan.cleanup()
        for (const path of [marker, parentMarker]) {
          if (!existsSync(path)) continue
          const pid = Number(readFileSync(path, 'utf-8'))
          assert.ok(Number.isSafeInteger(pid) && pid > 0)
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // The process group cleanup already reaped the fixture.
          }
        }
        cleanupFixture(root)
      }
    }
  )
}

test('descriptor is retained while pi runs and cleaned when pi exits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-mcp-exit-'))
  const launcher = writeLauncher(root)
  const plan = injectionPlan()
  assert.ok(plan.descriptorPath)
  let proc: PiRpcProcess | null = null
  try {
    proc = await PiRpcProcess.spawn({ cwd: root, piCommand: launcher, mcpInjection: plan })
    assert.equal(existsSync(plan.descriptorPath), true)
    await assert.rejects(proc.prompt('exit'), /process exited/)
    assert.equal(existsSync(plan.descriptorPath), false)
  } finally {
    proc?.dispose()
    plan.cleanup()
    cleanupFixture(root)
  }
})

const piOnPath = crossSpawn.sync('pi', ['--version'], { encoding: 'utf-8', timeout: 2000, maxBuffer: 65536 })
const piAvailable = piOnPath.status === 0 && /^\d+\.\d+\.\d+/.test(String(piOnPath.stdout).trim())

test(
  'injected servers reach real pi via the bundled bootstrap extension',
  { skip: !piAvailable && 'pi executable not found on PATH' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-acp-mcp-e2e-'))
    const marker = join(root, 'mcp-server-touched')
    const mcpServerScript = join(root, 'toucher.cjs')
    const literalEnv = {
      PI_ACP_TEST_MCP_COMMAND: '!printf changed',
      PI_ACP_TEST_MCP_REFERENCE: 'abc$PI_ACP_REVIEW_UNSET_TEST_VARIABLE',
      PI_ACP_TEST_MCP_BRACED: '${PI_ACP_REVIEW_UNSET_TEST_VARIABLE}',
      PI_ACP_TEST_MCP_DOLLARS: '$$literal'
    }
    assert.equal(process.env.PI_ACP_REVIEW_UNSET_TEST_VARIABLE, undefined)
    writeFileSync(
      mcpServerScript,
      [
        "const { writeFileSync } = require('node:fs')",
        `const values = Object.fromEntries(${JSON.stringify(Object.keys(literalEnv))}.map(name => [name, process.env[name]]))`,
        'writeFileSync(process.argv[process.argv.length - 1], JSON.stringify(values))',
        '// Stay alive briefly so pi sees a running server process, then exit.',
        'setTimeout(() => process.exit(0), 30000)'
      ].join('\n')
    )

    const plan = prepareMcpInjection([
      {
        name: 'toucher',
        command: process.execPath,
        args: [mcpServerScript, marker],
        env: Object.entries(literalEnv).map(([name, value]) => ({ name, value }))
      }
    ])

    let proc: PiRpcProcess | null = null
    try {
      proc = await PiRpcProcess.spawn({ cwd: root, mcpInjection: plan })

      // A successful get_state proves the -e extension loaded without killing the session
      // (extension load failures are fatal in pi RPC mode).
      const state = (await proc.getState()) as { sessionId?: string }
      assert.ok(typeof state.sessionId === 'string' && state.sessionId.length > 0)

      // Registered servers connect at session start: pi must spawn the server command.
      let touched = existsSync(marker)
      for (let waited = 0; !touched && waited < 15_000; waited += 250) {
        await new Promise(resolve => setTimeout(resolve, 250))
        touched = existsSync(marker)
      }
      assert.equal(touched, true, 'pi never spawned the injected MCP server command')
      assert.deepEqual(JSON.parse(readFileSync(marker, 'utf-8')), literalEnv)
    } finally {
      proc?.dispose()
      plan.cleanup()
      cleanupFixture(root)
    }
  }
)

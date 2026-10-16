import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('../../', import.meta.url))
const agentUrl = new URL('../../src/acp/agent.ts', import.meta.url).href
const indexUrl = new URL('../../src/index.ts', import.meta.url).href
const descriptorUrl = new URL('../../src/acp/mcp-descriptor.ts', import.meta.url).href

for (const trigger of ['stdin', 'stdout', 'SIGTERM', 'SIGINT'] as const) {
  test(
    `adapter disposes its agent on ${trigger}`,
    { timeout: 10_000, skip: process.platform === 'win32' && (trigger === 'SIGTERM' || trigger === 'SIGINT') },
    async t => {
      const source = `
      import { writeSync } from 'node:fs';
      import { PiAcpAgent } from ${JSON.stringify(agentUrl)};
      import { prepareMcpInjection } from ${JSON.stringify(descriptorUrl)};
      const plan = prepareMcpInjection([{ name: 'pending', command: 'echo', args: [], env: [] }]);
      const dispose = PiAcpAgent.prototype.dispose;
      PiAcpAgent.prototype.dispose = function () {
        writeSync(2, 'disposed\\n');
        dispose.call(this);
      };
      await import(${JSON.stringify(indexUrl)});
      process.send({ descriptorPath: plan.descriptorPath });
    `
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe', 'ipc']
      })
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', chunk => {
        stdout += String(chunk)
      })
      child.stderr?.on('data', chunk => {
        stderr += String(chunk)
      })
      const closed = once(child, 'close')
      const [message] = await once(child, 'message')
      assert.ok(message && typeof message === 'object' && 'descriptorPath' in message)
      assert.equal(typeof message.descriptorPath, 'string')
      const descriptorPath = String(message.descriptorPath)
      assert.ok(existsSync(descriptorPath))
      if (trigger === 'stdin') child.stdin?.end()
      else if (trigger === 'stdout') {
        child.stdout?.destroy()
        child.stdin?.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } })}\n`
        )
      } else child.kill(trigger)
      const [code, signal] = await closed
      assert.equal(code, 0, stderr)
      assert.equal(signal, null)
      assert.equal(stdout, '')
      // Tolerate loader deprecation warnings from the tsx import chain.
      const significant = stderr
        .split('\n')
        .filter(line => line.trim() && !line.includes('DeprecationWarning') && !line.startsWith('('))
      assert.deepEqual(significant, ['disposed'], `stderr: ${JSON.stringify(stderr)}`)
      assert.equal(existsSync(descriptorPath), false, 'pending session descriptor survived adapter shutdown')
    }
  )
}

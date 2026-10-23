// Preloaded by `npm test` (node --import): tests never touch the real home or the shared
// temp dir. pi settings and agent-dir lookups follow
// HOME, so point it at a throwaway dir; TMPDIR points inside it, so every os.tmpdir()
// consumer (test fixtures, adapter subprocesses) writes there. The whole dir is removed when
// the process that made it exits. The real home stays in PI_ACP_TEST_REAL_HOME for
// env-gated real-pi tests.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.PI_ACP_TEST_REAL_HOME) {
  process.env.PI_ACP_TEST_REAL_HOME = process.env.HOME ?? ''
  const home = mkdtempSync(join(tmpdir(), 'pi-acp-test-home-'))
  const temp = join(home, 'tmp')
  mkdirSync(temp)
  process.env.HOME = home
  process.env.TMPDIR = temp
  process.on('exit', () => rmSync(home, { recursive: true, force: true }))
}

// Preloaded by `npm test` (node --import): tests never touch the real home. The adapter
// store (~/.pi/pi-acp/session-map.json) and pi settings lookups follow HOME, so point it at
// a throwaway dir. The real home stays in PI_ACP_TEST_REAL_HOME for env-gated real-pi tests.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.PI_ACP_TEST_REAL_HOME) {
  process.env.PI_ACP_TEST_REAL_HOME = process.env.HOME ?? ''
  process.env.HOME = mkdtempSync(join(tmpdir(), 'pi-acp-test-home-'))
}

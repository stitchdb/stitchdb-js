import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
test('createClient<Database>() typing (tsc on test/types/usage.ts)', () => {
  try { execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'test/types/tsconfig.json'], { stdio: 'pipe' }) }
  catch (e) { assert.fail(String(e.stdout || e.message)) }
})

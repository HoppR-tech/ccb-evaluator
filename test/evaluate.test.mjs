import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runner = resolve(root, 'runners/typescript/evaluate.mjs')
const config = resolve(root, 'rule-packs', 'typescript', 'ohmyform-v1', 'dependency-cruiser.config.cjs')

async function evaluateCandidate(candidate) {
  const output = resolve(await mkdtemp(resolve(tmpdir(), 'ccb-evaluator-result-')), 'result.json')
  await execFileAsync(process.execPath, [runner, '--candidate', candidate, '--rule-config', config, '--result', output])
  return JSON.parse(await readFile(output, 'utf8'))
}

async function evaluate(fixture) {
  return evaluateCandidate(resolve(root, 'test/fixtures', fixture))
}

test('returns an aggregate pass result for a complete compliant slice', async () => {
  assert.deepEqual(await evaluate('passing'), { status: 'passing', violations: 0, score: 1, weightedScore: 1 })
})

test('returns an aggregate failure result without diagnostics', async () => {
  assert.deepEqual(await evaluate('failing'), { status: 'failing', violations: 9, score: 0, weightedScore: 0 })
})

test('counts more than 255 violations without using the process exit code', async () => {
  const candidate = await mkdtemp(resolve(tmpdir(), 'ccb-evaluator-many-'))
  await mkdir(resolve(candidate, 'api/src/domain'), { recursive: true })
  await mkdir(resolve(candidate, 'api/src/infrastructure'), { recursive: true })
  await writeFile(resolve(candidate, 'api/src/infrastructure/client.ts'), 'export const client = 1\n')
  await Promise.all(Array.from({ length: 256 }, (_, index) =>
    writeFile(resolve(candidate, `api/src/domain/model-${index}.ts`), "import { client } from '../infrastructure/client'\nexport { client }\n")
  ))

  assert.deepEqual(await evaluateCandidate(candidate), { status: 'failing', violations: 264, score: 0, weightedScore: 0 })
})

test('rejects candidate symlinks before static analysis', async () => {
  const candidate = await mkdtemp(resolve(tmpdir(), 'ccb-evaluator-symlink-'))
  await symlink(tmpdir(), resolve(candidate, 'outside'))

  assert.deepEqual(await evaluateCandidate(candidate), { status: 'evaluator_error' })
})

test('rejects a candidate root symlink before static analysis', async () => {
  const target = await mkdtemp(resolve(tmpdir(), 'ccb-evaluator-target-'))
  const parent = await mkdtemp(resolve(tmpdir(), 'ccb-evaluator-root-link-'))
  const candidate = resolve(parent, 'candidate')
  await symlink(target, candidate)

  assert.deepEqual(await evaluateCandidate(candidate), { status: 'evaluator_error' })
})

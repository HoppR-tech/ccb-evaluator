import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runner = resolve(root, 'runners/typescript/evaluate.mjs')
const config = resolve(root, 'rule-packs', 'typescript', 'ohmyform-v2', 'dependency-cruiser.config.cjs')

async function evaluateCandidate(candidate) {
  const output = resolve(await mkdtemp(resolve(tmpdir(), 'ccb-evaluator-result-')), 'result.json')
  await execFileAsync(process.execPath, [runner, '--candidate', candidate, '--rule-config', config, '--result', output])
  return JSON.parse(await readFile(output, 'utf8'))
}

async function evaluate(fixture) {
  return evaluateCandidate(resolve(root, 'test/fixtures', fixture))
}

test('returns multidimensional quality for a complete compliant slice', async () => {
  assert.deepEqual(await evaluate('passing'), {
    status: 'passing',
    violations: 0,
    qualityScore: 1,
    qualityQualified: true,
    dimensions: { architecture: 1, maintainability: 1, clarity: 1, tests: 1, robustness: 1 },
  })
})

test('scores every quality dimension without exposing diagnostics', async () => {
  assert.deepEqual(await evaluate('failing'), {
    status: 'failing',
    violations: 14,
    qualityScore: 0.5875,
    qualityQualified: false,
    dimensions: { architecture: 0, maintainability: 1, clarity: 1, tests: 0.25, robustness: 1 },
  })
})

test('counts more than 255 violations without using the process exit code', async () => {
  const candidate = await mkdtemp(resolve(tmpdir(), 'ccb-evaluator-many-'))
  await mkdir(resolve(candidate, 'api/src/domain'), { recursive: true })
  await mkdir(resolve(candidate, 'api/src/infrastructure'), { recursive: true })
  await writeFile(resolve(candidate, 'api/src/infrastructure/client.ts'), 'export const client = 1\n')
  await Promise.all(Array.from({ length: 256 }, (_, index) =>
    writeFile(resolve(candidate, `api/src/domain/model-${index}.ts`), "import { client } from '../infrastructure/client'\nexport { client }\n")
  ))

  assert.deepEqual(await evaluateCandidate(candidate), {
    status: 'failing',
    violations: 269,
    qualityScore: 0.5875,
    qualityQualified: false,
    dimensions: { architecture: 0, maintainability: 1, clarity: 1, tests: 0.25, robustness: 1 },
  })
})

test('disqualifies an unused architecture facade', async () => {
  const candidate = await mkdtemp(resolve(tmpdir(), 'ccb-evaluator-unused-facade-'))
  await cp(resolve(root, 'test/fixtures/passing'), candidate, { recursive: true })
  await writeFile(
    resolve(candidate, 'api/src/resolver/submission/index.ts'),
    `import { SubmissionStartMutation } from './submission.start.mutation'\nexport const submissionResolvers = [SubmissionStartMutation]\n`,
  )
  await writeFile(resolve(candidate, 'api/src/resolver/submission/submission.start.mutation.ts'), 'export class SubmissionStartMutation {}\n')

  const result = await evaluateCandidate(candidate)
  assert.equal(result.status, 'failing')
  assert.equal(result.qualityQualified, false)
  assert.ok(result.dimensions.architecture < 0.75)
})

test('scores transitive source and dangerous syntax forms', async () => {
  const candidate = await mkdtemp(resolve(tmpdir(), 'ccb-evaluator-dangerous-'))
  await cp(resolve(root, 'test/fixtures/passing'), candidate, { recursive: true })
  await writeFile(
    resolve(candidate, 'api/src/application/start.ts'),
    `import process = require('node:child_process')\n// @ts-expect-error benchmark fixture\nconst run = globalThis.eval\nexport const unsafe = () => run(process)\n`,
  )

  const result = await evaluateCandidate(candidate)
  assert.equal(result.status, 'failing')
  assert.equal(result.qualityQualified, false)
  assert.equal(result.dimensions.clarity, 0.75)
  assert.equal(result.dimensions.robustness, 0.5)
})

test('does not double-count test files as source files', async () => {
  const candidate = await mkdtemp(resolve(tmpdir(), 'ccb-evaluator-tests-'))
  await cp(resolve(root, 'test/fixtures/passing'), candidate, { recursive: true })
  await writeFile(
    resolve(candidate, 'api/src/application/start-submission.test.ts'),
    `import assert from 'node:assert/strict'\nimport test from 'node:test'\ntest('one', () => assert.ok(true))\ntest('two', () => assert.ok(true))\n`,
  )

  const result = await evaluateCandidate(candidate)
  assert.equal(result.status, 'failing')
  assert.equal(result.qualityQualified, false)
  assert.equal(result.dimensions.tests, 0.5)
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

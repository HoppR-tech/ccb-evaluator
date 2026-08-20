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
    violations: 21,
    qualityScore: 0.6066666666666667,
    qualityQualified: false,
    dimensions: { architecture: 0.08888888888888889, maintainability: 1, clarity: 1, tests: 0.2, robustness: 1 },
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
    violations: 276,
    qualityScore: 0.6066666666666667,
    qualityQualified: false,
    dimensions: { architecture: 0.08888888888888889, maintainability: 1, clarity: 1, tests: 0.2, robustness: 1 },
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
  await mkdir(resolve(candidate, 'api/src/shared'), { recursive: true })
  await writeFile(
    resolve(candidate, 'api/src/shared/start.ts'),
    `// @ts-expect-error benchmark fixture\nexport function unsafe() {\n  const process = req(\`node:child_process\`)\n  return run(process)\n}\nconst req = require\nconst run = globalThis['eval']\n`,
  )
  await writeFile(
    resolve(candidate, 'api/src/application/start-submission.ts'),
    `import type { SubmissionRepository } from '../domain/submission-repository'\nimport { unsafe } from '../shared/start'\nexport class StartSubmission {\n  constructor(private readonly submissions: SubmissionRepository) {}\n  execute(id: string): Promise<void> {\n    unsafe()\n    return this.submissions.save(id)\n  }\n}\n`,
  )

  const result = await evaluateCandidate(candidate)
  assert.equal(result.status, 'failing')
  assert.equal(result.qualityQualified, false)
  assert.equal(result.dimensions.clarity, 0.75)
  assert.equal(result.dimensions.robustness, 0.5)
})

test('requires imported providers to be registered in Nest arrays', async () => {
  const candidate = await mkdtemp(resolve(tmpdir(), 'ccb-evaluator-registration-'))
  await cp(resolve(root, 'test/fixtures/passing'), candidate, { recursive: true })
  await writeFile(
    resolve(candidate, 'api/src/app.providers.ts'),
    `import { StartSubmission } from './application/start-submission'\nimport { TypeOrmSubmissionRepository } from './infrastructure/typeorm-submission-repository'\nimport { submissionResolvers } from './resolver/submission'\nimport { SubmissionStartService } from './service/submission/submission.start.service'\nexport const providers = [StartSubmission, SubmissionStartService, ...submissionResolvers]\n`,
  )

  const result = await evaluateCandidate(candidate)
  assert.equal(result.status, 'failing')
  assert.equal(result.qualityQualified, false)
  assert.ok(result.dimensions.architecture > 0.75)
})

test('requires assertions inside each counted test case', async () => {
  const candidate = await mkdtemp(resolve(tmpdir(), 'ccb-evaluator-tests-'))
  await cp(resolve(root, 'test/fixtures/passing'), candidate, { recursive: true })
  await writeFile(
    resolve(candidate, 'api/src/application/start-submission.test.ts'),
    `import assert from 'node:assert/strict'\nimport test from 'node:test'\ntest('one', () => {})\ntest('two', () => {})\ntest('three', () => {})\nassert.ok(true)\nassert.ok(true)\nassert.ok(true)\n`,
  )

  const result = await evaluateCandidate(candidate)
  assert.equal(result.status, 'failing')
  assert.equal(result.qualityQualified, false)
  assert.equal(result.dimensions.tests, 0.6)
})

test('counts assertions in named test callbacks', async () => {
  const candidate = await mkdtemp(resolve(tmpdir(), 'ccb-evaluator-named-tests-'))
  await cp(resolve(root, 'test/fixtures/passing'), candidate, { recursive: true })
  await writeFile(
    resolve(candidate, 'api/src/application/start-submission.test.ts'),
    `import assert from 'node:assert/strict'\nimport test from 'node:test'\nfunction first() { assert.ok(true) }\nconst second = () => assert.ok(true)\nfunction third() { assert.ok(true) }\ntest('one', first)\ntest('two', second)\ntest('three', third)\n`,
  )

  const result = await evaluateCandidate(candidate)
  assert.equal(result.status, 'passing')
  assert.equal(result.qualityQualified, true)
  assert.equal(result.dimensions.tests, 1)
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

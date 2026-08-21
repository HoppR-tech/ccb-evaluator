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

async function evaluateCandidate(candidate, ruleConfig = config) {
  const output = resolve(await mkdtemp(resolve(tmpdir(), 'ccb-evaluator-result-')), 'result.json')
  await execFileAsync(process.execPath, [runner, '--candidate', candidate, '--rule-config', ruleConfig, '--result', output])
  return JSON.parse(await readFile(output, 'utf8'))
}

async function evaluate(fixture) {
  return evaluateCandidate(resolve(root, 'test/fixtures', fixture))
}

function checkPasses(check) {
  switch (check.operator) {
    case 'eq': return check.observed === check.threshold
    case 'gte': return check.observed >= check.threshold
    case 'lte': return check.observed <= check.threshold
    case 'exists': return check.observed === true
    case 'not_exists': return check.observed === false
    default: throw new Error(`unknown operator: ${check.operator}`)
  }
}

function assertEvidenceReconciles(result) {
  const evidence = result.evidence
  assert.equal(evidence.schemaVersion, 1)
  assert.equal(evidence.overall.score, result.qualityScore)
  assert.equal(evidence.overall.qualified, result.qualityQualified)
  let violations = 0
  let weightedScore = 0
  let totalWeight = 0
  const ids = new Set()
  for (const dimension of evidence.dimensions) {
    const earned = dimension.checks.reduce((total, check) => total + check.earned, 0)
    const maximum = dimension.checks.reduce((total, check) => total + check.max, 0)
    assert.equal(dimension.earned, earned)
    assert.equal(dimension.max, maximum)
    assert.equal(dimension.score, earned / maximum)
    assert.equal(result.dimensions[dimension.dimension], dimension.score)
    assert.equal(
      dimension.qualified,
      dimension.score >= dimension.minimum
        && dimension.checks.every((check) => !check.mandatory || check.status === 'passed'),
    )
    weightedScore += dimension.score * dimension.weight
    totalWeight += dimension.weight
    for (const check of dimension.checks) {
      assert.match(check.id, /^[a-z][a-z0-9.-]+$/)
      assert.ok(!ids.has(check.id))
      ids.add(check.id)
      assert.equal(check.status, checkPasses(check) ? 'passed' : 'failed')
      assert.equal(check.earned, check.status === 'passed' ? check.max : 0)
      assert.equal(check.locationsTruncated, check.locationCount > check.locations.length)
      assert.equal(check.pathsTruncated, check.pathCount > check.paths.length)
      for (const location of check.locations) {
        assert.ok(!location.path.startsWith('/'))
        assert.ok(!location.path.split('/').includes('..'))
        assert.doesNotMatch(location.path, /[\u0000-\u001f\u007f]/)
        assert.ok(location.line >= 1)
        assert.ok(location.endLine >= location.line)
      }
      for (const path of check.paths) {
        assert.equal(path.truncated, false)
        assert.equal(path.totalNodes, path.nodes.length)
        assert.ok(path.nodes.every((node) => !node.startsWith('/') && !node.split('/').includes('..')))
      }
      violations += check.violations
    }
  }
  assert.equal(evidence.overall.earned, weightedScore)
  assert.equal(evidence.overall.max, totalWeight)
  assert.equal(evidence.overall.score, weightedScore / totalWeight)
  assert.equal(result.violations, violations)
  assert.equal(
    result.qualityQualified,
    evidence.overall.score >= evidence.overall.qualifiedThreshold
      && evidence.dimensions.every((dimension) => dimension.qualified),
  )
  assert.equal(evidence.sources.length, evidence.inventory.fileCount)
  assert.deepEqual(evidence.sources.map((source) => source.path), evidence.inventory.files.map((file) => file.path))
  for (const source of evidence.sources) {
    assert.match(source.digest, /^sha256:[0-9a-f]{64}$/)
    assert.equal(source.lineCount, source.content.split('\n').length)
  }
  assert.equal(evidence.structure.nodeCount, evidence.structure.nodes.length)
  assert.equal(evidence.structure.edgeCount, evidence.structure.edges.length)
  assert.equal(evidence.structure.nodesTruncated, false)
  assert.equal(evidence.structure.edgesTruncated, false)
  assert.ok(!JSON.stringify(evidence).includes(root))
}

test('returns reconciled per-check evidence for a complete compliant slice', async () => {
  const result = await evaluate('passing')
  assert.equal(result.status, 'passing')
  assert.equal(result.violations, 0)
  assert.equal(result.qualityScore, 1)
  assert.equal(result.qualityQualified, true)
  assert.deepEqual(result.dimensions, { architecture: 1, maintainability: 1, clarity: 1, tests: 1, robustness: 1 })
  assertEvidenceReconciles(result)
  const architecture = result.evidence.dimensions.find((dimension) => dimension.dimension === 'architecture')
  const path = architecture.checks.find((check) => check.id === 'architecture.required-path.providers-infrastructure')
  assert.deepEqual(path.paths[0].nodes, [
    'api/src/app.providers.ts',
    'api/src/infrastructure/typeorm-submission-repository.ts',
  ])
  assert.deepEqual(path.locations.map(({ path: file, line }) => [file, line]), [['api/src/app.providers.ts', 2]])
})

test('explains every failing score with bounded source and structure evidence', async () => {
  const result = await evaluate('failing')
  assert.equal(result.status, 'failing')
  assert.equal(result.violations, 21)
  assert.equal(result.qualityScore, 0.6066666666666667)
  assert.equal(result.qualityQualified, false)
  assert.deepEqual(result.dimensions, { architecture: 0.08888888888888889, maintainability: 1, clarity: 1, tests: 0.2, robustness: 1 })
  assertEvidenceReconciles(result)
  assert.deepEqual(result.evidence.structure, {
    nodes: ['api/src/domain/model.ts', 'api/src/infrastructure/client.ts'],
    nodeCount: 2,
    nodesTruncated: false,
    edges: [{ from: 'api/src/domain/model.ts', to: 'api/src/infrastructure/client.ts' }],
    edgeCount: 1,
    edgesTruncated: false,
  })
  const dependencyRules = result.evidence.dimensions[0].checks.find((check) => check.id === 'architecture.dependency-rules')
  assert.equal(dependencyRules.status, 'failed')
  assert.match(dependencyRules.locations[0].message, /domain-must-not-depend-on-outer-layers/)
  assert.deepEqual(
    [dependencyRules.locations[0].path, dependencyRules.locations[0].line],
    ['api/src/domain/model.ts', 1],
  )
})

test('counts more than 255 violations without using the process exit code', async () => {
  const candidate = await mkdtemp(resolve(tmpdir(), 'ccb-evaluator-many-'))
  await mkdir(resolve(candidate, 'api/src/domain'), { recursive: true })
  await mkdir(resolve(candidate, 'api/src/infrastructure'), { recursive: true })
  await writeFile(resolve(candidate, 'api/src/infrastructure/client.ts'), 'export const client = 1\n')
  await Promise.all(Array.from({ length: 256 }, (_, index) =>
    writeFile(resolve(candidate, `api/src/domain/model-${index}.ts`), "import { client } from '../infrastructure/client'\nexport { client }\n")
  ))

  const result = await evaluateCandidate(candidate)
  assert.equal(result.status, 'failing')
  assert.equal(result.violations, 276)
  assert.equal(result.qualityScore, 0.6066666666666667)
  assert.equal(result.qualityQualified, false)
  assert.deepEqual(result.dimensions, { architecture: 0.08888888888888889, maintainability: 1, clarity: 1, tests: 0.2, robustness: 1 })
  assertEvidenceReconciles(result)
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

test('redacts and deterministically bounds candidate source snippets', async () => {
  const candidate = await mkdtemp(resolve(tmpdir(), 'ccb-evaluator-redaction-'))
  await cp(resolve(root, 'test/fixtures/passing'), candidate, { recursive: true })
  await writeFile(
    resolve(candidate, 'api/src/application/start-submission.ts'),
    `import type { SubmissionRepository } from '../domain/submission-repository'\nconst secret = "definitely-secret" as any\nconst token = "definitely-secret" as any\nconst password = "definitely-secret" as any\nconst credential = "definitely-secret" as any\nconst authorization = "definitely-secret" as any\nconst api_key = "definitely-secret" as any\nconst private_key = "definitely-secret" as any\nconst endpoint = "https://user:hunter2@example.com"\nexport class StartSubmission {\n  constructor(private readonly submissions: SubmissionRepository) {}\n  execute(id: string): Promise<void> { return this.submissions.save(id) }\n}\n`,
  )

  const result = await evaluateCandidate(candidate)
  const clarity = result.evidence.dimensions.find((dimension) => dimension.dimension === 'clarity')
  const explicitAny = clarity.checks.find((check) => check.id === 'clarity.no-explicit-any')
  assert.equal(explicitAny.locationCount, 7)
  assert.equal(explicitAny.locations.length, 6)
  assert.equal(explicitAny.locationsTruncated, true)
  assert.ok(explicitAny.locations.every((location) => location.snippet.includes('[REDACTED]')))
  assert.ok(!JSON.stringify(result.evidence).includes('definitely-secret'))
  const source = result.evidence.sources.find((file) => file.path === 'api/src/application/start-submission.ts')
  assert.ok(source.redactionCount >= 8)
  assert.ok(source.content.includes('https://[REDACTED]:[REDACTED]@example.com'))
  assert.ok(!source.content.includes('hunter2'))
  assert.equal(
    result.evidence.inventory.files.find((file) => file.path === 'api/src/application/start-submission.ts').anyTypes,
    7,
  )
})

test('preserves Unicode and spaces in candidate-relative source diagnostics', async () => {
  const candidate = await mkdtemp(resolve(tmpdir(), 'ccb-evaluator-unicode-path-'))
  await cp(resolve(root, 'test/fixtures/passing'), candidate, { recursive: true })
  const directory = resolve(candidate, 'api/src/application/nested folder')
  await mkdir(directory, { recursive: true })
  await writeFile(resolve(directory, 'élan source.ts'), 'export const value: any = 1\n')
  const application = resolve(candidate, 'api/src/application/start-submission.ts')
  await writeFile(application, `import './nested folder/élan source'\n${await readFile(application, 'utf8')}`)

  const result = await evaluateCandidate(candidate)
  const clarity = result.evidence.dimensions.find((dimension) => dimension.dimension === 'clarity')
  const explicitAny = clarity.checks.find((check) => check.id === 'clarity.no-explicit-any')
  assert.ok(explicitAny.locations.some((location) => location.path === 'api/src/application/nested folder/élan source.ts'))
  assert.ok(result.evidence.sources.some((source) => source.path === 'api/src/application/nested folder/élan source.ts'))
})

test('keeps score-determining dependency paths and graph edges complete', async () => {
  const candidate = await mkdtemp(resolve(tmpdir(), 'ccb-evaluator-long-path-'))
  await cp(resolve(root, 'test/fixtures/passing'), candidate, { recursive: true })
  const chain = resolve(candidate, 'api/src/chain')
  await mkdir(chain, { recursive: true })
  const length = 70
  await Promise.all(Array.from({ length }, (_, index) => {
    const next = index === length - 1
      ? '../infrastructure/typeorm-submission-repository'
      : `./node-${String(index + 1).padStart(2, '0')}`
    return writeFile(
      resolve(chain, `node-${String(index).padStart(2, '0')}.ts`),
      `export { TypeOrmSubmissionRepository } from '${next}'\n`,
    )
  }))
  const providers = resolve(candidate, 'api/src/app.providers.ts')
  await writeFile(
    providers,
    (await readFile(providers, 'utf8')).replace(
      './infrastructure/typeorm-submission-repository',
      './chain/node-00',
    ),
  )

  const result = await evaluateCandidate(candidate)
  const architecture = result.evidence.dimensions.find((dimension) => dimension.dimension === 'architecture')
  const requiredPath = architecture.checks.find((check) => check.id === 'architecture.required-path.providers-infrastructure')
  assert.equal(requiredPath.status, 'passed')
  assert.ok(requiredPath.paths[0].nodes.length > 64)
  assert.equal(requiredPath.paths[0].nodes.length, requiredPath.paths[0].totalNodes)
  assert.equal(requiredPath.paths[0].truncated, false)
  assert.equal(result.evidence.structure.nodeCount, result.evidence.structure.nodes.length)
  assert.equal(result.evidence.structure.edgeCount, result.evidence.structure.edges.length)
  assert.equal(result.evidence.structure.edgesTruncated, false)
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

test('rejects candidate symlinks with a stable bounded diagnostic', async () => {
  const candidate = await mkdtemp(resolve(tmpdir(), 'ccb-evaluator-symlink-'))
  await symlink(tmpdir(), resolve(candidate, 'outside'))

  assert.deepEqual(await evaluateCandidate(candidate), {
    status: 'evaluator_error',
    diagnostic: {
      schemaVersion: 1,
      phase: 'candidate_inspection',
      code: 'candidate_tree_invalid',
      reason: 'candidate must not contain symbolic links',
    },
  })
})

test('rejects a candidate root symlink before static analysis', async () => {
  const target = await mkdtemp(resolve(tmpdir(), 'ccb-evaluator-target-'))
  const parent = await mkdtemp(resolve(tmpdir(), 'ccb-evaluator-root-link-'))
  const candidate = resolve(parent, 'candidate')
  await symlink(target, candidate)

  assert.deepEqual(await evaluateCandidate(candidate), {
    status: 'evaluator_error',
    diagnostic: {
      schemaVersion: 1,
      phase: 'candidate_inspection',
      code: 'candidate_tree_invalid',
      reason: 'candidate must not be a symbolic link',
    },
  })
})

test('reports inaccessible candidates without exposing the host path', async () => {
  const parent = await mkdtemp(resolve(tmpdir(), 'ccb-evaluator-missing-'))
  const candidate = resolve(parent, 'missing-candidate')
  const result = await evaluateCandidate(candidate)
  assert.equal(result.status, 'evaluator_error')
  assert.equal(result.diagnostic.schemaVersion, 1)
  assert.equal(result.diagnostic.phase, 'candidate_inspection')
  assert.equal(result.diagnostic.code, 'candidate_access_failed')
  assert.ok(result.diagnostic.reason.length <= 240)
  assert.ok(!result.diagnostic.reason.includes(parent))
  assert.match(result.diagnostic.reason, /\[REDACTED_PATH\]/)
})

test('reports invalid rule packs as a stable rule-pack failure', async () => {
  const candidate = resolve(root, 'test/fixtures/passing')
  const directory = await mkdtemp(resolve(tmpdir(), 'ccb-evaluator-invalid-rule-'))
  const invalidConfig = resolve(directory, 'invalid.cjs')
  await writeFile(invalidConfig, 'module.exports = {}\n')
  const result = await evaluateCandidate(candidate, invalidConfig)
  assert.deepEqual(result, {
    status: 'evaluator_error',
    diagnostic: {
      schemaVersion: 1,
      phase: 'rule_pack',
      code: 'rule_pack_invalid',
      reason: 'rule pack must define ccb architecture and quality settings',
    },
  })
})

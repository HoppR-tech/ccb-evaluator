import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { lstat, mkdir, opendir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const MAX_CANDIDATE_ENTRIES = 10_000
const MAX_CANDIDATE_BYTES = 50 * 1024 * 1024
const MAX_ANALYZER_OUTPUT_BYTES = 10 * 1024 * 1024
const ANALYZER_TIMEOUT_MS = 30_000
const DIMENSIONS = ['architecture', 'maintainability', 'clarity', 'tests', 'robustness']
const runnerRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const depcruise = resolve(runnerRoot, 'node_modules/dependency-cruiser/bin/dependency-cruise.mjs')
const options = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, argument, index, args) => {
    if (argument.startsWith('--')) pairs.push([argument.slice(2), args[index + 1]])
    return pairs
  }, [])
)
const required = ['candidate', 'rule-config', 'result']

if (required.some((name) => !options[name])) {
  throw new Error(`required options: ${required.map((name) => `--${name}`).join(', ')}`)
}

const result = resolve(options.result)
await mkdir(dirname(result), { recursive: true })

async function inspectCandidateTree(candidate) {
  const directories = [candidate]
  const files = []
  let entries = 0
  let bytes = 0

  while (directories.length > 0) {
    const directory = directories.pop()
    const handle = await opendir(directory)
    for await (const entry of handle) {
      entries += 1
      if (entries > MAX_CANDIDATE_ENTRIES) throw new Error('candidate exceeds static-analysis limits')

      const path = resolve(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('candidate must not contain symbolic links')
      if (entry.isDirectory()) directories.push(path)
      else if (entry.isFile()) {
        bytes += (await stat(path)).size
        if (bytes > MAX_CANDIDATE_BYTES) throw new Error('candidate exceeds static-analysis limits')
        files.push({ path, relativePath: relative(candidate, path).replaceAll('\\', '/') })
      } else {
        throw new Error('candidate must contain only regular files and directories')
      }
    }
  }
  return files
}

async function analyzeDependencies(candidate, ruleConfig) {
  const { promise, resolve: resolveEvaluation } = Promise.withResolvers()
  let output = ''
  let outputBytes = 0
  let outputTooLarge = false
  const child = spawn(process.execPath, [depcruise, '--config', ruleConfig, '--output-type', 'json', '--no-progress', '.'], {
    cwd: candidate,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: ANALYZER_TIMEOUT_MS,
  })

  child.stdout.on('data', (chunk) => {
    outputBytes += chunk.length
    if (outputBytes > MAX_ANALYZER_OUTPUT_BYTES) {
      outputTooLarge = true
      child.kill()
      return
    }
    output += chunk
  })
  child.stderr.resume()
  child.on('error', () => resolveEvaluation(null))
  child.on('close', (code, signal) => {
    if (signal || code === null || outputTooLarge) return resolveEvaluation(null)
    try {
      return resolveEvaluation(JSON.parse(output))
    } catch {
      return resolveEvaluation(null)
    }
  })
  return promise
}

function checkScore(checks) {
  if (checks.length === 0 || checks.some((check) => !Number.isFinite(check.weight) || check.weight <= 0)) return null
  const totalWeight = checks.reduce((total, check) => total + check.weight, 0)
  return checks.filter((check) => check.passed).reduce((total, check) => total + check.weight, 0) / totalWeight
}

function architectureEvaluation(graph, expectations) {
  const errors = graph?.summary?.error
  if (!Number.isInteger(errors) || errors < 0 || !Array.isArray(graph.modules)) return null

  const checks = []
  for (const expectation of expectations.requiredModules ?? []) {
    checks.push({ passed: graph.modules.some((module) => new RegExp(expectation.path).test(module.source)), weight: expectation.weight })
  }
  for (const expectation of expectations.requiredDependencies ?? []) {
    checks.push({
      passed: graph.modules.some((module) =>
        new RegExp(expectation.from).test(module.source)
        && module.dependencies.some((dependency) => new RegExp(expectation.to).test(dependency.resolved))
      ),
      weight: expectation.weight,
    })
  }
  checks.push({ passed: errors === 0, weight: expectations.dependencyCruiserWeight })
  const score = checkScore(checks)
  if (score === null) return null
  return { score, violations: errors + checks.filter((check) => !check.passed).length }
}

function isFunctionLike(node) {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
}

function functionComplexity(root) {
  let complexity = 1
  function visit(node) {
    if (node !== root && isFunctionLike(node)) return
    if (
      ts.isIfStatement(node)
      || ts.isForStatement(node)
      || ts.isForInStatement(node)
      || ts.isForOfStatement(node)
      || ts.isWhileStatement(node)
      || ts.isDoStatement(node)
      || ts.isCaseClause(node)
      || ts.isCatchClause(node)
      || ts.isConditionalExpression(node)
      || (ts.isBinaryExpression(node) && ['&&', '||', '??'].includes(node.operatorToken.getText()))
    ) complexity += 1
    ts.forEachChild(node, visit)
  }
  visit(root)
  return complexity
}

function callName(node) {
  if (ts.isIdentifier(node.expression)) return node.expression.text
  if (ts.isPropertyAccessExpression(node.expression)) return `${node.expression.expression.getText()}.${node.expression.name.text}`
  return ''
}
function normalizedModulePath(path) {
  return path.replace(/^\.\//, '').replaceAll('\\', '/')
}

function dependencyClosure(graph, entryPoints) {
  if (!Array.isArray(graph?.modules)) return new Set()
  const patterns = entryPoints.map((pattern) => new RegExp(pattern))
  const modules = new Map(graph.modules.map((module) => [normalizedModulePath(module.source), module]))
  const selected = new Set([...modules.keys()].filter((source) => patterns.some((pattern) => pattern.test(source))))
  const pending = [...selected]
  while (pending.length > 0) {
    const module = modules.get(pending.pop())
    for (const dependency of module?.dependencies ?? []) {
      const resolved = normalizedModulePath(dependency.resolved)
      if (!modules.has(resolved) || selected.has(resolved)) continue
      selected.add(resolved)
      pending.push(resolved)
    }
  }
  return selected
}

async function sourceEvaluation(files, graph, quality) {
  const sourcePatterns = quality.sourceFiles.map((pattern) => new RegExp(pattern))
  const testPatterns = quality.testFiles.map((pattern) => new RegExp(pattern))
  const reachable = dependencyClosure(graph, quality.entryPoints)
  const testEntries = files.filter((file) => testPatterns.some((pattern) => pattern.test(file.relativePath)))
  const testPaths = new Set(testEntries.map((file) => file.relativePath))
  const sourceEntries = files.filter((file) => !testPaths.has(file.relativePath) && (
    sourcePatterns.some((pattern) => pattern.test(file.relativePath)) || reachable.has(file.relativePath)
  ))
  const limits = quality.limits
  const metrics = {
    sourceFiles: sourceEntries.length,
    testFiles: testEntries.length,
    maxFileLines: 0,
    maxFunctionLines: 0,
    maxParameters: 0,
    maxComplexity: 0,
    anyTypes: 0,
    suppressions: 0,
    nonNullAssertions: 0,
    testCases: 0,
    assertions: 0,
    focusedOrSkippedTests: 0,
    emptyCatches: 0,
    dangerousCalls: 0,
    dangerousImports: 0,
  }

  for (const entry of [...sourceEntries, ...testEntries]) {
    const text = await readFile(entry.path, 'utf8')
    const sourceFile = ts.createSourceFile(entry.relativePath, text, ts.ScriptTarget.Latest, true, entry.relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const lineCount = sourceFile.getLineAndCharacterOfPosition(sourceFile.end).line + 1
    if (sourceEntries.includes(entry)) metrics.maxFileLines = Math.max(metrics.maxFileLines, lineCount)
    metrics.suppressions += (text.match(/@ts-(?:ignore|nocheck|expect-error)|eslint-disable/g) ?? []).length

    function visit(node) {
      if (node.kind === ts.SyntaxKind.AnyKeyword) metrics.anyTypes += 1
      if (ts.isNonNullExpression(node)) metrics.nonNullAssertions += 1
      if (isFunctionLike(node) && sourceEntries.includes(entry)) {
        const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line
        const endLine = sourceFile.getLineAndCharacterOfPosition(node.end).line
        metrics.maxFunctionLines = Math.max(metrics.maxFunctionLines, endLine - startLine + 1)
        metrics.maxParameters = Math.max(metrics.maxParameters, node.parameters.length)
        metrics.maxComplexity = Math.max(metrics.maxComplexity, functionComplexity(node))
      }
      if (ts.isCatchClause(node) && node.block.statements.length === 0) metrics.emptyCatches += 1
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && quality.dangerousImports.includes(node.moduleSpecifier.text)) {
        metrics.dangerousImports += 1
      }
      if (
        ts.isImportEqualsDeclaration(node)
        && ts.isExternalModuleReference(node.moduleReference)
        && ts.isStringLiteral(node.moduleReference.expression)
        && quality.dangerousImports.includes(node.moduleReference.expression.text)
      ) metrics.dangerousImports += 1
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const aliasTarget = ts.isIdentifier(node.initializer)
          ? node.initializer.text
          : ts.isPropertyAccessExpression(node.initializer)
            ? node.initializer.getText()
            : ''
        if (quality.dangerousCalls.includes(aliasTarget)) metrics.dangerousCalls += 1
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const name = callName(node)
        if (quality.dangerousCalls.includes(name)) metrics.dangerousCalls += 1
        if (ts.isCallExpression(node)) {
          const moduleName = node.arguments[0]
          if (
            (name === 'require' || node.expression.kind === ts.SyntaxKind.ImportKeyword)
            && moduleName
            && ts.isStringLiteral(moduleName)
            && quality.dangerousImports.includes(moduleName.text)
          ) metrics.dangerousImports += 1
        }
        if (testEntries.includes(entry)) {
          if (/^(?:test|it)(?:\.(?:skip|only|todo))?$/.test(name)) metrics.testCases += 1
          if (/\.(?:skip|only|todo)$/.test(name)) metrics.focusedOrSkippedTests += 1
          if (name === 'expect' || name.startsWith('assert.')) metrics.assertions += 1
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }

  const checks = {
    maintainability: [
      metrics.sourceFiles > 0,
      metrics.maxFileLines <= limits.maxFileLines,
      metrics.maxFunctionLines <= limits.maxFunctionLines,
      metrics.maxParameters <= limits.maxParameters,
      metrics.maxComplexity <= limits.maxComplexity,
    ],
    clarity: [
      metrics.sourceFiles > 0,
      metrics.anyTypes === 0,
      metrics.suppressions === 0,
      metrics.nonNullAssertions === 0,
    ],
    tests: [
      metrics.testFiles >= limits.minTestFiles,
      metrics.testCases >= limits.minTestCases,
      metrics.assertions >= limits.minAssertions,
      metrics.focusedOrSkippedTests === 0,
    ],
    robustness: [
      metrics.sourceFiles > 0,
      metrics.emptyCatches === 0,
      metrics.dangerousCalls === 0,
      metrics.dangerousImports === 0,
    ],
  }

  return Object.fromEntries(Object.entries(checks).map(([dimension, results]) => [dimension, {
    score: results.filter(Boolean).length / results.length,
    violations: results.filter((passed) => !passed).length,
  }]))
}

function finalEvaluation(architecture, source, quality) {
  const dimensions = {
    architecture: architecture.score,
    maintainability: source.maintainability.score,
    clarity: source.clarity.score,
    tests: source.tests.score,
    robustness: source.robustness.score,
  }
  const weights = quality.weights
  if (DIMENSIONS.some((dimension) => !Number.isFinite(weights[dimension]) || weights[dimension] <= 0)) return { status: 'evaluator_error' }
  const totalWeight = DIMENSIONS.reduce((total, dimension) => total + weights[dimension], 0)
  const qualityScore = DIMENSIONS.reduce((total, dimension) => total + dimensions[dimension] * weights[dimension], 0) / totalWeight
  const qualityQualified = qualityScore >= quality.qualifiedThreshold
    && DIMENSIONS.every((dimension) => dimensions[dimension] >= quality.minimums[dimension])
  const violations = architecture.violations
    + source.maintainability.violations
    + source.clarity.violations
    + source.tests.violations
    + source.robustness.violations
  return {
    status: qualityQualified ? 'passing' : 'failing',
    violations,
    qualityScore,
    qualityQualified,
    dimensions,
  }
}

let evaluation
try {
  const candidatePath = resolve(options.candidate)
  if ((await lstat(candidatePath)).isSymbolicLink()) throw new Error('candidate must not be a symbolic link')
  const candidate = await realpath(candidatePath)
  const ruleConfig = await realpath(options['rule-config'])
  if (!(await stat(candidate)).isDirectory() || (await stat(ruleConfig)).isDirectory()) {
    throw new Error('candidate must be a directory and rule-config must be a file')
  }
  const files = await inspectCandidateTree(candidate)
  const rulePack = createRequire(import.meta.url)(ruleConfig).ccb
  if (!rulePack?.quality) throw new Error('rule pack must define ccb.quality')
  const graph = await analyzeDependencies(candidate, ruleConfig)
  const architecture = architectureEvaluation(graph, rulePack.architecture)
  if (architecture === null) throw new Error('architecture analysis failed')
  const source = await sourceEvaluation(files, graph, rulePack.quality)
  evaluation = finalEvaluation(architecture, source, rulePack.quality)
} catch {
  evaluation = { status: 'evaluator_error' }
}

await writeFile(result, `${JSON.stringify(evaluation)}\n`)

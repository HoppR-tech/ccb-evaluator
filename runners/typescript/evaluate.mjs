import { createHash } from 'node:crypto'
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
const EVIDENCE_SCHEMA_VERSION = 1
const MAX_EVIDENCE_LOCATIONS = 6
const MAX_EVIDENCE_PATHS = 6
const MAX_SNIPPET_CHARACTERS = 180
const MAX_EVIDENCE_PATH_CHARACTERS = 1_024
const MAX_CANONICAL_SOURCE_BYTES = 4 * 1024 * 1024
const MAX_RESULT_BYTES = 16 * 1024 * 1024
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
        files.push({ path, relativePath: candidateEvidencePath(relative(candidate, path).replaceAll('\\', '/')) })
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

function candidateEvidencePath(path) {
  const normalized = normalizedModulePath(path)
  if (
    normalized.length === 0
    || normalized.length > MAX_EVIDENCE_PATH_CHARACTERS
    || normalized.startsWith('/')
    || normalized.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) throw new Error('candidate path cannot be represented safely')
  return normalized
}

function redactSecrets(value) {
  let redactions = 0
  let redacted = value
  function replace(pattern, replacement) {
    redacted = redacted.replace(pattern, (...match) => {
      redactions += 1
      return typeof replacement === 'function' ? replacement(...match) : replacement
    })
  }
  replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi, (_match, scheme) => `${scheme}[REDACTED]:[REDACTED]@`)
  replace(/(password|passwd|secret|token|api[_-]?key|authorization|credential|private[_-]?key|connection[_-]?string)(\s*[:=]\s*)(["'`])[^"'`\r\n]*\3/gi, (_match, name, separator, quote) => `${name}${separator}${quote}[REDACTED]${quote}`)
  replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, 'Bearer [REDACTED]')
  replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED]')
  replace(/\bgh[pousr]_[A-Za-z0-9_]{12,}\b/g, '[REDACTED]')
  replace(/-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----/g, '[REDACTED PEM HEADER]')
  replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[REDACTED]')
  replace(/(["'`])[A-Za-z0-9+/=_-]{24,}\1/g, '$1[REDACTED]$1')
  replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '�')
  return { text: redacted, redactions }
}

function redactedSnippet(value) {
  return redactSecrets(value).text
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SNIPPET_CHARACTERS)
}

function sourceLocation(sourceFile, node, endNode = node) {
  const path = candidateEvidencePath(sourceFile.fileName)
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  const end = sourceFile.getLineAndCharacterOfPosition(endNode.end)
  const lineText = sourceFile.text.split(/\r?\n/, start.line + 1)[start.line] ?? ''
  return {
    path,
    line: start.line + 1,
    endLine: Math.max(start.line + 1, end.line + 1),
    snippet: redactedSnippet(lineText),
  }
}

async function fileLocation(files, path, endLine = 1) {
  const entry = files.find((file) => normalizedModulePath(file.relativePath) === normalizedModulePath(path))
  if (!entry) return null
  const text = await readFile(entry.path, 'utf8')
  const snippet = redactedSnippet(text.split(/\r?\n/, 1)[0] ?? '')
  return { path: candidateEvidencePath(entry.relativePath), line: 1, endLine: Math.max(1, endLine), snippet }
}

function boundedLocations(locations) {
  const unique = new Map()
  for (const location of locations) {
    if (!location) continue
    unique.set(`${location.path}:${location.line}:${location.endLine}:${location.snippet}:${location.message ?? ''}`, location)
  }
  const all = [...unique.values()]
  return {
    items: all.slice(0, MAX_EVIDENCE_LOCATIONS),
    total: all.length,
  }
}

function boundedPaths(paths) {
  const normalized = paths.slice(0, MAX_EVIDENCE_PATHS).map((path) => ({
    nodes: path.map(candidateEvidencePath),
    totalNodes: path.length,
    truncated: false,
  }))
  return {
    items: normalized,
    total: paths.length,
  }
}

function scoreCheck({
  id,
  dimension,
  title,
  passed,
  weight = 1,
  mandatory = false,
  observed,
  operator,
  threshold,
  expected,
  locations = [],
  locationCount = locations.length,
  paths = [],
  violations = passed ? 0 : 1,
}) {
  if (
    typeof id !== 'string'
    || !/^[a-z][a-z0-9.-]+$/.test(id)
    || typeof title !== 'string'
    || title.length === 0
    || !['eq', 'gte', 'lte', 'exists', 'not_exists'].includes(operator)
    || !['string', 'number', 'boolean'].includes(typeof observed)
    || !['string', 'number', 'boolean'].includes(typeof threshold)
    || !Number.isFinite(weight)
    || weight <= 0
    || !Number.isInteger(violations)
    || violations < 0
  ) throw new Error('invalid evidence check')
  const bounded = boundedLocations(locations)
  const boundedArchitecturePaths = boundedPaths(paths)
  return {
    id,
    dimension,
    title,
    status: passed ? 'passed' : 'failed',
    mandatory,
    earned: passed ? weight : 0,
    max: weight,
    violations,
    observed: typeof observed === 'string' ? observed.slice(0, 240) : observed,
    operator,
    threshold: typeof threshold === 'string' ? threshold.slice(0, 240) : threshold,
    expected: String(expected).slice(0, 240),
    locations: bounded.items,
    locationCount: Math.max(locationCount, bounded.total),
    locationsTruncated: Math.max(locationCount, bounded.total) > bounded.items.length,
    paths: boundedArchitecturePaths.items,
    pathCount: boundedArchitecturePaths.total,
    pathsTruncated: boundedArchitecturePaths.total > boundedArchitecturePaths.items.length,
  }
}

function checkScore(checks) {
  if (checks.length === 0 || checks.some((check) => !Number.isFinite(check.max) || check.max <= 0)) return null
  const total = checks.reduce((sum, check) => sum + check.max, 0)
  return checks.reduce((sum, check) => sum + check.earned, 0) / total
}

function dependencyPath(graph, fromPattern, toPattern) {
  const from = new RegExp(fromPattern)
  const to = new RegExp(toPattern)
  const modules = new Map(graph.modules.map((module) => [normalizedModulePath(module.source), module]))
  const starts = [...modules.keys()].filter((source) => from.test(source))
  const pending = [...starts]
  const visited = new Set(starts)
  const previous = new Map()
  while (pending.length > 0) {
    const source = pending.shift()
    if (source !== undefined && to.test(source)) {
      const path = [source]
      let cursor = source
      while (previous.has(cursor)) {
        cursor = previous.get(cursor)
        path.unshift(cursor)
      }
      return path
    }
    for (const dependency of modules.get(source)?.dependencies ?? []) {
      const resolved = normalizedModulePath(dependency.resolved)
      if (!modules.has(resolved) || visited.has(resolved)) continue
      visited.add(resolved)
      previous.set(resolved, source)
      pending.push(resolved)
    }
  }
  return null
}

async function dependencyLocation(files, graph, fromPath, toPath) {
  const module = graph.modules.find((entry) => normalizedModulePath(entry.source) === normalizedModulePath(fromPath))
  const dependency = module?.dependencies?.find((entry) => normalizedModulePath(entry.resolved) === normalizedModulePath(toPath))
  const sourceFile = await parsedSource(files, `^${escapeRegex(normalizedModulePath(fromPath))}$`)
  if (!dependency || !sourceFile) return fileLocation(files, fromPath)
  let match = null
  function visit(node) {
    if (!match && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === dependency.module) match = node
    if (!match) ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return match ? sourceLocation(sourceFile, match) : fileLocation(files, fromPath)
}

async function dependencyPathLocations(files, graph, path) {
  if (!path) return []
  const edgeCount = Math.min(Math.max(0, path.length - 1), MAX_EVIDENCE_LOCATIONS)
  return Promise.all(path.slice(0, edgeCount).map((from, index) => dependencyLocation(files, graph, from, path[index + 1])))
}

function architectureStructure(graph) {
  const edges = []
  const nodePaths = new Set()
  const edgeKeys = new Set()
  for (const module of graph.modules) {
    const from = candidateEvidencePath(module.source)
    nodePaths.add(from)
    for (const dependency of module.dependencies ?? []) {
      const to = candidateEvidencePath(dependency.resolved)
      nodePaths.add(to)
      const key = `${from}\0${to}`
      if (edgeKeys.has(key)) continue
      edgeKeys.add(key)
      edges.push({ from, to })
    }
  }
  const nodes = [...nodePaths].sort()
  edges.sort((left, right) => `${left.from}\0${left.to}`.localeCompare(`${right.from}\0${right.to}`))
  return {
    nodes,
    nodeCount: nodes.length,
    nodesTruncated: false,
    edges,
    edgeCount: edges.length,
    edgesTruncated: false,
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
async function parsedSource(files, pathPattern) {
  const pattern = new RegExp(pathPattern)
  const file = files.find((entry) => pattern.test(entry.relativePath))
  if (!file) return null
  const text = await readFile(file.path, 'utf8')
  return ts.createSourceFile(file.relativePath, text, ts.ScriptTarget.Latest, true, file.relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}

function importedSources(sourceFile) {
  const sources = new Map()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue
    const moduleName = staticText(statement.moduleSpecifier)
    if (!moduleName) continue
    if (statement.importClause.name) sources.set(statement.importClause.name.text, moduleName)
    const bindings = statement.importClause.namedBindings
    if (bindings && ts.isNamespaceImport(bindings)) sources.set(bindings.name.text, moduleName)
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) sources.set(element.name.text, moduleName)
    }
  }
  return sources
}

async function registeredImportEvidence(files, expectation) {
  const sourceFile = await parsedSource(files, expectation.module)
  if (!sourceFile) return { passed: false, locations: [], relatedPaths: [] }
  const imports = importedSources(sourceFile)
  const importPath = new RegExp(expectation.importPath)
  const fallback = sourceLocation(sourceFile, sourceFile.statements[0] ?? sourceFile)
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== expectation.exportName || !declaration.initializer || !ts.isArrayLiteralExpression(declaration.initializer)) continue
      for (const element of declaration.initializer.elements) {
        const value = ts.isSpreadElement(element) ? element.expression : element
        if (ts.isIdentifier(value) && importPath.test(imports.get(value.text) ?? '')) {
          return {
            passed: true,
            locations: [sourceLocation(sourceFile, element)],
            relatedPaths: [sourceFile.fileName],
          }
        }
      }
      return { passed: false, locations: [sourceLocation(sourceFile, declaration)], relatedPaths: [sourceFile.fileName] }
    }
  }
  return { passed: false, locations: [fallback], relatedPaths: [sourceFile.fileName] }
}

async function objectPropertyImportEvidence(files, expectation) {
  const sourceFile = await parsedSource(files, expectation.module)
  if (!sourceFile) return { passed: false, locations: [], relatedPaths: [] }
  const imports = importedSources(sourceFile)
  const importPath = new RegExp(expectation.importPath)
  const fallback = sourceLocation(sourceFile, sourceFile.statements[0] ?? sourceFile)
  let matchedProperty = null
  function visit(node) {
    if (matchedProperty || !ts.isCallExpression(node) || expressionName(node.expression) !== expectation.call) {
      if (!matchedProperty) ts.forEachChild(node, visit)
      return
    }
    const object = node.arguments[0]
    if (!object || !ts.isObjectLiteralExpression(object)) return
    matchedProperty = object.properties.find((property) => {
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === expectation.property) {
        return importPath.test(imports.get(property.name.text) ?? '')
      }
      return ts.isPropertyAssignment(property)
        && property.name.getText(sourceFile).replaceAll(/[\"']/g, '') === expectation.property
        && ts.isIdentifier(property.initializer)
        && importPath.test(imports.get(property.initializer.text) ?? '')
    }) ?? null
  }
  visit(sourceFile)
  return {
    passed: matchedProperty !== null,
    locations: [matchedProperty ? sourceLocation(sourceFile, matchedProperty) : fallback],
    relatedPaths: [sourceFile.fileName],
  }
}

async function architectureEvaluation(graph, expectations, files) {
  const errors = graph?.summary?.error
  if (!Number.isInteger(errors) || errors < 0 || !Array.isArray(graph.modules)) return null

  const checks = []
  for (const expectation of expectations.requiredModules ?? []) {
    const matches = graph.modules
      .map((module) => normalizedModulePath(module.source))
      .filter((source) => new RegExp(expectation.path).test(source))
    checks.push(scoreCheck({
      id: expectation.id,
      dimension: 'architecture',
      title: expectation.title,
      passed: matches.length > 0,
      weight: expectation.weight,
      mandatory: expectation.mandatory === true,
      observed: matches.length,
      operator: 'gte',
      threshold: 1,
      expected: `at least one module matching ${expectation.path}`,
      locations: await Promise.all(matches.slice(0, MAX_EVIDENCE_LOCATIONS).map((path) => fileLocation(files, path))),
      locationCount: matches.length,
      paths: matches.map((path) => [path]),
    }))
  }
  for (const expectation of expectations.requiredDependencies ?? []) {
    const matches = graph.modules.flatMap((module) => {
      const from = normalizedModulePath(module.source)
      if (!new RegExp(expectation.from).test(from)) return []
      return module.dependencies
        .map((dependency) => ({ from, to: normalizedModulePath(dependency.resolved) }))
        .filter(({ to }) => new RegExp(expectation.to).test(to))
    })
    checks.push(scoreCheck({
      id: expectation.id,
      dimension: 'architecture',
      title: expectation.title,
      passed: matches.length > 0,
      weight: expectation.weight,
      mandatory: expectation.mandatory === true,
      observed: matches.length,
      operator: 'gte',
      threshold: 1,
      expected: `${expectation.from} directly depends on ${expectation.to}`,
      locations: await Promise.all(matches.slice(0, MAX_EVIDENCE_LOCATIONS).map(({ from, to }) => dependencyLocation(files, graph, from, to))),
      locationCount: matches.length,
      paths: matches.map(({ from, to }) => [from, to]),
    }))
  }
  for (const expectation of expectations.requiredReachability ?? []) {
    const path = dependencyPath(graph, expectation.from, expectation.to)
    checks.push(scoreCheck({
      id: expectation.id,
      dimension: 'architecture',
      title: expectation.title,
      passed: path !== null,
      weight: expectation.weight,
      mandatory: expectation.mandatory === true,
      observed: path !== null,
      operator: 'exists',
      threshold: true,
      expected: `${expectation.from} reaches ${expectation.to}`,
      locations: await dependencyPathLocations(files, graph, path),
      locationCount: path ? Math.max(0, path.length - 1) : 0,
      paths: path ? [path] : [],
    }))
  }
  for (const expectation of expectations.forbiddenReachability ?? []) {
    const path = dependencyPath(graph, expectation.from, expectation.to)
    checks.push(scoreCheck({
      id: expectation.id,
      dimension: 'architecture',
      title: expectation.title,
      passed: path === null,
      weight: expectation.weight,
      mandatory: expectation.mandatory === true,
      observed: path !== null,
      operator: 'not_exists',
      threshold: false,
      expected: `${expectation.from} must not reach ${expectation.to}`,
      locations: await dependencyPathLocations(files, graph, path),
      locationCount: path ? Math.max(0, path.length - 1) : 0,
      paths: path ? [path] : [],
    }))
  }
  for (const expectation of expectations.requiredRegistrations ?? []) {
    const evidence = await registeredImportEvidence(files, expectation)
    checks.push(scoreCheck({
      id: expectation.id,
      dimension: 'architecture',
      title: expectation.title,
      passed: evidence.passed,
      weight: expectation.weight,
      mandatory: expectation.mandatory === true,
      observed: evidence.passed,
      operator: 'eq',
      threshold: true,
      expected: `${expectation.exportName} registers an import matching ${expectation.importPath}`,
      locations: evidence.locations,
      paths: evidence.relatedPaths.map((path) => [path]),
    }))
  }
  for (const expectation of expectations.requiredObjectProperties ?? []) {
    const evidence = await objectPropertyImportEvidence(files, expectation)
    checks.push(scoreCheck({
      id: expectation.id,
      dimension: 'architecture',
      title: expectation.title,
      passed: evidence.passed,
      weight: expectation.weight,
      mandatory: expectation.mandatory === true,
      observed: evidence.passed,
      operator: 'eq',
      threshold: true,
      expected: `${expectation.call} receives ${expectation.property} from an import matching ${expectation.importPath}`,
      locations: evidence.locations,
      paths: evidence.relatedPaths.map((path) => [path]),
    }))
  }
  const dependencyViolations = Array.isArray(graph.summary?.violations)
    ? graph.summary.violations.filter((violation) => violation?.type === 'dependency')
    : []
  const dependencyLocations = await Promise.all(dependencyViolations.slice(0, MAX_EVIDENCE_LOCATIONS).map(async (violation) => {
    const location = await dependencyLocation(files, graph, violation.from, violation.to)
    return location ? {
      ...location,
      message: `${violation.rule?.name ?? 'unknown-rule'}: ${normalizedModulePath(violation.from)} -> ${normalizedModulePath(violation.to)}`,
    } : null
  }))
  checks.push(scoreCheck({
    id: expectations.dependencyCruiserId,
    dimension: 'architecture',
    title: expectations.dependencyCruiserTitle,
    passed: errors === 0,
    weight: expectations.dependencyCruiserWeight,
    mandatory: expectations.dependencyCruiserMandatory === true,
    observed: errors,
    operator: 'eq',
    threshold: 0,
    expected: 'zero dependency-cruiser errors',
    locations: dependencyLocations,
    locationCount: dependencyViolations.length,
    paths: dependencyViolations.map((violation) => [violation.from, violation.to]),
    violations: errors + (errors === 0 ? 0 : 1),
  }))
  const score = checkScore(checks)
  if (score === null) return null
  return {
    score,
    qualified: checks.every((check) => !check.mandatory || check.status === 'passed'),
    violations: checks.reduce((total, check) => total + check.violations, 0),
    checks,
    structure: architectureStructure(graph),
  }
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

function staticText(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null
}

function expressionName(expression) {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) {
    const owner = expressionName(expression.expression)
    return owner ? `${owner}.${expression.name.text}` : expression.getText()
  }
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
    const owner = expressionName(expression.expression)
    const property = staticText(expression.argumentExpression)
    return owner && property ? `${owner}.${property}` : ''
  }
  return ''
}

function assertionNodes(root) {
  const assertions = []
  function visit(node) {
    if (node !== root && isFunctionLike(node)) return
    if (ts.isCallExpression(node)) {
      const name = expressionName(node.expression)
      if (name === 'expect' || name.startsWith('assert.')) assertions.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return assertions
}

function textLocation(sourceFile, start, length) {
  const path = candidateEvidencePath(sourceFile.fileName)
  const line = sourceFile.getLineAndCharacterOfPosition(start).line
  const endLine = sourceFile.getLineAndCharacterOfPosition(start + length).line
  return {
    path,
    line: line + 1,
    endLine: endLine + 1,
    snippet: redactedSnippet(sourceFile.text.split(/\r?\n/, line + 1)[line] ?? ''),
  }
}
function normalizedModulePath(path) {
  return path.replace(/^\.\//, '').replaceAll('\\', '/').normalize('NFC')
}

function dependencyClosure(graph, patterns, excludedPaths) {
  if (!Array.isArray(graph?.modules)) return new Set()
  const matchers = patterns.map((pattern) => new RegExp(pattern))
  const modules = new Map(graph.modules.map((module) => [normalizedModulePath(module.source), module]))
  const selected = new Set([...modules.keys()].filter((source) =>
    !excludedPaths.has(source) && matchers.some((pattern) => pattern.test(source))
  ))
  const pending = [...selected]
  while (pending.length > 0) {
    const source = pending.pop()
    for (const dependency of modules.get(source)?.dependencies ?? []) {
      const resolved = normalizedModulePath(dependency.resolved)
      if (!modules.has(resolved) || selected.has(resolved) || excludedPaths.has(resolved)) continue
      selected.add(resolved)
      pending.push(resolved)
    }
  }
  return selected
}

async function sourceEvaluation(files, graph, quality) {
  const sourcePatterns = quality.sourceFiles.map((pattern) => new RegExp(pattern))
  const testPatterns = quality.testFiles.map((pattern) => new RegExp(pattern))
  const testEntries = files.filter((file) => testPatterns.some((pattern) => pattern.test(file.relativePath)))
  const testPaths = new Set(testEntries.map((file) => normalizedModulePath(file.relativePath)))
  const reachable = dependencyClosure(graph, [...quality.sourceFiles, ...quality.entryPoints], testPaths)
  const sourceEntries = files.filter((file) => {
    const path = normalizedModulePath(file.relativePath)
    return !testPaths.has(path) && (reachable.has(path) || sourcePatterns.some((pattern) => pattern.test(path)))
  })
  const sourcePaths = new Set(sourceEntries.map((file) => normalizedModulePath(file.relativePath)))
  const evaluatedEntries = [...sourceEntries, ...testEntries]
    .sort((left, right) => normalizedModulePath(left.relativePath).localeCompare(normalizedModulePath(right.relativePath)))
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
    testCasesWithAssertions: 0,
    assertions: 0,
    focusedOrSkippedTests: 0,
    emptyCatches: 0,
    dangerousCalls: 0,
    dangerousImports: 0,
  }
  const locations = Object.fromEntries(Object.keys(metrics).map((name) => [name, []]))
  const locationCounts = Object.fromEntries(Object.keys(metrics).map((name) => [name, 0]))
  const inventory = []
  const sources = []
  let sourceBytes = 0
  function addLocation(name, location) {
    if (!location) return
    locationCounts[name] += 1
    if (locations[name].length < MAX_EVIDENCE_LOCATIONS) locations[name].push(location)
  }
  function updateMaximum(name, value, location) {
    if (value > metrics[name]) {
      metrics[name] = value
      locations[name] = []
      locationCounts[name] = 0
      addLocation(name, location)
    } else if (value === metrics[name]) {
      addLocation(name, location)
    }
  }

  for (const entry of evaluatedEntries) {
    const text = await readFile(entry.path, 'utf8')
    const canonicalText = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
    const redactedSource = redactSecrets(canonicalText)
    sourceBytes += Buffer.byteLength(redactedSource.text)
    if (sourceBytes > MAX_CANONICAL_SOURCE_BYTES) throw new Error('canonical source evidence exceeds limit')
    sources.push({
      path: candidateEvidencePath(entry.relativePath),
      digest: `sha256:${createHash('sha256').update(text).digest('hex')}`,
      lineCount: canonicalText.split('\n').length,
      redactionCount: redactedSource.redactions,
      content: redactedSource.text,
    })
    const sourceFile = ts.createSourceFile(entry.relativePath, text, ts.ScriptTarget.Latest, true, entry.relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const path = normalizedModulePath(entry.relativePath)
    const isSource = sourcePaths.has(path)
    const isTest = testPaths.has(path)
    const firstNode = sourceFile.statements[0] ?? sourceFile
    if (isSource) addLocation('sourceFiles', sourceLocation(sourceFile, firstNode))
    if (isTest) addLocation('testFiles', sourceLocation(sourceFile, firstNode))
    const fileMetrics = {
      functions: 0,
      maxFunctionLines: 0,
      maxParameters: 0,
      maxComplexity: 0,
      anyTypes: 0,
      suppressions: 0,
      nonNullAssertions: 0,
      testCases: 0,
      testCasesWithAssertions: 0,
      assertions: 0,
      focusedOrSkippedTests: 0,
      emptyCatches: 0,
      dangerousCalls: 0,
      dangerousImports: 0,
    }

    const dangerousCallAliases = new Set(quality.dangerousCalls)
    const dangerousImportAliases = new Set(['require'])
    const aliases = []
    const namedCallbacks = new Map()
    function collectDeclarations(node) {
      if (ts.isFunctionDeclaration(node) && node.name) namedCallbacks.set(node.name.text, node)
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        aliases.push({ name: node.name.text, target: expressionName(node.initializer) })
        if (isFunctionLike(node.initializer)) namedCallbacks.set(node.name.text, node.initializer)
      }
      ts.forEachChild(node, collectDeclarations)
    }
    collectDeclarations(sourceFile)
    let aliasesChanged
    do {
      aliasesChanged = false
      for (const alias of aliases) {
        if (dangerousCallAliases.has(alias.target) && !dangerousCallAliases.has(alias.name)) {
          dangerousCallAliases.add(alias.name)
          aliasesChanged = true
        }
        if (dangerousImportAliases.has(alias.target) && !dangerousImportAliases.has(alias.name)) {
          dangerousImportAliases.add(alias.name)
          aliasesChanged = true
        }
      }
    } while (aliasesChanged)

    const lineCount = sourceFile.getLineAndCharacterOfPosition(sourceFile.end).line + 1
    const safePath = candidateEvidencePath(entry.relativePath)
    if (isSource) {
      updateMaximum('maxFileLines', lineCount, {
        path: safePath,
        line: 1,
        endLine: lineCount,
        snippet: redactedSnippet(text.split(/\r?\n/, 1)[0] ?? ''),
      })
    }
    for (const match of text.matchAll(/@ts-(?:ignore|nocheck|expect-error)|eslint-disable/g)) {
      metrics.suppressions += 1
      fileMetrics.suppressions += 1
      addLocation('suppressions', textLocation(sourceFile, match.index, match[0].length))
    }

    function visit(node) {
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        metrics.anyTypes += 1
        fileMetrics.anyTypes += 1
        addLocation('anyTypes', sourceLocation(sourceFile, node))
      }
      if (ts.isNonNullExpression(node)) {
        metrics.nonNullAssertions += 1
        fileMetrics.nonNullAssertions += 1
        addLocation('nonNullAssertions', sourceLocation(sourceFile, node))
      }
      if (isFunctionLike(node) && isSource) {
        const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line
        const endLine = sourceFile.getLineAndCharacterOfPosition(node.end).line
        const functionLines = endLine - startLine + 1
        const complexity = functionComplexity(node)
        const location = sourceLocation(sourceFile, node)
        fileMetrics.functions += 1
        fileMetrics.maxFunctionLines = Math.max(fileMetrics.maxFunctionLines, functionLines)
        fileMetrics.maxParameters = Math.max(fileMetrics.maxParameters, node.parameters.length)
        fileMetrics.maxComplexity = Math.max(fileMetrics.maxComplexity, complexity)
        updateMaximum('maxFunctionLines', functionLines, location)
        updateMaximum('maxParameters', node.parameters.length, location)
        updateMaximum('maxComplexity', complexity, location)
      }
      if (ts.isCatchClause(node) && node.block.statements.length === 0) {
        metrics.emptyCatches += 1
        fileMetrics.emptyCatches += 1
        addLocation('emptyCatches', sourceLocation(sourceFile, node))
      }
      if (ts.isImportDeclaration(node)) {
        const moduleName = staticText(node.moduleSpecifier)
        if (moduleName && quality.dangerousImports.includes(moduleName)) {
          metrics.dangerousImports += 1
          fileMetrics.dangerousImports += 1
          addLocation('dangerousImports', sourceLocation(sourceFile, node))
        }
      }
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        const moduleName = node.moduleReference.expression ? staticText(node.moduleReference.expression) : null
        if (moduleName && quality.dangerousImports.includes(moduleName)) {
          metrics.dangerousImports += 1
          fileMetrics.dangerousImports += 1
          addLocation('dangerousImports', sourceLocation(sourceFile, node))
        }
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const aliasTarget = expressionName(node.initializer)
        if (dangerousCallAliases.has(aliasTarget)) {
          dangerousCallAliases.add(node.name.text)
          metrics.dangerousCalls += 1
          fileMetrics.dangerousCalls += 1
          addLocation('dangerousCalls', sourceLocation(sourceFile, node))
        }
        if (dangerousImportAliases.has(aliasTarget)) dangerousImportAliases.add(node.name.text)
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const name = expressionName(node.expression)
        if (dangerousCallAliases.has(name)) {
          metrics.dangerousCalls += 1
          fileMetrics.dangerousCalls += 1
          addLocation('dangerousCalls', sourceLocation(sourceFile, node))
        }
        if (ts.isCallExpression(node)) {
          const moduleName = node.arguments[0] ? staticText(node.arguments[0]) : null
          if (
            (dangerousImportAliases.has(name) || node.expression.kind === ts.SyntaxKind.ImportKeyword)
            && moduleName
            && quality.dangerousImports.includes(moduleName)
          ) {
            metrics.dangerousImports += 1
            fileMetrics.dangerousImports += 1
            addLocation('dangerousImports', sourceLocation(sourceFile, node))
          }
        }
        if (isTest) {
          if (/^(?:test|it)$/.test(name)) {
            const argument = [...node.arguments].reverse().find((candidate) =>
              isFunctionLike(candidate) || (ts.isIdentifier(candidate) && namedCallbacks.has(candidate.text))
            )
            const callback = argument && ts.isIdentifier(argument) ? namedCallbacks.get(argument.text) : argument
            if (callback) {
              const assertions = assertionNodes(callback)
              metrics.testCases += 1
              fileMetrics.testCases += 1
              addLocation('testCases', sourceLocation(sourceFile, node))
              metrics.assertions += assertions.length
              fileMetrics.assertions += assertions.length
              for (const assertion of assertions) addLocation('assertions', sourceLocation(sourceFile, assertion))
              if (assertions.length > 0) {
                metrics.testCasesWithAssertions += 1
                fileMetrics.testCasesWithAssertions += 1
                addLocation('testCasesWithAssertions', sourceLocation(sourceFile, node))
              }
            }
          }
          if (/\.(?:skip|only|todo)$/.test(name)) {
            metrics.focusedOrSkippedTests += 1
            fileMetrics.focusedOrSkippedTests += 1
            addLocation('focusedOrSkippedTests', sourceLocation(sourceFile, node))
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    inventory.push({
      path: safePath,
      kind: isSource ? 'source' : 'test',
      lines: lineCount,
      ...fileMetrics,
    })
  }

  const checks = {
    maintainability: [
      scoreCheck({ id: 'maintainability.source-files', dimension: 'maintainability', title: 'Evaluated source files exist', passed: metrics.sourceFiles > 0, observed: metrics.sourceFiles, operator: 'gte', threshold: 1, expected: 'at least 1 source file', locations: locations.sourceFiles, locationCount: locationCounts.sourceFiles }),
      scoreCheck({ id: 'maintainability.max-file-lines', dimension: 'maintainability', title: 'Files stay within the line limit', passed: metrics.maxFileLines <= limits.maxFileLines, observed: metrics.maxFileLines, operator: 'lte', threshold: limits.maxFileLines, expected: `at most ${limits.maxFileLines} lines`, locations: locations.maxFileLines, locationCount: locationCounts.maxFileLines }),
      scoreCheck({ id: 'maintainability.max-function-lines', dimension: 'maintainability', title: 'Functions stay within the line limit', passed: metrics.maxFunctionLines <= limits.maxFunctionLines, observed: metrics.maxFunctionLines, operator: 'lte', threshold: limits.maxFunctionLines, expected: `at most ${limits.maxFunctionLines} lines`, locations: locations.maxFunctionLines, locationCount: locationCounts.maxFunctionLines }),
      scoreCheck({ id: 'maintainability.max-parameters', dimension: 'maintainability', title: 'Functions stay within the parameter limit', passed: metrics.maxParameters <= limits.maxParameters, observed: metrics.maxParameters, operator: 'lte', threshold: limits.maxParameters, expected: `at most ${limits.maxParameters} parameters`, locations: locations.maxParameters, locationCount: locationCounts.maxParameters }),
      scoreCheck({ id: 'maintainability.max-complexity', dimension: 'maintainability', title: 'Functions stay within the complexity limit', passed: metrics.maxComplexity <= limits.maxComplexity, observed: metrics.maxComplexity, operator: 'lte', threshold: limits.maxComplexity, expected: `at most ${limits.maxComplexity}`, locations: locations.maxComplexity, locationCount: locationCounts.maxComplexity }),
    ],
    clarity: [
      scoreCheck({ id: 'clarity.source-files', dimension: 'clarity', title: 'Evaluated source files exist', passed: metrics.sourceFiles > 0, observed: metrics.sourceFiles, operator: 'gte', threshold: 1, expected: 'at least 1 source file', locations: locations.sourceFiles, locationCount: locationCounts.sourceFiles }),
      scoreCheck({ id: 'clarity.no-explicit-any', dimension: 'clarity', title: 'No explicit any types', passed: metrics.anyTypes === 0, observed: metrics.anyTypes, operator: 'eq', threshold: 0, expected: '0 explicit any types', locations: locations.anyTypes, locationCount: locationCounts.anyTypes }),
      scoreCheck({ id: 'clarity.no-diagnostic-suppressions', dimension: 'clarity', title: 'No diagnostic suppressions', passed: metrics.suppressions === 0, observed: metrics.suppressions, operator: 'eq', threshold: 0, expected: '0 suppressions', locations: locations.suppressions, locationCount: locationCounts.suppressions }),
      scoreCheck({ id: 'clarity.no-non-null-assertions', dimension: 'clarity', title: 'No non-null assertions', passed: metrics.nonNullAssertions === 0, observed: metrics.nonNullAssertions, operator: 'eq', threshold: 0, expected: '0 non-null assertions', locations: locations.nonNullAssertions, locationCount: locationCounts.nonNullAssertions }),
    ],
    tests: [
      scoreCheck({ id: 'tests.test-files', dimension: 'tests', title: 'Targeted test files exist', passed: metrics.testFiles >= limits.minTestFiles, observed: metrics.testFiles, operator: 'gte', threshold: limits.minTestFiles, expected: `at least ${limits.minTestFiles} test file(s)`, locations: locations.testFiles, locationCount: locationCounts.testFiles }),
      scoreCheck({ id: 'tests.test-cases', dimension: 'tests', title: 'Enough test cases exist', passed: metrics.testCases >= limits.minTestCases, observed: metrics.testCases, operator: 'gte', threshold: limits.minTestCases, expected: `at least ${limits.minTestCases} test case(s)`, locations: locations.testCases, locationCount: locationCounts.testCases }),
      scoreCheck({ id: 'tests.test-cases-with-assertions', dimension: 'tests', title: 'Each required test case has assertions', passed: metrics.testCasesWithAssertions >= limits.minTestCases, observed: metrics.testCasesWithAssertions, operator: 'gte', threshold: limits.minTestCases, expected: `at least ${limits.minTestCases} test case(s) with assertions`, locations: locations.testCasesWithAssertions, locationCount: locationCounts.testCasesWithAssertions }),
      scoreCheck({ id: 'tests.assertions', dimension: 'tests', title: 'Enough assertions exist', passed: metrics.assertions >= limits.minAssertions, observed: metrics.assertions, operator: 'gte', threshold: limits.minAssertions, expected: `at least ${limits.minAssertions} assertion(s)`, locations: locations.assertions, locationCount: locationCounts.assertions }),
      scoreCheck({ id: 'tests.no-focused-or-skipped', dimension: 'tests', title: 'No focused or skipped tests', passed: metrics.focusedOrSkippedTests === 0, observed: metrics.focusedOrSkippedTests, operator: 'eq', threshold: 0, expected: '0 focused or skipped tests', locations: locations.focusedOrSkippedTests, locationCount: locationCounts.focusedOrSkippedTests }),
    ],
    robustness: [
      scoreCheck({ id: 'robustness.source-files', dimension: 'robustness', title: 'Evaluated source files exist', passed: metrics.sourceFiles > 0, observed: metrics.sourceFiles, operator: 'gte', threshold: 1, expected: 'at least 1 source file', locations: locations.sourceFiles, locationCount: locationCounts.sourceFiles }),
      scoreCheck({ id: 'robustness.no-empty-catches', dimension: 'robustness', title: 'No empty catch blocks', passed: metrics.emptyCatches === 0, observed: metrics.emptyCatches, operator: 'eq', threshold: 0, expected: '0 empty catch blocks', locations: locations.emptyCatches, locationCount: locationCounts.emptyCatches }),
      scoreCheck({ id: 'robustness.no-dynamic-code', dimension: 'robustness', title: 'No dynamic code execution', passed: metrics.dangerousCalls === 0, observed: metrics.dangerousCalls, operator: 'eq', threshold: 0, expected: '0 dangerous calls', locations: locations.dangerousCalls, locationCount: locationCounts.dangerousCalls }),
      scoreCheck({ id: 'robustness.no-process-imports', dimension: 'robustness', title: 'No process-spawning imports', passed: metrics.dangerousImports === 0, observed: metrics.dangerousImports, operator: 'eq', threshold: 0, expected: '0 dangerous imports', locations: locations.dangerousImports, locationCount: locationCounts.dangerousImports }),
    ],
  }
  const dimensions = Object.fromEntries(Object.entries(checks).map(([dimension, dimensionChecks]) => [dimension, {
    score: checkScore(dimensionChecks),
    violations: dimensionChecks.reduce((total, check) => total + check.violations, 0),
    checks: dimensionChecks,
  }]))
  return {
    dimensions,
    inventory: {
      sourceFileCount: sourceEntries.length,
      testFileCount: testEntries.length,
      fileCount: evaluatedEntries.length,
      files: inventory,
      omittedUnsafePathCount: 0,
      filesTruncated: false,
    },
    sources,
  }
}

function finalEvaluation(architecture, source, quality) {
  const results = { architecture, ...source.dimensions }
  const weights = quality.weights
  if (
    !Number.isFinite(quality.qualifiedThreshold)
    || quality.qualifiedThreshold < 0
    || quality.qualifiedThreshold > 1
    || DIMENSIONS.some((dimension) =>
      !Number.isFinite(weights[dimension])
      || weights[dimension] <= 0
      || !Number.isFinite(quality.minimums[dimension])
      || quality.minimums[dimension] < 0
      || quality.minimums[dimension] > 1
      || !Number.isFinite(results[dimension].score)
    )
  ) return { status: 'evaluator_error' }

  const dimensions = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, results[dimension].score]))
  const totalWeight = DIMENSIONS.reduce((total, dimension) => total + weights[dimension], 0)
  const earned = DIMENSIONS.reduce((total, dimension) => total + dimensions[dimension] * weights[dimension], 0)
  const qualityScore = earned / totalWeight
  const evidenceDimensions = DIMENSIONS.map((dimension) => {
    const checks = results[dimension].checks
    const dimensionEarned = checks.reduce((total, check) => total + check.earned, 0)
    const dimensionMax = checks.reduce((total, check) => total + check.max, 0)
    return {
      dimension,
      score: dimensions[dimension],
      earned: dimensionEarned,
      max: dimensionMax,
      weight: weights[dimension],
      minimum: quality.minimums[dimension],
      qualified: dimensions[dimension] >= quality.minimums[dimension]
        && checks.every((check) => !check.mandatory || check.status === 'passed'),
      checks,
    }
  })
  const checkIds = evidenceDimensions.flatMap((dimension) => dimension.checks.map((check) => check.id))
  if (new Set(checkIds).size !== checkIds.length) return { status: 'evaluator_error' }
  const qualityQualified = qualityScore >= quality.qualifiedThreshold
    && evidenceDimensions.every((dimension) => dimension.qualified)
  const violations = evidenceDimensions.reduce(
    (total, dimension) => total + dimension.checks.reduce((sum, check) => sum + check.violations, 0),
    0,
  )
  return {
    status: qualityQualified ? 'passing' : 'failing',
    violations,
    qualityScore,
    qualityQualified,
    dimensions,
    evidence: {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      overall: {
        score: qualityScore,
        earned,
        max: totalWeight,
        qualifiedThreshold: quality.qualifiedThreshold,
        qualified: qualityQualified,
      },
      dimensions: evidenceDimensions,
      inventory: source.inventory,
      sources: source.sources,
      structure: architecture.structure,
    },
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
  const architecture = await architectureEvaluation(graph, rulePack.architecture, files)
  if (architecture === null) throw new Error('architecture analysis failed')
  const source = await sourceEvaluation(files, graph, rulePack.quality)
  evaluation = finalEvaluation(architecture, source, rulePack.quality)
} catch {
  evaluation = { status: 'evaluator_error' }
}

const serialized = `${JSON.stringify(evaluation)}\n`
await writeFile(result, Buffer.byteLength(serialized) > MAX_RESULT_BYTES ? '{"status":"evaluator_error"}\n' : serialized)

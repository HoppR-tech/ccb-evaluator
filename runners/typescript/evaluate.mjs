import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { lstat, mkdir, opendir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_CANDIDATE_ENTRIES = 10_000
const MAX_CANDIDATE_BYTES = 50 * 1024 * 1024
const MAX_ANALYZER_OUTPUT_BYTES = 10 * 1024 * 1024
const ANALYZER_TIMEOUT_MS = 30_000
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
      } else {
        throw new Error('candidate must contain only regular files and directories')
      }
    }
  }
}

async function analyze(candidate, ruleConfig) {
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

function score(graph, expectations) {
  const errors = graph?.summary?.error
  if (!Number.isInteger(errors) || errors < 0 || !Array.isArray(graph.modules)) return { status: 'evaluator_error' }

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

  if (checks.length === 0 || checks.some((check) => !Number.isFinite(check.weight) || check.weight <= 0)) {
    return { status: 'evaluator_error' }
  }
  const passed = checks.filter((check) => check.passed)
  const rawScore = passed.length / checks.length
  const totalWeight = checks.reduce((total, check) => total + check.weight, 0)
  const weightedScore = passed.reduce((total, check) => total + check.weight, 0) / totalWeight
  const violations = errors + checks.length - passed.length
  return {
    status: violations === 0 ? 'passing' : 'failing',
    violations,
    score: rawScore,
    weightedScore,
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
  await inspectCandidateTree(candidate)
  const rulePack = createRequire(import.meta.url)(ruleConfig)
  evaluation = score(await analyze(candidate, ruleConfig), rulePack.ccb ?? {})
} catch {
  evaluation = { status: 'evaluator_error' }
}

await writeFile(result, `${JSON.stringify(evaluation)}\n`)

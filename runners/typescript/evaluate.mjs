import { spawn } from 'node:child_process'
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
  return new Promise((resolveEvaluation) => {
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
    child.on('error', () => resolveEvaluation({ status: 'evaluator_error' }))
    child.on('close', (code, signal) => {
      if (signal || code === null || outputTooLarge) return resolveEvaluation({ status: 'evaluator_error' })
      try {
        const violations = JSON.parse(output).summary.error
        if (!Number.isInteger(violations) || violations < 0) return resolveEvaluation({ status: 'evaluator_error' })
        return resolveEvaluation(violations === 0 ? { status: 'passing', violations } : { status: 'failing', violations })
      } catch {
        return resolveEvaluation({ status: 'evaluator_error' })
      }
    })
  })
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
  evaluation = await analyze(candidate, ruleConfig)
} catch {
  evaluation = { status: 'evaluator_error' }
}

await writeFile(result, `${JSON.stringify(evaluation)}\n`)

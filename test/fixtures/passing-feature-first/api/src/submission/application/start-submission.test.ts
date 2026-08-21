import assert from 'node:assert/strict'
import test from 'node:test'
import { StartSubmission } from './start-submission'

test('saves the submission through its port', async () => {
  let saved = ''
  const useCase = new StartSubmission({ save: async (id) => { saved = id } })

  await useCase.execute('submission-1')

  assert.equal(saved, 'submission-1')
})

test('waits for persistence', async () => {
  let completed = false
  const useCase = new StartSubmission({ save: async () => { completed = true } })

  await useCase.execute('submission-2')

  assert.equal(completed, true)
})

test('propagates persistence failures', async () => {
  const failure = new Error('persistence failed')
  const useCase = new StartSubmission({ save: async () => { throw failure } })

  await assert.rejects(useCase.execute('submission-3'), failure)
})

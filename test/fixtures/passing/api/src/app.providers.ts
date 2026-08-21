import { StartSubmission } from './application/start-submission'
import { TypeOrmSubmissionRepository } from './infrastructure/typeorm-submission-repository'
import { submissionResolvers } from './resolver/submission'

export const providers = [
  StartSubmission,
  TypeOrmSubmissionRepository,
  ...submissionResolvers,
]

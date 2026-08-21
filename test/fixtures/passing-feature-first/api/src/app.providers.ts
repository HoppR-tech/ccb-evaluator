import { StartSubmission } from './submission/application/start-submission'
import { TypeOrmSubmissionRepository } from './submission/infrastructure/typeorm-submission-repository'
import { submissionResolvers } from './resolver/submission'

export const providers = [
  StartSubmission,
  TypeOrmSubmissionRepository,
  ...submissionResolvers,
]

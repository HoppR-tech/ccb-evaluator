import { StartSubmission } from './application/start-submission'
import { TypeOrmSubmissionRepository } from './infrastructure/typeorm-submission-repository'
import { submissionResolvers } from './resolver/submission'
import { SubmissionStartService } from './service/submission/submission.start.service'

export const providers = [
  StartSubmission,
  TypeOrmSubmissionRepository,
  SubmissionStartService,
  ...submissionResolvers,
]

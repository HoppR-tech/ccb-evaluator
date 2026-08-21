import type { SubmissionRepository } from '../domain/submission-repository'

export class StartSubmission {
  constructor(private readonly submissions: SubmissionRepository) {}

  execute(id: string): Promise<void> {
    return this.submissions.save(id)
  }
}

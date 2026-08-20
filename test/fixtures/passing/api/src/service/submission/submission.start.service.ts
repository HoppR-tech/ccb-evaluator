import { StartSubmission } from '../../application/start-submission'

export class SubmissionStartService {
  constructor(private readonly startSubmission: StartSubmission) {}

  start(id: string): Promise<void> {
    return this.startSubmission.execute(id)
  }
}

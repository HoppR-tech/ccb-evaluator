import type { SubmissionRepository } from '../domain/submission-repository'

export class TypeOrmSubmissionRepository implements SubmissionRepository {
  async save(_id: string): Promise<void> {}
}

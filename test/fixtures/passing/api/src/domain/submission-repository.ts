export interface SubmissionRepository {
  save(id: string): Promise<void>
}

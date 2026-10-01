import type { NoiseCleanupJob } from './backend'

// The one piece of Noise Cleanup the Studio provider needs at startup. The
// view derivation in noise-cleanup-view.ts is only read by the Library, so it
// stays out of the startup bundle by living apart from this.
export function upsertNoiseCleanupJob(
  jobs: readonly NoiseCleanupJob[],
  next: NoiseCleanupJob
): NoiseCleanupJob[] {
  const index = jobs.findIndex((job) => job.id === next.id)
  if (index < 0) {
    return [...jobs, next]
  }
  if (jobs[index]?.updatedAt.localeCompare(next.updatedAt) > 0) {
    return [...jobs]
  }
  return jobs.map((job, jobIndex) => (jobIndex === index ? next : job))
}

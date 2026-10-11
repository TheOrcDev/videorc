import type { CleanCutJob } from './backend'

// The one piece of Clean cut the Studio provider needs at startup (plan 174
// S3.11, E-4): the main window keeps every job its own connection hears on
// `cleanCut.status`, so the Library can say "Cutting 40%" and hold the file
// actions the backend would refuse. The view derivation in clean-cut-view.ts
// is only read by the Buddy tab and the Library, so it stays out of the
// startup bundle by living apart from this.

/** One entry per job id; a snapshot older than the one held is ignored. */
export function upsertCleanCutJob(jobs: readonly CleanCutJob[], job: CleanCutJob): CleanCutJob[] {
  const index = jobs.findIndex((entry) => entry.id === job.id)
  if (index === -1) return [job, ...jobs]
  if (jobs[index].updatedAt.localeCompare(job.updatedAt) > 0) return [...jobs]
  const next = [...jobs]
  next[index] = job
  return next
}

import { db } from '../db/client';
import { jobs } from '../db/schema';

export const JOB_DELETE_S3_OBJECT = 'delete_s3_object';
export const JOB_CLEANUP_UPLOADS = 'cleanup_orphan_uploads';

export async function enqueueJob(
  type: string,
  payload: Record<string, unknown>,
  opts: { runAt?: Date; maxAttempts?: number } = {},
): Promise<void> {
  await db.insert(jobs).values({
    type,
    payload,
    nextRunAt: opts.runAt ?? new Date(),
    maxAttempts: opts.maxAttempts ?? 5,
  });
}

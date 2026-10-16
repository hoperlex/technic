export type RequestCreateReconciliation =
  { state: 'created'; requestId: string } | { state: 'not-created'; nextOperationId: string };

export const PENDING_CREATE_FILE_MESSAGE =
  'Файл указан в прежней отправке. Сначала сверьте её исход.';

/** A retry still refers to these IDs even when the visible form changes. */
export function isFileInPendingCreate(
  attempt: { body: unknown } | undefined,
  fileId: string,
): boolean {
  const body = attempt?.body;
  if (!body || typeof body !== 'object') return false;
  const fileIds = (body as { fileIds?: unknown }).fileIds;
  return Array.isArray(fileIds) && fileIds.includes(fileId);
}

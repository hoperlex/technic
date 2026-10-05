import { isApiError } from '@shared/api';

/** A server answer with this status: 409 for a version conflict, 404 for a vanished request. */
export function hasApiStatus(error: unknown, status: number): boolean {
  return isApiError(error) && error.status === status;
}

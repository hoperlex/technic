import { isApiError } from '@shared/api';

/** Match an API status without treating transport and parsing failures as domain responses. */
export function hasApiStatus(error: unknown, status: number): boolean {
  return isApiError(error) && error.status === status;
}

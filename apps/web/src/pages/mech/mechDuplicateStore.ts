import { LocalCreateAttemptError, type LocalFormDraft } from '@shared/lib';

export const FORM = 'mech-duplicate';
export const COMPLETED_PREFIX = 'technic:mech-duplicate-completed:v1:';
export type Source = { id: string; displayNumber: string };
export type DuplicateDraft = LocalFormDraft<Source>;
export type Completion = { requestId: string; key: string };

function completionKey(userId: string, sourceId: string): string {
  return `${COMPLETED_PREFIX}${userId}:${sourceId}`;
}

export function readCompletion(
  userId: string,
  sourceId: string,
): { available: boolean; value: Completion | null } {
  try {
    const raw = localStorage.getItem(completionKey(userId, sourceId));
    if (!raw) return { available: true, value: null };
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return { available: false, value: null };
    const row = value as Partial<Completion>;
    if (typeof row.requestId !== 'string' || typeof row.key !== 'string')
      return { available: false, value: null };
    return { available: true, value: { requestId: row.requestId, key: row.key } };
  } catch {
    return { available: false, value: null };
  }
}

export function writeCompletion(userId: string, sourceId: string, value: Completion): boolean {
  try {
    localStorage.setItem(completionKey(userId, sourceId), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeCompletion(userId: string, sourceId: string): boolean {
  try {
    localStorage.removeItem(completionKey(userId, sourceId));
    return true;
  } catch {
    return false;
  }
}

export function parseSource(value: unknown): Source | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Partial<Source>;
  return typeof source.id === 'string' && typeof source.displayNumber === 'string'
    ? { id: source.id, displayNumber: source.displayNumber }
    : null;
}

export async function withSourceLock<T>(
  userId: string,
  sourceId: string,
  work: () => Promise<T>,
): Promise<T> {
  // localStorage has no compare-and-swap. Without this lock concurrent first clicks could get
  // distinct receipt keys and create two copies of one intended unit.
  const locks = navigator.locks;
  if (!locks) {
    throw new LocalCreateAttemptError(
      'Браузер не поддерживает безопасное дублирование в нескольких вкладках. Обновите браузер.',
    );
  }
  return locks.request(`technic:mech-duplicate:${userId}:${sourceId}`, work);
}

const PREFIX = 'technic:form-draft:v1:';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface LocalFormDraft<Payload> {
  schema: 1;
  id: string;
  userId: string;
  form: string;
  target: string;
  savedAt: number;
  payload: Payload;
  createAttempt?: { key: string; body: unknown; protocol?: 'receipt-v1' };
  nextCreateKey?: string;
  previousCreateKeys?: string[];
}

export function newLocalFormDraftId(): string {
  return crypto.randomUUID();
}

function parseEnvelope(raw: string | null): LocalFormDraft<unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const draft = value as Partial<LocalFormDraft<unknown>>;
    if (
      draft.schema !== 1 ||
      typeof draft.id !== 'string' ||
      typeof draft.userId !== 'string' ||
      typeof draft.form !== 'string' ||
      typeof draft.target !== 'string' ||
      typeof draft.savedAt !== 'number' ||
      !Number.isFinite(draft.savedAt) ||
      !('payload' in draft)
    )
      return null;
    if (
      draft.createAttempt !== undefined &&
      (!draft.createAttempt ||
        typeof draft.createAttempt.key !== 'string' ||
        (draft.createAttempt.protocol !== undefined &&
          draft.createAttempt.protocol !== 'receipt-v1') ||
        !draft.createAttempt.body ||
        typeof draft.createAttempt.body !== 'object')
    )
      return null;
    if (draft.nextCreateKey !== undefined && typeof draft.nextCreateKey !== 'string') return null;
    if (
      draft.previousCreateKeys !== undefined &&
      (!Array.isArray(draft.previousCreateKeys) ||
        !draft.previousCreateKeys.every((key) => typeof key === 'string'))
    )
      return null;
    return draft as LocalFormDraft<unknown>;
  } catch {
    return null;
  }
}

/** The key belongs to one opening. A second tab never writes through another opening's key. */
export function writeLocalFormDraft<Payload>(draft: LocalFormDraft<Payload>): boolean {
  try {
    localStorage.setItem(`${PREFIX}${draft.id}`, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function removeLocalFormDraft(id: string): boolean {
  try {
    localStorage.removeItem(`${PREFIX}${id}`);
    return true;
  } catch {
    return false;
  }
}

export function listLocalFormDrafts<Payload>(
  userId: string,
  form: string,
  target: string | undefined,
  parsePayload: (value: unknown) => Payload | null,
): { drafts: LocalFormDraft<Payload>[]; available: boolean } {
  try {
    const drafts: LocalFormDraft<Payload>[] = [];
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(PREFIX)) continue;
      const envelope = parseEnvelope(localStorage.getItem(key));
      if (
        !envelope ||
        envelope.userId !== userId ||
        envelope.form !== form ||
        (target !== undefined && envelope.target !== target)
      )
        continue;
      // An uncertain write must remain recoverable even after ordinary unsent drafts age out.
      if (Date.now() - envelope.savedAt > MAX_AGE_MS && !envelope.createAttempt) continue;
      const payload = parsePayload(envelope.payload);
      if (payload === null) continue;
      drafts.push({ ...envelope, payload });
    }
    drafts.sort((a, b) => b.savedAt - a.savedAt);
    return { drafts, available: true };
  } catch {
    return { drafts: [], available: false };
  }
}

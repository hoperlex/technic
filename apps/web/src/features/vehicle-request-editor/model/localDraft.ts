import dayjs from 'dayjs';
import type { CreateVehicleRequestInput, VehicleRequestType } from '@technic/contracts';
import {
  listLocalFormDrafts,
  newLocalFormDraftId,
  removeLocalFormDraft,
  writeLocalFormDraft,
} from '@shared/lib';
import type { FormValues } from './requestFormValues';

const FORM = 'vehicle-request';

export type DraftTarget = { kind: 'create' } | { kind: 'copy' | 'edit'; sourceId: string };

export type VehicleCreateProtocol = 'receipt-v1' | 'correction-v1';
export interface VehicleCreateAttempt {
  key: string;
  body: CreateVehicleRequestInput;
  /** Missing on drafts written before the versioned receipt route existed. */
  protocol?: VehicleCreateProtocol;
}

export function isBackdatedCreateAttempt(attempt: VehicleCreateAttempt | undefined): boolean {
  if (!attempt || attempt.protocol === 'receipt-v1') return false;
  return (
    attempt.protocol === 'correction-v1' ||
    !!attempt.body.operationId ||
    !!attempt.body.backdateReason
  );
}

export function isLegacyOrdinaryCreateAttempt(
  attempt: VehicleCreateAttempt | undefined,
): attempt is VehicleCreateAttempt & { protocol?: undefined } {
  return !!attempt && !attempt.protocol && !isBackdatedCreateAttempt(attempt);
}

type StoredValues = Omit<
  FormValues,
  'requestType' | 'classificationKey' | 'dateFrom' | 'dateTo' | 'scheduledDate'
> & {
  requestType?: VehicleRequestType;
  classificationKey?: string;
  dateFrom?: string | null;
  dateTo?: string | null;
  scheduledDate?: string | null;
};

export interface VehicleRequestLocalDraft {
  schema: 1;
  id: string;
  userId: string;
  target: DraftTarget;
  baseVersion: number | null;
  operationId: string;
  savedAt: number;
  values: StoredValues;
  createAttempt?: VehicleCreateAttempt;
  nextCreateKey?: string;
  previousCreateKeys?: string[];
}

function storedDate(value: FormValues['dateFrom']): string | null | undefined {
  return value ? value.format('YYYY-MM-DD') : value;
}

function restoredDate(value: string | null | undefined) {
  if (value == null) return value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = dayjs(value);
  return parsed.isValid() && parsed.format('YYYY-MM-DD') === value ? parsed : undefined;
}

export function draftValues(values: FormValues): StoredValues {
  return {
    ...values,
    dateFrom: storedDate(values.dateFrom),
    dateTo: storedDate(values.dateTo),
    scheduledDate: storedDate(values.scheduledDate),
  };
}

export function restoreDraftValues(values: StoredValues): FormValues {
  // `FormValues` describes a submitted form; a draft may precede its required type and classifier.
  // Ant Design owns the incomplete intermediate shape, while validation remains at submit time.
  return {
    ...values,
    dateFrom: restoredDate(values.dateFrom),
    dateTo: restoredDate(values.dateTo),
    scheduledDate: restoredDate(values.scheduledDate),
  } as FormValues;
}

interface Payload {
  target: DraftTarget;
  baseVersion: number | null;
  operationId: string;
  values: StoredValues;
  createAttempt?: VehicleCreateAttempt;
  nextCreateKey?: string;
  previousCreateKeys?: string[];
}

function parsePayload(value: unknown): Payload | null {
  if (!value || typeof value !== 'object') return null;
  const draft = value as Partial<Payload>;
  if (
    !draft.target ||
    !['create', 'copy', 'edit'].includes(draft.target.kind) ||
    (draft.target.kind !== 'create' && typeof draft.target.sourceId !== 'string') ||
    typeof draft.operationId !== 'string' ||
    (draft.baseVersion !== null && !Number.isInteger(draft.baseVersion)) ||
    !draft.values ||
    (draft.values.requestType !== undefined &&
      !['special_equipment', 'freight_transport'].includes(draft.values.requestType)) ||
    (draft.values.classificationKey !== undefined &&
      typeof draft.values.classificationKey !== 'string') ||
    (draft.values.customerKey !== undefined && typeof draft.values.customerKey !== 'string') ||
    (draft.values.trips !== undefined && !Array.isArray(draft.values.trips)) ||
    (draft.values.trips ?? []).some((trip) => !trip || typeof trip.key !== 'string') ||
    (draft.createAttempt !== undefined &&
      (!draft.createAttempt ||
        typeof draft.createAttempt.key !== 'string' ||
        !draft.createAttempt.body ||
        typeof draft.createAttempt.body !== 'object' ||
        (draft.createAttempt.protocol !== undefined &&
          !['receipt-v1', 'correction-v1'].includes(draft.createAttempt.protocol)))) ||
    (draft.nextCreateKey !== undefined && typeof draft.nextCreateKey !== 'string') ||
    (draft.previousCreateKeys !== undefined &&
      (!Array.isArray(draft.previousCreateKeys) ||
        draft.previousCreateKeys.some((key) => typeof key !== 'string')))
  )
    return null;
  return draft as Payload;
}

function targetKey(target: DraftTarget): string {
  return target.kind === 'create' ? 'create' : `${target.kind}:${target.sourceId}`;
}

export function newDraftId(): string {
  return newLocalFormDraftId();
}

export function listLocalDrafts(
  userId: string,
  target: DraftTarget,
): {
  drafts: VehicleRequestLocalDraft[];
  available: boolean;
} {
  const found = listLocalFormDrafts(userId, FORM, targetKey(target), parsePayload);
  return {
    available: found.available,
    drafts: found.drafts.map(({ payload, ...envelope }) => ({
      schema: 1,
      id: envelope.id,
      userId: envelope.userId,
      savedAt: envelope.savedAt,
      ...payload,
    })),
  };
}

export function writeLocalDraft(draft: VehicleRequestLocalDraft): boolean {
  return writeLocalFormDraft({
    schema: 1,
    id: draft.id,
    userId: draft.userId,
    form: FORM,
    target: targetKey(draft.target),
    savedAt: draft.savedAt,
    payload: {
      target: draft.target,
      baseVersion: draft.baseVersion,
      operationId: draft.operationId,
      values: draft.values,
      createAttempt: draft.createAttempt,
      nextCreateKey: draft.nextCreateKey,
      previousCreateKeys: draft.previousCreateKeys,
    },
  });
}

export function removeLocalDraft(id: string): boolean {
  return removeLocalFormDraft(id);
}

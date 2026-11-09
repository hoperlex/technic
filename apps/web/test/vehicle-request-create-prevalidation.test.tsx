import { act, renderHook } from '@testing-library/react';
import { Form } from 'antd';
import dayjs from 'dayjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createVehicleRequestStableSchema,
  type CreateVehicleRequestInput,
  type VehicleRequestDto,
} from '@technic/contracts';
import { errorFields, LocalCreateAttemptError, LocalValidationError } from '@shared/lib';
import { vehicleRequestErrorMessage } from '@entities/vehicle-request';
import { listLocalDrafts, type FormValues } from '@features/vehicle-request-editor';
import { saveVehicleRequest } from '../src/widgets/vehicle-request-editor/model/saveVehicleRequest';
import { useVehicleRequestLocalDraft } from '../src/widgets/vehicle-request-editor/model/useVehicleRequestLocalDraft';
import type { VehicleRequestEditorState } from '../src/widgets/vehicle-request-editor/model/useVehicleRequestEditorState';
import { freightRequestBody, freightTripBody } from './factories/vehicleRequestCreateBody';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const originalKey = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const replacementKey = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const operationId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const departmentId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const fileId = '11111111-1111-4111-8111-111111111111';

function useTab() {
  const [form] = Form.useForm<FormValues>();
  const draft = useVehicleRequestLocalDraft(form, userId);
  return { form, draft };
}

function openTab() {
  const tab = renderHook(useTab);
  act(() => tab.result.current.draft.begin({ kind: 'create' }, null, originalKey));
  return tab;
}

const zeroVolume = () => freightRequestBody({ trips: [freightTripBody({ volumeM3: 0 })] });

function storedEnvelopes() {
  return listLocalDrafts(userId, { kind: 'create' }).drafts;
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('Vehicle Request create pre-validation', () => {
  it('refuses a body the route schema would refuse, before anything is stored or sent', () => {
    const tab = openTab();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    let thrown: unknown;
    act(() => {
      try {
        tab.result.current.draft.prepareCreate(zeroVolume());
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeInstanceOf(LocalValidationError);
    // A local refusal must not read as "the first request may still commit" (the save path tests it).
    expect(thrown).toBeInstanceOf(LocalCreateAttemptError);
    expect(setItem).not.toHaveBeenCalled();
    expect(tab.result.current.draft.active?.createAttempt).toBeUndefined();
    expect(storedEnvelopes()).toHaveLength(0);
    // The toast names the field and the reason, with the row number.
    expect(errorFields(thrown)).toHaveProperty(['trips.0.volumeM3']);
    expect(vehicleRequestErrorMessage(thrown)).toBe(
      'Проверьте поля формы: Объём (строка 1) — Значение должно быть больше 0',
    );
  });

  it('keeps the key for the corrected form after a refusal', () => {
    const tab = openTab();
    const valid = freightRequestBody();
    expect(() => tab.result.current.draft.prepareCreate(zeroVolume())).toThrow(
      LocalValidationError,
    );
    let sent!: ReturnType<typeof tab.result.current.draft.prepareCreate>;
    act(() => {
      sent = tab.result.current.draft.prepareCreate(valid);
    });
    expect(sent.protocol).toBe('receipt-v1');
    expect(sent.key).toBe(tab.result.current.draft.active?.createAttempt?.key);
    expect(storedEnvelopes()[0]?.createAttempt?.body).toEqual(valid);
  });

  it('does not check a frozen body: the safe retry of a valid first body still goes out', () => {
    const tab = openTab();
    const valid = freightRequestBody();
    let first!: ReturnType<typeof tab.result.current.draft.prepareCreate>;
    act(() => {
      first = tab.result.current.draft.prepareCreate(valid);
    });

    // The form was edited into something the schema refuses; the retry still resends the first body.
    let retry!: typeof first;
    act(() => {
      retry = tab.result.current.draft.prepareCreate(zeroVolume());
    });
    expect(retry).toEqual(first);
    expect(storedEnvelopes()[0]?.createAttempt?.body).toEqual(valid);
  });

  it('does not check a frozen body even when that body itself no longer validates', () => {
    // A body frozen by an older build, or one that the server refused: the retry resends it
    // untouched, because that body may be the first POST that is still in flight.
    const tab = openTab();
    const spoiled = zeroVolume();
    const frozenElsewhere = {
      id: tab.result.current.draft.active!.id,
      userId,
      target: { kind: 'create' as const },
      baseVersion: null,
      operationId: originalKey,
      schema: 1 as const,
      savedAt: Date.now(),
      values: {} as never,
      createAttempt: { key: originalKey, body: spoiled, protocol: 'receipt-v1' as const },
    };
    act(() => {
      tab.result.current.draft.restore(frozenElsewhere, null);
    });
    let sent!: ReturnType<typeof tab.result.current.draft.prepareCreate>;
    act(() => {
      sent = tab.result.current.draft.prepareCreate(freightRequestBody());
    });
    expect(sent).toEqual({ key: originalKey, body: spoiled, protocol: 'receipt-v1' });
  });

  it('refuses a new backdated body and does not freeze it', () => {
    const tab = openTab();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    expect(() =>
      tab.result.current.draft.prepareCreate({
        ...zeroVolume(),
        operationId,
        backdateReason: 'Забыли завести',
      }),
    ).toThrow(LocalValidationError);
    expect(setItem).not.toHaveBeenCalled();
    expect(tab.result.current.draft.active?.createAttempt).toBeUndefined();

    let sent!: ReturnType<typeof tab.result.current.draft.prepareCreate>;
    act(() => {
      sent = tab.result.current.draft.prepareCreate({
        ...freightRequestBody(),
        operationId,
        backdateReason: 'Забыли завести',
      });
    });
    expect(sent.protocol).toBe('correction-v1');
  });

  it('validates the first attempt after a reconciliation released the previous one', () => {
    const tab = openTab();
    let sent!: ReturnType<typeof tab.result.current.draft.prepareCreate>;
    act(() => {
      sent = tab.result.current.draft.prepareCreate(freightRequestBody());
    });
    act(() => {
      expect(tab.result.current.draft.acceptNotCreated(sent.key, replacementKey)).toBe('resolved');
    });
    expect(tab.result.current.draft.active?.nextCreateKey).toBe(replacementKey);

    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    expect(() => tab.result.current.draft.prepareCreate(zeroVolume())).toThrow(
      LocalValidationError,
    );
    expect(setItem).not.toHaveBeenCalled();
    // The replacement key is not spent by a refusal.
    expect(tab.result.current.draft.active?.nextCreateKey).toBe(replacementKey);
    expect(tab.result.current.draft.active?.createAttempt).toBeUndefined();

    let next!: typeof sent;
    act(() => {
      next = tab.result.current.draft.prepareCreate(freightRequestBody({ comment: 'fixed' }));
    });
    expect(next.key).toBe(replacementKey);
    expect(next.body.comment).toBe('fixed');
  });
});

describe('Vehicle Request create pre-validation: real bodies', () => {
  const customerKeys = {
    object: { objectId: userId, departmentId: null },
    department: { objectId: null, departmentId },
  };

  function stateFor(options: {
    customer?: keyof typeof customerKeys;
    backdated?: boolean;
    newFileIds?: string[];
  }) {
    return {
      record: null,
      operationId,
      backdated: !!options.backdated,
      customer: { customerPairOf: () => customerKeys[options.customer ?? 'object'] },
      editor: { newFileIds: () => options.newFileIds ?? [], removedIds: [] },
    } as unknown as VehicleRequestEditorState;
  }

  const address = { source: 'object', refId: departmentId } as const;
  const row = (over: Record<string, unknown> = {}) => ({
    key: crypto.randomUUID(),
    fromLocation: 'Карьер',
    toLocation: 'Площадка',
    fromAddress: address,
    toAddress: { source: 'resolved', fiasId: 'fias-1' } as const,
    cargoName: 'Песок',
    fromResponsibleName: 'Иванов Иван',
    fromResponsiblePhone: '+7 (999) 000-00-00',
    toResponsibleName: 'Петров Пётр',
    toResponsiblePhone: '8 999 000 00 01',
    volumeM3: 12.5,
    weightTons: null,
    ...over,
  });
  const freight = (over: Record<string, unknown> = {}) =>
    ({
      requestType: 'freight_transport',
      classificationKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:',
      customerKey: `object:${userId}`,
      scheduledDate: dayjs('2026-10-20'),
      scheduledTime: '9:30',
      trips: [row()],
      comment: ' отправить ',
      ...over,
    }) as FormValues;

  const cases: [string, FormValues, Parameters<typeof stateFor>[0]][] = [
    [
      'special equipment, object customer',
      {
        requestType: 'special_equipment',
        classificationKey:
          'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        dateFrom: dayjs('2026-10-20'),
        dateTo: dayjs('2026-10-22'),
        responsibleName: 'Иванов Иван',
        responsiblePhone: '+79990000000',
        comment: '',
      } as FormValues,
      {},
    ],
    [
      'special equipment with open end and file IDs',
      {
        requestType: 'special_equipment',
        classificationKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:',
        dateFrom: dayjs('2026-10-20'),
        dateTo: null,
        responsibleName: 'Иванов Иван',
        responsiblePhone: '+79990000000',
      } as FormValues,
      { newFileIds: [fileId] },
    ],
    ['freight, object customer, one trip', freight(), {}],
    [
      'freight, department customer',
      freight({ customerKey: `department:${departmentId}` }),
      { customer: 'department' },
    ],
    ['freight, time unspecified', freight({ scheduledTime: '' }), {}],
    ['freight, trip time override', freight({ trips: [row({ scheduledTime: '14:15' })] }), {}],
    [
      'freight, null amounts (the server decides if a quantity is required)',
      freight({ trips: [row({ volumeM3: null, weightTons: null })] }),
      {},
    ],
    [
      'freight, weight only',
      freight({ trips: [row({ volumeM3: undefined, weightTons: 0.125 })] }),
      {},
    ],
    [
      'freight, several trips and file IDs',
      freight({ trips: [row(), row({ comment: 'позвонить' }), row()] }),
      { newFileIds: [fileId] },
    ],
    [
      'freight, backdated with a reason',
      freight({ scheduledDate: dayjs('2026-10-01'), backdateReason: ' Забыли завести ' }),
      { backdated: true },
    ],
    [
      'special equipment, backdated with a reason',
      {
        requestType: 'special_equipment',
        classificationKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:',
        dateFrom: dayjs('2026-10-01'),
        responsibleName: 'Иванов Иван',
        responsiblePhone: '+79990000000',
        backdateReason: 'Забыли завести',
      } as FormValues,
      { backdated: true },
    ],
  ];

  it.each(cases)('does not refuse %s', (_name, values, options) => {
    let built: CreateVehicleRequestInput | undefined;
    void saveVehicleRequest({ values }, stateFor(options), (body) => {
      built = body;
      return Promise.resolve({} as VehicleRequestDto);
    });
    expect(built).toBeDefined();
    // The schema itself, so a failure prints the refused path…
    const verdict = createVehicleRequestStableSchema.safeParse(JSON.parse(JSON.stringify(built)));
    expect(verdict.error?.issues).toBeUndefined();
    expect(verdict.success).toBe(true);

    // …and the gate the editor goes through.
    const tab = openTab();
    let sent!: ReturnType<typeof tab.result.current.draft.prepareCreate>;
    act(() => {
      sent = tab.result.current.draft.prepareCreate(built!);
    });
    expect(sent.protocol).toBe(options.backdated ? 'correction-v1' : 'receipt-v1');
  });
});

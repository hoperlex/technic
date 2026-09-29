import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import {
  moscowDateKeyOf,
  shiftDateKey,
  WAYBILL_ACK_REQUIRED_CODE,
  type AssignmentPreviewDto,
  type WaybillWarning,
} from '@technic/contracts';
import { selectOption } from './antd';
import { json, mockHttp, type RouteMap } from './http';
import { renderWithUser } from './render';
import { list } from './factories/common';
import {
  assignmentHistory,
  assignmentPreview,
  machinist,
  repairPreview,
  vehicleRequest,
} from './factories/vehicle';
import { VehiclePeriodModal } from '../src/pages/vehicle/VehiclePeriodModal';
import { VehicleRepairModal } from '../src/pages/vehicle/VehicleRepairModal';

/**
 * Warnings per issued sheet at the history doors — repair and period (B4, defect N1 of the repair
 * wave).
 *
 * In `history` read mode these doors issue ESM-2 blanks from their own plan and refuse a warned
 * sheet without a signature: 409 `waybill_ack_required`. The portal used to send no signature at
 * all, so a plan with a single warned sheet was a dead end in both windows — a toast and nothing
 * else to press. What is checked here:
 *
 * - **every warned sheet is shown by composition with its warnings**, and the command does not
 *   leave without an explicit tick;
 * - **the signature goes per sheet and only for warned ones**: the server rejects a signature for a
 *   clean sheet as superfluous;
 * - **409 `waybill_ack_required` is a question, not an error**: the window recomputes the preview
 *   and shows the new list with the reason above it; the old tick does not carry over.
 */

const TODAY = moscowDateKeyOf(new Date());
const day = (n: number) => shiftDateKey(TODAY, n);
const fmt = (key: string) => {
  const [y, m, d] = key.split('-');
  return `${d}.${m}.${y}`;
};

const SNILS: WaybillWarning = {
  facts: { code: 'driver_documents', personId: 'p-1', gaps: ['snils'] },
  message: 'У машиниста Иванов И. И. нет СНИЛС — графа останется пустой',
  entities: ['Иванов И. И.'],
};
const LICENSE: WaybillWarning = {
  facts: { code: 'driver_documents', personId: 'p-1', gaps: ['license'] },
  message: 'У машиниста Иванов И. И. нет удостоверения тракториста-машиниста',
  entities: ['Иванов И. И.'],
};

/** Two sheets: the first carries a warning, the second is clean and must not be signed. */
function warnedPreview(warning: WaybillWarning, fingerprint: string) {
  return {
    plan: {
      cancel: [],
      issue: [
        {
          issueKey: 0,
          from: day(8),
          to: day(14),
          vehicleId: 'v-1',
          vehicleName: 'КамАЗ Е646СК799',
          driverPersonId: 'p-1',
          driverName: 'Иванов И. И.',
        },
        {
          issueKey: 1,
          from: day(15),
          to: day(21),
          vehicleId: 'v-1',
          vehicleName: 'КамАЗ Е646СК799',
          driverPersonId: 'p-2',
          driverName: 'Петров П. П.',
        },
      ],
    },
    issues: [
      { issueKey: 0, warnings: [warning], warningFingerprint: fingerprint },
      { issueKey: 1, warnings: [], warningFingerprint: 'fp-clean' },
    ],
  } satisfies Partial<AssignmentPreviewDto>;
}

const FIRST = warnedPreview(SNILS, 'fp-warn-1');
const SECOND = warnedPreview(LICENSE, 'fp-warn-2');

/** The refusal of a history door: the fresh per-sheet list travels in `details.issues`. */
const ACK_REFUSAL = 'Выписка требует подтверждения: предупреждения по 1 листу(ам) ЭСМ-2 изменились';
const ackRequired = () =>
  json(
    {
      code: WAYBILL_ACK_REQUIRED_CODE,
      message: ACK_REFUSAL,
      details: { issues: SECOND.issues },
    },
    409,
  );

const REQUEST = vehicleRequest({
  id: 'vr-1',
  status: 'confirmed',
  dateFrom: day(-10),
  dateTo: day(7),
  version: 5,
  assignment: { vehicleId: 'v-1', ownership: 'own', typeName: 'Автокраны' },
} as never);

const TICK = /Согласен: листы выпишутся с перечисленными предупреждениями/;
const tick = () => fireEvent.click(screen.getByRole('checkbox', { name: TICK }));
const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

/** The window's own text, not the whole document: toasts live outside the dialog. */
const modalText = () => document.querySelector('.ant-modal')?.textContent ?? '';

describe('срок работ: предупреждения по выписываемым листам', () => {
  function renderPeriod(routes: RouteMap) {
    const http = mockHttp({
      'PATCH /vehicle-requests/:id/period': () =>
        json({
          version: 6,
          repeated: false,
          dateFrom: REQUEST.dateFrom,
          dateTo: day(21),
          esm2: { cancelled: [], issued: [] },
          earlyEndDropped: false,
          operationId: null,
          history: { state: 'ready', validatedOn: TODAY, dirty: false, changes: [] },
        }),
      ...routes,
    });
    renderWithUser(
      <VehiclePeriodModal
        request={REQUEST}
        command={{ dateTo: day(21) }}
        operationId="00000000-0000-4000-8000-000000000001"
        onCancel={() => {}}
        onApplied={() => {}}
      />,
    );
    return http;
  }
  const periodPreview = (part: ReturnType<typeof warnedPreview>, fingerprint: string) =>
    json({
      ...assignmentPreview({ ...part, fingerprint }),
      cancelGroups: [],
      cancelGroupsFingerprint: null,
    });

  it('называет лист по составу и без галочки не уходит; подпись — только по листу с предупреждением', async () => {
    const http = renderPeriod({
      'POST /vehicle-requests/:id/period/preview': () => periodPreview(FIRST, 'fp-preview'),
    });

    await screen.findByText('Листы выпишутся с предупреждениями');
    // The blank is named by what the person recognises: dates, machine and driver.
    expect(modalText()).toContain(
      `Лист за ${fmt(day(8))} — ${fmt(day(14))}: КамАЗ Е646СК799, машинист Иванов И. И.`,
    );
    expect(modalText()).toContain(SNILS.message);
    // The clean sheet is not in the warning block at all: there is nothing to confirm on it.
    expect(modalText()).not.toContain('машинист Петров П. П.');

    press('Изменить срок');
    await screen.findByText('Подтвердите предупреждения по листам');
    expect(http.countOf('PATCH /vehicle-requests/:id/period')).toBe(0);

    tick();
    press('Изменить срок');
    await waitFor(() => expect(http.countOf('PATCH /vehicle-requests/:id/period')).toBe(1));
    const sent = http.lastCall('PATCH /vehicle-requests/:id/period')!.body as Record<
      string,
      unknown
    >;
    expect(sent.acknowledgements).toEqual({ '0': 'fp-warn-1' });
    expect(sent.previewFingerprint).toBe('fp-preview');
  });

  it('без предупреждений не спрашивает подтверждения и подписей не шлёт', async () => {
    const http = renderPeriod({
      'POST /vehicle-requests/:id/period/preview': () =>
        periodPreview(
          { ...FIRST, issues: FIRST.issues.map((i) => ({ ...i, warnings: [] })) },
          'fp-clean-plan',
        ),
    });

    await screen.findAllByText(/Выпишется лист/);
    expect(screen.queryByText('Листы выпишутся с предупреждениями')).toBeNull();

    press('Изменить срок');
    await waitFor(() => expect(http.countOf('PATCH /vehicle-requests/:id/period')).toBe(1));
    const sent = http.lastCall('PATCH /vehicle-requests/:id/period')!.body as Record<
      string,
      unknown
    >;
    // An empty signature map is still a signature the server would have to reject.
    expect(sent).not.toHaveProperty('acknowledgements');
  });

  it('409 «предупреждения изменились» пересчитывает последствия в окне, а не тостом', async () => {
    let previews = 0;
    let patches = 0;
    const http = renderPeriod({
      'POST /vehicle-requests/:id/period/preview': () => {
        previews += 1;
        return previews === 1
          ? periodPreview(FIRST, 'fp-preview')
          : periodPreview(SECOND, 'fp-preview');
      },
      'PATCH /vehicle-requests/:id/period': () => {
        patches += 1;
        if (patches === 1) return ackRequired();
        return json({
          version: 6,
          repeated: false,
          dateFrom: REQUEST.dateFrom,
          dateTo: day(21),
          esm2: { cancelled: [], issued: [] },
          earlyEndDropped: false,
          operationId: null,
          history: { state: 'ready', validatedOn: TODAY, dirty: false, changes: [] },
        });
      },
    });

    await screen.findByText(SNILS.message);
    tick();
    press('Изменить срок');

    // The window asks the preview again and shows the new list with the reason above it.
    await screen.findByText(LICENSE.message);
    expect(modalText()).toContain('Предупреждения по листам изменились');
    expect(modalText()).not.toContain(SNILS.message);
    expect(screen.queryByText(ACK_REFUSAL)).toBeNull();
    // The old tick confirmed the old list: it does not carry over to the new one.
    expect(screen.getByRole('checkbox', { name: TICK })).toHaveProperty('checked', false);

    tick();
    press('Изменить срок');
    await waitFor(() => expect(http.countOf('PATCH /vehicle-requests/:id/period')).toBe(2));
    const sent = http.lastCall('PATCH /vehicle-requests/:id/period')!.body as Record<
      string,
      unknown
    >;
    expect(sent.acknowledgements).toEqual({ '0': 'fp-warn-2' });
  });
});

describe('починка истории: предупреждения по выписываемым листам', () => {
  const GAP = { from: day(-60), to: day(-30) };
  const SEMENOV = machinist();

  function renderRepair(routes: RouteMap) {
    const http = mockHttp({
      'GET /drivers': () => json(list([SEMENOV])),
      'GET /vehicle-requests/:id/assignment-changes': () => json(assignmentHistory()),
      'GET /vehicle-requests/:id/assignment-changes/repair/state': () =>
        json(repairPreview({ state: 'materialized', fillableGaps: [GAP] })),
      'POST /vehicle-requests/:id/assignment-changes/repair': () =>
        json({
          ok: true,
          repeated: false,
          version: 6,
          state: 'ready',
          operationId: null,
          archived: false,
        }),
      ...routes,
    });
    renderWithUser(
      <VehicleRepairModal request={REQUEST} onCancel={() => {}} onRepaired={() => {}} />,
    );
    return http;
  }

  async function showConsequences() {
    await screen.findByText('Кто работал в неизвестные дни');
    await selectOption(`Кто работал ${fmt(GAP.from)} — ${fmt(GAP.to)}`, /Семёнов/);
    press('Показать последствия');
    await screen.findByRole('button', { name: 'Подтвердить' });
  }

  it('показывает предупреждения на втором шаге и шлёт подпись только после галочки', async () => {
    const http = renderRepair({
      'POST /vehicle-requests/:id/assignment-changes/repair/preview': () =>
        json(repairPreview({ state: 'materialized', ...FIRST })),
    });
    await showConsequences();

    await screen.findByText('Листы выпишутся с предупреждениями');
    expect(modalText()).toContain(SNILS.message);

    press('Подтвердить');
    await screen.findByText('Подтвердите предупреждения по листам');
    expect(http.countOf('POST /vehicle-requests/:id/assignment-changes/repair')).toBe(0);

    tick();
    press('Подтвердить');
    await waitFor(() =>
      expect(http.countOf('POST /vehicle-requests/:id/assignment-changes/repair')).toBe(1),
    );
    const body = http.lastCall('POST /vehicle-requests/:id/assignment-changes/repair')!
      .body as Record<string, unknown>;
    expect(body.acknowledgements).toEqual({ '0': 'fp-warn-1' });
    // The preview never carries signatures: it hands them out, it does not take them.
    const preview = http.lastCall('POST /vehicle-requests/:id/assignment-changes/repair/preview')!
      .body as Record<string, unknown>;
    expect(preview).not.toHaveProperty('acknowledgements');
  });

  it('409 «предупреждения изменились» — перезапрос предпросмотра и новая галочка', async () => {
    let previews = 0;
    let commands = 0;
    const http = renderRepair({
      'POST /vehicle-requests/:id/assignment-changes/repair/preview': () => {
        previews += 1;
        return json(repairPreview({ state: 'materialized', ...(previews === 1 ? FIRST : SECOND) }));
      },
      'POST /vehicle-requests/:id/assignment-changes/repair': () => {
        commands += 1;
        if (commands === 1) return ackRequired();
        return json({
          ok: true,
          repeated: false,
          version: 6,
          state: 'ready',
          operationId: null,
          archived: false,
        });
      },
    });
    await showConsequences();

    await screen.findByText(SNILS.message);
    tick();
    press('Подтвердить');

    await screen.findByText(LICENSE.message);
    expect(modalText()).toContain('Последствия пересчитаны');
    expect(modalText()).toContain('Предупреждения по листам изменились');
    expect(screen.queryByText(ACK_REFUSAL)).toBeNull();
    // The same draft went back to the preview: the person does not re-enter the fill.
    expect(
      (
        http.lastCall('POST /vehicle-requests/:id/assignment-changes/repair/preview')!.body as {
          knownFills: unknown;
        }
      ).knownFills,
    ).toEqual([{ from: GAP.from, to: GAP.to, personId: SEMENOV.id }]);

    press('Подтвердить');
    await screen.findByText('Подтвердите предупреждения по листам');
    expect(http.countOf('POST /vehicle-requests/:id/assignment-changes/repair')).toBe(1);

    tick();
    press('Подтвердить');
    await waitFor(() =>
      expect(http.countOf('POST /vehicle-requests/:id/assignment-changes/repair')).toBe(2),
    );
    const body = http.lastCall('POST /vehicle-requests/:id/assignment-changes/repair')!
      .body as Record<string, unknown>;
    expect(body.acknowledgements).toEqual({ '0': 'fp-warn-2' });
  });
});

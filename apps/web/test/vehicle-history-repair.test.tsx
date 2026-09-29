import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { moscowDateKeyOf, shiftDateKey } from '@technic/contracts';
import { selectOption } from './antd';
import { apiError, json, mockHttp, type RouteMap } from './http';
import { renderWithUser } from './render';
import { list } from './factories/common';
import {
  assignmentChange,
  assignmentHistory,
  machinist,
  repairPreview,
  vehicleRequest,
} from './factories/vehicle';
import { VehicleRepairModal } from '../src/pages/vehicle/VehicleRepairModal';

/**
 * Окно «Починка истории» (подэтап 6a плана `docs/assignment-periods-plan.md`, Р29, Р31, Ц4).
 *
 * Дверь ремонта работает с апреля, а в портале её не было вовсе: «Состав по датам» писал «решают
 * его ремонтом истории» и отсылал к операции, которой в интерфейсе не существует. Отсюда предмет
 * проверок:
 *
 * - **окно сперва спрашивает, что чинить**: какие `unknown`-промежутки заблокированы и адресуются
 *   заполнением, а какие правятся якорями, знает только сервер — это зависит от отменяемости
 *   бумаги, и портал такого не считает;
 * - **заполнение уезжает отрезком, а не перечнем дней** (Ц4), и только тем, который человек назвал:
 *   пустой раздел в тело не попадает вовсе — схема отвергает пустой список;
 * - **сначала последствия, потом запись**: за заполнением портал выпишет бланки задним числом, и
 *   номера человек читает до нажатия, а не узнаёт из журнала;
 * - **отмена заполнения — другая команда** (Ю2): «восстанавливаю» и «снимаю» — разные утверждения,
 *   и выяснять их по составу тела нельзя;
 * - **отказ по правам объяснён словами** (Р32): его показывают текстом в окне, а не тостом.
 *
 * Даты считаются от сегодняшнего дня: «заблокированное прошлое» — понятие относительно календаря.
 */

const TODAY = moscowDateKeyOf(new Date());
const day = (n: number) => shiftDateKey(TODAY, n);
const fmt = (key: string) => {
  const [y, m, d] = key.split('-');
  return `${d}.${m}.${y}`;
};

const SEMENOV = machinist();
const KUZNETSOV = machinist({
  id: 'p-kuznetsov',
  lastName: 'Кузнецов',
  firstName: 'Кузьма',
  middleName: 'Кузьмич',
  fullName: 'Кузнецов Кузьма Кузьмич',
  personnelNo: '4022',
});

const REQUEST = vehicleRequest({
  id: 'vr-1',
  status: 'confirmed',
  dateFrom: day(-60),
  dateTo: day(10),
  version: 3,
  assignment: {
    vehicleId: 'v-1',
    ownership: 'own',
    modelName: 'Ивановец КС-45717',
    registrationNumber: 'Е646СК799',
  },
} as never);

/** Промежуток неизвестных дней в закрытом прошлом — единственный адрес заполнения (Ц4). */
const GAP = { from: day(-60), to: day(-30) };

function renderModal(routes: RouteMap = {}) {
  const http = mockHttp({
    'GET /drivers': () => json(list([SEMENOV, KUZNETSOV])),
    'GET /vehicle-requests/:id/assignment-changes': () => json(assignmentHistory()),
    'GET /vehicle-requests/:id/assignment-changes/repair/state': () =>
      json(repairPreview({ state: 'materialized', fillableGaps: [GAP] })),
    'POST /vehicle-requests/:id/assignment-changes/repair/preview': () =>
      json(repairPreview({ state: 'materialized', stateAfter: 'ready' })),
    'POST /vehicle-requests/:id/assignment-changes/repair': () =>
      json({
        ok: true,
        repeated: false,
        version: 4,
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

const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

function bodyOf(http: ReturnType<typeof mockHttp>, route: string): Record<string, unknown> {
  return http.lastCall(route)!.body as Record<string, unknown>;
}

describe('окно починки истории', () => {
  it('осмотром спрашивает, что чинить, и печатает промежуток неизвестных дней', async () => {
    renderModal();

    await screen.findByText('Кто работал в неизвестные дни');
    await screen.findByText(`Кто работал ${fmt(GAP.from)} — ${fmt(GAP.to)}`);
    // Почему именно здесь заполнение, а не якорь: бумагу этих дней уже не отменить.
    await screen.findByText(/За эти дни листов нет вовсе/);
  });

  it('полной истории говорит словами, что чинить нечего', async () => {
    renderModal({
      'GET /vehicle-requests/:id/assignment-changes/repair/state': () => json(repairPreview()),
    });

    await screen.findByText('История заявки полна: чинить в ней нечего.');
  });

  it('заполнение уезжает отрезком с названным человеком — и только после просмотра последствий', async () => {
    const http = renderModal();
    await screen.findByText('Кто работал в неизвестные дни');

    await selectOption(`Кто работал ${fmt(GAP.from)} — ${fmt(GAP.to)}`, /Семёнов/);
    press('Показать последствия');

    await waitFor(() =>
      expect(
        http.lastCall('POST /vehicle-requests/:id/assignment-changes/repair/preview'),
      ).toBeTruthy(),
    );
    const preview = bodyOf(http, 'POST /vehicle-requests/:id/assignment-changes/repair/preview');
    expect(preview.mode).toBe('repair');
    expect(preview.knownFills).toEqual([{ from: GAP.from, to: GAP.to, personId: SEMENOV.id }]);
    // Отпечатка в предпросмотре нет никогда: он его выдаёт, а не спрашивает.
    expect(preview.previewFingerprint).toBeUndefined();
    // Пустых работ в теле тоже нет: `anchors: []` схема отвергла бы, а раздела человек не заполнял.
    expect(preview.anchors).toBeUndefined();
    expect(preview.tailResolution).toBeUndefined();

    // Записи ещё не было: сперва человек читает цену действия.
    expect(http.lastCall('POST /vehicle-requests/:id/assignment-changes/repair')).toBeUndefined();

    press('Подтвердить');
    await waitFor(() =>
      expect(http.lastCall('POST /vehicle-requests/:id/assignment-changes/repair')).toBeTruthy(),
    );
    const applied = bodyOf(http, 'POST /vehicle-requests/:id/assignment-changes/repair');
    expect(applied.knownFills).toEqual(preview.knownFills);
    // А в боевом теле отпечаток обязателен: подтверждают именно те последствия, что показаны.
    expect(applied.previewFingerprint).toBe('fp-preview');
  });

  it('без единой названной работы окно не отправляет ничего', async () => {
    const http = renderModal();
    await screen.findByText('Кто работал в неизвестные дни');

    press('Показать последствия');

    await screen.findByText(/Назовите, что чинить/);
    expect(
      http.lastCall('POST /vehicle-requests/:id/assignment-changes/repair/preview'),
    ).toBeUndefined();
  });

  it('решение о машине после конца срока уезжает своим полем', async () => {
    const http = renderModal({
      'GET /vehicle-requests/:id/assignment-changes/repair/state': () =>
        json(
          repairPreview({
            state: 'materialized',
            requiredVehicleResolution: {
              tailVehicleId: 'v-9',
              tailVehicleName: 'Liebherr LTM 1130 · Х001ХХ199',
              assignmentVehicleId: 'v-1',
              assignmentVehicleName: 'Ивановец КС-45717 · Е646СК799',
              since: day(11),
            } as never,
          }),
        ),
    });

    await screen.findByText('Чем заявка закрыта после конца срока');
    fireEvent.click(screen.getByRole('radio', { name: /машина назначения/ }));
    press('Показать последствия');

    await waitFor(() =>
      expect(
        http.lastCall('POST /vehicle-requests/:id/assignment-changes/repair/preview'),
      ).toBeTruthy(),
    );
    expect(
      bodyOf(http, 'POST /vehicle-requests/:id/assignment-changes/repair/preview').tailResolution,
    ).toEqual({ kind: 'assignment_wins' });
  });

  it('отмена заполнения идёт другой командой, а не полем общей формы', async () => {
    const http = renderModal({
      'GET /vehicle-requests/:id/assignment-changes': () =>
        json(
          assignmentHistory({
            state: 'ready',
            changes: [
              assignmentChange({
                id: 'ch-v1',
                effectiveDate: day(-60),
                dimension: 'vehicle',
                vehicle: { vehicleId: 'v-1', name: 'Ивановец КС-45717 · Е646СК799' },
                driver: null,
              }),
              assignmentChange({
                id: 'ch-f1',
                effectiveDate: day(-60),
                driver: { state: 'set', personId: KUZNETSOV.id },
                origin: 'known_fill',
                changeGroupId: 'g-fill',
              }),
            ],
          }),
        ),
    });

    await screen.findByText('Заполнено ранее');
    // Имя берётся из справочника: строка истории носит состояние, а не человека.
    await screen.findByText(new RegExp(KUZNETSOV.fullName));

    press('Отменить заполнение');
    await waitFor(() =>
      expect(
        http.lastCall('POST /vehicle-requests/:id/assignment-changes/repair/preview'),
      ).toBeTruthy(),
    );
    const body = bodyOf(http, 'POST /vehicle-requests/:id/assignment-changes/repair/preview');
    expect(body.mode).toBe('cancel_fill');
    expect(body.target).toEqual({ changeGroupId: 'g-fill' });
    expect(body.knownFills).toBeUndefined();
  });

  it('отказ по правам объяснён текстом в окне, а не тостом в углу', async () => {
    renderModal({
      'POST /vehicle-requests/:id/assignment-changes/repair': () =>
        apiError(403, {
          code: 'forbidden',
          message: 'Заполнение задевает отработанные дни: нужно право на коррекцию путевых листов',
        }),
    });
    await screen.findByText('Кто работал в неизвестные дни');

    await selectOption(`Кто работал ${fmt(GAP.from)} — ${fmt(GAP.to)}`, /Семёнов/);
    press('Показать последствия');
    await screen.findByRole('button', { name: 'Подтвердить' });
    press('Подтвердить');

    await screen.findByText(/нужно право на коррекцию путевых листов/);
  });
});

/**
 * An archived request whose repair touches still-valid paper (R29, defect N3 of the repair wave).
 *
 * `restore` is part of the fingerprint. The window used to preview without it and confirm with
 * `restore: restoreRequired` — a different command, so the server answered 409 "stale", the window
 * re-previewed with the same body, and the circle never closed. Now the window asks the preview
 * again with `restore` as soon as the answer says it is required, shows why, and the command
 * repeats exactly the input of the shown preview.
 */
describe('починка истории архивной заявки', () => {
  const RESTORE_BANNER = 'Заявка в архиве — починка восстановит её';

  it('перезапрашивает предпросмотр с восстановлением и подтверждает тем же телом', async () => {
    const http = renderModal({
      'POST /vehicle-requests/:id/assignment-changes/repair/preview': ({ body }) =>
        json(
          (body as { restore?: boolean }).restore
            ? repairPreview({ archived: true, restoreRequired: true, fingerprint: 'fp-restore' })
            : repairPreview({ archived: true, restoreRequired: true, fingerprint: 'fp-plain' }),
        ),
    });
    await screen.findByText('Кто работал в неизвестные дни');

    await selectOption(`Кто работал ${fmt(GAP.from)} — ${fmt(GAP.to)}`, /Семёнов/);
    press('Показать последствия');

    await screen.findByText(RESTORE_BANNER);
    const previews = http.calls.filter(
      (c) => c.method === 'POST' && c.path.endsWith('/repair/preview'),
    );
    expect(previews).toHaveLength(2);
    expect((previews[0]!.body as Record<string, unknown>).restore).toBeUndefined();
    expect((previews[1]!.body as Record<string, unknown>).restore).toBe(true);

    press('Подтвердить');
    await waitFor(() =>
      expect(http.lastCall('POST /vehicle-requests/:id/assignment-changes/repair')).toBeTruthy(),
    );
    const applied = bodyOf(http, 'POST /vehicle-requests/:id/assignment-changes/repair');
    // The shown preview's input and fingerprint — never a mix of two previews.
    expect(applied.restore).toBe(true);
    expect(applied.previewFingerprint).toBe('fp-restore');
  });

  it('без требования восстановления не шлёт restore вовсе', async () => {
    const http = renderModal();
    await screen.findByText('Кто работал в неизвестные дни');

    await selectOption(`Кто работал ${fmt(GAP.from)} — ${fmt(GAP.to)}`, /Семёнов/);
    press('Показать последствия');
    await screen.findByRole('button', { name: 'Подтвердить' });
    expect(http.countOf('POST /vehicle-requests/:id/assignment-changes/repair/preview')).toBe(1);
    expect(screen.queryByText(RESTORE_BANNER)).toBeNull();

    press('Подтвердить');
    await waitFor(() =>
      expect(http.lastCall('POST /vehicle-requests/:id/assignment-changes/repair')).toBeTruthy(),
    );
    expect(bodyOf(http, 'POST /vehicle-requests/:id/assignment-changes/repair')).not.toHaveProperty(
      'restore',
    );
  });

  it('отказ «нужно восстановление» на команде — пересчёт с восстановлением, а не тост', async () => {
    let commands = 0;
    const refusal =
      'Решение о машине после конца срока у архивной заявки принимается только вместе с восстановлением — включите режим восстановления';
    const http = renderModal({
      'POST /vehicle-requests/:id/assignment-changes/repair/preview': ({ body }) =>
        json(
          repairPreview({
            archived: true,
            fingerprint: (body as { restore?: boolean }).restore ? 'fp-restore' : 'fp-plain',
          }),
        ),
      'POST /vehicle-requests/:id/assignment-changes/repair': () => {
        commands += 1;
        if (commands === 1) {
          return apiError(422, {
            code: 'unprocessable_entity',
            message: refusal,
            fields: { restore: 'Требуется восстановление' },
          });
        }
        return json({
          ok: true,
          repeated: false,
          version: 4,
          state: 'ready',
          operationId: null,
          archived: false,
        });
      },
    });
    await screen.findByText('Кто работал в неизвестные дни');
    await selectOption(`Кто работал ${fmt(GAP.from)} — ${fmt(GAP.to)}`, /Семёнов/);
    press('Показать последствия');
    await screen.findByRole('button', { name: 'Подтвердить' });
    press('Подтвердить');

    await screen.findByText(RESTORE_BANNER);
    expect(screen.queryByText(refusal)).toBeNull();
    press('Подтвердить');
    await waitFor(() =>
      expect(http.countOf('POST /vehicle-requests/:id/assignment-changes/repair')).toBe(2),
    );
    const applied = bodyOf(http, 'POST /vehicle-requests/:id/assignment-changes/repair');
    expect(applied.restore).toBe(true);
    expect(applied.previewFingerprint).toBe('fp-restore');
  });
});

/**
 * "Two operations" (defect D3, decision R5): a fill stops at the last locked day, and if the driver
 * is unknown on the first changeable day, the request needs an anchor — a separate command.
 *
 * The window used to step back with a bare "history fixed" toast; after the server fix that would
 * hide exactly the leftover. Now it waits for the fresh inspection, says what is left, and offers
 * the anchor field right there.
 */
describe('починка истории: что осталось после заполнения', () => {
  const ANCHOR = {
    requestId: 'vr-1',
    requestNumber: 'ТС-1',
    effectiveDate: day(-29),
    from: day(-29),
    to: day(10),
  };

  it('поле заполнения объясняет, что касается только закрытых дней', async () => {
    renderModal();
    await screen.findByText(/Заполнение касается только закрытых дней/);
  });

  it('после заполнения показывает остаток и предлагает якорь отдельной операцией', async () => {
    let repaired = false;
    const http = renderModal({
      'GET /vehicle-requests/:id/assignment-changes/repair/state': () =>
        json(
          repaired
            ? repairPreview({ state: 'materialized', requiredAnchors: [ANCHOR] })
            : repairPreview({ state: 'materialized', fillableGaps: [GAP] }),
        ),
      'POST /vehicle-requests/:id/assignment-changes/repair': () => {
        repaired = true;
        return json({
          ok: true,
          repeated: false,
          version: 4,
          state: 'materialized',
          operationId: null,
          archived: false,
        });
      },
    });
    await screen.findByText('Кто работал в неизвестные дни');
    await selectOption(`Кто работал ${fmt(GAP.from)} — ${fmt(GAP.to)}`, /Семёнов/);
    press('Показать последствия');
    await screen.findByRole('button', { name: 'Подтвердить' });
    press('Подтвердить');

    // Not "history fixed": the toast and the window both say there is more to do.
    await screen.findByText('Ремонт записан, но история ещё не полна');
    await screen.findByText('Ремонт записан — в истории осталось, что чинить');
    expect(screen.queryByText('История заявки исправлена')).toBeNull();
    expect(
      screen.getByText(new RegExp(`${fmt(ANCHOR.from)} — ${fmt(ANCHOR.to)}: машинист неизвестен`)),
    ).toBeDefined();

    // The anchor is offered in the same window, and it goes as a separate command.
    await selectOption(`Кто работал ${fmt(ANCHOR.from)} — ${fmt(ANCHOR.to)}`, /Кузнецов/);
    press('Показать последствия');
    await waitFor(() =>
      expect(http.countOf('POST /vehicle-requests/:id/assignment-changes/repair/preview')).toBe(2),
    );
    const second = bodyOf(http, 'POST /vehicle-requests/:id/assignment-changes/repair/preview');
    expect(second.anchors).toEqual([
      { effectiveDate: ANCHOR.effectiveDate, driverPersonId: KUZNETSOV.id },
    ]);
    expect(second.knownFills).toBeUndefined();
  });

  it('полная после ремонта история — «исправлена», без списка остатка', async () => {
    let repaired = false;
    renderModal({
      'GET /vehicle-requests/:id/assignment-changes/repair/state': () =>
        json(
          repaired
            ? repairPreview()
            : repairPreview({ state: 'materialized', fillableGaps: [GAP] }),
        ),
      'POST /vehicle-requests/:id/assignment-changes/repair': () => {
        repaired = true;
        return json({
          ok: true,
          repeated: false,
          version: 4,
          state: 'ready',
          operationId: null,
          archived: false,
        });
      },
    });
    await screen.findByText('Кто работал в неизвестные дни');
    await selectOption(`Кто работал ${fmt(GAP.from)} — ${fmt(GAP.to)}`, /Семёнов/);
    press('Показать последствия');
    await screen.findByRole('button', { name: 'Подтвердить' });
    press('Подтвердить');

    await screen.findByText('История заявки исправлена');
    await screen.findByText('История заявки полна: чинить в ней нечего.');
    expect(screen.queryByText('Ремонт записан, но история ещё не полна')).toBeNull();
  });
});

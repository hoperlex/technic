import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { moscowDateKeyOf, shiftDateKey, type AssignmentChangeDto } from '@technic/contracts';
import { selectOption, typeDate } from './antd';
import { apiError, json, mockHttp, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser, shtabUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import {
  assignmentChange,
  assignmentHistory,
  assignmentPreview,
  machinist,
  vehicleFeed,
  vehicleRequest,
  vehicleSummary,
} from './factories/vehicle';
import { VehicleMachinistModal } from '../src/pages/vehicle/VehicleMachinistModal';
import { VehicleRequestsTab } from '../src/pages/vehicle/VehicleRequestsTab';

/**
 * Окно «Сменить машиниста» и «Состав по датам» (этап 6 плана `docs/assignment-periods-plan.md`).
 *
 * Сервер меняет человека внутри срока заявки с апреля, а в портале такой двери не было: машиниста
 * меняли, переписывая назначение целиком — вместе с машиной, ставками и рейсом. Отсюда предмет
 * проверок, и он не только про кнопку:
 *
 * - **состав по датам читается человеком**: с какого числа какая машина и какой машинист, а
 *   неизвестное прошлое названо честно (Р19) — пустая строка на его месте читалась бы как «человека
 *   не было», хотя лист за эти дни выдан и фамилия в нём напечатана;
 * - **дремлющее решение видно** (Р24): заведённое за концом срока не прячется, иначе через неделю
 *   его заведут второй раз, а потом оба оживут вместе с продлением;
 * - **три экрана отказов**: пробелы машиниста (`requiredAnchors`), расхождение хвоста (Р31) и то,
 *   что именно погаснет при отмене решения;
 * - **цена действия читается до нажатия**, а не узнаётся из журнала по сгоревшим номерам; и если
 *   говорить не о чем — второго экрана нет вовсе;
 * - **отказ по правам объяснён словами**: коррекционные права спрашивает сервер по посчитанному
 *   исходу (Р32), и приходит такой отказ уже после просмотра последствий.
 *
 * Даты считаются от сегодняшнего дня: «будущее решение» и «дремлющее» — понятия относительно
 * календаря, и прибитая числом фикстура протухла бы вместе с ним.
 */

const TODAY = moscowDateKeyOf(new Date());
const day = (n: number) => shiftDateKey(TODAY, n);
/** Дата так, как её печатает портал и набирает человек: `24.08.2026`. */
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

const CRANE = 'Ивановец КС-45717 · Е646СК799';

/** Заказ спецтехники в работе на собственной машине: только у такого и ведётся история состава. */
const REQUEST = vehicleRequest({
  id: 'vr-1',
  status: 'confirmed',
  dateFrom: day(-10),
  dateTo: day(10),
  version: 3,
  assignment: {
    vehicleId: 'v-1',
    ownership: 'own',
    modelName: 'Ивановец КС-45717',
    registrationNumber: 'Е646СК799',
  },
} as never);

/** Начальное решение: машина и человек одной группой и одной датой (перевод в работу). */
const START: AssignmentChangeDto[] = [
  assignmentChange({
    id: 'ch-v1',
    effectiveDate: day(-10),
    dimension: 'vehicle',
    vehicle: { vehicleId: 'v-1', name: CRANE },
    driver: null,
  }),
  assignmentChange({ id: 'ch-d1', effectiveDate: day(-10) }),
];

/** Решение о человеке на будущее: работы за ним ещё нет, и снять его дешевле, чем переигрывать. */
const FUTURE_DRIVER = assignmentChange({
  id: 'ch-d2',
  effectiveDate: day(3),
  driver: { state: 'set', personId: KUZNETSOV.id },
  origin: 'machinist_change',
  changeGroupId: 'g-2',
});

function renderModal(routes: RouteMap = {}) {
  const http = mockHttp({
    'GET /drivers': () => json(list([SEMENOV, KUZNETSOV])),
    'GET /vehicle-requests/:id/assignment-changes': () => json(assignmentHistory()),
    'POST /vehicle-requests/:id/assignment-changes/preview': () => json(assignmentPreview()),
    'POST /vehicle-requests/:id/assignment-changes': () =>
      json({
        version: 4,
        repeated: false,
        esm2: { cancelled: [], issued: [] },
        history: assignmentHistory(),
      }),
    ...routes,
  });
  renderWithUser(
    <VehicleMachinistModal request={REQUEST} onCancel={() => {}} onApplied={() => {}} />,
  );
  return http;
}

/** Заполнить форму: кого сажают и с какого числа. Портал ни того, ни другого не подставляет. */
async function fillChange(name: RegExp, dateKey: string): Promise<void> {
  await selectOption('Машинист', name);
  typeDate('Работает с', fmt(dateKey));
}

const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

/** Тело последнего запроса к маршруту — им проверяют, что уехало серверу. */
function bodyOf(http: ReturnType<typeof mockHttp>, route: string): Record<string, unknown> {
  return http.lastCall(route)!.body as Record<string, unknown>;
}

describe('состав по датам', () => {
  it('печатает свёртку: с какого числа какая машина и какой машинист', async () => {
    renderModal({
      'GET /vehicle-requests/:id/assignment-changes': () =>
        json(assignmentHistory({ changes: [...START, FUTURE_DRIVER] })),
    });

    // Отрезок кончается днём перед следующим решением, а последний — концом срока работ.
    await screen.findByText(`${fmt(day(-10))} — ${fmt(day(2))}`);
    await screen.findByText(`${fmt(day(3))} — ${fmt(day(10))}`);
    // Имя приходит из справочника: строка истории носит состояние, а не человека.
    expect(screen.getAllByText(SEMENOV.fullName).length).toBeGreaterThan(0);
    expect(screen.getAllByText(KUZNETSOV.fullName).length).toBeGreaterThan(0);
    expect(screen.getAllByText(CRANE).length).toBe(2);
  });

  it('неизвестное прошлое названо честно и объясняет, почему заявка не готова', async () => {
    renderModal({
      'GET /vehicle-requests/:id/assignment-changes': () =>
        json(
          assignmentHistory({
            state: 'materialized',
            changes: [
              START[0]!,
              assignmentChange({
                id: 'ch-u1',
                effectiveDate: day(-10),
                driver: { state: 'unknown' },
                origin: 'backfill',
                createdByName: null,
              }),
              assignmentChange({ id: 'ch-d3', effectiveDate: day(-4), origin: 'machinist_change' }),
            ],
          }),
        ),
    });

    // Не пустая строка и не «не назначен»: лист за эти дни выдан, и человек в нём напечатан.
    await screen.findByText(/неизвестен — историю восстановили по бланкам/);
    await screen.findByText('По бланкам');
    // И сразу — почему заявка «не готова», с днями, а не общей фразой.
    await screen.findByText('История заявки неполна');
    await screen.findByText(/пока за все дни срока не назван машинист/);
  });

  it('расхождение хвоста названо обеими машинами и объясняет, что запирает', async () => {
    renderModal({
      'GET /vehicle-requests/:id/assignment-changes': () =>
        json(
          assignmentHistory({
            changes: [
              assignmentChange({
                id: 'ch-v9',
                effectiveDate: day(-10),
                dimension: 'vehicle',
                vehicle: { vehicleId: 'v-9', name: 'Liebherr LTM 1130 · Х001ХХ199' },
                driver: null,
              }),
              assignmentChange({ id: 'ch-d1', effectiveDate: day(-10) }),
            ],
          }),
        ),
    });

    await screen.findByText('Не решено, чем заявка закрыта после конца срока');
    await screen.findByText(/История ведёт заявку на «Liebherr LTM 1130 · Х001ХХ199»/);
    await screen.findByText(/Смене машиниста расхождение не мешает/);
  });

  it('прошедшее решение отменой не правится: кнопки нет', async () => {
    renderModal({
      'GET /vehicle-requests/:id/assignment-changes': () =>
        json(
          assignmentHistory({
            changes: [
              ...START,
              assignmentChange({ id: 'ch-d4', effectiveDate: day(-3), origin: 'machinist_change' }),
            ],
          }),
        ),
    });

    await screen.findByText(`${fmt(day(-3))} — ${fmt(day(10))}`);
    // Прошедшие дни правят назначением другого человека — так у правки остаются причина и автор.
    expect(screen.queryByRole('button', { name: 'Отменить решение' })).toBeNull();
  });
});

describe('гашение запланированного решения', () => {
  it('называет состав погасшей группы и не гасит её до подтверждения', async () => {
    const http = renderModal({
      'GET /vehicle-requests/:id/assignment-changes': () =>
        json(assignmentHistory({ changes: [...START, FUTURE_DRIVER] })),
      'POST /vehicle-requests/:id/assignment-changes/preview': () =>
        json(
          assignmentPreview({
            operationRequirement: {
              kind: 'assignment_tail',
              reasonRequired: true,
              operationIdRequired: true,
            },
            fingerprint: 'fp-cancel',
          }),
        ),
    });

    await screen.findByText(`${fmt(day(3))} — ${fmt(day(10))}`);
    press('Отменить решение');

    await screen.findByText(`Погаснет решение с ${fmt(day(3))}`);
    await screen.findByText(`Машинист: ${KUZNETSOV.fullName}`);
    await screen.findByText(/на эти дни вернётся состав предыдущего отрезка/);
    // Команда не ушла: человек читает, что именно погаснет, а не узнаёт об этом после.
    expect(http.countOf('POST /vehicle-requests/:id/assignment-changes')).toBe(0);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'сменщик заболел' } });
    press('Подтвердить');

    await waitFor(() =>
      expect(http.countOf('POST /vehicle-requests/:id/assignment-changes')).toBe(1),
    );
    const body = bodyOf(http, 'POST /vehicle-requests/:id/assignment-changes');
    expect(body.kind).toBe('cancel');
    expect(body.target).toEqual({ changeId: 'ch-d2' });
    expect(body.previewFingerprint).toBe('fp-cancel');
    expect((body.operation as { reason: string }).reason).toBe('сменщик заболел');
  });

  it('снятие границы хвоста предупреждает, что продление после него будет заперто', async () => {
    renderModal({
      // Отмена дремлющей записи бумаги не трогает, но идёт записью в журнал (Р32) — значит второй
      // экран человеку показывают: сказать ему есть что.
      'POST /vehicle-requests/:id/assignment-changes/preview': () =>
        json(
          assignmentPreview({
            operationRequirement: {
              kind: 'assignment_tail',
              reasonRequired: true,
              operationIdRequired: true,
            },
          }),
        ),
      'GET /vehicle-requests/:id/assignment-changes': () =>
        json(
          assignmentHistory({
            changes: [
              ...START,
              assignmentChange({
                id: 'ch-tv',
                effectiveDate: day(20),
                dimension: 'vehicle',
                vehicle: { vehicleId: 'v-1', name: CRANE },
                driver: null,
                origin: 'tail_resolution',
                changeGroupId: 'g-tail',
              }),
              assignmentChange({
                id: 'ch-td',
                effectiveDate: day(20),
                driver: { state: 'cleared' },
                origin: 'tail_resolution',
                changeGroupId: 'g-tail',
              }),
            ],
          }),
        ),
    });

    // Дремлющее решение — отдельной строкой, а не спрятанным хвостом списка (Р24).
    await screen.findByText('Ожидает продления срока');
    await screen.findByText(`с ${fmt(day(20))}`);
    press('Отменить решение');

    await screen.findByText(`Погаснет решение с ${fmt(day(20))}`);
    await screen.findByText(`Техника: ${CRANE}`);
    await screen.findByText('Машинист: снят — бланк ведёт арендодатель');
    await screen.findByText(/продлить её не выйдет, пока это решение не примут заново/);
  });
});

describe('смена машиниста', () => {
  it('первое нажатие показывает цену действия, а машиниста не меняет', async () => {
    const http = renderModal({
      'POST /vehicle-requests/:id/assignment-changes/preview': () =>
        json(
          assignmentPreview({
            plan: {
              cancel: [
                {
                  waybillId: 'wb-1',
                  displayNumber: '260604-646-00000004897',
                  from: day(-10),
                  to: day(-4),
                },
              ],
              issue: [
                {
                  issueKey: 0,
                  from: day(-10),
                  to: day(-4),
                  vehicleId: 'v-1',
                  vehicleName: CRANE,
                  driverPersonId: KUZNETSOV.id,
                  driverName: KUZNETSOV.fullName,
                },
              ],
            },
            requiredUnlocks: [
              {
                waybillId: 'wb-1',
                displayNumber: '260604-646-00000004897',
                from: day(-10),
                to: day(-4),
              },
            ],
            unlockFingerprint: 'fp-unlock',
            operationRequirement: { kind: 'crew', reasonRequired: true, operationIdRequired: true },
            fingerprint: 'fp-loud',
          }),
        ),
    });

    await fillChange(/Кузнецов/, day(-6));
    press('Сменить машиниста');

    // Бумага: что сгорит — номером, что выпишется — вместе с составом.
    await screen.findByText(
      new RegExp(`Сгорит № 260604-646-00000004897 за ${fmt(day(-10))} — ${fmt(day(-4))}`),
    );
    await screen.findByText(new RegExp(`машинист ${KUZNETSOV.fullName}`));
    await screen.findByText('Отработанные недели');
    await screen.findByText(/попадёт в журнал вместе с причиной/);
    expect(http.countOf('POST /vehicle-requests/:id/assignment-changes')).toBe(0);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ошиблись сменой' } });
    press('Подтвердить');

    await waitFor(() =>
      expect(http.countOf('POST /vehicle-requests/:id/assignment-changes')).toBe(1),
    );
    const body = bodyOf(http, 'POST /vehicle-requests/:id/assignment-changes');
    expect(body).toMatchObject({
      kind: 'set',
      dimension: 'driver',
      effectiveDate: day(-6),
      driverPersonId: KUZNETSOV.id,
      version: REQUEST.version,
      previewFingerprint: 'fp-loud',
      unlockFingerprint: 'fp-unlock',
    });
  });

  it('говорить не о чем — команда уходит сразу, но с отпечатком', async () => {
    const http = renderModal();

    await fillChange(/Кузнецов/, day(5));
    press('Сменить машиниста');

    // Второго экрана нет: пустое «ничего не произойдёт, нажмите ещё раз» приучает нажимать не
    // читая, и тогда экран не работает в тот единственный раз, когда сказать ему есть что.
    await waitFor(() =>
      expect(http.countOf('POST /vehicle-requests/:id/assignment-changes')).toBe(1),
    );
    expect(http.countOf('POST /vehicle-requests/:id/assignment-changes/preview')).toBe(1);
    expect(bodyOf(http, 'POST /vehicle-requests/:id/assignment-changes').previewFingerprint).toBe(
      'fp-preview',
    );
    expect(screen.queryByText('Путевые листы ЭСМ-2')).toBeNull();
  });

  it('пробелы машиниста: окно спрашивает имена, а команду не отправляет', async () => {
    let phase = 0;
    const http = renderModal({
      'POST /vehicle-requests/:id/assignment-changes/preview': () => {
        phase += 1;
        return json(
          phase === 1
            ? assignmentPreview({
                requiredAnchors: [
                  {
                    requestId: REQUEST.id,
                    requestNumber: REQUEST.displayNumber,
                    effectiveDate: day(-10),
                    from: day(-10),
                    to: day(-8),
                  },
                ],
              })
            : assignmentPreview({ fingerprint: 'fp-with-anchors' }),
        );
      },
    });

    await fillChange(/Кузнецов/, day(-6));
    press('Сменить машиниста');

    // Первая фаза (Р16): последствий ещё нет — их набор станет известен только после ответа.
    await screen.findByText('Назовите машиниста на днях, где он неизвестен');
    expect(screen.queryByText('Путевые листы ЭСМ-2')).toBeNull();
    expect(http.countOf('POST /vehicle-requests/:id/assignment-changes')).toBe(0);

    await selectOption(`Кто работал ${fmt(day(-10))} — ${fmt(day(-8))}`, /Семёнов/);
    press('Показать последствия');

    await waitFor(() =>
      expect(http.countOf('POST /vehicle-requests/:id/assignment-changes/preview')).toBe(2),
    );
    // Названное имя уезжает якорем — той же датой, какую назвал предпросмотр: чужую сервер не примет.
    expect(bodyOf(http, 'POST /vehicle-requests/:id/assignment-changes/preview').anchors).toEqual([
      { effectiveDate: day(-10), driverPersonId: SEMENOV.id },
    ]);
  });

  it('расхождение хвоста из предпросмотра показано тем же экраном', async () => {
    renderModal({
      'POST /vehicle-requests/:id/assignment-changes/preview': () =>
        json(
          assignmentPreview({
            requiredVehicleResolution: {
              tailVehicleId: 'v-9',
              tailVehicleName: 'Liebherr LTM 1130',
              assignmentVehicleId: 'v-1',
              assignmentVehicleName: CRANE,
              since: day(11),
            },
          }),
        ),
    });

    await fillChange(/Кузнецов/, day(5));
    press('Сменить машиниста');

    await screen.findByText('Не решено, чем заявка закрыта после конца срока');
    await screen.findByText(/История ведёт заявку на «Liebherr LTM 1130»/);
  });

  it('не хватило коррекционных прав — отказ объяснён в окне, а не тостом', async () => {
    const http = renderModal({
      'POST /vehicle-requests/:id/assignment-changes/preview': () =>
        json(
          assignmentPreview({
            operationRequirement: { kind: 'crew', reasonRequired: true, operationIdRequired: true },
          }),
        ),
      'POST /vehicle-requests/:id/assignment-changes': () =>
        apiError(403, {
          code: 'forbidden',
          message:
            'Изменение задевает прошедшие дни — правит их тот, у кого есть право коррекции задним числом',
        }),
    });

    await fillChange(/Кузнецов/, day(-6));
    press('Сменить машиниста');
    await screen.findByText('Журнал коррекций');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ошиблись сменой' } });
    press('Подтвердить');

    await screen.findByText('Команду не провести: не хватает прав');
    await screen.findByText(/правит их тот, у кого есть право коррекции задним числом/);
    // И главное — что делать дальше, и что ничего не записано.
    await screen.findByText(/Ничего не записано/);
    expect(http.countOf('POST /vehicle-requests/:id/assignment-changes')).toBe(1);
  });

  it('последствия устарели — окно переспрашивает и объясняет, почему вернуло назад', async () => {
    let attempt = 0;
    const http = renderModal({
      'POST /vehicle-requests/:id/assignment-changes/preview': () =>
        json(
          assignmentPreview({
            plan: {
              cancel: [
                { waybillId: 'wb-1', displayNumber: 'ЭСМ-2 № 9', from: day(-10), to: day(-4) },
              ],
              issue: [],
            },
            fingerprint: `fp-${++attempt}`,
          }),
        ),
      'POST /vehicle-requests/:id/assignment-changes': ({ body }) =>
        (body as { previewFingerprint?: string }).previewFingerprint === 'fp-1'
          ? apiError(409, {
              code: 'assignment_preview_stale',
              message: 'Последствия изменились с момента предпросмотра',
            })
          : json({
              version: 4,
              repeated: false,
              esm2: { cancelled: [], issued: [] },
              history: assignmentHistory(),
            }),
    });

    await fillChange(/Кузнецов/, day(-6));
    press('Сменить машиниста');
    await screen.findByText(/Сгорит № ЭСМ-2 № 9/);
    press('Подтвердить');

    // Не тост и не «отпечаток не совпал», а пересчитанный перечень с объяснением возврата.
    await screen.findByText('Последствия пересчитаны');
    await screen.findByText(/Последствия изменились с того момента, как вы их смотрели/);
    await waitFor(() =>
      expect(http.countOf('POST /vehicle-requests/:id/assignment-changes/preview')).toBe(2),
    );

    // Круг замыкает нажатие, а не окно само: повторить команду за спиной у человека оно не вправе.
    expect(http.countOf('POST /vehicle-requests/:id/assignment-changes')).toBe(1);
    press('Подтвердить');
    await waitFor(() =>
      expect(http.countOf('POST /vehicle-requests/:id/assignment-changes')).toBe(2),
    );
  });
});

/**
 * Кому дверь открыта (§9, Р32).
 *
 * Действие живёт в карточке рядом со строкой «Водитель»: там его и ищут глазами. Права у него те
 * же, какими открыта сама ручка, — вести состояние заявки и видеть бумагу; коррекционных
 * (`waybills.correct`) портал не спрашивает нарочно, их спрашивает сервер и по посчитанному исходу.
 * А вот два состояния действие прячут насовсем, и не из осторожности: у линейного заказа машиниста
 * называют при выписке каждого листа (ADR 0100 §6), а на арендную машину бланк выписывает
 * арендодатель — истории человека там не ведётся вовсе, и дверь ответила бы отказом.
 */
describe('доступ к смене машиниста', () => {
  const LINEAR = vehicleRequest({
    ...REQUEST,
    id: 'vr-2',
    num: 43,
    displayNumber: 'Т-43',
    isLinear: true,
  } as never);
  const RENTAL = vehicleRequest({
    ...REQUEST,
    id: 'vr-3',
    num: 44,
    displayNumber: 'Т-44',
    assignment: { ...REQUEST.assignment!, ownership: 'rental', lessorName: 'СпецАренда' },
  } as never);

  function renderTab(user = authUser()) {
    const http = mockHttp({
      'GET /vehicle-requests/summary': () => json(vehicleSummary({ confirmed: 3 })),
      'GET /vehicle-requests/feed': () => json(vehicleFeed([REQUEST, LINEAR, RENTAL])),
      'GET /objects': () => json(list([{ id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' }])),
      'GET /departments': () => json(list([])),
      'GET /vehicle-classifications': () => json(emptyList()),
      'GET /vehicles': () => json(emptyList()),
      'GET /drivers': () => json(list([SEMENOV, KUZNETSOV])),
      'GET /vehicle-requests/:id/history': () => json([]),
      'GET /vehicle-requests/:id/driver': () =>
        json({ personId: SEMENOV.id, fullName: SEMENOV.fullName, phone: '' }),
      'GET /vehicle-requests/:id/waybills': () => json([]),
      'GET /vehicle-requests/:id/relocations': () => json([]),
      'GET /vehicle-requests/:id/days': () => json({ items: [], onDate: TODAY }),
      'GET /vehicle-requests/:id/assignment-changes': () => json(assignmentHistory()),
    });
    renderWithUser(<VehicleRequestsTab />, { user });
    return http;
  }

  /*
   * Действие ищется по тексту, а не по роли: на полной странице `getByRole` вычисляет доступное
   * имя каждому узлу таблицы и трёх открытых окон — счёт идёт на минуты (о том же предупреждает
   * шапка `test/antd.ts`). Текст здесь так же однозначен: другой кнопки с этими словами нет.
   */

  /** Открыть карточку заявки из строки списка — там и стоит действие. */
  async function openCard(displayNumber: string): Promise<void> {
    const row = (await screen.findByText(displayNumber)).closest('tr')!;
    fireEvent.click(row.querySelector('[aria-label="Открыть карточку"]')!);
    await screen.findByText(SEMENOV.fullName);
  }

  it('диспетчеру предложена — своим правом, без коррекционного', async () => {
    renderTab(authUser());
    await openCard(REQUEST.displayNumber);
    expect(screen.getByText('Сменить машиниста')).toBeDefined();
  });

  it('у линейного заказа и на арендной машине действия нет', async () => {
    renderTab(authUser());

    // У линейного машиниста называют при выписке каждого листа — истории человека на заявке нет.
    await openCard(LINEAR.displayNumber);
    expect(screen.queryByText('Сменить машиниста')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));

    // На арендной машине бланк ведёт арендодатель: портал её машиниста не знает вовсе.
    await openCard(RENTAL.displayNumber);
    expect(screen.queryByText('Сменить машиниста')).toBeNull();
  });

  it('роль без права вести заявку действия не видит', async () => {
    renderTab(shtabUser('obj-1'));
    await openCard(REQUEST.displayNumber);
    expect(screen.queryByText('Сменить машиниста')).toBeNull();
  });
});

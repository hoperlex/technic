import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import {
  ROLLBACK_WAYBILL_MESSAGE,
  type VehicleRequestAssignmentDto,
  type VehicleRequestCompletionDto,
  type VehicleRequestRollbackPreviewDto,
} from '@technic/contracts';
import { apiError, json, mockHttp, type HttpMock, type MockResponse, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import {
  approvedVehicleRequest,
  classification,
  vehicleFeed,
  vehicleSummary,
} from './factories/vehicle';
import { VehicleRequestsTab } from '../src/pages/vehicle/VehicleRequestsTab';
import { MOBILE_VIEWPORT } from './viewport';
import { expectModalClosed } from './antd';

/**
 * Возврат заявки на технику из «В работе» в «Новую» — откат администратора, который стирает всё,
 * что заявка нажила в работе (`transitionResetsWork`).
 *
 * ПЕРЕЧЕНЬ СТИРАЕМОГО СЧИТАЕТ СЕРВЕР (ADR 0211), и это главное, что сторожит сценарий. Прежде его
 * собирал портал по DTO заявки и её перегонам — вторым носителем правила, которое исполняет дверь, —
 * и пересказ разошёлся в обе стороны: молчал о днях, сменах, досрочном завершении и листах ЭСМ-2 и
 * обещал убрать перегон, который остаётся из-за выписанного по нему листа. Поэтому проверяется не
 * «строка про рейс есть», а «на экране ровно то, что прислал предпросмотр»: строка, которой в
 * ответе нет, — это снова вранье ровно там, где человек решает, стирать ли работу.
 *
 * Остальные четыре вещи по разметке неотличимы от исправной работы:
 *
 * 1. Возврат не выполняется нажатием пункта меню: сперва окно с обязательной причиной.
 * 2. **Визы в перечне нет вовсе** (ADR 0172): откат её не снимает, и строка о ней остановила бы
 *    человека ради сбережения того, чему ничего не грозит. Проверяется отрицанием — такая строка в
 *    перечне была, и вернуть её обратно легче всего незаметно.
 * 3. Пока предпросмотр не ответил, окно не обещает ничего: ни пустого «стирать нечего», ни
 *    перечня. Пустой перечень читается как «работы не завелось» — и возврат жмут спокойно.
 * 4. На сервер уходит один PATCH статуса — с причиной, версией и отпечатком прочитанных
 *    последствий, — а список после него перезапрашивается.
 */

/** Собственная машина со ставкой: её назначение и есть та договорённость, которую стирает возврат. */
const OWN_VEHICLE: VehicleRequestAssignmentDto = {
  vehicleId: 'v-1',
  ownership: 'own',
  vehicleKindId: 'vk-special',
  vehicleTypeId: 'vt-1',
  typeName: 'Автокраны',
  vehicleCategoryId: 'vc-1',
  categoryName: 'г/п 25 т',
  categorySpecs: { lift_capacity: 25 },
  modelName: 'Ивановец КС-45717',
  registrationNumber: 'Е646СК799',
  description: '',
  lessorId: null,
  lessorName: null,
  pricePerHour: 2500,
  pricePerShift: null,
  shiftHours: null,
  assignedBy: 'user-1',
  assignedByName: 'Диспетчеров Д. П.',
  assignedAt: '2026-08-02T08:00:00.000Z',
};

/** Арендная: ставок по ней не согласовали, и назвать в перечне остаётся арендодателя. */
const RENTAL_VEHICLE: VehicleRequestAssignmentDto = {
  ...OWN_VEHICLE,
  vehicleId: 'v-2',
  ownership: 'rental',
  registrationNumber: null,
  modelName: null,
  description: 'Автокран 25 тн',
  lessorId: 'cp-9',
  lessorName: 'ООО «Кран-Сервис»',
  pricePerHour: null,
};

/**
 * Факт у заявки «В работе» — не выдумка: так выглядит заявка, которую уже закрывали и откатили
 * администратором назад в работу (откат `done` → `confirmed` прежний факт бережёт). Возврат в
 * «Новую» — единственный переход, который его стирает, и сказать об этом нужно заранее.
 */
const COMPLETION: VehicleRequestCompletionDto = {
  workedUnit: 'hours',
  workedAmount: 26,
  rate: null,
  totalCost: null,
  completedBy: 'user-1',
  completedByName: 'Диспетчеров Д. П.',
  completedAt: '2026-08-03T14:00:00.000Z',
  // Заявка закрыта старым статусным путём: фактической даты у такого факта нет (Р3 плана
  // закрытия фактической датой), и снимка прежнего срока тоже.
  endedOn: null,
  previousDateTo: null,
};

/**
 * Ответ предпросмотра со всеми семью частями плана сразу. Не «типичная» заявка, а полная: окно
 * обязано назвать каждую часть, и заявка, у которой половины нет, этого не проверит.
 *
 * Номера бланков здесь есть — так отвечают держателю `waybills.read`; без журнала сервер пришлёт
 * `sheets: null`, и тогда о бумаге говорят счётчики (отдельная проверка ниже).
 */
const PREVIEW: VehicleRequestRollbackPreviewDto = {
  blockers: [],
  assignment: true,
  completion: true,
  routes: {
    detach: [{ routeNumber: 'Р-3', date: '2026-08-05' }],
    frozen: [{ routeNumber: 'Р-4', date: '2026-08-06' }],
  },
  relocations: {
    drop: [{ routeNumber: 'Р-8', purpose: 'delivery', routeDate: '2026-08-05' }],
    keep: [{ routeNumber: 'Р-9', purpose: 'pickup', routeDate: '2026-08-14' }],
  },
  shifts: [
    { date: '2026-08-05', approved: false },
    { date: '2026-08-06', approved: true },
  ],
  earlyEnd: { newDateTo: '2026-08-12' },
  esm2: {
    cancelCount: 1,
    keepCount: 1,
    sheets: {
      cancel: [{ id: 'wb-1', number: 'ЭСМ2-000123', from: '2026-08-10', to: '2026-08-16' }],
      keep: [{ id: 'wb-2', number: 'ЭСМ2-000120', from: '2026-08-03', to: '2026-08-09' }],
    },
  },
  dropsLinearFreeze: true,
  fingerprint: 'fp-1',
};

/** Плана нет вовсе: сервер сказал, что стирать нечего, — и только тогда об этом говорит окно. */
const EMPTY_PREVIEW: VehicleRequestRollbackPreviewDto = {
  ...PREVIEW,
  routes: { detach: [], frozen: [] },
  relocations: { drop: [], keep: [] },
  assignment: false,
  completion: false,
  shifts: [],
  earlyEnd: null,
  esm2: { cancelCount: 0, keepCount: 0, sheets: { cancel: [], keep: [] } },
  dropsLinearFreeze: false,
};

/**
 * Заявка в работе со всем нажитым: виза, машина со ставкой, место в рейсе и факт прошлого
 * закрытия. Версия нарочно не первая — её видно в теле запроса.
 */
const IN_WORK = approvedVehicleRequest({
  id: 'vr-1',
  status: 'confirmed',
  version: 5,
  assignment: OWN_VEHICLE,
  completion: COMPLETION,
  route: {
    id: 'route-3',
    displayNumber: 'Р-3',
    routeDate: '2026-08-05',
    position: 2,
    hasWaybill: false,
    version: 4,
  },
});

const REASON = 'Заказчик перенёс работы, машину сняли';

const STATUS_ROUTE = 'PATCH /vehicle-requests/:id/status';
const PREVIEW_ROUTE = 'POST /vehicle-requests/:id/rollback/preview';

/**
 * Вкладка глазами администратора: откат назад по циклу — его право
 * (`requests.rollbackStatus`), и пункта «Новая» в меню статусов больше ни у кого нет.
 */
function renderTab(over: RouteMap = {}, mobile = false): HttpMock {
  const http = mockHttp({
    'GET /vehicle-requests/feed': () => json(vehicleFeed([IN_WORK])),
    'GET /vehicle-requests/summary': () => json(vehicleSummary({ confirmed: 1 })),
    // Справочники экрана: сценарию не нужны, но вкладка их спрашивает при первом рендере.
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /vehicle-classifications': () => json(list([classification()])),
    // Справочник техники — фильтр по назначенной машине (ADR 0098); списку заявок он не важен.
    'GET /vehicles': () => json(emptyList()),
    // Последствия спрашиваются ровно на открытие окна возврата и считаются сервером тем же планом,
    // которым он их потом исполнит, — своего перечня у портала больше нет.
    [PREVIEW_ROUTE]: () => json(PREVIEW),
    // Отвечаем той же заявкой, уже вернувшейся в «Новую», — так отвечает и сервер. Виза в ответе
    // остаётся: её откат не снимает (ADR 0172), и заявка возвращается готовой к работе.
    [STATUS_ROUTE]: ({ params, body }) =>
      json(
        approvedVehicleRequest({
          ...IN_WORK,
          id: params.id,
          status: (body as { status: 'new' }).status,
          assignment: null,
          completion: null,
          route: null,
          version: IN_WORK.version + 1,
        }),
      ),
    ...over,
  });

  renderWithUser(<VehicleRequestsTab />, {
    user: authUser({ role: 'admin' }),
    viewport: mobile ? MOBILE_VIEWPORT : undefined,
  });
  return http;
}

/** Кнопка по видимой подписи: `*ByRole` на таблице antd считает доступные имена всему дереву. */
function clickButton(label: string) {
  const button = [...document.querySelectorAll('button')].find((el) => el.textContent === label);
  expect(button, `кнопка «${label}»`).toBeTruthy();
  fireEvent.click(button!);
}

/** Смена статуса строки: тег статуса — кнопка с меню переходов, доступных этой роли (ADR 0021). */
async function openStatusMenu(target: string) {
  clickButton('В работе');
  const item = await waitFor(() => {
    const found = [...document.querySelectorAll('.ant-dropdown-menu-item')].find(
      (el) => el.textContent === target,
    );
    expect(found, `пункт меню «${target}»`).toBeTruthy();
    return found!;
  });
  fireEvent.click(item);
}

/** Кнопка окна возврата: подписи у неё свои — «Вернуть в «Новую»» и «Не возвращать». */
function submitRollbackModal() {
  clickButton('Вернуть в «Новую»');
}

/** Окно открыто и последствия на экране: до их появления окно ничего не обещает. */
async function openRollbackWindow() {
  await openStatusMenu('Новая');
  expect(await screen.findByText('Возврат заявки в «Новую»')).toBeDefined();
  await screen.findByText('Заявка вернётся в состояние только что заведённой');
}

function typeReason(value = REASON) {
  fireEvent.change(screen.getByLabelText('Причина возврата заявки № Т-42'), {
    target: { value },
  });
}

describe('возврат заявки на технику в «Новую»', () => {
  it('перечисляет присланное сервером: что снимется и что останется', async () => {
    const http = renderTab();
    expect(await screen.findByText('Т-42')).toBeDefined();

    await openRollbackWindow();
    // Пункт меню сам по себе ничего не меняет: работу стирает подтверждение, а не промах пальцем.
    expect(http.countOf(STATUS_ROUTE)).toBe(0);
    // Последствия спрошены под ту версию, которую окно потом и предъявит двери.
    expect(http.lastCall(PREVIEW_ROUTE)?.body).toEqual({ version: IN_WORK.version });

    // Снимется: машина со ставкой (название — из заявки, сам факт снятия — из плана), место в
    // рейсе, перегон без листа, дни работ с согласованными врозь, ожидающее досрочное, лист ЭСМ-2
    // текущей недели, заморозка линейности и предъявленный факт.
    expect(await screen.findByText(/Назначенная техника: Е646СК799 — .*₽\/час/)).toBeDefined();
    expect(screen.getByText('Место в рейсе Р-3 за 05.08.2026')).toBeDefined();
    expect(screen.getByText('Доставка техники на объект — рейс Р-8 от 05.08.2026')).toBeDefined();
    expect(
      screen.getByText('Дни работ — 2 строки, из них согласованных объектом: 06.08.2026'),
    ).toBeDefined();
    expect(
      screen.getByText('Запрос на досрочное завершение по 12.08.2026 — он ждёт визы и будет снят'),
    ).toBeDefined();
    expect(
      screen.getByText('Аннулируются листы ЭСМ-2: ЭСМ2-000123 (10.08.2026 — 16.08.2026)'),
    ).toBeDefined();
    expect(screen.getByText(/Снимется заморозка линейности/)).toBeDefined();
    expect(screen.getByText('Предъявленный факт: 26 ч')).toBeDefined();

    // Останется — и сказано почему: лист держит и место в рейсе, и перегон, а отработанная неделя
    // сверкой не аннулируется. Молчание об этом и обещало лишнее.
    expect(
      screen.getByText('Место в рейсе Р-4 за 06.08.2026 — его держит действующий путевой лист'),
    ).toBeDefined();
    expect(screen.getByText(/Вывоз техники с объекта — рейс Р-9 от 14\.08\.2026/)).toBeDefined();
    expect(
      screen.getByText(/Останутся действующими листы ЭСМ-2 за отработанные недели: ЭСМ2-000120/),
    ).toBeDefined();

    // Виза у заявки есть (`approvedVehicleRequest`), и всё же о ней не сказано ни слова: откат её
    // не снимает, и завизированной она вернётся в «Новую» (ADR 0172).
    expect(screen.queryByText(/Виза руководителя строительства/)).toBeNull();
  });

  it('перечень не обещает того, чего в плане сервера нет', async () => {
    // Та же заявка арендной машиной, а план пуст: кроме назначения сервер не назвал ничего — и
    // окно не называет. Прежний портал дорисовывал бы сюда перегоны и место в рейсе по DTO.
    renderTab({
      'GET /vehicle-requests/feed': () =>
        json(
          vehicleFeed([
            approvedVehicleRequest({
              ...IN_WORK,
              assignment: RENTAL_VEHICLE,
              completion: null,
              route: null,
            }),
          ]),
        ),
      [PREVIEW_ROUTE]: () => json({ ...EMPTY_PREVIEW, assignment: true }),
    });
    expect(await screen.findByText('Т-42')).toBeDefined();

    await openRollbackWindow();

    // У аренды ставок не согласовали — назван арендодатель: с ним договаривались, ему и звонить.
    expect(
      screen.getByText('Назначенная техника: Автокран 25 тн — ООО «Кран-Сервис»'),
    ).toBeDefined();
    expect(screen.queryByText(/Виза руководителя строительства/)).toBeNull();
    expect(screen.queryByText(/Место в рейсе/)).toBeNull();
    expect(screen.queryByText(/Доставка техники/)).toBeNull();
    expect(screen.queryByText(/Дни работ/)).toBeNull();
    expect(screen.queryByText(/ЭСМ-2/)).toBeNull();
    expect(screen.queryByText(/Предъявленный факт/)).toBeNull();
  });

  it('без журнала листов о бумаге говорят счётчики, а не номера бланков', async () => {
    // `sheets: null` — так сервер отвечает держателю права отката без `waybills.read` (ADR 0106):
    // «сгорит ли бумага» он узнаёт полностью, номера строгой отчётности ему не открываются.
    renderTab({
      [PREVIEW_ROUTE]: () =>
        json({ ...PREVIEW, esm2: { cancelCount: 2, keepCount: 1, sheets: null } }),
    });
    expect(await screen.findByText('Т-42')).toBeDefined();
    await openRollbackWindow();

    expect(screen.getByText('Аннулируются недельные листы ЭСМ-2 — 2')).toBeDefined();
    expect(
      screen.getByText('Останутся действующими листы ЭСМ-2 за отработанные недели — 1'),
    ).toBeDefined();
    expect(screen.queryByText(/ЭСМ2-000123/)).toBeNull();
  });

  it('до ответа сервера окно не обещает ни перечня, ни пустоты', async () => {
    // Ответ придерживается до нажатия: ожидание — это состояние окна, а не мгновение между кадрами.
    const held: { release?: () => void } = {};
    renderTab({
      [PREVIEW_ROUTE]: () =>
        new Promise<MockResponse>((resolve) => {
          held.release = () => resolve(json(PREVIEW));
        }),
    });
    expect(await screen.findByText('Т-42')).toBeDefined();
    await openStatusMenu('Новая');
    expect(await screen.findByText('Возврат заявки в «Новую»')).toBeDefined();

    // Ожидание названо вслух. Пустой перечень или «стирать нечего» человек читает как «работы по
    // заявке не завелось» и жмёт возврат спокойно — а стёрлось бы всё.
    expect(await screen.findByText('Выясняем, что снимет возврат')).toBeDefined();
    expect(screen.queryByText('Стирать у заявки нечего — сменится только статус.')).toBeNull();
    expect(screen.queryByText(/Назначенная техника/)).toBeNull();

    held.release!();
    expect(await screen.findByText('Место в рейсе Р-3 за 05.08.2026')).toBeDefined();
  });

  it('помеха берётся из ответа предпросмотра, а не из флага заявки', async () => {
    // Флага `hasActiveWaybill` у заявки нет, а лист держит день заказа (ADR 0207): сказать об этом
    // может только сервер, и говорит он теми же словами, которыми откажет дверь.
    renderTab({
      'GET /vehicle-requests/feed': () =>
        json(vehicleFeed([approvedVehicleRequest({ ...IN_WORK, hasActiveWaybill: false })])),
      [PREVIEW_ROUTE]: () =>
        json({
          ...PREVIEW,
          blockers: [{ code: 'active_waybill', message: ROLLBACK_WAYBILL_MESSAGE }],
        }),
    });
    expect(await screen.findByText('Т-42')).toBeDefined();
    await openRollbackWindow();
    expect(screen.getByText(ROLLBACK_WAYBILL_MESSAGE)).toBeDefined();
  });

  it('флаг заявки сам по себе помехой больше не считается', async () => {
    // Обратная сторона того же: `hasActiveWaybill` держится и при аннулированном листе, а план
    // блокировок не нашёл. Пугать запретом, которого у двери нет, — не лучше, чем молчать о нём.
    renderTab({
      'GET /vehicle-requests/feed': () =>
        json(vehicleFeed([approvedVehicleRequest({ ...IN_WORK, hasActiveWaybill: true })])),
    });
    expect(await screen.findByText('Т-42')).toBeDefined();
    await openRollbackWindow();
    expect(screen.queryByText(ROLLBACK_WAYBILL_MESSAGE)).toBeNull();
  });

  it('отказ предпросмотра показан вместо перечня: вслепую не подтверждают', async () => {
    renderTab({
      [PREVIEW_ROUTE]: () =>
        apiError(500, { code: 'internal', message: 'Сервер не ответил', requestId: 'req-1' }),
    });
    expect(await screen.findByText('Т-42')).toBeDefined();
    await openStatusMenu('Новая');
    expect(await screen.findByText('Не удалось узнать, что снимет возврат')).toBeDefined();
    expect(screen.queryByText('Стирать у заявки нечего — сменится только статус.')).toBeNull();
  });

  it('без причины окно не отпускает: на сервер ничего не уходит', async () => {
    const http = renderTab();
    expect(await screen.findByText('Т-42')).toBeDefined();

    await openRollbackWindow();

    submitRollbackModal();
    expect(await screen.findByText('Укажите причину')).toBeDefined();
    expect(http.countOf(STATUS_ROUTE)).toBe(0);

    // Пробелы причиной не считаются: иначе поле обходилось бы нажатием на пробел, а в истории
    // статусов осталась бы пустая строка вместо объяснения, зачем стёрли работу.
    typeReason('   ');
    submitRollbackModal();
    await waitFor(() => expect(screen.getByText('Укажите причину')).toBeDefined());
    expect(http.countOf(STATUS_ROUTE)).toBe(0);
  });

  it('уходит один PATCH — с причиной, версией и отпечатком прочитанных последствий', async () => {
    const http = renderTab();
    expect(await screen.findByText('Т-42')).toBeDefined();

    await openRollbackWindow();

    // Причина набирается с лишними пробелами: в историю статусов она попадает обрезанной.
    typeReason(`  ${REASON}  `);
    submitRollbackModal();

    await waitFor(() => expect(http.countOf(STATUS_ROUTE)).toBe(1));
    const call = http.lastCall(STATUS_ROUTE);
    // Адрес — та самая заявка, из строки которой открыли меню.
    expect(call?.path).toBe(`/vehicle-requests/${IN_WORK.id}/status`);
    expect(call?.body).toMatchObject({
      status: 'new',
      // Причина обязательна и уходит тем же запросом, что и статус: отдельным она разъехалась бы
      // со сменой статуса при первом же отказе сервера.
      comment: REASON,
      // Версия — защита от одновременной правки: без неё сервер не отличит возврат «этой» заявки
      // от возврата той, которую тем временем успели взять в работу другой машиной.
      version: IN_WORK.version,
      // Отпечаток — последствия, которые человек прочитал. Изменились между просмотром и нажатием,
      // не тронув версию (по перегону выписали лист, неделя стала отработанной), — дверь откажет.
      previewFingerprint: PREVIEW.fingerprint,
    });
    // Снятие машины и стирание факта — дело сервера: вторым запросом портал их не досылает. Кроме
    // PATCH статуса окно написало ровно один POST — вопрос предпросмотра, и тот ничего не меняет.
    expect(http.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
    expect(http.countOf(PREVIEW_ROUTE)).toBe(1);
    expect(http.calls.filter((c) => c.method !== 'GET')).toHaveLength(2);
  });

  it('устаревший отпечаток возвращает свежий перечень, а не тост «повторите»', async () => {
    let patches = 0;
    const http = renderTab({
      [PREVIEW_ROUTE]: () =>
        json(
          patches === 0
            ? PREVIEW
            : // Неделя кончилась, пока человек читал: лист больше не сгорит, и подтверждать он
              // должен уже это.
              {
                ...PREVIEW,
                esm2: { cancelCount: 0, keepCount: 2, sheets: null },
                fingerprint: 'fp-2',
              },
        ),
      [STATUS_ROUTE]: ({ params, body }) => {
        patches += 1;
        if (patches === 1) {
          return apiError(409, {
            code: 'version_conflict',
            message: 'Данные изменились с момента просмотра: посмотрите заново',
          });
        }
        return json(
          approvedVehicleRequest({
            ...IN_WORK,
            id: params.id,
            status: (body as { status: 'new' }).status,
            assignment: null,
            completion: null,
            route: null,
            version: IN_WORK.version + 1,
          }),
        );
      },
    });
    expect(await screen.findByText('Т-42')).toBeDefined();
    await openRollbackWindow();

    typeReason();
    submitRollbackModal();

    // Окно не закрылось и не показало тост: оно спросило последствия заново и сказало, почему.
    expect(await screen.findByText('Последствия пересчитаны')).toBeDefined();
    await waitFor(() => expect(http.countOf(PREVIEW_ROUTE)).toBe(2));
    // Прежняя строка о сгорающем листе снята: перечень описывает новое состояние, а не прежнее.
    expect(screen.queryByText(/Аннулируются/)).toBeNull();
    expect(http.countOf(STATUS_ROUTE)).toBe(1);

    // Второе нажатие — по прочитанному заново: уезжает новый отпечаток, и дверь пропускает.
    submitRollbackModal();
    await waitFor(() => expect(http.countOf(STATUS_ROUTE)).toBe(2));
    expect(http.lastCall(STATUS_ROUTE)?.body).toMatchObject({ previewFingerprint: 'fp-2' });
    await expectModalClosed('Возврат заявки в «Новую»');
  });

  it('после возврата список перезапрашивается, а окно закрывается', async () => {
    const http = renderTab();
    expect(await screen.findByText('Т-42')).toBeDefined();
    expect(http.countOf('GET /vehicle-requests/feed')).toBe(1);

    await openRollbackWindow();
    typeReason();
    submitRollbackModal();

    // Строка списка обязана показать новый статус сама: перезапрос — единственное, что об этом
    // заботится, а прежний статус на экране читался бы как «возврат не прошёл».
    await waitFor(() => expect(http.countOf('GET /vehicle-requests/feed')).toBe(2));
    await expectModalClosed('Возврат заявки в «Новую»');
  });

  it('на телефоне окно открывается тем же путём — из списка статусов снизу', async () => {
    const http = renderTab({}, true);
    expect(await screen.findByText('Т-42')).toBeDefined();

    // На телефоне переходы показываются списком снизу, а не выпадающим меню (ADR 0030): пункт
    // «Новая» появляется там сам, и окно причины обязано открыться и отсюда — иначе возврат
    // с телефона уходил бы без объяснения либо не уходил вовсе.
    fireEvent.click(screen.getByLabelText('Изменить статус'));
    clickButton('Новая');

    expect(await screen.findByText('Возврат заявки в «Новую»')).toBeDefined();
    expect(await screen.findByText('Место в рейсе Р-3 за 05.08.2026')).toBeDefined();
    expect(http.countOf(STATUS_ROUTE)).toBe(0);

    typeReason();
    submitRollbackModal();

    await waitFor(() => expect(http.countOf(STATUS_ROUTE)).toBe(1));
    expect(http.lastCall(STATUS_ROUTE)?.body).toMatchObject({
      status: 'new',
      comment: REASON,
      previewFingerprint: PREVIEW.fingerprint,
    });
  });
});

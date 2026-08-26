import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assignRouteSchema,
  dayAlreadyPlannedMessage,
  LINEAR_DAY_DOOR_MESSAGE,
  assignVehicleSchema,
  attachRouteRequestSchema,
  canCorrectRoute,
  canIssueWaybill,
  canJoinRoute,
  correctRouteSchema,
  createVehicleRouteSchema,
  transferCorrectionSchema,
  formatVehicleRouteNumber,
  issueRouteWaybillSchema,
  isRouteEditable,
  movedRouteDateKey,
  ROUTE_REQUEST_CAPACITY,
  parseVehicleRouteNumberSearch,
  updateVehicleRouteSchema,
  CARGO_NOTE_LIMIT,
  routeCargoLabel,
  routeCargoWithNote,
  routeContactsLabel,
  routeDateMismatch,
  routeExtraTaskLine,
  routeWaybillForm,
  routeOrderSchema,
  routeTripFieldsSchema,
  type RouteTripFields,
  trailerLabelOf,
  shouldDetachOnStatus,
} from '@technic/contracts';

/**
 * Маршрут — рейс машины на дату (план `docs/vehicle-routes-plan.md`). Правила здесь чистые: их
 * зовут и форма, и сервер, и разъехаться двум наборам условий негде — как это уже сделано с
 * `waybillRequirement` (ADR 0041 п. 1).
 */

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';

/** Заявка, годная для рейса: от неё отталкиваются проверки «чего не хватает». */
const goodRequest = {
  requestType: 'freight_transport' as const,
  isLinear: false,
  status: 'confirmed' as const,
  deletedAt: null,
  // День грузоперевозки — точка: его несёт время подачи (ADR 0100 §2 — у линейного заказа вместо
  // точки отрезок срока, и правило спрашивает у заявки не «какой день», а «мой ли он»).
  day: { kind: 'trip' as const, date: '2026-08-03' },
  ownership: 'own' as const,
};

/**
 * Линейный заказ, годный для рейса дня: заказ техники на объект, у которого вместо дня подачи срок
 * работ, а вместо «одного рейса» — по рейсу на распланированный день (ADR 0100).
 */
const goodLinearRequest = {
  requestType: 'special_equipment' as const,
  isLinear: true,
  status: 'confirmed' as const,
  deletedAt: null,
  day: {
    kind: 'linear' as const,
    dateFrom: '2026-08-01',
    dateTo: '2026-08-10',
    plannedDays: [] as string[],
  },
  ownership: 'own' as const,
};

const emptyRoute = {
  routeDate: '2026-08-03',
  requestCount: 0,
  purpose: 'freight' as const,
  formCode: '4p' as const,
};

describe('номер маршрута', () => {
  it('читается так же, как его называют в разговоре', () => {
    expect(formatVehicleRouteNumber(12)).toBe('Р-12');
  });

  it('поиск понимает и число, и номер с префиксом', () => {
    expect(parseVehicleRouteNumberSearch('12')).toBe(12);
    expect(parseVehicleRouteNumberSearch('Р-12')).toBe(12);
    expect(parseVehicleRouteNumberSearch('р 0012')).toBe(12);
    expect(parseVehicleRouteNumberSearch('Р-')).toBeUndefined();
    expect(parseVehicleRouteNumberSearch('маршрут')).toBeUndefined();
  });
});

describe('заморозка маршрута выписанным листом', () => {
  it('без листа и с аннулированным маршрут правится', () => {
    expect(isRouteEditable(null)).toBe(true);
    expect(isRouteEditable('cancelled')).toBe(true);
  });

  it('с действующим листом — нет: бумага у водителя главнее записи', () => {
    expect(isRouteEditable('issued')).toBe(false);
  });
});

describe('какая заявка годится для рейса', () => {
  it('грузоперевозка в работе на собственной машине в тот же день', () => {
    expect(canJoinRoute(goodRequest, emptyRoute)).toEqual({ ok: true });
  });

  it('заказ техники на объект по маршруту не едет', () => {
    const check = canJoinRoute({ ...goodRequest, requestType: 'special_equipment' }, emptyRoute);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain('грузоперевозки');
  });

  /*
   * Линейный заказ (ADR 0100) — единственное исключение из «в рейс ходят только грузоперевозки»:
   * его дни ездят обычными рейсами. Но приходит он в правило другой стороной — днём срока, — и
   * попытка положить его целиком, как грузовую заявку, объясняется своими словами: дверь у дня
   * одна, карточка заявки (§8).
   */
  it('линейный заказ со стороны рейса не кладут: у дня своя дверь', () => {
    const check = canJoinRoute(
      { ...goodRequest, requestType: 'special_equipment', isLinear: true },
      emptyRoute,
    );
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toBe(LINEAR_DAY_DOOR_MESSAGE);
    expect(check.ok === false && check.reason).toContain('карточки заявки');
  });

  it('заявка не в работе в рейс не кладётся, и статус назван в ответе', () => {
    const check = canJoinRoute({ ...goodRequest, status: 'new' }, emptyRoute);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain('Новая');
  });

  it('удалённая заявка не годится', () => {
    expect(canJoinRoute({ ...goodRequest, deletedAt: '2026-08-01T10:00:00Z' }, emptyRoute).ok).toBe(
      false,
    );
  });

  it('арендная машина и машина без назначения объясняются по-разному', () => {
    const rental = canJoinRoute({ ...goodRequest, ownership: 'rental' }, emptyRoute);
    expect(rental.ok === false && rental.reason).toContain('арендодатель');
    const none = canJoinRoute({ ...goodRequest, ownership: null }, emptyRoute);
    expect(none.ok === false && none.reason).toContain('не назначена');
  });

  it('заявка соседнего дня в рейс не попадает: лист печатает задание на день', () => {
    const check = canJoinRoute(
      { ...goodRequest, day: { kind: 'trip', date: '2026-08-04' } },
      emptyRoute,
    );
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain('2026-08-04');
  });

  /*
   * Вместимость задаёт бумага, и у бланков она разная (ADR 0068): 4-П держит семь строк задания
   * (четыре талона и три строки доп. задания), а таблица оборота формы № 3 разграфлена на десять.
   * Одним числом на портал это не выразить — отсюда и `ROUTE_REQUEST_CAPACITY`.
   */
  it('восьмая заявка не встаёт в 4-П: в нём семь строк задания', () => {
    const full = { ...emptyRoute, requestCount: ROUTE_REQUEST_CAPACITY['4p'] };
    const check = canJoinRoute(goodRequest, full);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain('7 строк задания');
    expect(check.ok === false && check.reason).toContain('второй маршрут');
    expect(
      canJoinRoute(goodRequest, { ...full, requestCount: ROUTE_REQUEST_CAPACITY['4p'] - 1 }),
    ).toEqual({ ok: true });
  });

  /*
   * У легкового предел свой и не бумажный: задание форма № 3 не печатает вовсе (ADR 0071), и
   * десять — это «сколько заявок портал ведёт в одном рейсе» (CHECK позиции, миграция 0096).
   * Отказ поэтому и звучит иначе: ссылаться на строки бланка, которых он не печатает, значило бы
   * объяснять человеку выдуманную причину.
   */
  it('легковой держит десять, но местами рейса, а не строками бланка', () => {
    const leg3 = { ...emptyRoute, formCode: 'leg3' as const };
    // Восьмая заявка, отбитая у 4-П, здесь проходит: предел другой, и он больше.
    expect(
      canJoinRoute(goodRequest, { ...leg3, requestCount: ROUTE_REQUEST_CAPACITY['4p'] }),
    ).toEqual({ ok: true });
    const check = canJoinRoute(goodRequest, {
      ...leg3,
      requestCount: ROUTE_REQUEST_CAPACITY.leg3,
    });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain('10 мест');
    expect(check.ok === false && check.reason).not.toContain('строк задания');
  });
});

/**
 * Линейный заказ в рейсе (ADR 0100): заявка отвечает правилу не днём подачи, а сроком работ, и
 * день ей задаёт сам рейс — строка состава и рейс делят дату физически (составной FK, миграция
 * 0127). Отсюда две проверки, которых у грузоперевозки нет: день внутри срока и день ещё не занят.
 */
describe('какой день линейного заказа годится для рейса', () => {
  const dayRoute = { ...emptyRoute, routeDate: '2026-08-05' };

  it('день внутри срока встаёт в грузовой рейс', () => {
    expect(canJoinRoute(goodLinearRequest, dayRoute)).toEqual({ ok: true });
  });

  it('рейс за сроком заказа день не получает — срок назван в отказе', () => {
    const check = canJoinRoute(goodLinearRequest, { ...dayRoute, routeDate: '2026-08-11' });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain('вне срока заказа');
    expect(check.ok === false && check.reason).toContain('2026-08-01 — 2026-08-10');
  });

  it('однодневный срок читается по дате начала: пустой конец — это тот же день', () => {
    const oneDay = {
      ...goodLinearRequest,
      day: { ...goodLinearRequest.day, dateFrom: '2026-08-05', dateTo: null },
    };
    expect(canJoinRoute(oneDay, dayRoute)).toEqual({ ok: true });
    expect(canJoinRoute(oneDay, { ...dayRoute, routeDate: '2026-08-06' }).ok).toBe(false);
  });

  it('день, уже стоящий в рейсе, вторым не встаёт — и текст отказа общий с карточкой заявки', () => {
    const check = canJoinRoute(
      { ...goodLinearRequest, day: { ...goodLinearRequest.day, plannedDays: ['2026-08-05'] } },
      dayRoute,
    );
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toBe(dayAlreadyPlannedMessage('2026-08-05'));
  });

  /*
   * Соседний день той же заявки помехой не является: ради этого линейный тип и заведён — машина
   * выходит день за днём, и каждый день едет своим рейсом.
   */
  it('другой распланированный день не мешает', () => {
    const check = canJoinRoute(
      { ...goodLinearRequest, day: { ...goodLinearRequest.day, plannedDays: ['2026-08-04'] } },
      dayRoute,
    );
    expect(check).toEqual({ ok: true });
  });

  it('состояние заявки спрашивается раньше дня: не в работе — не планируют', () => {
    const check = canJoinRoute({ ...goodLinearRequest, status: 'new' }, dayRoute);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain('Новая');
  });

  it('арендная техника в рейс не идёт и днями: лист на неё выписывает арендодатель', () => {
    const check = canJoinRoute({ ...goodLinearRequest, ownership: 'rental' }, dayRoute);
    expect(check.ok === false && check.reason).toContain('арендодатель');
  });

  /*
   * Ёмкость у дня та же, что у грузовой заявки: строки задания в бланке общие (ADR 0068). Второй
   * объект того же дня попадает в тот же лист, пока эти строки есть, — и упирается в семь.
   */
  it('восьмой день в 4-П не влезает — в листе семь строк задания', () => {
    const check = canJoinRoute(goodLinearRequest, {
      ...dayRoute,
      requestCount: ROUTE_REQUEST_CAPACITY['4p'],
    });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain('7 строк задания');
  });
});

describe('состав рейса при смене статуса заявки', () => {
  it('«Выполнена» состав не трогает: рейс состоялся, связь — история', () => {
    expect(shouldDetachOnStatus('done', false)).toBe(false);
    expect(shouldDetachOnStatus('done', true)).toBe(false);
  });

  it('отмена и возврат в «Новую» вынимают заявку, пока маршрут не заморожен', () => {
    expect(shouldDetachOnStatus('cancelled', false)).toBe(true);
    expect(shouldDetachOnStatus('new', false)).toBe(true);
  });

  it('из выписанного листа заявка исчезнуть не может', () => {
    expect(shouldDetachOnStatus('cancelled', true)).toBe(false);
    expect(shouldDetachOnStatus('new', true)).toBe(false);
  });
});

describe('готовность рейса к выписке листа', () => {
  const ready = {
    purpose: 'freight' as const,
    driverPersonId: UUID_A,
    formCode: '4p' as const,
    requests: [{ displayNumber: 'ТС-501', status: 'confirmed' as const }],
    sourceRequest: null,
    waybillStatus: null,
  };

  it('водитель, непустой состав и все заявки в работе', () => {
    expect(canIssueWaybill(ready)).toEqual({ ok: true });
  });

  it('без водителя лист не выписать — он обязательный реквизит', () => {
    const check = canIssueWaybill({ ...ready, driverPersonId: null });
    expect(check.ok === false && check.reason).toContain('водителя');
  });

  it('пустому рейсу выписывать нечего', () => {
    expect(canIssueWaybill({ ...ready, requests: [] }).ok).toBe(false);
    expect(canIssueWaybill({ ...ready, requests: [], blankAllowed: false }).ok).toBe(false);
  });

  /**
   * Пустой бланк (ADR 0071): по праву `waybills.issueBlank` лист по рейсу без заявок выписывается.
   * Пустым остаётся только задание — остальное рейс даёт как обычно, и без водителя лист не
   * выписывается ни с правом, ни без: он обязательный реквизит, а не часть задания.
   */
  it('с правом на пустой бланк рейс без заявок выписывается, но водитель всё равно нужен', () => {
    expect(canIssueWaybill({ ...ready, requests: [], blankAllowed: true })).toEqual({ ok: true });

    const check = canIssueWaybill({
      ...ready,
      requests: [],
      blankAllowed: true,
      driverPersonId: null,
    });
    expect(check.ok === false && check.reason).toContain('водителя');
  });

  it('право на пустой бланк не делает пустым состав из отменённых заявок', () => {
    const check = canIssueWaybill({
      ...ready,
      blankAllowed: true,
      requests: [{ displayNumber: 'ТС-501', status: 'cancelled' }],
    });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.blocking).toEqual(['ТС-501']);
  });

  it('действующий лист второго не даёт, аннулированный — даёт', () => {
    expect(canIssueWaybill({ ...ready, waybillStatus: 'issued' }).ok).toBe(false);
    expect(canIssueWaybill({ ...ready, waybillStatus: 'cancelled' })).toEqual({ ok: true });
  });

  it('отменённая заявка в составе называет себя и блокирует выдачу', () => {
    const check = canIssueWaybill({
      ...ready,
      waybillStatus: 'cancelled',
      requests: [
        { displayNumber: 'ТС-501', status: 'confirmed' },
        { displayNumber: 'ТС-502', status: 'cancelled' },
      ],
    });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.blocking).toEqual(['ТС-502']);
  });

  /*
   * Собрать рейс шире бланка портал не даёт (`canJoinRoute`), но бланк типа машины правится
   * справочником уже после сборки (ADR 0065): десять заявок легкового могли остаться с семью
   * строками 4-П. Печатать такой лист нельзя — часть работы дня в бумаге не назовётся.
   */
  it('состав шире бланка выписку останавливает и называет лишние заявки', () => {
    const requests = Array.from({ length: ROUTE_REQUEST_CAPACITY.leg3 }, (_, i) => ({
      displayNumber: `ТС-${500 + i}`,
      status: 'confirmed' as const,
    }));
    expect(canIssueWaybill({ ...ready, formCode: 'leg3', requests })).toEqual({ ok: true });

    const check = canIssueWaybill({ ...ready, formCode: '4p', requests });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain('7 строк задания');
    expect(check.ok === false && check.blocking).toEqual(['ТС-507', 'ТС-508', 'ТС-509']);
  });

  it('закрытая заявка — тоже история рейса, а не задание на новый', () => {
    const check = canIssueWaybill({
      ...ready,
      requests: [{ displayNumber: 'ТС-501', status: 'done' }],
    });
    expect(check.ok === false && check.blocking).toEqual(['ТС-501']);
  });

  /**
   * Коррекция (ADR 0101, Р36): preflight будущего состояния гоняется **до** первого аннулирования,
   * когда действующий лист ещё на месте. Контекст снимает ровно одну проверку — «лист уже есть», —
   * потому что этот лист аннулируется той же транзакцией.
   */
  it('коррекция проходит проверку при действующем листе — его же и заменяет', () => {
    expect(canIssueWaybill({ ...ready, waybillStatus: 'issued' }).ok).toBe(false);
    expect(
      canIssueWaybill({ ...ready, waybillStatus: 'issued', correction: { allowed: true } }),
    ).toEqual({ ok: true });
  });

  /**
   * А вот требование «все заявки в работе» коррекция не снимает (Р3), и это главное, что здесь не
   * меняется: возврат заявки в «Новую» при замороженном рейсе её из состава не вынимает
   * (`shouldDetachOnStatus`), так что `new` во вчерашнем рейсе — штатное последствие ADR 0058.
   * Пропустив её, портал напечатал бы бумагу на работу, которую никто не поручал.
   */
  it('но состав коррекция не смягчает: не-«В работе» блокирует и её', () => {
    const check = canIssueWaybill({
      ...ready,
      waybillStatus: 'issued',
      correction: { allowed: true },
      requests: [
        { displayNumber: 'ТС-501', status: 'confirmed' },
        { displayNumber: 'ТС-502', status: 'new' },
      ],
    });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.blocking).toEqual(['ТС-502']);
  });

  it('водителя коррекция тоже не отменяет — он обязательный реквизит листа', () => {
    const check = canIssueWaybill({
      ...ready,
      waybillStatus: 'issued',
      correction: { allowed: true },
      driverPersonId: null,
    });
    expect(check.ok === false && check.reason).toContain('водителя');
  });

  /**
   * У перегона состава нет: вместо талонов заказчиков он держит заявку, ради которой едет, — и
   * проверяется её состояние. «Выполнена» перегону не мешает: технику вывозят с объекта и после
   * того, как работы закрыли.
   */
  describe('перегон техники', () => {
    const relocation = {
      purpose: 'delivery' as const,
      driverPersonId: UUID_A,
      formCode: '4p' as const,
      requests: [],
      sourceRequest: { displayNumber: 'ТС-700', status: 'confirmed' as const },
      waybillStatus: null,
    };

    it('пустой состав перегону не мешает — он едет по своей заявке', () => {
      expect(canIssueWaybill(relocation)).toEqual({ ok: true });
    });

    it('вывоз выписывается и по закрытой заявке: технику увозят после работ', () => {
      expect(canIssueWaybill({ ...relocation, purpose: 'pickup' })).toEqual({ ok: true });
      expect(
        canIssueWaybill({
          ...relocation,
          purpose: 'pickup',
          sourceRequest: { displayNumber: 'ТС-700', status: 'done' },
        }),
      ).toEqual({ ok: true });
    });

    it('отменённая и откатанная в «Новую» заявка перегон не выписывает', () => {
      for (const status of ['cancelled', 'new'] as const) {
        const check = canIssueWaybill({
          ...relocation,
          sourceRequest: { displayNumber: 'ТС-700', status },
        });
        expect(check.ok).toBe(false);
        expect(check.ok === false && check.blocking).toEqual(['ТС-700']);
      }
    });

    it('водитель обязателен и здесь — он реквизит листа, а не состава', () => {
      expect(canIssueWaybill({ ...relocation, driverPersonId: null }).ok).toBe(false);
    });
  });
});

/**
 * Коррекция рейса (ADR 0101). Предикат отвечает на то, что не зависит от субъекта: глубина по
 * календарю и состав. Право и причину спрашивает `backdateGuard` — здесь их нет намеренно, иначе
 * одно и то же правило считалось бы двумя способами.
 */
describe('можно ли исправить рейс задним числом', () => {
  const TODAY = '2026-08-12';
  const route = {
    routeDate: '2026-08-11',
    requests: [{ displayNumber: 'ТС-501', status: 'confirmed' as const }],
  };

  it('вчерашний рейс с составом в работе — можно', () => {
    expect(canCorrectRoute(route, TODAY)).toEqual({ ok: true });
  });

  it('рейс без заявок коррекции не мешает: блокировать в нём нечего', () => {
    expect(canCorrectRoute({ ...route, requests: [] }, TODAY)).toEqual({ ok: true });
  });

  /**
   * Р13: новый лист печатает задание по всему составу. Переписав назначения у части заявок,
   * получим бумагу, где остальные талоны снова расходятся с порталом, — поэтому отказ, а не
   * частичная коррекция.
   */
  it('закрытая заявка в составе останавливает коррекцию и называет свой номер', () => {
    const check = canCorrectRoute(
      {
        ...route,
        requests: [
          { displayNumber: 'ТС-501', status: 'confirmed' },
          { displayNumber: 'ТС-502', status: 'done' },
        ],
      },
      TODAY,
    );
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.blocking).toEqual(['ТС-502']);
    // Текст говорит, что делать, а не «нельзя» (Р38): закрытие откатывает администратор.
    expect(check.ok === false && check.reason).toContain('администратор');
  });

  /**
   * «Новая» в составе вчерашнего рейса — штатное последствие ADR 0058, а не редкость. Поручение у
   * неё другое, чем у закрытой: её берут в работу обычным порядком, и делает это диспетчер сам.
   */
  it('«Новая» в составе — тоже отказ, но с другим поручением', () => {
    const check = canCorrectRoute(
      { ...route, requests: [{ displayNumber: 'ТС-503', status: 'new' }] },
      TODAY,
    );
    expect(check.ok === false && check.blocking).toEqual(['ТС-503']);
    expect(check.ok === false && check.reason).toContain('в работу');
    expect(check.ok === false && check.reason).not.toContain('администратор');
  });

  it('смешанный состав называет оба поручения и обе заявки', () => {
    const check = canCorrectRoute(
      {
        ...route,
        requests: [
          { displayNumber: 'ТС-501', status: 'done' },
          { displayNumber: 'ТС-502', status: 'new' },
        ],
      },
      TODAY,
    );
    expect(check.ok === false && check.blocking).toEqual(['ТС-501', 'ТС-502']);
    expect(check.ok === false && check.reason).toContain('администратор');
    expect(check.ok === false && check.reason).toContain('виза');
  });

  /**
   * Глубина проверяется раньше состава: за тридцатью днями не поможет ни откат закрытия, ни виза —
   * там нужен другой человек с другим правом (Р37). Узнать об этом после похода к администратору
   * за откатом было бы худшим из порядков.
   */
  it('старше тридцати дней — отказ по глубине, и он звучит раньше отказа по составу', () => {
    const old = {
      routeDate: '2026-07-01',
      requests: [{ displayNumber: 'ТС-501', status: 'done' as const }],
    };
    const check = canCorrectRoute(old, TODAY);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.blocking).toEqual([]);
    expect(check.ok === false && check.reason).toContain('30 дней');
    // С правом глубины остаётся только состав — и он называет свою заявку.
    const withRight = canCorrectRoute(old, TODAY, { unlimited: true });
    expect(withRight.ok === false && withRight.blocking).toEqual(['ТС-501']);
  });

  it('ровно тридцать дней — ещё граница диспетчера', () => {
    expect(canCorrectRoute({ ...route, routeDate: '2026-07-13' }, TODAY).ok).toBe(true);
    expect(canCorrectRoute({ ...route, routeDate: '2026-07-12' }, TODAY).ok).toBe(false);
  });
});

/**
 * Тела команд коррекции (ADR 0101, Р2 и Р30). Обе идемпотентны по `operationId` и обе требуют
 * причину: у бланка строгой отчётности повтор запроса не бесплатное действие, а сгоревший номер
 * без объяснения не разберёт потом никто.
 */
describe('схемы коррекции рейса', () => {
  const base = { operationId: UUID_A, version: 3, reason: 'выехала другая машина' };

  it('принимает машину, водителя, реквизиты и порядок талонов', () => {
    const parsed = correctRouteSchema.safeParse({
      ...base,
      vehicleId: UUID_B,
      driverPersonId: UUID_C,
      requestOrder: [UUID_B, UUID_C],
    });
    expect(parsed.success).toBe(true);
  });

  it('без ключа идемпотентности, версии или причины — не принимает', () => {
    expect(
      correctRouteSchema.safeParse({ ...base, operationId: undefined, vehicleId: UUID_B }).success,
    ).toBe(false);
    expect(
      correctRouteSchema.safeParse({ ...base, version: undefined, vehicleId: UUID_B }).success,
    ).toBe(false);
    expect(correctRouteSchema.safeParse({ ...base, reason: '  ', vehicleId: UUID_B }).success).toBe(
      false,
    );
  });

  /** Р31: тело с одной причиной сожгло бы номер, ничего не исправив. */
  it('коррекция, которая ничего не меняет, отклоняется', () => {
    expect(correctRouteSchema.safeParse(base).success).toBe(false);
  });

  it('одна и та же заявка дважды в порядке талонов — не порядок', () => {
    const parsed = correctRouteSchema.safeParse({ ...base, requestOrder: [UUID_B, UUID_B] });
    expect(parsed.success).toBe(false);
  });

  /**
   * Состав коррекцией не меняется (Р2): приход и уход заявки — это перенос со своей командой,
   * своими блокировками и версией **обоих** рейсов. Прежний `requestIds` позволял потерять талон в
   * чужом рейсе, не назвав его, — потому его в теле и нет.
   */
  it('состава в теле коррекции нет вовсе', () => {
    const parsed = correctRouteSchema.safeParse({ ...base, requestIds: [UUID_B] });
    expect(parsed.success).toBe(false);
  });

  it('перенос называет оба рейса с их версиями', () => {
    const parsed = transferCorrectionSchema.safeParse({
      operationId: UUID_A,
      version: 2,
      source: { routeId: UUID_B, version: 5 },
      requestId: UUID_C,
      reason: 'заявка ехала вторничным рейсом',
    });
    expect(parsed.success).toBe(true);
  });

  it('перенос без версии источника не принимается: жгутся оба номера', () => {
    const parsed = transferCorrectionSchema.safeParse({
      operationId: UUID_A,
      version: 2,
      source: { routeId: UUID_B },
      requestId: UUID_C,
      reason: 'заявка ехала вторничным рейсом',
    });
    expect(parsed.success).toBe(false);
  });

  /**
   * Дыра 1 (Р29): заведение рейса и выписка листа принимают причину, но не требуют её схемой —
   * нужна она ровно тогда, когда дата уже прошла, а это знает только сервер, у которого есть
   * субъект с его правами. Схема, потребовавшая причину у всякого рейса, спрашивала бы объяснение
   * за обычный завтрашний день.
   */
  it('заведение рейса принимает причину заднего числа и обходится без неё', () => {
    const route = { vehicleId: UUID_A, routeDate: '2026-08-12' };
    expect(createVehicleRouteSchema.safeParse(route).success).toBe(true);
    const backdated = createVehicleRouteSchema.safeParse({
      ...route,
      reason: 'рейс состоялся во вторник, заводим сегодня',
    });
    expect(backdated.success && backdated.data.reason).toBe(
      'рейс состоялся во вторник, заводим сегодня',
    );
  });

  it('выписка листа принимает причину и ключ операции — оба необязательны', () => {
    expect(issueRouteWaybillSchema.safeParse({ version: 2 }).success).toBe(true);
    const backdated = issueRouteWaybillSchema.safeParse({
      version: 2,
      reason: 'бумагу выписали на месте',
      operationId: UUID_A,
    });
    expect(backdated.success).toBe(true);
    // Ключ — uuid: им сервер отличает повтор от новой команды, и «строка» тут не годится.
    expect(
      issueRouteWaybillSchema.safeParse({ version: 2, reason: 'x', operationId: 'нет' }).success,
    ).toBe(false);
  });

  it('талон в приёмнике — позиция в пределах бланка либо ничего', () => {
    const body = {
      operationId: UUID_A,
      version: 2,
      source: { routeId: UUID_B, version: 5 },
      requestId: UUID_C,
      reason: 'перенос',
    };
    expect(transferCorrectionSchema.safeParse({ ...body, position: 1 }).success).toBe(true);
    expect(transferCorrectionSchema.safeParse({ ...body, position: 0 }).success).toBe(false);
    expect(transferCorrectionSchema.safeParse({ ...body, position: 99 }).success).toBe(false);
  });
});

/**
 * Бланк рейса (`routeWaybillForm`). У грузового его выбирает тип машины, у перегона он всегда
 * 4-П: экскаватор идёт по дорогам как транспортное средство, и документ у этой поездки один.
 */
describe('бланк рейса', () => {
  const own = { ownership: 'own' as const };

  it('грузовой рейс печатается бланком своего типа', () => {
    expect(routeWaybillForm({ ...own, purpose: 'freight', formCode: '4p' }).formCode).toBe('4p');
    expect(routeWaybillForm({ ...own, purpose: 'freight', formCode: 'leg3' }).formCode).toBe(
      'leg3',
    );
  });

  it('перегон печатается 4-П, каким бы бланком ни печатался рейс типа', () => {
    for (const purpose of ['delivery', 'pickup'] as const) {
      expect(routeWaybillForm({ purpose, ownership: 'own', formCode: 'leg3' })).toEqual({
        formCode: '4p',
        reason: null,
      });
    }
  });

  it('на арендную технику лист выписывает арендодатель — и перегон её тоже его', () => {
    for (const purpose of ['freight', 'delivery'] as const) {
      const check = routeWaybillForm({
        purpose,
        ownership: 'rental',
        formCode: '4p',
      });
      expect(check.formCode).toBeNull();
      expect(check.reason).toContain('арендодатель');
    }
  });
});

/** Заявки в перегон не кладут: талоны заказчиков — про грузоперевозку. */
describe('состав перегона', () => {
  it('заявка в рейс перемещения не встаёт', () => {
    const check = canJoinRoute(goodRequest, { ...emptyRoute, purpose: 'delivery' });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain('перегон');
  });

  /*
   * У линейной техники перегона не бывает вовсе (ADR 0100 §9): она уезжает вечером домой, и её
   * выезд — обычный рейс дня. Отказ поэтому свой: «заявки в перегон не кладут» ничего бы здесь не
   * объяснило — кладут-то не заявку, а день.
   */
  it('день линейного заказа в перегон не кладут — перегона у него нет', () => {
    const check = canJoinRoute(goodLinearRequest, { ...emptyRoute, purpose: 'delivery' });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain('возвращается на базу');
  });
});

describe('груз в подписи рейса', () => {
  it('объём вперёд массы — тем же правилом, что печатает бланк', () => {
    expect(routeCargoLabel('12.000', '8.000')).toBe('12.000 м³');
    expect(routeCargoLabel(null, '8.000')).toBe('8.000 т');
    expect(routeCargoLabel(null, null)).toBe('');
  });

  /**
   * Комментарий заявки — вторая строка графы «Груз» (ADR 0071). Строк у графы ровно две: первую
   * занимает количество, вторую комментарий, и на неё влезает около двух десятков знаков.
   */
  describe('комментарий заявки второй строкой', () => {
    it('становится второй строкой графы', () => {
      expect(routeCargoWithNote('12 м³', 'песок карьерный')).toBe('12 м³\nпесок карьерный');
    });

    it('пустая часть не оставляет пустой строки', () => {
      expect(routeCargoWithNote('12 м³', '')).toBe('12 м³');
      expect(routeCargoWithNote('12 м³', '   ')).toBe('12 м³');
      // Груза без количества у заявки не бывает (CHECK «объём или масса»), но графа не обязана
      // об этом знать: одинокий комментарий не должен начинаться с переноса.
      expect(routeCargoWithNote('', 'песок')).toBe('песок');
      expect(routeCargoWithNote('', '')).toBe('');
    });

    it('многострочный комментарий схлопывается: строка в графе одна', () => {
      expect(routeCargoWithNote('8 т', 'песок\nзвонить за час')).toBe('8 т\nпесок звонить за час');
    });

    /*
     * Длинный комментарий режется многоточием, а не бумагой. Обрезка по границе ячейки молчалива
     * и приходится на середину слова — на бумаге это выглядит как полный текст, которому просто
     * не хватило места, и понять, что часть примечания потерялась, читателю нечем.
     */
    it('длинный комментарий обрезается видимо — многоточием', () => {
      const long = 'песок карьерный мытый первого класса, звонить за час до подачи';
      const cargo = routeCargoWithNote('12 м³', long);
      const note = cargo.split('\n')[1]!;

      expect(note.length).toBe(CARGO_NOTE_LIMIT);
      expect(note.endsWith('…')).toBe(true);
      expect(long.startsWith(note.slice(0, -1).trimEnd())).toBe(true);
    });
  });
});

/**
 * Графа «заказчик, телефон» бланка 4-П: по строке на каждый конец маршрута. Строки не подписаны —
 * их порядок повторяет графы «откуда» и «куда» той же строки задания, — и обе обязаны уместиться
 * в графу, у которой по высоте ровно две строки.
 */
describe('контакты в графе задания', () => {
  it('строка на погрузку и строка на разгрузку, в порядке маршрута', () => {
    expect(
      routeContactsLabel([
        { name: 'Иванов Иван Иванович', phone: '9141234567' },
        { name: 'Петров Пётр Петрович', phone: '9147654321' },
      ]),
    ).toBe('Иванов И.И., +7 (914) 123 45 67\nПетров П.П., +7 (914) 765 43 21');
  });

  it('ФИО из трёх слов сокращается до инициалов — иначе строка не влезает в графу', () => {
    expect(routeContactsLabel([{ name: 'Кузнецова Анна Владимировна', phone: '9141112233' }])).toBe(
      'Кузнецова А.В., +7 (914) 111 22 33',
    );
  });

  it('запись не из трёх слов печатается как есть: разбирать её портал не берётся', () => {
    expect(routeContactsLabel([{ name: 'Иванов И.И.', phone: '9141112233' }])).toBe(
      'Иванов И.И., +7 (914) 111 22 33',
    );
    expect(routeContactsLabel([{ name: 'прораб Иванов Иван Иванович', phone: '9141112233' }])).toBe(
      'прораб Иванов Иван Иванович, +7 (914) 111 22 33',
    );
  });

  /*
   * Заявки старше миграции 0062 контакта не несут вовсе. Пустая строка в графе выглядела бы
   * потерянным номером — печатается только то, что известно, а нет ничего, так и графа пуста.
   */
  it('пустой контакт строки не занимает', () => {
    expect(
      routeContactsLabel([
        { name: '', phone: '' },
        { name: 'Петров Пётр Петрович', phone: '9147654321' },
      ]),
    ).toBe('Петров П.П., +7 (914) 765 43 21');
    expect(routeContactsLabel([{ name: '', phone: '' }])).toBe('');
  });

  it('телефон без имени печатается один: дозвониться по нему можно', () => {
    expect(routeContactsLabel([{ name: '', phone: '9147654321' }])).toBe('+7 (914) 765 43 21');
  });
});

/**
 * Задание рейсов 5–7 (ADR 0068): в бланке 4-П им отведены три нижние строки блока
 * «Дополнительное задание водителю» — по одной объединённой ячейке без граф внутри.
 */
describe('строка доп. задания', () => {
  const contacts = routeContactsLabel([
    { name: 'Иванов Иван Иванович', phone: '9141234567' },
    { name: 'Петров Пётр Петрович', phone: '9147654321' },
  ]);

  it('складывается порядком граф таблицы выше: откуда, куда, груз, контакты', () => {
    expect(
      routeExtraTaskLine({
        from: 'Зимняя, 666',
        to: 'Лётная, 555',
        cargo: '10 м³',
        contacts,
      }),
    ).toBe(
      'Зимняя, 666 → Лётная, 555, 10 м³, Иванов И.И., +7 (914) 123 45 67; Петров П.П., +7 (914) 765 43 21',
    );
  });

  /*
   * Контакты приходят двумя строками — так их печатает графа «заказчик, телефон» четырёх верхних
   * строк. Здесь строка одна на всё задание и высотой в две: перенос внутри контактов вытеснил бы
   * с бумаги вторую половину задания.
   */
  it('контакты сводятся в одну строку: переносов внутри задания быть не должно', () => {
    expect(routeExtraTaskLine({ from: 'А', to: 'Б', cargo: '', contacts })).not.toContain('\n');
  });

  /*
   * Груз приходит сюда двумя строками — количество и комментарий заявки (ADR 0071), — и сводится
   * тем же порядком, что и контакты: ячейка блока держит две строки на всё задание.
   */
  it('груз с комментарием тоже сводится в строку', () => {
    const line = routeExtraTaskLine({
      from: 'Зимняя, 666',
      to: 'Лётная, 555',
      cargo: routeCargoWithNote('10 м³', 'песок'),
      contacts: '',
    });
    expect(line).toBe('Зимняя, 666 → Лётная, 555, 10 м³; песок');
    expect(line).not.toContain('\n');
  });

  it('пустой рейс даёт пустую строку — ни стрелки, ни запятых', () => {
    expect(routeExtraTaskLine({ from: '', to: '', cargo: '', contacts: '' })).toBe('');
  });

  /*
   * Заявка без части граф — обычное дело: груз не всегда заведён, контакта у заявок старше
   * миграции 0062 нет вовсе. Разделители пропадают вместе со значением, иначе строка приезжает на
   * бумагу с осиротевшими запятыми.
   */
  it('пропущенная графа не оставляет разделителя', () => {
    expect(routeExtraTaskLine({ from: 'Зимняя, 666', to: '', cargo: '', contacts: '' })).toBe(
      'Зимняя, 666',
    );
    expect(
      routeExtraTaskLine({ from: 'Зимняя, 666', to: 'Лётная, 555', cargo: '', contacts: '' }),
    ).toBe('Зимняя, 666 → Лётная, 555');
  });
});

describe('схемы маршрута', () => {
  it('реквизиты прицепа без прицепа в рейсе не принимаются', () => {
    expect(
      routeTripFieldsSchema.safeParse({ withTrailer: true, trailer1Model: 'МАЗ' }).success,
    ).toBe(true);
    expect(
      routeTripFieldsSchema.safeParse({ withTrailer: false, trailer1Model: 'МАЗ' }).success,
    ).toBe(false);
  });

  it('второй прицеп без первого не принимается — в бланке они идут по порядку', () => {
    const both = {
      withTrailer: true,
      trailer1Model: 'ШМИТЦ SPR-24',
      trailer1RegNumber: 'ВХ933277',
      trailer2Model: 'КРОНА SDP27',
      trailer2RegNumber: 'ЕН806277',
    };
    expect(routeTripFieldsSchema.safeParse(both).success).toBe(true);
    // Первый пуст, второй заполнен: в шапке 4-П это дыра между графами, а не «второй прицеп».
    expect(
      routeTripFieldsSchema.safeParse({ withTrailer: true, trailer2Model: 'КРОНА SDP27' }).success,
    ).toBe(false);
    expect(
      routeTripFieldsSchema.safeParse({ withTrailer: true, trailer2RegNumber: 'ЕН806277' }).success,
    ).toBe(false);
    // Госномер без марки первым прицепом считается: графы бланка независимы, и рейс, о прицепе
    // которого известен только номер, описать по-прежнему можно.
    expect(
      routeTripFieldsSchema.safeParse({
        withTrailer: true,
        trailer1RegNumber: 'ВХ933277',
        trailer2Model: 'КРОНА SDP27',
      }).success,
    ).toBe(true);
  });

  /*
   * Подпись прицепов: одна функция на три места, которые её показывают, — карточку рейса и кабинет
   * водителя, журнал путевых листов и задание по листу ЭСМ-2. Предмет теста именно единственность:
   * до неё выражение было переписано трижды и все три копии знали только первый прицеп.
   */
  describe('подпись прицепов', () => {
    it('называет оба прицепа и разделяет их так же, как подпись машины', () => {
      expect(
        trailerLabelOf({
          trailer1Model: 'ШМИТЦ SPR-24',
          trailer1RegNumber: 'ВХ933277',
          trailer2Model: 'КРОНА SDP27',
          trailer2RegNumber: 'ЕН806277',
        }),
      ).toBe('ШМИТЦ SPR-24 ВХ933277 · КРОНА SDP27 ЕН806277');
    });

    it('один прицеп остаётся одной строкой, без разделителя в хвосте', () => {
      expect(trailerLabelOf({ trailer1Model: 'ШМИТЦ SPR-24', trailer1RegNumber: 'ВХ933277' })).toBe(
        'ШМИТЦ SPR-24 ВХ933277',
      );
    });

    it('пропущенная графа не оставляет лишнего пробела', () => {
      expect(trailerLabelOf({ trailer1RegNumber: 'ВХ933277' })).toBe('ВХ933277');
      expect(trailerLabelOf({ trailer1Model: 'ШМИТЦ SPR-24' })).toBe('ШМИТЦ SPR-24');
    });

    it('пустой набор даёт пустую строку, а не разделители', () => {
      expect(trailerLabelOf({})).toBe('');
      expect(
        trailerLabelOf({ trailer1Model: '  ', trailer1RegNumber: null, trailer2Model: undefined }),
      ).toBe('');
    });
  });

  it('порядок присылается полным списком без повторов и не длиннее бланка', () => {
    expect(routeOrderSchema.safeParse({ requestIds: [UUID_A, UUID_B], version: 3 }).success).toBe(
      true,
    );
    expect(routeOrderSchema.safeParse({ requestIds: [UUID_A, UUID_A], version: 3 }).success).toBe(
      false,
    );
    expect(
      routeOrderSchema.safeParse({
        requestIds: [UUID_A, UUID_B, UUID_C, UUID_A, UUID_B],
        version: 3,
      }).success,
    ).toBe(false);
  });

  it('перенос опознаёт исходный маршрут парой «кто + версия»', () => {
    const moved = attachRouteRequestSchema.safeParse({
      requestId: UUID_A,
      version: 2,
      source: { routeId: UUID_B, version: 7 },
    });
    expect(moved.success).toBe(true);
    // Одной версии мало: она нумеруется в каждом маршруте отдельно и совпала бы случайно.
    expect(
      attachRouteRequestSchema.safeParse({ requestId: UUID_A, version: 2, source: { version: 7 } })
        .success,
    ).toBe(false);
  });

  it('заявка едет либо в существующий рейс, либо в новый — но не в оба сразу', () => {
    expect(assignRouteSchema.safeParse({ routeId: UUID_A }).success).toBe(true);
    expect(assignRouteSchema.safeParse({ newRoute: { driverPersonId: UUID_B } }).success).toBe(
      true,
    );
    expect(assignRouteSchema.safeParse({ newRoute: {} }).success).toBe(true);
    expect(
      assignRouteSchema.safeParse({ routeId: UUID_A, newRoute: { driverPersonId: UUID_B } })
        .success,
    ).toBe(false);
    expect(assignRouteSchema.safeParse({}).success).toBe(false);
  });
});

/**
 * Тело перевода заявки в работу (Р3, Р22): рейс приходит вместе с назначением, а прежние поля —
 * водитель и графы бланка — принимаются, пока живо старое тело запроса.
 */
describe('назначение с маршрутом', () => {
  const base = { vehicleId: UUID_A };

  it('принимает существующий рейс и новый', () => {
    expect(assignVehicleSchema.safeParse({ ...base, route: { routeId: UUID_B } }).success).toBe(
      true,
    );
    expect(
      assignVehicleSchema.safeParse({
        ...base,
        route: { newRoute: { driverPersonId: UUID_C, trip: { garageNumber: '00000389' } } },
      }).success,
    ).toBe(true);
  });

  it('старого тела больше нет: водитель и графы бланка описывают рейс, а не назначение', () => {
    // Схема strict: поля, отменённые contract-релизом, теперь отклоняются, а не игнорируются
    // молча — иначе клиент, отставший на версию, думал бы, что назначил водителя.
    const parsed = assignVehicleSchema.safeParse({
      ...base,
      driverPersonId: UUID_C,
      waybill: { withTrailer: false, garageNumber: '00000389' },
    });
    expect(parsed.success).toBe(false);
  });

  it('назначение без рейса проходит схему: рейс обязателен не всегда, и решает это сервер', () => {
    // Аренда и заказ техники на объект рейса не знают вовсе — отказ на уровне схемы отсёк бы их.
    expect(assignVehicleSchema.safeParse(base).success).toBe(true);
  });
});

/**
 * Расхождение дат заявки и её рейса.
 *
 * Правило нужно порталу с обеих сторон: рейс переносят вместе с заявками (там расхождения не
 * возникает вовсе), а заявку правят отдельной формой — и тогда она может уехать на другой день,
 * оставив рейс на прежнем. Запретить это нельзя: заявку и рейс ведут разные люди в разное время.
 * Но и молчать нельзя — лист напечатает задание на день рейса, а работы в этот день уже нет.
 */
describe('расхождение дня заявки и дня рейса', () => {
  const route = { displayNumber: 'Р-12', routeDate: '2026-08-10' };

  it('совпали — говорить не о чем', () => {
    expect(routeDateMismatch({ tripDate: '2026-08-10' }, route)).toBeNull();
    // У линейного дня своего дня нет вовсе: он физически равен дню рейса (составной FK, миграция
    // 0127), и расхождению взяться неоткуда — молчание здесь единственный правдивый ответ.
    expect(routeDateMismatch({ tripDate: null }, route)).toBeNull();
  });

  it('разошлись — обе даты названы, и сказано, чем это грозит бумаге', () => {
    const message = routeDateMismatch({ tripDate: '2026-08-12' }, route);
    expect(message).toContain('2026-08-12');
    expect(message).toContain('Р-12');
    expect(message).toContain('2026-08-10');
  });
});

/**
 * Дата в теле правки рейса. Она появилась вместе с переносом заявок (сервер двигает и подачу
 * состава), поэтому схема обязана её принимать — и по-прежнему требовать версию: перенос меняет
 * чужие записи, и делать это по устаревшему представлению о рейсе нельзя.
 */
describe('правка рейса: дата в теле запроса', () => {
  it('принимает дату рейса вместе с версией', () => {
    const parsed = updateVehicleRouteSchema.safeParse({ routeDate: '2026-08-12', version: 3 });
    expect(parsed.success).toBe(true);
  });

  it('без версии не принимает: перенос идёт под оптимистической блокировкой', () => {
    expect(updateVehicleRouteSchema.safeParse({ routeDate: '2026-08-12' }).success).toBe(false);
  });

  it('дата разбирается только календарная', () => {
    expect(
      updateVehicleRouteSchema.safeParse({ routeDate: '12.08.2026', version: 1 }).success,
    ).toBe(false);
  });

  /*
   * Причина заднего числа (ADR 0101 п. 4 и 6): в схеме необязательна, потому что обязательной её
   * делает не форма тела, а субъект и дата — их знает только `backdateGuard` в обработчике.
   * Требовать причину схемой значило бы спрашивать объяснение за перенос завтрашнего выезда.
   */
  it('причина принимается и не требуется: обязательной её делает дата, а не схема', () => {
    expect(
      updateVehicleRouteSchema.safeParse({
        routeDate: '2026-08-12',
        version: 3,
        reason: 'Рейс состоялся днём раньше',
      }).success,
    ).toBe(true);
    expect(updateVehicleRouteSchema.safeParse({ driverPersonId: null, version: 3 }).success).toBe(
      true,
    );
  });
});

/**
 * Эффективная дата переноса рейса (§4 плана ADR 0101, Р29) — то место, где легче всего ошибиться на
 * день и сдвинуть этим всю границу. Правило считается одной функцией на портал и сервер: разойдись
 * они, форма спрашивала бы причину там, где ручка её не ждёт.
 */
describe('эффективная дата переноса рейса', () => {
  it('день не двигают — заднего числа нет вовсе', () => {
    // Ни поля в теле, ни изменения: правка водителя и реквизитов прошлого рейса свободна
    // (ADR 0101 п. 6) — пока листа нет, рейс планировочная запись.
    expect(movedRouteDateKey('2026-08-10', undefined)).toBeNull();
    expect(movedRouteDateKey('2026-08-10', '2026-08-10')).toBeNull();
  });

  it('берётся более ранняя из двух дат — и вперёд, и назад', () => {
    // Назад: новая дата и есть более ранняя.
    expect(movedRouteDateKey('2026-08-10', '2026-08-05')).toBe('2026-08-05');
    // Вперёд: решает прежний день рейса. Иначе прошлое открывалось бы в два шага — сдвинуть рейс
    // на завтра без права, а оттуда куда угодно, — и подача заявок состава переписалась бы молча.
    expect(movedRouteDateKey('2026-08-05', '2026-08-10')).toBe('2026-08-05');
  });
});

// ── Подсказка заведения рейса: закреплённые прицепы (план `docs/vehicle-trailers-plan.md`, §4.2.2) ──
//
// `GET /vehicle-routes/suggest` отдавал `{ routes, trip }`, где `trip` — графы шапки ПРОШЛОГО рейса
// машины (`lastTripFields`). Закрепление прицепа приезжает **третьим полем** `hitched`, а не
// подмешивается в `trip`, и доказывается здесь не подстановка, а то, что она НЕ ПРОТЕКЛА: у машины
// без закрепления `hitched` пуст, а `trip` возвращается ровно тем же, чем был. Смешай источники — и
// история прицепа поехала бы в окно «Новый маршрут», которое сегодня не подставляет ничего, то есть
// портал начал бы решать за человека там, где вчера молчал (ADR 0083, решение 2).
//
// БАЗЫ ЗДЕСЬ НЕТ, и это не упрощение. Проверяется форма ответа и форма запроса — то и другое живо
// на любой машине, а db-тесты пропускаются без `TEST_DATABASE_URL`, то есть в обычном прогоне
// защиты бы не было вовсе. Приём тот же, что в `office-equipment-sql-correlation.test.ts`:
// `db/client` подменён фальшивым драйвером поверх настоящего drizzle (запрос собирается по-честному
// и записывается), маршрут регистрируется на подставном `FastifyInstance`, обработчик зовётся
// напрямую. Чего файл не проверяет: живую выборку из `vehicle_trailers` — правильность самих
// привязок остаётся за `vehicle-trailers.db.test.ts`.

/**
 * Перехваченные запросы и то, чем на них отвечает драйвер. Через `vi.hoisted`: фабрика `vi.mock`
 * поднимается выше объявлений модуля, и обычная константа к её выполнению ещё не существовала бы.
 */
const probe = vi.hoisted(() => ({
  queries: [] as { text: string; params: unknown[] }[],
  /** Строки прошлого рейса — по одной на машину; пусто означает «рейсов у машины ещё не было». */
  lastTrip: [] as unknown[][],
  /** Закреплённые прицепы: ключ — id машины, строки лежат в том порядке, в каком их вернёт база. */
  hitched: new Map<string, unknown[][]>(),
}));

vi.mock('../src/db/client', async () => {
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const schema = await import('../src/db/schema');
  const result = (rows: unknown[][]) => ({
    rows,
    rowCount: rows.length,
    fields: [],
    command: 'SELECT',
    oid: 0,
  });
  /**
   * Драйвер отвечает по таблице запроса: `vehicle_trailers` — закреплённым, `vehicle_routes` без
   * джойнов — прошлым рейсом (его читает `lastTripFields`), `vehicle_routes` с джойнами — рейсами
   * дня, которых у этих машин нет. Строки массивами: drizzle просит у pg `rowMode: 'array'` и
   * раскладывает значения по полям `select` позиционно — порядок фикстур обязан совпадать с
   * порядком полей в запросе.
   *
   * `casing: 'snake_case'` — тот же, что у настоящего клиента: иначе собрался бы не тот SQL,
   * который уходит в базу, и разбор запроса ниже проверял бы выдумку.
   */
  const client = {
    query: async (q: unknown, params: unknown[] = []) => {
      const text = typeof q === 'string' ? q : String((q as { text?: string }).text ?? q);
      probe.queries.push({ text, params });
      if (text.includes('"vehicle_trailers"')) {
        return result(probe.hitched.get(String(params[0] ?? '')) ?? []);
      }
      if (text.includes('inner join')) return result([]);
      if (text.includes('"vehicle_routes"')) return result(probe.lastTrip);
      return result([]);
    },
    connect: async () => {
      throw new Error('фальшивый драйвер транзакций не открывает: подсказка только читает');
    },
  };
  return {
    db: drizzle(client as never, { schema, casing: 'snake_case' }),
    pool: client,
    pingDb: async () => undefined,
    closeDb: async () => undefined,
  };
});

/** Машина с двумя закреплёнными прицепами и машина без единого — весь предмет проверки. */
const VEHICLE_HITCHED = '44444444-4444-4444-8444-444444444444';
const VEHICLE_BARE = '55555555-5555-4555-8555-555555555555';
const TRAILER_SLOT_1 = '66666666-6666-4666-8666-666666666666';
const TRAILER_SLOT_2 = '77777777-7777-4777-8777-777777777777';

/**
 * Графы шапки прошлого рейса: восемь значений в порядке полей `lastTripFields`. Прицеп в них стоит
 * ВЧЕРАШНИЙ и с закреплением не совпадает — иначе «поле не протекло» доказывалось бы совпадением
 * двух одинаковых строк.
 */
const LAST_TRIP_ROW = [
  true,
  'СЗАП-8551',
  'АВ123477',
  '',
  '',
  'Г-14',
  'городское',
  'коммерческая',
] as unknown[];

/** Строка закреплённого прицепа: порядок значений — порядок полей `hitchedTrailersOf`. */
const trailerRow = (id: string, position: number, model: string, reg: string, status: string) =>
  [id, position, model, reg, status] as unknown[];

type SuggestHandler = (req: unknown) => Promise<{
  routes: unknown[];
  trip: RouteTripFields | null;
  hitched: { id: string; position: number; model: string; registrationNumber: string }[];
}>;

let suggestHandler: SuggestHandler;
let lastTripFieldsOf: (vehicleId: string) => Promise<RouteTripFields | null>;

describe('подсказка заведения рейса: закреплённые прицепы приезжают своим полем', () => {
  beforeAll(async () => {
    /*
     * Конфиг проверяет окружение при импорте, поэтому оно выставляется до первого `await import`.
     * Адрес базы заведомо нерабочий: перестань подмена драйвера действовать — файл упадёт отказом
     * соединения, а не уедет молча в чью-то настоящую базу.
     */
    const { generateKeyPairSync } = await import('node:crypto');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    process.env.JWT_PRIVATE_KEY_PEM ??= String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
    process.env.JWT_PUBLIC_KEY_PEM ??= String(publicKey.export({ type: 'spki', format: 'pem' }));
    process.env.DATABASE_URL ??= 'postgres://suggest:suggest@127.0.0.1:1/none';
    process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
    process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
    process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
    process.env.S3_ENDPOINT ??= 'http://localhost:9000';
    process.env.S3_BUCKET ??= 'test';
    process.env.S3_ACCESS_KEY_ID ??= 'test';
    process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
    process.env.LOG_LEVEL ??= 'error';

    /*
     * Подставной `FastifyInstance`: вместо маршрутизации складывает обработчики в карту. Стражи
     * прав к форме ответа отношения не имеют — обработчик зовётся напрямую, минуя `preHandler`;
     * доступ к подсказке проверяет `access-conditions.test.ts`.
     */
    const handlers = new Map<string, SuggestHandler>();
    const record =
      (method: string) =>
      (url: string, _options: unknown, handler: SuggestHandler): void => {
        handlers.set(`${method} ${url}`, handler);
      };
    const app: Record<string, unknown> = {
      requirePermission: () => async () => undefined,
      authenticate: async () => undefined,
      get: record('GET'),
      post: record('POST'),
      put: record('PUT'),
      patch: record('PATCH'),
      delete: record('DELETE'),
    };
    app.withTypeProvider = () => app;

    const routes = await import('../src/routes/vehicle-routes');
    await routes.default(app as never);
    suggestHandler = handlers.get('GET /suggest')!;
    lastTripFieldsOf = (await import('../src/services/vehicle-routes')).lastTripFields;

    probe.lastTrip = [LAST_TRIP_ROW];
    probe.hitched.set(VEHICLE_HITCHED, [
      trailerRow(TRAILER_SLOT_1, 1, 'ШМИТЦ SPR-24', 'ВХ933277', 'active'),
      trailerRow(TRAILER_SLOT_2, 2, 'МАЗ 975800', 'ВК118577', 'maintenance'),
    ]);
  });

  const suggest = async (vehicleId: string) => {
    probe.queries.length = 0;
    return suggestHandler({ query: { vehicleId, date: '2026-08-26' } });
  };

  it('у машины с закреплением поле полно и стоит по слотам', async () => {
    const res = await suggest(VEHICLE_HITCHED);
    // Каждое поле элемента здесь нужно окну: марка и госномер — это графы бланка, слот говорит, в
    // какую из двух пар их класть, состояние — то, о чём подпись обязана предупредить (§4.2.3).
    expect(res.hitched).toEqual([
      {
        id: TRAILER_SLOT_1,
        position: 1,
        model: 'ШМИТЦ SPR-24',
        registrationNumber: 'ВХ933277',
        status: 'active',
      },
      {
        id: TRAILER_SLOT_2,
        position: 2,
        model: 'МАЗ 975800',
        registrationNumber: 'ВК118577',
        status: 'maintenance',
      },
    ]);
  });

  it('прицеп в ремонте из ответа не выкидывается — о нём предупреждают', async () => {
    // Скрой его здесь — и машина с единственным закреплённым полуприцепом выглядела бы
    // незакреплённой, то есть портал молча вернулся бы к вчерашнему поведению вместо подписи.
    const res = await suggest(VEHICLE_HITCHED);
    expect(res.hitched.map((t) => t.position)).toEqual([1, 2]);
    expect(res.hitched[1]).toMatchObject({ status: 'maintenance' });
  });

  it('порядок слотов задаёт база, а удалённые в выборку не попадают', async () => {
    await suggest(VEHICLE_HITCHED);
    const trailerQueries = probe.queries.filter((q) => q.text.includes('"vehicle_trailers"'));
    // Один запрос, а не по запросу на слот: слотов два, и два круга до базы на каждое открытие
    // окна заведения рейса — цена, за которую ничего не покупается.
    expect(trailerQueries).toHaveLength(1);
    const { text } = trailerQueries[0]!;
    expect(text).toMatch(/order by "vehicle_trailers"\."hitch_position"/);
    expect(text).toMatch(/"vehicle_trailers"\."deleted_at" is null/);
  });

  it('у машины без закрепления поле пусто, а графы прошлого рейса — прежние', async () => {
    const res = await suggest(VEHICLE_BARE);
    // Главная проверка этапа. Пусто — это не «данных нет», а полноценный ответ: новой подстановки
    // у такой машины не бывает, и окно обязано вести себя ровно как вчера.
    expect(res.hitched).toEqual([]);
    // `trip` — прежний, вчерашний, со своим прицепом: подстановка в него не подмешалась ни на байт.
    expect(res.trip).toMatchObject({
      withTrailer: true,
      trailer1Model: 'СЗАП-8551',
      trailer1RegNumber: 'АВ123477',
      garageNumber: 'Г-14',
      communicationKind: 'городское',
      transportationKind: 'коммерческая',
    });
    // И то же самое — сравнением с источником: ответ отдаёт ровно то, что вернула `lastTripFields`,
    // а не пересобранную из чего-то ещё копию.
    expect(res.trip).toEqual(await lastTripFieldsOf(VEHICLE_BARE));
  });

  it('закрепление не переписывает графы прошлого рейса и у машины с прицепом', async () => {
    // Два поля отвечают на разные вопросы и живут рядом: `trip` — история, `hitched` — сегодняшнее
    // закрепление. Кто из них попадёт в графы, решает окно, а не сервер.
    const res = await suggest(VEHICLE_HITCHED);
    expect(res.trip).toEqual(await lastTripFieldsOf(VEHICLE_HITCHED));
    expect(res.trip).toMatchObject({ trailer1RegNumber: 'АВ123477' });
  });

  it('ответ несёт ровно три поля — форма `VehicleRouteSuggestDto`', async () => {
    const res = await suggest(VEHICLE_BARE);
    expect(Object.keys(res).sort()).toEqual(['hitched', 'routes', 'trip']);
    expect(res.routes).toEqual([]);
  });
});

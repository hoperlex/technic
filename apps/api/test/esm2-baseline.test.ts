import { describe, expect, it } from 'vitest';
import {
  esm2Mode,
  esm2Periods,
  esm2SyncPlan,
  moscowDateKeyOf,
  shiftDateKey,
  type VehicleOwnership,
  weekStartKey,
} from '@technic/contracts';

/*
 * ЭСМ2-РАЗРЕЗ. Файл — **характеристический**: он нарочно фиксирует поведение сегодняшней недельной
 * сверки, чтобы подмена на отрезковый разрез не прошла незаметно. Обёртка двух режимов ему не
 * применима технически (юнит-тест, базы нет) и не нужна по смыслу: предмет файла — старый алгоритм,
 * а не выбор между старым и новым.
 *
 * Что с ним будет на этапе 5: `esm2SyncPlan` и `esm2Mode` получают обязательный `syncScope`, а
 * `wanted` приходит из `esm2SheetPlan` — файл упадёт на типах, и это **правильное** падение: оно и
 * означает, что подмена состоялась. Блок `esm2Periods` переживёт замену как есть — резак границы
 * недели остаётся и в новом движке, потому что бланк по-прежнему не перешагивает неделю.
 */

/**
 * Характеристические тесты недельной сверки ЭСМ-2 — снимок сегодняшнего поведения перед
 * переходом на отрезки (`docs/assignment-periods-plan.md`, этап 1, волна 1.3, задание Б).
 *
 * Зачем файл. На этапе 3 недельный разрез заменяется разрезом по отрезкам назначения (Р5: `kept`
 * считается по паре границ и машине, `locked` — по занятым дням, а не по календарной неделе;
 * граница прошедшего — по концу отрезка), и меняют при этом ровно четыре вещи: `esm2Mode`,
 * `esm2Periods`, `esm2SyncPlan` и сборку их входа `buildEsm2SyncPlan`. Подмена недели отрезком
 * тихо переставит границы там, где никто не смотрит, а замечает такое не тест, а человек, взявший
 * бумагу в руки, — и обычно через неделю: лишний `issue` это сгоревший бланк строгой отчётности,
 * лишний `cancel` — сгоревший дважды, пропущенный отрезок — дни работы без документа.
 *
 * Как читать падение. Каждый тест описывает систему **такой, какая она есть сегодня**, включая
 * то, что выглядит странно; странности помечены словом «странность» в комментарии. Уронив такой
 * тест на этапе 3, спрашивайте не «чей это баг», а «названо ли новое поведение в плане»:
 *
 * - тест без пометки «странность» упал — скорее всего сломали то, что ломать не собирались;
 * - тест с пометкой упал — скорее всего это и есть предмет правки: обновите ожидание и допишите в
 *   комментарий, каким правилом плана оно теперь объясняется.
 *
 * Чего здесь нет намеренно. Основы этих же функций уже закреплены в `waybill-contracts.test.ts`
 * (разрез срока, матрица `esm2Mode`, «сошлось — не трогаем», смена машины и машиниста, подрезка
 * `on_demand`, коррекция с двумя ключами). Дублировать их незачем — здесь только края, которых там
 * нет, и та проводка, которой без базы не было вовсе (`buildEsm2SyncPlan`).
 *
 * Чего покрыть не удалось. `syncEsm2Waybills`, `issueEsm2OnDemand` и `activeSheets` пишут в базу
 * или закрыты модулем, и их поведение проверяется db-тестами (`esm2-correction.db.test.ts`,
 * `linear-esm2-on-demand.db.test.ts`, `weekly-request-apply.db.test.ts`). Не покрыт и один
 * настоящий край `esm2Periods`: дата, которую не разбирает `Date.parse` («не дата»), уводит его
 * цикл в бесконечный — `weekStartKey` и `shiftDateKey` возвращают такой ключ как есть, и `from`
 * перестаёт расти. Тестом это не запишешь — прогон повиснет, — а сегодня случай теоретический:
 * даты приходят из колонок `date`. При переходе на отрезки, где границы считаются кодом, а не
 * читаются из строки, край стоит помнить.
 */

// ── Календарь тестов ────────────────────────────────────────────────────────────────────────
//
// Август 2026 удобен тем, что месяц начинается близко к понедельнику: 03.08 — пн, 09.08 — вс,
// 10.08 — пн, 16.08 — вс. Даты пишутся в тестах прямо, а не считаются: посчитанная дата в
// характеристическом тесте повторяет ошибку кода, который проверяет.
const MON = '2026-08-03';
const WED = '2026-08-05';
const SUN = '2026-08-09';
const NEXT_MON = '2026-08-10';
const NEXT_WED = '2026-08-12';
const NEXT_SUN = '2026-08-16';

describe('ЭСМ-2, срез срока на недели (`esm2Periods`)', () => {
  it('срок ровно в одну календарную неделю — один лист на всю неделю', () => {
    // Пн…вс укладывается в бланк целиком: семь строк «пн…вс» впечатаны, и резать тут нечего.
    expect(esm2Periods(MON, SUN)).toEqual([{ from: MON, to: SUN }]);
  });

  it('начало и конец срока в середине недели — крайние листы подрезаны, средние целые', () => {
    // Ср 05.08 — ср 12.08: первый лист обрывается воскресеньем, второй начинается понедельником.
    // Граница листа — календарная, а не «семь дней от начала работ»: единица бумаги это неделя.
    expect(esm2Periods(WED, NEXT_WED)).toEqual([
      { from: WED, to: SUN },
      { from: NEXT_MON, to: NEXT_WED },
    ]);
  });

  it('однодневный срок в воскресенье — лист на один день, а не на неделю', () => {
    // Воскресенье — последний день своей недели, поэтому подрезка совпадает с самим сроком.
    expect(esm2Periods(SUN, SUN)).toEqual([{ from: SUN, to: SUN }]);
  });

  it('срок с воскресенья — первый бланк уходит на один день', () => {
    // Странность (как есть): срок вс…ср даёт два листа — «вс…вс» и «пн…ср», — то есть два номера
    // на четыре дня работы. Так работает разрез по календарю: неделя, а не длина срока.
    expect(esm2Periods(SUN, NEXT_WED)).toEqual([
      { from: SUN, to: SUN },
      { from: NEXT_MON, to: NEXT_WED },
    ]);
  });

  it('неделя через Новый год не дробится — год в бланке не единица счёта', () => {
    // Пн 28.12.2026 — вс 03.01.2027: один документ на обе половины. Дробится лист только сроком,
    // и границы года среди его границ нет, как нет и границы месяца.
    expect(esm2Periods('2026-12-28', '2027-01-03')).toEqual([
      { from: '2026-12-28', to: '2027-01-03' },
    ]);
    // А срок, начатый в середине недели перед Новым годом, режется своим обычным правилом.
    expect(esm2Periods('2026-12-30', '2027-01-06')).toEqual([
      { from: '2026-12-30', to: '2027-01-03' },
      { from: '2027-01-04', to: '2027-01-06' },
    ]);
  });

  it('пустое начало срока листов не даёт: считать неделю не от чего', () => {
    expect(esm2Periods('', NEXT_WED)).toEqual([]);
    expect(esm2Periods('', null)).toEqual([]);
  });

  it('пустая строка в дате окончания читается как однодневный срок — наравне с `null`', () => {
    // Странность (как есть): `dateTo` проверяется на истинность (`dateTo || dateFrom`), а не на
    // `null`. Пустая строка и «даты нет» для разреза неразличимы. Из базы приходит `null`, так
    // что сегодня разницы не видно, — но правило именно такое.
    expect(esm2Periods(WED, '')).toEqual([{ from: WED, to: WED }]);
    expect(esm2Periods(WED, null)).toEqual([{ from: WED, to: WED }]);
  });

  it('месячный срок — пять листов: по одному на каждый понедельник внутри него и на его начало', () => {
    expect(esm2Periods(WED, '2026-09-03')).toEqual([
      { from: '2026-08-05', to: '2026-08-09' },
      { from: '2026-08-10', to: '2026-08-16' },
      { from: '2026-08-17', to: '2026-08-23' },
      { from: '2026-08-24', to: '2026-08-30' },
      { from: '2026-08-31', to: '2026-09-03' },
    ]);
  });

  it('листы идут встык, не пересекаются и каждый лежит внутри одной календарной недели', () => {
    // Тот самый инвариант, который этап 3 и отменяет: сегодня «неделя» — единица планирования, и
    // ни один лист не выходит за её границы. Проверяется свойством, а не перечнем дат: список дат
    // уронит и безобидная правка календаря, а свойство переживёт её и упадёт ровно на разрезе.
    const periods = esm2Periods(WED, '2026-10-14');
    expect(periods.length).toBeGreaterThan(5);
    periods.forEach((period, i) => {
      expect(period.from <= period.to).toBe(true);
      expect(weekStartKey(period.from)).toBe(weekStartKey(period.to));
      const previous = periods[i - 1];
      if (previous) expect(period.from).toBe(shiftDateKey(previous.to, 1));
    });
    expect(periods.at(0)?.from).toBe(WED);
    expect(periods.at(-1)?.to).toBe('2026-10-14');
  });
});

describe('ЭСМ-2, кому портал ведёт листы (`esm2Mode`)', () => {
  const base = {
    requestType: 'special_equipment' as const,
    status: 'confirmed' as const,
    isLinear: false,
  };

  it('режим решает принадлежность машины, и «машины нет» — тоже принадлежность', () => {
    // Странность (как есть): у заявки в работе, но без назначения, `ownership` приходит `null`
    // (левый join к назначению), и режим у неё `none` — тот же, что у аренды. То есть «технику
    // ещё не подобрали» портал сегодня не отличает от «бумагу ведёт арендодатель»: и там и там
    // листов заявке не положено, а уже выписанные — под аннулирование (см. `buildEsm2SyncPlan`).
    // Ровно эту неразличимость снимает Р19 плана.
    const modes: [VehicleOwnership | null, boolean, string][] = [
      ['own', false, 'auto'],
      ['own', true, 'on_demand'],
      ['rental', false, 'none'],
      ['rental', true, 'none'],
      [null, false, 'none'],
      [null, true, 'none'],
    ];
    for (const [ownership, isLinear, expected] of modes) {
      expect(esm2Mode({ ...base, ownership, isLinear })).toBe(expected);
    }
  });

  it('архив проверяется на истинность строки, а не на `null`', () => {
    // Странность (как есть): пустая строка в `deletedAt` — «не архив». Из базы приходит либо
    // `null`, либо ISO-время, так что случай теоретический, — но правило именно такое.
    expect(esm2Mode({ ...base, ownership: 'own', deletedAt: '' })).toBe('auto');
    expect(esm2Mode({ ...base, ownership: 'own', deletedAt: '2026-08-01T00:00:00Z' })).toBe('none');
  });
});

describe('ЭСМ-2, сверка бумаги с заявкой (`esm2SyncPlan`)', () => {
  const VEHICLE = 'vehicle-1';
  const DRIVER = 'driver-1';
  const sheet = (
    id: string,
    from: string,
    to: string,
    over: Partial<{ vehicleId: string; driverPersonId: string }> = {},
  ) => ({
    id,
    periodFrom: from,
    periodTo: to,
    vehicleId: VEHICLE,
    driverPersonId: DRIVER,
    ...over,
  });

  /** Обычный заказ, «сегодня» до начала срока: прошлое в этих проверках не участвует. */
  const auto = (over: Partial<Parameters<typeof esm2SyncPlan>[0]>) =>
    esm2SyncPlan({
      mode: 'auto',
      wanted: [],
      existing: [],
      vehicleId: VEHICLE,
      driverPersonId: DRIVER,
      today: '2026-08-01',
      ...over,
    });

  it('подрезанный лист сходится так же, как полный: сверка сравнивает границы, а не полноту недели', () => {
    // Лист «пн…ср» после досрочного завершения — законный документ, а не половина документа.
    // Совпали обе границы, машина и человек — план молчит, и ни один номер не горит.
    const plan = auto({
      wanted: [{ from: NEXT_MON, to: NEXT_WED }],
      existing: [sheet('a', NEXT_MON, NEXT_WED)],
    });
    expect(plan).toEqual({ cancel: [], issue: [] });
  });

  it('сдвиг любой границы внутри недели жжёт номер: правке выданный бланк не подлежит', () => {
    // Продление срока внутри той же недели (лист «пн…ср», срок дотянули до вс).
    expect(
      auto({
        wanted: [{ from: NEXT_MON, to: NEXT_SUN }],
        existing: [sheet('a', NEXT_MON, NEXT_WED)],
      }),
    ).toEqual({ cancel: ['a'], issue: [{ from: NEXT_MON, to: NEXT_SUN }] });
    // И сокращение того же листа — тем же порядком: в графе «Период работы» напечатаны прежние
    // даты, и «продлить» бланк нечем, кроме нового номера.
    expect(
      auto({
        wanted: [{ from: NEXT_MON, to: NEXT_WED }],
        existing: [sheet('a', NEXT_MON, NEXT_SUN)],
      }),
    ).toEqual({ cancel: ['a'], issue: [{ from: NEXT_MON, to: NEXT_WED }] });
  });

  it('машину сняли с заявки — бумага горит вся, а замена выписывается «ни на что»', () => {
    // Странность (как есть): `vehicleId: null` считается сменой машины — лист не сходится ни с
    // чем, — и при этом недели остаются в `issue`. Сама сверка эту пару не считает
    // противоречивой: остановить её обязан вызывающий, и `syncEsm2Waybills` действительно
    // отвечает 422 «На заявке нет техники — путевой лист выписывать не на что», уже после того,
    // как план посчитан. То есть номер не сгорает только потому, что падает вся транзакция.
    const plan = auto({
      wanted: [{ from: MON, to: SUN }],
      existing: [sheet('a', MON, SUN)],
      vehicleId: null,
    });
    expect(plan).toEqual({ cancel: ['a'], issue: [{ from: MON, to: SUN }] });
  });

  it('отработанный лист не горит и закрывает свою календарную неделю целиком', () => {
    // Странность (как есть, и ровно её отменяет Р5): «отработанность» и защита считаются
    // неделями, а не днями. Лист прошедшей недели выписан на другую машину — расхождение налицо,
    // — но он не аннулируется (`canCancelWaybill`), а его понедельник попадает в `locked`, и на
    // эту неделю не выписывается уже ничего, даже другой её отрезок. План молчит, и разошедшаяся
    // бумага остаётся разошедшейся навсегда: снять это можно только коррекцией (`unlockWaybillIds`
    // плюс `correction`).
    const plan = auto({
      today: '2026-08-20',
      wanted: [{ from: MON, to: WED }],
      existing: [sheet('a', MON, SUN, { vehicleId: 'vehicle-2' })],
    });
    expect(plan).toEqual({ cancel: [], issue: [] });
  });

  it('граница отработанности — последний день листа, и день этот ещё «сегодня»', () => {
    // Расхождение по машинисту в неделю пн…вс; разными остаются только «сегодня».
    const stale = {
      wanted: [{ from: MON, to: SUN }],
      existing: [sheet('a', MON, SUN, { driverPersonId: 'driver-2' })],
    };
    // Воскресенье ещё не прошло — лист переоформляется как обычный: `canCancelWaybill` сравнивает
    // «сегодня» с последним днём периода нестрого.
    expect(auto({ ...stale, today: SUN })).toEqual({
      cancel: ['a'],
      issue: [{ from: MON, to: SUN }],
    });
    // Понедельник следующей недели — неделя отстояна, и бумага неприкосновенна.
    expect(auto({ ...stale, today: NEXT_MON })).toEqual({ cancel: [], issue: [] });
  });

  it('срок, сокращённый внутрь прошлого, жжёт номер и замены не выписывает', () => {
    // Странность (как есть), и найдена она этим же тестом. Заказ закрывают в воскресенье задним
    // числом — по среду. Лист недели пн…вс аннулировать ещё можно (его последний день — сегодня),
    // и он уходит в `cancel`. А замену «пн…ср» выписать уже нельзя: у выписки своя граница —
    // `p.to >= today`, — и она считается по концу **нового** отрезка, который в прошлом.
    // Получается сгоревший номер и три отработанных дня без документа; закрыть их можно только
    // коррекцией (`correction`), то есть с правом и причиной. Двух границ здесь именно две, и
    // сходятся они в один день ровно тогда, когда срок правят последним днём недели.
    const plan = auto({
      today: SUN,
      wanted: [{ from: MON, to: WED }],
      existing: [sheet('a', MON, SUN)],
    });
    expect(plan).toEqual({ cancel: ['a'], issue: [] });
    // С проверенной операцией коррекции та же правка доводится до конца.
    expect(
      auto({
        today: SUN,
        wanted: [{ from: MON, to: WED }],
        existing: [sheet('a', MON, SUN)],
        correction: { allowed: true },
      }),
    ).toEqual({ cancel: ['a'], issue: [{ from: MON, to: WED }] });
  });

  it('два листа в одной неделе: отработанный закрывает неделю, а соседний горит без замены', () => {
    // Странность (как есть): у заявки два отрезка одной недели — «пн…ср» отработан, «чт…вс»
    // выписан на машину, которую с тех пор сменили. Первый защищён и запирает весь понедельник,
    // второй защиты не имеет и уходит в `cancel`. Замены ему не будет: неделя в `locked`.
    // Результат — сгоревший номер и четверг…воскресенье без документа, причём молча.
    const plan = auto({
      today: '2026-08-06',
      wanted: [
        { from: MON, to: WED },
        { from: '2026-08-06', to: SUN },
      ],
      existing: [
        sheet('worked', MON, WED),
        sheet('stale', '2026-08-06', SUN, { vehicleId: 'vehicle-2' }),
      ],
    });
    expect(plan).toEqual({ cancel: ['stale'], issue: [] });
  });

  it('пустоту набора для режима `none` обеспечивает вызывающий, а не сама сверка', () => {
    // Странность (как есть): у `esm2SyncPlan` нет ветки «режим `none` — не выписывать». Запрет
    // заводить новые недели написан только для `on_demand`; `none` держится на том, что
    // `buildEsm2SyncPlan` отдаёт ему пустой `wanted`. Ошибись вызывающий набором — портал выпишет
    // бумагу заявке, которой листов не положено вовсе.
    const plan = esm2SyncPlan({
      mode: 'none',
      wanted: [{ from: MON, to: SUN }],
      existing: [],
      vehicleId: VEHICLE,
      driverPersonId: DRIVER,
      today: '2026-08-01',
    });
    expect(plan).toEqual({ cancel: [], issue: [{ from: MON, to: SUN }] });
  });

  it('дубль в наборе даёт два бланка на одни и те же дни: набору сверка верит', () => {
    // Странность (как есть): `issue` — это отфильтрованный `wanted`, без склейки и без проверки
    // на повтор. Сегодня повтор невозможен (`esm2Periods` режет срок встык, `esm2RequestedPeriods`
    // складывает недели в `Map` по границам), поэтому и защиты нет. На отрезках повтор границ
    // перестаёт быть невозможным — эту проверку стоит перечитать первой.
    const plan = auto({
      wanted: [
        { from: MON, to: SUN },
        { from: MON, to: SUN },
      ],
    });
    expect(plan.issue).toEqual([
      { from: MON, to: SUN },
      { from: MON, to: SUN },
    ]);
  });

  it('порядок ответа: `cancel` — порядком листов, `issue` — порядком набора', () => {
    // Порядок не косметика: вход и план целиком уходят в отпечаток предпросмотра последствий
    // (§5.4), и два расчёта одного состояния обязаны давать посимвольно одно и то же.
    const plan = auto({
      wanted: [
        { from: MON, to: SUN },
        { from: NEXT_MON, to: NEXT_SUN },
      ],
      existing: [
        sheet('second', NEXT_MON, NEXT_SUN, { driverPersonId: 'driver-2' }),
        sheet('first', MON, SUN, { driverPersonId: 'driver-2' }),
      ],
    });
    expect(plan.cancel).toEqual(['second', 'first']);
    expect(plan.issue).toEqual([
      { from: MON, to: SUN },
      { from: NEXT_MON, to: NEXT_SUN },
    ]);
  });
});

// ── Сборка входа сверки (`buildEsm2SyncPlan`) ──────────────────────────────────────────────
//
// Функция читающая, а не чистая: режим, набор недель, машина и машинист собираются тремя
// запросами (заявка, действующие листы, машинист последнего листа). Базы для этого не нужно —
// нужен читатель, отвечающий заранее заданными строками, и он же считает, **какие запросы вообще
// были заданы**. Второе не менее важно первого: «заявке без листов машиниста не ищут» — такое же
// сегодняшнее поведение, как и любое значение в ответе.
//
// Конфигурация читается при импорте модуля и без окружения падает, поэтому переменные ставятся до
// динамического импорта — тем же приёмом, что и в db-тестах. Подключения при этом не открывается:
// пул `pg` соединяется лениво, а ни одного настоящего запроса здесь не выполняется.
process.env.DATABASE_URL ??= 'postgres://technic:technic@127.0.0.1:5433/esm2-baseline-not-used';
process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
process.env.JWT_PUBLIC_KEY_PEM ??= '-----BEGIN PUBLIC KEY-----\nZmFrZQ==\n-----END PUBLIC KEY-----';
process.env.S3_ENDPOINT ??= 'http://localhost:9000';
process.env.S3_BUCKET ??= 'test';
process.env.S3_ACCESS_KEY_ID ??= 'test';
process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
process.env.LOG_LEVEL ??= 'error';

const { buildEsm2SyncPlan } = await import('../src/services/waybill-esm2');

/** Какой из трёх запросов сборки задан — по нему тест и проверяет, что читалось, а что нет. */
type Query = 'request' | 'sheets' | 'machinist';

interface RequestRow {
  requestType: 'special_equipment' | 'freight_transport';
  status: 'new' | 'confirmed' | 'done' | 'cancelled';
  deletedAt: Date | null;
  dateFrom: string | null;
  dateTo: string | null;
  vehicleId: string | null;
  ownership: VehicleOwnership | null;
  isLinear: boolean;
}

interface SheetRow {
  id: string;
  periodFrom: string;
  periodTo: string;
  vehicleId: string;
  driverPersonId: string;
  /** Печатный номер листа: сборке он не нужен, и проверка ниже это подтверждает. */
  number: number;
  prefix: string;
  numberWidth: number;
}

/**
 * Звено цепочки drizzle: любой метод (`from`, `innerJoin`, `where`, `orderBy`, `limit`) возвращает
 * такое же звено, а `await` отдаёт заранее заданные строки. Ровно столько, сколько нужно сборке.
 */
function chain(rows: readonly unknown[]): unknown {
  const step: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject);
      }
      return () => new Proxy({}, step);
    },
  };
  return new Proxy({}, step);
}

/**
 * Читатель на заранее заданных строках.
 *
 * Запросы различаются по набору запрошенных полей — это единственный признак, доступный снаружи.
 * Незнакомый набор не подставляет пустоту молча, а падает с текстом: набор запросов сборки это
 * тоже её сегодняшнее поведение, и появление четвёртого чтения обязано уронить проверку, а не
 * тихо прийти в неё нулём.
 */
function fakeReader(
  state: { request: RequestRow | null; sheets: SheetRow[]; lastMachinist: string | null },
  log: Query[],
) {
  return {
    select(fields: Record<string, unknown>) {
      const keys = Object.keys(fields);
      if (keys.includes('requestType')) {
        log.push('request');
        return chain(
          state.request
            ? [
                {
                  id: 'request-1',
                  objectId: 'object-1',
                  vehicleTypeName: 'Экскаватор',
                  ...state.request,
                },
              ]
            : [],
        );
      }
      if (keys.includes('periodFrom')) {
        log.push('sheets');
        return chain(state.sheets);
      }
      if (keys.length === 1 && keys[0] === 'driverPersonId') {
        log.push('machinist');
        return chain(state.lastMachinist ? [{ driverPersonId: state.lastMachinist }] : []);
      }
      throw new Error(`Незнакомый запрос сборки плана ЭСМ-2: ${keys.join(', ')}`);
    },
  } as unknown as Parameters<typeof buildEsm2SyncPlan>[0];
}

describe('ЭСМ-2, сборка входа сверки (`buildEsm2SyncPlan`)', () => {
  const VEHICLE = 'vehicle-1';
  const DRIVER = 'driver-1';
  const confirmed: RequestRow = {
    requestType: 'special_equipment',
    status: 'confirmed',
    deletedAt: null,
    dateFrom: WED,
    dateTo: '2026-08-26',
    vehicleId: VEHICLE,
    ownership: 'own',
    isLinear: false,
  };
  const sheetRow = (
    id: string,
    from: string,
    to: string,
    over: Partial<SheetRow> = {},
  ): SheetRow => ({
    id,
    periodFrom: from,
    periodTo: to,
    vehicleId: VEHICLE,
    driverPersonId: DRIVER,
    number: 4897,
    prefix: '260604-646-',
    numberWidth: 11,
    ...over,
  });

  async function build(
    state: Partial<{
      request: RequestRow | null;
      sheets: SheetRow[];
      lastMachinist: string | null;
    }>,
    params: Partial<Parameters<typeof buildEsm2SyncPlan>[1]> = {},
  ) {
    const log: Query[] = [];
    const reader = fakeReader(
      { request: confirmed, sheets: [], lastMachinist: null, ...state },
      log,
    );
    const built = await buildEsm2SyncPlan(reader, {
      requestId: 'request-1',
      asOf: '2026-08-01',
      ...params,
    });
    return { built, log };
  }

  it('заявки нет — плана нет, и дальше читателя не спрашивают', async () => {
    // `null` вместо плана — не ошибка: сверку зовут пять мест, и заявка могла уехать в архив
    // между чтением и вызовом. Ни листов, ни машиниста при этом не читается: спрашивать не о чем.
    const { built, log } = await build({ request: null });
    expect(built).toBeNull();
    expect(log).toEqual(['request']);
  });

  it('обычный заказ на несколько недель — набор считается сроком, и лист выписывается на каждую', async () => {
    // Три недели срока ср 05.08 — ср 26.08 при пустой бумаге: портал сам решает, сколько её нужно.
    const { built } = await build({});
    expect(built?.input.mode).toBe('auto');
    expect(built?.input.wanted).toEqual([
      { from: WED, to: SUN },
      { from: NEXT_MON, to: NEXT_SUN },
      { from: '2026-08-17', to: '2026-08-23' },
      { from: '2026-08-24', to: '2026-08-26' },
    ]);
    expect(built?.plan.cancel).toEqual([]);
    expect(built?.plan.issue).toEqual(built?.input.wanted);
  });

  it('машинист наследуется с последнего листа, когда его не назвали этим действием', async () => {
    // Меняли срок или машину, а не человека: в бланке замены печатается тот же машинист.
    // Читается он отдельным запросом и берётся в том числе с аннулированного листа.
    const { built, log } = await build({
      sheets: [sheetRow('a', WED, SUN)],
      lastMachinist: 'driver-last',
    });
    expect(built?.input.driverPersonId).toBe('driver-last');
    expect(log).toEqual(['request', 'sheets', 'machinist']);
    // В план уходят пять полей листа, а не вся строка: печатный номер сверке не нужен и в
    // отпечаток предпросмотра не идёт.
    expect(built?.input.existing).toEqual([
      { id: 'a', periodFrom: WED, periodTo: SUN, vehicleId: VEHICLE, driverPersonId: DRIVER },
    ]);
  });

  it('названный машинист старше унаследованного — за прежним читателя не спрашивают', async () => {
    const { built, log } = await build(
      { sheets: [sheetRow('a', WED, SUN)], lastMachinist: 'driver-last' },
      { driverPersonId: 'driver-2' },
    );
    expect(built?.input.driverPersonId).toBe('driver-2');
    expect(log).toEqual(['request', 'sheets']);
  });

  it('линейный заказ: набор — только уже выписанные недели, а машинист не наследуется вовсе', async () => {
    // ADR 0100 §5–6: недели называет человек, и «машиниста заявки» у линейного заказа нет —
    // сверка получает `null` и оставляет каждой неделе своего. Запроса за прежним человеком не
    // делается, даже когда листы есть.
    const { built, log } = await build({
      request: { ...confirmed, isLinear: true },
      sheets: [sheetRow('a', NEXT_MON, NEXT_SUN)],
      lastMachinist: 'driver-last',
    });
    expect(built?.input.mode).toBe('on_demand');
    expect(built?.input.driverPersonId).toBeNull();
    expect(built?.input.wanted).toEqual([{ from: NEXT_MON, to: NEXT_SUN }]);
    expect(built?.plan).toEqual({ cancel: [], issue: [] });
    expect(log).toEqual(['request', 'sheets']);
  });

  it('заявке без режима и без листов машиниста не ищут: чтение стоит запроса на каждую правку', async () => {
    // Самый частый случай портала — грузоперевозка: листов ей не положено, и их у неё нет.
    const { built, log } = await build({
      request: { ...confirmed, requestType: 'freight_transport' },
    });
    expect(built?.input.mode).toBe('none');
    expect(built?.input.wanted).toEqual([]);
    expect(built?.input.driverPersonId).toBeNull();
    expect(log).toEqual(['request', 'sheets']);
  });

  it('заявке без режима, но с листами, машиниста всё-таки читают — а вся её бумага горит', async () => {
    // Странность (как есть): человек нужен только выписке, а выписывать здесь нечего — набор
    // пуст, и план состоит из одних аннулирований. Условие пропуска написано как «режим `none`
    // **и** листов нет», поэтому лишний запрос случается ровно там, где заявку выводят из работы.
    const { built, log } = await build({
      request: { ...confirmed, status: 'cancelled' },
      sheets: [sheetRow('a', WED, SUN), sheetRow('b', NEXT_MON, NEXT_SUN)],
      lastMachinist: 'driver-last',
    });
    expect(built?.input.mode).toBe('none');
    expect(built?.input.driverPersonId).toBe('driver-last');
    expect(built?.plan).toEqual({ cancel: ['a', 'b'], issue: [] });
    expect(log).toEqual(['request', 'sheets', 'machinist']);
  });

  it('принадлежность из параметра перебивает нынешнюю: режим решает назначаемая машина', async () => {
    // Заказ вели арендной единицей, а продолжают своей — бумагу он заводит тем же действием,
    // которым машину назначают, а не следующим.
    const { built } = await build(
      { request: { ...confirmed, ownership: 'rental', dateFrom: NEXT_MON, dateTo: NEXT_SUN } },
      { ownership: 'own' },
    );
    expect(built?.input.mode).toBe('auto');
    expect(built?.plan.issue).toEqual([{ from: NEXT_MON, to: NEXT_SUN }]);
  });

  it('срок не заполнен — набор пуст, хотя режим у заявки есть', async () => {
    // Считать неделю не от чего. Листов при этом не аннулируется: их и нет.
    const { built } = await build({ request: { ...confirmed, dateFrom: null, dateTo: null } });
    expect(built?.input.mode).toBe('auto');
    expect(built?.input.wanted).toEqual([]);
    expect(built?.plan).toEqual({ cancel: [], issue: [] });
  });

  it('оба ключа коррекции доезжают до сверки вместе, а без операции остаются пустыми', async () => {
    // Р11: разблокировав лист, но не разрешив прошедшую неделю, сверка сожгла бы номер и не
    // выписала замены. Поэтому ключи и кладутся в один вход одним условием.
    const withCorrection = await build(
      {
        request: { ...confirmed, dateFrom: MON, dateTo: SUN },
        sheets: [sheetRow('a', MON, SUN, { vehicleId: 'vehicle-2' })],
        lastMachinist: DRIVER,
      },
      { asOf: '2026-08-20', correction: { id: 'correction-1', unlockWaybillIds: ['a'] } },
    );
    expect(withCorrection.built?.input.unlockWaybillIds).toEqual(['a']);
    expect(withCorrection.built?.input.correction).toEqual({ allowed: true });
    expect(withCorrection.built?.plan).toEqual({
      cancel: ['a'],
      issue: [{ from: MON, to: SUN }],
    });

    const plain = await build(
      {
        request: { ...confirmed, dateFrom: MON, dateTo: SUN },
        sheets: [sheetRow('a', MON, SUN, { vehicleId: 'vehicle-2' })],
        lastMachinist: DRIVER,
      },
      { asOf: '2026-08-20' },
    );
    expect(plain.built?.input.unlockWaybillIds).toBeUndefined();
    expect(plain.built?.input.correction).toBeUndefined();
    // Та же прошедшая неделя без операции: лист неприкосновенен, замены нет, план молчит.
    expect(plain.built?.plan).toEqual({ cancel: [], issue: [] });
  });

  it('без явной даты расчёта днём сверки становится сегодня по МСК', async () => {
    // Р12: дату захватывает вызывающий один раз на транзакцию, а умолчание — московский день, а
    // не UTC: полночь между отпечатком и сверкой отдала бы другой план.
    const { built } = await build({}, { asOf: undefined });
    expect(built?.input.today).toBe(moscowDateKeyOf(new Date()));
  });
});

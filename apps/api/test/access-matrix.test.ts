import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ACCESS_PROFILES, ROLE_ADDON_PERMISSIONS, type AccessSubject } from '@technic/contracts';

/**
 * Сквозная проверка прав: настоящие запросы к собранному приложению под каждым субъектом
 * доступа — ролью, у внешнего исполнителя парой «роль + тип контрагента» (ADR 0038), у учётки с
 * надстройкой парой «роль + надстройка» (ADR 0086).
 *
 * Матрица (`permissions.test.ts`) отвечает на вопрос «что субъект может», страж
 * (`route-authorization.test.ts`) — «объявлена ли проверка». Здесь проверяется третье:
 * что маршрут отдаёт 403 именно тем, кому должен, — то есть что к маршруту привязано
 * правильное право, а не просто какое-нибудь.
 *
 * Перебор по **условию** (`access-conditions.test.ts`, план §14) отвечает на четвёртый вопрос:
 * обязательно ли каждое право объявленного условия. Он ходит по всем маршрутам манифеста синтетическим
 * субъектом («роль без нужных прав плюс ровно эти права») и потому видит то, чего профилями не
 * увидеть: у конъюнкции — каждый её член по отдельности, у условного права — сценарий с полем и без.
 * Этот файл ему не дублирует и остаётся: перечни здесь — вторая, независимая от манифеста запись
 * ожидания, написанная должностями, и перепутанное на маршруте право видно именно в ней. Плюс здесь
 * живёт то, чего в манифесте нет по построению: коридоры сторон, маршруты «по самой записи» и
 * полнота самих субъектов (проверки под перечнем кейсов).
 *
 * До обработчиков дело не доходит: у запрещённых ролей отказ приходит из preHandler, а
 * разрешённым мы проверяем только «не 403» — БД подменена заглушкой, любой запрос в неё
 * падает и превращается в 500, чего для проверки доступа достаточно.
 */

const DB_CALL = 'вызов БД в тесте прав';

/**
 * Любое обращение к db — ошибка: тест доходит максимум до входа в обработчик.
 *
 * Падает заглушка не на вызове, а на `await`: запрос drizzle собирается цепочкой
 * (`select().from().where()`), и синхронный бросок из середины такой цепочки оставлял бы уже
 * созданный соседний промис необработанным. Так и получалось на `Promise.all([loadRows(…),
 * db.select(…)])` в журнале путевых листов: тест проходил, а vitest сообщал об unhandled
 * rejection и возвращал ненулевой код выхода.
 */
vi.mock('../src/db/client', () => {
  const fail = () => Promise.reject(new Error(DB_CALL));
  const chain: unknown = new Proxy(
    {},
    {
      get: (_target, prop): unknown =>
        prop === 'then'
          ? (_resolve: unknown, reject: (e: Error) => void) => reject(new Error(DB_CALL))
          : () => chain,
    },
  );
  const db = new Proxy({}, { get: () => () => chain });
  return { db, pingDb: fail, pool: { end: async () => {} } };
});

// Токен и загрузка пользователя подменяются: проверяем права, а не механику входа.
vi.mock('../src/auth/tokens', () => ({
  verifyAccessToken: async () => ({ sub: 'user-1', role: currentSubject.role, av: 1 }),
  signAccessToken: async () => 'test-token',
}));

vi.mock('../src/auth/principal', () => ({
  loadPrincipal: async () => {
    /*
     * Назначенные полномочия (ADR 0106, шаг 1c) приходят на сервер тем же принципалом, что роль и
     * тип контрагента: без них профиль с набором проверялся бы здесь как голая роль и молча проходил
     * бы весь перебор — «отказано» у него совпало бы с «отказано» у базовой роли.
     *
     * Коды берутся из надстроек профиля, потому что код системного набора и код надстройки совпадают
     * (`SYSTEM_GRANT_CODES ... satisfies readonly RoleAddon[]`), а состав — из `ROLE_ADDON_PERMISSIONS`:
     * тем же списком его завела в `grant_permissions` миграция 0145, и совпадение сверяет
     * `grants-catalog.db.test.ts`. Гейта совместимости с ролью здесь нет намеренно — его держит SQL
     * (`grantPermissionsExpr`), а `ACCESS_PROFILES` несовместимых пар не собирает вовсе.
     */
    const grantCodes = currentSubject.addons ?? [];
    return {
      id: 'user-1',
      email: 'user@test.local',
      lastName: 'Пользователь',
      firstName: 'Тестовый',
      middleName: '',
      fullName: 'Пользователь Тестовый',
      role: currentSubject.role,
      isActive: true,
      mustChangePassword: false,
      constructionObjectIds: [OBJECT_ID],
      // Карточка работника (ADR 0102) — четвёртая ось области. В принципале она есть у всех:
      // матрица проверяет права, а не то, кому её выдали, — иначе кабинет отвечал бы «учётка не
      // связана с работником» и запрет по праву остался бы непроверенным.
      personId: PERSON_ID,
      counterpartyId: COUNTERPARTY_ID,
      counterpartyType: currentSubject.counterpartyType ?? null,
      grantCodes: [...grantCodes],
      grantPermissions: grantCodes.flatMap((code) => [...ROLE_ADDON_PERMISSIONS[code]]),
      /*
       * Пустые надстройки — не забытое поле, а условие проверки. Живой принципал на этом шаге
       * выводит их из тех же кодов (`systemAddonsOf`), и оба источника отвечают на право одинаково:
       * оставь мы `addons` заполненными — перебор проходил бы на старом источнике, и сломанные права
       * набора остались бы незамеченными. Такой принципал к тому же не выдумка: набор, собранный
       * администратором, даёт ровно эту форму уже сегодня — коды есть, пометок нет, — а после шага 1e
       * её примут все наборы.
       */
      addons: [],
      authVersion: 1,
    };
  },
}));

// Валидные UUID: схемы проверяются до preHandler, и на кривом id тест увидел бы 400 вместо 403.
const OBJECT_ID = '11111111-1111-4111-8111-111111111111';
const COUNTERPARTY_ID = '22222222-2222-4222-8222-222222222222';
const RECORD_ID = '33333333-3333-4333-8333-333333333333';
const PERSON_ID = '44444444-4444-4444-8444-444444444444';
/** Заявку заводят не раньше чем на завтра по МСК — берём заведомо будущую дату. */
const FUTURE_DELIVERY_AT = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
/**
 * День рейса — тоже заведомо будущий, и по своей причине: рейс на прошедшую дату требует
 * `waybills.correct` (ADR 0101 п. 4), а этого права у менеджера нет. Прибитая календарём дата
 * однажды стала бы прошлым — и матрица прав начала бы падать на заднем числе, к которому она
 * отношения не имеет.
 */
const FUTURE_ROUTE_DATE = FUTURE_DELIVERY_AT.slice(0, 10);

/** Субъект текущего запроса: подменённый `loadPrincipal` возвращает его принципалу. */
let currentSubject: AccessSubject = { role: null };
let app: FastifyInstance;

/**
 * Ключ субъекта в перечнях кейсов: у исполнителя — «роль/тип контрагента», у учётки с надстройкой
 * — «роль+надстройка», у остальных ролей просто роль. Пара пишется одной строкой, потому что и
 * разрешение у неё одно на пару: роль исполнителя без типа контрагента не отвечает ни на один
 * вопрос про доступ, а «штаб» и «штаб с надстройкой» отвечают на них по-разному.
 *
 * Перечень объявлен списком, а тип выведен из него: писавшийся руками union отставал от
 * контрактов — в нём не было ни водителя (ADR 0102), ни визы отдела ИТ, хотя их ключи в кейсах уже
 * стояли. Расхождение молчит с обеих сторон: забытый ключ `allowed` не принимает (и кейс новой
 * роли писать нечем), а лишний не ловит никто. Список сверяется с `ACCESS_PROFILES` отдельной
 * проверкой ниже — порядок в нём тот же, что в контрактах, и новая роль обязана уронить её здесь,
 * а не проявиться отказом в бою.
 */
const DECLARED_PROFILE_KEYS = [
  'admin',
  'manager',
  'dispatcher',
  'shtab',
  'rukstroy',
  'commandant',
  // Площадка (ADR 0112) — целевая объектная роль реформы, заведённая до перевода учёток. В перечнях
  // ниже она стоит там же, где штаб, **кроме** заказа техники и недели: эти два модуля приезжают ей
  // полномочием, и до выдачи набора она обязана получать на них 403 наравне с комендантом.
  'site',
  'department',
  'department_head',
  'operator/operator',
  'operator/vehicle_lessor',
  'operator/service',
  'observer',
  'driver',
  // Служба главного механика: своей оси области у обеих ролей нет — парк они смотрят целиком.
  'mechanic',
  'chief_mechanic',
  'shtab+office_equipment_operator',
  // Площадка — третья базовая роль обеих надстроек с шага prepare этапа 8 (ADR 0113): после
  // перевода учёток штаба в этой паре не останется, и субъект обязан проверяться заранее.
  'site+office_equipment_operator',
  'department+office_equipment_operator',
  'shtab+office_equipment_it_approver',
  'site+office_equipment_it_approver',
  'department+office_equipment_it_approver',
] as const;

type ProfileKey = (typeof DECLARED_PROFILE_KEYS)[number];

/** Ключ базовой роли субъекта: тот же ключ, но без надстроек. */
const baseKeyOf = (s: AccessSubject): ProfileKey =>
  (s.counterpartyType ? `${s.role}/${s.counterpartyType}` : String(s.role)) as ProfileKey;

const keyOf = (s: AccessSubject): ProfileKey => {
  const addons = s.addons ?? [];
  return (addons.length ? `${baseKeyOf(s)}+${addons.join('+')}` : baseKeyOf(s)) as ProfileKey;
};

const PROFILE_KEYS = ACCESS_PROFILES.map(keyOf);

interface Case {
  title: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  /** Тело запроса: схема Fastify проверяется до preHandler, поэтому оно должно быть валидным. */
  payload?: unknown;
  /** Субъекты, которым маршрут разрешён; остальным ожидается 403. */
  allowed: ProfileKey[];
  /**
   * Маршрут решает по самой записи, а не по роли (`authorizeInHandler`): роль сюда не пускает
   * и не отсекает — доступ определяется тем, видна ли пользователю связанная заявка.
   */
  checkedInHandler?: true;
}

/**
 * Разрешён ли субъект на маршруте. Профиль с надстройкой (ADR 0086) проходит и по ключу своей
 * базовой роли: надстройка права **добавляет**, а не заменяет, — «штаб + оператор оргтехники»
 * обязан попадать всюду, куда попадает штаб, и обратное означало бы, что выданная надстройка
 * закрыла человеку его собственные заявки.
 *
 * Правилом, а не двумя лишними строками в каждом втором перечне: дописанные к «штабу» и «отделу»
 * ключи ничего бы не проверили (это то же самое утверждение, повторённое три десятка раз), а
 * следующая надстройка удвоила бы их снова. Свои маршруты надстройки перечисляются её собственным
 * ключом — там базовой роли как раз нет, и это видно в перечне строкой.
 */
const isAllowed = (c: Case, s: AccessSubject): boolean =>
  c.allowed.includes(keyOf(s)) || c.allowed.includes(baseKeyOf(s));

/**
 * Служба главного механика: обе роли смотрят парк целиком, своей оси области у них нет. В перечнях
 * они стоят парой везде, где решает чтение, — справочники, гараж, журнал листов, карточки
 * водителей, — и одним именем, а не двумя строками в каждом втором кейсе: это одно решение, и
 * разъехаться чтение у них не должно.
 *
 * Расходятся роли ровно на двух правах — ведение водителей и аннулирование бланка, — и там в
 * перечне стоит один `chief_mechanic`: механик в тех кейсах остаётся среди запрещённых, и отказ
 * ему проверяется тем же перебором.
 */
const MECHANICS: ProfileKey[] = ['mechanic', 'chief_mechanic'];

/**
 * Ведение справочника оргтехники (ADR 0085, 0086): три роли, ведущие справочники, плюс надстройка
 * «Оператор (оргтехника)» на своих базовых ролях. Один перечень на все маршруты ведения — их
 * шесть, и разъехаться они не должны: заведение, правка и удаление тут одно решение.
 */
const OFFICE_EQUIPMENT_KEEPERS: ProfileKey[] = [
  'admin',
  'manager',
  'dispatcher',
  'shtab+office_equipment_operator',
  'site+office_equipment_operator',
  'department+office_equipment_operator',
];

/**
 * Заказчик заявки на обслуживание (ADR 0085): обе объектные роли и обе роли отдела. Один перечень
 * на заведение, правку и удаление — это одно решение, и разъехаться они не должны. Комендант сюда
 * не входит: оргтехника на площадке идёт через штаб, как и заказ техники.
 */
const SERVICE_REQUEST_CUSTOMERS: ProfileKey[] = [
  'admin',
  'shtab',
  'rukstroy',
  // Площадка — тот же заказчик: оргтехника входит в `site` целиком (ADR 0112, решение №1).
  'site',
  'department',
  'department_head',
];

/**
 * Решения по заявке — у оператора оргтехники, то есть у надстройки (ADR 0086). Базовых ролей в
 * перечне нет намеренно: на то надстройка и заведена, чтобы назначал сервис и принимал работу один
 * человек, а не всякий, кто завёл заявку.
 */
const SERVICE_REQUEST_OPERATORS: ProfileKey[] = [
  'admin',
  'shtab+office_equipment_operator',
  'site+office_equipment_operator',
  'department+office_equipment_operator',
];

/**
 * Виза отдела ИТ (план модернизации, Р51): решение о том, звать ли внешний сервис. Ни у заказчика,
 * ни у оператора, ни у исполнителя её нет — подтверждать необходимость работы, которую сам же и
 * продаёшь либо сам же и заказал, не согласование (Р55).
 */
const SERVICE_REQUEST_IT_APPROVERS: ProfileKey[] = [
  'admin',
  'shtab+office_equipment_it_approver',
  'site+office_equipment_it_approver',
  'department+office_equipment_it_approver',
];

/** Работа исполнителя: смета, диагностика, закрытие. Вне контрагента `service` — только админ. */
const SERVICE_REQUEST_EXECUTORS: ProfileKey[] = ['admin', 'operator/service'];

/** Кто видит модуль: заказчики, сквозной наблюдатель и исполнитель своих заявок. */
const SERVICE_REQUEST_READERS: ProfileKey[] = [
  ...SERVICE_REQUEST_CUSTOMERS,
  'observer',
  'operator/service',
];

/**
 * Кто подшивает и снимает документы: заказчик (фото поломки — половина заявки) и исполнитель (акт,
 * счёт, гарантийный талон). Оператор оргтехники попадает сюда своей базовой ролью, поэтому его
 * ключей в перечне нет — иначе они нарушили бы правило «свои маршруты надстройки перечисляются там,
 * где базовой роли отказано».
 */
const SERVICE_REQUEST_FILE_KEEPERS: ProfileKey[] = [
  ...SERVICE_REQUEST_CUSTOMERS,
  'operator/service',
];

const CASES: Case[] = [
  // ── Водители (ADR 0037): своё право, а не `directories.*` — в карточке персональные данные ──
  // Круг шире тех, кто ведёт заявки: карточки водителей читает и служба главного механика — за
  // руль его техники садятся эти люди, — а ведёт их из неё только главный механик. Пара кейсов
  // «чтение — ведение» ниже и держит эту границу: механик, попавший в ведение, обязан уронить
  // перебор запретов.
  {
    title: 'справочник водителей — чтение: ведущим заявки и службе главного механика',
    method: 'GET',
    url: '/api/v1/drivers',
    allowed: ['admin', 'manager', 'dispatcher', ...MECHANICS],
  },
  {
    // Список должностей — тот же справочник, вид в него другой: должности живых сотрудников с
    // числами рядом. Отдельным правом не закрыт и открытым не оставлен — читает его тот же, кто
    // читает карточки, потому что должность из карточки и берётся (ADR 0095).
    title: 'должности справочника водителей — тем же, кто читает справочник',
    method: 'GET',
    url: '/api/v1/drivers/job-titles',
    allowed: ['admin', 'manager', 'dispatcher', ...MECHANICS],
  },
  {
    // Главный механик заводит водителя наравне с диспетчером: людей в парк принимает ОГМ. Механика
    // здесь нет — он справочник читает, и это единственное, чем две роли службы различаются в
    // водителях.
    title: 'заведение водителя — тем же, кто выписывает путевой лист, и главному механику',
    method: 'POST',
    url: '/api/v1/drivers',
    payload: {
      lastName: 'Тестовый',
      firstName: 'Водитель',
      snils: '112-233-445 95',
    },
    allowed: ['admin', 'manager', 'dispatcher', 'chief_mechanic'],
  },
  // Загрузки кадровой выгрузки у водителей больше нет: справочник грузится файлом .xlsx через
  // обмен справочниками (ADR 0073), и его маршруты проверяются ниже, в разделе администрирования.
  // Право там своё — `directories.import`, только у администратора: диспетчер по-прежнему заводит
  // водителя формой, но справочник целиком файлом не переписывает.
  {
    // Отбор водителя под машину — часть формы перевода заявки в работу. Право на статусы
    // заявок ТС сюда не годится: с ADR 0038 оно есть и у арендодателя, а водителей нашего
    // парка он не назначает — путевой лист выписывается только на собственные машины.
    title: 'отбор водителей под машину — тем же, кто читает справочник водителей',
    method: 'GET',
    url: '/api/v1/drivers/available?vehicleId=00000000-0000-4000-8000-000000000000&on=2026-08-03',
    allowed: ['admin', 'manager', 'dispatcher', ...MECHANICS],
  },
  {
    title: 'замена удостоверения — тем же, кто ведёт водителей',
    method: 'POST',
    url: `/api/v1/drivers/${RECORD_ID}/licenses`,
    payload: {
      number: '482645',
      categories: [{ categoryId: '55555555-5555-4555-8555-555555555555' }],
    },
    allowed: ['admin', 'manager', 'dispatcher', 'chief_mechanic'],
  },
  {
    title: 'отметка проверки документа — тем же, кто ведёт водителей',
    method: 'POST',
    url: `/api/v1/drivers/${RECORD_ID}/licenses/${RECORD_ID}/verify`,
    payload: { verificationStatus: 'verified' },
    allowed: ['admin', 'manager', 'dispatcher', 'chief_mechanic'],
  },
  {
    title: 'аннулирование удостоверения — тем же, кто ведёт водителей',
    method: 'POST',
    url: `/api/v1/drivers/${RECORD_ID}/licenses/${RECORD_ID}/revoke`,
    payload: { revokeReason: 'лишение права управления' },
    allowed: ['admin', 'manager', 'dispatcher', 'chief_mechanic'],
  },
  // ── Путевые листы (ADR 0037): журнал и аннулирование — своими правами ──
  // Журнал читает и служба главного механика: лист выписывают на её технику и её водителя. А вот
  // списывает испорченный бланк из неё только главный механик — аннулирование расходует номер
  // строгой отчётности, и у механика его нет.
  {
    title: 'журнал путевых листов — ведущим заявки и службе главного механика',
    method: 'GET',
    url: '/api/v1/waybills',
    allowed: ['admin', 'manager', 'dispatcher', ...MECHANICS],
  },
  {
    title: 'аннулирование листа — своим правом, и у службы оно только у главного механика',
    method: 'POST',
    url: `/api/v1/waybills/${RECORD_ID}/cancel`,
    payload: { reason: 'испорчен при печати' },
    allowed: ['admin', 'manager', 'dispatcher', 'chief_mechanic'],
  },
  {
    // Печать уносит из портала СНИЛС и номер удостоверения ровно так же, как выгрузка файлом
    // (ADR 0037 п. 13, ADR 0041): право у неё то же, и шире круг быть не может.
    title: 'печать бланка — тем же правом, что чтение журнала',
    method: 'GET',
    url: `/api/v1/waybills/${RECORD_ID}/print`,
    allowed: ['admin', 'manager', 'dispatcher', ...MECHANICS],
  },
  {
    title: 'листы заявки в карточке — правом на листы, а не на заявки',
    method: 'GET',
    url: `/api/v1/vehicle-requests/${RECORD_ID}/waybills`,
    allowed: ['admin', 'manager', 'dispatcher', ...MECHANICS],
  },
  {
    // Выписка ЭСМ-2 по требованию у линейного заказа (ADR 0100 §6). Права те же две, что у
    // выписки листа с рейса: это тот же документ и тот же коридор решений. Арендодателю сюда
    // нельзя, хотя `vehicleRequests.status` у него есть, — в бланке машинист нашего парка.
    title: 'выписка ЭСМ-2 по требованию — правом на листы и на ход заявки',
    method: 'POST',
    url: `/api/v1/vehicle-requests/${RECORD_ID}/esm2`,
    payload: {
      weekOf: '2026-08-03',
      vehicleId: RECORD_ID,
      driverPersonId: RECORD_ID,
      version: 1,
    },
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  // ── Дни линейного заказа (ADR 0100 §8) ──
  // Читают план все, кто видит заявку (ADR 0122): «кто и на чём выйдет ко мне в четверг» — вопрос
  // заказчика в первую очередь. Планирование живёт в рейсах — оно распоряжается чужой машиной и
  // чужим днём, — и спрашивает те же две проверки, что сами маршруты, с тем же запрещённым:
  // внешним арендодателем, у которого `vehicleRequests.status` есть, а `waybills.read` нет.
  {
    title: 'план по дням — правом на саму заявку: его читает и заказчик',
    method: 'GET',
    url: `/api/v1/vehicle-requests/${RECORD_ID}/days`,
    // Перечень тот же, что у списка заявок. Службы главного механика в нём нет вовсе:
    // `vehicleRequests.read` ей не положен — заявок она не ведёт, а свои машины и своих водителей
    // видит в гараже и в журнале листов.
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'department',
      'department_head',
      'operator/vehicle_lessor',
      'observer',
    ],
  },
  {
    title: 'постановка дня в рейс — правом на листы и на ход заявки',
    method: 'POST',
    url: `/api/v1/vehicle-requests/${RECORD_ID}/days/2026-08-03/route`,
    payload: { routeId: RECORD_ID },
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    title: 'снятие дня с рейса — теми же двумя правами',
    method: 'DELETE',
    url: `/api/v1/vehicle-requests/${RECORD_ID}/days/2026-08-03/route`,
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  // Вложения к бланку — своё право (`waybills.files`): смотреть журнал может и тот, кто документы
  // к нему не подшивает. Состав ролей тот же, что у чтения и аннулирования, — журнал ведут они.
  {
    title: 'прикрепление скана к бланку — правом waybills.files',
    method: 'POST',
    url: `/api/v1/waybills/${RECORD_ID}/files`,
    payload: { addFileIds: [RECORD_ID] },
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  // ── Маршруты: обе проверки сразу, waybills.read И vehicleRequests.status ──
  // Важен здесь не столько список разрешённых, сколько один запрещённый: у внешнего
  // арендодателя `vehicleRequests.status` есть (ADR 0038, он закрывает свои заявки), а
  // `waybills.read` нет — и в рейс, где лежат чужие заявки и допуски водителей собственного
  // парка, он попасть не должен ни на чтение, ни на правку.
  {
    title: 'список рейсов — закрыт от всех, кроме ведущих заявки и листы',
    method: 'GET',
    url: '/api/v1/vehicle-routes',
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    title: 'заведение рейса — теми же двумя правами',
    method: 'POST',
    url: '/api/v1/vehicle-routes',
    payload: { vehicleId: RECORD_ID, routeDate: FUTURE_ROUTE_DATE },
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    title: 'заявка в рейс — теми же двумя правами',
    method: 'POST',
    url: `/api/v1/vehicle-routes/${RECORD_ID}/requests`,
    payload: { requestId: RECORD_ID, version: 0 },
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    title: 'порядок талонов — теми же двумя правами',
    method: 'PUT',
    url: `/api/v1/vehicle-routes/${RECORD_ID}/order`,
    payload: { requestIds: [RECORD_ID], version: 0 },
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    title: 'выписка листа с рейса — теми же двумя правами',
    method: 'POST',
    url: `/api/v1/vehicle-routes/${RECORD_ID}/waybill`,
    payload: { version: 0 },
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    // В ответе — рейсы этой машины на эту дату вместе с водителями. Права на смену статуса тут
    // мало по той же причине, что и на самих маршрутах.
    title: 'подсказка рейсов при переводе в работу — теми же двумя правами',
    method: 'GET',
    url: `/api/v1/vehicle-requests/${RECORD_ID}/route-prefill?vehicleId=${RECORD_ID}`,
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  // ── Гараж (ADR 0076): срез дня по своему парку и водителям ──
  // Право своё, а не сумма прав источников среза: в строке видно, кто за рулём, — те же
  // персональные данные, что в карточке водителя. Наблюдателю раздел закрыт вместе с ними, хотя
  // заявки он читает; арендодателю — тем более: парк и водители тут наши.
  // Служба главного механика получает раздел целиком, и это её главный экран: где сегодня каждая
  // машина и кто на ней. Обе роли читают одинаково — гараж только показывает, действий в нём нет.
  {
    title: 'срез техники — ведущим водителей и листы плюс служба главного механика',
    method: 'GET',
    url: '/api/v1/garage/vehicles',
    allowed: ['admin', 'manager', 'dispatcher', ...MECHANICS],
  },
  {
    title: 'сводка по парку — тем же правом',
    method: 'GET',
    url: '/api/v1/garage/vehicles/summary',
    allowed: ['admin', 'manager', 'dispatcher', ...MECHANICS],
  },
  {
    title: 'срез водителей — тем же правом',
    method: 'GET',
    url: '/api/v1/garage/drivers',
    allowed: ['admin', 'manager', 'dispatcher', ...MECHANICS],
  },
  {
    title: 'сводка по водителям — тем же правом',
    method: 'GET',
    url: '/api/v1/garage/drivers/summary',
    allowed: ['admin', 'manager', 'dispatcher', ...MECHANICS],
  },
  // ── Справочники: чтение нужно всем (форма заявки), ведение — трём ролям ──
  // «Всем» — это и сервисная компания (ADR 0085): `directories.read` она получает ролью внешнего
  // исполнителя, как оператор вывоза и арендодатель ТС, и без справочников у неё не отрисуется ни
  // фильтр, ни название в списке. Свой справочник — оргтехники — ей при этом закрыт (Р7), и
  // проверяется это ниже, в разделе оргтехники.
  //
  // Служба главного механика читает справочники, но не ведёт их — ни одна из двух ролей: ведение
  // одним правом открывает весь раздел, вместе с объектами, контрагентами и прайсом вывоза. Поэтому
  // в кейсах ведения ниже её ключей нет, и оба механика попадают там в перебор запретов.
  {
    title: 'справочник техники — чтение',
    method: 'GET',
    url: '/api/v1/vehicles',
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'commandant',
      'site',
      'department',
      'department_head',
      'operator/operator',
      'operator/vehicle_lessor',
      'operator/service',
      'observer',
      ...MECHANICS,
    ],
  },
  {
    title: 'справочник типов ТС — чтение',
    method: 'GET',
    url: '/api/v1/vehicle-types',
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'commandant',
      'site',
      'department',
      'department_head',
      'operator/operator',
      'operator/vehicle_lessor',
      'operator/service',
      'observer',
      ...MECHANICS,
    ],
  },
  {
    // Классификатор (ADR 0028) — тот же справочник, что типы и категории, только одним списком:
    // им заполняется форма заявки, поэтому читать его должны все роли.
    title: 'классификатор ТС — чтение',
    method: 'GET',
    url: '/api/v1/vehicle-classifications',
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'commandant',
      'site',
      'department',
      'department_head',
      'operator/operator',
      'operator/vehicle_lessor',
      'operator/service',
      'observer',
      ...MECHANICS,
    ],
  },
  {
    title: 'объекты — создание',
    method: 'POST',
    url: '/api/v1/objects',
    payload: { code: 'OBJ-1', name: 'Объект', address: 'Москва' },
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    title: 'техника — удаление',
    method: 'DELETE',
    url: `/api/v1/vehicles/${RECORD_ID}`,
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    title: 'прайс вывоза — создание позиции',
    method: 'POST',
    url: '/api/v1/waste-tariffs',
    payload: {
      operatorCounterpartyId: COUNTERPARTY_ID,
      wasteTypeId: RECORD_ID,
      containerTypeId: RECORD_ID,
      pricePerM3: 1000,
    },
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    title: 'контрагенты — удаление',
    method: 'DELETE',
    url: `/api/v1/counterparties/${RECORD_ID}`,
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    title: 'контрагенты — восстановление из архива',
    method: 'POST',
    url: `/api/v1/counterparties/${RECORD_ID}/restore`,
    allowed: ['admin'],
  },
  // ── Удаление записи справочника насовсем (ADR 0060) ──
  // Ведение справочников и удаление насовсем — разные права: менеджер и диспетчер заводят и
  // гасят записи, но снести погашенную может только администратор.
  {
    title: 'объекты — удаление насовсем',
    method: 'DELETE',
    url: `/api/v1/objects/${RECORD_ID}/purge`,
    allowed: ['admin'],
  },
  {
    title: 'водители — удаление насовсем',
    method: 'DELETE',
    url: `/api/v1/drivers/${RECORD_ID}/purge`,
    allowed: ['admin'],
  },
  {
    // Документ водителя убирают тем же правом, что и запись справочника: аннулирование остаётся у
    // ведущих справочник (оно означает «документ был и перестал действовать»), а удаление снимает
    // бумагу, которой у человека не было, — и освобождает занятые ею серию с номером.
    //
    // Замена со снятием прежнего (`deletePrevious` у POST /:id/licenses) спрашивает то же право, но
    // проверяется уже в обработчике — после загрузки карточки, — и здесь, на подменённой БД, до неё
    // не доходит. Её отказ проверяется на живой схеме (`driver-license-delete.db.test.ts`).
    title: 'удаление документа водителя — правом на удаление насовсем',
    method: 'DELETE',
    url: `/api/v1/drivers/${RECORD_ID}/licenses/${RECORD_ID}`,
    allowed: ['admin'],
  },
  // ── Склады поставщиков (ADR 0051): обычный справочник, своего права не заводит ──
  {
    title: 'склады — список',
    method: 'GET',
    url: '/api/v1/warehouses',
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'commandant',
      'site',
      'department',
      'department_head',
      'operator/operator',
      'operator/vehicle_lessor',
      'operator/service',
      'observer',
      ...MECHANICS,
    ],
  },
  {
    title: 'склады — создание',
    method: 'POST',
    url: '/api/v1/warehouses',
    payload: { supplierId: COUNTERPARTY_ID, address: 'г. Мытищи, ул. Ленина, д. 1' },
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    title: 'склады — правка',
    method: 'PATCH',
    url: `/api/v1/warehouses/${RECORD_ID}`,
    payload: { address: 'г. Мытищи, ул. Ленина, д. 2' },
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    title: 'склады — удаление',
    method: 'DELETE',
    url: `/api/v1/warehouses/${RECORD_ID}`,
    allowed: ['admin', 'manager', 'dispatcher'],
  },

  // ── Оргтехника (ADR 0085): справочник со своей парой прав ──
  // Чтение — не `directories.read`: то есть у всех ролей, включая коменданта и исполнителя чужого
  // модуля, а карточка единицы рассказывает и про её обслуживание. Ведение — не
  // `directories.write`: то открывает весь раздел справочников, а тут нужен один.
  //
  // Отсюда и круг: заказчики (объектные роли, отделы) и наблюдатель читают, ведут те же трое, кто
  // ведёт остальные справочники. Комендант закрыт целиком — техника с площадки идёт через штаб; у
  // внешних исполнителей права нет вовсе, в том числе у сервисной компании (в её заявку реквизиты
  // единицы приходят снимком, а право открыло бы весь парк).
  //
  // Четвёртый способ получить ведение — надстройка «Оператор (оргтехника)» (ADR 0086): её ключ
  // стоит в перечнях ведения рядом с тремя ролями, а базовой роли (штаба, отдела) там нет — на то
  // надстройка и заведена, чтобы оператором оргтехники стал один человек, а не всякий штаб. На
  // архив она не распространяется: восстановление и удаление насовсем ниже остались за
  // администратором, и профиль с надстройкой получает там 403 наравне со своей базовой ролью.
  {
    title: 'оргтехника — список',
    method: 'GET',
    url: '/api/v1/office-equipment',
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'site',
      'department',
      'department_head',
      'observer',
    ],
  },
  {
    title: 'оргтехника — карточка единицы',
    method: 'GET',
    url: `/api/v1/office-equipment/${RECORD_ID}`,
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'site',
      'department',
      'department_head',
      'observer',
    ],
  },
  {
    title: 'оргтехника — заведение единицы',
    method: 'POST',
    url: '/api/v1/office-equipment',
    payload: {
      equipmentTypeId: RECORD_ID,
      name: 'Kyocera ECOSYS M3145',
      inventoryNumber: '0012345',
      objectId: OBJECT_ID,
    },
    allowed: OFFICE_EQUIPMENT_KEEPERS,
  },
  {
    title: 'оргтехника — правка единицы',
    method: 'PATCH',
    url: `/api/v1/office-equipment/${RECORD_ID}`,
    payload: { location: 'каб. 312' },
    allowed: OFFICE_EQUIPMENT_KEEPERS,
  },
  {
    title: 'оргтехника — удаление единицы',
    method: 'DELETE',
    url: `/api/v1/office-equipment/${RECORD_ID}`,
    allowed: OFFICE_EQUIPMENT_KEEPERS,
  },
  {
    // Архив общий для всего портала (ADR 0060, 0070): возвращает записи администратор, а не тот,
    // кто ведёт справочник.
    title: 'оргтехника — восстановление из архива',
    method: 'POST',
    url: `/api/v1/office-equipment/${RECORD_ID}/restore`,
    allowed: ['admin'],
  },
  {
    title: 'оргтехника — удаление насовсем',
    method: 'DELETE',
    url: `/api/v1/office-equipment/${RECORD_ID}/purge`,
    allowed: ['admin'],
  },
  {
    // Типы — перечень внутри того же справочника, и права у него те же: отдельного «типа
    // оргтехники» в матрице нет намеренно, иначе на десять строк завелась бы своя пара прав.
    title: 'типы оргтехники — список',
    method: 'GET',
    url: '/api/v1/office-equipment-types',
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'site',
      'department',
      'department_head',
      'observer',
    ],
  },
  {
    title: 'типы оргтехники — заведение',
    method: 'POST',
    url: '/api/v1/office-equipment-types',
    payload: { code: 'plotter', name: 'Плоттер' },
    allowed: OFFICE_EQUIPMENT_KEEPERS,
  },
  {
    title: 'типы оргтехники — правка',
    method: 'PATCH',
    url: `/api/v1/office-equipment-types/${RECORD_ID}`,
    payload: { name: 'Плоттеры' },
    allowed: OFFICE_EQUIPMENT_KEEPERS,
  },
  {
    title: 'типы оргтехники — удаление',
    method: 'DELETE',
    url: `/api/v1/office-equipment-types/${RECORD_ID}`,
    allowed: OFFICE_EQUIPMENT_KEEPERS,
  },

  // ── Заявки на обслуживание (ADR 0085) ──
  // Модуль ведут три стороны, и прав у него девять — по одному на решение, а не по одному на
  // раздел. Отсюда и перечни ниже: заказчик заводит и правит, оператор оргтехники решает (кого
  // позвать, согласны ли на эти деньги, принята ли работа), сервис работает (смета, диагностика,
  // закрытие). Матрица проверяет ровно это: что к маршруту привязано право той стороны, чьё это
  // действие, а не «какое-нибудь право модуля».
  //
  // Оператор оргтехники приходит надстройкой (ADR 0086), поэтому в перечнях решений стоят её
  // ключи, а базовых ролей там нет: штаб без надстройки — обычный заказчик. Обратное верно тоже —
  // в перечнях заказчика стоит «штаб», и профиль с надстройкой попадает туда правилом `isAllowed`,
  // потому что надстройка права добавляет, а не заменяет.
  //
  // Право у маршрута не всегда называет сторону в одиночку: `serviceRequests.status` есть и у
  // сервиса, и у оператора оргтехники, а ручки под ним разные (Р17). Отделяет их коридор —
  // `assertSideAllowed` стоит первой строкой обработчика, до области и до единого запроса в БД, —
  // поэтому чужая сторона получает здесь такой же 403, как от `requirePermission`. Проверять это
  // матрицей и нужно: разница между «отказано» и «пропущено до записи» иначе видна только в бою.
  {
    title: 'заявки на обслуживание — список',
    method: 'GET',
    url: '/api/v1/service-requests',
    allowed: SERVICE_REQUEST_READERS,
  },
  {
    title: 'заявки на обслуживание — карточка',
    method: 'GET',
    url: `/api/v1/service-requests/${RECORD_ID}`,
    allowed: SERVICE_REQUEST_READERS,
  },
  {
    title: 'заявки на обслуживание — история',
    method: 'GET',
    url: `/api/v1/service-requests/${RECORD_ID}/history`,
    allowed: SERVICE_REQUEST_READERS,
  },
  {
    // Реестр гарантий живёт правом модуля, а не справочника: он собран из строк смет закрытых
    // заявок, и сервису в нём видны его же работы.
    title: 'заявки на обслуживание — реестр гарантий',
    method: 'GET',
    url: '/api/v1/service-requests/warranties',
    allowed: SERVICE_REQUEST_READERS,
  },
  {
    // Счётчик «ждут меня» для бейджа в меню закрыт правом чтения модуля, а не правом решения:
    // ответ у него — число заявок области, и стороне без шага в цикле он честно отвечает нулём.
    // Закрой его `serviceRequests.assign`, и сервисная компания — вторая сторона цикла — получала
    // бы 403 на собственную очередь.
    title: 'заявки на обслуживание — счётчик «ждут меня»',
    method: 'GET',
    url: '/api/v1/service-requests/waiting-count',
    allowed: SERVICE_REQUEST_READERS,
  },
  {
    title: 'заявки на обслуживание — заведение',
    method: 'POST',
    url: '/api/v1/service-requests',
    // Контакт заявителя обязателен (Р49): без него схема отвечает 400 раньше, чем страж —
    // 403, и матрица прав проверяла бы не то.
    payload: {
      officeEquipmentId: RECORD_ID,
      description: 'не захватывает бумагу',
      responsibleName: 'Иванов И. И.',
      responsiblePhone: '9000000000',
    },
    allowed: SERVICE_REQUEST_CUSTOMERS,
  },
  {
    title: 'заявки на обслуживание — правка',
    method: 'PATCH',
    url: `/api/v1/service-requests/${RECORD_ID}`,
    payload: { description: 'не захватывает бумагу из нижнего лотка', version: 1 },
    allowed: SERVICE_REQUEST_CUSTOMERS,
  },
  {
    title: 'заявки на обслуживание — удаление',
    method: 'DELETE',
    url: `/api/v1/service-requests/${RECORD_ID}`,
    allowed: SERVICE_REQUEST_CUSTOMERS,
  },
  {
    // Кого позвать чинить — решение заказчика, и принимает его один человек: оператор оргтехники.
    // Ни штаб, ни отдел без надстройки сервис не назначают, иначе назначал бы всякий, кто завёл
    // заявку.
    title: 'заявки на обслуживание — назначение сервиса',
    method: 'PATCH',
    url: `/api/v1/service-requests/${RECORD_ID}/service`,
    payload: { serviceCounterpartyId: COUNTERPARTY_ID, version: 1 },
    allowed: SERVICE_REQUEST_OPERATORS,
  },
  {
    title: 'заявки на обслуживание — виза отдела ИТ',
    method: 'PATCH',
    url: `/api/v1/service-requests/${RECORD_ID}/it-approval`,
    payload: { approved: true, version: 1 },
    allowed: SERVICE_REQUEST_IT_APPROVERS,
  },
  {
    title: 'заявки на обслуживание — согласование сметы',
    method: 'PATCH',
    url: `/api/v1/service-requests/${RECORD_ID}/estimate/approval`,
    payload: { approved: true, version: 1 },
    allowed: SERVICE_REQUEST_OPERATORS,
  },
  {
    // Приёмка, возврат и отмена стоят на общем `serviceRequests.status`, и сервис его тоже имеет:
    // отделяет стороны коридор. «Принять работу за заказчика» — ровно тот случай, ради которого
    // коридоры и разведены.
    title: 'заявки на обслуживание — приёмка работы',
    method: 'PATCH',
    url: `/api/v1/service-requests/${RECORD_ID}/accept`,
    payload: { version: 1 },
    allowed: SERVICE_REQUEST_OPERATORS,
  },
  {
    title: 'заявки на обслуживание — возврат на доработку',
    method: 'PATCH',
    url: `/api/v1/service-requests/${RECORD_ID}/rework`,
    payload: { reason: 'подача по-прежнему не работает', version: 1 },
    allowed: SERVICE_REQUEST_OPERATORS,
  },
  {
    // `/status` осталась отмене и административным откатам (Р18): у переходов с содержанием свои
    // ручки, и право здесь — то же операторское.
    title: 'заявки на обслуживание — отмена и откаты',
    method: 'PATCH',
    url: `/api/v1/service-requests/${RECORD_ID}/status`,
    payload: { status: 'cancelled', reason: 'технику списали', version: 1 },
    allowed: SERVICE_REQUEST_OPERATORS,
  },
  {
    // Смета — право стороны исполнителя, и вне контрагента `service` оно есть только у
    // администратора. Оператор оргтехники сюда не попадает намеренно: он смету согласует, а
    // подписывать собственную работу не должен.
    title: 'заявки на обслуживание — состав сметы',
    method: 'PUT',
    url: `/api/v1/service-requests/${RECORD_ID}/estimate`,
    payload: {
      items: [{ kind: 'part', name: 'Ролик подачи', quantity: 1, unitPrice: 1800 }],
      version: 1,
    },
    allowed: SERVICE_REQUEST_EXECUTORS,
  },
  {
    title: 'заявки на обслуживание — предъявление сметы',
    method: 'PATCH',
    url: `/api/v1/service-requests/${RECORD_ID}/estimate/submit`,
    payload: { version: 1 },
    allowed: SERVICE_REQUEST_EXECUTORS,
  },
  {
    title: 'заявки на обслуживание — переоткрытие сметы',
    method: 'PATCH',
    url: `/api/v1/service-requests/${RECORD_ID}/estimate/reopen`,
    payload: { reason: 'нужен ещё термоузел', version: 1 },
    allowed: SERVICE_REQUEST_EXECUTORS,
  },
  {
    title: 'заявки на обслуживание — закрытие работ',
    method: 'PATCH',
    url: `/api/v1/service-requests/${RECORD_ID}/complete`,
    payload: { completedOn: '2026-08-05', items: [], version: 1 },
    allowed: SERVICE_REQUEST_EXECUTORS,
  },
  {
    // Отказ от заявки и взятие её в диагностику — шаги исполнителя, но право у маршрута общее,
    // `serviceRequests.status`: оно есть и у оператора оргтехники. Отсекает его коридор, и в
    // перечень оператор поэтому не попадает — «предъявить смету за сервис» и «отказаться за него»
    // не должны работать ни через свою ручку, ни через `/status`.
    title: 'заявки на обслуживание — отказ исполнителя',
    method: 'PATCH',
    url: `/api/v1/service-requests/${RECORD_ID}/decline`,
    payload: { reason: 'заняты до конца месяца', version: 1 },
    allowed: SERVICE_REQUEST_EXECUTORS,
  },
  {
    title: 'заявки на обслуживание — взятие в диагностику',
    method: 'PATCH',
    url: `/api/v1/service-requests/${RECORD_ID}/start`,
    payload: { version: 1 },
    allowed: SERVICE_REQUEST_EXECUTORS,
  },
  {
    // Примечание исполнителя (приём ADR 0053): вторая сторона комментария. Заявку оно не правит —
    // поэтому и не `serviceRequests.update`, которого у сервиса нет вовсе.
    title: 'заявки на обслуживание — примечание исполнителя',
    method: 'PATCH',
    url: `/api/v1/service-requests/${RECORD_ID}/service-comment`,
    payload: { serviceComment: 'будем во вторник после обеда', version: 1 },
    allowed: SERVICE_REQUEST_EXECUTORS,
  },
  {
    // Файлы — своё право (Р29): фотография поломки от заказчика, смета и акт от исполнителя.
    // Правку заявки оно не требует, поэтому круг здесь шире, чем у `PATCH /:id`.
    title: 'заявки на обслуживание — подшивка документа',
    method: 'POST',
    url: `/api/v1/service-requests/${RECORD_ID}/files`,
    payload: { fileIds: [RECORD_ID], kind: 'act' },
    allowed: SERVICE_REQUEST_FILE_KEEPERS,
  },
  {
    title: 'заявки на обслуживание — снятие документа',
    method: 'DELETE',
    url: `/api/v1/service-requests/${RECORD_ID}/files/${RECORD_ID}`,
    allowed: SERVICE_REQUEST_FILE_KEEPERS,
  },
  {
    // Архив общий для всего портала (ADR 0060, 0070): возвращает и сносит записи администратор, а
    // не тот, кто ведёт заявки.
    title: 'заявки на обслуживание — восстановление из архива',
    method: 'POST',
    url: `/api/v1/service-requests/${RECORD_ID}/restore`,
    allowed: ['admin'],
  },
  {
    title: 'заявки на обслуживание — удаление насовсем',
    method: 'DELETE',
    url: `/api/v1/service-requests/${RECORD_ID}/purge`,
    allowed: ['admin'],
  },

  // ── Вывоз мусора: раньше модуль был открыт любому вошедшему ──
  {
    // Роли отдела здесь есть (ADR 0062): право на модуль у них общее, а есть ли им что показать,
    // решает площадка отдела — это область, и маршрут её проверяет по строкам, а не отказом.
    title: 'вывоз — список',
    method: 'GET',
    url: '/api/v1/waste-requests',
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'commandant',
      'site',
      'department',
      'department_head',
      'operator/operator',
      'observer',
    ],
  },
  {
    title: 'вывоз — удаление заявки',
    method: 'DELETE',
    url: `/api/v1/waste-requests/${RECORD_ID}`,
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'commandant',
      'site',
      'department',
      'department_head',
    ],
  },
  {
    title: 'вывоз — смена статуса',
    method: 'PATCH',
    url: `/api/v1/waste-requests/${RECORD_ID}/status`,
    payload: { status: 'confirmed', version: 1 },
    allowed: ['admin', 'manager', 'dispatcher', 'operator/operator'],
  },
  {
    title: 'вывоз — назначение оператора',
    method: 'PATCH',
    url: `/api/v1/waste-requests/${RECORD_ID}/operator`,
    payload: { operatorCounterpartyId: COUNTERPARTY_ID, version: 1 },
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    // Примечание исполнителя (ADR 0053): пишет его оператор — правкой заявки это не является, —
    // и те, кто заявку ведёт. Площадка сюда не входит: у неё своя строка комментария.
    title: 'вывоз — комментарий исполнителя',
    method: 'PATCH',
    url: `/api/v1/waste-requests/${RECORD_ID}/comment`,
    payload: { operatorComment: 'будем после 15:00', version: 1 },
    allowed: ['admin', 'manager', 'dispatcher', 'operator/operator'],
  },
  {
    title: 'вывоз — восстановление из архива',
    method: 'POST',
    url: `/api/v1/waste-requests/${RECORD_ID}/restore`,
    allowed: ['admin'],
  },
  // Удаление заявки насовсем (ADR 0070) — не право модуля: заявки вывоза удаляют менеджер и
  // диспетчер, а снести удалённую может только администратор, и это разные права.
  {
    title: 'вывоз — удаление насовсем',
    method: 'DELETE',
    url: `/api/v1/waste-requests/${RECORD_ID}/purge`,
    allowed: ['admin'],
  },

  // ── Заказ ТС: оператору вывоза недоступен целиком (ADR 0010), арендодателю открыт как
  // исполнителю — он видит заявки, на которые вышла его техника, и закрывает их (ADR 0038) ──
  {
    title: 'заказ ТС — список',
    method: 'GET',
    url: '/api/v1/vehicle-requests',
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'department',
      'department_head',
      'operator/vehicle_lessor',
      'observer',
    ],
  },
  {
    title: 'заказ ТС — сводка',
    method: 'GET',
    url: '/api/v1/vehicle-requests/summary',
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'department',
      'department_head',
      'operator/vehicle_lessor',
      'observer',
    ],
  },
  {
    // Срез «На объекте» (ADR 0036) — то же чтение заявок: наблюдателю он открыт, оператору
    // вывоза недоступен вместе со всем модулем.
    title: 'заказ ТС — техника на объектах',
    method: 'GET',
    url: '/api/v1/vehicle-requests/on-site',
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'department',
      'department_head',
      'operator/vehicle_lessor',
      'observer',
    ],
  },
  {
    // Контакт водителя (ADR 0122) — правом на заявку, а не на листы: имя и телефон того, кто
    // приедет, нужны прежде всего тому, кто машину встречает. Персональные данные бланка —
    // СНИЛС и удостоверение — остались за `drivers.read` и `waybills.read`, и служба главного
    // механика в перечне поэтому не стоит: заявок она не ведёт вовсе.
    title: 'заказ ТС — контакт водителя в карточке',
    method: 'GET',
    url: `/api/v1/vehicle-requests/${RECORD_ID}/driver`,
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'department',
      'department_head',
      'operator/vehicle_lessor',
      'observer',
    ],
  },
  {
    title: 'заказ ТС — итог по технике на объектах',
    method: 'GET',
    url: '/api/v1/vehicle-requests/on-site/summary',
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'department',
      'department_head',
      'operator/vehicle_lessor',
      'observer',
    ],
  },
  {
    title: 'заказ ТС — удаление заявки',
    method: 'DELETE',
    url: `/api/v1/vehicle-requests/${RECORD_ID}`,
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'department',
      'department_head',
    ],
  },
  {
    // Виза — решение заказчика, а не того, кто заявку обрабатывает (ADR 0025): менеджеру и
    // диспетчеру она недоступна, хотя статусы ведут именно они. Заказчиков двое — объект и отдел
    // (ADR 0040), и визирует каждый у себя: право на маршруте одно, разводит их область.
    title: 'заказ ТС — виза заказчика',
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${RECORD_ID}/approval`,
    payload: { approved: true, version: 1 },
    allowed: ['admin', 'rukstroy', 'department_head'],
  },
  {
    // Досрочное завершение (ADR 0044): попросить сократить срок может тот, кто заявку ведёт, —
    // площадка замечает освободившуюся технику, диспетчер оформляет. Отдельного права нет:
    // состав ролей у правки ровно тот же, а «правит только "Новую"» — это область, и она здесь
    // намеренно не применяется. Арендодателю и наблюдателю действие закрыто отсутствием правки.
    title: 'заказ ТС — запрос досрочного завершения',
    method: 'POST',
    url: `/api/v1/vehicle-requests/${RECORD_ID}/early-end`,
    payload: { newDateTo: '2026-08-20', reason: 'Работы закончены', version: 1 },
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'department',
      'department_head',
    ],
  },
  {
    // Решение по запросу — то же право и та же область, что у визы самой заявки: сокращение
    // срока согласует тот, кто согласовывал заказ.
    title: 'заказ ТС — виза досрочного завершения',
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${RECORD_ID}/early-end`,
    payload: { approved: true, version: 1 },
    allowed: ['admin', 'rukstroy', 'department_head'],
  },
  {
    // Отзыв запроса — тем же, кто мог его подать: отбой обычно приходит диспетчеру, а не автору.
    title: 'заказ ТС — отзыв запроса на досрочное завершение',
    method: 'DELETE',
    url: `/api/v1/vehicle-requests/${RECORD_ID}/early-end`,
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'department',
      'department_head',
    ],
  },
  {
    // Смены (подтверждение работы по дням): читает их тот же, кто видит заявку, — в том числе
    // арендодатель и наблюдатель: по этой таблице разбирают спор о часах.
    title: 'заказ ТС — таблица смен',
    method: 'GET',
    url: `/api/v1/vehicle-requests/${RECORD_ID}/shifts`,
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'department',
      'department_head',
      'observer',
      'operator/vehicle_lessor',
    ],
  },
  {
    // Часы вносит тот, кто ведёт заявку, — тем же правом, что и правку: «объектная роль правит
    // только "Новую"» здесь не применяется, смены и появляются только у заявки в работе.
    title: 'заказ ТС — запись смены',
    method: 'PUT',
    url: `/api/v1/vehicle-requests/${RECORD_ID}/shifts/2026-08-03`,
    payload: { machineHours: 8 },
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'department',
      'department_head',
    ],
  },
  {
    title: 'заказ ТС — удаление смены',
    method: 'DELETE',
    url: `/api/v1/vehicle-requests/${RECORD_ID}/shifts/2026-08-03`,
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'department',
      'department_head',
    ],
  },
  {
    // Подпись объекта под днём работы: круг «кто мог бы завести эту заявку» — право на заведение
    // плюс область. Арендодатель и наблюдатель не подтверждают: первый — вторая сторона в споре
    // о часах, второй не ведёт ничего.
    title: 'заказ ТС — согласование смены',
    method: 'POST',
    url: `/api/v1/vehicle-requests/${RECORD_ID}/shifts/2026-08-03/approval`,
    payload: { approved: true },
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'department',
      'department_head',
    ],
  },
  {
    title: 'заказ ТС — смена статуса',
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${RECORD_ID}/status`,
    payload: { status: 'confirmed', version: 1 },
    // Право на маршрут у арендодателя есть; коридор переходов и чужие заявки отсекаются дальше —
    // проверками области и `assertTransitionAllowed`, а не 403 на входе.
    allowed: ['admin', 'manager', 'dispatcher', 'operator/vehicle_lessor'],
  },
  {
    // Смена машины у заявки в работе (ADR 0048) разрешена тем же правом, что и назначение при
    // переводе в работу: подбор техники — решение диспетчера. Площадка сюда не попадает, хотя
    // право правки заявки у неё есть, — на то это и отдельный маршрут, а не поле формы правки.
    title: 'заказ ТС — смена назначенной техники',
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${RECORD_ID}/assignment`,
    payload: { vehicleId: RECORD_ID, version: 1 },
    allowed: ['admin', 'manager', 'dispatcher', 'operator/vehicle_lessor'],
  },
  // Архив заказов техники (ADR 0070): распоряжаться им — не то же, что вести заявки. Заявки
  // заводят и удаляют многие, а вернуть удалённую и снести её насовсем может администратор.
  {
    title: 'заказ ТС — восстановление из архива',
    method: 'POST',
    url: `/api/v1/vehicle-requests/${RECORD_ID}/restore`,
    allowed: ['admin'],
  },
  {
    title: 'заказ ТС — удаление насовсем',
    method: 'DELETE',
    url: `/api/v1/vehicle-requests/${RECORD_ID}/purge`,
    allowed: ['admin'],
  },

  // ── Назначение исполнителя не должно обходиться общими маршрутами заявки (ADR 0010) ──
  {
    title: 'вывоз — исполнитель прямо в форме создания',
    method: 'POST',
    url: '/api/v1/waste-requests',
    payload: {
      objectId: OBJECT_ID,
      requestType: 'container_install',
      containerTypeId: RECORD_ID,
      operatorCounterpartyId: COUNTERPARTY_ID,
      deliveryAt: FUTURE_DELIVERY_AT,
      deliveryTimeUnspecified: true,
      responsibleName: 'Петров П. П.',
      responsiblePhone: '+7 926 000-00-01',
    },
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    title: 'вывоз — смена исполнителя правкой заявки',
    method: 'PATCH',
    url: `/api/v1/waste-requests/${RECORD_ID}`,
    payload: { operatorCounterpartyId: COUNTERPARTY_ID, version: 1 },
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    title: 'вывоз — создание заявки без исполнителя',
    method: 'POST',
    url: '/api/v1/waste-requests',
    payload: {
      objectId: OBJECT_ID,
      requestType: 'container_install',
      containerTypeId: RECORD_ID,
      deliveryAt: FUTURE_DELIVERY_AT,
      deliveryTimeUnspecified: true,
      responsibleName: 'Петров П. П.',
      responsiblePhone: '+7 926 000-00-01',
    },
    allowed: ['admin', 'manager', 'dispatcher', 'shtab', 'rukstroy', 'commandant', 'site'],
  },

  // ── Архив справочника: смотрит тот, кто его ведёт; возвращает из архива администратор ──
  {
    title: 'техника — восстановление из архива',
    method: 'POST',
    url: `/api/v1/vehicles/${RECORD_ID}/restore`,
    allowed: ['admin'],
  },

  // ── Файлы: доступ определяется связанной заявкой, а не ролью (authorizeInHandler) ──
  {
    title: 'файл — ссылка на скачивание',
    method: 'GET',
    url: `/api/v1/files/${RECORD_ID}/download`,
    allowed: [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'commandant',
      'site',
      'department',
      'department_head',
      'operator/operator',
      'operator/vehicle_lessor',
      'operator/service',
      'observer',
      // Водитель (ADR 0102) ходит теми же ручками: он грузит фотографии показаний и открывает
      // свои. Права роли тут ни при чём — доступ решает связь файла (Р34), и для чужого снимка
      // ответом будет 403 из обработчика, а не отказ стража.
      'driver',
      // По той же причине здесь и служба главного механика: маршрут пускает всех, кого пускает
      // связанная запись, и роль на входе не спрашивают вовсе.
      ...MECHANICS,
    ],
    checkedInHandler: true,
  },

  // ── Кабинет водителя (ADR 0102) ──
  // Второй контур портала: своя пара прав и своя, самая узкая область — «свой человек». Человек
  // берётся из принципала, поэтому в адресе его нет и подменить его нечем.
  {
    title: 'кабинет — задание на дату',
    method: 'GET',
    url: '/api/v1/driver/assignment?date=2026-08-12',
    // Администратор здесь не «тоже водитель»: у него по построению все права портала, и кабинет
    // не исключение — своей карточки у него может не быть, но право открыть ручку есть.
    allowed: ['admin', 'driver'],
  },
  {
    title: 'показания парка — журнал машины',
    method: 'GET',
    url: `/api/v1/vehicle-readings/journal/${RECORD_ID}?from=2026-08-01&to=2026-08-12`,
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    // Реестр приёма (план «Показания техники», Р26) — тем же правом, что журнал и карточка: это
    // те же данные модуля показаний, только разрезом «с кого сегодня ждут». Службе главного
    // механика он закрыт по той же причине, что и остальной модуль (Р14).
    title: 'показания парка — реестр приёма',
    method: 'GET',
    url: '/api/v1/vehicle-readings/intake?from=2026-08-01&to=2026-08-12',
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    // Пакетный приём (план «Показания техники», Р8, Р9) — правом правки, а не чтения: реестр
    // показывают все трое, но принимать день значит подписаться под чужими цифрами.
    //
    // Тело непустое намеренно: с пустым списком обработчик отвечает, ни разу не спросив БД, и
    // разрешённые роли проходили бы этот кейс, даже если бы маршрут не доходил до приёма вовсе.
    title: 'показания парка — пакетный приём отчётов',
    method: 'POST',
    url: '/api/v1/vehicle-readings/reports/accept-batch',
    payload: { reports: [{ id: RECORD_ID, version: 0 }] },
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    // Карточка машины (план «Показания техники», Р14а) — тем же правом, что журнал: в ответе
    // только статистика показаний. Службе главного механика она закрыта, и это не недосмотр:
    // сводка обслуживания приходит ей своей ручкой под `vehicleMaintenance.read`, а `vehicleReadings.read`
    // открыло бы заодно приёмку, журналы и фотографии приборных панелей (Р14).
    title: 'показания парка — карточка машины',
    method: 'GET',
    url: `/api/v1/vehicle-readings/vehicles/${RECORD_ID}/card?from=2026-08-01&to=2026-08-12`,
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    /**
     * Выгрузки (план «Показания техники», Р18) — тем же правом, что сводка и журнал: выгружают
     * ровно то, что видят на экране. Колонки ТО в варианте «Срез на дату» приходят под своим
     * правом (Р14а) уже внутри обработчика, и службе главного механика эта ручка закрыта целиком:
     * `vehicleMaintenance.read` не открывает ни журналов, ни выгрузок.
     */
    title: 'показания парка — выгрузка',
    method: 'GET',
    url: '/api/v1/vehicle-readings/export?kind=fleetSummary&from=2026-08-01&to=2026-08-12',
    allowed: ['admin', 'manager', 'dispatcher'],
  },

  // ── Техобслуживание по пробегу (план «Показания техники», Р14) ──
  // Зеркало предыдущей пары кейсов, и в этом весь смысл перечня: службе главного механика открыты
  // все шесть ручек ТО и закрыты все ручки показаний, а `vehicleReadings.read` ни одной из этих
  // ручек не открывает. Разъедься эти два перечня — и «независимое право» осталось бы независимым
  // только на бумаге.
  {
    title: 'ТО — сводка по машине',
    method: 'GET',
    url: `/api/v1/vehicle-maintenance/vehicles/${RECORD_ID}/summary?on=2026-08-12`,
    allowed: ['admin', 'manager', 'dispatcher', ...MECHANICS],
  },
  {
    title: 'ТО — состояние пакетом для колонки гаража',
    method: 'GET',
    url: `/api/v1/vehicle-maintenance/snapshot?on=2026-08-12&ids=${RECORD_ID}`,
    allowed: ['admin', 'manager', 'dispatcher', ...MECHANICS],
  },
  {
    title: 'ТО — история записей машины',
    method: 'GET',
    url: `/api/v1/vehicle-maintenance/vehicles/${RECORD_ID}/history`,
    allowed: ['admin', 'manager', 'dispatcher', ...MECHANICS],
  },
  {
    title: 'ТО — завести запись',
    method: 'POST',
    url: `/api/v1/vehicle-maintenance/vehicles/${RECORD_ID}`,
    payload: { performedOn: '2026-08-12', odometerKm: 128_400, documentNumber: 'АКТ-17' },
    allowed: ['admin', 'manager', 'dispatcher', ...MECHANICS],
  },
  {
    title: 'ТО — правка записи',
    method: 'PATCH',
    url: `/api/v1/vehicle-maintenance/${RECORD_ID}`,
    payload: { performedOn: '2026-08-12', odometerKm: 128_400, version: 0 },
    allowed: ['admin', 'manager', 'dispatcher', ...MECHANICS],
  },
  {
    title: 'ТО — удаление записи',
    method: 'DELETE',
    // Версия в адресе, а не в теле: у DELETE тела нет, и без неё схема ответила бы 400 раньше, чем
    // страж — 403 (Р30).
    url: `/api/v1/vehicle-maintenance/${RECORD_ID}?version=0`,
    allowed: ['admin', 'manager', 'dispatcher', ...MECHANICS],
  },

  // ── Администрирование ──
  { title: 'учётки — список', method: 'GET', url: '/api/v1/users', allowed: ['admin'] },
  // Архив учёток (ADR 0063): распоряжаться им — не то же, что вести учётки. Права те же, что у
  // архива справочников, и в матрице они сходятся на одном администраторе.
  {
    title: 'учётки — восстановление из архива',
    method: 'POST',
    url: `/api/v1/users/${RECORD_ID}/restore`,
    allowed: ['admin'],
  },
  {
    title: 'учётки — удаление насовсем',
    method: 'DELETE',
    url: `/api/v1/users/${RECORD_ID}/purge`,
    allowed: ['admin'],
  },
  { title: 'аудит — журнал', method: 'GET', url: '/api/v1/audit', allowed: ['admin'] },

  // ── Обмен справочниками файлом (ADR 0073) ──
  // Своё право, а не `directories.write`: выгрузка уносит справочник целиком (у водителей — с
  // персональными данными), загрузка меняет сотни строк одним действием. Диспетчер и менеджер
  // ведут справочники, но обмена файлом им не выдано.
  {
    title: 'обмен справочниками — список',
    method: 'GET',
    url: '/api/v1/directories',
    allowed: ['admin'],
  },
  {
    title: 'обмен справочниками — выгрузка',
    method: 'GET',
    url: '/api/v1/directories/objects/export',
    allowed: ['admin'],
  },
  {
    title: 'обмен справочниками — загрузка',
    method: 'POST',
    url: '/api/v1/directories/objects/import',
    payload: { dryRun: true, filename: 'objects.xlsx', contentBase64: 'UEsDBBQAAAAIAA==' },
    allowed: ['admin'],
  },
];

/**
 * Каждый запрос идёт с собственного адреса: матрица перебирает все маршруты под всеми
 * субъектами, и с одного адреса такой перебор упирается в защиту от подбора (429) — она считает
 * запросы по IP. Тест проверяет права, а не лимиты, и упереться в них он не должен.
 */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

async function request(subject: AccessSubject, c: Case) {
  currentSubject = subject;
  return app.inject({
    method: c.method,
    url: c.url,
    remoteAddress: nextAddress(),
    headers: { authorization: 'Bearer test-token' },
    ...(c.payload === undefined ? {} : { payload: c.payload as object }),
  });
}

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: 'https://portal.test',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/technic_test',
    JWT_PUBLIC_KEY_PEM: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----',
    COOKIE_SECRET: 'test-cookie-secret-value',
    CSRF_SECRET: 'test-csrf-secret-value',
    S3_ENDPOINT: 'https://s3.test.local',
    S3_BUCKET: 'test-bucket',
    S3_ACCESS_KEY_ID: 'test-key',
    S3_SECRET_ACCESS_KEY: 'test-secret',
    LOG_LEVEL: 'fatal',
  });
  const { buildApp } = await import('../src/app');
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe('доступ по субъектам — запреты', () => {
  for (const c of CASES) {
    const denied = ACCESS_PROFILES.filter((s) => !isAllowed(c, s));
    if (denied.length === 0) continue;
    it(`${c.title}: отказ для ${denied.map(keyOf).join(', ')}`, async () => {
      for (const subject of denied) {
        const res = await request(subject, c);
        expect(res.statusCode, `${keyOf(subject)} → ${c.method} ${c.url}`).toBe(403);
      }
    });
  }
});

describe('доступ по субъектам — разрешения', () => {
  for (const c of CASES) {
    // Перебираются субъекты, а не ключи перечня: профиль с надстройкой стоит в перечне лишь на
    // своих маршрутах, а пройти обязан и там, куда его пускает базовая роль (ADR 0086).
    const allowed = ACCESS_PROFILES.filter((s) => isAllowed(c, s));
    it(`${c.title}: пропускает ${allowed.map(keyOf).join(', ')}`, async () => {
      for (const subject of allowed) {
        const key = keyOf(subject);
        const res = await request(subject, c);
        // Проверка прав пройдена — дальше обработчик упирается в подменённую БД.
        expect(res.statusCode, `${key} → ${c.method} ${c.url}`).not.toBe(403);
        expect(res.statusCode, `${key} → ${c.method} ${c.url}`).not.toBe(401);
      }
    });
  }
});

describe('перечни кейсов покрывают всех, кто бывает в портале', () => {
  it('каждый субъект доступа встречается хотя бы в одном разрешении', () => {
    const uncovered = ACCESS_PROFILES.filter((s) => !CASES.some((c) => isAllowed(c, s)));
    expect(uncovered.map(keyOf)).toEqual([]);
  });

  /**
   * Ключ, которого нет ни у одного субъекта, — это опечатка, снимающая проверку молча: перебор
   * разрешений его не найдёт, а перебор запретов не отличит от «просто не перечислен».
   */
  it('в перечнях разрешений нет выдуманных субъектов', () => {
    const known = new Set<string>(PROFILE_KEYS);
    const unknown = CASES.flatMap((c) => c.allowed).filter((key) => !known.has(key));
    expect([...new Set(unknown)]).toEqual([]);
  });

  /**
   * Обратная сторона: перечень ключей, из которого выведен тип `ProfileKey`, — второй список рядом
   * с `ACCESS_PROFILES`, и отстать он может молча. Отставший тип не даёт написать кейс новой роли
   * (ключа он не примет), и роль тихо остаётся вообще без собственных разрешений — ровно так
   * `driver` и обе роли службы главного механика однажды и оказались в перечне только по факту
   * запретов. Сравнением целиком, вместе с порядком: перечни выводятся из одного и того же списка
   * ролей, и разойтись им нечем, кроме недосмотра.
   */
  it('перечень ключей совпадает с субъектами доступа из контрактов', () => {
    expect(PROFILE_KEYS).toEqual([...DECLARED_PROFILE_KEYS]);
  });

  /**
   * У каждой надстройки есть маршрут, который открывает она сама. Без этого профиль с надстройкой
   * прошёл бы весь перебор на правах базовой роли, и матрица молчала бы о том, что надстройка не
   * открывает ничего, — а ровно ради этого её и заводят.
   *
   * Заодно проверяется, что такие маршруты перечислены честно: базовой роли в них быть не должно,
   * иначе надстройка ничего не решает и её ключ в перечне лишний.
   */
  it('профиль с надстройкой разрешён там, где его базовой роли отказано', () => {
    for (const subject of ACCESS_PROFILES.filter((s) => s.addons?.length)) {
      const own = CASES.filter((c) => c.allowed.includes(keyOf(subject)));
      expect(own.length, keyOf(subject)).toBeGreaterThan(0);
      for (const c of own) expect(c.allowed, c.title).not.toContain(baseKeyOf(subject));
    }
  });
});

describe('учётка без роли', () => {
  it('не проходит ни на один маршрут, закрытый правом', async () => {
    for (const c of CASES.filter((x) => !x.checkedInHandler)) {
      const res = await request({ role: null }, c);
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(403);
    }
  });

  it('на маршрутах «по записи» доходит до обработчика — там её не видит ни одна заявка', async () => {
    for (const c of CASES.filter((x) => x.checkedInHandler)) {
      const res = await request({ role: null }, c);
      expect(res.statusCode, `${c.method} ${c.url}`).not.toBe(403);
    }
  });
});

describe('вход обязателен', () => {
  it('без токена — 401 на любом маршруте матрицы', async () => {
    for (const c of CASES) {
      const res = await app.inject({
        method: c.method,
        url: c.url,
        remoteAddress: nextAddress(),
        ...(c.payload === undefined ? {} : { payload: c.payload as object }),
      });
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(401);
    }
  });
});

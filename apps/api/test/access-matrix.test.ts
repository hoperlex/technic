import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ACCESS_PROFILES, type AccessSubject } from '@technic/contracts';

/**
 * Сквозная проверка прав: настоящие запросы к собранному приложению под каждым субъектом
 * доступа — ролью, а у внешнего исполнителя парой «роль + тип контрагента» (ADR 0038).
 *
 * Матрица (`permissions.test.ts`) отвечает на вопрос «что субъект может», страж
 * (`route-authorization.test.ts`) — «объявлена ли проверка». Здесь проверяется третье:
 * что маршрут отдаёт 403 именно тем, кому должен, — то есть что к маршруту привязано
 * правильное право, а не просто какое-нибудь.
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
  loadPrincipal: async () => ({
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
    counterpartyId: COUNTERPARTY_ID,
    counterpartyType: currentSubject.counterpartyType ?? null,
    authVersion: 1,
  }),
}));

// Валидные UUID: схемы проверяются до preHandler, и на кривом id тест увидел бы 400 вместо 403.
const OBJECT_ID = '11111111-1111-4111-8111-111111111111';
const COUNTERPARTY_ID = '22222222-2222-4222-8222-222222222222';
const RECORD_ID = '33333333-3333-4333-8333-333333333333';
/** Заявку заводят не раньше чем на завтра по МСК — берём заведомо будущую дату. */
const FUTURE_DELIVERY_AT = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();

/** Субъект текущего запроса: подменённый `loadPrincipal` возвращает его принципалу. */
let currentSubject: AccessSubject = { role: null };
let app: FastifyInstance;

/**
 * Ключ субъекта в перечнях кейсов: у исполнителя — «роль/тип контрагента», у остальных ролей
 * просто роль. Пара пишется одной строкой, потому что и разрешение у неё одно на пару: роль
 * исполнителя без типа контрагента не отвечает ни на один вопрос про доступ.
 */
type ProfileKey =
  | 'admin'
  | 'manager'
  | 'dispatcher'
  | 'shtab'
  | 'rukstroy'
  | 'commandant'
  | 'department'
  | 'department_head'
  | 'observer'
  | 'operator/operator'
  | 'operator/vehicle_lessor';

const keyOf = (s: AccessSubject): ProfileKey =>
  (s.counterpartyType ? `${s.role}/${s.counterpartyType}` : String(s.role)) as ProfileKey;

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

const CASES: Case[] = [
  // ── Водители (ADR 0037): своё право, а не `directories.*` — в карточке персональные данные ──
  {
    title: 'справочник водителей — чтение закрыто от всех, кроме ведущих заявки',
    method: 'GET',
    url: '/api/v1/drivers',
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    title: 'заведение водителя — тем же, кто выписывает путевой лист',
    method: 'POST',
    url: '/api/v1/drivers',
    payload: {
      lastName: 'Тестовый',
      firstName: 'Водитель',
      snils: '112-233-445 95',
    },
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    // Загрузка кадровой выгрузки (ADR 0047) заводит тех же людей теми же записями, что и форма
    // заведения, — отличается только количеством. Своего права у неё поэтому нет.
    title: 'загрузка кадровой выгрузки — тем же, кто заводит водителей',
    method: 'POST',
    url: '/api/v1/drivers/import',
    payload: {
      dryRun: true,
      file: { drivers: [{ fullName: 'Тестовый Водитель Водителевич', snils: '112-233-445 95' }] },
    },
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    // Отбор водителя под машину — часть формы перевода заявки в работу. Право на статусы
    // заявок ТС сюда не годится: с ADR 0038 оно есть и у арендодателя, а водителей нашего
    // парка он не назначает — путевой лист выписывается только на собственные машины.
    title: 'отбор водителей под машину — тем же, кто ведёт водителей',
    method: 'GET',
    url: '/api/v1/drivers/available?vehicleId=00000000-0000-4000-8000-000000000000&on=2026-08-03',
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    title: 'замена удостоверения — тем же, кто ведёт водителей',
    method: 'POST',
    url: `/api/v1/drivers/${RECORD_ID}/licenses`,
    payload: {
      number: '482645',
      categories: [{ categoryId: '55555555-5555-4555-8555-555555555555' }],
    },
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    title: 'отметка проверки документа — тем же, кто ведёт водителей',
    method: 'POST',
    url: `/api/v1/drivers/${RECORD_ID}/licenses/${RECORD_ID}/verify`,
    payload: { verificationStatus: 'verified' },
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    title: 'аннулирование удостоверения — тем же, кто ведёт водителей',
    method: 'POST',
    url: `/api/v1/drivers/${RECORD_ID}/licenses/${RECORD_ID}/revoke`,
    payload: { revokeReason: 'лишение права управления' },
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  // ── Путевые листы (ADR 0037): журнал и аннулирование — своими правами ──
  {
    title: 'журнал путевых листов — закрыт от всех, кроме ведущих заявки',
    method: 'GET',
    url: '/api/v1/waybills',
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    title: 'аннулирование листа — своим правом',
    method: 'POST',
    url: `/api/v1/waybills/${RECORD_ID}/cancel`,
    payload: { reason: 'испорчен при печати' },
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    // Печать уносит из портала СНИЛС и номер удостоверения ровно так же, как выгрузка файлом
    // (ADR 0037 п. 13, ADR 0041): право у неё то же, и шире круг быть не может.
    title: 'печать бланка — тем же правом, что чтение журнала',
    method: 'GET',
    url: `/api/v1/waybills/${RECORD_ID}/print`,
    allowed: ['admin', 'manager', 'dispatcher'],
  },
  {
    title: 'листы заявки в карточке — правом на листы, а не на заявки',
    method: 'GET',
    url: `/api/v1/vehicle-requests/${RECORD_ID}/waybills`,
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
    payload: { vehicleId: RECORD_ID, routeDate: '2026-08-03' },
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
  // ── Справочники: чтение нужно всем (форма заявки), ведение — трём ролям ──
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
      'department',
      'department_head',
      'operator/operator',
      'operator/vehicle_lessor',
      'observer',
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
      'department',
      'department_head',
      'operator/operator',
      'operator/vehicle_lessor',
      'observer',
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
      'department',
      'department_head',
      'operator/operator',
      'operator/vehicle_lessor',
      'observer',
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
      'department',
      'department_head',
      'operator/operator',
      'operator/vehicle_lessor',
      'observer',
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

  // ── Вывоз мусора: раньше модуль был открыт любому вошедшему ──
  {
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
      'operator/operator',
      'observer',
    ],
  },
  {
    title: 'вывоз — удаление заявки',
    method: 'DELETE',
    url: `/api/v1/waste-requests/${RECORD_ID}`,
    allowed: ['admin', 'manager', 'dispatcher', 'shtab', 'rukstroy', 'commandant'],
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
    allowed: ['admin', 'manager', 'dispatcher', 'shtab', 'rukstroy', 'commandant'],
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
      'department',
      'department_head',
      'operator/operator',
      'operator/vehicle_lessor',
      'observer',
    ],
    checkedInHandler: true,
  },

  // ── Администрирование ──
  { title: 'учётки — список', method: 'GET', url: '/api/v1/users', allowed: ['admin'] },
  { title: 'аудит — журнал', method: 'GET', url: '/api/v1/audit', allowed: ['admin'] },
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
    const denied = ACCESS_PROFILES.filter((s) => !c.allowed.includes(keyOf(s)));
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
    it(`${c.title}: пропускает ${c.allowed.join(', ')}`, async () => {
      for (const key of c.allowed) {
        const subject = ACCESS_PROFILES.find((s) => keyOf(s) === key);
        expect(subject, `неизвестный субъект ${key}`).toBeDefined();
        const res = await request(subject!, c);
        // Проверка прав пройдена — дальше обработчик упирается в подменённую БД.
        expect(res.statusCode, `${key} → ${c.method} ${c.url}`).not.toBe(403);
        expect(res.statusCode, `${key} → ${c.method} ${c.url}`).not.toBe(401);
      }
    });
  }
});

describe('перечни кейсов покрывают всех, кто бывает в портале', () => {
  it('каждый субъект доступа встречается хотя бы в одном разрешении', () => {
    const mentioned = new Set(CASES.flatMap((c) => c.allowed));
    expect(PROFILE_KEYS.filter((k) => !mentioned.has(k))).toEqual([]);
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

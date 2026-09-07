import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  encodeEquipmentChangesCursor,
  encodeEquipmentMovementsCursor,
  encodeEquipmentRequestsCursor,
  equipmentRequestOutcomeOf,
  equipmentRequestSummary,
  EQUIPMENT_WARRANTY_CHANGE_FIELD,
  formatServiceRequestNumber,
  projectEquipmentRequestRowForAudience,
  type EquipmentChangeRowDto,
  type EquipmentChangesCursor,
  type EquipmentChangesPageDto,
  type EquipmentMovementRowDto,
  type EquipmentMovementsCursor,
  type EquipmentMovementsPageDto,
  type EquipmentRequestRowDto,
  type EquipmentRequestsCursor,
  type EquipmentRequestsPageDto,
  type OfficeEquipmentItemWarrantyDto,
  type RequestChangeDto,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  auditLog,
  constructionObjects,
  counterparties,
  departments,
  officeEquipmentMovements,
  serviceRequestExecutors,
  serviceRequestItems,
  serviceRequests,
  users,
} from '../db/schema';
import { serviceRequestVisibilityWhere } from '../lib/access';
import { serviceAudienceByRequest } from './service-request-audience';
import { confirmedPlaceByRequest } from './service-request-place';
import type { Principal } from '../auth/principal';

/**
 * Три бизнес-блока истории единицы оргтехники (план
 * `docs/office-equipment-history-blocks-plan.md`, §4, Р1–Р5, Р8–Р10).
 *
 * Read model поверх тех же таблиц, что и лента (`office-equipment-history.ts`), а не вторая
 * правда: своей записи и своего понятия «что случилось» у блоков нет. Лента остаётся каноническим
 * аудитом и режимом «Полная история» — ни один её источник этим файлом не снимается (К2).
 *
 * ОБЛАСТЬ ТА ЖЕ, ЧТО У ЛЕНТЫ, И НИ ОДНОГО НОВОГО ПРАВИЛА ВИДИМОСТИ (К3). Ремонтная часть —
 * `serviceRequestVisibilityWhere`, то есть **область заявок**, а не справочника: у ролей отдела это
 * разные области (справочник по владельцу техники, заявки по заказчику), и показать здесь заявку
 * соседнего отдела значило бы обойти модуль через справочник. Всё остальное — область КАРТОЧКИ,
 * которую держит сам маршрут (`requireHistoryEquipment`): карточка открыта — открыты её журнал
 * перемещений и её правки, ровно как сегодня у ленты.
 *
 * ПОЧЕМУ ТРИ ФУНКЦИИ, А НЕ ОДНА С ПАРАМЕТРОМ. У блоков разные источники, разные ключи порядка и
 * разные курсоры (Р1, Р8): общая функция свелась бы к `switch` на три несовместимых тела, а
 * вызывающему пришлось бы разбирать размеченное объединение ради каждой вкладки.
 *
 * ПРЕДЕЛЫ БОЛЬШЕ НЕ ОБЩИЕ (Р9, закрывает Н3). Каждый блок читает свою таблицу со своим
 * `pageSize + 1`, и «есть ли ещё» здесь — точный ответ базы, а не следствие слияния шести
 * источников под общим потолком: у ленты старые шаги могли не попасть в страницу, потому что предел
 * выбрали соседи, у блока такого не бывает.
 */

const fromObjects = alias(constructionObjects, 'blocks_from_objects');
const toObjects = alias(constructionObjects, 'blocks_to_objects');
const fromDepartments = alias(departments, 'blocks_from_departments');
const toDepartments = alias(departments, 'blocks_to_departments');
const movers = alias(users, 'blocks_movers');
const actors = alias(users, 'blocks_actors');
const executorUsers = alias(users, 'blocks_executor_users');

/**
 * Дата без времени в человеческом виде. Свой четырёхстрочник, а не импорт из
 * `office-equipment-diff.ts`: тамошний `dateOnly` не экспортирован, а расширять чужой модуль ради
 * одной строки — трогать файл, который правит соседний план. Через JS `Date` дата поехала бы на
 * день: `YYYY-MM-DD` — это календарные сутки, а не момент времени.
 */
function dateOnly(value: string | null): string {
  if (!value) return '—';
  const [y, m, d] = value.split('-');
  return y && m && d ? `${d}.${m}.${y}` : value;
}

interface CardAuditMetadata {
  changes?: RequestChangeDto[];
  warrantyChange?: { from: string | null; until: string | null };
}

function metadataOf(value: unknown): CardAuditMetadata {
  return value && typeof value === 'object' ? (value as CardAuditMetadata) : {};
}

/** Страница = «взяли на одну строку больше»: она же и есть ответ на вопрос «а есть ли ещё». */
function pageOf<T>(rows: T[], pageSize: number): { page: T[]; hasMore: boolean } {
  return { page: rows.slice(0, pageSize), hasMore: rows.length > pageSize };
}

// ── Блок «Связанные заявки» ──

/**
 * Заявки по аппарату — одна заявка одной строкой (К1, закрывает Н1 и Н2).
 *
 * Карточка единицы приходит аргументом, а не читается заново: маршрут уже прочитал её ради области
 * (`requireHistoryEquipment`), и второй поход за той же строкой стоил бы пятого запроса ради
 * значения, которое лежит в руке. `objectId` нужен признаку расхождения площадок ниже.
 *
 * БЮДЖЕТ ЗАПРОСОВ — ЧЕТЫРЕ НА СТРАНИЦУ, И НЕ БОЛЬШЕ (Р10, К8), при любом числе строк:
 *   1. сама страница со всеми полями строки;
 *   2. исполнители пачкой по идентификаторам страницы (образец — `executorsByRequest` в маршруте
 *      заявок);
 *   3. действующие гарантии позиций — той же пачкой (образец — `loadServiceHistory` в маршруте
 *      справочника);
 *   4. аудитория страницы (`serviceAudienceByRequest`), и то лишь когда читателю право исполнения
 *      вообще что-то открывает: без `serviceRequests.execute` она не ходит в базу вовсе.
 *
 * Пустая страница стоит одного запроса: догрузки по пустому списку идентификаторов не идут никуда.
 *
 * Ни одного коррелированного подзапроса в списке столбцов — и это не вкусовщина: драйвер
 * переписывает колонки односоставного запроса в голые идентификаторы, и корреляция, вписанная в
 * выражение столбца, разрешается уже в таблицу подзапроса молча, без единой ошибки
 * (`office-equipment-sql-correlation.test.ts`).
 */
export async function loadEquipmentRequestsPage(
  p: Principal,
  equipment: { id: string; objectId: string },
  opts: { cursor: EquipmentRequestsCursor | null; pageSize: number },
): Promise<EquipmentRequestsPageDto> {
  const rows = await db
    .select({
      id: serviceRequests.id,
      num: serviceRequests.num,
      kind: serviceRequests.kind,
      status: serviceRequests.status,
      description: serviceRequests.description,
      createdAt: serviceRequests.createdAt,
      updatedAt: serviceRequests.updatedAt,
      totalAmount: serviceRequests.finalTotalAmount,
      replacementRecommended: serviceRequests.replacementRecommended,
      rejectionResolution: serviceRequests.rejectionResolution,
      warrantyClaimSource: serviceRequests.warrantyClaimSource,
      objectOverridden: serviceRequests.objectOverridden,
      equipmentObjectId: serviceRequests.equipmentObjectId,
      serviceName: counterparties.name,
      // Не для показа, а для аудитории строки (ADR 0160): назначенная субъекту заявка отдаёт ему
      // сумму ремонта, соседняя в том же блоке — нет.
      serviceCounterpartyId: serviceRequests.serviceCounterpartyId,
    })
    .from(serviceRequests)
    .leftJoin(counterparties, eq(serviceRequests.serviceCounterpartyId, counterparties.id))
    .where(
      and(
        eq(serviceRequests.officeEquipmentId, equipment.id),
        // Архивные (снесённые) заявки блок не показывает никому — умолчание плана (В3): сегодня их
        // не показывает и лента, и расширять область блоком план не берётся.
        isNull(serviceRequests.deletedAt),
        serviceRequestVisibilityWhere(p),
        // Порядок и курсор — одна пара «дата + идентификатор» (Р8). Кортежем, а не тремя
        // условиями: так сравнение читается тем же, чем сортировка, и индекс по паре работает.
        opts.cursor
          ? sql`(${serviceRequests.createdAt}, ${serviceRequests.id})
                < (${opts.cursor.createdAt}::timestamptz, ${opts.cursor.id}::uuid)`
          : undefined,
      ),
    )
    // По `created_at`, а НЕ по `updated_at`, и это решение (Р8): правка старой заявки перетасовала
    // бы уже прочитанные страницы, и «показать ещё» повторяло бы строки. `updated_at` показывается
    // колонкой, но порядка не задаёт.
    .orderBy(desc(serviceRequests.createdAt), desc(serviceRequests.id))
    .limit(opts.pageSize + 1);

  const { page, hasMore } = pageOf(rows, opts.pageSize);
  const ids = page.map((row) => row.id);

  // Три догрузки одной пачкой и параллельно: вход у всех трёх один — идентификаторы страницы, и
  // ждать их по очереди незачем.
  const [executors, warranties, audiences, confirmedPlaces] = await Promise.all([
    executorNamesByRequest(ids),
    activeItemWarrantiesByRequest(ids),
    serviceAudienceByRequest(p, page),
    /*
     * Подтверждения заявленного места (план перемещения, Р8) — пятой пакетной догрузкой, а не
     * коррелированным подзапросом в списке столбцов: такой подзапрос drizzle собирает молча
     * неверно, и модуль на этом уже обжигался. Запрос идёт параллельно остальным, цепочку не
     * удлиняет и считает то же самое, что DTO заявки, — одним модулем на оба места.
     */
    confirmedPlaceByRequest(ids),
  ]);

  const items = page.map((row) => {
    const dto: EquipmentRequestRowDto = {
      id: row.id,
      displayNumber: formatServiceRequestNumber(row.num),
      kind: row.kind,
      summary: equipmentRequestSummary(row.description),
      // Контрагент первым, поимённые за ним: так строку и читают вслух — «сервис такой-то, ведёт
      // Иванов». Пустой список означает «ещё не назначена», и это честный ответ, а не пропуск.
      executors: [...(row.serviceName ? [row.serviceName] : []), ...(executors.get(row.id) ?? [])],
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      status: row.status,
      // Итог считает сервер и отдаёт кодом со словарной подписью (Р2, Н12): собери мы фразу с
      // суммой, проекция аудитории обнулила бы `totalAmount`, а цифра осталась бы в тексте.
      outcome: equipmentRequestOutcomeOf(row),
      totalAmount: row.totalAmount === null ? null : Number(row.totalAmount),
      warranties: warranties.get(row.id) ?? [],
      /*
       * «Заявляли, что аппарат стоит не там, и не разобрали» — то же выражение, что в DTO заявки:
       * хранимая пометка И живое расхождение снимка со справочником. Порознь оба признака отвечают
       * неверно: хранимый сам не гаснет ничем, а вычисляемый у прошлогодних заявок расходится
       * сплошь и рядом, хотя никто ничего не заявлял.
       *
       * Карточка сравнивается ТА, ЧЬЮ историю открыли: блок живёт внутри одной единицы, и её
       * `object_id` уже прочитан маршрутом — соединение со справочником ради того же значения было
       * бы вторым путём к первому.
       *
       * ТРЕТИЙ ЧЛЕН (план п. 12, Р8) на месте: расхождение считается неразобранным, только пока по
       * заявке нет подтверждающего перемещения. Считает его тот же модуль, что и DTO заявки
       * (`services/service-request-place.ts`), — два понятия расхождения, посчитанные порознь,
       * разъехались бы молча, и ИТ-служба видела бы в очереди одно, а в истории аппарата другое.
       */
      objectMismatch:
        row.objectOverridden &&
        row.equipmentObjectId !== equipment.objectId &&
        !confirmedPlaces.has(row.id),
    };
    /*
     * Аудитория применяется К СТРАНИЦЕ — после отбора, курсора и сортировки (Р5), ровно как в
     * ленте. Деньги не влияют ни на состав, ни на порядок, и курсор не зависит от того, кто читает:
     * иначе «показать ещё» у заявителя и у финансиста разъехалось бы на одних и тех же данных.
     *
     * Строке без посчитанной аудитории достаётся `requester` — самая узкая: fail-closed здесь стоит
     * ровно столько же, сколько fail-open, а цена ошибки у них разная.
     */
    return projectEquipmentRequestRowForAudience(dto, audiences.get(row.id) ?? 'requester');
  });

  const last = page[page.length - 1];
  return {
    items,
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeEquipmentRequestsCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null,
  };
}

/**
 * Поимённые исполнители страницы — одной пачкой (Р10). Соединением в самой странице их брать
 * нельзя: их несколько на заявку, и `leftJoin` размножил бы строки заголовка, испортив и порядок,
 * и предел «страница плюс один».
 */
async function executorNamesByRequest(ids: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({
      requestId: serviceRequestExecutors.requestId,
      name: executorUsers.fullName,
    })
    .from(serviceRequestExecutors)
    .innerJoin(executorUsers, eq(serviceRequestExecutors.userId, executorUsers.id))
    .where(inArray(serviceRequestExecutors.requestId, ids))
    // Порядок назначения, а не алфавит: первым назначили — первым и назван. Имя вторым ключом ради
    // устойчивости: два назначения одной секундой иначе менялись бы местами от запроса к запросу.
    .orderBy(serviceRequestExecutors.assignedAt, executorUsers.fullName);
  for (const row of rows) {
    const list = map.get(row.requestId) ?? [];
    list.push(row.name);
    map.set(row.requestId, list);
  }
  return map;
}

/**
 * Действующие гарантии позиций страницы — той же пачкой (Р10, Р6).
 *
 * Только выполненные и только не истёкшие: гарантия на невыполненную позицию невозможна, а
 * истёкшая — уже история, и её место в «Полной истории» отдельным событием (К5). Отбор дословно
 * повторяет `loadServiceHistory`, потому что блок эту секцию и заменяет (Р7): разойдись правило,
 * карточка и вкладка назвали бы разные гарантии одной заявки.
 */
async function activeItemWarrantiesByRequest(
  ids: string[],
): Promise<Map<string, OfficeEquipmentItemWarrantyDto[]>> {
  const map = new Map<string, OfficeEquipmentItemWarrantyDto[]>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({
      requestId: serviceRequestItems.requestId,
      itemId: serviceRequestItems.id,
      name: serviceRequestItems.name,
      warrantyUntil: serviceRequestItems.warrantyUntil,
    })
    .from(serviceRequestItems)
    .where(
      and(
        inArray(serviceRequestItems.requestId, ids),
        eq(serviceRequestItems.performed, true),
        isNotNull(serviceRequestItems.warrantyUntil),
        sql`${serviceRequestItems.warrantyUntil} >= CURRENT_DATE`,
      ),
    )
    .orderBy(serviceRequestItems.sortOrder);
  for (const row of rows) {
    const list = map.get(row.requestId) ?? [];
    list.push({ itemId: row.itemId, name: row.name, warrantyUntil: row.warrantyUntil! });
    map.set(row.requestId, list);
  }
  return map;
}

// ── Блок «Ручные правки» ──

/**
 * Правки карточки: что человек изменил в реквизитах, кто и когда (Р3).
 *
 * Принципал сюда не передаётся, и это не забывчивость: область блока — область КАРТОЧКИ, и её уже
 * проверил маршрут (`requireHistoryEquipment`), как проверяет её для ленты. Второй предикат по тому
 * же вопросу разошёлся бы с первым молча.
 *
 * Один запрос на страницу. Жизненный цикл (заведение, архивирование, восстановление) сюда не
 * входит — он остаётся в шапке экрана и в полной истории (Р6), поэтому и лишних действий из
 * `audit_log` читать не нужно. Отбор идёт по `audit_log_entity_idx (entity_type, entity_id,
 * created_at)`, действие — фильтром поверх него: у одной карточки записей десятки, и частичный
 * индекс по действию окупился бы только на порядок больших объёмах (§7).
 */
export async function loadEquipmentChangesPage(
  equipmentId: string,
  opts: { cursor: EquipmentChangesCursor | null; pageSize: number },
): Promise<EquipmentChangesPageDto> {
  const rows = await db
    .select({
      id: auditLog.id,
      metadata: auditLog.metadata,
      createdAt: auditLog.createdAt,
      actorName: actors.fullName,
    })
    .from(auditLog)
    .leftJoin(actors, eq(auditLog.actorUserId, actors.id))
    .where(
      and(
        eq(auditLog.entityType, 'officeEquipment'),
        eq(auditLog.entityId, equipmentId),
        eq(auditLog.action, 'officeEquipment.update'),
        opts.cursor
          ? sql`(${auditLog.createdAt}, ${auditLog.id})
                < (${opts.cursor.at}::timestamptz, ${opts.cursor.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(opts.pageSize + 1);

  const { page, hasMore } = pageOf(rows, opts.pageSize);
  const items: EquipmentChangeRowDto[] = page.map((row) => {
    const meta = metadataOf(row.metadata);
    /*
     * Гарантия поставщика — такая же правка реквизита, и здесь она встаёт в тот же список (Р3,
     * закрывает Н7). В ЛЕНТЕ она остаётся отдельным событием `warranty`, и двоения в этом нет: там
     * вопрос «что происходило с гарантией» — вместе с истечением и гарантиями ремонтов, — а тут
     * «что правил человек». Строка одна на запись аудита: одно действие — одна правка, даже если
     * человек тем же нажатием передвинул и срок, и место.
     */
    const warranty = meta.warrantyChange;
    const changes: RequestChangeDto[] = [
      ...(meta.changes ?? []),
      ...(warranty
        ? [
            {
              field: EQUIPMENT_WARRANTY_CHANGE_FIELD,
              from: dateOnly(warranty.from),
              to: dateOnly(warranty.until),
            },
          ]
        : []),
    ];
    // Пустой список — не пропуск строки, а её содержание: записи до появления `officeEquipmentDiff`
    // деталей не несут (Н5), и прятать их нельзя. «Правок не было» и «правки были, но подробностей
    // не сохранилось» — разные утверждения, и первое было бы неправдой.
    return {
      id: row.id,
      at: row.createdAt.toISOString(),
      actorName: row.actorName,
      changes,
    };
  });

  const last = page[page.length - 1];
  return {
    items,
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeEquipmentChangesCursor({ at: last.createdAt.toISOString(), id: last.id })
        : null,
  };
}

// ── Блок «Перемещения» ──

/**
 * Перемещения: откуда, куда, когда и почему (Р4).
 *
 * Единственный из трёх блоков, где событие и строка совпадают один в один: строка ничего к журналу
 * не добавляет и ничего из него не прячет — включая уточнение состояния обеими сторонами и признак
 * «подтверждено заявленное место» (план п. 12, Р5 и Р8; миграция 0275). Область — область карточки,
 * проверенная маршрутом; денег в журнале нет ни одного поля, поэтому и проекции по аудиториям здесь
 * нет (Р5).
 *
 * Один запрос на страницу: все соединения отдают по одной строке на перемещение (обе площадки, оба
 * отдела, автор и номер связанной заявки), поэтому предел «страница плюс один» считает именно
 * перемещения, а не строки соединения.
 *
 * Номер связанной заявки приходит соединением БЕЗ проверки видимости заявок — ровно как в ленте, и
 * это осознанно, а не пропуск: «переехал по заявке СО-14» отвечает на вопрос «почему аппарат не на
 * месте», номер не выдаёт ни суммы, ни содержания, и правило здесь то же самое, что действует
 * сегодня. Новых правил видимости блоки не заводят (К3).
 */
export async function loadEquipmentMovementsPage(
  equipmentId: string,
  opts: { cursor: EquipmentMovementsCursor | null; pageSize: number },
): Promise<EquipmentMovementsPageDto> {
  const rows = await db
    .select({
      m: officeEquipmentMovements,
      fromObject: { id: fromObjects.id, code: fromObjects.code, name: fromObjects.name },
      toObject: { id: toObjects.id, code: toObjects.code, name: toObjects.name },
      fromDepartment: {
        id: fromDepartments.id,
        code: fromDepartments.code,
        name: fromDepartments.name,
      },
      toDepartment: { id: toDepartments.id, code: toDepartments.code, name: toDepartments.name },
      movedByName: movers.fullName,
      requestNum: serviceRequests.num,
    })
    .from(officeEquipmentMovements)
    .innerJoin(fromObjects, eq(officeEquipmentMovements.fromObjectId, fromObjects.id))
    .innerJoin(toObjects, eq(officeEquipmentMovements.toObjectId, toObjects.id))
    .leftJoin(fromDepartments, eq(officeEquipmentMovements.fromDepartmentId, fromDepartments.id))
    .leftJoin(toDepartments, eq(officeEquipmentMovements.toDepartmentId, toDepartments.id))
    .innerJoin(movers, eq(officeEquipmentMovements.movedBy, movers.id))
    .leftJoin(serviceRequests, eq(officeEquipmentMovements.serviceRequestId, serviceRequests.id))
    .where(
      and(
        eq(officeEquipmentMovements.equipmentId, equipmentId),
        // Тройка, а не пара (Р8): `moved_on` — бизнес-дата («увезли в пятницу»), порядка записи она
        // не задаёт, два переезда одного дня различает время записи, а совпадение и его — `id`.
        opts.cursor
          ? sql`(${officeEquipmentMovements.movedOn}, ${officeEquipmentMovements.createdAt}, ${officeEquipmentMovements.id})
                < (${opts.cursor.movedOn}::date, ${opts.cursor.createdAt}::timestamptz, ${opts.cursor.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(
      desc(officeEquipmentMovements.movedOn),
      desc(officeEquipmentMovements.createdAt),
      desc(officeEquipmentMovements.id),
    )
    .limit(opts.pageSize + 1);

  const { page, hasMore } = pageOf(rows, opts.pageSize);
  const items: EquipmentMovementRowDto[] = page.map((row) => ({
    id: row.m.id,
    movedOn: row.m.movedOn,
    fromObject: row.fromObject,
    toObject: row.toObject,
    // Соединение необязательное: отдела у стороны может не быть вовсе («не закреплена»). Пустая
    // ссылка узнаётся по `id`, а не по самому объекту: drizzle отдаёт у `leftJoin` объект с полями
    // `null`, и проверка «строка есть» дала бы отдел без названия.
    fromDepartment: row.fromDepartment?.id ? row.fromDepartment : null,
    toDepartment: row.toDepartment?.id ? row.toDepartment : null,
    fromLocation: row.m.fromLocation,
    toLocation: row.m.toLocation,
    fromState: row.m.fromState,
    toState: row.m.toState,
    fromStateNote: row.m.fromStateNote,
    toStateNote: row.m.toStateNote,
    reason: row.m.reason,
    comment: row.m.comment,
    serviceRequestId: row.m.serviceRequestId,
    serviceRequestNum: row.requestNum,
    confirmsDeclaredPlace: row.m.confirmsDeclaredPlace,
    movedByName: row.movedByName,
    createdAt: row.m.createdAt.toISOString(),
  }));

  const last = page[page.length - 1];
  return {
    items,
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeEquipmentMovementsCursor({
            movedOn: last.m.movedOn,
            createdAt: last.m.createdAt.toISOString(),
            id: last.m.id,
          })
        : null,
  };
}

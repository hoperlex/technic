import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, count, eq, type SQL } from 'drizzle-orm';
import {
  changeMechRequestStatusSchema,
  createMechRequestSchema,
  duplicateMechRequestSchema,
  extendMechRequestSchema,
  isClosedRequestStatus,
  isMechAwaitingIssue,
  isMechCompletionCorrection,
  isMechRentalRunning,
  issueMechRequestSchema,
  MECH_DELETE_RUNNING_MESSAGE,
  MECH_EXTEND_NOT_LATER_MESSAGE,
  MECH_NO_COMPLETED_STATUS_MESSAGE,
  type MechRequestDto,
  type MechRequestHistoryQuery,
  mechDeleteScope,
  mechEditScope,
  mechRequestHistoryQuerySchema,
  mechRequestListQuerySchema,
  mechRequestSummaryQuerySchema,
  mechTransitionBlocker,
  mechTransitionResetsDeal,
  moscowDateKeyOf,
  type RequestStatus,
  requestStatusLabels,
  revokeMechIssueSchema,
  updateMechDealSchema,
  updateMechRequestSchema,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  constructionObjects,
  mechModels,
  mechRequestStatusHistory,
  mechRequests,
  users,
} from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit, writeAuditTx } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import type { Principal } from '../auth/principal';
import {
  assertArchiveVisible,
  assertObjectRoleEditable,
  assertPlaceObjectScope,
  assertTransitionAllowed,
  MECH_SCOPE_LABEL,
} from '../lib/access';
import { orderByFrom, pageParams } from '../lib/pagination';
import { hardDeleteFiles } from '../services/request-files';
import {
  loadMechRequestDto,
  mechBaseQuery,
  mechFilesByRequestIds,
  toMechRequestDto,
} from '../services/mech-request-dto';
import {
  assertMechLessorAssignable,
  assertMechModelAssignable,
  assertMechPairAssignable,
  assertMechRequesterAllowed,
  assertMechRequestLive,
  assertMechRequestOpenable,
  lockMechRequest,
} from '../services/mech-request-guards';
import {
  collectMechRequestFiles,
  linkMechRequestFiles,
  unlinkMechRequestFiles,
} from '../services/mech-request-files';
import {
  loadMechHistorySummary,
  loadMechSummary,
  mechHistorySortColumns,
  mechHistoryWhere,
  mechListSortColumns,
  mechListWhere,
} from '../services/mech-request-list';
import { MECH_HISTORY_EXPORT_LIMIT, mechHistoryWorkbook } from '../services/mech-history-export';
import { NO_MECH_FACT, planMechTransition } from '../services/mech-request-transition';
import {
  diffMechRequests,
  mechAuditSnapshot,
  mechCompletionChanges,
  mechDealChanges,
  mechExtendChanges,
  mechIssueChanges,
  mechIssueRevokeChanges,
} from '../services/mech-request-diff';
import { loadMechRequestHistory } from '../services/mech-request-history';

/*
 * Аренда малой механизации (план `docs/mechanization-module-plan.md`): виброплиты, компрессоры,
 * генераторы — всё, что стоит на площадке неделями и стоит денег каждый день.
 *
 * Три особенности модуля, о которые спотыкается всякий, кто читает его впервые:
 *
 * 1. **Заявка и есть аренда** (Р1). Одна строка описывает просьбу, договорённость, саму аренду и её
 *    итог; отдельной записи состояния нет. Статусы названы заказчиком, четвёртого не будет, поэтому
 *    «договорились» и «техника стоит на объекте» разведены ПОЛЯМИ (`actualFrom`, `actualTo`), а не
 *    статусом — предикаты живут в контрактах (`isMechRentalRunning` и соседи) и спрашиваются
 *    одинаково здесь, в портале и в частичном индексе базы.
 * 2. **Барьеров правки и удаления три, и они независимы** (Р19): состояние записи (Б1,
 *    `mechEditScope`/`mechDeleteScope`), роль заявителя (Б2, `assertObjectRoleEditable`) и
 *    удалённость (Б3, `assertMechRequestLive`). Запрос обязан пройти все: Б1 отвечает «что вообще
 *    можно делать с записью в таком состоянии», Б2 — «кому из ролей это разрешено», Б3 — «а эта
 *    строка вообще жива».
 * 3. **Все мутации идут одним протоколом** (Р21): транзакция → `SELECT ... FOR UPDATE` ПЕРВЫМ
 *    действием (`lockMechRequest`) → существование, область, авторизация и сверка версии
 *    (`assertMechRequestOpenable`) → барьеры и доменный предикат → запись. Порядок последних двух
 *    шагов не косметика: поставь барьеры раньше версии, и обещанный 409 не наступил бы никогда.
 *
 * Разведение ответов: **409 — «данные под тобой изменились, перечитай карточку»; 422 — «правило
 * запрещает это действие»**.
 *
 * Продление живёт своим правом (`mechRequests.extend`, диспетчер), а не `.status` и не `.update`:
 * оно не двигает заявку по циклу и не правит форму — это согласие платить дальше (Р9).
 */

const idParams = z.object({ id: z.string().uuid() });

/**
 * Чем отвечает повтор того же статуса, если к нему приложено содержимое (Р21). Пары «поле → отказ»
 * перечислены здесь, а не строятся в обработчике, потому что у каждого из трёх содержимых своя
 * законная дверь, и назвать её обязан сам отказ: без этого человек, чей ход не состоялся, повторял
 * бы его тем же способом.
 *
 * Порядок перебора — порядок цикла: договорённость, выдача, факт возврата. Схема тела уже развела
 * их по статусам (`deal` и `actualFrom` бывают только у «В работе», `completion` — только у
 * «Выполнена»), поэтому одновременно сработать может лишь пара первых двух, и назвать одну из них
 * достаточно: вторая приедет следующим отказом.
 */
const SAME_STATUS_REFUSALS: [
  field: 'deal' | 'actualFrom' | 'completion',
  message: string,
  hint: string,
][] = [
  [
    'deal',
    'Заявка уже в работе: арендодателя и ставку правят отдельным действием, а не повторным переводом в работу',
    'Исправьте договорённость отдельно',
  ],
  [
    'actualFrom',
    'Заявка уже в работе: выдачу отмечают отдельным действием',
    'Отметьте выдачу отдельно',
  ],
  [
    'completion',
    'Заявка уже завершена: чтобы исправить факт, откатите её в «В работе» и завершите заново',
    'Сначала откатите заявку',
  ],
];

/**
 * Версия у маршрутов без тела (удаление, удаление насовсем). Клиентская версия обязательна у всякой
 * мутации существующей строки (Р21), а `DELETE` тела не носит — тот же приём, что у удаления точки
 * маршрута и акта обслуживания. `coerce`: в строке запроса число приходит текстом.
 */
const versionQuery = z.object({ version: z.coerce.number().int().nonnegative() });

/** Восстановление из архива — тоже мутация, и версия ей нужна наравне с прочими (Р21). */
const restoreBody = z.object({ version: z.number().int().nonnegative() });

export default async function mechRequestsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  // Право на каждое действие отдельно (ADR 0021). Договорённость, выдача и снятие отметки закрыты
  // правом смены статуса: это работа офиса, а не правка формы, и через общий `PATCH` их пустил бы
  // барьер роли, который площадке правку «Новой» разрешает.
  const auth = { preHandler: [app.authenticate, app.requirePermission('mechRequests.read')] };
  const canCreate = {
    preHandler: [
      app.authenticate,
      app.requirePermission('mechRequests.create', 'Недостаточно прав для создания заявки'),
    ],
  };
  const canUpdate = {
    preHandler: [
      app.authenticate,
      app.requirePermission('mechRequests.update', 'Недостаточно прав для редактирования заявки'),
    ],
  };
  const canDelete = {
    preHandler: [
      app.authenticate,
      app.requirePermission('mechRequests.delete', 'Недостаточно прав для удаления заявки'),
    ],
  };
  const canChangeStatus = {
    preHandler: [
      app.authenticate,
      app.requirePermission('mechRequests.status', 'Недостаточно прав для смены статуса'),
    ],
  };
  // Продление — своё право, и разведено оно со сменой статуса намеренно (Р9): срок не двигает
  // заявку по циклу, а означает согласие платить дальше, и звонит арендодателю с этим диспетчер, а
  // не менеджер. Спроси здесь `.status` — и право `.extend` перестало бы что-либо значить.
  const canExtend = {
    preHandler: [
      app.authenticate,
      app.requirePermission('mechRequests.extend', 'Недостаточно прав для продления аренды'),
    ],
  };

  r.get('/', { ...auth, schema: { querystring: mechRequestListQuerySchema } }, async (req) => {
    const p = requirePrincipal(req);
    const q = req.query;
    // «Сегодня» вычисляется один раз на запрос и по московскому календарю (Р12): сервер живёт в
    // UTC, а человек нет, и с 00:00 до 03:00 МСК эти два календаря показывают разные дни.
    const where = mechListWhere(p, q, moscowDateKeyOf(new Date()));
    const page = pageParams(q);
    // Сортировка по неуникальному столбцу сама по себе не задаёт порядок строк с одинаковым
    // значением: между запросами страниц они переставятся, и часть заявок задвоится, а часть
    // пропадёт. num + id доводят сортировку до полной.
    const rows = await mechBaseQuery()
      .where(where)
      .orderBy(
        orderByFrom(mechListSortColumns, q.sortBy, q.sortOrder, 'createdAt'),
        asc(mechRequests.num),
        asc(mechRequests.id),
      )
      .limit(page.limit)
      .offset(page.offset);
    // Площадка присоединяется и здесь: по её наименованию и коду идёт поиск, а прочие справочники
    // отбор не сужают — считать их ради `count(*)` незачем.
    const [totalRow] = await db
      .select({ c: count() })
      .from(mechRequests)
      .innerJoin(constructionObjects, eq(mechRequests.objectId, constructionObjects.id))
      // Модель — ради поиска по её наименованию: счётчик обязан считать ровно те строки, которые
      // отобрала таблица, и соединение, забытое здесь, дало бы «показано 20 из 0» на первом же
      // поиске словом из справочника.
      .leftJoin(mechModels, eq(mechRequests.mechModelId, mechModels.id))
      .where(where);
    const filesMap = await mechFilesByRequestIds(
      db,
      rows.map((row) => row.id),
    );
    return {
      items: rows.map((row) => toMechRequestDto(row, filesMap.get(row.id) ?? [])),
      total: Number(totalRow!.c),
      page: page.page,
      pageSize: page.pageSize,
    };
  });

  r.get(
    '/summary',
    { ...auth, schema: { querystring: mechRequestSummaryQuerySchema } },
    async (req) => {
      const p = requirePrincipal(req);
      return loadMechSummary(p, req.query.placeObjectId, moscowDateKeyOf(new Date()));
    },
  );

  // Подсказки ранее вводившихся видов (`GET /kinds`) здесь больше нет: строгий выбор из справочника
  // (ADR 0156, решение 2) сделал её лишней, а оставленная рядом — вредной. Она отвечала «что уже
  // набирали в этой области», и портал, спросивший её при пустом справочнике, предлагал бы человеку
  // написания вместо позиций. Модели читаются справочником `GET /api/v1/mech-models`.

  // ── Журнал закрытых аренд: вкладка «История» (§7 п. 3, Э3) ──
  //
  // Отдельным маршрутом, а не фильтром общего списка, по той же причине, что и у вывоза
  // (ADR 0135): вопросы к журналу другие. Не «что сейчас стоит на площадках», а «что за период
  // арендовали, у кого и во сколько это обошлось» — отсюда свой итог, свои столбцы факта и своя
  // выгрузка.
  //
  // Область и присутствие считаются теми же выражениями, что у списка (`mechHistoryWhere` рядом с
  // `mechListWhere`): журнал — тот же реестр с другого конца, а не второй способ читать заявки.

  /**
   * Открытый статус в журнале — отказ, а не молчаливое расширение до обоих закрытых. Выдача, в
   * которой отбор не сработал, отличается от правильной только числом строк, и по ней это не
   * видно; отказ же называет вкладку, где такие заявки живут.
   */
  const assertMechHistoryStatus = (q: { status?: RequestStatus }): void => {
    if (!q.status || isClosedRequestStatus(q.status)) return;
    // «Завершена» — случай отдельный: у механизации такого статуса нет вовсе (Р8), и отправлять за
    // ней в рабочую вкладку было бы ложью — там её тоже нет. Отвечает тот же текст, которым на
    // неё отвечает схема смены статуса.
    if (q.status === 'completed') {
      throw err.badRequest(MECH_NO_COMPLETED_STATUS_MESSAGE, { status: 'Такого статуса нет' });
    }
    throw err.badRequest(
      `Заявки в статусе «${requestStatusLabels[q.status]}» журналом не закрыты — они во вкладке «Заявки»`,
      { status: 'Статус работы' },
    );
  };

  /** Строки журнала: та же выборка, что и у списка, но с отбором и порядком журнала. */
  const historyRows = (q: MechRequestHistoryQuery, where: SQL | undefined, limit: number) =>
    mechBaseQuery()
      .where(where)
      // По плановому возврату, а не по дате заведения: журнал читают по времени, когда аренда
      // кончалась, — так же его сводят со счетами. Плановая дата есть у каждой строки, в отличие
      // от фактической: у отменённой заявки факта нет вовсе, и по нему все отмены слиплись бы в
      // пустой хвост. Доводка `num + id` та же, что и в списке: сортировка по неуникальному
      // столбцу сама по себе порядок строк не задаёт.
      .orderBy(
        orderByFrom(mechHistorySortColumns, q.sortBy, q.sortOrder, 'plannedTo'),
        asc(mechRequests.num),
        asc(mechRequests.id),
      )
      .limit(limit);

  r.get(
    '/history',
    { ...auth, schema: { querystring: mechRequestHistoryQuerySchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const q = req.query;
      assertMechHistoryStatus(q);
      const where = mechHistoryWhere(p, q);
      const page = pageParams(q);
      const rows = await historyRows(q, where, page.limit).offset(page.offset);
      const [totalRow] = await db
        .select({ c: count() })
        .from(mechRequests)
        .innerJoin(constructionObjects, eq(mechRequests.objectId, constructionObjects.id))
        // Модель — ради поиска по её наименованию, той же парой соединений, что и у списка.
        .leftJoin(mechModels, eq(mechRequests.mechModelId, mechModels.id))
        .where(where);
      const filesMap = await mechFilesByRequestIds(
        db,
        rows.map((row) => row.id),
      );
      return {
        items: rows.map((row) => toMechRequestDto(row, filesMap.get(row.id) ?? [])),
        total: Number(totalRow!.c),
        page: page.page,
        pageSize: page.pageSize,
      };
    },
  );

  /**
   * Итог журнала за выбранные фильтры (Э3): сколько закрыто, сколько из них было арендами, сколько
   * дней техника простояла, сколько отработала и во сколько обошлась.
   *
   * Считается по ТЕМ ЖЕ условиям, что и сам журнал, — включая `status`, в отличие от сводки над
   * рабочим списком: там фильтр по статусу свёл бы сводку к самой себе, а здесь он сужает вопрос
   * («во сколько обошлись отменённые» — законный вопрос к журналу).
   */
  r.get(
    '/history/summary',
    { ...auth, schema: { querystring: mechRequestHistoryQuerySchema } },
    async (req) => {
      const p = requirePrincipal(req);
      assertMechHistoryStatus(req.query);
      return loadMechHistorySummary(p, req.query);
    },
  );

  /**
   * Тот же журнал файлом. Отдельной ручкой, а не параметром `format` у первой: у ответов разные
   * типы содержимого и разные схемы, и ручка, отвечающая то JSON, то байтами, ломает типизацию
   * обеим сторонам.
   *
   * Выборка и область — те же самые, вплоть до сортировки: файл, показывающий не то, что портал,
   * спорит с ним, а спор разбирают глазами. Страниц у файла нет — его сверяют со счетами целиком,
   * — но потолок есть, и, упёршись в него, книга говорит об этом последней строкой.
   */
  r.get(
    '/history/export',
    { ...auth, schema: { querystring: mechRequestHistoryQuerySchema } },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const q = req.query;
      assertMechHistoryStatus(q);
      const where = mechHistoryWhere(p, q);
      // Лишняя строка сверх потолка — способ узнать, что отбор в файл не поместился, не считая его
      // второй раз.
      const rows = await historyRows(q, where, MECH_HISTORY_EXPORT_LIMIT + 1);
      const book = mechHistoryWorkbook({
        // Вложения в книгу не идут: файл сверяют со счетами, а не открывают из него документы.
        rows: rows.slice(0, MECH_HISTORY_EXPORT_LIMIT).map((row) => toMechRequestDto(row, [])),
        // Итог — по ВСЕМУ отбору, а не по попавшим в файл строкам: обрезанный список с обрезанной
        // суммой читался бы как весь журнал.
        summary: await loadMechHistorySummary(p, q),
        truncated: rows.length > MECH_HISTORY_EXPORT_LIMIT,
        periodFrom: q.periodFrom,
        periodTo: q.periodTo,
      });
      return reply
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header(
          'content-disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(book.filename)}`,
        )
        .send(Buffer.from(book.bytes));
    },
  );

  r.get('/:id', { ...auth, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    const dto = await loadMechRequestDto(db, req.params.id);
    if (!dto) throw err.notFound('Заявка не найдена');
    assertArchiveVisible(p, dto.deletedAt, 'Заявка не найдена');
    assertPlaceObjectScope(p, dto.objectId, MECH_SCOPE_LABEL);
    return dto;
  });

  // История заявки: заведение, правки, договорённость, выдача, снятие, продление, завершение,
  // архив и восстановление. Доступна тем же, кто видит саму заявку — отдельного права на неё нет:
  // это те же события, что и в карточке, только по времени.
  r.get('/:id/history', { ...auth, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    const [row] = await db
      .select({
        id: mechRequests.id,
        objectId: mechRequests.objectId,
        deletedAt: mechRequests.deletedAt,
        createdAt: mechRequests.createdAt,
        createdBy: mechRequests.createdBy,
        createdByName: users.fullName,
      })
      .from(mechRequests)
      .innerJoin(users, eq(mechRequests.createdBy, users.id))
      .where(eq(mechRequests.id, req.params.id));
    if (!row) throw err.notFound('Заявка не найдена');
    assertArchiveVisible(p, row.deletedAt, 'Заявка не найдена');
    assertPlaceObjectScope(p, row.objectId, MECH_SCOPE_LABEL);
    return loadMechRequestHistory(row.id, {
      at: row.createdAt,
      actorId: row.createdBy,
      actorName: row.createdByName,
    });
  });

  /**
   * Заведение — **отдельная ветка протокола Р21**: запереть ещё не существующую строку нечем.
   * Последовательность своя: транзакция → проверка пары «отдел — площадка» и активности её половин
   * → проверка модели → вставка → привязка файлов → первая запись истории статусов → коммит →
   * аудит обычным `writeAudit`.
   *
   * Аудит здесь ПОСЛЕ транзакции, а не в ней: заведения нет в строгом перечне (`writeAuditTx`), и
   * держать обещание, которого протокол не даёт, хуже, чем назвать границу. Снимок при этом
   * пишется полный — тот же, что у `hard_delete` и `purge`, — хотя половина его ключей у новой
   * заявки пуста по существу: один набор с пустыми значениями честнее второго, укороченного.
   */
  const createRequest = async (
    p: Principal,
    input: {
      objectId: string;
      departmentId: string | null;
      mechModelId: string;
      plannedFrom: string;
      plannedTo: string;
      responsibleName: string;
      responsiblePhone: string;
      comment: string;
      fileIds: string[];
    },
    /** Исходная заявка «Дублировать»; в журнале только она и отличает копию от обычного заведения. */
    sourceRequestId?: string,
  ): Promise<MechRequestDto> => {
    assertPlaceObjectScope(p, input.objectId, MECH_SCOPE_LABEL);
    assertMechRequesterAllowed(p, input.departmentId);
    const created = await db.transaction(async (tx) => {
      await assertMechPairAssignable(tx, input.objectId, input.departmentId);
      // Модель проверяется до вставки: внешний ключ отвечает «такая строка есть», а «её можно
      // выбрать сегодня» — вопрос сервиса. Наименование при этом никуда не пишется: с уборкой Э3
      // снимка написания у заявки нет вовсе, предмет аренды хранится одной ссылкой (ADR 0156).
      await assertMechModelAssignable(tx, input.mechModelId);
      const [row] = await tx
        .insert(mechRequests)
        .values({
          objectId: input.objectId,
          departmentId: input.departmentId,
          mechModelId: input.mechModelId,
          plannedFrom: input.plannedFrom,
          plannedTo: input.plannedTo,
          responsibleName: input.responsibleName,
          responsiblePhone: input.responsiblePhone,
          comment: input.comment,
          status: 'new',
          createdBy: p.id,
        })
        .returning({ id: mechRequests.id });
      await tx.insert(mechRequestStatusHistory).values({
        requestId: row!.id,
        fromStatus: null,
        toStatus: 'new',
        changedBy: p.id,
      });
      await linkMechRequestFiles(tx, row!.id, input.fileIds, p.id);
      return row!;
    });
    const dto = (await loadMechRequestDto(db, created.id))!;
    await writeAudit({
      actorUserId: p.id,
      action: 'mech_request.create',
      entityType: 'mech_request',
      entityId: created.id,
      metadata: {
        ...mechAuditSnapshot(dto),
        ...(sourceRequestId ? { sourceRequestId } : {}),
      },
    });
    return dto;
  };

  r.post('/', { ...canCreate, schema: { body: createMechRequestSchema } }, async (req, reply) => {
    const p = requirePrincipal(req);
    const body = req.body;
    const dto = await createRequest(p, {
      objectId: body.objectId,
      departmentId: body.departmentId ?? null,
      mechModelId: body.mechModelId,
      plannedFrom: body.plannedFrom,
      plannedTo: body.plannedTo,
      responsibleName: body.responsibleName,
      responsiblePhone: body.responsiblePhone,
      comment: body.comment,
      fileIds: body.fileIds,
    });
    reply.code(201);
    return dto;
  });

  /**
   * «Дублировать» (Р3): ставка задаётся за час или смену ЕДИНИЦЫ, две единицы возвращают в разные
   * дни и работают разное число часов — поэтому «нужны две виброплиты» это две заявки, а не
   * количество в одной. Кнопка закрывает эргономику этого решения.
   *
   * Исходная заявка читается **без замка**: из неё только копируются значения, и запирать её
   * незачем — параллельная правка исходной на копию не влияет.
   *
   * Пара «отдел + площадка» проверяется заново: это заведение новой заявки, а не копия строки, и
   * площадку у отдела могли снять после того, как завели исходную. Вложения не копируются вовсе —
   * файл принадлежит одной заявке (`UNIQUE(file_id)`), а копия документа это новая загрузка.
   */
  r.post(
    '/:id/duplicate',
    { ...canCreate, schema: { params: idParams, body: duplicateMechRequestSchema } },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const source = await loadMechRequestDto(db, req.params.id);
      if (!source) throw err.notFound('Заявка не найдена');
      assertArchiveVisible(p, source.deletedAt, 'Заявка не найдена');
      assertPlaceObjectScope(p, source.objectId, MECH_SCOPE_LABEL);
      // Копия ссылается на ту же модель. У заявки старше Э2 ссылки может не быть вовсе — её
      // написание не нашлось в справочнике при переносе, а уборка Э3 сняла и само написание, — и
      // копировать тут нечего: предмета аренды у такой заявки не осталось, а строгий выбор не
      // допускает завести новую заявку без модели. Отказ поэтому не называет модель по имени: имя
      // потеряно вместе с колонкой, и подставить в кавычки нечего.
      if (!source.mechModelId) {
        throw err.unprocessable(
          'У этой заявки модель не указана — её завели до справочника, и скопировать заявку нечем: ' +
            'оформите новую и выберите модель в «Справочниках»',
          { mechModelId: 'Модель не указана' },
        );
      }
      const dto = await createRequest(
        p,
        {
          objectId: source.objectId,
          departmentId: source.departmentId,
          mechModelId: source.mechModelId,
          plannedFrom: source.plannedFrom,
          plannedTo: source.plannedTo,
          responsibleName: source.responsibleName,
          responsiblePhone: source.responsiblePhone,
          comment: source.comment,
          fileIds: [],
        },
        source.id,
      );
      reply.code(201);
      return dto;
    },
  );

  /**
   * Правка формы. Три барьера, каждый со своим вопросом (Р19):
   *
   * - **Б1 — состояние записи** (`mechEditScope`): «Новая» правится целиком; после неё срок, модель,
   *   площадка и заявитель неизменяемы ДЛЯ ВСЕХ, включая офис и администратора — за ними стоит
   *   договорённость с арендодателем, и срок двигает только продление своим правом. У закрытой
   *   заявки открыты комментарий и вложения: акт приходит позже, а разбор постфактум пишут в
   *   комментарий;
   * - **Б2 — роль заявителя** (`assertObjectRoleEditable`): площадка и отдел правят заявку только в
   *   «Новой». Б1 его не заменяет, а дополняет;
   * - **Б3 — удалённая запись**: у архивной строки нет ни правки, ни повторного удаления.
   *
   * Поле считается тронутым, только если присланное значение **отличается** от нынешнего. Иначе
   * форма, отправляющая свои поля целиком, получала бы отказ за неизменённый срок — то есть барьер
   * запрещал бы не действие, а способ его прислать.
   */
  r.patch(
    '/:id',
    { ...canUpdate, schema: { params: idParams, body: updateMechRequestSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const body = req.body;
      const edited = await db.transaction(async (tx) => {
        const row = assertMechRequestOpenable(p, await lockMechRequest(tx, id), body.version);
        assertMechRequestLive(row, 'править');
        assertObjectRoleEditable(p, row.status, 'редактировать');

        // Б3 уже пройден выше, поэтому `deletedAt` передаётся пустым: спросить `mechEditScope`
        // здесь надо про состояние заявки, а про архив он ответил бы `none` раньше всего прочего.
        const scope = mechEditScope({ ...row, deletedAt: null });
        const nextDepartmentId =
          body.departmentId !== undefined ? body.departmentId : row.departmentId;
        const objectChanged = body.objectId !== undefined && body.objectId !== row.objectId;
        const departmentChanged = nextDepartmentId !== row.departmentId;
        const modelChanged = body.mechModelId !== undefined && body.mechModelId !== row.mechModelId;
        const periodChanged =
          (body.plannedFrom !== undefined && body.plannedFrom !== row.plannedFrom) ||
          (body.plannedTo !== undefined && body.plannedTo !== row.plannedTo);
        const contactChanged =
          (body.responsibleName !== undefined && body.responsibleName !== row.responsibleName) ||
          (body.responsiblePhone !== undefined && body.responsiblePhone !== row.responsiblePhone);

        if (scope !== 'all') {
          // Срок отделён от прочего неизменяемого не для красоты: его двигают каждый день, и отказ
          // обязан назвать законный путь, иначе человек ищет его в этой же форме.
          if (periodChanged) {
            throw err.unprocessable(
              'Срок аренды после «Новой» двигает только продление: у него своё право, обязательная причина и своё событие истории',
              { plannedTo: 'Оформите продление' },
            );
          }
          if (objectChanged || departmentChanged || modelChanged) {
            throw err.unprocessable(
              'Модель, площадку и заявителя после «Новой» не меняют — за ними стоит договорённость с арендодателем',
            );
          }
        }
        if (scope === 'comment' && contactChanged) {
          throw err.unprocessable(
            'Заявка закрыта: принимать технику уже некому — у неё правятся только комментарий и вложения',
            { responsibleName: 'Заявка закрыта' },
          );
        }

        // Пара стережётся в момент, когда её НАЗНАЧАЮТ (Р17): площадку могли снять с отдела уже
        // после заведения, и перепроверка неизменённой пары запретила бы офису поправить
        // комментарий старой заявки.
        const objectId = body.objectId ?? row.objectId;
        if (objectChanged || departmentChanged) {
          assertPlaceObjectScope(p, objectId, MECH_SCOPE_LABEL);
          assertMechRequesterAllowed(p, nextDepartmentId);
          await assertMechPairAssignable(tx, objectId, nextDepartmentId);
        }

        // Модель проверяется, только когда её МЕНЯЮТ, — тем же правилом, что и пара «отдел +
        // площадка» рядом: позицию справочника могли погасить после того, как заявку завели, и
        // перепроверка неизменённой ссылки запретила бы офису поправить у такой заявки комментарий.
        // Наименование проверка по-прежнему возвращает, но записывать его больше некуда: снимка
        // написания у заявки нет с уборки Э3, предмет аренды хранится одной ссылкой.
        const mechModelId = body.mechModelId ?? row.mechModelId;
        if (modelChanged) await assertMechModelAssignable(tx, body.mechModelId!);

        const plannedFrom = body.plannedFrom ?? row.plannedFrom;
        const plannedTo = body.plannedTo ?? row.plannedTo;
        // Схеме есть что сказать про срок, только когда пришли обе даты; прислали одну — вторая
        // лежит в строке, которой у схемы нет, и сравнивает их сервер.
        if (plannedTo < plannedFrom) {
          throw err.badRequest('Дата возврата не может быть раньше даты подачи', {
            plannedTo: 'Раньше даты подачи',
          });
        }

        const before = (await loadMechRequestDto(tx, id))!;
        const [updated] = await tx
          .update(mechRequests)
          .set({
            objectId,
            departmentId: nextDepartmentId,
            mechModelId,
            plannedFrom,
            plannedTo,
            responsibleName: body.responsibleName ?? row.responsibleName,
            responsiblePhone: body.responsiblePhone ?? row.responsiblePhone,
            comment: body.comment ?? row.comment,
            updatedBy: p.id,
            version: row.version + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(mechRequests.id, id), eq(mechRequests.version, body.version)))
          .returning({ id: mechRequests.id });
        if (!updated) throw err.conflict();
        // Файлы — в этой же транзакции: снятое вложение обязано уйти в отложенное удаление вместе
        // с правкой, а не отдельным запросом, который может не состояться.
        if (body.removeFileIds?.length) await unlinkMechRequestFiles(tx, id, body.removeFileIds);
        if (body.addFileIds?.length) {
          await linkMechRequestFiles(tx, id, body.addFileIds, p.id, true);
        }
        return { before, after: (await loadMechRequestDto(tx, id))! };
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'mech_request.update',
        entityType: 'mech_request',
        entityId: id,
        metadata: { changes: diffMechRequests(edited.before, edited.after) },
      });
      return edited.after;
    },
  );

  /**
   * Договорённость отдельной ручкой правом `.status` — тем же, которым её и поставили (Р19). Через
   * общий `PATCH` это было бы неверно: там барьер роли пускает площадку, а договорённость — работа
   * офиса, и правит он её, пока техника не выдана.
   *
   * После выдачи договорённость не правится вовсе: техника уже работает по этой ставке, и лечение
   * одно — снять отметку выдачи, поправить, отметить заново.
   */
  r.patch(
    '/:id/deal',
    { ...canChangeStatus, schema: { params: idParams, body: updateMechDealSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const { lessorId, rate, rateUnit, version } = req.body;
      return db.transaction(async (tx) => {
        const row = assertMechRequestOpenable(p, await lockMechRequest(tx, id), version);
        assertMechRequestLive(row, 'править');
        assertObjectRoleEditable(p, row.status, 'редактировать');
        if (row.status !== 'confirmed') {
          throw err.unprocessable(
            'Арендодатель и ставка появляются, когда заявку берут в работу, и живут вместе с ней',
          );
        }
        if (row.actualFrom !== null) {
          throw err.unprocessable(
            'Техника выдана: чтобы поправить договорённость, сначала снимите отметку выдачи',
          );
        }
        const lessor = await assertMechLessorAssignable(tx, lessorId);
        const before = (await loadMechRequestDto(tx, id))!;
        const [updated] = await tx
          .update(mechRequests)
          .set({
            lessorId,
            lessorType: lessor.lessorType,
            lessorIsActive: lessor.lessorIsActive,
            rate: String(rate),
            rateUnit,
            updatedBy: p.id,
            version: row.version + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(mechRequests.id, id), eq(mechRequests.version, version)))
          .returning({ id: mechRequests.id });
        if (!updated) throw err.conflict();
        // Строгий аудит (Р21): прежняя ставка не хранится больше нигде — строка помнит одно
        // «сейчас», — и потерянное событие означало бы исправление, которого будто не было.
        await writeAuditTx(tx, {
          actorUserId: p.id,
          action: 'mech_request.deal',
          entityType: 'mech_request',
          entityId: id,
          metadata: {
            changes: mechDealChanges(before, { lessorName: lessor.lessorName, rate, rateUnit }),
          },
        });
        return (await loadMechRequestDto(tx, id))!;
      });
    },
  );

  /**
   * Смена статуса. Что переход делает с договорённостью и фактом, считает `planMechTransition`:
   * договорённость приезжает вместе с «В работе», факт возврата — вместе с «Выполнена», а вход в
   * «Новую» стирает обоих, и всё это обязано случиться той же транзакцией, что и смена статуса.
   *
   * Барьеров перехода два, и оба про выданную технику (`mechTransitionBlocker`): отмена после
   * выдачи и откат в «Новую» после выдачи. Второй — не следствие первого: `confirmed → new` стирает
   * договорённость и факт по построению, и без запрета получалась бы дверь из трёх шагов в обход
   * запрета на удаление действующей аренды — откат → всё стёрлось → физическое удаление «Новой».
   */
  r.patch(
    '/:id/status',
    { ...canChangeStatus, schema: { params: idParams, body: changeMechRequestStatusSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const { status, comment, version } = req.body;
      const outcome = await db.transaction(async (tx) => {
        const row = assertMechRequestOpenable(p, await lockMechRequest(tx, id), version);
        assertMechRequestLive(row, 'сменить её статус');
        const before = (await loadMechRequestDto(tx, id))!;
        // Повтор того же статуса — не событие: писать переход «В работе → В работе» в историю
        // значило бы засорять её нажатиями.
        //
        // Но повтор С ПРИЛОЖЕННЫМ СОДЕРЖИМЫМ — это не повтор, а другое действие, и отдать на него
        // тихий успех нельзя. Двойное нажатие сюда не доходит вовсе: у второго запроса версия
        // старая, и его отсекает 409 шагом раньше (Р21). Значит, если сюда пришла договорённость,
        // дата выдачи или факт возврата, их прислали ОСОЗНАННО и с актуальной версией — а ответ
        // 200 означал бы, что портал показал «готово» там, где не произошло ничего: незамеченная
        // отметка выдачи уводит технику из вкладки «В аренде» (риск 4 плана), а незамеченное
        // повторное завершение теряет исправленную сумму. Отказ называет законную дверь, потому
        // что у каждого из трёх содержимых она своя.
        if (row.status === status) {
          const stuck = SAME_STATUS_REFUSALS.find(([field]) => req.body[field] !== undefined);
          if (stuck) throw err.unprocessable(stuck[1], { [stuck[0]]: stuck[2] });
          return { dto: before, changed: false as const, from: row.status };
        }
        assertTransitionAllowed(p, row.status, status, 'mech');
        const blocker = mechTransitionBlocker(row, status);
        if (blocker) throw err.unprocessable(blocker);
        // Возврат в «Новую» стирает договорённость целиком (Р8), и причина ему нужна наравне с
        // причиной отмены: без неё в истории осталась бы пара переходов, по которой не понять, за
        // что сняли арендодателя и цену. Спрашивает её сервер, а не схема тела: схеме известен
        // только целевой статус, а требование держится на паре «откуда → куда». Тот же приём и та
        // же формулировка, что у вывоза мусора (`transitionResetsWork` в routes/waste-requests.ts),
        // только правило своё — модульное, потому что общее описывает один переход, а у механизации
        // в «Новую» ведут два.
        if (mechTransitionResetsDeal(row.status, status) && !comment) {
          throw err.badRequest('Укажите причину возврата заявки в «Новую»', {
            comment: 'Укажите причину',
          });
        }

        const plan = await planMechTransition(tx, row, req.body);
        const [updated] = await tx
          .update(mechRequests)
          .set({
            status,
            ...plan.deal,
            ...plan.fact,
            updatedBy: p.id,
            version: row.version + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(mechRequests.id, id), eq(mechRequests.version, version)))
          .returning({ id: mechRequests.id });
        if (!updated) throw err.conflict();
        await tx.insert(mechRequestStatusHistory).values({
          requestId: id,
          fromStatus: row.status,
          toStatus: status,
          changedBy: p.id,
          comment,
        });

        // Строгий аудит — три события, каждое единственный носитель своего факта (Р21). Пишутся они
        // ровно тогда, когда переход их породил: «взяли в работу с выдачей сразу» даёт два, а
        // отмена — ни одного.
        if (plan.dealAfter) {
          await writeAuditTx(tx, {
            actorUserId: p.id,
            action: 'mech_request.deal',
            entityType: 'mech_request',
            entityId: id,
            metadata: { changes: mechDealChanges(before, plan.dealAfter) },
          });
        }
        if (plan.issuedAt) {
          await writeAuditTx(tx, {
            actorUserId: p.id,
            action: 'mech_request.issue',
            entityType: 'mech_request',
            entityId: id,
            metadata: { changes: mechIssueChanges(row.actualFrom, plan.issuedAt) },
          });
        }
        if (plan.completion) {
          await writeAuditTx(tx, {
            actorUserId: p.id,
            action: 'mech_request.complete',
            entityType: 'mech_request',
            entityId: id,
            metadata: { changes: mechCompletionChanges(before, plan.completion) },
          });
        }
        return {
          dto: (await loadMechRequestDto(tx, id))!,
          changed: true as const,
          from: row.status,
        };
      });
      if (!outcome.changed) return outcome.dto;
      // Переход — второй реестр аудита (§6): в карточку он приходит из таблицы истории статусов,
      // где есть и он, и причина. Но в общем журнале быть обязан — без него отмена заявки не
      // оставляет в `audit_log` ни строки, и сквозной разбор «что происходило в портале в этот
      // день» её не увидит. Best-effort: расчётного факта событие не несёт.
      await writeAudit({
        actorUserId: p.id,
        action: 'mech_request.status',
        entityType: 'mech_request',
        entityId: id,
        metadata: { from: outcome.from, to: status, comment },
      });
      return outcome.dto;
    },
  );

  /**
   * Отметка выдачи (Р2): с этого дня заявка стала действующей арендой — попала во вкладку «В
   * аренде», пошёл срок, отмена закрылась.
   *
   * Доступна ровно при «ждёт подачи» (`isMechAwaitingIssue`): у заявки, которую ещё не взяли в
   * работу, отмечать нечего, у выданной отметка уже стоит, а у отменённой её и быть не может.
   */
  r.post(
    '/:id/issue',
    { ...canChangeStatus, schema: { params: idParams, body: issueMechRequestSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const { actualFrom, version } = req.body;
      return db.transaction(async (tx) => {
        const row = assertMechRequestOpenable(p, await lockMechRequest(tx, id), version);
        assertMechRequestLive(row, 'отметить выдачу');
        if (!isMechAwaitingIssue(row)) {
          throw err.unprocessable(
            row.actualFrom
              ? 'Отметка выдачи уже стоит — снимите её, если она ошибочна'
              : 'Выдачу отмечают у заявки, которую взяли в работу и ждут подачи',
            { actualFrom: 'Отметка сейчас недоступна' },
          );
        }
        const [updated] = await tx
          .update(mechRequests)
          .set({
            actualFrom,
            updatedBy: p.id,
            version: row.version + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(mechRequests.id, id), eq(mechRequests.version, version)))
          .returning({ id: mechRequests.id });
        if (!updated) throw err.conflict();
        await writeAuditTx(tx, {
          actorUserId: p.id,
          action: 'mech_request.issue',
          entityType: 'mech_request',
          entityId: id,
          metadata: { changes: mechIssueChanges(null, actualFrom) },
        });
        return (await loadMechRequestDto(tx, id))!;
      });
    },
  );

  /**
   * Снятие ошибочной отметки выдачи (Р2). Без этого действия единственным лечением опечатки был бы
   * откат в «Новую», стирающий договорённость, — а он после выдачи и запрещён.
   *
   * Доступно ровно при ДЕЙСТВУЮЩЕЙ АРЕНДЕ — всём предикате целиком, а не при одном пустом
   * `actual_to`. Иначе снятие прошло бы там, где снимать нечего или незачем: у заявки без выдачи, у
   * отменённой и вторым нажатием подряд. Все три случая — 422; а вот второе снятие, разошедшееся с
   * первым по времени, приходит со старой версией и получает 409, и различие этих двух ответов и
   * есть проверка того, что версия сверяется раньше предметных правил.
   */
  r.post(
    '/:id/issue-revoke',
    { ...canChangeStatus, schema: { params: idParams, body: revokeMechIssueSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const { reason, version } = req.body;
      return db.transaction(async (tx) => {
        const row = assertMechRequestOpenable(p, await lockMechRequest(tx, id), version);
        assertMechRequestLive(row, 'править');
        if (!isMechRentalRunning(row)) {
          throw err.unprocessable(
            'Снимать отметку не с чего: аренда сейчас не идёт — техника либо не выдавалась, либо уже возвращена',
          );
        }
        const revokedFrom = row.actualFrom!;
        const [updated] = await tx
          .update(mechRequests)
          .set({
            // Возврата у действующей аренды нет по построению (`issue_first_check`), но факт
            // обнуляется целиком: лестница состояний допускает только «пусто», «выдача» и «выдача
            // с полным возвратом», и половинчатое состояние из неё не выразимо.
            ...NO_MECH_FACT,
            updatedBy: p.id,
            version: row.version + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(mechRequests.id, id), eq(mechRequests.version, version)))
          .returning({ id: mechRequests.id });
        if (!updated) throw err.conflict();
        await writeAuditTx(tx, {
          actorUserId: p.id,
          action: 'mech_request.issue_revoke',
          entityType: 'mech_request',
          entityId: id,
          metadata: { changes: mechIssueRevokeChanges(revokedFrom, reason) },
        });
        return (await loadMechRequestDto(tx, id))!;
      });
    },
  );

  /**
   * Продление срока аренды (Р9, Р11). Не правка формы и не смена статуса: заявка остаётся ровно
   * там, где была, а меняется обещание платить — поэтому и право своё, и событие своё.
   *
   * Три предметных правила, и каждое отвечает на свой вопрос:
   *
   * - **продлевают ДЕЙСТВУЮЩУЮ аренду** — весь предикат `isMechRentalRunning` целиком (Р2), а не
   *   один заполненный `actual_from`. У заявки, которую ещё не подали, срок правится обычной
   *   формой, пока она «Новая»; у коррекции завершения (откат «Выполнена → В работе» с целым
   *   фактом) техника уже вернулась, и продлевать нечего — там ждут повторного завершения;
   * - **новая дата строго больше прежней** (Р11): та же дата — не продление, а меньшая — сокращение
   *   срока, и оно выражается завершением с фактической датой возврата, а не задним числом
   *   передвинутым планом. Сравнить их может только сервер: прежней даты у схемы тела нет;
   * - **причина обязательна** (схема тела). В комментарий заявки её не положить — он перезаписался
   *   бы, — а без неё в истории осталась бы одна передвинутая дата без ответа «почему платим ещё».
   *
   * Аудит строгий и внутри транзакции (Р21): прежний срок строка не хранит — она помнит одно
   * «сейчас», — и потерянное событие означало бы продление, которого будто не было.
   */
  r.patch(
    '/:id/extend',
    { ...canExtend, schema: { params: idParams, body: extendMechRequestSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const { plannedTo, reason, version } = req.body;
      return db.transaction(async (tx) => {
        const row = assertMechRequestOpenable(p, await lockMechRequest(tx, id), version);
        assertMechRequestLive(row, 'продлить аренду');
        if (!isMechRentalRunning(row)) {
          throw err.unprocessable(
            'Продлевают действующую аренду: техника либо ещё не выдана, либо уже возвращена',
          );
        }
        // Строгое сравнение строк `YYYY-MM-DD`: ключ сравнивается лексикографически ровно так же,
        // как хронологически, и пересчёт в моменты времени вернул бы часовой пояс туда, откуда его
        // убрали. Равенство отсекается тем же условием — повтор нажатия с актуальной версией
        // должен ответить по делу, а не тихим успехом.
        if (plannedTo <= row.plannedTo) {
          throw err.unprocessable(MECH_EXTEND_NOT_LATER_MESSAGE, {
            plannedTo: 'Позже прежней даты',
          });
        }
        const [updated] = await tx
          .update(mechRequests)
          .set({
            // Двигается ровно план возврата. `plannedFrom` и факт выдачи не трогаются вовсе:
            // аренда уже идёт, и подвинутое начало переписало бы то, что случилось.
            plannedTo,
            updatedBy: p.id,
            version: row.version + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(mechRequests.id, id), eq(mechRequests.version, version)))
          .returning({ id: mechRequests.id });
        if (!updated) throw err.conflict();
        await writeAuditTx(tx, {
          actorUserId: p.id,
          action: 'mech_request.extend',
          entityType: 'mech_request',
          entityId: id,
          metadata: { changes: mechExtendChanges(row.plannedTo, plannedTo, reason) },
        });
        return (await loadMechRequestDto(tx, id))!;
      });
    },
  );

  /**
   * Удаление (ADR 0070): «Новая» стирается физически вместе с вложениями — просьба, о которой
   * передумали, историей не является; всё прочее уходит в архив обратимо.
   *
   * **Действующую аренду и коррекцию завершения не удаляет никто** (`mechDeleteScope`), включая
   * администратора: удаление уводит строку из всех выборок, а техника стоит на площадке и стоит
   * денег — и вместе со строкой из журнала ушла бы стоимость состоявшейся аренды.
   *
   * У физического удаления версию не увеличить — строки после него нет, — поэтому CAS выражается
   * условием самого `DELETE` и проверкой числа удалённых строк: «удалили ноль» означает, что запись
   * успели поменять, и ответ 409, а не тихий успех.
   */
  r.delete(
    '/:id',
    { ...canDelete, schema: { params: idParams, querystring: versionQuery } },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const { version } = req.query;
      const outcome = await db.transaction(async (tx) => {
        const row = assertMechRequestOpenable(p, await lockMechRequest(tx, id), version);
        assertMechRequestLive(row, 'удалить');
        assertObjectRoleEditable(p, row.status, 'удалять');
        // Б3 уже пройден выше, поэтому `deletedAt` передаётся пустым: иначе `mechDeleteScope`
        // ответил бы `none` про архив, а спросить его здесь надо про состояние аренды.
        const scope = mechDeleteScope({ ...row, deletedAt: null });
        if (scope === 'none') throw err.unprocessable(MECH_DELETE_RUNNING_MESSAGE);

        if (scope === 'hard') {
          // Снимок берётся до удаления: журнал — единственное, что останется от строки.
          const snapshot = mechAuditSnapshot((await loadMechRequestDto(tx, id))!);
          const linked = await collectMechRequestFiles(tx, id);
          const removed = await tx
            .delete(mechRequests)
            .where(and(eq(mechRequests.id, id), eq(mechRequests.version, version)))
            .returning({ id: mechRequests.id });
          if (removed.length !== 1) throw err.conflict();
          // История статусов и связи с файлами уходят каскадом; сами строки `files` каскад не
          // трогает — их уносит защищённый `hardDeleteFiles`, уже увидев связь снятой.
          await hardDeleteFiles(tx, linked);
          return { mode: 'hard' as const, snapshot };
        }

        const [updated] = await tx
          .update(mechRequests)
          .set({
            deletedAt: new Date(),
            deletedBy: p.id,
            version: row.version + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(mechRequests.id, id), eq(mechRequests.version, version)))
          .returning({ id: mechRequests.id });
        if (!updated) throw err.conflict();
        return { mode: 'soft' as const, snapshot: null };
      });
      await writeAudit({
        actorUserId: p.id,
        action: outcome.mode === 'hard' ? 'mech_request.hard_delete' : 'mech_request.soft_delete',
        entityType: 'mech_request',
        entityId: id,
        // У архивирования снимка нет намеренно: строка на месте, а событие показывается в карточке
        // готовым видом «Перемещена в архив», у которого `changes` пусты по существу.
        ...(outcome.snapshot ? { metadata: outcome.snapshot } : {}),
      });
      return { ok: true, mode: outcome.mode };
    },
  );

  /**
   * Восстановление из архива (ADR 0070). Строка берётся без условия по `deleted_at` намеренно:
   * восстанавливают как раз удалённую, и фильтр «только живые» отвечал бы 404 на единственную
   * заявку, ради которой ручка заведена.
   *
   * Область спрашивается до разбора состояния: на живой заявке ручка отдаёт карточку целиком, и без
   * проверки здесь `archive.restore` читал бы чужие заявки в обход `mechRequests.read`.
   */
  r.post(
    '/:id/restore',
    {
      preHandler: [app.authenticate, app.requirePermission('archive.restore')],
      schema: { params: idParams, body: restoreBody },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const { version } = req.body;
      const restored = await db.transaction(async (tx) => {
        // `assertMechRequestOpenable` здесь не годится: он спрашивает `archive.read`, а
        // восстановление открыто своим правом `archive.restore` — права выдаются порознь, и
        // требовать здесь оба значило бы закрыть ручку тому, кому её и открывали.
        const row = await lockMechRequest(tx, id);
        if (!row) throw err.notFound('Заявка не найдена');
        assertPlaceObjectScope(p, row.objectId, MECH_SCOPE_LABEL);
        if (row.version !== version) throw err.conflict();
        // Живая заявка отдаётся как есть: восстанавливать нечего, а отказ на повторном нажатии
        // читался бы как поломка.
        if (!row.deletedAt) return { dto: (await loadMechRequestDto(tx, id))!, changed: false };
        const [updated] = await tx
          .update(mechRequests)
          .set({
            deletedAt: null,
            deletedBy: null,
            updatedBy: p.id,
            version: row.version + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(mechRequests.id, id), eq(mechRequests.version, version)))
          .returning({ id: mechRequests.id });
        if (!updated) throw err.conflict();
        return { dto: (await loadMechRequestDto(tx, id))!, changed: true };
      });
      if (restored.changed) {
        await writeAudit({
          actorUserId: p.id,
          action: 'mech_request.restore',
          entityType: 'mech_request',
          entityId: id,
        });
      }
      return restored.dto;
    },
  );

  /**
   * Удаление насовсем (Р15, ADR 0070) — своя ручка, а не общий `registerPurgeRoute`, и причин три
   * сразу: тот принимает только `id` (клиентской версии взять неоткуда), читает строку и проверяет
   * её состояние ДО транзакции — то есть без замка, — и пишет аудит ПОСЛЕ коммита. Общий помощник
   * не расширяется: он написан для справочников, где у строки нет ни версии, ни состояния, и
   * подгонять его под заявку значило бы усложнить его шестнадцати нынешним потребителям.
   *
   * **Состояние спрашивается и здесь**: право открывает действие, состояние его разрешает, и у
   * удаления насовсем не может быть исключения из этого — он единственный, после кого нечего
   * восстанавливать. Архивная строка, которая по своим полям является действующей арендой или
   * коррекцией завершения, через портал появиться не может (Б1 не даёт её архивировать), но
   * приходит из старых данных, из прямого SQL и из ошибки будущей правки.
   *
   * Аудит — строгий и внутри транзакции (Р21): после `purge` от заявки не остаётся ничего, кроме
   * строки журнала со снимком, и потерянная запись означает бесследно исчезнувший документ вместе
   * с деньгами, которые по нему считали.
   */
  r.delete(
    '/:id/purge',
    {
      preHandler: [app.authenticate, app.requirePermission('records.purge')],
      schema: { params: idParams, querystring: versionQuery },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const { version } = req.query;
      await db.transaction(async (tx) => {
        // Права архива проверяются по отдельности (Р15): вкладку открывает `archive.read`,
        // восстановление — `archive.restore`, удаление насовсем — `records.purge`. Поэтому
        // `assertMechRequestOpenable` здесь не годится: он спрашивает `archive.read`, а без него
        // ручка отвечала бы 404 на единственную строку, ради которой заведена, — архивную.
        const row = await lockMechRequest(tx, id);
        if (!row) throw err.notFound('Заявка не найдена');
        assertPlaceObjectScope(p, row.objectId, MECH_SCOPE_LABEL);
        if (row.version !== version) throw err.conflict();
        assertObjectRoleEditable(p, row.status, 'удалять');
        if (!row.deletedAt) throw err.conflict('Заявка не в архиве — сначала удалите её');
        // Через `mechDeleteScope` этого не спросить: у архивной строки он отвечает `none` всегда —
        // и ответ был бы про Б3, а не про состояние аренды. Спрашиваются оба случая поимённо:
        // реализация через один предикат присутствия оставила бы коррекцию завершения открытой.
        if (isMechRentalRunning(row) || isMechCompletionCorrection(row)) {
          throw err.unprocessable(MECH_DELETE_RUNNING_MESSAGE);
        }
        const snapshot = mechAuditSnapshot((await loadMechRequestDto(tx, id))!);
        const linked = await collectMechRequestFiles(tx, id);
        const removed = await tx
          .delete(mechRequests)
          .where(and(eq(mechRequests.id, id), eq(mechRequests.version, version)))
          .returning({ id: mechRequests.id });
        if (removed.length !== 1) throw err.conflict();
        await hardDeleteFiles(tx, linked);
        await writeAuditTx(tx, {
          actorUserId: p.id,
          action: 'mech_request.purge',
          entityType: 'mech_request',
          entityId: id,
          metadata: snapshot,
        });
      });
      return { ok: true };
    },
  );
}

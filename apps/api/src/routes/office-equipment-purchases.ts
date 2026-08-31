import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  cancelOfficeEquipmentPurchaseSchema,
  closeOfficeEquipmentPurchaseSchema,
  createOfficeEquipmentPurchaseSchema,
  formatOfficeEquipmentPurchaseNumber,
  OFFICE_EQUIPMENT_PURCHASE_CONFLICT_CODES,
  officeEquipmentPurchaseListQuerySchema,
  submitOfficeEquipmentPurchaseSchema,
  updateOfficeEquipmentPurchaseSchema,
  type CreateOfficeEquipmentPurchaseInput,
  type OfficeEquipmentPurchaseDetailDto,
  type OfficeEquipmentPurchasePrefillDto,
  type OfficeEquipmentPurchaseStatus,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  officeEquipmentConsumables,
  officeEquipmentPurchaseItems,
  officeEquipmentPurchases,
} from '../db/schema';
import { requirePrincipal } from '../auth/plugin';
import type { Principal } from '../auth/principal';
import { writeAuditTx } from '../lib/audit';
import { err } from '../lib/errors';
import { orderByFrom, pageParams } from '../lib/pagination';
import { pgErrorOf } from '../lib/pg-error';
import {
  alreadyOrderedExpr,
  deficitExpr,
  lockAndCalcConsumables,
  loadPurchaseDetail,
  openPurchasesByConsumable,
  purchaseFingerprint,
  purchaseQuery,
  PURCHASE_IDEMPOTENCY_CONSTRAINT,
  PURCHASE_NOT_FOUND,
  snapshotMismatches,
  toPurchaseDto,
  type ConsumableCalcRow,
} from '../services/office-equipment-purchases';

/**
 * Плановая закупка расходников (ADR 0146, план
 * `docs/office-equipment-consumables-and-purchase-plan.md`, Р9–Р13, Р15–Р18; миграция `0227`).
 *
 * ЧТО ЭТО ЗА ДОКУМЕНТ. «Чего и сколько закупить» портал до сих пор не отвечал вовсе: остаток он
 * знает, расход по заявкам знает, а «сколько позиции хотим держать на полке» записать было негде —
 * это число жило в голове у ИТ-службы. Потребность (Р13) даёт его, дефицит считается по нему
 * (Р15), а закупка — это бумага, которой дефицит превращают в заказ снабжению.
 *
 * ПОЧЕМУ СВОЙ ФАЙЛ, А НЕ ВИД ЗАЯВКИ (Р9). Довод ADR 0133 об одной таблице заявок был конкретен:
 * «та же техника, та же область видимости, та же история, те же письма». У закупки нет первых
 * двух. Остаток расходников один на компанию (граница ADR 0132), значит потребность, дефицит и
 * заказ по дефициту глобальны — ни площадки, ни отдела у такого документа не бывает. А модуль
 * заявок построен ровно на обратном: на аппарате, его объекте и его отделе, которыми считается
 * область, фильтруются списки и стоят `INNER JOIN` базового запроса. Первая редакция плана
 * впихивала глобальный документ в эту модель и платила исключениями в семи местах.
 *
 * ОТСЮДА ВИДИМОСТЬ — ПО ПРАВУ, А НЕ ПО ОБЛАСТИ (Р12). Единственный страж всех ручек —
 * `officeEquipmentPurchases.manage`; предиката области здесь нет ни одного, и искать его в этом
 * файле не надо. Право входит в набор «Оргтехника: ведение» и требует `officeEquipment.read`
 * (`PERMISSION_REQUIRES`): закупка показывает номенклатуру, и вести то, чего не видишь, — дыра,
 * ради которой таблица требований и заведена.
 *
 * ЧЕГО У ЗАКУПКИ НЕТ и чего в этом файле искать не надо: вложений, обсуждения, срочности,
 * заморозки, писем, ФИО и телефона заявителя. Счёт от поставщика подшивают в учётной системе, а
 * звонить по закупке некому, кроме того, кто её завёл (Р16). На альфе это принято сознательно.
 *
 * ОСТАТОК ОНА НЕ ДВИГАЕТ (Р11): закупка — бумага, приход заводится ручной правкой остатка. Поэтому
 * журналу остатка не нужен ни новый вид события, ни ссылка сюда, а порядок «сначала приход, потом
 * закрытие» держится галочкой в форме закрытия и записан ПРИНЯТЫМ ОПЕРАЦИОННЫМ РИСКОМ, а не
 * инвариантом: текущий остаток не доказывает, что приход именно по этой закупке.
 *
 * АУДИТ ЗДЕСЬ СТРОГИЙ — `writeAuditTx` в той же транзакции, и общего `writeAudit` нет ни в одной
 * ручке (Р9). Общий помощник глотает ошибку записи (`catch` + `logger.error`): у остального
 * портала это осознанный компромисс — журнал не должен ронять выписанный путевой лист, — но
 * закупка двигает деньги снабжения, и запись о ней, потерянная молча, объясняла бы расхождение
 * хуже, чем её отсутствие. При этом ЛЕНТА КАРТОЧКИ СТРОИТСЯ НЕ ИЗ АУДИТА, а из пар колонок
 * (`created_by/at`, `submitted_by/at`, `closed_by/at`, `cancelled_by/at`): они пишутся той же
 * транзакцией, что и статус, и лента полна по построению.
 */

const idParams = z.object({ id: z.string().uuid() });

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Ключ идемпотентности заголовком — тем же транспортом, что у кабинета водителя (ADR 0103,
 * `routes/driver.ts`).
 *
 * ЗДЕСЬ ОН ОБЯЗАТЕЛЕН, А ТАМ НЕТ, и это не расхождение приёмов. Ручка новая, legacy-клиентов у неё
 * нет вовсе, а необязательный ключ означал бы, что защита работает у тех, кто её попросил, — то
 * есть не работает. Колонки `idempotency_key` и `idempotency_fingerprint` объявлены `NOT NULL`
 * ровно поэтому, и принять запрос без ключа маршрут не смог бы, даже захотев.
 *
 * `uuid`, а не свободная строка: ключ порождает портал на попытку отправки, тип отбивает мусор в
 * заголовке раньше маршрута, и он же стоит типом колонки.
 */
function idempotencyKeyOf(req: FastifyRequest): string {
  const raw = req.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) {
    throw err.badRequest('Заведение закупки требует заголовок Idempotency-Key');
  }
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) throw err.badRequest('Некорректный Idempotency-Key');
  return parsed.data;
}

/**
 * Отказ «этот ключ уже занят другой командой» (Р17, шаг 2).
 *
 * Отдельным кодом, а не общим `version_conflict`: исход у него другой. «Устарели данные» лечится
 * повторной отправкой со свежим снимком, а занятый ключ означает, что портал переиспользовал UUID
 * попытки под изменённое тело, — повторять тут нечего, надо взять новый ключ.
 */
function idempotencyConflict(): never {
  throw err.conflict('Под этим ключом отправки уже принята другая закупка', {
    code: OFFICE_EQUIPMENT_PURCHASE_CONFLICT_CODES.idempotency,
  });
}

/** «Ход из этого состояния уже не делают» — 409 с текущим статусом и номером (Р10, Р18). */
function statusConflict(
  num: number,
  status: OfficeEquipmentPurchaseStatus,
  message: string,
): never {
  const displayNumber = formatOfficeEquipmentPurchaseNumber(num);
  throw err.conflict(message, {
    code: OFFICE_EQUIPMENT_PURCHASE_CONFLICT_CODES.status,
    details: { kind: 'status', status, displayNumber },
  });
}

/**
 * «Черновик правил другой» — 409 с новой версией и СВЕЖИМ СОДЕРЖИМЫМ (Р18).
 *
 * Содержимое целиком, а не один номер версии: окну надо показать, ЧТО именно поменял сосед. «Версия
 * 3, а у вас 2» человек прочитает как отказ портала и нажмёт ту же кнопку ещё раз — и получит тот
 * же ответ.
 */
async function versionConflict(runner: Tx | typeof db, id: string): Promise<never> {
  const fresh = await loadPurchaseDetail(runner, id);
  throw err.conflict('Закупку изменил другой человек — посмотрите свежий состав и повторите', {
    code: OFFICE_EQUIPMENT_PURCHASE_CONFLICT_CODES.version,
    details: { kind: 'version', purchase: fresh },
  });
}

/**
 * Состав закупки годен: все позиции существуют и ни одна не погашена (Р13).
 *
 * ПОГАШЕННУЮ НЕ ДОБАВИТЬ ДАЖЕ РУКАМИ, и это не придирка: гашение означает «больше не покупаем», а
 * закупка погашенного — это забытая галочка, а не заказ. Предзаполнение таких не предлагает вовсе,
 * но форма умеет дописывать строки подбором, и запрет обязан стоять на сервере — иначе он был бы
 * правилом одного клиента.
 *
 * ОТКАЗ РАЗЛИЧАЕТ ДВА СЛУЧАЯ. «Позиции нет» — это устаревшая вкладка или подделанное тело, и ответ
 * на неё 400; «позиция погашена» — законное состояние справочника, о котором человеку надо сказать
 * словами, и ответ тот же 400, но с другим текстом и именем позиции. Молчаливое отбрасывание
 * строки было бы худшим из возможных: закупка ушла бы в снабжение без той позиции, ради которой её
 * и заводили.
 */
function assertConsumablesUsable(
  ids: readonly string[],
  calc: Map<string, ConsumableCalcRow>,
): void {
  const missing = ids.filter((id) => !calc.has(id));
  if (missing.length > 0) {
    throw err.badRequest('Позиция номенклатуры не найдена', {
      items: 'Одна из позиций закупки не найдена — обновите справочник',
    });
  }
  const inactive = ids.map((id) => calc.get(id)!).filter((row) => !row.isActive);
  if (inactive.length > 0) {
    throw err.badRequest(`Позиция «${inactive[0]!.name}» погашена — её больше не закупают`, {
      items: `Позиция «${inactive[0]!.name}» погашена`,
    });
  }
}

/**
 * Снимок разошёлся — 409 с НОВЫМИ ЧИСЛАМИ по каждой изменившейся строке (Р17, шаг 6).
 *
 * ЭТО НЕ ОТКАЗ ПО ПОЛЮ. Человек ничего не написал неверно — его данные устарели, — и ответ обязан
 * назвать новые числа: иначе окно предложит переспросить ровно то же самое. Осознанное превышение
 * при этом разрешено, но только повторной отправкой со свежим снимком; отдельного флага «я
 * подтверждаю» нет, пересланный свежий снимок и есть подтверждение.
 */
function assertSnapshotFresh(
  items: CreateOfficeEquipmentPurchaseInput['items'],
  calc: Map<string, ConsumableCalcRow>,
): void {
  const rows = snapshotMismatches(items, calc);
  if (rows.length === 0) return;
  throw err.conflict('Числа по складу изменились — проверьте новые и повторите', {
    code: OFFICE_EQUIPMENT_PURCHASE_CONFLICT_CODES.snapshot,
    details: { kind: 'snapshot', rows },
  });
}

/**
 * Строки закупки одной вставкой, со СНИМКОМ РАСЧЁТА в каждой (Р17).
 *
 * `suggestedQuantity` считает сервер по своим же пересчитанным числам, а не берёт из тела: снимок,
 * присланный клиентом, к этому моменту уже сверен с базой (шаг 6), значит четвёртое число
 * выводится из трёх первых одной формулой Р15. Прими мы его отдельно, портал мог бы прислать
 * снимок, противоречащий сам себе.
 */
async function insertItems(
  tx: Tx,
  purchaseId: string,
  items: CreateOfficeEquipmentPurchaseInput['items'],
  calc: Map<string, ConsumableCalcRow>,
): Promise<void> {
  await tx.insert(officeEquipmentPurchaseItems).values(
    items.map((item) => {
      const now = calc.get(item.consumableId)!;
      return {
        purchaseId,
        consumableId: item.consumableId,
        quantity: item.quantity,
        requiredSnapshot: now.required,
        stockSnapshot: now.stock,
        alreadyOrderedSnapshot: now.alreadyOrdered,
        // Взято у уже посчитанного снимка, а не выведено формулой второй раз: `suggested` в нём и
        // есть `max(0, потребность − остаток − уже заказано)` по тем самым числам, что сверены
        // шагом 6, — а второе вычисление того же на месте разошлось бы с первым при первой же
        // правке правила.
        suggestedQuantity: now.suggested,
      };
    }),
  );
}

/**
 * Уже созданная закупка под тем же ключом — вместе с её отпечатком (Р17, шаги 2, 4 и 8).
 *
 * ПАРА «АВТОР + КЛЮЧ», а не ключ сам по себе: ключ описывает попытку КОНКРЕТНОГО человека, и
 * совпадение UUID у двоих (пусть невероятное) не должно превращать чужую закупку в «повтор». Ровно
 * этой парой объявлено и уникальное ограничение.
 */
async function findByIdempotencyKey(
  runner: Tx | typeof db,
  actorId: string,
  key: string,
): Promise<{ id: string; fingerprint: string } | null> {
  const [row] = await runner
    .select({
      id: officeEquipmentPurchases.id,
      fingerprint: officeEquipmentPurchases.idempotencyFingerprint,
    })
    .from(officeEquipmentPurchases)
    .where(
      and(
        eq(officeEquipmentPurchases.createdBy, actorId),
        eq(officeEquipmentPurchases.idempotencyKey, key),
      ),
    );
  return row ?? null;
}

export default async function officeEquipmentPurchasesRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  /*
   * ОДИН СТРАЖ НА ВСЕ РУЧКИ, и это следствие Р12, а не экономия. У закупки одна сторона: заводит,
   * проводит, закрывает и отменяет её держатель одного права, и шесть коридоров, разведённых по
   * сторонам (как у заявки на обслуживание), ей не нужны — ни второй стороны, ни исполнителя у
   * бумаги для снабжения не бывает.
   */
  const canManage = app.requirePermission(
    'officeEquipmentPurchases.manage',
    'Плановые закупки расходников ведёт ответственный за них',
  );

  /**
   * Список. Порядок по умолчанию — свежие сверху: закупку ищут по номеру редко, а «что сейчас у
   * снабжения» спрашивают каждый раз.
   *
   * Отбор по состоянию — тем же `IN`-списком, каким он приехал: набор состояний в запросе выражает
   * рабочий срез «все открытые», и одним значением его не выразить.
   */
  r.get(
    '/',
    {
      preHandler: [app.authenticate, canManage],
      schema: { querystring: officeEquipmentPurchaseListQuerySchema },
    },
    async (req) => {
      const q = req.query;
      const where =
        q.status === undefined ? undefined : inArray(officeEquipmentPurchases.status, q.status);
      const sortCols = {
        num: officeEquipmentPurchases.num,
        createdAt: officeEquipmentPurchases.createdAt,
        updatedAt: officeEquipmentPurchases.updatedAt,
      };
      const p2 = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        purchaseQuery(db)
          .where(where)
          .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'num'))
          .limit(p2.limit)
          .offset(p2.offset),
        db.select({ c: count() }).from(officeEquipmentPurchases).where(where),
      ]);
      return {
        items: rows.map(toPurchaseDto),
        total: Number(totalRows[0]!.c),
        page: p2.page,
        pageSize: p2.pageSize,
      };
    },
  );

  /**
   * ПРЕДЗАПОЛНЕНИЕ ФОРМЫ (Р16, Р17 шаг 0) — отдельная ручка, а не поле списка расходников.
   *
   * Отдельная потому, что вопросы разные. Перечень отвечает «что у нас есть и в каком состоянии»,
   * и в нём законны позиции с нулевой потребностью, погашенные и те, где заказывать нечего.
   * Предзаполнение отвечает «что заказать прямо сейчас», и всё перечисленное из него выпадает:
   *
   *   · ПОГАШЕННЫЕ — гашение означает «больше не покупаем» (Р13);
   *   · С НУЛЕВОЙ ПОТРЕБНОСТЬЮ — ноль означает «не следим», и предложи мы их, форма звала бы
   *     заказать всё, чего нет на складе, включая то, что сознательно не держат;
   *   · С НЕПОЛОЖИТЕЛЬНЫМ «к закупке» — заказывать нечего, а строка с нулём в форме читалась бы
   *     как «закажите ноль».
   *
   * ПОРОГ ВЫЧИТАЕТ УЖЕ ЗАКАЗАННОЕ (Р15), и без этого вторая открытая форма предложила бы те же
   * количества, а склад заказал бы вдвое — это блокер, найденный вторым ревью плана.
   *
   * СЧИТАЕТ СЕРВЕР, ОДНИМ ЗАПРОСОМ И ОДНОЙ ФОРМУЛОЙ — той же самой, что отдаёт столбцы перечня
   * расходников. Два вычислителя дефицита разошлись бы, а по этому числу заказывают.
   *
   * СТРАНИЦ У НЕЁ НЕТ намеренно: это не список, а состав одного документа. Позиций с дефицитом в
   * справочнике десятки, форма показывает их разом, и «страница 2 закупки» была бы приглашением
   * забыть половину заказа.
   */
  r.get(
    '/prefill',
    { preHandler: [app.authenticate, canManage] },
    async (): Promise<OfficeEquipmentPurchasePrefillDto> => {
      /*
       * Ссылка наружу — отдельным `sql`-объектом, по тому же правилу, что и во всех подзапросах
       * этого модуля (разбор — у `consumableIdRef` в `routes/office-equipment-consumables.ts`).
       * Вписанная на месте колонка дала бы `consumable_id = id` строки закупки — сравнение двух
       * чужих колонок, всегда ложное, — и «уже заказано» стало бы нулём у каждой позиции. Форма
       * предложила бы заказать то, что уже везут.
       */
      const idRef = sql`${officeEquipmentConsumables}."id"`;
      const alreadyOrdered = alreadyOrderedExpr(idRef);
      const suggested = deficitExpr(
        sql`${officeEquipmentConsumables}."required_quantity"`,
        sql`${officeEquipmentConsumables}."quantity"`,
        alreadyOrdered,
      );
      const rows = await db
        .select({
          consumableId: officeEquipmentConsumables.id,
          code: officeEquipmentConsumables.code,
          name: officeEquipmentConsumables.name,
          color: officeEquipmentConsumables.color,
          required: officeEquipmentConsumables.requiredQuantity,
          stock: officeEquipmentConsumables.quantity,
          alreadyOrdered,
          suggested,
        })
        .from(officeEquipmentConsumables)
        .where(
          and(
            eq(officeEquipmentConsumables.isActive, true),
            sql`${officeEquipmentConsumables.requiredQuantity} > 0`,
            sql`${suggested} > 0`,
          ),
        )
        // Порядок — по наименованию: форму читают глазами и сверяют со счётом, а не с номером
        // строки. По убыванию дефицита было бы «полезнее», но тогда одна и та же позиция каждый
        // раз оказывалась бы в новом месте формы.
        .orderBy(asc(officeEquipmentConsumables.name));
      /*
       * Открытые закупки по тем же позициям — ссылками (Р15). Запрета на вторую нет: снабжение
       * возит частями, и законный случай нельзя запрещать ради защиты от случайного. Но человек
       * обязан ВИДЕТЬ, что заказ уже идёт, — именно потому, что одного вычитания мало: раз вторая
       * закупка законна, отличить её от случайного дубля ограничением нечем, и защиту даёт
       * протокол сохранения (Р17), а не запрет.
       */
      const open = await openPurchasesByConsumable(
        db,
        rows.map((row) => row.consumableId),
      );
      return {
        rows: rows.map((row) => ({
          consumableId: row.consumableId,
          code: row.code,
          name: row.name,
          color: row.color,
          required: row.required,
          stock: row.stock,
          alreadyOrdered: Number(row.alreadyOrdered),
          suggested: Number(row.suggested),
          openPurchases: open.get(row.consumableId) ?? [],
        })),
      };
    },
  );

  /**
   * Карточка: шапка, лента переходов из своих колонок и строки со снимком расчёта. Статический
   * `prefill` объявлен выше нарочно — читается так же, как работает, хотя маршрутизатор Fastify
   * предпочёл бы статический сегмент параметру и при обратном порядке.
   */
  r.get(
    '/:id',
    { preHandler: [app.authenticate, canManage], schema: { params: idParams } },
    async (req): Promise<OfficeEquipmentPurchaseDetailDto> => loadPurchaseDetail(db, req.params.id),
  );

  /**
   * ЗАВЕДЕНИЕ — ПРОТОКОЛ Р17, И ПОРЯДОК ЕГО ШАГОВ ВАЖНЕЕ ИХ СОДЕРЖАНИЯ.
   *
   * Задача протокола названа в плане одной картинкой: двое открыли форму на «к закупке 10» и
   * сохранят двадцать, причём НИ ОДНО ограничение базы при этом не нарушится — вторая открытая
   * закупка законна. Значит защита обязана быть протоколом сохранения, а не ограничением; взят он
   * у правки остатка (`FOR UPDATE` + сверка ожидаемого + 409), и это прямое заимствование: ошибка
   * там того же класса — «в форме число, которого на складе уже нет».
   *
   *   1. НОРМАЛИЗОВАТЬ ТЕЛО И ПОСЧИТАТЬ ОТПЕЧАТОК. Нормализация обязательна ДО отпечатка: строки
   *      упорядочиваются по позиции, комментарий обрезается по краям — иначе переставленные
   *      местами строки той же закупки дали бы «другую команду под тем же ключом».
   *
   *   2. СПРОСИТЬ КЛЮЧ — ДО ВСЯКИХ БЛОКИРОВОК И ДО СВЕРКИ СНИМКА. Это самый неочевидный шаг, и
   *      редакция 4 плана ошиблась именно на нём, поставив ключ последним. При потерянном ответе
   *      первая закупка УЖЕ подняла «уже заказано», значит повтор получил бы 409 на снимке, не
   *      дойдя до собственного ключа, — то есть обещание «повтор вернёт исходную закупку» не
   *      выполнялось бы ровно в том случае, ради которого ключ и заводится. Отпечаток тот же —
   *      вернуть созданную закупку и НИЧЕГО БОЛЬШЕ НЕ ДЕЛАТЬ, в том числе не писать второе событие
   *      аудита; отпечаток другой — 409.
   *
   *   3. ВЗЯТЬ `FOR UPDATE` НА СТРОКИ РАСХОДНИКОВ ПО ВОЗРАСТАНИЮ `id`. Порядок фиксирован и тот
   *      же, что у правки остатка и у выдачи по заявке: встречный порядок захвата двух ручек даёт
   *      `40P01` на ровном месте — этот модуль уже ловил такое у переименования модели.
   *
   *   4. СПРОСИТЬ КЛЮЧ ЕЩЁ РАЗ, УЖЕ ПОД БЛОКИРОВКОЙ. Два одинаковых запроса способны одновременно
   *      не увидеть ключа на шаге 2, и без второго чтения оба пошли бы создавать.
   *
   *   5. ПЕРЕСЧИТАТЬ под блокировкой: потребность и остаток из запертых строк, «уже заказано» —
   *      суммой строк открытых закупок.
   *
   *   6. СНИМОК РАЗОШЁЛСЯ — 409 с новыми числами по каждой изменившейся строке.
   *
   *   7. ШАПКА И СТРОКИ — ОДНОЙ ТРАНЗАКЦИЕЙ. Иначе закупка без строк становится видимой между
   *      двумя запросами и попадает в чужой расчёт «уже заказано» нулём. Аудит пишется здесь же,
   *      строгим `writeAuditTx`.
   *
   *   8. ГОНКУ УНИКАЛЬНОГО КЛЮЧА ЛОВИТЬ СНАРУЖИ ПРЕРВАННОЙ ТРАНЗАКЦИИ И ТОЛЬКО ПО ИМЕНИ
   *      ОГРАНИЧЕНИЯ. Два запроса с одним ключом, но НЕПЕРЕСЕКАЮЩИМИСЯ позициями, на блокировках
   *      расходников не встретятся вовсе — шаги 3 и 4 их не разведут, разведёт только уникальный
   *      ключ. Разбор — у `asIdempotentRepeat` ниже.
   */
  r.post(
    '/',
    {
      preHandler: [app.authenticate, canManage],
      schema: { body: createOfficeEquipmentPurchaseSchema },
    },
    async (req, reply): Promise<OfficeEquipmentPurchaseDetailDto> => {
      const p = requirePrincipal(req);
      const b = req.body;
      const key = idempotencyKeyOf(req);
      // Шаг 1.
      const fingerprint = purchaseFingerprint(b);

      /*
       * Шаг 2. Вне транзакции и до блокировок — см. разбор в шапке ручки. Повтор потерянного
       * ответа заканчивается ЗДЕСЬ и не идёт дальше: ни блокировок, ни записи, ни второго события
       * аудита он не делает.
       */
      const seen = await findByIdempotencyKey(db, p.id, key);
      if (seen) {
        if (seen.fingerprint !== fingerprint) idempotencyConflict();
        return await loadPurchaseDetail(db, seen.id);
      }

      const consumableIds = b.items.map((i) => i.consumableId);
      const created = await db
        .transaction(async (tx) => {
          // Шаг 3.
          const calc = await lockAndCalcConsumables(tx, consumableIds);
          /*
           * Шаг 4. Повторное чтение ключа — уже под блокировкой. Оно ловит ровно тот случай, когда
           * два одинаковых запроса разминулись на шаге 2: тот, кто занял блокировки первым, к
           * этому моменту закоммитился, и второй обязан увидеть его строку, а не пойти создавать
           * вторую.
           */
          const underLock = await findByIdempotencyKey(tx, p.id, key);
          if (underLock) {
            if (underLock.fingerprint !== fingerprint) idempotencyConflict();
            return { id: underLock.id, repeated: true as const };
          }
          // Шаг 5 частью уже сделан `lockAndCalcConsumables`; здесь — проверки состава и снимка.
          assertConsumablesUsable(consumableIds, calc);
          // Шаг 6.
          assertSnapshotFresh(b.items, calc);
          // Шаг 7.
          const [header] = await tx
            .insert(officeEquipmentPurchases)
            .values({
              comment: b.comment,
              createdBy: p.id,
              idempotencyKey: key,
              idempotencyFingerprint: fingerprint,
            })
            .returning({
              id: officeEquipmentPurchases.id,
              num: officeEquipmentPurchases.num,
            });
          const purchase = header!;
          await insertItems(tx, purchase.id, b.items, calc);
          await writeAuditTx(tx, {
            actorUserId: p.id,
            action: 'officeEquipmentPurchase.create',
            entityType: 'officeEquipmentPurchase',
            entityId: purchase.id,
            metadata: {
              displayNumber: formatOfficeEquipmentPurchaseNumber(purchase.num),
              itemCount: b.items.length,
              totalQuantity: b.items.reduce((sum, i) => sum + i.quantity, 0),
            },
          });
          return { id: purchase.id, repeated: false as const };
        })
        // Шаг 8.
        .catch(async (e: unknown) => asIdempotentRepeat(e, p, key, fingerprint));

      /*
       * 201 только у настоящего заведения. Повтор потерянного ответа отвечает 200: ресурс этим
       * запросом не создавался, и сказать «создано» значило бы соврать клиенту, который как раз и
       * пытается понять, создавал он что-нибудь или нет.
       */
      if (!created.repeated) reply.code(201);
      return await loadPurchaseDetail(db, created.id);
    },
  );

  /**
   * Разбор гонки уникального ключа (Р17, шаг 8) — СНАРУЖИ уже прерванной транзакции.
   *
   * ПОЧЕМУ СНАРУЖИ. К моменту `23505` транзакция прервана, и читать в ней нечего: любой запрос в
   * ней ответит `25P02`. Победившая строка перечитывается новым запросом, отпечаток сравнивается
   * ещё раз — совпал, возвращаем её; не совпал, отвечаем 409.
   *
   * ПОЧЕМУ ПО ПАРЕ «КОД + ИМЯ», А НЕ ПО ОДНОМУ КОДУ. `23505` в этой транзакции способны дать и
   * другие ограничения — уникальность номера закупки, пара «закупка + позиция» в строках,
   * ограничения строгого аудита. Перехвати мы код целиком, настоящий дефект базы вернулся бы
   * клиенту как УСПЕШНЫЙ ПОВТОР, то есть чужой закупкой вместо ошибки. Имя не то — исходная ошибка
   * летит дальше нетронутой; имя задано руками в миграции `0227` именно ради этого разбора
   * (сгенерированное было бы хрупким: оно не названо нигде и меняется вместе с составом колонок).
   *
   * ТО ЖЕ ПРАВИЛО НА ВТОРОЙ СЛУЧАЙ: имя совпало, а строки по ключу не нашлось — её успели удалить,
   * ключ занят чем-то, чего уже нет. Это тоже не повтор, и придумывать ответ здесь нельзя: ручка
   * отвечает тем же 409 «ключ занят», а не молчаливым успехом с чужим документом.
   *
   * Через `pgErrorOf`, потому что drizzle оборачивает ошибку драйвера в свою и на верхнем объекте
   * ни кода, ни имени ограничения уже нет — прямая проверка молчала бы.
   */
  async function asIdempotentRepeat(
    e: unknown,
    p: Principal,
    key: string,
    fingerprint: string,
  ): Promise<{ id: string; repeated: true }> {
    const pg = pgErrorOf(e);
    if (pg?.code !== '23505' || pg.constraint !== PURCHASE_IDEMPOTENCY_CONSTRAINT) throw e;
    const winner = await findByIdempotencyKey(db, p.id, key);
    if (!winner || winner.fingerprint !== fingerprint) idempotencyConflict();
    return { id: winner.id, repeated: true };
  }

  /**
   * ПРАВКА ЧЕРНОВИКА — ТОЛЬКО В «НОВОЙ» И ПОД ВЕРСИЕЙ СОДЕРЖИМОГО (Р18).
   *
   * После проведения состав не правится вовсе, и ошибка исправляется отменой с причиной и новой
   * закупкой: «В работе» означает, что бумага у снабжения, и переписанный задним числом состав
   * разошёлся бы с тем, по чему заказывают.
   *
   * ИДЁТ ТЕМ ЖЕ ПРОТОКОЛОМ Р17 — блокировка, пересчёт, сверка снимка, — но с одной поправкой:
   * СОБСТВЕННЫЙ ВКЛАД ПРАВИМОЙ ЗАКУПКИ ИЗ «уже заказано» ВЫЧИТАЕТСЯ. Без этого черновик
   * конфликтовал бы сам с собой: его же строки лежат в «уже заказано», снимка формы в них нет, и
   * первая же правка получала бы 409 на ровном месте.
   *
   * И ЭТОГО МАЛО — ОТСЮДА `content_version`. Довод «состояние само по себе и есть версия» верен
   * для переходов и неверен для правки полей, и разница видна на одном сценарии: двое открыли
   * черновик на 10, первый поставил 12 и сохранил, второй ставит 8. Снимок Р17 у второго СОШЁЛСЯ —
   * внешнее состояние не менялось, а собственный вклад закупки из него и так вычитается, — и
   * правка молча перетёрла бы 12 на 8.
   *
   * НОЛЬ СТРОК УСЛОВНОЙ ЗАПИСИ ОЗНАЧАЕТ ОДНО ИЗ ДВУХ, И ОТВЕТ ОБЯЗАН ИХ РАЗЛИЧАТЬ: закупку уже
   * провели (409 с текущим статусом) либо её правил другой (409 с новой версией и свежим
   * содержимым). Один ответ на два случая заставил бы человека гадать, куда делась его правка.
   */
  r.patch(
    '/:id',
    {
      preHandler: [app.authenticate, canManage],
      schema: { params: idParams, body: updateOfficeEquipmentPurchaseSchema },
    },
    async (req): Promise<OfficeEquipmentPurchaseDetailDto> => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const b = req.body;
      await db.transaction(async (tx) => {
        const [current] = await tx
          .select({
            num: officeEquipmentPurchases.num,
            status: officeEquipmentPurchases.status,
          })
          .from(officeEquipmentPurchases)
          .where(eq(officeEquipmentPurchases.id, id));
        if (!current) throw err.notFound(PURCHASE_NOT_FOUND);
        /*
         * Ранний отказ по статусу — ради текста, а не ради правильности: условная запись ниже
         * отбила бы то же самое, но не смогла бы отличить «уже провели» от «правил другой».
         * Настоящую защиту даёт именно она — между этим чтением и записью статус успевает
         * измениться.
         */
        if (current.status !== 'new') {
          statusConflict(
            current.num,
            current.status,
            'Закупку уже провели — состав правится только в «Новой»',
          );
        }
        /*
         * Блокируются ПОЗИЦИИ ОБОИХ СОСТАВОВ — и нового, и снимаемого. Снимаемые нужны потому, что
         * их строки сейчас лежат в чужом «уже заказано»: соседнее заведение, считающее дефицит по
         * той же позиции, обязано либо увидеть их, либо дождаться нас, а не разойтись с нами на
         * полпути. Порядок захвата — по возрастанию `id`, и его задаёт сам загрузчик.
         */
        const previous = await tx
          .select({ consumableId: officeEquipmentPurchaseItems.consumableId })
          .from(officeEquipmentPurchaseItems)
          .where(eq(officeEquipmentPurchaseItems.purchaseId, id));
        const nextIds = b.items.map((i) => i.consumableId);
        const calc = await lockAndCalcConsumables(
          tx,
          [...nextIds, ...previous.map((row) => row.consumableId)],
          // Собственный вклад правимой закупки — вон из «уже заказано» (см. шапку ручки).
          id,
        );
        assertConsumablesUsable(nextIds, calc);
        assertSnapshotFresh(b.items, calc);
        /*
         * УСЛОВНАЯ ЗАПИСЬ: статус и версия стоят В УСЛОВИИ, а не проверяются чтением выше. Ровно
         * это и есть защита — чтение с последующим `UPDATE` оставляет между собой щель, в которую
         * пролезает и проведение, и чужая правка.
         */
        const updated = await tx
          .update(officeEquipmentPurchases)
          .set({
            comment: b.comment,
            contentVersion: sql`${officeEquipmentPurchases.contentVersion} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(officeEquipmentPurchases.id, id),
              eq(officeEquipmentPurchases.status, 'new'),
              eq(officeEquipmentPurchases.contentVersion, b.contentVersion),
            ),
          )
          .returning({ contentVersion: officeEquipmentPurchases.contentVersion });
        if (updated.length !== 1) {
          /*
           * Ноль строк. Перечитываем состояние и РАЗЛИЧАЕМ два случая: статус уехал — 409 со
           * статусом («уже провели»), статус тот же — значит разошлась версия, и это чужая правка:
           * 409 со свежим содержимым.
           */
          const [after] = await tx
            .select({
              num: officeEquipmentPurchases.num,
              status: officeEquipmentPurchases.status,
            })
            .from(officeEquipmentPurchases)
            .where(eq(officeEquipmentPurchases.id, id));
          if (!after) throw err.notFound(PURCHASE_NOT_FOUND);
          if (after.status !== 'new') {
            statusConflict(
              after.num,
              after.status,
              'Закупку уже провели — состав правится только в «Новой»',
            );
          }
          await versionConflict(tx, id);
        }
        /*
         * Состав переписывается целиком, а не сводится построчно: строка закупки — это состав
         * документа, а не его история (у неё и `CASCADE` по той же причине). Снимок расчёта в ней
         * при этом обновляется на сегодняшний — правка и есть новое решение, принятое по новым
         * числам, и оставить в строке снимок первой отправки значило бы соврать о том, из чего
         * вышло исправленное количество.
         */
        await tx
          .delete(officeEquipmentPurchaseItems)
          .where(eq(officeEquipmentPurchaseItems.purchaseId, id));
        await insertItems(tx, id, b.items, calc);
        await writeAuditTx(tx, {
          actorUserId: p.id,
          action: 'officeEquipmentPurchase.update',
          entityType: 'officeEquipmentPurchase',
          entityId: id,
          metadata: {
            displayNumber: formatOfficeEquipmentPurchaseNumber(current.num),
            contentVersion: updated[0]!.contentVersion,
            itemCount: b.items.length,
            totalQuantity: b.items.reduce((sum, i) => sum + i.quantity, 0),
          },
        });
      });
      return await loadPurchaseDetail(db, id);
    },
  );

  /**
   * «ПРОВЕСТИ» (`new` → `in_work`) — передать бумагу в снабжение.
   *
   * ЕДИНСТВЕННЫЙ ПЕРЕХОД, НЕСУЩИЙ ВЕРСИЮ СОДЕРЖИМОГО (Р18), и это не осторожность: в снабжение
   * уезжает СОСТАВ, и провести надо ровно тот, который человек видел на экране. Правка соседа,
   * приехавшая между открытием карточки и нажатием кнопки, меняет именно его — а после проведения
   * состав уже не правится вовсе.
   *
   * Условной записью, как и все ходы (Р10): `WHERE id = ? AND status = 'new' AND content_version = ?`
   * с обязательным `ROW_COUNT = 1`.
   */
  r.post(
    '/:id/submit',
    {
      preHandler: [app.authenticate, canManage],
      schema: { params: idParams, body: submitOfficeEquipmentPurchaseSchema },
    },
    async (req): Promise<OfficeEquipmentPurchaseDetailDto> => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const now = new Date();
      await db.transaction(async (tx) => {
        const moved = await tx
          .update(officeEquipmentPurchases)
          .set({
            status: 'in_work',
            submittedBy: p.id,
            submittedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(officeEquipmentPurchases.id, id),
              eq(officeEquipmentPurchases.status, 'new'),
              eq(officeEquipmentPurchases.contentVersion, req.body.expectedVersion),
            ),
          )
          .returning({ num: officeEquipmentPurchases.num });
        if (moved.length !== 1) {
          await refuseTransition(tx, id, 'new', 'Закупка уже не «Новая» — обновите карточку');
        }
        await writeAuditTx(tx, {
          actorUserId: p.id,
          action: 'officeEquipmentPurchase.submit',
          entityType: 'officeEquipmentPurchase',
          entityId: id,
          metadata: {
            displayNumber: formatOfficeEquipmentPurchaseNumber(moved[0]!.num),
            contentVersion: req.body.expectedVersion,
          },
        });
      });
      return await loadPurchaseDetail(db, id);
    },
  );

  /**
   * «ЗАКРЫТЬ» (`in_work` → `closed`) с подтверждением «приход занесён» (Р11).
   *
   * ПОДТВЕРЖДЕНИЕ ОБЯЗАТЕЛЬНО И НИЧЕГО НЕ ДОКАЗЫВАЕТ. Проверить порядок «сначала приход, потом
   * закрытие» портал не может: текущий остаток не доказывает, что приход именно по ЭТОЙ закупке, —
   * между открытием и закрытием были выдачи по заявкам, ручные корректировки и, возможно, приход
   * по соседней закупке. Сопоставить движение с закупкой нечем, пока у журнала остатка нет вида
   * события «приход со ссылкой на закупку», а его на альфе нет по решению заказчика.
   *
   * Поэтому галочка делает ровно две вещи: заставляет прочитать правило в момент, когда оно
   * применяется, и оставляет имя того, кто это утверждал. СВОИХ КОЛОНОК У НЕЁ НЕТ — след
   * подтверждения — сама пара `closed_by/at`: закупка закрыта, значит подтверждение было. Пара
   * `stock_confirmed_by/at` дублировала бы её и однажды с ней разошлась бы.
   *
   * ЗАКРЫТИЕ ВЕРСИИ НЕ НЕСЁТ, в отличие от проведения, и это не забывчивость: состав к этому
   * моменту уже неизменяем — править его нельзя с самого перехода в «В работе», — и стеречь тут
   * нечего, кроме самого статуса.
   */
  r.post(
    '/:id/close',
    {
      preHandler: [app.authenticate, canManage],
      schema: { params: idParams, body: closeOfficeEquipmentPurchaseSchema },
    },
    async (req): Promise<OfficeEquipmentPurchaseDetailDto> => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const now = new Date();
      await db.transaction(async (tx) => {
        const moved = await tx
          .update(officeEquipmentPurchases)
          .set({ status: 'closed', closedBy: p.id, closedAt: now, updatedAt: now })
          .where(
            and(
              eq(officeEquipmentPurchases.id, id),
              eq(officeEquipmentPurchases.status, 'in_work'),
            ),
          )
          .returning({ num: officeEquipmentPurchases.num });
        if (moved.length !== 1) {
          /*
           * `null`, а не `'in_work'`: у закрытия НЕТ условия по версии — состав к этому моменту уже
           * неизменяем, — значит ноль строк объясняется только статусом, и «правил другой» здесь
           * невозможно по построению. Скажи мы `'in_work'`, отказ однажды соврал бы про чужую
           * правку там, где её не бывает.
           */
          await refuseTransition(
            tx,
            id,
            null,
            'Закрыть можно только закупку «В работе» — обновите карточку',
          );
        }
        await writeAuditTx(tx, {
          actorUserId: p.id,
          action: 'officeEquipmentPurchase.close',
          entityType: 'officeEquipmentPurchase',
          entityId: id,
          metadata: {
            displayNumber: formatOfficeEquipmentPurchaseNumber(moved[0]!.num),
            // Подтверждение — в журнал: колонок у него нет, и это единственное место, где остаётся
            // след того, что человек его прочитал и поставил (Р11).
            stockReceiptConfirmed: true,
          },
        });
      });
      return await loadPurchaseDetail(db, id);
    },
  );

  /**
   * «ОТМЕНИТЬ» — из «Новой» и из «В работе», с обязательной причиной (Р10).
   *
   * ЗАКРЫТУЮ ОТМЕНИТЬ НЕЛЬЗЯ: закрытая и отменённая — конечные состояния, и ошибку исправляют новой
   * закупкой, а не переписыванием прошлой. Административного отката на альфе нет вовсе;
   * единственный осмысленный — «закрыли по ошибке» — разрешается тем же способом.
   *
   * ДВА ИСХОДНЫХ СОСТОЯНИЯ В ОДНОМ УСЛОВИИ, а не две ручки: отмена — один ход с одной причиной, и
   * различать «отменил из Новой» от «отменил из В работе» шапке нечем — прежнее состояние она не
   * хранит. Именно поэтому `CHECK` пары проведения у отменённой ослаблен: отменить можно и до
   * проведения, и после, а по статусу `cancelled` эти два случая уже не различить.
   */
  r.post(
    '/:id/cancel',
    {
      preHandler: [app.authenticate, canManage],
      schema: { params: idParams, body: cancelOfficeEquipmentPurchaseSchema },
    },
    async (req): Promise<OfficeEquipmentPurchaseDetailDto> => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const now = new Date();
      await db.transaction(async (tx) => {
        const moved = await tx
          .update(officeEquipmentPurchases)
          .set({
            status: 'cancelled',
            cancelledBy: p.id,
            cancelledAt: now,
            cancelReason: req.body.reason,
            updatedAt: now,
          })
          .where(
            and(
              eq(officeEquipmentPurchases.id, id),
              inArray(officeEquipmentPurchases.status, ['new', 'in_work']),
            ),
          )
          .returning({ num: officeEquipmentPurchases.num });
        if (moved.length !== 1) {
          await refuseTransition(
            tx,
            id,
            null,
            'Отменить можно только «Новую» или «В работе» — обновите карточку',
          );
        }
        await writeAuditTx(tx, {
          actorUserId: p.id,
          action: 'officeEquipmentPurchase.cancel',
          entityType: 'officeEquipmentPurchase',
          entityId: id,
          metadata: {
            displayNumber: formatOfficeEquipmentPurchaseNumber(moved[0]!.num),
            reason: req.body.reason,
          },
        });
      });
      return await loadPurchaseDetail(db, id);
    },
  );

  /**
   * Ноль строк условного перехода — объяснить, а не отвечать «конфликт» (Р10).
   *
   * ПОЧЕМУ ЭТО НЕ РОСКОШЬ. Ноль означает «состояние уже другое», и без такого разбора параллельные
   * «Закрыть» и «Отменить» отвечали бы одинаковым молчанием — а человеку надо знать, что документ
   * УЖЕ отменил сосед, и не жать кнопку второй раз. Заодно здесь отделяется исчезнувшая закупка:
   * ноль строк бывает и от того, что документа нет вовсе, и 404 честнее 409.
   *
   * `expected` — то состояние, из которого ход разрешён; `null` означает «их несколько» (отмена).
   * Совпало — значит условие отбил не статус, а версия содержимого: так бывает у «Провести», и
   * ответ на это другой (свежее содержимое, а не текущий статус).
   */
  async function refuseTransition(
    tx: Tx,
    id: string,
    expected: OfficeEquipmentPurchaseStatus | null,
    message: string,
  ): Promise<never> {
    const [row] = await tx
      .select({ num: officeEquipmentPurchases.num, status: officeEquipmentPurchases.status })
      .from(officeEquipmentPurchases)
      .where(eq(officeEquipmentPurchases.id, id));
    if (!row) throw err.notFound(PURCHASE_NOT_FOUND);
    if (expected !== null && row.status === expected) await versionConflict(tx, id);
    statusConflict(row.num, row.status, message);
  }
}

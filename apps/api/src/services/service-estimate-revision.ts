import { and, asc, eq, inArray, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import {
  SERVICE_CLOSING_DOCUMENT_KINDS,
  SERVICE_DOCUMENT_FORMAT_CLOSING_KINDS,
  type ServiceEstimateExemptionOutcome,
  type ServiceEstimateFormat,
  type ServiceRequestEstimateDisputeDto,
  type ServiceRequestEstimateExemptionDto,
} from '@technic/contracts';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/client';
import {
  serviceRequestEstimateDisputes,
  serviceRequestEstimateExemptions,
  serviceRequestEstimateRevisions,
  serviceRequestFiles,
  users,
} from '../db/schema';
import { err } from '../lib/errors';

/**
 * Ревизии объёма работ заявки оргтехники: запись строки ревизии и чтение формата действующей —
 * Э3 плана `docs/office-equipment-on-site-and-invoice-estimate-plan.md` (решения Р4, Р5).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ, А НЕ ПОМОЩНИК В МАРШРУТЕ. Читателей правила «какая бумага закрывает
 * заявку» семь (Н8 плана), и двое из них — SQL: очередь «Ожидаются документы» в
 * `routes/service-requests.ts` и отбор пачки автозакрытия в `routes/internal-service-requests.ts`.
 * Второй живёт в другом файле и в другом процессе (его будит worker), и пока условие было написано
 * словами в обоих, оно уже разъезжалось: перечень видов пришлось сводить в контракты отдельной
 * правкой. Формат ревизии добавляет к правилу второй признак — разойтись теперь есть чему дважды.
 *
 * ФОРМАТ ЧИТАЕТСЯ ИЗ СТРОКИ РЕВИЗИИ, А НЕ ВЫВОДИТСЯ ИЗ СОСТАВА. Догадка «строк нет — значит
 * документ» разошлась бы с правдой на первой же раскладке «Ведения»: она переиздаёт документную
 * ревизию в построчную, и признак обязан это пережить (Р4).
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = typeof db | Tx;

/**
 * Формат ДЕЙСТВУЮЩЕЙ ревизии заявки; `null` — ревизий нет вовсе (заявка-наследие либо смета ещё не
 * предъявлялась), и это законное значение: планка закрывающего документа у него сегодняшняя
 * (`closingKindsForFormat` в контрактах).
 *
 * «Действующая» — это `state = 'active'`, и гасит её только СЛЕДУЮЩЕЕ предъявление. Возврат в правку
 * (`reopen`) ревизию не гасит намеренно: номер остаётся в заявке, строки объёма работ остаются на
 * месте, и формат по-прежнему описывает то, что в заявке лежит, — снять состояние значило бы
 * ответить «ревизии нет» заявке, у которой она есть. Отсюда инвариант, на который опираются все
 * читатели: активная строка — это ровно та, чей номер стоит в `service_requests.estimate_revision`
 * (а при нуле строк нет вовсе — полный сброс их снимает, см. `dropEstimateRevisions`).
 *
 * Больше одной активной быть не может — это держит частичный уникальный индекс
 * `service_request_estimate_revisions_active_unique`, а не аккуратность маршрутов.
 *
 * Исполнитель передаётся тот же, в котором взята блокировка заявки: формат решает, какая бумага
 * закрывает заявку, и прочитанный мимо транзакции он отвечал бы про состояние до раскладки
 * «Ведения», которая помещается между открытием окна и нажатием кнопки (Р8).
 */
export async function readActiveEstimateFormat(
  exec: Exec,
  requestId: string,
): Promise<ServiceEstimateFormat | null> {
  const [row] = await exec
    .select({ format: serviceRequestEstimateRevisions.format })
    .from(serviceRequestEstimateRevisions)
    .where(
      and(
        eq(serviceRequestEstimateRevisions.requestId, requestId),
        eq(serviceRequestEstimateRevisions.state, 'active'),
      ),
    )
    .limit(1);
  return row?.format ?? null;
}

/**
 * То же одним запросом на страницу: список заявок — горячий путь, и строка на заявку стоила бы
 * полусотни запросов там, где хватает одного. Заявки без ревизий в карту не попадают вовсе —
 * отсутствие ключа и означает `null` (планка наследия), а не «не посчитали».
 */
export async function activeEstimateFormatByRequest(
  ids: string[],
): Promise<Map<string, ServiceEstimateFormat>> {
  const map = new Map<string, ServiceEstimateFormat>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({
      requestId: serviceRequestEstimateRevisions.requestId,
      format: serviceRequestEstimateRevisions.format,
    })
    .from(serviceRequestEstimateRevisions)
    .where(
      and(
        inArray(serviceRequestEstimateRevisions.requestId, ids),
        eq(serviceRequestEstimateRevisions.state, 'active'),
      ),
    );
  for (const row of rows) map.set(row.requestId, row.format);
  return map;
}

/**
 * Записать строку предъявленной ревизии — **единственное место, где она появляется**, и зовут его
 * оба пути подъёма номера: предъявление исполнителя и переиздание раскладкой «Ведения».
 *
 * ПОРЯДОК ШАГОВ ОБЯЗАТЕЛЕН: прежняя активная гасится ДО вставки новой. Частичный уникальный индекс
 * «одна активная на заявку» немедленный, и обратный порядок отказал бы на втором же предъявлении.
 *
 * СУММА — СНИМОК, А НЕ ПРОИЗВОДНАЯ, и `null` у неё означает «неизвестна», а не ноль: у документной
 * подачи (Э4) содержимое счёта системе ещё неизвестно, и записанный ноль читался бы как «работы
 * бесплатны» — тот же запрет, что у итога по акту (Р2). У гарантийного формата ноль, напротив,
 * настоящая цена: служебная нулевая строка — и есть объём работ «чиним по гарантии, денег нет».
 *
 * Строка пишется ТОЙ ЖЕ транзакцией, что подъём номера в заявке: аудит модуля уходит после
 * `COMMIT`, и сбой между ними оставил бы денежное решение без единой записи о том, кто его принял
 * (Р4).
 */
export async function recordEstimateRevision(
  tx: Tx,
  params: {
    requestId: string;
    revision: number;
    format: ServiceEstimateFormat;
    submittedBy: string;
    /** `null` — сумма неизвестна; у построчного и гарантийного формата это итог строк. */
    totalAmount: string | null;
  },
): Promise<void> {
  await tx
    .update(serviceRequestEstimateRevisions)
    .set({ state: 'superseded', updatedAt: new Date() })
    .where(
      and(
        eq(serviceRequestEstimateRevisions.requestId, params.requestId),
        eq(serviceRequestEstimateRevisions.state, 'active'),
      ),
    );
  await tx.insert(serviceRequestEstimateRevisions).values({
    requestId: params.requestId,
    revision: params.revision,
    format: params.format,
    state: 'active',
    submittedBy: params.submittedBy,
    submittedAt: new Date(),
    totalAmount: params.totalAmount,
  });
}

/**
 * Снять ревизии заявки целиком — спутник ПОЛНОГО СБРОСА СМЕТЫ, того самого, что обнуляет
 * `service_requests.estimate_revision` (сброс по переходу и переназначение со сменой подрядчика).
 *
 * ПОЧЕМУ СТРОКИ ИМЕННО УДАЛЯЮТСЯ, А НЕ ПОМЕЧАЮТСЯ `superseded`. Ключ ревизии — номер, а не
 * суррогат (Р4), и сброс начинает нумерацию заново: следующее предъявление той же заявки снова
 * назовётся первым. Оставь мы прежние строки — новая «ревизия 1» столкнулась бы с прежней по
 * первичному ключу, то есть предъявление после переназначения падало бы ошибкой БД. Пометка
 * состоянием от этого не спасает: она меняет смысл строки, а не её ключ.
 *
 * И ЭТО НЕ ПОТЕРЯ СЛЕДА: сброс в том и состоит, что прежнего объёма работ больше нет — строки
 * сметы он удаляет тем же шагом. Историей денежных решений заявки остаётся аудит и лента, а эта
 * таблица описывает живую смету: её формат, автора и снимок суммы.
 *
 * СБРОС У ЗАЯВКИ С ПОДАННЫМ СЧЁТОМ ОТБИВАЕТСЯ ЗДЕСЬ, А НЕ ОШИБКОЙ БД (Э4, открытый конец Э3).
 * Страницы-основания ссылаются на строку ревизии составным ключом `ON DELETE RESTRICT`
 * (`service_request_files_estimate_revision_fk`), и с открытием документного формата такая заявка
 * появилась: `DELETE` ниже у неё откажет — то есть переназначение и возврат отменённой в «Новую»
 * упали бы пятисоткой с текстом про внешний ключ. Проверка стоит В ЭТОЙ функции, а не в двух
 * ручках: полный сброс — одно правило с двумя входами, и третий, заведённый позже, унаследовал бы
 * отказ, а не ошибку драйвера.
 *
 * ИЗ ДВУХ ПУТЕЙ, НАЗВАННЫХ ПЛАНОМ, ВЫБРАН ОТКАЗ, А НЕ ПЕРЕНОС СТРАНИЦ. Переносить их некуда:
 * сброс обнуляет нумерацию, и ревизии, на которую страница могла бы сослаться, после него не
 * существует вовсе — «перенос» на деле означал бы снятие роли `estimate_basis`, то есть
 * превращение счёта-основания обратно в закрывающую бумагу (Р5, ответ В10) и обход замка Р6
 * «основание не снимается никогда» тем самым кодом, ради которого `RESTRICT` и поставлен. Цена
 * отказа названа вслух: у заявки, по которой объём работ предъявлен счётом, сменить подрядчика и
 * вернуть её в «Новую» больше нельзя — разбирают её до конца по месту либо заводят новую. Заявку
 * это не запирает: отмена сметы не сбрасывает (`serviceResetOnTransition`), и обычный цикл —
 * возврат в правку, переиздание раскладкой, спор — работает как прежде.
 */
export async function dropEstimateRevisions(tx: Tx, requestId: string): Promise<void> {
  const [basis] = await tx
    .select({ fileId: serviceRequestFiles.fileId })
    .from(serviceRequestFiles)
    .where(
      and(
        eq(serviceRequestFiles.requestId, requestId),
        eq(serviceRequestFiles.purpose, 'estimate_basis'),
      ),
    )
    .limit(1);
  if (basis) {
    throw err.unprocessable(
      'Объём работ по заявке предъявлен счётом — страницы счёта остаются основанием денежного ' +
        'решения и не снимаются: сбросить смету и передать заявку другому подрядчику нельзя, ' +
        'заведите новую заявку',
      { estimate: 'Объём работ предъявлен счётом' },
    );
  }
  /*
   * СЛЕД ОСВОБОЖДЕНИЯ УХОДИТ ВМЕСТЕ С РЕВИЗИЯМИ, и это сказано вслух, потому что план называет эту
   * таблицу единственным следом разбора постфактум (Р13).
   *
   * Ссылка заявления на ревизию — каскад, значит полный сброс сметы уносит и заявления. Останавливать
   * его тут нечем: ключ заявления — пара «заявка + ревизия», а сброс обнуляет нумерацию, то есть
   * ревизии, на которую строка ссылается, после него не существует. Сохранить строку можно было бы
   * только отвязанной от ревизии — и она перестала бы отвечать на главный вопрос разбора, «под каким
   * именно объёмом работ подпись не собирали».
   *
   * Почему этого достаточно. Сброс снимает и само денежное обязательство: подпись, её источник и
   * номер ревизии обнуляются тем же шагом, то есть разбирать после него нечего — освобождения больше
   * нет ни в одном смысле. А факт, что оно БЫЛО, остаётся в журнале действий: `estimate_submit` с
   * форматом и исходом заявления в `metadata`, и запись о самом сбросе рядом. Журнал для этого и
   * существует — в отличие от строки следа, он не привязан к живой ревизии.
   */
  await tx
    .delete(serviceRequestEstimateRevisions)
    .where(eq(serviceRequestEstimateRevisions.requestId, requestId));
}

/**
 * ЗАЯВЛЕНИЕ ОБ ОСВОБОЖДЕНИИ ОТ ПОДПИСИ И ЕГО ИСХОД (Р3) — строка, ради которой волна и заведена:
 * денежного контроля у освобождения нет вовсе (Р13), и эта таблица остаётся единственным следом,
 * по которому его разбирают постфактум.
 *
 * ПИШЕТСЯ ТОЙ ЖЕ ТРАНЗАКЦИЕЙ, ЧТО ПРЕДЪЯВЛЕНИЕ, и это не удобство: аудит модуля уходит после
 * `COMMIT`, и сбой между ними оставил бы подпись без единой записи о том, кто её отменил.
 *
 * ИСХОД ПИШЕТСЯ В ОБОИХ СЛУЧАЯХ — и при `applied`, и при `observed`. Выключенный рубильник не
 * отказ, а наблюдение: до включения служба обязана видеть, сколько заявлений приходит и на какие
 * суммы, а отброшенное заявление такой картины не дало бы вовсе.
 *
 * Ключ строки — пара «заявка + ревизия», и второго заявления по одной ревизии взяться неоткуда:
 * повторное предъявление поднимает номер.
 */
export async function recordEstimateExemption(
  tx: Tx,
  params: {
    requestId: string;
    revision: number;
    declaredBy: string;
    note: string;
    outcome: ServiceEstimateExemptionOutcome;
  },
): Promise<void> {
  await tx.insert(serviceRequestEstimateExemptions).values({
    requestId: params.requestId,
    revision: params.revision,
    declaredBy: params.declaredBy,
    declaredAt: new Date(),
    note: params.note,
    outcome: params.outcome,
  });
}

/**
 * Заявления об освобождении — одним запросом на страницу, тем же приёмом, что и формат ревизии
 * выше и по той же причине: карточку собирает общая сборка списка, и строка на заявку стоила бы
 * полусотни запросов.
 *
 * ОТДАЁТСЯ ПОСЛЕДНЕЕ ПО НОМЕРУ РЕВИЗИИ, а не «то, что нашлось». Заявлений по заявке бывает
 * несколько — предъявили, вернули в правку, предъявили снова, — и карточку интересует нынешнее
 * положение дел; номер ревизии едет в DTO рядом, и по нему читатель отличает освобождение по
 * ДЕЙСТВУЮЩЕЙ ревизии от снятого прошлым переизданием (иначе он показывал бы снятое основание как
 * живое). Порядок задаётся явной сортировкой: «последняя вставленная» строка у таблицы без
 * хронологии — это план запроса, а не факт.
 */
export async function estimateExemptionByRequest(
  ids: string[],
): Promise<Map<string, ServiceRequestEstimateExemptionDto>> {
  const map = new Map<string, ServiceRequestEstimateExemptionDto>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({
      requestId: serviceRequestEstimateExemptions.requestId,
      revision: serviceRequestEstimateExemptions.revision,
      declaredBy: serviceRequestEstimateExemptions.declaredBy,
      declaredByName: users.fullName,
      declaredAt: serviceRequestEstimateExemptions.declaredAt,
      note: serviceRequestEstimateExemptions.note,
      outcome: serviceRequestEstimateExemptions.outcome,
    })
    .from(serviceRequestEstimateExemptions)
    .leftJoin(users, eq(serviceRequestEstimateExemptions.declaredBy, users.id))
    .where(inArray(serviceRequestEstimateExemptions.requestId, ids))
    .orderBy(asc(serviceRequestEstimateExemptions.revision));
  for (const row of rows) {
    map.set(row.requestId, {
      revision: row.revision,
      by: row.declaredBy,
      // Учётки может уже не быть (`set null` у ссылки): факт освобождения без имени правдой быть
      // не перестаёт, а имя события остаётся в аудите.
      byName: row.declaredByName ?? '',
      at: row.declaredAt.toISOString(),
      note: row.note,
      outcome: row.outcome,
    });
  }
  return map;
}

/**
 * СПОРЫ ОБ ОСВОБОЖДЕНИИ — тем же пакетным приёмом, что заявления выше, и тем же одним запросом на
 * страницу: признак «по заявке спор» стоит в строке СПИСКА, и строка на заявку стоила бы полусотни
 * запросов.
 *
 * ОТДАЁТСЯ ПОСЛЕДНИЙ ПО ВРЕМЕНИ ОТКРЫТИЯ, а не открытый. Споров по заявке бывает несколько — исход
 * `keep` заявку не меняет, и через неделю, с новыми доводами, её оспаривают снова (потому у таблицы
 * и суррогатный ключ), — а карточку интересует нынешнее положение дел: идёт ли спор сейчас и чем
 * кончился прошлый. Открытый при этом всегда последний: второй открывают только после разрешения
 * первого (частичный уникальный индекс), и «последний» с «открытым, если он есть» не расходятся.
 *
 * РАЗРЕШЁННЫЙ СПОР ИЗ КАРТОЧКИ НЕ ИСЧЕЗАЕТ, и это не полнота ради полноты: именно он объясняет
 * второе окно приёмки у заявки в «Решена» и подпись, собранную уже после закрытия работ (Р9). Без
 * него портал объяснял бы оба состояния свободным текстом причины заморозки — то есть догадкой по
 * словам человека.
 *
 * Имена обоих участников — снимком через внешние соединения: учётки может уже не быть (`set null` у
 * обеих ссылок), и факт спора без имени правдой быть не перестаёт.
 */
export async function estimateDisputeByRequest(
  ids: string[],
): Promise<Map<string, ServiceRequestEstimateDisputeDto>> {
  const map = new Map<string, ServiceRequestEstimateDisputeDto>();
  if (ids.length === 0) return map;
  const openedByUser = alias(users, 'dispute_opened_by_user');
  const resolvedByUser = alias(users, 'dispute_resolved_by_user');
  const rows = await db
    .select({
      requestId: serviceRequestEstimateDisputes.requestId,
      revision: serviceRequestEstimateDisputes.revision,
      state: serviceRequestEstimateDisputes.state,
      reason: serviceRequestEstimateDisputes.reason,
      openedBy: serviceRequestEstimateDisputes.openedBy,
      openedByName: openedByUser.fullName,
      openedAt: serviceRequestEstimateDisputes.openedAt,
      outcome: serviceRequestEstimateDisputes.outcome,
      resolvedBy: serviceRequestEstimateDisputes.resolvedBy,
      resolvedByName: resolvedByUser.fullName,
      resolvedAt: serviceRequestEstimateDisputes.resolvedAt,
    })
    .from(serviceRequestEstimateDisputes)
    .leftJoin(openedByUser, eq(serviceRequestEstimateDisputes.openedBy, openedByUser.id))
    .leftJoin(resolvedByUser, eq(serviceRequestEstimateDisputes.resolvedBy, resolvedByUser.id))
    .where(inArray(serviceRequestEstimateDisputes.requestId, ids))
    // Порядок задаётся явно: «последняя вставленная» строка у таблицы без хронологии — это план
    // запроса, а не факт. Перезапись по ключу карты и оставляет самый поздний спор.
    .orderBy(asc(serviceRequestEstimateDisputes.openedAt));
  for (const row of rows) {
    map.set(row.requestId, {
      revision: row.revision,
      state: row.state,
      reason: row.reason,
      openedBy: row.openedBy,
      openedByName: row.openedByName ?? '',
      openedAt: row.openedAt.toISOString(),
      outcome: row.outcome,
      resolvedBy: row.resolvedBy,
      resolvedByName: row.resolvedByName ?? '',
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    });
  }
  return map;
}

/**
 * ПО ЗАЯВКЕ ЕСТЬ РАЗРЕШЁННЫЙ СПОР С ИСХОДОМ «НУЖНА ПОДПИСЬ» (Р9) — вопрос ОДНОЙ заявки, и потому
 * своей функцией, а не полем карты выше: спрашивает его предъявление объёма работ, а оно идёт по
 * одной заявке и обязано читать факт ТЕМ ЖЕ исполнителем, в котором взята блокировка.
 *
 * ЗАЧЕМ ЭТОТ ФАКТ ВООБЩЕ НУЖЕН. Требование спора иначе снимается тем же подрядчиком и без всякого
 * разбора: возврат в правку (`/estimate/reopen`) гасит ожидание, следующее предъявление с тем же
 * заявлением снова получает `applied` — и ревизия подписывается автоматически, работы закрываются,
 * автоприёмка через сутки принимает заявку. Ни одной человеческой подписи не собрано, а требование
 * спора не помнит никто. Поэтому его помнит заявка.
 *
 * ПО ЗАЯВКЕ ЦЕЛИКОМ, А НЕ ПО РЕВИЗИИ: возврат в правку номер НЕ поднимает, зато следующее
 * предъявление поднимает, и требование, привязанное к ревизии спора, снималось бы ровно тем ходом,
 * ради запрета которого заводится.
 *
 * ДОРОГИ НАЗАД У ТРЕБОВАНИЯ НЕТ, И ЭТО НЕ ЖЁСТКОСТЬ, А ЕДИНСТВЕННОЕ СОГЛАСОВАННОЕ ЧТЕНИЕ. Снять
 * его мог бы только новый спор с исходом «оставить освобождение», но такого спора по этой заявке
 * больше не открыть: спор требует ПРИМЕНЁННОГО освобождения по действующей ревизии (`disputeFactsOf`
 * — след `applied` плюс автоподпись `auto`), а после этого требования заявление отвечает `observed`
 * и автоподписи не ставит. То есть «оспорить обратно» нечего. Цена решения названа вслух: заявка,
 * по которой хоть раз потребовали подпись, собирает её дальше обычным порядком — освобождение по
 * ней больше не применяется никогда.
 */
export async function estimateSignatureRequiredByDispute(
  exec: Exec,
  requestId: string,
): Promise<boolean> {
  const [row] = await exec
    .select({ id: serviceRequestEstimateDisputes.id })
    .from(serviceRequestEstimateDisputes)
    .where(
      and(
        eq(serviceRequestEstimateDisputes.requestId, requestId),
        eq(serviceRequestEstimateDisputes.state, 'resolved'),
        eq(serviceRequestEstimateDisputes.outcome, 'require_signature'),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * ССЫЛКА НА КОЛОНКУ ВНЕШНЕГО ЗАПРОСА — ВСЕГДА ЛИШНИМ СЛОЕМ `sql`, И ЭТО НЕ УКРАШЕНИЕ. Собирая
 * список столбцов односоставного запроса, drizzle переписывает колоночные чанки ВЕРХНЕГО УРОВНЯ
 * выражения в голые идентификаторы: `"service_requests"."id"` стало бы `"id"` и разрешилось бы в
 * таблицу подзапроса — то есть `scf.request_id = "id"` сравнивало бы связь файла сама с собой и
 * условие выродилось бы в «закрывающий документ есть всегда». Отказа при этом не бывает: запрос
 * законен, Postgres отвечает правдоподобной неправдой. Внутрь вложенного `sql`-объекта проход не
 * заходит (drizzle 0.45.2, `pg-core/dialect.js`, `buildSelection`), и один слой закрывает вопрос
 * независимо от того, куда условие вставят.
 *
 * Поймано этим же файлом при реализации Э3 — `service-estimate-revision-sql.test.ts` краснел ровно
 * на форме «условие в списке столбцов»; общий разбор ловушки — в
 * `office-equipment-sql-correlation.test.ts`.
 */
function outerRef(ref: SQLWrapper): SQL {
  return sql`${ref}`;
}

/**
 * ВИДЫ, ЗАКРЫВАЮЩИЕ ЭТУ ЗАЯВКУ, НА SQL — вторая реализация правила Р5, и первая живёт в контрактах
 * (`closingKindsForFormat`). **Копия здесь неизбежна, и сказать это прямо дешевле, чем делать вид,
 * что правило одно.** Спрашивают его два отбора — очередь «Ожидаются документы» и пачка
 * автозакрытия, — а они выбирают МНОЖЕСТВО заявок одним запросом: формат у каждой строки свой, и
 * TS-предикат позвать из `WHERE` нечем. Вытащить сперва строки, а отсеять в приложении, нельзя ни
 * той, ни другой: очередь — это фильтр списка с пагинацией, а пачка автозакрытия, набранная до
 * проверки, заполнилась бы незакрываемыми заявками и вытесняла бы законные каждый прогон.
 *
 * ЧЕМ ДВЕ РЕДАКЦИИ ДЕРЖАТ В СОГЛАСИИ. Матричным тестом эквивалентности на живой базе: все клетки
 * `вид × роль × формат действующей ревизии` прогоняются и через TS-предикат, и через это условие,
 * ответы обязаны совпасть (§6 плана). Перечни видов при этом не переписаны словами, а приходят
 * параметрами из тех же констант контрактов — разойтись может только ФОРМА правила, и ровно её
 * ловит матрица.
 *
 * ПУСТОЙ ОТВЕТ ПОДЗАПРОСА — ЭТО НАСЛЕДИЕ, И СРАВНЕНИЕ ЗДЕСЬ НЕ СЛУЧАЙНО ИМЕННО ТАКОЕ:
 * `NULL = 'document'` даёт `NULL`, то есть не `true`, и ветка `ELSE` отвечает сегодняшним перечнем.
 * Заявка без ревизий закрывается, как закрывалась, — переинтерпретировать прошлое новым правилом
 * значило бы задним числом открыть заявки, которые служба считала закрытыми.
 */
function closingKindsSql(requestId: SQLWrapper): SQL {
  return sql`CASE
      WHEN (SELECT scr.format
              FROM service_request_estimate_revisions scr
             WHERE scr.request_id = ${outerRef(requestId)} AND scr.state = 'active') = 'document'
      THEN ${sql.param([...SERVICE_DOCUMENT_FORMAT_CLOSING_KINDS])}::text[]
      ELSE ${sql.param([...SERVICE_CLOSING_DOCUMENT_KINDS])}::text[]
    END`;
}

/**
 * ЗАКРЫВАЮЩАЯ ЛИ ЭТО БУМАГА — условие на ОДНУ строку связи файла, ровно те два признака, что
 * читает `isServiceClosingFile` в контрактах: роль файла и вид, допустимый формату действующей
 * ревизии.
 *
 * Отдельно от `EXISTS` ниже потому, что у отбора автозакрытия тем же условием считается ещё и срок:
 * окно на возражение идёт от ПЕРВОЙ закрывающей бумаги, и `min(attached_at)` обязан выбирать из
 * того же множества. Разойдись они — заявка созревала бы от счёта, которым документная заявка не
 * закрывается, то есть закрылась бы раньше, чем получила акт.
 *
 * Роль читается прямым сравнением, без `coalesce`: колонка `NOT NULL` с умолчанием
 * `closing_evidence` (миграция 0306), и подстраховка читалась бы как намёк, что пустая роль бывает.
 *
 * Ссылки на колонки приезжают параметрами, а не пишутся здесь именами: условие вставляют и в
 * запрос drizzle (очередь), и в sql-шаблон с псевдонимами (`f`, `r` в отборе пачки), и собственных
 * имён таблиц у этих двух мест нет общих.
 */
export function serviceClosingFileMatchSql(
  file: { kind: SQLWrapper; purpose: SQLWrapper },
  requestId: SQLWrapper,
): SQL {
  return sql`${outerRef(file.purpose)} = 'closing_evidence'
    AND ${outerRef(file.kind)} = ANY (${closingKindsSql(requestId)})`;
}

/**
 * «У ЗАЯВКИ ЕСТЬ ЗАКРЫВАЮЩИЙ ДОКУМЕНТ» — то же правило целиком, и это главный читатель условия:
 * очередь «Ожидаются документы» спрашивает его отрицанием, отбор автозакрытия — утверждением.
 *
 * Аргумент — ссылка на идентификатор заявки ВНЕШНЕГО запроса: `serviceRequests.id` из drizzle либо
 * ``sql`r.id` `` из шаблона пачки; квалификацию ей сохраняет `outerRef` выше. Псевдоним `scf` свой и
 * нарочно редкий: условие вставляют внутрь чужих запросов, и привычные `f`/`r` затенили бы их
 * собственные таблицы.
 */
export function serviceHasClosingDocumentSql(requestId: SQLWrapper): SQL {
  return sql`EXISTS (SELECT 1 FROM service_request_files scf
                      WHERE scf.request_id = ${outerRef(requestId)}
                        AND ${serviceClosingFileMatchSql(
                          { kind: sql`scf.kind`, purpose: sql`scf.purpose` },
                          requestId,
                        )})`;
}

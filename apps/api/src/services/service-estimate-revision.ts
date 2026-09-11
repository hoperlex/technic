import { and, eq, inArray, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import {
  SERVICE_CLOSING_DOCUMENT_KINDS,
  SERVICE_DOCUMENT_FORMAT_CLOSING_KINDS,
  type ServiceEstimateFormat,
} from '@technic/contracts';
import { db } from '../db/client';
import { serviceRequestEstimateRevisions } from '../db/schema';

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
 * ЧЕГО ЗДЕСЬ ЖДАТЬ НА Э4. Страницы-основания ссылаются на строку ревизии составным ключом
 * `ON DELETE RESTRICT` (`service_request_files_estimate_revision_fk`), то есть у заявки с поданным
 * счётом этот `DELETE` откажет. Сегодня такой заявки не существует по построению — документный
 * формат ручка предъявления не принимает вовсе (§7, шаг 1), — и Э4, открывая формат, обязан решить
 * сброс явно: либо отказывать переназначению понятным 422, либо переносить страницы. Молчаливого
 * каскада здесь не будет намеренно: он унёс бы доказательство денежного решения (Р6).
 */
export async function dropEstimateRevisions(tx: Tx, requestId: string): Promise<void> {
  await tx
    .delete(serviceRequestEstimateRevisions)
    .where(eq(serviceRequestEstimateRevisions.requestId, requestId));
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

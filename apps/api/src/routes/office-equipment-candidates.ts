import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import {
  confirmOfficeEquipmentCandidateSchema,
  formatServiceRequestNumber,
  isObjectScopedRole,
  mergeOfficeEquipmentCandidateSchema,
  officeEquipmentCandidateListQuerySchema,
  officeEquipmentTitle,
  OFFICE_EQUIPMENT_CANDIDATE_CONFLICT_CODES,
  rejectOfficeEquipmentCandidateSchema,
  updateOfficeEquipmentCandidateSchema,
  type OfficeEquipmentCandidateDecisionDto,
  type OfficeEquipmentCandidateDto,
  type ServiceRequestStatus,
  type UpdateOfficeEquipmentCandidateInput,
} from '@technic/contracts';
import { db } from '../db/client';
import { officeEquipment, officeEquipmentCandidates, serviceRequests } from '../db/schema';
import { requirePrincipal } from '../auth/plugin';
import type { Principal } from '../auth/principal';
import { writeAudit, writeAuditTx, type AuditEntry } from '../lib/audit';
import { AppError, err } from '../lib/errors';
import {
  officeEquipmentCandidateReviewWhere,
  officeEquipmentCandidateScopeWhere,
  officeEquipmentScopeWhere,
} from '../lib/access';
import { pageParams } from '../lib/pagination';
import {
  CANDIDATE_NOT_FOUND,
  loadCandidateDto,
  lockCandidateRow,
  requireCandidateDto,
  selectCandidates,
} from '../services/office-equipment-candidates';
import { officeEquipmentCandidateDiff } from '../services/office-equipment-candidate-diff';
import {
  prepareCandidateMail,
  queueCandidateMail,
} from '../services/office-equipment-candidate-mail';
import {
  asMissingModelBadRequest,
  assertObjectExists,
  assertTypeUsable,
  insertEquipmentCard,
} from '../services/office-equipment-write';

/**
 * Кандидат на добавление техники — очередь проверки, карточка, правка реквизитов и три решения
 * (план `docs/office-equipment-candidate-plan.md`, Р9, Р11–Р16, §8; миграция `0264`).
 *
 * ЧТО ЭТО ЗА ПРЕДМЕТ. Заявитель без `officeEquipment.write` упирался в тупик: аппарата в справочнике
 * нет, завести его нечем, и заявку человек в этот момент бросал. Кандидат — его свидетельство «в
 * кабинете 214 стоит вот это», которое заводится ОДНОЙ ТРАНЗАКЦИЕЙ ВМЕСТЕ С ЗАЯВКОЙ (Р2, ручка
 * `POST /service-requests`) и только решением человека с `write` превращается в карточку парка.
 * Отдельной ручки «завести кандидата» здесь поэтому нет и не будет — искать её в этом файле не надо.
 *
 * ЗАПИСЬЮ СВОЕЙ ТАБЛИЦЫ, А НЕ НЕАКТИВНОЙ КАРТОЧКОЙ ПАРКА (Р1). Требование «до подтверждения запись
 * не попадает никуда» в варианте с карточкой выполнялось бы списком исключений, который невозможно
 * закрыть: он открыт для каждой будущей ручки справочника. Здесь оно выполнено тем, что записи в
 * парке ещё нет — и **эти три ручки не должны стать десятым читателем парка** (§12): они не
 * соединяются с `office_equipment` ни для отбора, ни для подписи, кроме одного `leftJoin` на
 * карточку-РЕЗУЛЬТАТ уже решённого сообщения.
 *
 * ЧЕМ ОТКРЫТЫ.
 *
 *   · `GET /` — рабочая очередь: право `officeEquipment.review`, область — основание `review` Р9.
 *     Списка «мои кандидаты» у заявителя нет намеренно (§8): состояние его сообщения встроено в его
 *     же заявку, и второй список означал бы второе место, куда человеку надо ходить.
 *   · `GET /:id` — карточка: `serviceRequests.read` **либо** `review`, область — полный предикат Р9
 *     (автор ∨ видимая заявка ∨ очередь). Дизъюнкция, а не конъюнкция: у двух сторон права разные,
 *     и записанное через «и» условие отобрало бы ручку у обеих сразу.
 *   · `PATCH /:id` — правка шести заявленных реквизитов проверяющим до решения (Р12).
 *   · `POST /:id/confirm` — по сообщению заводится карточка парка, и заявка получает её предметом;
 *     `POST /:id/merge` — предметом становится уже заведённая карточка; `POST /:id/reject` — отказ
 *     с обязательной причиной. Все три исхода КОНЕЧНЫ (Р15): правки после решения не предусмотрено
 *     вовсе, «передумал» оформляется новой парой «кандидат + заявка».
 *
 * ЧЕГО У НЕГО НЕТ и чего в этом файле искать не надо: правки автором — кандидат есть свидетельство о
 * том, что человек видел в кабинете, и переписанное задним числом свидетельство ничего не доказывает
 * (Р12); уточнения идут репликой в обсуждении заявки (ADR 0141), канал уже есть. Нет мягкого
 * удаления: сообщение не отзывают, а отклоняют с причиной, и это решение проверяющего, а не действие
 * автора. Нет и перехода статуса заявки: решение по технике снимает неопределённость, а ход заявке
 * выбирает оператор явно (Р16) — двигать её по циклу за спиной исполнителя решение по справочнику
 * не вправе.
 *
 * АУДИТ ЗДЕСЬ ДВУХ СОРТОВ, И ЭТО ГЛАВНОЕ РАЗЛИЧИЕ МЕЖДУ ПРАВКОЙ И РЕШЕНИЕМ (§11). Правка пишет
 * ОБЫЧНЫЙ `writeAudit`: она не двигает ни парк, ни деньги, след её есть и в самой строке
 * (`updated_by/at`, из которой строится лента кандидата), и ронять исправление опечатки сбоем записи
 * в журнал не за что. Три решения пишут СТРОГИЙ `writeAuditTx` в своей транзакции: решение заводит
 * запись в парке и связывает исходную заявку, и потерянная молча строка оставила бы «откуда взялась
 * эта карточка» без ответа именно в редком случае, ради которого журнал и читают.
 */

const idParams = z.object({ id: z.string().uuid() });

/**
 * «Правка не состоялась» — 409 со СВЕЖИМ DTO, а не с одним номером версии (Р12).
 *
 * Содержимое целиком потому, что окну надо показать, ЧТО именно изменилось: «версия 3, а у вас 2»
 * человек прочитает как отказ портала и нажмёт ту же кнопку ещё раз, получив тот же ответ. Причин у
 * отказа две, и обе кончаются здесь: решение уже принято (сообщение вышло из `pending`) либо форму
 * успел поправить второй проверяющий. Различать их отдельными кодами незачем — исход у обеих один:
 * посмотреть свежее состояние и решить заново.
 */
/**
 * Ссылки правки годны, и целевая площадка не уводит сообщение из очереди правящего.
 *
 * ССЫЛКИ ПРОВЕРЯЮТСЯ ТЕМИ ЖЕ ПОМОЩНИКАМИ, ЧТО У ПАРКА (`assertTypeUsable`, `assertObjectExists`),
 * а не своей парой запросов, — по доводу Р14: у двух дверей в одни и те же справочники обязан быть
 * один ответ, а копия проверок разошлась бы с оригиналом на первой же новой (скажем, на «тип
 * погашен»). Без них внешний ключ отвечал бы на опечатку в теле пятисоткой, то есть скрывал бы
 * ошибку формы за поломкой сервера.
 *
 * ЧУЖАЯ ПЛОЩАДКА — 422, и спрашивается она ТОЛЬКО У ОБЪЕКТНОЙ РОЛИ. Правило то же, что у переезда
 * карточки парка («перенос на чужой объект — тот же выход за область, только в другую сторону»), и
 * причина у него здесь буквальная: очередь объектного проверяющего считается площадкой сообщения,
 * и правка, переставившая площадку, унесла бы строку из его очереди в чужую — то есть сделала бы
 * его руками то, чего ему делать не положено. У отдельской роли и у роли без оси очередь считается
 * не площадкой вовсе (Р9), и запрет на объект был бы для них правилом чужой оси: отдельский
 * проверяющий законно разбирает сообщение о технике на площадке, к его отделу не приписанной, —
 * ровно это и означает «ось по подразделению автора».
 *
 * 422, а не 400 соседних проверок: там ссылка НЕ ВЕДЁТ никуда, а здесь она ведёт куда надо и
 * значение само по себе законно — его не принимает область. Тем же кодом отвечает чужой объект на
 * заведении кандидата (Р7), и двум дверям расходиться тут нечем.
 */
async function assertEditableRefs(
  p: Principal,
  body: UpdateOfficeEquipmentCandidateInput,
): Promise<void> {
  await assertTypeUsable(db, body.equipmentTypeId);
  await assertObjectExists(db, body.objectId);
  if (isObjectScopedRole(p.role) && !p.constructionObjectIds.includes(body.objectId)) {
    throw err.unprocessable('Площадка вне вашей области', {
      objectId: 'Эта площадка не ваша — сообщение разбирает её проверяющий',
    });
  }
}

async function candidateConflict(p: Principal, id: string, scope: SQL | undefined): Promise<never> {
  const fresh = await loadCandidateDto(p, id, scope);
  if (!fresh) throw err.notFound(CANDIDATE_NOT_FOUND);
  throw err.conflict('Сообщение изменилось — посмотрите свежее состояние и повторите', {
    details: { kind: 'candidate', candidate: fresh },
  });
}

// ── Три решения проверяющего (Р11, Р13, Р15) ──
//
// ЧТО У НИХ ОБЩЕГО И ПОЧЕМУ ОНО ВЫНЕСЕНО В ОДИН ПОМОЩНИК. Различаются решения ровно исходом и
// работой над связанной заявкой; всё остальное — порядок блокировок, сверка `pending` и версии,
// условная запись с `ROW_COUNT = 1`, строгий аудит и место для постановки письма — у них одно и то
// же. Три копии этого порядка разошлись бы на первой же правке, причём разошлись бы молча: тест,
// написанный на подтверждение, про отказ ничего не знает. Поэтому здесь одна `runDecision`, а
// каждая ручка приносит ей только своё.

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * «Решение не состоялось» — сигналом, а не готовым 409 (Р11).
 *
 * Свежее состояние кандидата собирается ПОСЛЕ отката транзакции и обычным соединением: внутри своей
 * транзакции мы держим `FOR UPDATE` на кандидате и заявке, и собранный там ответ рассказывал бы о
 * состоянии, которое ещё не окончательно, — а победитель гонки как раз в этот момент дописывает
 * своё. Тот же приём и та же причина, что у разбора `23505` снаружи прерванной транзакции на
 * заведении пары (`asCandidateIntakeRepeat`).
 */
class DecisionConflict extends Error {}

/**
 * Что решение делает сверх общего порядка: исход, результат и правка единственной связанной заявки.
 *
 * `requestPatch === null` означает «заявку решение не трогает вовсе» — это отказ (Р16): описание,
 * вложения и обсуждение остаются работой человека, и стирать их отказом по справочнику нельзя, а
 * ход заявки оператор выбирает явно.
 */
interface DecisionRecord {
  status: 'confirmed' | 'duplicate' | 'rejected';
  /** `null` ровно у отказа: карточки не появилось — это же держит `…_result_check`. */
  resultEquipmentId: string | null;
  /** Пусто у обоих положительных исходов: причина обязательна ровно у отказа (`…_reason_check`). */
  reason: string;
  /**
   * Как решение называет ПРЕДМЕТ в истории связанной заявки (Р6): подпись заведённой карточки у
   * подтверждения, подпись цели у объединения, пусто у отказа — предмета не появилось, и фразу там
   * строит причина.
   *
   * Отдельным полем, а не выковыриванием из `metadata`: у трёх решений метаданные разные по
   * составу (`officeEquipmentId`, `title`, `reason`, `requestNum`), и общий шаг, гадающий по ключам
   * чужого словаря, разошёлся бы с ними на первой же правке — молча, пустой строкой в ленте.
   * Собирается подпись `officeEquipmentTitle` — той же функцией, что в списке, в журнале решения и
   * в письме: имя карточки в четырёх местах обязано читаться одинаково.
   */
  subjectTitle: string;
  requestPatch: {
    officeEquipmentId: string;
    equipmentName: string;
    equipmentSerialNumber: string;
    equipmentInventoryNumber: string;
    equipmentLocation: string;
  } | null;
  /** Метаданные строки `officeEquipmentCandidate.*` — чем решение объясняется в журнале. */
  metadata: Record<string, unknown>;
  /**
   * Строки строгого аудита СВЕРХ решения — сегодня их ровно одна и ровно у подтверждения
   * (`officeEquipment.create`): карточка обязана появиться в журнале парка так же, как заведённая
   * руками, иначе вопрос «откуда взялась эта карточка» остаётся без ответа именно в редком случае,
   * ради которого журнал и читают.
   */
  extraAudit: AuditEntry[];
}

/** Единственная связанная заявка (Р4, пара 1:1) — под `FOR UPDATE` и первой из двух строк. */
interface LockedRequest {
  id: string;
  num: number;
  kind: 'repair' | 'consumable';
  status: ServiceRequestStatus;
  deletedAt: Date | null;
}

/**
 * ШАГ 1 ТРАНЗАКЦИИ: заявка `FOR UPDATE` (Р13).
 *
 * Первой берётся ИМЕННО ЗАЯВКА, хотя решают здесь кандидата, и это не вкусовщина: тем же порядком
 * «заявка → кандидат» идёт `PATCH /service-requests/:id/accept`, у которого заявка — предмет ручки.
 * Возьми решение кандидата первым, две одновременные попытки — приёмка и решение — заперли бы друг
 * друга насмерть.
 *
 * `null` означает пару, у которой заявки уже нет. По построению такого не бывает (Р4: необратимый
 * purge заявки уносит её единственного кандидата той же транзакцией), но выдумывать здесь
 * пятисотку незачем: отказу можно ответить словами, а решению, которое заявки не трогает, — просто
 * состояться.
 */
async function lockLinkedRequest(tx: Tx, candidateId: string): Promise<LockedRequest | null> {
  const [row] = await tx
    .select({
      id: serviceRequests.id,
      num: serviceRequests.num,
      kind: serviceRequests.kind,
      status: serviceRequests.status,
      deletedAt: serviceRequests.deletedAt,
    })
    .from(serviceRequests)
    .where(eq(serviceRequests.equipmentCandidateId, candidateId))
    .for('update');
  return row ?? null;
}

/**
 * Общий порядок всех трёх решений (Р11, Р13). Шаги пронумерованы планом, и переставлять их нельзя:
 *
 *   1. видимость — 404 вне очереди проверяющего, до всякой работы и до блокировок;
 *   2. блокировки в порядке «заявка → кандидат» (защита от дедлока с приёмкой);
 *   3. сверка `pending` и присланной версии — 409 со свежим состоянием;
 *   4. работа самого решения (вставка карточки, поиск цели объединения, проверка причины);
 *   5. ОДНА условная запись, разом пишущая статус, результат, причину, пару «кто и когда» и
 *      увеличенную версию. Одна — потому что `…_result_check` и `…_decision_check` не допускают
 *      промежуточного состояния «confirmed без результата»: раздели мы её на две, транзакция
 *      упёрлась бы в ограничение на первой же половине;
 *   6. ссылка и снимки единственной связанной заявки (Р6);
 *   7. строгий аудит той же транзакцией (§11) — до трёх строк: решение, карточка парка (только у
 *      подтверждения) и след решения в ИСТОРИИ ЗАЯВКИ;
 *   8. ПОСТАНОВКА ПИСЬМА автору сообщения (Р13, шаг 7; §10) — между аудитом и возвратом свежего
 *      DTO и ТЕМ ЖЕ `tx`: SQL-ошибка очереди обязана откатить решение целиком, а SMTP работает уже
 *      после ответа — в транзакции появляются лишь строка очереди и задача воркера. Постановка
 *      после commit, как предлагала первая редакция плана, оставляла бы окно «решение есть,
 *      события нет».
 *
 * ВНЕШНЯЯ КОНФИГУРАЦИЯ КАНАЛА ЧИТАЕТСЯ ДО ТРАНЗАКЦИИ (§5.9 почтового плана): она не определяет ни
 * пользователя, ни его доступ, и её отказ («почта выключена», «канал не настроен») даёт мягкий
 * исход — решение состоится и без письма. Рубильник, актуальные адресаты и тела считаются уже
 * внутри, после блокировки кандидата.
 *
 * ВЕРСИЯ И СТАТУС СТОЯТ В УСЛОВИИ ЗАПИСИ, а не проверяются перед ней (Р11). Проверка под
 * блокировкой строки уже почти достаточна, но «почти» здесь не годится: условие в `WHERE` нельзя
 * забыть при следующей правке — без него запрос не собирается вовсе, — а отдельную проверку можно.
 * Ноль изменённых строк означает то же, что и несовпадение выше, и отвечает тем же 409.
 *
 * ОБЛАСТЬ ОЧЕРЕДИ — ТОЖЕ В УСЛОВИИ: вне своей области сообщение для решения просто не находится, и
 * ответ на него 404 — тот же, что у карточки, и по той же причине.
 */
async function runDecision(
  p: Principal,
  id: string,
  expectedVersion: number,
  action: 'confirm' | 'merge' | 'reject',
  work: (tx: Tx, request: LockedRequest | null) => Promise<DecisionRecord>,
): Promise<OfficeEquipmentCandidateDecisionDto> {
  const scope = officeEquipmentCandidateReviewWhere(p);
  // Шаг 0 — вне транзакции и только конфигурация процесса (см. выше). В базу подготовка не ходит
  // вовсе: обратный адрес письма о решении — ящик службы, а не чей-то личный.
  const mailPlan = prepareCandidateMail('office_equipment_candidate_decided', {
    id: p.id,
    email: p.email,
    counterpartyId: p.counterpartyId,
  });
  try {
    return await db.transaction(async (tx) => {
      // Шаг 1. Чужое сообщение — 404 до блокировок: разговаривать о строке, которой для
      // спрашивающего не существует, нельзя даже отказом по существу.
      await requireCandidateDto(p, id, scope, tx);
      // Шаг 2. Порядок обязателен — см. `lockLinkedRequest` и `lockCandidateRow`.
      const request = await lockLinkedRequest(tx, id);
      const locked = await lockCandidateRow(tx, id, scope);
      // Шаг 3. Решение уже принято либо форма устарела — оба случая кончаются одним ответом:
      // посмотреть свежее состояние и решить заново.
      if (!locked || locked.status !== 'pending' || locked.contentVersion !== expectedVersion) {
        throw new DecisionConflict();
      }
      // Шаг 4. Своё у каждого решения.
      const record = await work(tx, request);
      // Шаг 5. Одна условная запись на весь исход.
      const now = new Date();
      const written = await tx
        .update(officeEquipmentCandidates)
        .set({
          status: record.status,
          resultEquipmentId: record.resultEquipmentId,
          decisionReason: record.reason,
          decidedBy: p.id,
          decidedAt: now,
          contentVersion: sql`${officeEquipmentCandidates.contentVersion} + 1`,
          /*
           * Пара правки (`updated_by/at`) НЕ трогается намеренно: она отвечает на свой вопрос —
           * «поправили ли реквизиты до решения» (Р12), — и переписанная решением, она соврала бы,
           * будто сообщение правили. Лента жизни кандидата строится из трёх пар, и каждая
           * принадлежит своему событию.
           */
        })
        .where(
          and(
            eq(officeEquipmentCandidates.id, id),
            eq(officeEquipmentCandidates.status, 'pending'),
            eq(officeEquipmentCandidates.contentVersion, expectedVersion),
            scope,
          ),
        )
        .returning({ contentVersion: officeEquipmentCandidates.contentVersion });
      if (written.length !== 1) throw new DecisionConflict();

      // Шаг 6. Заявка получает предмет и снимки (Р6). Отдельного перехода статуса при этом НЕТ:
      // заявка стоит там, где стояла, и решение по технике не двигает её по циклу за спиной
      // исполнителя. Снят при этом замок приёмки — тем, что кандидат перестал быть `pending`.
      if (record.requestPatch && request) {
        await tx
          .update(serviceRequests)
          .set(record.requestPatch)
          .where(eq(serviceRequests.id, request.id));
      }

      /**
       * Шаг 7. СТРОГИЙ АУДИТ (§11, перечень в `lib/audit.ts`): `writeAuditTx`, а не общий
       * `writeAudit`. Решение заводит запись в парке и связывает исходную заявку — потерянная молча
       * строка оставила бы «откуда взялась эта карточка» без ответа именно в редком случае, ради
       * которого журнал и читают. Отказ виден сразу: проверяющий повторит решение, и кандидат
       * останется ожидающим, а не решится втихую.
       */
      await writeAuditTx(tx, {
        actorUserId: p.id,
        action: `officeEquipmentCandidate.${action}`,
        entityType: 'officeEquipmentCandidate',
        entityId: id,
        metadata: {
          status: record.status,
          contentVersion: written[0]!.contentVersion,
          requestId: request?.id ?? null,
          ...record.metadata,
        },
      });
      for (const entry of record.extraAudit) await writeAuditTx(tx, entry);

      /**
       * ТРЕТЬЯ СТРОКА — СЛЕД РЕШЕНИЯ В ИСТОРИИ САМОЙ ЗАЯВКИ (Р6, Р16).
       *
       * ЗАЧЕМ ОНА. Лента заявки читает журнал по паре `entity_type = 'serviceRequest'` из закрытого
       * перечня действий (`AUDIT_ACTIONS` в `services/service-request-history.ts`), а обе строки
       * выше написаны на СВОИ сущности — кандидата и карточку парка. Без этой записи решение,
       * которое переписывает предмет чужой заявки, в истории этой заявки не появилось бы вовсе:
       * заявитель увидел бы, что у заявки вдруг завёлся аппарат, и не нашёл бы, откуда; а при
       * отказе не увидел бы ничего и продолжал бы ждать решения, уже принятого.
       *
       * ОТКАЗ ПИШЕТСЯ НАРАВНЕ С ПОЛОЖИТЕЛЬНЫМИ ИСХОДАМИ, хотя заявку он не трогает вовсе (Р16). В
       * этом и смысл: заявка живёт дальше, и человек обязан понимать, почему предмет так и не
       * подтверждён, — иначе он пойдёт спрашивать это звонком в ИТ-службу, то есть ровно тем
       * обращением, ради отмены которого модуль и заводился.
       *
       * ТОЙ ЖЕ ТРАНЗАКЦИЕЙ И ТЕМ ЖЕ СТРОГИМ `writeAuditTx`, что и решение (§11, перечень в
       * `lib/audit.ts`, п. 9). Не по природе события, а по РОДСТВУ с решением: строка, пережившая
       * откат, рассказывала бы в истории о подтверждении, которого нет, — а потерянная молча
       * оставила бы предмет заявки появившимся ниоткуда. Обычный `writeAudit` не годится вдвойне:
       * он пишет своим соединением, то есть мимо транзакции, и оба этих состояния допускает.
       *
       * ЗАЯВКИ МОЖЕТ НЕ БЫТЬ (`request === null`) — по построению так не бывает (Р4), и решение в
       * этом случае просто состоится без следа: писать событие истории некуда, а выдумывать
       * пятисотку там, где решению ничто не мешает, незачем (тот же довод, что у `lockLinkedRequest`).
       *
       * В МЕТАДАННЫХ — ФАКТЫ, А НЕ ГОТОВАЯ ФРАЗА: подпись предмета и причина отказа. Слова из них
       * складывает сборка ленты (`candidateDecisionComment`), и правка формулировки достаёт разом
       * все записи, включая прошлогодние; вмороженный текст оставил бы в ленте две редакции одного
       * события.
       */
      if (request) {
        await writeAuditTx(tx, {
          actorUserId: p.id,
          action: `serviceRequest.candidate_${action}`,
          entityType: 'serviceRequest',
          entityId: request.id,
          metadata: {
            candidateId: id,
            status: record.status,
            title: record.subjectTitle,
            reason: record.reason,
          },
        });
      }

      /**
       * Шаг 8. ПИСЬМО АВТОРУ СООБЩЕНИЯ (§10). Исход решения приезжает в постановку явным
       * параметром, а не вычитывается письмом из строки: он же — вторая половина якоря
       * дедупликации, и письмо, собранное «по тому, что сейчас в базе», однажды рассказало бы о
       * чужом исходе, случись рядом вторая транзакция.
       *
       * Отдельной записи «письмо не ушло» после commit здесь нет намеренно: итог планирования
       * пишет сама постановка (`officeEquipmentCandidate.mailPlanned`) — той же транзакцией, что и
       * решение, — и вторая запись о том же факте, но пережившая откат, рассказывала бы о письме,
       * которого не планировалось.
       */
      const mail = await queueCandidateMail(tx, {
        prepared: mailPlan,
        candidateId: id,
        decision: record.status,
      });

      // Свежее состояние — тем же соединением транзакции: собранное обычным пулом, оно показало бы
      // строку ДО решения, потому что наша транзакция ещё не закоммичена.
      const fresh = await requireCandidateDto(p, id, scope, tx);
      // Исход почтовой части — аддитивными полями поверх обычного DTO
      // (`OfficeEquipmentCandidateDecisionDto`): форма ответа трёх ручек не меняется, а портал
      // получает ответ на вопрос «узнал ли заявитель о решении».
      return { ...fresh, mail: mail.outcome, mailTargets: mail.targets };
    });
  } catch (e) {
    if (e instanceof DecisionConflict) await candidateConflict(p, id, scope);
    throw e;
  }
}

/**
 * РУБЕЖ 3 (Р10): пока проверяющий думал, карточку с этим номером завели руками.
 *
 * ОТКАЗ ПЕРЕВОДИТСЯ, А НЕ ПОВТОРЯЕТСЯ. Номера проверяет общий `insertEquipmentCard` (Р14) — теми же
 * словами, что и справочник: «Серийный номер … занят карточкой «…»». Ответ верный, но у второй
 * двери у человека другой следующий шаг: не «поправьте номер», а «объедините сообщение с этой
 * карточкой». Поэтому проверка остаётся ОДНА (порядок отказов помощника при этом сохраняется: тип и
 * модель отвечают раньше номеров), а её 409 переписывается здесь — с готовым следующим шагом и
 * идентификатором цели для кнопки объединения.
 *
 * ТРИ РЕДАКЦИИ, как у рубежа 1, и по той же причине — дальше человек делает три разных действия:
 * своя активная карточка объединяется одним нажатием; свою неактивную сначала возвращают в
 * эксплуатацию (иначе объединение обошло бы серверный замок Ф2, и `POST /:id/merge` её всё равно
 * отобьёт); чужая не объединяется вовсе — её разбирает проверяющий той области.
 *
 * По статусу ответа, а не по тексту: текст меняется правкой формулировки, статус — нет. Единственный
 * 409 внутри помощника — занятый номер; появится второй, это место обязано узнать о нём здесь.
 */
async function asConfirmNumberConflict(
  tx: Tx,
  p: Principal,
  e: unknown,
  numbers: { serialNumber: string; inventoryNumber: string },
): Promise<unknown> {
  if (!(e instanceof AppError) || e.statusCode !== 409) return e;
  const serial = numbers.serialNumber.trim();
  const inventory = numbers.inventoryNumber.trim();
  const matches = [
    serial
      ? sql`upper(btrim(${officeEquipment.serialNumber})) = upper(btrim(${serial}))`
      : undefined,
    inventory
      ? sql`upper(btrim(${officeEquipment.inventoryNumber})) = upper(btrim(${inventory}))`
      : undefined,
  ].filter((c): c is SQL => c !== undefined);
  if (matches.length === 0) return e;
  /*
   * Область считается ТЕМ ЖЕ предикатом, что и у справочника (`officeEquipmentScopeWhere`), а не
   * сравнением объекта со списком привязок: у роли отдела область парка — это отделы-владельцы и
   * неразмеченная техника, и повторённое здесь своими руками правило разошлось бы с ним на первой
   * же правке. `undefined` означает «сужать нечем» — тогда своей считается любая живая карточка.
   */
  const scope = officeEquipmentScopeWhere(
    p,
    officeEquipment.objectId,
    officeEquipment.ownerDepartmentId,
  );
  const rows = await tx
    .select({
      id: officeEquipment.id,
      name: officeEquipment.name,
      serialNumber: officeEquipment.serialNumber,
      inventoryNumber: officeEquipment.inventoryNumber,
      isActive: officeEquipment.isActive,
      mine: scope === undefined ? sql<boolean>`true` : sql<boolean>`COALESCE(${scope}, false)`,
    })
    .from(officeEquipment)
    // Удалённая карточка номер не держит — тем же условием ограничены и уникальные индексы парка.
    .where(and(isNull(officeEquipment.deletedAt), or(...matches)))
    /*
     * ДВЕ — ЭТО ПОТОЛОК: номера уникальны среди живых карточек, поэтому по каждому из двух совпасть
     * может максимум одна строка. Разными они бывают, когда серийный назван у одной карточки, а
     * инвентарный у другой, — и тогда называется та, о которой сказал бы сам помощник: серийный он
     * проверяет первым.
     */
    .limit(2);
  const found =
    (serial
      ? rows.find((row) => row.serialNumber.trim().toUpperCase() === serial.toUpperCase())
      : undefined) ?? rows[0];
  if (!found) return e;
  const title = officeEquipmentTitle(found);
  if (!found.mine) {
    // Ни наименования, ни места: раскрывается один факт «номер занят», и он же назван самим номером.
    return err.conflict(
      'Карточка с этим номером уже заведена в другом подразделении — объединить сообщение с ней может её проверяющий',
      { code: OFFICE_EQUIPMENT_CANDIDATE_CONFLICT_CODES.parkDuplicate },
    );
  }
  if (!found.isActive) {
    // Идентификатор не отдаётся намеренно: объединение неактивную цель отобьёт (Ф2), и
    // подставленная кнопка обещала бы ход, которого нет.
    return err.conflict(
      `Карточка с этим номером есть, но снята с эксплуатации: «${title}». Верните её в работу, затем объедините сообщение с ней`,
      { code: OFFICE_EQUIPMENT_CANDIDATE_CONFLICT_CODES.parkDuplicate },
    );
  }
  return err.conflict(
    `Карточка с этим номером уже заведена: «${title}». Объедините сообщение с ней`,
    {
      code: OFFICE_EQUIPMENT_CANDIDATE_CONFLICT_CODES.parkDuplicate,
      details: { kind: 'parkDuplicate', officeEquipmentId: found.id, title },
    },
  );
}

/**
 * Цель объединения (Р15): живая, активная и в области проверяющего карточка.
 *
 * ТРИ УСЛОВИЯ, И НИ ОДНО НЕ ЛИШНЕЕ. `deleted_at IS NULL` — архивная карточка предметом заявки быть
 * не может; область — иначе объединением можно было бы приписать себе чужую технику, не имея на неё
 * прав нигде больше; `is_active = true` — иначе объединение стало бы боковой дверью в обход
 * серверного запрета заводить заявки на выведенную из эксплуатации карточку (Ф2), причём дверью,
 * открытой ровно тому, кто должен этот запрет соблюдать.
 *
 * 422, а не 404 (§8): ручку человек нашёл, сообщение своё, и не годится ЗНАЧЕНИЕ в теле — ровно то,
 * о чём говорит 422 с путём поля. Неактивная цель отвечает своим текстом: «не найдена» отправило бы
 * проверяющего искать карточку, которая на экране у него перед глазами.
 */
async function requireMergeTarget(
  tx: Tx,
  p: Principal,
  officeEquipmentId: string,
): Promise<{
  id: string;
  name: string;
  serialNumber: string;
  inventoryNumber: string;
  location: string;
}> {
  const [row] = await tx
    .select({
      id: officeEquipment.id,
      name: officeEquipment.name,
      serialNumber: officeEquipment.serialNumber,
      inventoryNumber: officeEquipment.inventoryNumber,
      location: officeEquipment.location,
      isActive: officeEquipment.isActive,
    })
    .from(officeEquipment)
    .where(
      and(
        eq(officeEquipment.id, officeEquipmentId),
        isNull(officeEquipment.deletedAt),
        officeEquipmentScopeWhere(p, officeEquipment.objectId, officeEquipment.ownerDepartmentId),
      ),
    );
  if (!row) {
    throw err.unprocessable('Карточка не найдена', { officeEquipmentId: 'Не найдена' });
  }
  if (!row.isActive) {
    throw err.unprocessable(
      `Карточка «${officeEquipmentTitle(row)}» снята с эксплуатации: сначала верните её в работу`,
      { officeEquipmentId: 'Снята с эксплуатации' },
    );
  }
  return row;
}

/**
 * «Одна открытая заявка на единицу» — та же планка, что и у заведения (Р21 ADR 0085), но спрошенная
 * со второй стороны: объединение приписывает существующей карточке ЧУЖУЮ заявку, и если по этой
 * карточке уже открыт ремонт, в парке оказались бы две открытые заявки на один аппарат.
 *
 * Проверяется здесь, а не отдаётся частичному индексу `service_requests_open_repair_unique`:
 * нарушение индекса стало бы пятисоткой, а проверяющему нужен номер занявшей место заявки — чтобы
 * открыть её и разобраться, какая из двух настоящая.
 *
 * У подтверждения такой проверки нет и не нужно: карточка там только что заведена, и заявок по ней
 * не существует по построению.
 */
async function assertCardFreeOfOpenRequest(
  tx: Tx,
  equipmentId: string,
  request: LockedRequest,
): Promise<void> {
  /*
   * Спрашивается ТОЛЬКО у открытой заявки, и это не оптимизация: замок держат ЧАСТИЧНЫЕ индексы, и
   * закрытая либо архивная заявка в них не входит вовсе. Спроси мы всегда, объединение сообщения по
   * отменённой заявке отбивалось бы там, где база его принимает, — то есть запрет оказался бы
   * строже собственного инварианта.
   */
  const openHere =
    request.deletedAt === null && request.status !== 'accepted' && request.status !== 'cancelled';
  if (!openHere) return;
  const [open] = await tx
    .select({ num: serviceRequests.num })
    .from(serviceRequests)
    .where(
      and(
        eq(serviceRequests.officeEquipmentId, equipmentId),
        eq(serviceRequests.kind, request.kind),
        isNull(serviceRequests.deletedAt),
        notInArray(serviceRequests.status, ['accepted', 'cancelled']),
        ne(serviceRequests.id, request.id),
      ),
    );
  if (!open) return;
  throw err.conflict(
    `По этой карточке уже есть незакрытая заявка ${formatServiceRequestNumber(open.num)} — объединять сообщение с ней нельзя, пока та не закрыта`,
    { fields: { officeEquipmentId: 'Занята другой заявкой' } },
  );
}

/**
 * Снимки заявки после положительного решения (Р6) — единственный раз в жизни заявки, когда снимок
 * меняется.
 *
 * ПЕРЕПИСЫВАЮТСЯ ЧЕТЫРЕ КОЛОНКИ ПРЕДМЕТА И НИ ОДНОЙ КОЛОНКИ ОБЛАСТИ. Снимок ценен как «что стояло в
 * справочнике на момент заведения», а до проверки в справочнике не стояло ничего — проверка и есть
 * тот момент, когда значение появляется. А вот `equipment_object_id`, `customer_department_id` и
 * `equipment_department_id` — это ТРИ СНИМКА ОБЛАСТИ: перепиши их решение по справочнику, живая
 * заявка сменила бы круг тех, кто её видит, посреди работы — и сменила бы молча, без всякого
 * действия её участников. Физическое место аппарата назвал заявитель (Р7), и оно остаётся за ним.
 */
function requestPatchOf(card: {
  id: string;
  name: string;
  serialNumber: string;
  inventoryNumber: string;
  location: string;
}): NonNullable<DecisionRecord['requestPatch']> {
  return {
    officeEquipmentId: card.id,
    equipmentName: card.name,
    equipmentSerialNumber: card.serialNumber,
    equipmentInventoryNumber: card.inventoryNumber,
    equipmentLocation: card.location,
  };
}

/** «Заявки уже нет» — то, чем кончаются два решения, которым её надо переписать (см. `lockLinkedRequest`). */
function requireLinkedRequest(request: LockedRequest | null): LockedRequest {
  if (!request) {
    throw err.conflict(
      'Заявка, к которой приложено сообщение, не найдена — обновите страницу и посмотрите свежее состояние',
    );
  }
  return request;
}

export default async function officeEquipmentCandidatesRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /*
   * ОЧЕРЕДЬ И ПРАВКА ЗАКРЫТЫ ОДНИМ ПРАВОМ, а карточка — выбором из двух, и это разные вопросы, а не
   * разная строгость. Очередь и правка — работа проверяющего; карточку читает всякий, кому видна
   * связанная заявка, и права заявки ему для этого достаточно.
   */
  const canReview = app.requirePermission(
    'officeEquipment.review',
    'Сообщения об отсутствующей технике проверяет тот, кто ведёт справочник',
  );

  /**
   * РАБОЧАЯ ОЧЕРЕДЬ ПРОВЕРЯЮЩЕГО.
   *
   * ОБЛАСТЬ — ОДНО ОСНОВАНИЕ `review`, а не полный предикат Р9, и это решение, а не упрощение.
   * Полный предикат добавил бы в очередь собственные сообщения проверяющего и сообщения по видимым
   * ему заявкам — то есть строки, за которые он как проверяющий не отвечает: очередь перестала бы
   * отвечать на свой единственный вопрос «что разобрать мне». Карточку любой из них он всё равно
   * откроет — `GET /:id` спрашивает полный предикат.
   *
   * ПОРЯДОК — СТАРЫЕ СВЕРХУ (умолчание схемы `asc`). Свежее сверху означало бы, что сообщение, до
   * которого не дошли руки в первый день, не дождётся проверки никогда: очередь работала бы стеком.
   * Тем же порядком описан и частичный индекс ожидающих.
   *
   * ВТОРЫМ КЛЮЧОМ СОРТИРОВКИ СТОИТ `id`, и это не украшение: `created_at` у двух сообщений,
   * заведённых в одну транзакцию-миллисекунду, совпадает, а страница без полного порядка отдаёт при
   * `OFFSET` то одну строку, то другую — и одна из них не попадает ни на какую страницу вовсе.
   */
  r.get(
    '/',
    {
      preHandler: [app.authenticate, canReview],
      schema: { querystring: officeEquipmentCandidateListQuerySchema },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const q = req.query;
      const where = and(
        officeEquipmentCandidateReviewWhere(p),
        q.status === undefined ? undefined : inArray(officeEquipmentCandidates.status, q.status),
      );
      const dir = q.sortOrder === 'asc' ? asc : desc;
      const page = pageParams(q);
      const [items, totalRows] = await Promise.all([
        selectCandidates(
          p,
          where,
          sql`${dir(officeEquipmentCandidates.createdAt)}, ${dir(officeEquipmentCandidates.id)}`,
          page.limit,
          page.offset,
        ),
        db.select({ c: count() }).from(officeEquipmentCandidates).where(where),
      ]);
      return { items, total: Number(totalRows[0]!.c), page: page.page, pageSize: page.pageSize };
    },
  );

  /**
   * КАРТОЧКА СООБЩЕНИЯ — три читателя и одно условие (Р9).
   *
   * Право спрашивается ВЫБОРОМ ИЗ ДВУХ (`anyOf`), а не конъюнкцией: карточку читают заявитель и все,
   * кому видна его заявка (у них `serviceRequests.read`), и проверяющий, у которого своё право и
   * который заявку может не видеть вовсе. Записанное через «и», условие отобрало бы ручку у обеих
   * сторон сразу.
   *
   * ОБЛАСТЬ — ПОЛНЫЙ ПРЕДИКАТ Р9, и вне неё ответ 404, а не 403: о существовании чужого сообщения
   * знать не нужно, а 403 сам по себе сообщал бы, что такое сообщение есть. Право при этом отдельно
   * от области намеренно — «положено ли вообще» и «над какими строками» отвечают разные слои
   * (ADR 0021), и смешение их уже стоило модулю двух дыр.
   */
  r.get(
    '/:id',
    {
      preHandler: [
        app.authenticate,
        app.requireAnyPermission(
          ['serviceRequests.read', 'officeEquipment.review'],
          'Сообщение о технике читают участники заявки и проверяющий',
        ),
      ],
      schema: { params: idParams },
    },
    async (req): Promise<OfficeEquipmentCandidateDto> => {
      const p = requirePrincipal(req);
      return await requireCandidateDto(p, req.params.id, officeEquipmentCandidateScopeWhere(p));
    },
  );

  /**
   * ПРАВКА ЗАЯВЛЕННЫХ РЕКВИЗИТОВ ПРОВЕРЯЮЩИМ ДО РЕШЕНИЯ (Р12): «заявитель списал `O` вместо `0`».
   *
   * Отклонять заявку из-за одной опечатки значило бы заставить человека заводить её заново, а
   * заводить карточку парка по неверному номеру — растить второй такой же аппарат в справочнике.
   *
   * УСЛОВНАЯ ЗАПИСЬ, А НЕ «ПРОЧИТАТЬ И ОБНОВИТЬ»: статус и версия стоят В УСЛОВИИ `UPDATE`, и
   * ровно это и есть защита. Чтение с последующей записью оставляет между собой щель, в которую
   * пролезает и решение соседа, и его же правка, — а статуса для защиты не хватает: правка идёт
   * ВНУТРИ `pending`, где статус неподвижен и не стережёт ничего. Обязательный `ROW_COUNT = 1`;
   * ноль означает «решение уже принято или форма устарела» и отвечает 409 со свежим состоянием.
   *
   * ОБЛАСТЬ ПРОВЕРЯЮЩЕГО — ТОЖЕ В УСЛОВИИ ЗАПИСИ, а не отдельной проверкой перед ней: вне своей
   * области сообщение для правки просто не находится, и ответ на него 404 — тот же, что у карточки,
   * и по той же причине. Отдельная проверка была бы третьим местом, где записано «чья это очередь».
   *
   * ПОЛЯ ПРИЕЗЖАЮТ ПОЛНЫМ НАБОРОМ, а не разницей (схема контракта): их шесть, форма показывает все
   * шесть сразу, и «стереть комментарий» от «не трогать комментарий» частичным телом не отличить.
   */
  r.patch(
    '/:id',
    {
      preHandler: [app.authenticate, canReview],
      schema: { params: idParams, body: updateOfficeEquipmentCandidateSchema },
    },
    async (req): Promise<OfficeEquipmentCandidateDto> => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const b = req.body;
      const scope = officeEquipmentCandidateReviewWhere(p);

      /*
       * Снимок «до» — ради диффа аудита, и читается он ПОД ТЕМ ЖЕ УСЛОВИЕМ ОБЛАСТИ, что и запись:
       * иначе чужое сообщение успело бы попасть в память до того, как ответить «не найдено». Он же
       * отсеивает строку вне очереди проверяющего — 404 до всякой работы.
       *
       * Тем же DTO, что и ответ ручки, а не выборкой колонок: дифф по сырым ссылкам дал бы «Тип:
       * 3f1c… → 9a2e…», строку, которую не прочесть ни в журнале, ни в разборе через полгода.
       */
      const before = await loadCandidateDto(p, id, scope);
      if (!before) throw err.notFound(CANDIDATE_NOT_FOUND);
      /*
       * Тело проверяется ПОСЛЕ того, как строка нашлась, и порядок здесь смысловой. Сначала «есть
       * ли для вас такое сообщение», потом «годится ли присланное»: обратный порядок отвечал бы на
       * правку чужого сообщения разбором его полей — то есть разговаривал бы о строке, которой для
       * спрашивающего не существует.
       */
      await assertEditableRefs(p, b);

      const updated = await db
        .update(officeEquipmentCandidates)
        .set({
          equipmentTypeId: b.equipmentTypeId,
          declaredModel: b.declaredModel,
          serialNumber: b.serialNumber,
          inventoryNumber: b.inventoryNumber,
          objectId: b.objectId,
          location: b.location,
          comment: b.comment,
          contentVersion: sql`${officeEquipmentCandidates.contentVersion} + 1`,
          updatedBy: p.id,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(officeEquipmentCandidates.id, id),
            eq(officeEquipmentCandidates.status, 'pending'),
            eq(officeEquipmentCandidates.contentVersion, b.expectedVersion),
            scope,
          ),
        )
        .returning({ contentVersion: officeEquipmentCandidates.contentVersion });
      if (updated.length !== 1) await candidateConflict(p, id, scope);

      const after = await requireCandidateDto(p, id, scope);
      /*
       * ДИФФ ТЕМ ЖЕ ПРИЁМОМ, ЧТО У ПРАВКИ КАРТОЧКИ ПАРКА (`officeEquipmentDiff`, §11): без него в
       * журнале стояло бы «сообщение правили» без ответа, что стало с номерами, — а правка тут
       * ровно за тем и нужна, чтобы поправить номер. Аудит ОБЫЧНЫЙ: сбой записи не должен ронять
       * исправленную опечатку, а лента самого кандидата строится не из журнала, а из пар колонок
       * (`updated_by/at`), которые пишутся той же записью, что и реквизиты.
       */
      await writeAudit({
        actorUserId: p.id,
        action: 'officeEquipmentCandidate.update',
        entityType: 'officeEquipmentCandidate',
        entityId: id,
        metadata: {
          contentVersion: after.contentVersion,
          ...officeEquipmentCandidateDiff(before, after),
        },
      });
      return after;
    },
  );

  // ── Три решения проверяющего (Р13, Р15) ──
  //
  // Ими сообщение и кончается: все три исхода КОНЕЧНЫ, правка после решения не предусмотрена вовсе,
  // а «передумал» оформляется новой парой «кандидат + заявка». Общий порядок транзакции у них один
  // (`runDecision` выше), и каждая ручка приносит туда только своё.

  /**
   * ПОДТВЕРДИТЬ ТЕХНИКУ (Р13): по сообщению заводится карточка парка, и заявка получает её предметом.
   *
   * ТЕЛО — ПОЛНАЯ ФОРМА КАРТОЧКИ, А НЕ ОДНА ВЕРСИЯ, и это решение опроса, а не удобство портала.
   * Проверяющий здесь не «соглашается с сообщением», а ЗАВОДИТ КАРТОЧКУ ПО СООБЩЕНИЮ: заявитель не
   * знает половины реквизитов учёта (Р7) — модели-ссылки, отдела-владельца, даты покупки и
   * гарантии, — и карточка, собранная из его слов один в один, была бы неполной с первого дня, то
   * есть невидимой для счётчиков парка и для вкладки «Гарантии». Форма приезжает предзаполненной
   * заявленным, и это работа портала, а не сервера: сервер обязан принять ровно то же, что принимает
   * первая дверь справочника.
   *
   * ВСТАВКА — ОБЩИМ ПОМОЩНИКОМ (Р14), со всеми проверками первой двери: тип, модель, объект, отдел,
   * область заведения и номера. Область при этом проверяется ПО МЕСТУ, КУДА ЗАВОДЯТ КАРТОЧКУ, а не
   * по площадке сообщения: очередь отдельского проверяющего приносит ему сообщения с чужих площадок
   * (Р9), и завести по ним карточку в чужую область он не должен.
   */
  r.post(
    '/:id/confirm',
    {
      preHandler: [app.authenticate, canReview],
      schema: { params: idParams, body: confirmOfficeEquipmentCandidateSchema },
    },
    async (req): Promise<OfficeEquipmentCandidateDecisionDto> => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const b = req.body;
      return await runDecision(p, id, b.expectedVersion, 'confirm', async (tx, request) => {
        // Заявка нужна раньше вставки: карточку, заведённую по сообщению, которое некуда приложить,
        // пришлось бы отменять вторым действием — а откат транзакции делает это сам и бесплатно.
        const linked = requireLinkedRequest(request);
        const created = await insertEquipmentCard(tx, p, b.equipment).catch(async (e: unknown) => {
          // Занятый номер — рубеж 3 (Р10): тот же отказ, но с готовым следующим шагом.
          const retold = await asConfirmNumberConflict(tx, p, e, b.equipment);
          // Гонка с удалением модели приходит отказом триггера зеркала — и уходит тем же 400, что
          // и ссылка в никуда у первой двери: дверь другая, ответ обязан быть один.
          throw retold === e ? asMissingModelBadRequest(e) : retold;
        });
        const card = {
          id: created.id,
          // Имя — то, что ЛЕГЛО В БАЗУ: при заведении по модели его пишет триггер зеркала, и
          // взятое из тела оно оставило бы снимок заявки пустым.
          name: created.name,
          serialNumber: b.equipment.serialNumber,
          inventoryNumber: b.equipment.inventoryNumber,
          location: b.equipment.location,
        };
        return {
          status: 'confirmed',
          resultEquipmentId: created.id,
          // Причины у подтверждения нет: оно объясняет себя самой заведённой карточкой.
          reason: '',
          // Ею же оно называет себя и в истории заявки — подписью заведённой карточки, собранной
          // из имени ИЗ БАЗЫ и присланных номеров.
          subjectTitle: officeEquipmentTitle(card),
          requestPatch: requestPatchOf(card),
          metadata: { officeEquipmentId: created.id, requestNum: linked.num },
          /*
           * ВТОРАЯ СТРОКА ЖУРНАЛА — О САМОЙ КАРТОЧКЕ, и пишется она обычным именем действия
           * (`officeEquipment.create`), тем же, что и заведение руками: лента парка обязана
           * показывать карточку одинаково, откуда бы та ни пришла. Строгой она здесь становится не
           * по своей природе, а по родству с решением — обе строки атомарны ему (Р13, §11).
           */
          extraAudit: [
            {
              actorUserId: p.id,
              action: 'officeEquipment.create',
              entityType: 'officeEquipment',
              entityId: created.id,
              // Происхождение — полем метаданных: «откуда взялась эта карточка» спрашивают у
              // журнала парка, а ссылка на сообщение живёт в кандидате, куда из парка не смотрят.
              metadata: { ...created.auditMetadata, candidateId: id },
            },
          ],
        };
      });
    },
  );

  /**
   * ЭТО УЖЕ ЗАВЕДЁННЫЙ АППАРАТ (Р15): исход `duplicate`. Карточку завели руками, пока сообщение
   * стояло в очереди, либо заявитель не нашёл её из-за области видимости — и то и другое не вина
   * автора, поэтому подпись исхода не читается упрёком.
   *
   * ВТОРОЙ КАРТОЧКИ НЕ ПОЯВЛЯЕТСЯ, и в этом весь смысл решения: заявка получает предметом
   * существующую единицу, а сообщение закрывается ссылкой на неё. Целевую карточку сервер проверяет
   * тремя условиями сразу (`requireMergeTarget`), и «активна» среди них — не формальность, а замок
   * Ф2, который иначе обходился бы объединением.
   */
  r.post(
    '/:id/merge',
    {
      preHandler: [app.authenticate, canReview],
      schema: { params: idParams, body: mergeOfficeEquipmentCandidateSchema },
    },
    async (req): Promise<OfficeEquipmentCandidateDecisionDto> => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const b = req.body;
      return await runDecision(p, id, b.expectedVersion, 'merge', async (tx, request) => {
        const linked = requireLinkedRequest(request);
        const target = await requireMergeTarget(tx, p, b.officeEquipmentId);
        await assertCardFreeOfOpenRequest(tx, target.id, linked);
        return {
          status: 'duplicate',
          resultEquipmentId: target.id,
          reason: '',
          // Та же подпись, что уходит в журнал решения ниже: в истории заявки объединение называет
          // карточку тем именем, под которым его принимали.
          subjectTitle: officeEquipmentTitle(target),
          requestPatch: requestPatchOf(target),
          metadata: {
            officeEquipmentId: target.id,
            // Подпись цели — той же функцией, что в списке и в письме: по ней решение читают в
            // журнале через полгода, когда карточку успели переименовать.
            title: officeEquipmentTitle(target),
            requestNum: linked.num,
          },
          // Карточки решение не заводит — второй строки журнала парка тут быть не должно: карточка
          // уже появилась в нём тогда, когда её завели.
          extraAudit: [],
        };
      });
    },
  );

  /**
   * ОТКЛОНИТЬ (Р15): аппарата в названном месте нет либо сообщение недостоверно.
   *
   * ПРИЧИНА ОБЯЗАТЕЛЬНА И УХОДИТ ЗАЯВИТЕЛЮ ДОСЛОВНО (В5) — и в карточку заявки, и в письмо. Общее
   * «сообщение отклонено, подробности в портале» экономило бы проверяющему выбор слов ценой второго
   * действия человека: он всё равно пойдёт смотреть причину, а не поняв её, напишет в ИТ-службу — то
   * есть ровно тем обращением, ради отмены которого модуль и заводился. То же требует и база
   * (`…_reason_check`).
   *
   * ЗАЯВКУ ОТКАЗ НЕ ТРОГАЕТ ВОВСЕ (Р16), и это не пропуск. Описание, вложения и обсуждение — работа
   * человека, и стирать её отказом по справочнику нельзя; отменить заявку решение тоже не вправе:
   * «аппарат не заводим в парк» не означает «по заявке ничего не делали», и ход заявки оператор
   * выбирает явно, своим действием и со своей причиной. Замок приёмки при этом СНЯТ — иначе заявка
   * в «Решена» осталась бы в тупике: принять нельзя, а отменить за оператора некому.
   */
  r.post(
    '/:id/reject',
    {
      preHandler: [app.authenticate, canReview],
      schema: { params: idParams, body: rejectOfficeEquipmentCandidateSchema },
    },
    async (req): Promise<OfficeEquipmentCandidateDecisionDto> => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const b = req.body;
      return await runDecision(p, id, b.expectedVersion, 'reject', async () => ({
        status: 'rejected',
        // Результата у отказа нет: карточки не появилось — это же держит `…_result_check`.
        resultEquipmentId: null,
        reason: b.reason,
        // И называть в истории заявки нечего: предмета не появилось, и фразу там строит причина —
        // она же уходит заявителю дословно (В5).
        subjectTitle: '',
        requestPatch: null,
        metadata: { reason: b.reason },
        extraAudit: [],
      }));
    },
  );
}

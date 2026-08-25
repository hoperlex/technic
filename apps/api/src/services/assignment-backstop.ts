import { eq, inArray } from 'drizzle-orm';
import {
  esm2Mode,
  formatVehicleRequestNumber,
  moscowDateKeyOf,
  type RequiredAnchor,
  type RequiredVehicleResolution,
} from '@technic/contracts';
import { specialEquipmentRequestDetails, vehicleRequests, vehicles } from '../db/schema';
import { writeAuditTx } from '../lib/audit';
import { AppError } from '../lib/errors';
import { tailEffectiveDate } from './assignment-effects';
import {
  computeAssignmentHistory,
  readAssignmentHistorySnapshot,
  type AssignmentHistorySnapshot,
} from './assignment-ensure';
import {
  assignmentSegments,
  assignmentStateOn,
  type AssignmentChangeRow,
  type AssignmentTerm,
} from './assignment-history';
import { historyIsAuthoritative, readAssignmentMode } from './assignment-mode';
import { mutableRangesOf, requiredAnchorsOf } from './assignment-repair';
import type { AssignmentWriteTx } from './assignment-write';

/**
 * Бэкстоп чужих дверей: что скажет история той двери, которая машиниста не спрашивает
 * (`docs/assignment-periods-plan.md`, Р16, Р21, Р22, Р23, Р30, Р31; фазирование — Ж5).
 *
 * ЗАЧЕМ ОН. Бумагу ЭСМ-2 сверяет не одна дверь. `syncEsm2Waybills` зовут шесть мест: статусная
 * ручка, смена назначения, обе ветки досрочного завершения, правка срока и недельная операция
 * (Р21). Ни одна из них не спрашивает у человека, кто работал, — и любая может задеть дни, у
 * которых в истории машинист `unknown` или у которых хвост истории разошёлся с назначением. Тогда
 * сверка либо откажет невнятно («укажите машиниста» из своей глубины), либо — если человек в
 * денормализации всё-таки нашёлся — молча выпишет бланк строгой отчётности не на того.
 *
 * ЧЕГО ОН НЕ ДЕЛАЕТ — НЕ НАЗЫВАЕТ МАШИНИСТА (Р22). Соблазн протащить в правку срока поле `anchors`
 * разобран планом и отвергнут дважды. По правам: обычная правка заявки защищена одним
 * `vehicleRequests.update` — правом площадки, — а недельную визирует роль с `weeklyRequests.approve`;
 * приняв якорь, обе двери начали бы вписывать людей в бланки строгой отчётности и получать в
 * предпросмотре ФИО собственного парка (ADR 0027, 0048, 0050 п. 11). По модели недельной заявки:
 * «завизировано, но не применено» там запрещено двумя CHECK-равенствами схемы, и отложенное
 * применение потребовало бы нового статуса и миграции. Поэтому чужая дверь **отказывает** и
 * называет, куда идти, а машиниста называет своя — команда «Сменить машиниста» либо ремонт истории.
 *
 * ПОЧЕМУ СЕГОДНЯ ЭТО ДИАГНОСТИКА, А НЕ ОТКАЗ (Ж5, Е2). Включить отказы прямо сейчас — значит
 * создать производственный тупик: до переключения чтения (этап 5) продление заявки с
 * `unknown`-хвостом отвечало бы `requiredAnchors`, а починить историю было бы нечем — дата ремонта
 * обязана лежать внутри срока, которого ещё нет. Поэтому фаза задаётся **режимом чтения**, а не
 * сборкой:
 *
 * ```
 * read_mode = legacy   → requiredAnchors и requiredVehicleResolution считаются, уходят в
 *                        диагностику и никого не останавливают
 * read_mode = history  → те же результаты становятся боевыми 422
 * ```
 *
 * Режим — значение в управляющей строке (`assignment-mode.ts`), поэтому обе сборки — текущая и
 * rollback — понимают обе фазы, и переключение не требует раската.
 *
 * КУДА ПИШЕТСЯ ДИАГНОСТИКА И ПОЧЕМУ ТУДА. Два адреса, и у каждого своя работа:
 *
 * - **`audit_log`** — долговечная улика по каждой заявке: `entity_type = 'vehicle_request'`,
 *   `entity_id` — заказ, `metadata` — те самые `requiredAnchors` и `requiredVehicleResolution`,
 *   которыми дверь ответила бы в режиме `history`. Журнал уже индексирован парой «тип + id»
 *   (`audit_log_entity_idx`), то есть вопрос «какие заказы задели чужие двери и чем» — один запрос,
 *   а не выгрузка логов. Запись идёт **в транзакции двери** (`writeAuditTx`): откатилась дверь —
 *   откатилась и диагностика, иначе теневая улика описывала бы операцию, которой не было;
 * - **счётчик процесса** ({@link assignmentBackstopCounters}) — чтобы ненулевую диагностику увидели
 *   без запроса в базу: он уходит в `/metrics` и настраивается алертом. Счётчик именно процессный, а
 *   не `count(*)` по журналу: `audit_log` растёт от всего портала и индекса по `action` не имеет,
 *   а скрейп раз в десятки секунд не должен просматривать его целиком.
 *
 * После переключения чтения диагностики не станет вовсе — будут отказы, — и их считает второй
 * счётчик ({@link assignmentBackstopRefusals}). Иначе метрика тени ушла бы в ноль ровно в тот
 * день, когда двери начали отказывать по-настоящему, и это читалось бы как тишина.
 *
 * **Почему не `assignment_shadow_checks` (миграция `0167`).** Та таблица — не журнал, а *manifest*
 * поколения (К1): строки заводятся **заранее**, по одной на каждую ожидаемую цель, worker только
 * переводит их из `pending` в `match`/`mismatch`, а `expected_checks` прогона считает их заранее.
 * У двери никакого `run_id` нет и быть не может, и вставка «лишней» цели ломала бы ровно то
 * свойство, ради которого manifest заведён: доказательство cutover перестало бы быть полным
 * перечнем проверенного. Теневое сравнение придёт этапом 4 своим прогоном; door-time диагностика —
 * сигнал «сходите посмотрите», а не доказательство, и решает cutover не она (Е1).
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Правил истории: и пробелы машиниста ({@link requiredAnchorsOf}), и изменяемая
 * область ({@link mutableRangesOf}), и восстановление истории в памяти
 * ({@link computeAssignmentHistory}) уже написаны своими модулями — вторая редакция тех же правил
 * разошлась бы с первой на первом же уточнении. Этот модуль отвечает на два вопроса, которых у
 * них нет: **что из посчитанного относится к этой двери** и **фаза сейчас какая**.
 */

// ── Двери ──

/**
 * Чужая дверь — та, что зовёт сверку ЭСМ-2, но машиниста не спрашивает (Р21).
 *
 * Седьмой двери здесь нет намеренно: ручная выписка `on_demand` идёт мимо сверки, своим
 * `issueEsm2OnDemand`, и человека спрашивает прямо в теле запроса — бэкстоп ей не нужен.
 */
export type AssignmentBackstopDoor =
  | 'request_status'
  | 'request_assignment'
  | 'early_end_request'
  | 'early_end_decision'
  | 'work_period'
  | 'weekly_apply';

interface DoorSpec {
  /** Как дверь называется в отказе и в диагностике — человеку, а не разработчику. */
  title: string;
  /**
   * Может ли операция открыть дни, которых у заказа не было.
   *
   * От этого зависит **только** расхождение хвоста: Р31 запирает им расширение срока — правку
   * `dateTo` вперёд и продление недельной операцией, — а статус и досрочное завершение новых дней
   * не открывают, и требовать от них решения по хвосту значило бы запирать работу ради состояния,
   * которое бумаге не мешает (Р30). Пробелы машиниста спрашиваются у всех шести: они относятся к
   * дням, которые дверь и так задевает.
   */
  opensTerm: boolean;
}

const DOORS: Record<AssignmentBackstopDoor, DoorSpec> = {
  request_status: { title: 'Смена статуса заказа', opensTerm: false },
  request_assignment: { title: 'Смена техники заказа', opensTerm: false },
  early_end_request: { title: 'Запрос досрочного завершения', opensTerm: false },
  early_end_decision: { title: 'Виза досрочного завершения', opensTerm: false },
  work_period: { title: 'Правка срока работ', opensTerm: true },
  weekly_apply: { title: 'Применение недельной заявки', opensTerm: true },
};

// ── Вердикт ──

/** Что история сказала бы про один заказ; пустого вердикта не бывает — вместо него `null`. */
export interface AssignmentBackstopVerdict {
  requestId: string;
  requestNumber: string;
  /** Начала `portal`-отрезков без машиниста в изменяемой части (Р16). */
  requiredAnchors: RequiredAnchor[];
  /** Расхождение хвоста, запирающее расширение срока (Р31); `null` — согласован либо не спрашивали. */
  requiredVehicleResolution: RequiredVehicleResolution | null;
}

/**
 * Машинно-читаемое тело отказа (Р22, Р23).
 *
 * Заказов может быть несколько — недельная операция называет **все** проблемные разом, чтобы
 * неделю чинили одним заходом, а не по одному заказу за визу.
 */
export interface AssignmentBackstopDetails {
  door: AssignmentBackstopDoor;
  requests: AssignmentBackstopVerdict[];
}

/** Код отказа: у портала на него свой экран (волна 6.2), и путать его с обычным 422 нельзя. */
export const ASSIGNMENT_BACKSTOP_CODE = 'assignment_history_incomplete';

/** Действие журнала, которым диагностика находится: `action = 'assignment.backstop_shadow'`. */
export const ASSIGNMENT_BACKSTOP_AUDIT_ACTION = 'assignment.backstop_shadow';

// ── Счётчик процесса ──

const counters = new Map<AssignmentBackstopDoor, number>();

/**
 * Сколько раз каждая дверь получила непустой вердикт с момента старта процесса.
 *
 * Счётчик, а не gauge: значение только растёт, перезапуск обнуляет — Prometheus такой сброс
 * понимает сам. Считается в момент записи диагностики, то есть до коммита двери; откатившаяся
 * транзакция оставит счётчику лишнюю единицу, но не оставит журналу лишней строки. Неточность
 * осознанная: счётчик отвечает на вопрос «идти ли смотреть», а отвечает на «что именно» журнал.
 */
export function assignmentBackstopCounters(): { door: AssignmentBackstopDoor; count: number }[] {
  return [...counters.entries()]
    .map(([door, count]) => ({ door, count }))
    .sort((a, b) => (a.door < b.door ? -1 : 1));
}

/**
 * Второй счётчик — боевые отказы, а не тень.
 *
 * Нужен он ровно потому, что первый в режиме `history` замолкает: отказ бросается **до** записи
 * диагностики, и после переключения чтения метрика тени уходит в ноль ровно тогда, когда чужие
 * двери начинают отказывать по-настоящему. Без второго счётчика первые сутки после cutover
 * выглядели бы как «всё тихо», а на деле это те самые риски §11 плана — площадка не продлевает
 * срок (п. 15), недельная виза не проходит из-за одного заказа (п. 16), диспетчер упирается в
 * обязательное поле (п. 12). Первым о них узнаёт график, а не звонок диспетчера.
 *
 * Считается в момент броска, то есть отказ засчитан даже если вызывающий его проглотил: 422 из
 * бэкстопа проглотить нечем — он откатывает транзакцию двери целиком.
 */
const refusals = new Map<AssignmentBackstopDoor, number>();

/** Сколько раз каждая дверь **отказала** по неполной истории (режим `history`). */
export function assignmentBackstopRefusals(): { door: AssignmentBackstopDoor; count: number }[] {
  return [...refusals.entries()]
    .map(([door, count]) => ({ door, count }))
    .sort((a, b) => (a.door < b.door ? -1 : 1));
}

/** Обнуление счётчиков — только тестам: прогон не должен зависеть от порядка файлов. */
export function resetAssignmentBackstopCounters(): void {
  counters.clear();
  refusals.clear();
}

// ── Расчёт ──

export interface AssignmentBackstopParams {
  door: AssignmentBackstopDoor;
  requestId: string;
  /** День расчёта: им меряется изменяемая область (Р21). По умолчанию — сегодняшний московский. */
  asOf?: string;
  /**
   * Последний день срока, каким он станет после операции, — вход продления (Р31).
   *
   * Расширение обязано проверить **весь вновь открываемый диапазон**: в нём лежат дремлющие
   * изменения обеих шкал, и посчитанный по нынешнему `date_to` вердикт их бы не увидел. Не передан
   * — считается по сроку, записанному в базе (правка срока зовёт бэкстоп уже после записи периода,
   * и там это тот же самый новый срок).
   */
  prospectiveDateTo?: string | null;
  /**
   * Открывает ли **эта команда** новые дни — сильнее умолчания двери (Ю78).
   *
   * У правки срока направление зависит не от двери, а от команды: продление открывает дни,
   * сокращение закрывает. Сокращению решение по хвосту спрашивать нельзя — гашение хвостовой группы
   * само создаёт расхождение, о котором его тут же и спросят.
   *
   * Не передан — берётся умолчание двери, и это верно для пяти дверей из шести: они либо всегда
   * открывают дни, либо не открывают никогда.
   */
  opensTerm?: boolean;
}

/**
 * Что история сказала бы этой двери — без единой записи.
 *
 * `null` означает «двери сказать нечего», и таких случаев четыре:
 *
 * - заявка не заказ спецтехники — статусную ручку проходят и вывоз мусора, и грузоперевозка;
 * - **заказ недельной бумаги не ведёт** (`esm2Mode ≠ 'auto'`): не в работе, арендный, удалённый или
 *   линейный. Гейт именно бумажный, а не «есть ли пробел в истории», и это существенно (Р21 п. 2):
 *   бэкстоп сторожит **бланк строгой отчётности**, выписываемый не на того. Там, где листа не будет
 *   вовсе — новый заказ до перевода в работу, отмена, аренда, — пробел в истории чинят своей дверью
 *   и в своё время, а чужую он не касается. У линейного заказа машиниста заявки не существует
 *   вовсе (ADR 0100 §6), и бумага из истории у него не считается (Р4);
 * - историю восстановить нечем (`empty` с причиной) — это работа ремонта, а не чужой двери;
 * - обычный случай — история полна и с назначением согласована.
 */
export async function evaluateAssignmentBackstop(
  tx: AssignmentWriteTx,
  params: AssignmentBackstopParams,
): Promise<AssignmentBackstopVerdict | null> {
  const asOf = params.asOf ?? moscowDateKeyOf(new Date());
  // Своя проверка типа заявки, а не отказ из глубины снимка: у вывоза мусора и грузоперевозки ни
  // срока работ, ни истории назначения нет вовсе, и `readAssignmentHistorySnapshot` ответил бы им
  // 422 — то есть бэкстоп сломал бы дверь ради заявки, к которой он не относится.
  const [head] = await tx
    .select({
      requestType: vehicleRequests.requestType,
      num: vehicleRequests.num,
      status: vehicleRequests.status,
      deletedAt: vehicleRequests.deletedAt,
      dateFrom: specialEquipmentRequestDetails.dateFrom,
    })
    .from(vehicleRequests)
    .leftJoin(
      specialEquipmentRequestDetails,
      eq(specialEquipmentRequestDetails.requestId, vehicleRequests.id),
    )
    .where(eq(vehicleRequests.id, params.requestId));
  if (!head || head.requestType !== 'special_equipment' || head.dateFrom === null) return null;

  const snapshot = await readAssignmentHistorySnapshot(tx, params.requestId);
  // Режим бумаги считается тем же `esm2Mode`, каким его считает сама сверка, и по **уже
  // записанному** состоянию заявки: статусная ручка зовёт бэкстоп после смены статуса, и отмена
  // заказа обязана прочитаться как «бумаги больше не будет», а не как «бумага под вопросом».
  const paperMode = esm2Mode({
    requestType: head.requestType,
    status: head.status,
    ownership: snapshot.assignmentVehicleId
      ? (snapshot.ownershipByVehicle.get(snapshot.assignmentVehicleId) ?? null)
      : null,
    deletedAt: head.deletedAt ? head.deletedAt.toISOString() : null,
    isLinear: snapshot.isLinear,
  });
  if (paperMode !== 'auto') return null;

  const term = prospectiveTerm(snapshot.term, params.prospectiveDateTo ?? null);
  // История считается **в памяти** и по прицельному сроку: у заказа, заведённого до модуля, строк
  // нет вовсе, и без гипотетического бэкфилла бэкстоп молчал бы ровно там, где он нужнее всего —
  // на старых заказах, чью историю восстанавливать по бумаге (Р20).
  const computed = computeAssignmentHistory({ ...snapshot, term }, asOf);
  if (computed.state === 'empty') return null;

  const segments = assignmentSegments(computed.changes, term);
  const mutable = mutableRangesOf(term, snapshot.sheets, asOf);
  const requiredAnchors = requiredAnchorsOf(
    { id: params.requestId, num: head.num },
    segments,
    term,
    snapshot.ownershipByVehicle,
    mutable,
  );
  /*
   * Направление правки сильнее умолчания двери (Ю78). `opensTerm` описывает дверь целиком, но у
   * правки срока оно зависит от команды: продление открывает дни, сокращение — закрывает. Спрашивать
   * у сокращения решение по хвосту нельзя: гашение хвостовой группы **само создаёт** то расхождение,
   * о котором его тут же и спросят, — дверь упрётся в им же произведённое состояние и не пройдёт
   * никогда. Поэтому вызывающий, знающий обе даты, вправе сказать направление явно.
   */
  const opensTerm = params.opensTerm ?? DOORS[params.door].opensTerm;
  const requiredVehicleResolution = opensTerm
    ? await tailMismatchOf(tx, snapshot, computed.changes, term)
    : null;

  if (requiredAnchors.length === 0 && requiredVehicleResolution === null) return null;
  return {
    requestId: params.requestId,
    requestNumber: formatVehicleRequestNumber(head.num),
    requiredAnchors,
    requiredVehicleResolution,
  };
}

/**
 * Срок, по которому считается вердикт: записанный в базе либо продлённый операцией.
 *
 * Прицел берётся только вперёд. Сокращение срока идёт своей дверью с визой, и «продление» назад
 * сюда не приходит вовсе; но проверка стоит и здесь — перевёрнутый срок дал бы пустую свёртку и
 * молчаливый вердикт вместо расчёта.
 */
function prospectiveTerm(term: AssignmentTerm, prospectiveDateTo: string | null): AssignmentTerm {
  if (!prospectiveDateTo) return term;
  const last = term.dateTo || term.dateFrom;
  return prospectiveDateTo > last ? { dateFrom: term.dateFrom, dateTo: prospectiveDateTo } : term;
}

/**
 * Расхождение хвоста (Р31): машина, **действующая на конце срока**, против машины назначения.
 *
 * Свёртка на `dateTo`, а не последняя строка истории (Б2): после сокращения срока последней строкой
 * может остаться машина, которая на конце срока уже не действует, и сравнение с ней прозевало бы
 * настоящее расхождение. Конец берётся у прицельного срока — в продлении именно он и решает, —
 * а `since` у **записанного**: это дата, которой ремонт поставит дремлющую границу, и ставит он её
 * до продления, по сроку, который видит.
 *
 * Имена спрашиваются только при расхождении и только для двух машин: у согласованного хвоста —
 * а это подавляющее большинство заказов — бэкстоп не делает ни одного лишнего запроса.
 */
async function tailMismatchOf(
  tx: AssignmentWriteTx,
  snapshot: AssignmentHistorySnapshot,
  changes: readonly AssignmentChangeRow[],
  term: AssignmentTerm,
): Promise<RequiredVehicleResolution | null> {
  const tail = assignmentStateOn(changes, term.dateTo || term.dateFrom).vehicle?.vehicleId ?? null;
  const assigned = snapshot.assignmentVehicleId;
  if (!tail || !assigned || tail === assigned) return null;
  const names = new Map<string, string>();
  for (const row of await tx
    .select({
      id: vehicles.id,
      description: vehicles.description,
      registrationNumber: vehicles.registrationNumber,
    })
    .from(vehicles)
    .where(inArray(vehicles.id, [tail, assigned]))) {
    names.set(row.id, row.description || row.registrationNumber || row.id);
  }
  return {
    tailVehicleId: tail,
    tailVehicleName: names.get(tail) ?? tail,
    assignmentVehicleId: assigned,
    assignmentVehicleName: names.get(assigned) ?? assigned,
    since: tailEffectiveDate(snapshot.term),
  };
}

// ── Применение: диагностика или отказ (Ж5) ──

/**
 * Что делать с посчитанными вердиктами — единственное место, где фаза превращается в поведение.
 *
 * Пустой перечень проходит молча и режима не спрашивает: лишний запрос к управляющей строке на
 * каждой смене статуса — цена ни за что.
 */
export async function applyAssignmentBackstop(
  tx: AssignmentWriteTx,
  params: {
    door: AssignmentBackstopDoor;
    actor: { id: string };
    verdicts: readonly AssignmentBackstopVerdict[];
    /** Что именно делали — уходит в диагностику, чтобы событие читалось без соседних строк. */
    reason?: string;
  },
): Promise<void> {
  const verdicts = params.verdicts.filter(
    (v) => v.requiredAnchors.length > 0 || v.requiredVehicleResolution !== null,
  );
  if (verdicts.length === 0) return;

  const details: AssignmentBackstopDetails = { door: params.door, requests: [...verdicts] };
  // Режим читается **без** блокировки: управляющую строку эта транзакция уже взяла `FOR SHARE`
  // шагом 0 своей двери (`requireOpenDoor`), и второй блокирующий запрос ничего бы не добавил.
  const mode = await readAssignmentMode(tx);
  if (historyIsAuthoritative(mode)) {
    refusals.set(params.door, (refusals.get(params.door) ?? 0) + 1);
    throw new AppError(
      422,
      ASSIGNMENT_BACKSTOP_CODE,
      refusalMessage(params.door, verdicts),
      undefined,
      details,
    );
  }

  counters.set(params.door, (counters.get(params.door) ?? 0) + 1);
  for (const verdict of verdicts) {
    await writeAuditTx(tx, {
      actorUserId: params.actor.id,
      action: ASSIGNMENT_BACKSTOP_AUDIT_ACTION,
      entityType: 'vehicle_request',
      entityId: verdict.requestId,
      metadata: {
        door: params.door,
        doorTitle: DOORS[params.door].title,
        // Режим записывается вместе с событием: строка обязана отвечать, почему операция всё же
        // прошла, — иначе через месяц её прочитают как «отказ, который кто-то обошёл».
        readMode: mode.readMode,
        ...(params.reason ? { reason: params.reason } : {}),
        requiredAnchors: verdict.requiredAnchors,
        requiredVehicleResolution: verdict.requiredVehicleResolution,
      },
    });
  }
}

/**
 * Посчитать и применить — для дверей, работающих с одним заказом.
 *
 * Недельная операция этой формой не пользуется: ей нужен preflight по **всем** применимым строкам
 * до первой записи (Р23), и вердикты она собирает сама, а сюда приносит их разом.
 */
export async function assertAssignmentBackstop(
  tx: AssignmentWriteTx,
  params: AssignmentBackstopParams & { actor: { id: string }; reason?: string },
): Promise<void> {
  const verdict = await evaluateAssignmentBackstop(tx, params);
  if (!verdict) return;
  await applyAssignmentBackstop(tx, {
    door: params.door,
    actor: params.actor,
    verdicts: [verdict],
    ...(params.reason ? { reason: params.reason } : {}),
  });
}

// ── Текст отказа (Р22) ──

/**
 * Отказ объясняет три вещи разом: что не так, почему чинит это не здесь и куда идти.
 *
 * Без третьей части отказ был бы тупиком: человек, правящий срок, про окно «Сменить машиниста»
 * знать не обязан — он вообще не тот, кто называет людей в бланки.
 */
function refusalMessage(
  door: AssignmentBackstopDoor,
  verdicts: readonly AssignmentBackstopVerdict[],
): string {
  const parts: string[] = [];
  const gaps = verdicts.filter((v) => v.requiredAnchors.length > 0);
  if (gaps.length > 0) {
    parts.push(
      `в истории не назван машинист: ${gaps
        .map(
          (v) =>
            `заказ ${v.requestNumber} — ${[...new Set(v.requiredAnchors.map((a) => dateRu(a.effectiveDate)))].join(', ')}`,
        )
        .join('; ')}. Назначьте его действием «Сменить машиниста» в карточке заказа`,
    );
  }
  const tails = verdicts.filter((v) => v.requiredVehicleResolution !== null);
  if (tails.length > 0) {
    parts.push(
      `история и назначение расходятся по технике: ${tails
        .map(
          (v) =>
            `заказ ${v.requestNumber} — история ведёт «${v.requiredVehicleResolution!.tailVehicleName}», назначено «${v.requiredVehicleResolution!.assignmentVehicleName}»`,
        )
        .join('; ')}. Выберите, какая машина работает дальше, в окне ремонта истории`,
    );
  }
  return `${DOORS[door].title} машиниста не назначает — ${parts.join('; ')}, и повторите операцию.`;
}

/** Календарный ключ человеку: «01.03.2026». Через `Date` он бы поехал на день. */
function dateRu(key: string): string {
  const [y, m, d] = key.split('-');
  return y && m && d ? `${d}.${m}.${y}` : key;
}

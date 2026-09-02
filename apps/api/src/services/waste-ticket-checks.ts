import { createHash } from 'node:crypto';
import {
  countsInWasteVolumeSum,
  dateKeySpan,
  formatWaybillDate,
  moscowDateKeyOf,
  WASTE_TICKET_CHECK_CODES,
  type WasteTicketAttachedFile,
  type WasteTicketBadgeDto,
  type WasteTicketCheckCode,
  type WasteTicketCheckDto,
  wasteTicketCheckSeverity,
  type WasteTicketStatus,
  type WasteTicketSubsystemState,
  type WasteTicketWorkKind,
} from '@technic/contracts';
import { similarWasteAddress } from './waste-ticket-normalize';

// ── Сверка талонов вывоза с заявкой (ADR 0114, план `docs/waste-ticket-ocr-plan.md`, Р15–Р21) ──
//
// ЗАМЕЧАНИЯ НЕ МАТЕРИАЛИЗУЮТСЯ (Р21). Таблица замечаний разошлась бы с талонами на первой же
// правке — и разошлась бы молча, потому что смотреть стали бы на неё, а не на талоны. Поэтому
// здесь чистая функция от (заявка, факт закрытия, талоны) к замечаниям, и тот же предикат ложится
// подзапросом в отбор «требуют разбора» (Р24).
//
// Материализуется РЕШЕНИЕ человека — «принимаю расхождение», и хранится оно с отпечатком входа
// (`wasteTicketCheckFingerprint`): изменилась любая величина, из которой расхождение сложилось, —
// принятие перестаёт действовать само. Без этого «принято» означало бы «замолчать навсегда», в том
// числе про расхождение, которого в момент принятия не было.
//
// ПРОВЕРКИ СЧИТАЮТСЯ ДО ПОДТВЕРЖДЕНИЯ (Р15). Считать их только по подтверждённым талонам нельзя:
// тогда человек, ещё не разобравший бумагу, не увидел бы ни одного замечания — то есть сверка
// появлялась бы уже после того, как он принял решение. Поэтому в счёт идут все НЕОТКЛОНЁННЫЕ
// талоны, а пока среди них есть неподтверждённые, результат помечен «предварительно». Ограничения
// БД при этом по-прежнему действуют только на подтверждённых: занять номер может лишь та бумага,
// которую человек признал.
//
// Модуль намеренно ничего не знает ни о базе, ни о правах: соседей по номеру и по скану ищет
// маршрут (он же решает, вправе ли смотрящий читать заявку-соседа, Р28), а сюда они приезжают
// готовым списком. Иначе одну и ту же сверку нельзя было бы прогнать на таблице случаев в тесте.

/**
 * Версия алгоритма сверки — часть отпечатка входа (Р21). Поднимается, когда меняется САМО ПРАВИЛО:
 * состав проверок, формула допуска, набор величин отпечатка. Принятые расхождения после этого
 * перестают действовать все разом, и это правильно: человек соглашался с выводом прежней сверки, а
 * не новой. Правка текста замечания версию не двигает — текст ничего не решает.
 */
export const WASTE_TICKET_CHECKS_VERSION = 1;

/**
 * Действующие допуски (Р18). Значения по умолчанию — те же, что в плане: объём сходится ТОЧНО
 * (нулевой допуск: талон и закрытие считают одни и те же кубы, и «почти сошлось» здесь означает
 * ошибку чтения), перегруз против заявки терпится до 10 %, расхождение с ПЛАНОВОЙ датой — до трёх
 * суток (вывоз сдвигают выходные, и ругаться на такой сдвиг значит ругаться на календарь).
 *
 * Приезжают параметром, а не читаются из конфигурации: допуск входит в отпечаток входа, и функция,
 * которая берёт его сама, посчитала бы принятие действующим по одному значению, а замечание — по
 * другому, поменяйся конфигурация между вызовами.
 */
export interface WasteTicketTolerances {
  /** `TICKET_VOLUME_TOLERANCE`, м³: жёсткая сверка суммы талонов с фактом закрытия. */
  volumeM3: number;
  /** `TICKET_VOLUME_PLAN_TOLERANCE`, доля: перегруз против заявленного объёма. */
  volumeOverPlanRatio: number;
  /** Мягкий порог расхождения с плановой датой, сутки: применяется, когда дня вывоза нет (Р19). */
  planDateDays: number;
}

export const DEFAULT_WASTE_TICKET_TOLERANCES: WasteTicketTolerances = {
  volumeM3: 0,
  volumeOverPlanRatio: 0.1,
  planDateDays: 3,
};

/**
 * Талон глазами сверки. Нормализации номера приезжают готовыми (`waste-ticket-normalize.ts`): их
 * считает тот, кто пишет строку, и пересчёт здесь означал бы, что в базе лежит один ключ, а
 * сравнивается другой.
 */
export interface WasteTicketCheckTicket {
  id: string;
  /** Номер дословно — он идёт в текст замечания: человеку показывают бумагу, а не ключ (Р16). */
  numberRaw: string;
  /** Консервативный ключ: по нему стоит уникальность и считается точный повтор номера. */
  numberKey: string;
  /** Поисковая нормализация: по ней ищется ПОХОЖИЙ номер, и вывод всегда предупреждение. */
  numberFuzzy: string;
  issuedOn: string | null;
  volumeM3: number | null;
  workKind: WasteTicketWorkKind;
  addressRaw: string;
  status: WasteTicketStatus;
  /** Снимок области уникальности: `null` — заявка без исполнителя, такие сведены в одну область. */
  operatorCounterpartyId: string | null;
  /** Страница скана; `null` у ручного талона и у машинного, чью страницу убрали. */
  pageId: string | null;
  /** Хэш растра страницы: точный повтор бумаги виден по нему даже без прочитанного номера (Р17). */
  pageSha256: string;
  /** Клапан «это разные бумаги» (Р17): строка выведена из-под ограничения человеком. */
  duplicateOverride: boolean;
  /** Файл, из которого пришла страница талона; `null` у ручного и у отвязанного (ADR 0155, Р18). */
  fileId: string | null;
  /** Модели прочитали поле по-разному — подтверждение такого талона падает (ADR 0155, Р16). */
  disputed: boolean;
  /** По талону лежит непринятое предложение перераспознавания — второе чтение ждёт человека. */
  hasProposal: boolean;
  /** Время последней правки строки: часть отпечатка готового набора (ADR 0155, Р23). */
  updatedAt: Date;
}

/**
 * Область уникальности номера ГЛАЗАМИ СВЕРКИ (ADR 0155, Р15).
 *
 * Машинный талон заводится «ничьим»: `operator_counterparty_id` у него `NULL`, а оператора он
 * получает в момент подтверждения — снимком с заявки. Считай сверка неподтверждённый талон по его
 * собственной пустой области, и предупреждение о похожем номере появлялось бы ПОСЛЕ подтверждения:
 * человек нажимает кнопку «всё сошлось» и получает ⚠️ там, где секунду назад было чисто.
 *
 * Условие по статусу, а не `??`: у подтверждённого талона `NULL` — законный снимок «заявка без
 * исполнителя», и подмена его оператором заявки переписала бы область уникальности задним числом.
 */
export function effectiveTicketArea(
  ticket: { status: WasteTicketStatus; operatorCounterpartyId: string | null },
  requestOperatorCounterpartyId: string | null,
): string | null {
  return ticket.status === 'unconfirmed'
    ? requestOperatorCounterpartyId
    : ticket.operatorCounterpartyId;
}

/** Как совпал сосед, найденный вне этой заявки. */
export type WasteTicketNeighbourKind = 'page' | 'number' | 'similar_number' | 'other_operator';

/**
 * Талон-сосед из ЧУЖОЙ заявки. Ищет его маршрут — по `page_sha256`, `number_key` и `number_fuzzy`
 * среди подтверждённых строк без снятого клапана, то есть ровно по тем, что стоят в частичных
 * индексах (Р17).
 */
export interface WasteTicketNeighbour {
  /** Талон ЭТОЙ заявки, для которого сосед найден. */
  ticketId: string;
  kind: WasteTicketNeighbourKind;
  /**
   * «М-812 от 15.08.2026» — или `null`, если заявку-соседа смотрящему читать не положено. Тогда
   * замечание говорит «по другой заявке» и не называет её: текст замечания — такой же канал
   * утечки, как ручка чтения, по нему чужую площадку можно перебрать номерами (Р28).
   */
  requestLabel: string | null;
  /** Номер соседа как он написан: у похожего номера именно он и объясняет замечание. */
  number: string;
}

/** Факт закрытия — то, с чем сверяются талоны (Р18, Р19). */
export interface WasteTicketCompletion {
  /** Предъявленный объём; `null` — закрытие весом (металлолом), с талонами вывоза не сверяется. */
  volumeM3: number | null;
  /** День фактического вывоза; `null` у закрытий старше колонки — им дата не выдумывается (Р19). */
  removedOn: string | null;
  removedOnSource: 'entered' | 'unknown';
}

/** Заявка — вторая половина сверки: что заказывали, когда и куда. */
export interface WasteTicketCheckRequest {
  /** Заявленный объём, м³; `null` — заявка без объёма (контейнерные операции, Р1). */
  requestedVolumeM3: number | null;
  /** Плановая дата подачи. */
  deliveryAt: Date | null;
  /** Адрес объекта заявки. */
  objectAddress: string;
  /** Название объекта: площадку узнают и по нему («Автозаводская, лот 33»), а адрес бывает пуст. */
  objectName: string;
  /** Область уникальности номера — исполнитель заявки (Р17). */
  operatorCounterpartyId: string | null;
}

/** Всё, из чего считаются и замечания, и отпечаток входа: один набор на обе задачи. */
export interface WasteTicketCheckInputs {
  request: WasteTicketCheckRequest;
  completion: WasteTicketCompletion | null;
  /**
   * Талоны заявки в порядке предъявления (страница, позиция, время заведения). Порядок значим:
   * замечание о повторе вешается на бумагу, предъявленную ПОЗЖЕ, — первая ни в чём не виновата.
   */
  tickets: readonly WasteTicketCheckTicket[];
  tolerances?: WasteTicketTolerances;
}

/** Принятие расхождения, как оно лежит в `waste_ticket_check_resolutions` (Р21). */
export interface StoredWasteTicketResolution {
  checkCode: string;
  subjectKey: string;
  inputFingerprint: string;
  acceptedByName: string;
  acceptedAt: string;
  comment: string;
}

export interface WasteTicketChecksInput extends WasteTicketCheckInputs {
  /** Совпадения в чужих заявках; пусто — маршрут ничего не нашёл или искать было нечем. */
  neighbours?: readonly WasteTicketNeighbour[];
  /** Принятия расхождений этой заявки; недействующие отсеются сами по отпечатку. */
  resolutions?: readonly StoredWasteTicketResolution[];
  /**
   * Сбои и слепые перепроверки — то, что ждёт человека помимо самой бумаги (Р24). В **замечания**
   * не превращается: замечание говорит «эти цифры не сходятся», а сломанный файл говорит «цифр
   * нет вовсе», и принять его как расхождение нельзя. Влияет только на значок — и обязано влиять,
   * иначе строка реестра оказалась бы пустой при живом фильтре.
   */
  subsystem?: WasteTicketSubsystemState;
}

export interface WasteTicketChecksResult {
  checks: WasteTicketCheckDto[];
  /** Сумма по неотклонённым талонам без простоев — та цифра, что стоит в замечании (Р18). */
  ticketsVolumeM3: number;
  /** Среди неотклонённых талонов есть неподтверждённые: сверка предварительная (Р15). */
  preliminary: boolean;
  /**
   * Можно ли принимать расхождения (Р15): только когда все талоны заявки разобраны. Иначе
   * отпечаток входа снимался бы с промежуточного состояния и слетал бы на следующем подтверждении.
   */
  acceptanceAllowed: boolean;
  badge: WasteTicketBadgeDto;
}

// ── Мелочи для текста замечаний ──

function plural(count: number, words: readonly [string, string, string]): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return words[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return words[1];
  return words[2];
}

/** Объём человеку: хвостовые нули не печатаются, дробная часть — с запятой, как её пишут в акте. */
function volumeText(value: number): string {
  const fixed = value.toFixed(3);
  const trimmed = fixed.includes('.') ? fixed.replace(/\.?0+$/u, '') : fixed;
  return `${trimmed.replace('.', ',')} м³`;
}

/** Сумма считается в той же точности, что и колонка `numeric(12,3)`: иначе сложение даст хвост. */
function roundVolume(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Календарных суток между днями; знак не нужен — в замечании стоит «расхождение N дней». */
function daysBetween(a: string, b: string): number {
  const [from, to] = a <= b ? [a, b] : [b, a];
  return Math.max(dateKeySpan(from, to) - 1, 0);
}

function daysText(days: number): string {
  return `${days} ${plural(days, ['день', 'дня', 'дней'])}`;
}

/** Кавычки-ёлочки — так замечания и написаны в §9.2 плана. */
function quoted(value: string): string {
  return `«${value}»`;
}

// ── Отпечаток входа (Р21) ──

/**
 * Число в отпечаток идёт СТРОКОЙ фиксированной точности: двоичный хвост `0.1 + 0.2` отпечаток
 * двигать не должен, а `numeric(12,3)` из базы приходит уже округлённым.
 */
function fingerprintNumber(value: number | null): string {
  return value == null ? '' : value.toFixed(3);
}

export interface WasteTicketFingerprintInput extends WasteTicketCheckInputs {
  checkCode: WasteTicketCheckCode;
  /** Id талона у построчных проверок, `''` у заявочных — тот же ключ, что в первичном ключе. */
  subjectKey: string;
}

/**
 * Отпечаток входа расхождения (Р21) — sha256 от всего, из чего расхождение сложилось: кода
 * проверки, набора подтверждённых талонов, фактического объёма, дня вывоза, заявленного объёма,
 * плановой даты, области оператора, действующих допусков и версии алгоритма.
 *
 * Три величины добавлены сверх перечисленных в Р21, и каждая закрывает свою дыру:
 *
 * - ВИД РАБОТ талона — он решает, входит ли талон в сумму (Р18): переведи подтверждённый талон из
 *   вывоза в простой, и сумма поедет, а принятие расхождения по объёму осталось бы в силе;
 * - АДРЕС талона и адрес объекта — вход четвёртой проверки, которой во времена первой редакции
 *   Р21 ещё не было: без них принятое «адрес не похож» пережило бы исправление адреса;
 * - ЧИСЛО НЕРАЗОБРАННЫХ талонов — принять расхождение можно только при нуле (Р15), а появившийся
 *   позже неподтверждённый талон меняет и сумму, и сам текст замечания.
 *
 * Набор талонов сортируется: порядок строк в выборке — не величина, и перестановка не должна
 * снимать принятие. Неподтверждённые в набор не входят вовсе — в момент принятия их нет по Р15.
 */
export function wasteTicketCheckFingerprint(input: WasteTicketFingerprintInput): string {
  const tolerances = input.tolerances ?? DEFAULT_WASTE_TICKET_TOLERANCES;
  const confirmed = input.tickets
    .filter((t) => t.status === 'confirmed')
    .map((t) =>
      [
        t.numberKey,
        t.issuedOn ?? '',
        fingerprintNumber(t.volumeM3),
        t.workKind,
        t.addressRaw.trim().toLowerCase(),
      ].join(' '),
    )
    .sort();
  const pending = input.tickets.filter(
    (t) => t.status !== 'dismissed' && t.status !== 'confirmed',
  ).length;

  const payload = JSON.stringify([
    WASTE_TICKET_CHECKS_VERSION,
    input.checkCode,
    input.subjectKey,
    confirmed,
    pending,
    fingerprintNumber(input.completion?.volumeM3 ?? null),
    input.completion?.removedOn ?? '',
    fingerprintNumber(input.request.requestedVolumeM3),
    input.request.deliveryAt?.toISOString() ?? '',
    input.request.operatorCounterpartyId ?? '',
    input.request.objectAddress.trim().toLowerCase(),
    input.request.objectName.trim().toLowerCase(),
    [tolerances.volumeM3, tolerances.volumeOverPlanRatio, tolerances.planDateDays],
  ]);
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

// ── Сама сверка ──

/** Порядок на полосе задаётся порядком кодов в контракте: сначала красное, потом жёлтое. */
const CODE_ORDER = new Map<WasteTicketCheckCode, number>(
  WASTE_TICKET_CHECK_CODES.map((code, index) => [code, index]),
);

/**
 * Четыре проверки заявки (Р17, Р18, Р19) плюс три предупреждения, которыми заканчиваются их
 * оговорки. Считаются по всем неотклонённым талонам; пока среди них есть неподтверждённые,
 * результат помечен «предварительно» (Р15).
 */
export function wasteTicketChecks(input: WasteTicketChecksInput): WasteTicketChecksResult {
  const { request, completion, tickets, subsystem } = input;
  const tolerances = input.tolerances ?? DEFAULT_WASTE_TICKET_TOLERANCES;
  const neighbours = input.neighbours ?? [];
  const resolutions = input.resolutions ?? [];

  // Отклонённые («это не талон» — шапка бланка, приписка с проходной, второй кадр той же бумаги)
  // не участвуют ни в одной проверке: человек уже сказал, что бумаги здесь нет.
  // Область у неподтверждённых подставляется вперёд (Р15): проверки обязаны видеть ту область, в
  // которой бумага окажется после подтверждения, иначе предупреждение появится уже после нажатия.
  // Подменяется РАБОЧАЯ копия, а не вход: отпечаток принятого расхождения снимается с `input.tickets`,
  // и двигать его правилом, которое к принятию отношения не имеет, нельзя.
  const active = tickets
    .filter((t) => t.status !== 'dismissed')
    .map((t) => ({
      ...t,
      operatorCounterpartyId: effectiveTicketArea(t, request.operatorCounterpartyId),
    }));
  const unconfirmed = active.filter((t) => t.status !== 'confirmed').length;
  const preliminary = unconfirmed > 0;
  // Готовые к подтверждению одним действием (ADR 0155, Р16): спорное поле роняет подтверждение, а
  // живое предложение означает второе чтение, о котором человек ещё не решил.
  const confirmableTickets = active.filter(
    (t) => t.status === 'unconfirmed' && !t.disputed && !t.hasProposal,
  );

  const collected = new Map<string, WasteTicketCheckDto>();
  const push = (code: WasteTicketCheckCode, subjectKey: string, message: string): void => {
    // Одно замечание на пару «проверка + предмет»: этой парой оно и гасится принятием
    // (`PRIMARY KEY (request_id, check_code, subject_key)`), и вторая строка с тем же ключом
    // означала бы замечание, которое принять нельзя. Поводов бывает несколько — тогда они
    // перечисляются в одном тексте.
    const key = `${code} ${subjectKey}`;
    const existing = collected.get(key);
    if (existing) {
      if (!existing.message.includes(message)) existing.message += `; ${message}`;
      return;
    }
    collected.set(key, {
      code,
      severity: wasteTicketCheckSeverity[code],
      subjectKey,
      message,
      preliminary,
      resolution: null,
    });
  };

  collectDuplicates(active, neighbours, push);
  const volume = collectVolume(active, request, completion, tolerances, unconfirmed, push);
  collectDates(active, request, completion, tolerances, push);
  collectAddresses(active, request, push);

  const checks = [...collected.values()].sort(
    (a, b) => (CODE_ORDER.get(a.code) ?? 0) - (CODE_ORDER.get(b.code) ?? 0),
  );

  // Принятие показывается ТОЛЬКО пока отпечаток сходится: недействующее в ответе не появляется
  // вовсе, а замечание просто возвращается. Показать его серым значило бы сказать «снято» про то,
  // что снова висит.
  for (const check of checks) {
    const stored = resolutions.find(
      (r) => r.checkCode === check.code && r.subjectKey === check.subjectKey,
    );
    if (!stored) continue;
    const fingerprint = wasteTicketCheckFingerprint({
      request,
      completion,
      tickets,
      tolerances,
      checkCode: check.code,
      subjectKey: check.subjectKey,
    });
    if (fingerprint !== stored.inputFingerprint) continue;
    check.resolution = {
      acceptedByName: stored.acceptedByName,
      acceptedAt: stored.acceptedAt,
      comment: stored.comment,
    };
  }

  return {
    checks,
    ticketsVolumeM3: volume,
    preliminary,
    acceptanceAllowed: unconfirmed === 0,
    badge: {
      confirmable: confirmableTickets.length,
      confirmableFingerprint: confirmableFingerprint(confirmableTickets),
      // Снятое замечание в значке не считается: оно уже разобрано человеком и в реестр «требуют
      // разбора» заявку не тянет.
      //
      // Слепая перепроверка попадает в значок по своему состоянию: `mismatch` — расхождение двух
      // чтений, то есть работа арбитра (⛔); `pending` — бумага ещё не прочитана вторым человеком,
      // то есть та же очередь, что и неподтверждённый талон (⏳).
      errors:
        checks.filter((c) => c.severity === 'error' && !c.resolution).length +
        (subsystem?.blindMismatch ?? 0),
      warnings: checks.filter((c) => c.severity === 'warning' && !c.resolution).length,
      pendingConfirmation: unconfirmed + (subsystem?.blindPending ?? 0),
      failures: (subsystem?.failedFiles ?? 0) + (subsystem?.failedPages ?? 0),
      // Приложенная бумага, до которой разбор не дошёл, — ПОФАЙЛОВО (ADR 0155, Р18).
      //
      // Прежнее правило («сколько файлов, пока нет ни одного подтверждённого талона») отвечало про
      // заявку целиком там, где вопрос про конкретный лист: распознанная бумага давала `⏳2 📄2`, а
      // единственный нечитаемый файл — `🚫1 📄1`. Два числа об одном и том же.
      unreviewedPaper: unreviewedPaperFiles(active, subsystem?.attachedTicketFiles ?? []),
    },
  };
}

/**
 * Отпечаток готового набора (ADR 0155, Р23): по нему сервер узнаёт, что человек нажимал кнопку,
 * видя ровно эти талоны. Числа мало — между отрисовкой и нажатием один талон может исчезнуть, а
 * другой появиться, и счёт совпадёт при другом составе.
 *
 * В отпечаток идёт `updatedAt`: правка талона, не меняющая ни статуса, ни спора, всё равно меняет
 * цифры, под которыми человек подписывается.
 */
function confirmableFingerprint(tickets: readonly WasteTicketCheckTicket[]): string {
  if (tickets.length === 0) return '';
  const payload = tickets
    .map((t) => [t.id, t.updatedAt.toISOString(), t.status].join(' '))
    .sort()
    .join('\n');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Сколько приложенных листов ждут, чтобы к ним ПРИСТУПИЛИ (ADR 0155, Р18). Лист считается дошедшим
 * до разбора, если верно любое:
 *
 * 1. по нему есть неотклонённый талон — бумага прочитана, дальше о ней говорят ⏳ и ⛔;
 * 2. он сломан и уже посчитан в 🚫 — про такой сказано другим числом;
 * 3. он прочитан успешно, талона в нём не нашлось, а в заявке есть неотклонённый талон БЕЗ
 *    страницы, то есть заведённый руками. Это единственный выход из тупика: разобрать лист, в
 *    котором машина талона не увидела, можно только руками, а ручной талон к файлу не привязан.
 *
 * Отклонённый талон лист НЕ закрывает: «это не талон» говорит ровно обратное — настоящей бумаги в
 * разборе так и нет (правило ADR 0135 сохранено дословно).
 */
function unreviewedPaperFiles(
  active: readonly WasteTicketCheckTicket[],
  attached: readonly WasteTicketAttachedFile[],
): number {
  if (attached.length === 0) return 0;
  const coveredFiles = new Set(
    active.map((t) => t.fileId).filter((id): id is string => id !== null),
  );
  const hasManual = active.some((t) => t.fileId === null);
  return attached.filter((file) => {
    if (file.broken || coveredFiles.has(file.fileId)) return false;
    return !(file.readOk && hasManual);
  }).length;
}

type Push = (code: WasteTicketCheckCode, subjectKey: string, message: string) => void;

/**
 * Уникальность двухслойная (Р17): точный повтор БУМАГИ виден по хэшу растра ещё до всякого чтения,
 * повтор НОМЕРА — в области оператора-исполнителя, потому что талон выдаёт перевозчик и у двух
 * перевозчиков нумерация независима.
 *
 * Внутри одной заявки повтор ищется здесь, вне её — приезжает соседями от маршрута: искать соседа
 * значит ходить в базу, а сверка обязана оставаться чистой.
 */
function collectDuplicates(
  active: readonly WasteTicketCheckTicket[],
  neighbours: readonly WasteTicketNeighbour[],
  push: Push,
): void {
  const pageOwners = new Map<string, string>();
  const numberOwners = new Map<string, WasteTicketCheckTicket>();
  const fuzzyOwners = new Map<string, WasteTicketCheckTicket>();

  for (const ticket of active) {
    // Один скан, приложенный дважды разными файлами, — это буквально один и тот же лист. Талоны с
    // ОДНОЙ страницы сюда не попадают: на кадре их законно бывает два, и различает случаи `pageId`.
    if (ticket.pageSha256 && ticket.pageId) {
      const owner = pageOwners.get(ticket.pageSha256);
      if (!owner) {
        pageOwners.set(ticket.pageSha256, ticket.pageId);
      } else if (owner !== ticket.pageId) {
        push('duplicate_number', ticket.id, 'Тот же скан уже приложен к этой заявке');
      }
    }

    if (!ticket.numberKey) continue;
    const area = ticket.operatorCounterpartyId ?? '';

    const sameNumber = numberOwners.get(ticket.numberKey);
    if (!sameNumber) {
      numberOwners.set(ticket.numberKey, ticket);
    } else if ((sameNumber.operatorCounterpartyId ?? '') === area) {
      // Клапан «это разные бумаги» снимает замечание о НОМЕРЕ — человек уже сказал, что совпадение
      // случайно. На повтор скана он не распространяется: одинаковый растр это один лист, и
      // утверждение о разных бумагах его не отменяет.
      if (!ticket.duplicateOverride) {
        push(
          'duplicate_number',
          ticket.id,
          `Номер ${ticket.numberRaw} уже предъявлен другим талоном этой заявки`,
        );
      }
    } else {
      push(
        'duplicate_number_other_operator',
        ticket.id,
        `Тот же номер ${ticket.numberRaw} стоит у талона другого перевозчика`,
      );
    }

    if (!ticket.numberFuzzy) continue;
    const similar = fuzzyOwners.get(ticket.numberFuzzy);
    if (!similar) {
      fuzzyOwners.set(ticket.numberFuzzy, ticket);
      continue;
    }
    // Похожий — это НЕ тот же самый: точный повтор уже назван выше, и повторять его вторым
    // замечанием значит показывать одно расхождение дважды.
    if (similar.numberKey === ticket.numberKey) continue;
    if ((similar.operatorCounterpartyId ?? '') !== area) continue;
    push(
      'similar_number',
      ticket.id,
      `Похожий номер у того же перевозчика: ${ticket.numberRaw} и ${similar.numberRaw}`,
    );
  }

  const byId = new Map(active.map((t) => [t.id, t]));
  for (const neighbour of neighbours) {
    const ticket = byId.get(neighbour.ticketId);
    if (!ticket) continue;
    // Заявка-сосед называется только тому, кто вправе её читать (Р28): текст замечания — такой же
    // канал утечки, как ручка чтения, по нему чужую площадку можно перебрать номерами.
    const where = neighbour.requestLabel
      ? `по заявке ${neighbour.requestLabel}`
      : 'по другой заявке';
    switch (neighbour.kind) {
      case 'page':
        push('duplicate_number', ticket.id, `Тот же скан уже предъявлен ${where}`);
        break;
      case 'number':
        if (!ticket.duplicateOverride) {
          push('duplicate_number', ticket.id, `Номер ${ticket.numberRaw} уже предъявлен ${where}`);
        }
        break;
      case 'similar_number':
        push(
          'similar_number',
          ticket.id,
          `Похожий номер у того же перевозчика: ${ticket.numberRaw} и ${neighbour.number} ${where}`,
        );
        break;
      case 'other_operator':
        push(
          'duplicate_number_other_operator',
          ticket.id,
          `Тот же номер ${ticket.numberRaw} предъявлен другим перевозчиком ${where}`,
        );
        break;
    }
  }
}

/**
 * Объём (Р18): сумма по неотклонённым талонам против факта закрытия — жёстко, против заявленного —
 * мягко. ТАЛОНЫ ПРОСТОЯ В СУММУ НЕ ВХОДЯТ и объёма не требуют: их объём — не «ноль вывезенного», а
 * «вывоза не было», и сложи мы их вместе, жёсткая проверка ругалась бы на каждой заявке, где
 * машина простояла у закрытых ворот. Предикат общий с порталом (`countsInWasteVolumeSum`), иначе
 * человек увидел бы замечание, не сходящееся с таблицей у него же перед глазами.
 *
 * Возвращает сумму: её показывают в карточке, и второй счёт того же числа разошёлся бы с первым.
 */
function collectVolume(
  active: readonly WasteTicketCheckTicket[],
  request: WasteTicketCheckRequest,
  completion: WasteTicketCompletion | null,
  tolerances: WasteTicketTolerances,
  unconfirmed: number,
  push: Push,
): number {
  const summable = active.filter((t) => countsInWasteVolumeSum(t.workKind));
  const sum = roundVolume(summable.reduce((acc, t) => acc + (t.volumeM3 ?? 0), 0));
  // Талонов нет вовсе — сверять нечего: «в талонах 0 м³, в закрытии 48 м³» было бы замечанием не о
  // расхождении, а о том, что распознавание ещё не отработало. Об этом говорит состояние файла
  // (Р29), а заявку в реестр тянет неразобранность (Р24).
  if (active.length === 0) return sum;

  const missing = summable.filter((t) => t.volumeM3 == null).length;
  // Хвост «объём не прочитан у 1 талона» приписан к сумме намеренно: без него сумма выглядит
  // полной, и человек искал бы недостачу в закрытии вместо смазанной графы.
  const gap =
    missing > 0
      ? `; объём не прочитан у ${missing} ${plural(missing, ['талона', 'талонов', 'талонов'])}`
      : '';
  const draft =
    unconfirmed > 0
      ? ` (${unconfirmed} из ${active.length} ${plural(unconfirmed, ['не подтверждён', 'не подтверждены', 'не подтверждены'])})`
      : '';

  const fact = completion?.volumeM3 ?? null;
  if (fact != null && Math.abs(sum - fact) > tolerances.volumeM3 + 1e-9) {
    push(
      'volume_mismatch',
      '',
      `В талонах ${volumeText(sum)}${draft}, в закрытии ${volumeText(fact)}${gap}`,
    );
  }

  // Недогруз против заявки замечанием не считается: заказали 30 м³, вывезли 20 — вывезли столько,
  // сколько было. Ловится только перегруз: за него платят.
  const planned = request.requestedVolumeM3;
  if (
    planned != null &&
    planned > 0 &&
    sum > planned * (1 + tolerances.volumeOverPlanRatio) + 1e-9
  ) {
    const over = Math.round((sum / planned - 1) * 100);
    push(
      'volume_over_request',
      '',
      `В талонах ${volumeText(sum)}${draft}, в заявке ${volumeText(planned)} — на ${over} % больше заказанного`,
    );
  }
  return sum;
}

/**
 * Дата (Р19). Жёстко — против фактического дня вывоза, и ТОЛЬКО когда он введён человеком
 * (`removed_on_source = 'entered'`): у закрытий старше колонки дня нет, и выдумывать его нельзя —
 * подстановка плановой даты выдала бы предположение за факт и нарисовала бы расхождения там, где
 * их никто не совершал.
 *
 * Когда дня вывоза нет, сравнение идёт с ПЛАНОВОЙ датой и мягко, по допуску в сутках. Две сверки
 * взаимоисключающие, а не идущие подряд: у них один код проверки и один предмет, а значит и одно
 * принятие на двоих (`PRIMARY KEY (request_id, check_code, subject_key)`) — два замечания с этим
 * ключом человек не смог бы разобрать по отдельности.
 */
function collectDates(
  active: readonly WasteTicketCheckTicket[],
  request: WasteTicketCheckRequest,
  completion: WasteTicketCompletion | null,
  tolerances: WasteTicketTolerances,
  push: Push,
): void {
  const removedOn =
    completion && completion.removedOnSource === 'entered' ? completion.removedOn : null;
  const plannedOn = request.deliveryAt ? moscowDateKeyOf(request.deliveryAt) : null;

  for (const ticket of active) {
    // Дата не прочиталась — сверять нечего. Такой талон ждёт человека сам по себе (Р24), и второе
    // замечание о том же только заслонило бы настоящие расхождения.
    if (!ticket.issuedOn) continue;

    if (removedOn) {
      if (ticket.issuedOn === removedOn) continue;
      const off = daysText(daysBetween(ticket.issuedOn, removedOn));
      push(
        'date_mismatch',
        ticket.id,
        `Дата талона ${formatWaybillDate(ticket.issuedOn)}, дата вывоза ${formatWaybillDate(removedOn)} — расхождение ${off}`,
      );
      continue;
    }

    if (!plannedOn) continue;
    const off = daysBetween(ticket.issuedOn, plannedOn);
    if (off <= tolerances.planDateDays) continue;
    push(
      'date_mismatch',
      ticket.id,
      `Дата вывоза в закрытии не указана; дата талона ${formatWaybillDate(ticket.issuedOn)} расходится с плановой ${formatWaybillDate(plannedOn)} на ${daysText(off)}`,
    );
  }
}

/**
 * Адрес (Р18) — четвёртая проверка, добавленная после замера настоящих бланков: она ловит бумагу,
 * приехавшую с ЧУЖОЙ площадки. Мягкая и нестрогая по построению: адрес пишут от руки и сокращают
 * как придётся, и жёсткой она ругалась бы на каждом втором талоне.
 *
 * Сравнение идёт и с адресом объекта, и с его названием: площадку в портале нередко и называют
 * адресом («Автозаводская, лот 33»), а поле адреса у объекта бывает пустым.
 */
function collectAddresses(
  active: readonly WasteTicketCheckTicket[],
  request: WasteTicketCheckRequest,
  push: Push,
): void {
  const targets = [request.objectAddress, request.objectName].filter((t) => t.trim().length > 0);
  if (targets.length === 0) return;

  for (const ticket of active) {
    if (!ticket.addressRaw.trim()) continue;
    if (targets.some((target) => similarWasteAddress(ticket.addressRaw, target))) continue;
    push(
      'address_mismatch',
      ticket.id,
      `Адрес талона ${quoted(ticket.addressRaw)} не похож на объект заявки ${quoted(targets[0]!)}`,
    );
  }
}

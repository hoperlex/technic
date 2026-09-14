/**
 * Журнал находок: память системы о решениях человека.
 *
 * ЗАЧЕМ ОН ЕСТЬ. Без журнала каждый прогон отправляет агенту весь набор находок заново, включая
 * те, по которым человек уже ответил «это осознанный долг» или «это ложное срабатывание». Платится
 * за это дважды: деньгами за контекст и вниманием человека, которого спрашивают об одном и том же.
 * Журнал узнаёт находку по ОТПЕЧАТКУ (`fingerprintOf`), а не по формулировке, и молчит о том, что
 * уже решено.
 *
 * ЗАЧЕМ ОН ЗАБЫВАЕТ. Решение принимается не о тексте находки, а о коде и правиле, которые за ней
 * стоят. Изменился код вокруг — прежнее «осознанный долг» относится к другому коду; изменилось
 * правило — к другому правилу. Молчаливая память в этом случае опаснее лишнего вопроса: система
 * скрывала бы находку, которую никто не рассматривал. Поэтому у памяти есть ровно четыре причины
 * истечь, и все они перечислены в `reopenReason`.
 *
 * ПОЧЕМУ `deferred` ТОЖЕ МОЛЧИТ. В `fresh` не идут ни `accepted-debt`, ни `false-positive`, ни
 * `deferred`: «не сейчас» — такое же решение человека, как и два других, и если показывать его
 * каждый прогон, срок `deferredReviewDays` нечему было бы истекать. Разница между ними только в
 * сроке: у отложенного и у ложного он есть, у осознанного долга — нет, его отменяет не время, а
 * изменение кода, правила или доказательства.
 *
 * ПОЧЕМУ ХРАНИЛИЩЕ — ИНТЕРФЕЙС. Сегодня журнал помещается в один JSON. Когда перестанет
 * помещаться, на его место встанет SQLite, и знать об этом должен только конструктор вызывающего,
 * а не сверка.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TrackedFinding } from '../core/finding.ts';
import type { LedgerPolicy } from '../core/types.ts';

/**
 * Состояние находки в журнале.
 *
 * `new` и `reopened` означают одно для отбора — «решения нет, показывать» — но разное для
 * человека: второе говорит, что решение БЫЛО и перестало действовать, и это первое, что он хочет
 * знать, снова увидев старую находку.
 */
export type LedgerStatus =
  'new' | 'accepted-debt' | 'deferred' | 'false-positive' | 'fixed' | 'reopened';

export interface LedgerEntry {
  readonly fingerprint: string;
  readonly status: LedgerStatus;
  readonly title: string;
  readonly files: readonly string[];
  readonly policy?: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
  /** Когда человек принял решение. От этой даты считается срок пересмотра. */
  readonly decidedAt?: string;
  /** Почему такое решение. Единственное поле журнала, которое пишет человек. */
  readonly note?: string;
  /**
   * Отпечаток доказательства.
   *
   * Не дублирует `fingerprint`: тот намеренно огрубляет доказательство — гасит регистр, пробелы и
   * ЧИСЛА, чтобы сдвиг строк и переформулировка не делали проблему новой. Но «функция не
   * вызывается из 2 мест» и «из 17 мест» — это один отпечаток и разный масштаб проблемы. Дайджест
   * считается по точному тексту и ловит ровно такой случай.
   */
  readonly evidenceDigest: string;
}

/** Хранилище журнала. Интерфейс, а не класс: JSON здесь временный жилец. */
export interface FindingStore {
  load(): Promise<readonly LedgerEntry[]>;
  save(entries: readonly LedgerEntry[]): Promise<void>;
}

const STATUSES: readonly LedgerStatus[] = [
  'new',
  'accepted-debt',
  'deferred',
  'false-positive',
  'fixed',
  'reopened',
];

/** Статусы, при которых находка агенту не показывается: решение человека действует. */
const SUPPRESSING: readonly LedgerStatus[] = ['accepted-debt', 'deferred', 'false-positive'];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Дайджест доказательства.
 *
 * Регистр и пробелы гасятся — модель перепишет их иначе, ничего не изменив по сути. Числа и полная
 * длина сохраняются: именно ими доказательство отличается от самого себя месячной давности.
 */
export function evidenceDigestOf(evidence: string): string {
  const normalized = evidence.toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Журнал в одном файле JSON.
 *
 * Запись атомарна (временный файл и переименование), потому что здесь лежат решения человека:
 * оборванная на середине запись стоила бы не прогона, а всех ответов, которые он когда-либо дал.
 * По той же причине испорченный файл не подменяется пустым журналом — он роняет загрузку с именем
 * файла, чтобы человек увидел потерю, а не тишину.
 */
export class JsonFindingStore implements FindingStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  async load(): Promise<readonly LedgerEntry[]> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      // Журнала ещё нет — это первый прогон, а не сбой. Любая другая беда (права, каталог вместо
      // файла) остаётся видимой: молча принять её за пустой журнал значит стереть память.
      if (isMissingFile(error)) return [];
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${this.file}: журнал находок не читается как JSON`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`${this.file}: журнал находок должен быть массивом записей`);
    }
    return parsed.map((item, index) => parseEntry(item, `${this.file}[${index}]`));
  }

  async save(entries: readonly LedgerEntry[]): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    // Порядок задаётся отпечатком, а не порядком прихода находок: журнал читают глазами и
    // сравнивают между прогонами, а файл, строки которого переезжают сами по себе, сравнивать
    // нечем.
    const ordered = [...entries].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8');
    await rename(temporary, this.file);
  }
}

export interface ReconcileInput {
  readonly entries: readonly LedgerEntry[];
  readonly findings: readonly TrackedFinding[];
  readonly policy: LedgerPolicy;
  readonly now: Date;
  /** Изменился ли код, относящийся к находке, со времени решения. Считает вызывающий. */
  readonly codeChanged: (entry: LedgerEntry) => boolean;
  /** Изменилось ли правило, на которое находка ссылается. */
  readonly policyChanged: (entry: LedgerEntry) => boolean;
}

export interface SuppressedFinding {
  readonly finding: TrackedFinding;
  readonly entry: LedgerEntry;
  /** Почему находка не показана. Без этого подавление неотличимо от пропажи. */
  readonly why: string;
}

export interface ReconcileResult {
  readonly entries: readonly LedgerEntry[];
  readonly fresh: readonly TrackedFinding[];
  readonly suppressed: readonly SuppressedFinding[];
  readonly reopened: readonly LedgerEntry[];
}

/**
 * Сверка находок прогона с журналом.
 *
 * Чистая функция: решение «изменился ли код» и «изменилось ли правило» считает вызывающий и
 * передаёт готовым ответом. Так сверку можно проверить тестом без репозитория, без git и без
 * сегодняшней даты — а именно её ошибки дороже всего: она решает, о чём система промолчит.
 */
export function reconcile(input: ReconcileInput): ReconcileResult {
  const nowIso = input.now.toISOString();
  const known = new Map(input.entries.map((entry) => [entry.fingerprint, entry]));
  const fresh: TrackedFinding[] = [];
  const suppressed: SuppressedFinding[] = [];
  const reopened: LedgerEntry[] = [];

  for (const finding of input.findings) {
    const digest = evidenceDigestOf(finding.evidence);
    const previous = known.get(finding.fingerprint);

    // Правило 1: отпечаток незнаком — находку никто не видел, решения нет. Она `new` и идёт агенту.
    if (!previous) {
      const entry = newEntry(finding, digest, nowIso);
      known.set(entry.fingerprint, entry);
      fresh.push(finding);
      continue;
    }

    // Правило 5: `lastSeen` обновляется всегда, когда находка встретилась, — даже у подавленной.
    // Иначе нечем отличить решение, которое всё ещё про живую проблему, от решения о находке,
    // пропавшей год назад.
    const refreshed = refreshEntry(previous, finding, digest, nowIso);
    const why = reopenReason(previous, input, digest);

    if (why) {
      // Правила 3 и 4: решение перестало действовать. Прежние `decidedAt` и `note` сохраняются
      // намеренно — статус `reopened` уже говорит, что решение не в силе, а дата и причина
      // показывают человеку, что он решал в прошлый раз. Решая заново, он читает именно это.
      const entry: LedgerEntry = { ...refreshed, status: 'reopened' };
      known.set(entry.fingerprint, entry);
      reopened.push(entry);
      fresh.push(finding);
      continue;
    }

    known.set(refreshed.fingerprint, refreshed);

    // Правило 2: решённая находка агенту не показывается. Это и есть экономия, ради которой
    // журнал существует.
    if (SUPPRESSING.includes(refreshed.status)) {
      suppressed.push({ finding, entry: refreshed, why: suppressionReason(refreshed) });
      continue;
    }
    fresh.push(finding);
  }

  // Записи, не встретившиеся в этом прогоне, остаются нетронутыми и НЕ помечаются `fixed`.
  // Отсутствие находки не доказывает, что её починили: область прогона бывает неполной, а агент —
  // невнимательным. Пометку «исправлено» ставит тот, кто это знает: человек или цикл правки.
  const entries = [...known.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  return { entries, fresh, suppressed, reopened };
}

/**
 * Причина переоткрытия или `null`, если решение ещё в силе.
 *
 * Порядок проверок — от самой веской причины к самой формальной, потому что в отчёт и в журнал
 * попадает только первая: человеку нужна причина, а не их полный список.
 */
function reopenReason(entry: LedgerEntry, input: ReconcileInput, digest: string): string | null {
  // Правило 4: находка, помеченная исправленной, встретилась снова. Это регрессия, и она
  // показывается независимо от сроков и настроек: починка, которая отменилась, — худший из
  // возможных видов долга, потому что все считают вопрос закрытым.
  if (entry.status === 'fixed') return 'находка появилась снова после отметки об исправлении';

  // Нерешённые статусы переоткрывать не из чего: решения не было.
  if (!SUPPRESSING.includes(entry.status)) return null;

  if (input.policy.reopenOnCodeChange && input.codeChanged(entry)) {
    return 'код вокруг находки изменился со времени решения';
  }
  if (input.policy.reopenOnPolicyChange && input.policyChanged(entry)) {
    return 'правило, на которое ссылается находка, изменилось';
  }
  // Доказательство сменилось при том же отпечатке: та же проблема другого масштаба. Решение
  // принималось о прежнем масштабе.
  if (entry.evidenceDigest !== digest) return 'доказательство находки изменилось по существу';

  const days = reviewDays(entry.status, input.policy);
  if (days !== null && expired(entry, days, input.now)) {
    return `истёк срок пересмотра (${days} дн.)`;
  }
  return null;
}

/**
 * Срок пересмотра для статуса.
 *
 * У `accepted-debt` срока нет, и это не упущение политики: осознанный долг тем и осознан, что
 * человек согласился жить с ним без напоминаний. Его отменяет изменение кода, правила или
 * доказательства — то есть событие, а не календарь.
 */
function reviewDays(status: LedgerStatus, policy: LedgerPolicy): number | null {
  if (status === 'deferred') return policy.deferredReviewDays;
  if (status === 'false-positive') return policy.falsePositiveReviewDays;
  return null;
}

function expired(entry: LedgerEntry, days: number, now: Date): boolean {
  // Неположительный срок читается как «не помнить вовсе»: политика вправе выключить память по
  // статусу, не заводя отдельного флага.
  if (days <= 0) return true;
  // Даты решения нет — решение записано мимо `decide`, руками. Срок считается от первой встречи:
  // ошибка в сторону лишнего вопроса дешевле, чем решение, которое молчит вечно и без даты.
  const base = Date.parse(entry.decidedAt ?? entry.firstSeen);
  if (Number.isNaN(base)) return true;
  return now.getTime() - base >= days * DAY_MS;
}

function suppressionReason(entry: LedgerEntry): string {
  const decided = entry.decidedAt ? ` от ${entry.decidedAt.slice(0, 10)}` : '';
  if (entry.status === 'accepted-debt') return `осознанный долг: решение${decided}`;
  if (entry.status === 'false-positive') return `ложное срабатывание: решение${decided}`;
  return `отложено: решение${decided}`;
}

function newEntry(finding: TrackedFinding, digest: string, nowIso: string): LedgerEntry {
  return {
    fingerprint: finding.fingerprint,
    status: 'new',
    title: finding.title,
    files: [...finding.files],
    ...(finding.policy === undefined ? {} : { policy: finding.policy }),
    firstSeen: nowIso,
    lastSeen: nowIso,
    evidenceDigest: digest,
  };
}

/**
 * Запись после повторной встречи находки.
 *
 * Заголовок, файлы и правило берутся из свежей находки, а решение человека (`status`, `decidedAt`,
 * `note`) — из журнала. Разделение принципиальное: описание проблемы принадлежит прогону и должно
 * читаться сегодняшним, а решение принадлежит человеку, и переписывать его некому.
 */
function refreshEntry(
  entry: LedgerEntry,
  finding: TrackedFinding,
  digest: string,
  nowIso: string,
): LedgerEntry {
  return {
    ...entry,
    title: finding.title,
    files: [...finding.files],
    ...(finding.policy === undefined ? {} : { policy: finding.policy }),
    lastSeen: nowIso,
    evidenceDigest: digest,
  };
}

export interface DecideOptions {
  readonly note?: string;
  readonly now: Date;
}

/**
 * Решение человека по одной находке.
 *
 * Возвращается новый журнал целиком, а не изменённая запись: журнал — единственное значение,
 * которое кладётся в хранилище, и собирать его из кусков на стороне вызывающего значит однажды
 * положить туда половину.
 *
 * Неизвестный отпечаток — ошибка, а не пустая операция: человек, опечатавшийся в отпечатке, должен
 * узнать об этом сразу, а не обнаружить через прогон, что его решение нигде не записалось.
 */
export function decide(
  entries: readonly LedgerEntry[],
  fingerprint: string,
  status: LedgerStatus,
  options: DecideOptions,
): readonly LedgerEntry[] {
  const target = entries.find((entry) => entry.fingerprint === fingerprint);
  if (!target) throw new Error(`в журнале нет находки с отпечатком ${fingerprint}`);
  // Причина объясняет КОНКРЕТНОЕ решение. Перенести старую причину на новое значит подписать его
  // чужим объяснением, поэтому решение без причины стирает прежнюю.
  const base = dropNote({ ...target, status, decidedAt: options.now.toISOString() });
  const decided: LedgerEntry = options.note === undefined ? base : { ...base, note: options.note };
  return entries.map((entry) => (entry.fingerprint === fingerprint ? decided : entry));
}

function dropNote(entry: LedgerEntry): LedgerEntry {
  const { note: _note, ...rest } = entry;
  return rest;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Разбор одной записи из файла.
 *
 * Проверяется не форма ради формы: журнал правят руками (это единственный способ записать решение
 * без командной строки), и опечатка в статусе не должна превращаться в молчаливое подавление
 * находки с непонятным статусом.
 */
function parseEntry(value: unknown, where: string): LedgerEntry {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${where}: запись журнала должна быть объектом`);
  }
  const raw: Record<string, unknown> = { ...value };
  const fingerprint = requireString(raw.fingerprint, `${where}.fingerprint`);
  const status = raw.status;
  if (!isStatus(status)) {
    throw new Error(`${where}.status: неизвестный статус «${String(status)}»`);
  }
  const files = raw.files;
  if (!isStringList(files)) {
    throw new Error(`${where}.files: ожидался список путей`);
  }
  return {
    fingerprint,
    status,
    title: requireString(raw.title, `${where}.title`),
    files,
    ...(typeof raw.policy === 'string' ? { policy: raw.policy } : {}),
    firstSeen: requireString(raw.firstSeen, `${where}.firstSeen`),
    lastSeen: requireString(raw.lastSeen, `${where}.lastSeen`),
    ...(typeof raw.decidedAt === 'string' ? { decidedAt: raw.decidedAt } : {}),
    ...(typeof raw.note === 'string' ? { note: raw.note } : {}),
    evidenceDigest: requireString(raw.evidenceDigest, `${where}.evidenceDigest`),
  };
}

function isStatus(value: unknown): value is LedgerStatus {
  return typeof value === 'string' && STATUSES.some((status) => status === value);
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${where}: ожидалась непустая строка`);
  }
  return value;
}

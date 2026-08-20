import { z } from 'zod';
import { baseListQuery, dateOnlySchema, optionalPhoneSchema, uuidSchema } from './common';
import { optionalEmailSchema } from './email';
import { personNameFields, personNamePartialFields } from './person-name';
import { snilsSchema } from './snils';

// ── Справочник водителей (ADR 0008, ADR 0037) ──
// Отдельной таблицы водителей нет: водитель — это физлицо (`persons`) с действующей
// специализацией `driver`, трудовым отношением (оттуда табельный номер) и водительским
// удостоверением (`person_credentials` вида `driver_license`) с категориями. Карточка собирает
// все четыре сущности в одну форму: заводить человека, потом специализацию, потом документ —
// три экрана вместо одного, и на каждом можно остановиться на полпути.
//
// Отсюда же берёт правила отбор водителя под машину (ADR 0037, ADR 0055): «кто может выйти в рейс
// на этой машине в эту дату» считается по комплекту документов — сроку удостоверения, его
// аннулированию и заполненности граф, которые печатает бланк, — тем же условиям, что показывает
// карточка. Категория прав в отбор не входит: она справочная и только помечает расхождение.

// ── Статус проверки документа ──
// Проверка отделена от срока действия: непросроченный, но непроверенный документ подтверждённым
// допуском не является — а решение, пускать ли по нему в рейс, принимает не справочник.

export const CREDENTIAL_VERIFICATION_STATUSES = ['unverified', 'verified', 'rejected'] as const;
export const credentialVerificationStatusSchema = z.enum(CREDENTIAL_VERIFICATION_STATUSES);
export type CredentialVerificationStatus = (typeof CREDENTIAL_VERIFICATION_STATUSES)[number];

export const credentialVerificationStatusLabels: Record<CredentialVerificationStatus, string> = {
  unverified: 'Не проверен',
  verified: 'Проверен',
  rejected: 'Отклонён',
};

export const credentialVerificationStatusColors: Record<CredentialVerificationStatus, string> = {
  unverified: 'default',
  verified: 'green',
  rejected: 'red',
};

// ── Виды документов допуска (ADR 0008, ADR 0095) ──
// Их два: за грузовик садятся по водительскому удостоверению, за погрузчик и экскаватор — по
// удостоверению тракториста-машиниста. Разводятся они видом документа, а не буквой категории:
// «C» водительского и «C» тракториста — разные машины, и приписать одно к другому значит выдать
// человеку допуск, которого у него нет (`credential_types`, миграции 0058 и 0123).

export const CREDENTIAL_TYPE_CODES = ['driver_license', 'tractor_license'] as const;
export type CredentialTypeCode = (typeof CREDENTIAL_TYPE_CODES)[number];

export const credentialTypeLabels: Record<CredentialTypeCode, string> = {
  driver_license: 'Водительское удостоверение',
  tractor_license: 'Удостоверение тракториста-машиниста',
};

/** Как документ называют в колонке таблицы и в короткой пометке: места там на две буквы. */
export const credentialTypeShortLabels: Record<CredentialTypeCode, string> = {
  driver_license: 'ВУ',
  tractor_license: 'УТМ',
};

// ── Должность решает, каким документом человек допущен (ADR 0095) ──
//
// Должность лежит в действующем трудовом отношении (`person_employments.job_title`) и приходит из
// кадровой выгрузки. Отдельной сущности для неё не заводится: справочник должностей, который никто
// не ведёт, разошёлся бы с кадрами в первый же месяц.
//
// Сопоставление — явным списком, а не префиксом «машинист»: у машиниста автокрана в кадрах стоит
// водительское удостоверение (автокран ездит по дорогам общего пользования), а у машиниста
// погрузчика и экскаватора — тракторное. Список короткий, потому что он перечисляет должности,
// которые в кадровой выгрузке действительно есть, а не все мыслимые.

/** Нормализованная должность: регистр и лишние пробелы — оформление кадровой строки, не смысл. */
export function normalizeJobTitle(jobTitle: string): string {
  return jobTitle.trim().replace(/\s+/gu, ' ').toLowerCase();
}

/**
 * Должности, про которые известно, каким документом они допускают. Ключи — нормализованные
 * (`normalizeJobTitle`). Сервер собирает из этой же таблицы SQL-выражение: фильтр справочника
 * отбирает страницу до выдачи строк и посчитать должность в памяти не может, а двух правд о
 * должности быть не должно.
 */
export const JOB_TITLE_CREDENTIALS: Readonly<Record<string, CredentialTypeCode>> = {
  водитель: 'driver_license',
  'машинист автокрана': 'driver_license',
  'машинист погрузчика': 'tractor_license',
  'машинист экскаватора': 'tractor_license',
};

/**
 * Должности, которым колонка «категории» кадровой выгрузки означает водительское удостоверение.
 * У машиниста в той же колонке стоят категории тракторного, и коды у них те же буквы: «B, C, D, E,
 * F» самоходной машины — это не B, C и D автомобиля (ADR 0049).
 *
 * Префикс остался рядом со списком: «водитель-экспедитор» и «водитель погрузчика» в кадрах
 * встречаются, перечислить их все нельзя, а слово в начале называет документ прямо.
 */
export const DRIVER_JOB_TITLE_PREFIX = 'водител';

/**
 * Вид документа, названный должностью; `null` — должность порталу незнакома.
 *
 * Разница между `null` и умолчанием существенна, и потому функции две. Там, где спрашивают «какой
 * документ у человека смотреть» (`requiredCredentialType`), незнакомая должность безопасно
 * трактуется как водительская — так портал вёл себя всегда. Там, где решают «куда записать
 * категории из файла», незнакомая должность обязана остаться неизвестной: приписать тракторные
 * категории к ВУ значит молча выдать допуск к автобусу (ADR 0049).
 */
export function jobTitleCredentialType(jobTitle: string): CredentialTypeCode | null {
  const key = normalizeJobTitle(jobTitle);
  const known = JOB_TITLE_CREDENTIALS[key];
  if (known) return known;
  return key.startsWith(DRIVER_JOB_TITLE_PREFIX) ? 'driver_license' : null;
}

/**
 * Каким документом человек допущен: по нему считаются пробелы комплекта, он подставляется в
 * путевой лист и им же меряется соответствие требованию машины.
 *
 * Умолчание — водительское: справочник заводили под водителей, и незнакомая должность не должна
 * менять поведение молча. Такие должности видно в фильтре справочника — по нему список и пополняют.
 */
export function requiredCredentialType(jobTitle: string): CredentialTypeCode {
  return jobTitleCredentialType(jobTitle) ?? 'driver_license';
}

/** Водительская ли должность — тот же вопрос, что задаёт разбор кадровой строки (ADR 0049). */
export function isDriverJobTitle(jobTitle: string): boolean {
  return jobTitleCredentialType(jobTitle) === 'driver_license';
}

// ── DTO ──

/**
 * Категория, открытая документом. Собственные сроки сужают срок документа, но не продлевают его
 * (это держит и БД): категория, открытая до июня, к июлю закрыта, даже если само удостоверение
 * действует до 2031 года.
 */
export interface DriverLicenseCategoryDto {
  /** Категория справочника (`qualification_categories`), а не строка документа. */
  categoryId: string;
  /** Код в нижнем регистре — им сравнивают («ce»). */
  code: string;
  /** Буква, как в удостоверении («CE») — ею категория называется в интерфейсе. */
  name: string;
  validFrom: string | null;
  validTo: string | null;
  restrictions: string;
}

/**
 * Документ допуска: водительское удостоверение или удостоверение тракториста-машиниста. У человека
 * их может быть несколько — новое не стирает старое, а по должности он допущен одним из видов.
 *
 * Имя типа осталось прежним (`DriverLicenseDto`): переименовывать его во всех формах ради второго
 * вида документа значило бы поменять полсотни мест, ничего не изменив по существу — вид документа
 * несёт поле.
 */
export interface DriverLicenseDto {
  id: string;
  /** Вид документа: им и разводятся одинаковые буквы категорий (ADR 0095). */
  credentialTypeCode: CredentialTypeCode;
  series: string;
  number: string;
  issuedOn: string | null;
  expiresOn: string | null;
  issuedBy: string;
  verificationStatus: CredentialVerificationStatus;
  verifiedByName: string | null;
  verifiedAt: string | null;
  /** Аннулирование — не истечение и не удаление: документ был действующим и перестал им быть. */
  revokedAt: string | null;
  revokeReason: string;
  categories: DriverLicenseCategoryDto[];
}

export interface DriverDto {
  id: string;
  lastName: string;
  firstName: string;
  middleName: string;
  /** Считает БД из трёх частей — единственная точка правды по ФИО. */
  fullName: string;
  birthDate: string | null;
  phone: string;
  /** Пусто — адреса нет: письмо с заданием такому водителю не создаётся, он идёт в пропуски. */
  email: string;
  /** 11 цифр; «112-233-445 95» — оформление вывода (`formatSnils`). */
  snils: string;
  comment: string;
  /** Из действующего трудового отношения (`ended_on IS NULL`); пусто — отношение не заведено. */
  personnelNo: string;
  /** Должность из кадров: ею решается, каким документом человек допущен (`requiredCredentialType`). */
  jobTitle: string;
  employedSince: string | null;
  /**
   * Документы обоих видов от свежего к старому; пусто — ни одного не заведено. Списком, а не парой
   * полей: у человека бывают и ВУ, и тракторное сразу, а строка справочника показывает оба.
   */
  licenses: DriverLicenseDto[];
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

// ── Годность документа ──

/** Почему документ не годится на дату; `null` — годен. Статус проверки — отдельно, см. ниже. */
export type LicenseDefect = 'revoked' | 'rejected' | 'expired';

export const licenseDefectLabels: Record<LicenseDefect, string> = {
  revoked: 'Аннулировано',
  rejected: 'Документ отклонён при проверке',
  expired: 'Срок действия истёк',
};

/**
 * Годен ли документ на дату. Дата — параметром, а не «сегодня»: заявку берут в работу заранее, и
 * права, истекающие завтра, для послезавтрашнего рейса уже не годятся.
 *
 * `unverified` дефектом не считается: это состояние учётной процедуры, а не отсутствие прав, и
 * останавливать работу из-за неразобранной бумаги нельзя (ADR 0037). Такой документ помечают.
 */
export function licenseDefect(
  license: Pick<DriverLicenseDto, 'expiresOn' | 'revokedAt' | 'verificationStatus'>,
  on: string,
): LicenseDefect | null {
  if (license.revokedAt !== null) return 'revoked';
  if (license.verificationStatus === 'rejected') return 'rejected';
  // Пустой срок — бессрочный документ: у российского ВУ так не бывает, но вид документа это
  // допускает, и «нет срока» не то же самое, что «срок вышел».
  if (license.expiresOn !== null && license.expiresOn < on) return 'expired';
  return null;
}

/** За сколько дней до конца срока документ считается истекающим. */
export const LICENSE_EXPIRING_DAYS = 30;

/** Как документ выглядит в строке: негодность тремя её причинами, годность — сроком до конца. */
export type LicenseDisplayState =
  'valid' | 'expiring' | 'expired' | 'revoked' | 'rejected' | 'none';

/**
 * Дни между календарными сутками (`YYYY-MM-DD`) — тем же приёмом, что у гарантии
 * (`warranty.ts`): срок действия документа кончается «по такое-то число», и `Date` сдвигал бы его
 * на сутки в чужом часовом поясе. Строка, которой не бывает датой, — `null`.
 */
function licenseDaysBetween(fromIso: string, toIso: string): number | null {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

/**
 * Как показать документ на день среза: дефект старше срока, срок старше «годен».
 *
 * Вход — ровно то, что есть в строке среза: срок и уже посчитанный дефект. Полного документа у
 * портала нет и не будет — ни `revokedAt`, ни `verificationStatus` в срез дня не едут: это данные
 * карточки водителя. Первая редакция считала подсветку по одному сроку, и отклонённый документ с
 * будущим сроком получал подпись «просрочено» — неправду о том, почему им нельзя выписывать лист.
 *
 * Второго счёта срока здесь нет намеренно: вышедший срок приезжает дефектом `expired`
 * (`licenseDefect` считает его на тот же день), и сверять дату повторно значило бы завести вторую
 * правду о годности. Пустой срок без дефекта — бессрочный документ: подсветки он не заслуживает,
 * а «графа пуста» и «срок вышел» — разные вещи, и дефект их уже различил.
 */
export function licenseDisplayState(
  license: { expiresOn: string | null; defect: LicenseDefect | null },
  on: string,
): LicenseDisplayState {
  if (license.defect !== null) return license.defect;
  if (license.expiresOn === null) return 'none';
  const left = licenseDaysBetween(on, license.expiresOn);
  if (left === null) return 'none';
  return left <= LICENSE_EXPIRING_DAYS ? 'expiring' : 'valid';
}

/**
 * Открыта ли категория этим документом на дату: собственные сроки категории сужают срок документа.
 *
 * Принимает только категории, а не документ целиком: тем же правилом сервер считает соответствие
 * водителя требованию машины (`selectDrivers`), а собирать ради него полный DTO ему незачем.
 */
export function hasCategoryOn(
  license: {
    categories: readonly Pick<DriverLicenseCategoryDto, 'code' | 'validFrom' | 'validTo'>[];
  },
  code: string,
  on: string,
): boolean {
  return license.categories.some(
    (c) =>
      c.code === code &&
      (c.validFrom === null || c.validFrom <= on) &&
      (c.validTo === null || c.validTo >= on),
  );
}

/**
 * Категория с прицепом: рейс с прицепом свыше 750 кг требует E-версию той же категории
 * (ADR 0037). Прицепа в реестре техники нет, поэтому признак ставят на рейс при переводе заявки
 * в работу — а требование к водителю поднимается этой таблицей.
 */
const TRAILER_CATEGORY_BY_BASE: Record<string, string> = {
  b: 'be',
  c: 'ce',
  c1: 'c1e',
  d: 'de',
  d1: 'd1e',
};

/**
 * Какая категория нужна для рейса с прицепом. У категории, которая уже с прицепом (CE, BE), и у
 * тех, к кому прицеп неприменим (трамвай, мопед), требование не меняется: E-версии у них нет, и
 * подменять код было бы нечем.
 */
export function trailerCategoryCode(code: string): string {
  return TRAILER_CATEGORY_BY_BASE[code] ?? code;
}

/** Категории одной строкой: «B, C, CE» — как их читают в списке и в путевом листе. */
export function licenseCategoriesLabel(license: DriverLicenseDto): string {
  return license.categories.map((c) => c.name).join(', ');
}

/** «99 39 482645» — серия и номер, как напечатаны в удостоверении. */
export function licenseNumberLabel(license: Pick<DriverLicenseDto, 'series' | 'number'>): string {
  return [license.series, license.number].filter((p) => p !== '').join(' ');
}

/**
 * Реквизиты удостоверения не внесены. Так выглядят документы, заведённые загрузкой кадровой
 * выгрузки без объекта `license`: категории в ней есть, серии и номера нет.
 *
 * Номер удостоверения — обязательный реквизит бланка (приказ Минтранса № 390), и без него лист
 * печатается недействительным, поэтому в отбор водителя такой документ не даёт (ADR 0055).
 * Показывает это справочник: там пометка стоит там же, где её можно закрыть, — в карточке.
 *
 * Принимает уже склеенные серию с номером (`licenseNumberLabel`): так правило одно и для карточки
 * водителя, и для любой другой строки, где их склеил сервер.
 */
export function licenseRequisitesMissing(numberLabel: string): boolean {
  return numberLabel.trim() === '';
}

// ── Комплект документов для путевого листа ──
// Бланк печатает о водителе четыре вещи: ФИО, СНИЛС, серию с номером удостоверения и дату его
// выдачи (`issueWaybillForRoute`). ФИО есть у всякой карточки, остальное — нет: выгрузка приносит
// людей без реквизитов документа, а руками заводят и до того, как принесли бумаги. Пустая графа
// делает напечатанный лист недействительным (приказ Минтранса № 390), и обнаруживает это тот, кто
// взял бумагу в руки, — поэтому справочник обязан уметь показать, кого ещё дозаполнить.
//
// Этим же комплектом сужается отбор водителя под машину (ADR 0055): он единственное, без чего
// рейс не состоится, — и потому единственное, что вправе кого-то из отбора убрать.

/** Чего не хватает водителю для путевого листа. */
export type DriverDocumentGap = 'snils' | 'license' | 'requisites' | 'issuedOn';

/**
 * Как пробел называется в карточке. Документ назван коротко («ВУ», «УТМ»), а не общим словом
 * «удостоверение»: человек, который пришёл дозаполнять карточки, должен видеть, какую бумагу
 * спрашивать, — у машиниста погрузчика это не то же самое, что у водителя (ADR 0095).
 */
export function driverDocumentGapLabel(gap: DriverDocumentGap, type: CredentialTypeCode): string {
  const doc = credentialTypeShortLabels[type];
  switch (gap) {
    case 'snils':
      return 'СНИЛС не внесён';
    case 'license':
      return `Действующего ${doc} нет`;
    case 'requisites':
      return `Серия и номер ${doc} не внесены`;
    case 'issuedOn':
      return `Дата выдачи ${doc} не внесена`;
  }
}

/**
 * Документ в том объёме, в каком его спрашивает путевой лист: вид, годность на дату и графы,
 * которые бланк печатает. Структурным типом, а не `DriverLicenseDto`: те же вопросы задаёт сервер
 * строкам своего запроса (`selectDrivers`), и собирать ради них полный DTO ему незачем.
 */
export type WaybillLicense = Pick<
  DriverLicenseDto,
  | 'credentialTypeCode'
  | 'series'
  | 'number'
  | 'issuedOn'
  | 'expiresOn'
  | 'revokedAt'
  | 'verificationStatus'
>;

/**
 * Пробелы одного документа. Срок действия сюда не входит: пустой срок — бессрочный документ
 * (`licenseDefect`), а не незаполненная графа, и в путевом листе его не печатают.
 */
function licenseGaps(license: WaybillLicense): DriverDocumentGap[] {
  const gaps: DriverDocumentGap[] = [];
  if (licenseRequisitesMissing(licenseNumberLabel(license))) gaps.push('requisites');
  if (license.issuedOn === null) gaps.push('issuedOn');
  return gaps;
}

/**
 * По какому документу выпишется лист: годному на эту дату, а из нескольких годных — самому
 * заполненному. Аннулированное, отклонённое или просроченное удостоверение листа не даёт, сколько
 * граф в нём ни заполни; `null` — годного нет ни одного.
 *
 * Отдельной функцией, потому что ответ нужен дважды и обязан быть одним: по нему считаются пробелы
 * (`driverDocumentGaps`) и по нему же сервер берёт серию, номер и дату выдачи в снимок листа. Две
 * копии этого выбора означали бы лист, выписанный по одному документу, а предупреждение — по другому.
 */
export function waybillLicenseOf<T extends WaybillLicense>(
  licenses: readonly T[],
  on: string,
): T | null {
  const valid = licenses.filter((l) => licenseDefect(l, on) === null);
  if (valid.length === 0) return null;
  return valid.reduce((best, l) => (licenseGaps(l).length < licenseGaps(best).length ? l : best));
}

/**
 * Документ, которым человек допущен по своей должности, — и только он: у водителя лист выпишется
 * по водительскому, у машиниста экскаватора по тракторному, даже если рядом лежит второе (ADR 0095).
 *
 * Чужой вид не подставляется никогда, в том числе когда своего нет вовсе: напечатанный в графе
 * «водительское удостоверение» номер тракторного делает лист недействительным ровно так же, как
 * пустая графа, — но пустую графу видно, а чужой номер выглядит заполненным.
 */
export function waybillDocumentOf<T extends WaybillLicense>(
  licenses: readonly T[],
  jobTitle: string,
  on: string,
): T | null {
  const type = requiredCredentialType(jobTitle);
  return waybillLicenseOf(
    licenses.filter((l) => l.credentialTypeCode === type),
    on,
  );
}

/**
 * Порядок негодных документов для показа: свежий впереди. Сравнение полное — четырьмя ключами,
 * последний из которых разрешает любую ничью.
 *
 * `expiresOn` пустой считается самым поздним: бессрочный документ с дефектом (аннулированный,
 * отклонённый) — самый свежий из негодных, а не самый старый. У `issuedOn` пустота значит обратное
 * — дата выдачи пустой не бывает у заполненного документа, и такой строке место в хвосте.
 *
 * Четвёртый ключ, `id`, не педантизм: без него побеждал бы первый элемент входного массива, а его
 * порядок задаёт запрос (`loadDriverLicenses` сортирует по `issuedOn` и `createdAt`), — и строка
 * среза меняла бы документ от правки, к ней отношения не имеющей.
 */
function compareDisplayLicenses(
  a: WaybillLicense & { id: string },
  b: WaybillLicense & { id: string },
): number {
  if (a.expiresOn !== b.expiresOn) {
    if (a.expiresOn === null) return -1;
    if (b.expiresOn === null) return 1;
    return a.expiresOn > b.expiresOn ? -1 : 1;
  }
  if (a.issuedOn !== b.issuedOn) {
    if (a.issuedOn === null) return 1;
    if (b.issuedOn === null) return -1;
    return a.issuedOn > b.issuedOn ? -1 : 1;
  }
  const gaps = licenseGaps(a).length - licenseGaps(b).length;
  if (gaps !== 0) return gaps;
  return a.id < b.id ? -1 : 1;
}

/**
 * Документ, который срез **показывает**: годный на день, а если годного нет — самый свежий из
 * негодных того же вида. От `waybillDocumentOf` отличается только этим хвостом: тот отвечает на
 * «чем выписывать лист» и негодного не возвращает никогда.
 *
 * Разница нужна показу, а не правилу: без запасного документа просроченный срок в строке не
 * появился бы никогда — она молчала бы о человеке ровно там, где обязана предупредить. Правило
 * выписки при этом не двигается ни на строку: пробелы (`driverDocumentGaps`) и снимок бланка
 * по-прежнему считаются по годному документу.
 *
 * Живёт рядом с `waybillDocumentOf`, а не в маршруте гаража: третий ключ порядка — `licenseGaps`,
 * функция приватная, и копия сравнения в маршруте разошлась бы с оригиналом на первой же правке
 * пробелов.
 */
export function displayDocumentOf<T extends WaybillLicense & { id: string }>(
  licenses: readonly T[],
  jobTitle: string,
  on: string,
): T | null {
  const valid = waybillDocumentOf(licenses, jobTitle, on);
  if (valid) return valid;

  // Вид документа задаёт должность (ADR 0095), и запасной берётся только своего вида: чужой номер
  // в строке выглядел бы допуском, которого у человека нет, — ровно то, от чего отказывается
  // `waybillDocumentOf`.
  const type = requiredCredentialType(jobTitle);
  const own = licenses.filter((l) => l.credentialTypeCode === type);
  if (own.length === 0) return null;
  return own.reduce((best, l) => (compareDisplayLicenses(l, best) < 0 ? l : best));
}

/** Кого спрашивают о пробелах: человек с должностью, СНИЛСом и своими документами. */
export interface DriverDocumentSubject {
  snils: string;
  /** Должность из кадров: ею выбран вид документа (`requiredCredentialType`). */
  jobTitle: string;
  licenses: readonly WaybillLicense[];
}

/**
 * Чего не хватает водителю для путевого листа на дату; пустой список — комплект полный.
 *
 * Считается по документу, которым лист выпишется (`waybillDocumentOf`): указывать на пробелы
 * старого удостоверения, когда рядом лежит полное, незачем, — и по документу того вида, которым
 * человек допущен, а не по любому имеющемуся.
 *
 * То же правило повторено запросом — фильтром списка водителей (`documents` в
 * `driverListQuerySchema`, `licenseCompleteConditions` на сервере): страницу отбирает сервер,
 * считать полноту в памяти он не может — но набор условий обязан совпадать, иначе фильтр покажет
 * одно, а строка в нём скажет другое.
 */
export function driverDocumentGaps(driver: DriverDocumentSubject, on: string): DriverDocumentGap[] {
  const gaps: DriverDocumentGap[] = [];
  if (driver.snils.trim() === '') gaps.push('snils');

  const license = waybillDocumentOf(driver.licenses, driver.jobTitle, on);
  if (!license) return [...gaps, 'license'];
  return [...gaps, ...licenseGaps(license)];
}

/** Полный ли комплект — тот же вопрос, что задаёт фильтр справочника. */
export function driverDocumentsComplete(driver: DriverDocumentSubject, on: string): boolean {
  return driverDocumentGaps(driver, on).length === 0;
}

// ── Ввод ──

const seriesSchema = z.string().trim().max(20);
const numberSchema = z.string().trim().min(1, 'Номер обязателен').max(20);
const issuedBySchema = z.string().trim().max(255);
const personnelNoSchema = z.string().trim().max(50);
const jobTitleSchema = z.string().trim().max(255);
// Телефон водителя — общей схемой (ADR 0066): своя, принимавшая любой текст, разошлась бы с
// правилом остальных полей, а номер здесь тот же — по нему звонят перед рейсом.
const phoneSchema = optionalPhoneSchema;
// Адрес водителя — общей схемой, как и телефон: по нему уходит задание на рейс, и правило проверки
// у него то же, что у адреса учётной записи. Уникальности нет намеренно: бригада может читать почту
// с одного рабочего ящика, и запрет на повтор развалил бы такой справочник.
const emailFieldSchema = optionalEmailSchema;
const commentSchema = z.string().trim().max(2000);

/** Категория документа: ссылка на справочник плюс собственные сроки, если они у неё свои. */
export const driverLicenseCategoryInputSchema = z
  .object({
    categoryId: uuidSchema,
    validFrom: dateOnlySchema.nullable().optional(),
    validTo: dateOnlySchema.nullable().optional(),
    restrictions: z.string().trim().max(500).optional().default(''),
  })
  .strict()
  .refine((c) => !c.validFrom || !c.validTo || c.validTo >= c.validFrom, {
    message: 'Категория не может истечь раньше, чем открыта',
    path: ['validTo'],
  });

/**
 * Документ целиком.
 *
 * У водительского удостоверения хотя бы одна категория обязательна: документ без категорий не
 * открывает ничего, и водителя по нему не отобрать ни под одну машину. У тракторного — нет: в
 * кадровой выгрузке его категорий не бывает вовсе, а печатному листу нужны номер и дата выдачи, и
 * требовать букву, которой нет в присланных данных, значило бы не дать завести документ совсем.
 */
export const driverLicenseInputSchema = z
  .object({
    credentialType: z.enum(CREDENTIAL_TYPE_CODES).optional().default('driver_license'),
    series: seriesSchema.optional().default(''),
    number: numberSchema,
    issuedOn: dateOnlySchema.nullable().optional(),
    expiresOn: dateOnlySchema.nullable().optional(),
    issuedBy: issuedBySchema.optional().default(''),
    categories: z.array(driverLicenseCategoryInputSchema).max(16),
    /**
     * Снять прежние документы этого вида вместе с заведением нового.
     *
     * Умолчание — не снимать: замена копит историю, и по какому листу человек ездил в прошлом
     * году, видно только из старой записи. Но серию и номер держит она же
     * (`person_credentials_number_unique`), и переоформление с тем же номером — как и правка
     * ошибочно заведённого документа — иначе упирается в занятый номер.
     *
     * При заведении водителя поле бессмысленно, но и не мешает: снимать у новой карточки нечего.
     */
    deletePrevious: z.boolean().optional().default(false),
  })
  .strict()
  .refine((l) => l.credentialType !== 'driver_license' || l.categories.length > 0, {
    message: 'Укажите хотя бы одну категорию',
    path: ['categories'],
  })
  .refine((l) => !l.issuedOn || !l.expiresOn || l.expiresOn >= l.issuedOn, {
    message: 'Срок действия не может истечь раньше выдачи',
    path: ['expiresOn'],
  })
  .refine(
    (l) => new Set(l.categories.map((c) => c.categoryId)).size === l.categories.length,
    'Категория указана дважды',
  );
export type DriverLicenseInput = z.infer<typeof driverLicenseInputSchema>;
/**
 * То же удостоверение со стороны клиента: поля с умолчаниями (`series`, `restrictions`) он вправе
 * не присылать — их подставит схема. Тип вывода потребовал бы их заполнения, и форма собирала бы
 * то, чего сервер не спрашивает.
 */
export type DriverLicenseBody = z.input<typeof driverLicenseInputSchema>;

/**
 * Занятый номер — обычный ввод, а не поломка: серию и номер держит частичный уникальный индекс
 * `person_credentials_number_unique`, и отказ БД без перевода превращался бы во «внутреннюю ошибку
 * сервера». Текст один на форму и сервер: человек видит одно и то же до и после отправки.
 *
 * Свой документ и чужой разведены намеренно: в первом случае человеку править нечего — прежний
 * документ снимается галочкой замены, во втором номер и правда занят другой карточкой.
 */
export function licenseNumberTakenMessage(sameDriver: boolean): string {
  return sameDriver
    ? 'Такой документ у водителя уже заведён — снимите прежний галочкой замены или проверьте номер'
    : 'Документ с такой серией и номером заведён у другого работника';
}

/** Гонка двух одинаковых номеров: править нечего, но и молчать нельзя. */
export const LICENSE_NUMBER_RACE_MESSAGE =
  'Этот номер только что заняли — обновите страницу и повторите';

/**
 * Заведение водителя. СНИЛС обязателен: без него не выписать путевой лист (ADR 0037), а карточка
 * водителя заводится ровно ради него. Удостоверение — нет: человека заносят в справочник и до
 * того, как принесли документы, и такой водитель просто не попадёт в отбор.
 */
export const createDriverSchema = z
  .object({
    ...personNameFields,
    snils: snilsSchema,
    birthDate: dateOnlySchema.nullable().optional(),
    phone: phoneSchema.optional().default(''),
    email: emailFieldSchema.optional().default(''),
    comment: commentSchema.optional().default(''),
    personnelNo: personnelNoSchema.optional().default(''),
    jobTitle: jobTitleSchema.optional().default('Водитель'),
    employedSince: dateOnlySchema.nullable().optional(),
    license: driverLicenseInputSchema.optional(),
  })
  .strict();
export type CreateDriverInput = z.infer<typeof createDriverSchema>;
export type CreateDriverBody = z.input<typeof createDriverSchema>;

/**
 * Отметка проверки документа. Учётное действие, а не правка реквизитов: проверенное
 * удостоверение отличается от непроверенного не содержимым, а тем, что его кто-то сверил с
 * оригиналом — поэтому и операция своя.
 */
export const verifyDriverLicenseSchema = z
  .object({
    verificationStatus: credentialVerificationStatusSchema,
    verificationComment: z.string().trim().max(2000).optional().default(''),
  })
  .strict();
export type VerifyDriverLicenseInput = z.infer<typeof verifyDriverLicenseSchema>;
export type VerifyDriverLicenseBody = z.input<typeof verifyDriverLicenseSchema>;

/**
 * Аннулирование: документ был действующим и перестал им быть — это не истечение срока и не
 * удаление записи. Причина обязательна: по ней потом объясняют, почему водитель выпал из отбора.
 */
export const revokeDriverLicenseSchema = z
  .object({
    revokeReason: z.string().trim().min(1, 'Укажите причину').max(2000),
  })
  .strict();
export type RevokeDriverLicenseInput = z.infer<typeof revokeDriverLicenseSchema>;

/** Правка карточки. Документы правятся своими операциями: у них своя история и своя проверка. */
export const updateDriverSchema = z
  .object({
    ...personNamePartialFields,
    snils: snilsSchema.optional(),
    birthDate: dateOnlySchema.nullable().optional(),
    phone: phoneSchema.optional(),
    email: emailFieldSchema.optional(),
    comment: commentSchema.optional(),
    personnelNo: personnelNoSchema.optional(),
    jobTitle: jobTitleSchema.optional(),
    employedSince: dateOnlySchema.nullable().optional(),
    version: z.number().int().nonnegative(),
  })
  .strict();
export type UpdateDriverInput = z.infer<typeof updateDriverSchema>;

// ── Отбор водителя под машину (ADR 0037, ADR 0055, ADR 0064) ──
//
// Отбора больше нет: список показывает весь справочник водителей (ADR 0064). Ни категория прав, ни
// полнота документов из него никого не убирают — они стали двумя ключами его порядка и двумя
// поводами предупредить.
//
// До ADR 0064 список сужал комплект документов: путевой лист с пустой графой недействителен, и
// водителя без СНИЛСа или без номера удостоверения предлагать было незачем. Оказалось, что незачем
// предлагать — не то же самое, что нельзя показать: половина справочника заведена кадровой
// выгрузкой без реквизитов ВУ (ADR 0047), человек за рулём при этом ездит, а диспетчер видел
// пустой список и шёл заводить рейс мимо портала. Пустая графа осталась дефектом бумаги —
// но узнают о ней теперь до печати, из предупреждения, а не после, взяв бланк в руки.
//
// Категория машине проставлена скопом по типу техники (миграция `0059`), поэлементно её с ПТС никто
// не сверял, и запрещать ею работу — значит прятать от диспетчера водителя, который к машине
// допущен. Она справочная с ADR 0055: расхождение видно пометкой и предупреждением, решает человек.

/**
 * Водитель в списке выбора при переводе заявки в работу. СНИЛС сюда не попадает намеренно: он
 * нужен бланку, а не выбору, и собирает его сервер. Персональные данные не выносятся на экран,
 * которым пользуется каждый, кто берёт заявки в работу, — карточка водителя закрыта своим правом.
 */
export interface DriverOptionDto {
  personId: string;
  fullName: string;
  personnelNo: string;
  /**
   * Каким документом человек допущен по должности (`requiredCredentialType`). Им подписаны и
   * пробелы, и расхождение с требованием машины: «без номера ВУ» и «без номера УТМ» — разные
   * бумаги, и нести их в кабину будут разные люди.
   */
  credentialTypeCode: CredentialTypeCode;
  /** «00 00 000001» — серия и номер, как напечатаны в удостоверении; пусто — не внесены. */
  licenseNumber: string;
  licenseExpiresOn: string | null;
  /**
   * `unverified` — водитель в списке, но с пометкой: проверка бумаги не отменяет допуска.
   * `null` — годного на дату удостоверения нет вовсе, и проверять нечего (ADR 0064).
   */
  verificationStatus: CredentialVerificationStatus | null;
  /**
   * Чего не хватает для путевого листа на дату рейса (`driverDocumentGaps`); пусто — комплект
   * полный. Никого не убирает из списка (ADR 0064): по нему считается порядок и складывается
   * предупреждение о графах, которые останутся в бланке пустыми.
   */
  gaps: DriverDocumentGap[];
  categories: string[];
  /**
   * Открыта ли у водителя категория, которую требует машина, на дату рейса. `true` и тогда, когда
   * требование у машины не заведено: расхождению взяться неоткуда. Ничего не запрещает — по нему
   * ставится пометка в строке и предупреждение после выбора (ADR 0055).
   */
  matchesRequiredCategory: boolean;
  /**
   * Рейсов этой машины с этим водителем за последний год — тех, что состоялись
   * (`driverWorkedOnVehicle`). `0` — не работал либо работал раньше окна.
   */
  workedRoutes: number;
  /** День последнего такого рейса; `null` — не работал. Им же список ставится по свежести. */
  lastWorkedOn: string | null;
}

// ── Категория прав как справочная информация (ADR 0055) ──

/** Короткая пометка в строке выбора — рядом с «работал на этой машине». */
export const DRIVER_CATEGORY_MISMATCH_HINT = 'категория не подходит';

/**
 * Развёрнутое предупреждение там, где водителя выбирают: пометки в строке мало — её читают при
 * выборе и забывают. Названы обе стороны — что требует машина и что открыто у водителя: решение
 * остаётся за человеком, и ему нужны оба набора, а не факт «не совпало» (как у техники —
 * `vehicleSubstitutionWarning`).
 *
 * Вид документа назван у каждой стороны (ADR 0095): «C» водительского и «C» тракториста — разные
 * машины, и предупреждение «нужна C, а открыта C» читалось бы как ошибка портала.
 */
export function driverCategoryMismatchWarning(
  required: string,
  requiredType: CredentialTypeCode,
  categories: string[],
  documentType: CredentialTypeCode,
): string {
  const need = `${credentialTypeShortLabels[requiredType]} «${required}»`;
  const open =
    categories.length > 0
      ? `по ${credentialTypeShortLabels[documentType]} открыты «${categories.join(', ')}»`
      : `по ${credentialTypeShortLabels[documentType]} не открыто ни одной категории`;
  return (
    `Машине нужна категория ${need}, а у водителя ${open}. ` +
    'Рейс заведётся как есть — проверьте по удостоверению, что водитель к этой машине допущен.'
  );
}

// ── Полнота документов как справочная информация (ADR 0064) ──

/**
 * Короткая пометка в строке выбора — рядом с «категория не подходит». Формулировка «без чего»
 * (а не «чего нет»): в строке она стоит после ФИО и категорий, и «Иванов · C, CE · без номера ВУ»
 * читается одним куском, а «Иванов · C, CE · номер ВУ не внесён» — двумя.
 */
export function driverDocumentGapHint(gap: DriverDocumentGap, type: CredentialTypeCode): string {
  const doc = credentialTypeShortLabels[type];
  switch (gap) {
    case 'snils':
      return 'без СНИЛС';
    case 'license':
      return `без действующего ${doc}`;
    case 'requisites':
      return `без номера ${doc}`;
    case 'issuedOn':
      return `без даты выдачи ${doc}`;
  }
}

/** Пробелы одной строкой для строки списка: «без номера ВУ, без даты выдачи ВУ». */
export function driverDocumentGapsHint(
  gaps: readonly DriverDocumentGap[],
  type: CredentialTypeCode,
): string | null {
  return gaps.length > 0 ? gaps.map((g) => driverDocumentGapHint(g, type)).join(', ') : null;
}

/**
 * Развёрнутое предупреждение там, где водителя выбирают и где по нему печатают бумагу.
 *
 * Говорит о последствии, а не о состоянии справочника: незаполненная графа — это не «карточка
 * неполная», это лист, который водитель повезёт недействительным (приказ Минтранса № 390). Бланк
 * называется, если он уже известен: у формы № 3 и у 4-П графы разные, и «в путевом листе 4-П»
 * отвечает на «а меня это касается?» без похода в другой раздел.
 *
 * Текст один на все три места — выбор водителя в переводе заявки в работу, карточка рейса и
 * подтверждение выписки листа (ADR 0064): расходиться формулировкам негде.
 */
export function driverDocumentGapsWarning(
  gaps: readonly DriverDocumentGap[],
  type: CredentialTypeCode,
  formLabel: string | null,
): string | null {
  const what = driverDocumentGapsHint(gaps, type);
  if (!what) return null;
  const where = formLabel ? `в путевом листе ${formLabel}` : 'в путевом листе';
  return (
    `Водитель ${what}: ${where} эти графы останутся пустыми, а бланк с пустой графой ` +
    'недействителен. Недостающее вносит администратор в справочнике водителей.'
  );
}

/**
 * Насколько водитель подходит: 0 — комплект полный и категория та, 1 — комплект полный, категория
 * чужая, 2 — категория та, но документов не хватает, 3 — ни того, ни другого.
 *
 * Порядок ключей отвечает на «кого сажать»: документы стоят выше категории, потому что пустая
 * графа бланка — дефект бумаги, который обнаружится в тот же день, а расхождение с категорией
 * заведено оптом миграцией `0059` и часто существует только в справочнике (ADR 0055).
 */
export function driverRelevanceRank(
  d: Pick<DriverOptionDto, 'gaps' | 'matchesRequiredCategory'>,
): number {
  return (d.gaps.length > 0 ? 2 : 0) + (d.matchesRequiredCategory ? 0 : 1);
}

// ── Опыт водителя на конкретной машине (ADR 0056) ──

/**
 * Глубина, на которую считается опыт. Год — не круглое число ради круглого: за него меняется и
 * парк, и люди, и «возил эту машину позапрошлым летом» не то знание, ради которого водителя
 * поднимают наверх списка.
 */
export const DRIVER_EXPERIENCE_MONTHS = 12;

/** Короткая пометка в строке списка — рядом с «документ не проверен». */
export const DRIVER_WORKED_ON_VEHICLE_HINT = 'работал на этой машине';

/** Работал ли водитель на этой машине: пометку ставит она, и порядок списка считается по ней же. */
export function driverWorkedOnVehicle(d: Pick<DriverOptionDto, 'lastWorkedOn'>): boolean {
  return d.lastWorkedOn !== null;
}

/**
 * Порядок списка выбора: сначала пригодные (`driverRelevanceRank` — комплект документов, затем
 * категория), внутри них — работавшие на этой машине по свежести последнего рейса, остальные по
 * алфавиту, как список стоял до появления опыта.
 *
 * Алфавит наверху отвечал на вопрос «как найти человека, которого я уже выбрал в голове», а
 * диспетчер решает обратную задачу — кого посадить. Тот, кто эту машину уже возил, знает её
 * повадки, и искать его среди двух десятков однофамильцев по алфавиту незачем. Опыт при этом
 * ничего не запрещает и никого не прячет: список тот же, изменился только порядок, поэтому
 * пометка в строке обязательна — иначе непонятно, почему человек оказался первым.
 *
 * Пригодность стоит выше опыта по логике порядка, а не запрета (ADR 0055, ADR 0064): водитель с
 * полным комплектом и нужной категорией — обычный выбор, всякий другой — исключение, которое
 * диспетчер принимает осознанно, и держать его вперемешку значило бы предлагать исключение первым.
 */
export function compareDriverOptions(
  a: Pick<DriverOptionDto, 'fullName' | 'lastWorkedOn' | 'matchesRequiredCategory' | 'gaps'>,
  b: Pick<DriverOptionDto, 'fullName' | 'lastWorkedOn' | 'matchesRequiredCategory' | 'gaps'>,
): number {
  const rank = driverRelevanceRank(a) - driverRelevanceRank(b);
  if (rank !== 0) return rank;
  if (a.lastWorkedOn !== b.lastWorkedOn) {
    // Не работал — вниз, независимо от имени: пустой опыт сравнивать с датой нечем.
    if (a.lastWorkedOn === null) return 1;
    if (b.lastWorkedOn === null) return -1;
    // Даты в ISO-формате: лексикографическое сравнение и есть хронологическое.
    return b.lastWorkedOn.localeCompare(a.lastWorkedOn);
  }
  return a.fullName.localeCompare(b.fullName, 'ru');
}

export interface DriverSelectionDto {
  /**
   * Категория, которой требует машина («C», «CE» при рейсе с прицепом). Список ею не сужен
   * (ADR 0055) — ею названа одна сторона расхождения в предупреждении. `null` — требование у
   * машины не заведено, и расхождению взяться неоткуда: пустое требование безопаснее неверного.
   */
  requiredCategory: string | null;
  /**
   * Какого документа эта категория (ADR 0095): требование машины ссылается на категорию любого
   * вида, и без вида «нужна C» ничего не значит. `null` — требования нет.
   */
  requiredCategoryType: CredentialTypeCode | null;
  /**
   * Весь справочник водителей в порядке пригодности (ADR 0064). Пустой список означает ровно одно:
   * действующих водителей нет вовсе — интерфейсу больше не нужно объяснять, кого именно отсеял
   * отбор, потому что отбора нет.
   */
  drivers: DriverOptionDto[];
}

export const driverSelectionQuerySchema = z.object({
  vehicleId: uuidSchema,
  /** Дата рейса: заявку берут в работу заранее, и годность считается на неё, а не на сегодня. */
  on: dateOnlySchema,
  withTrailer: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
export type DriverSelectionQuery = z.infer<typeof driverSelectionQuerySchema>;

// ── Список ──

export const DRIVER_SORT_FIELDS = [
  'fullName',
  'snils',
  'personnelNo',
  'createdAt',
  'updatedAt',
] as const;

/**
 * Комплект документов для путевого листа — по нему справочник и делится надвое (`driverDocumentGaps`).
 * Значений два, а не флажок «только неполные»: вопросов к списку тоже два — «кого дозаполнить» и
 * «кем закрывать рейсы прямо сейчас», и второй задают не реже первого.
 */
export const DRIVER_DOCUMENT_SETS = ['complete', 'incomplete'] as const;
export const driverDocumentSetSchema = z.enum(DRIVER_DOCUMENT_SETS);
export type DriverDocumentSet = (typeof DRIVER_DOCUMENT_SETS)[number];

export const driverDocumentSetLabels: Record<DriverDocumentSet, string> = {
  complete: 'Полный комплект',
  incomplete: 'Неполный комплект',
};

/**
 * Должность в фильтре справочника (ADR 0095). Приходит из кадров текстом, поэтому и фильтруется
 * текстом — сравнением нормализованных значений (`normalizeJobTitle`), а не идентификатором:
 * справочника должностей нет, и заводить его ради выпадающего списка не стали.
 */
export interface DriverJobTitleDto {
  /** Как должность записана в кадрах — ею же и фильтруют. */
  jobTitle: string;
  /** Каким документом эта должность допускает: по нему справочник прячет чужие колонки. */
  credentialTypeCode: CredentialTypeCode;
  /** Сколько человек с такой должностью — по нему видно опечатку кадровой выгрузки. */
  count: number;
}

export const driverListQuerySchema = baseListQuery(DRIVER_SORT_FIELDS).extend({
  documents: driverDocumentSetSchema.optional(),
  /**
   * Должность целиком, как её отдал `GET /drivers/job-titles`. Сравнение нормализованное: «Машинист
   *  экскаватора» с двумя пробелами и «машинист экскаватора» — одна должность, а не две.
   */
  jobTitle: z.string().trim().max(255).optional(),
  /**
   * Кто открыл эту категорию — справочный вопрос, а не отбор под машину (ADR 0055): «кого можно
   * посадить за седельный тягач» спрашивают у справочника, а не у формы назначения. Считается на
   * сегодня по годному документу — тем же правилом, что показывает карточка (`hasCategoryOn`).
   */
  categoryId: uuidSchema.optional(),
  includeDeleted: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
export type DriverListQuery = z.infer<typeof driverListQuerySchema>;

// ── Кадровая строка: как её читает портал (ADR 0047, формат — ADR 0073) ──
//
// Схем самого файла здесь больше нет: справочник водителей грузится тем же `.xlsx`, что и
// остальные справочники, и форму файла проверяет обмен (`services/directory-transfer`). Осталось
// то, что описывает не файл, а предметную область: какие коды бывают только у водительского
// удостоверения. Правило «должность называет документ» стоит выше — им пользуется не только
// загрузка, но и весь справочник (`jobTitleCredentialType`).

/**
 * Коды, которые бывают только у водительского удостоверения: подкатегории (B1, C1, D1), составы
 * с прицепом (BE, CE, C1E, DE, D1E), мотоциклы, мопеды, трамвай и троллейбус. У удостоверения
 * тракториста-машиниста таких нет — его категории это одиночные буквы.
 *
 * По ним у машиниста и распознаётся настоящее ВУ: в кадровой выгрузке колонка одна, и у половины
 * машинистов крана в ней стоят именно водительские категории. Признаком служит только сам набор,
 * и только когда в нём нет ни одного незнакомого справочнику кода: у тракторного удостоверения
 * нового образца есть и «B1», и «D1», но рядом с ними стоят «B2», «E1», «G1», которых у ВУ нет.
 */
export const DRIVER_ONLY_CATEGORY_CODES = [
  'a',
  'a1',
  'b1',
  'c1',
  'd1',
  'be',
  'ce',
  'c1e',
  'de',
  'd1e',
  'm',
  'tm',
  'tb',
] as const;

export function looksLikeDriverLicense(codes: readonly string[]): boolean {
  const markers = new Set<string>(DRIVER_ONLY_CATEGORY_CODES);
  return codes.some((c) => markers.has(c));
}

/**
 * Что получилось. Отчёт перечисляет людей поимённо, а не числами: тот, кто грузит файл, обязан
 * увидеть, кого именно заводит, — сверять он будет с бумажной выгрузкой в руках.
 */
export interface DriversImportReportDto {
  /** Повтор запроса без `dryRun` заведёт ровно то же — если файл и справочник не изменились. */
  dryRun: boolean;
  /** ФИО заведённых (при `dryRun` — тех, кто будет заведён). */
  created: string[];
  /** Уже есть в справочнике: совпал СНИЛС — ключ человека (ADR 0037). */
  skipped: string[];
  /**
   * Кому выгрузка проставила или сменила email. Единственное, что импорт правит у заведённого
   * человека: адреса в справочнике появились позже самих водителей, и заносить их в сотню карточек
   * руками — работа, ради которой выгрузка и существует. Остальные поля заведённого не трогаются:
   * повторная загрузка не должна переписывать то, что уточняли в портале.
   */
  emailUpdated: { who: string; email: string }[];
  /** Заведён без удостоверения: в отбор под машину такой водитель не попадёт. */
  withoutLicense: { who: string; why: string }[];
  /** Коды, которых нет в справочнике категорий: их вносит администратор по оригиналу. */
  unknownCategories: { who: string; codes: string[] }[];
  /** Однофамилец среди заведённых раньше с другим СНИЛС — повод проверить, не один ли человек. */
  nameCollisions: { who: string; existing: string }[];
}

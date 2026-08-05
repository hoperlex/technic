import { z } from 'zod';
import { baseListQuery, dateOnlySchema, optionalPhoneSchema, uuidSchema } from './common';
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

/** Водительское удостоверение. У человека их может быть несколько: новое не стирает старое. */
export interface DriverLicenseDto {
  id: string;
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
  /** 11 цифр; «112-233-445 95» — оформление вывода (`formatSnils`). */
  snils: string;
  comment: string;
  /** Из действующего трудового отношения (`ended_on IS NULL`); пусто — отношение не заведено. */
  personnelNo: string;
  jobTitle: string;
  employedSince: string | null;
  /** Удостоверения от свежего к старому; пусто — документ ещё не заведён. */
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
 * Реквизиты удостоверения не внесены. Так выглядят документы, заведённые первичным наполнением
 * справочника из кадровой выгрузки (`seed:drivers`): категории в ней есть, серии и номера нет.
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

export const driverDocumentGapLabels: Record<DriverDocumentGap, string> = {
  snils: 'СНИЛС не внесён',
  license: 'Действующего удостоверения нет',
  requisites: 'Серия и номер не внесены',
  issuedOn: 'Дата выдачи не внесена',
};

/**
 * Документ в том объёме, в каком его спрашивает путевой лист: годность на дату и графы, которые
 * бланк печатает. Структурным типом, а не `DriverLicenseDto`: те же вопросы задаёт сервер строкам
 * своего запроса (`selectDrivers`), и собирать ради них полный DTO ему незачем.
 */
export type WaybillLicense = Pick<
  DriverLicenseDto,
  'series' | 'number' | 'issuedOn' | 'expiresOn' | 'revokedAt' | 'verificationStatus'
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
 * Чего не хватает водителю для путевого листа на дату; пустой список — комплект полный.
 *
 * Считается по документу, которым лист выпишется (`waybillLicenseOf`): указывать на пробелы
 * старого удостоверения, когда рядом лежит полное, незачем.
 *
 * То же правило повторено запросом — фильтром списка водителей (`documents` в
 * `driverListQuerySchema`, `licenseCompleteConditions` на сервере): страницу отбирает сервер,
 * считать полноту в памяти он не может — но набор условий обязан совпадать, иначе фильтр покажет
 * одно, а строка в нём скажет другое.
 */
export function driverDocumentGaps(
  driver: { snils: string; licenses: readonly WaybillLicense[] },
  on: string,
): DriverDocumentGap[] {
  const gaps: DriverDocumentGap[] = [];
  if (driver.snils.trim() === '') gaps.push('snils');

  const license = waybillLicenseOf(driver.licenses, on);
  if (!license) return [...gaps, 'license'];
  return [...gaps, ...licenseGaps(license)];
}

/** Полный ли комплект — тот же вопрос, что задаёт фильтр справочника. */
export function driverDocumentsComplete(
  driver: { snils: string; licenses: readonly WaybillLicense[] },
  on: string,
): boolean {
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
 * Удостоверение целиком. Хотя бы одна категория обязательна: документ без категорий не открывает
 * ничего, и водителя по нему не отобрать ни под одну машину.
 */
export const driverLicenseInputSchema = z
  .object({
    series: seriesSchema.optional().default(''),
    number: numberSchema,
    issuedOn: dateOnlySchema.nullable().optional(),
    expiresOn: dateOnlySchema.nullable().optional(),
    issuedBy: issuedBySchema.optional().default(''),
    categories: z
      .array(driverLicenseCategoryInputSchema)
      .min(1, 'Укажите хотя бы одну категорию')
      .max(16),
  })
  .strict()
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
 */
export function driverCategoryMismatchWarning(required: string, categories: string[]): string {
  const open = categories.length > 0 ? `«${categories.join(', ')}»` : 'ни одной категории';
  return (
    `Машине нужна категория «${required}», а у водителя открыты ${open}. ` +
    'Рейс заведётся как есть — проверьте по удостоверению, что водитель к этой машине допущен.'
  );
}

// ── Полнота документов как справочная информация (ADR 0064) ──

/**
 * Короткая пометка в строке выбора — рядом с «категория не подходит». Формулировка «без чего»
 * (а не «чего нет»): в строке она стоит после ФИО и категорий, и «Иванов · C, CE · без номера ВУ»
 * читается одним куском, а «Иванов · C, CE · номер ВУ не внесён» — двумя.
 */
export const driverDocumentGapHints: Record<DriverDocumentGap, string> = {
  snils: 'без СНИЛС',
  license: 'без действующего ВУ',
  requisites: 'без номера ВУ',
  issuedOn: 'без даты выдачи ВУ',
};

/** Пробелы одной строкой для строки списка: «без номера ВУ, без даты выдачи ВУ». */
export function driverDocumentGapsHint(gaps: readonly DriverDocumentGap[]): string | null {
  return gaps.length > 0 ? gaps.map((g) => driverDocumentGapHints[g]).join(', ') : null;
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
  formLabel: string | null,
): string | null {
  const what = driverDocumentGapsHint(gaps);
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

export const driverListQuerySchema = baseListQuery(DRIVER_SORT_FIELDS).extend({
  documents: driverDocumentSetSchema.optional(),
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

// ── Кадровая выгрузка (ADR 0047) ──

/**
 * Сколько строк принимается за раз. Ограничение не про производительность, а про происхождение
 * файла: кадровая выгрузка одного отдела — это десятки человек, и файл на тысячу строк означает,
 * что грузят не то, что собирались. Отказ по размеру объясним, молча заведённая тысяча — нет.
 */
export const DRIVERS_IMPORT_MAX_RECORDS = 500;

/**
 * Реквизиты ВУ из кадровой таблицы. Даты оставлены строками по той же причине, что даты человека:
 * единый разбор обоих поддерживаемых форматов и понятные ошибки живут в `prepareDriverImport`.
 * Категории остаются в поле `categories` строки — это сохраняет совместимость со старой
 * выгрузкой, где реквизитов документа ещё не было.
 */
export const driverImportLicenseSchema = z
  .object({
    series: z.string().trim().min(1, 'Серия ВУ обязательна').max(20),
    number: z.string().trim().min(1, 'Номер ВУ обязателен').max(20),
    issuedOn: z.string().trim().min(1, 'Дата выдачи ВУ обязательна').max(10),
    expiresOn: z.string().trim().min(1, 'Срок действия ВУ обязателен').max(10),
    issuedBy: z.string().trim().max(255).optional(),
  })
  .strict();
export type DriverImportLicenseInput = z.infer<typeof driverImportLicenseSchema>;

/**
 * Одна строка выгрузки. Даты приняты в двух видах намеренно: «ГГГГ-ММ-ДД» отдаёт кадровая
 * система, «ДД.ММ.ГГГГ» набирает человек, а файл правит кадровик, а не программист. Разбор,
 * контрольная сумма СНИЛС и категории — в `prepareDriverImport`: схема проверяет форму, а не
 * содержание, и валидировать здесь второй раз значило бы завести второй набор правил.
 */
export const driverImportRecordSchema = z
  .object({
    fullName: z.string().trim().min(1, 'ФИО обязательно').max(255),
    personnelNo: z.string().trim().max(50).optional(),
    /**
     * Должность и подразделение строки. В выгрузке отдела они разные — водители, водители КМУ,
     * машинисты крана, погрузчика и экскаватора сидят в одном файле, а обособленные подразделения
     * идут его разделами. Не указаны — берутся общие из файла.
     */
    jobTitle: z.string().trim().max(255).optional(),
    department: z.string().trim().max(255).optional(),
    birthDate: z.string().trim().max(10).optional(),
    employedSince: z.string().trim().max(10).optional(),
    snils: z.string().trim().min(1, 'СНИЛС обязателен').max(20),
    /** Категории строкой ровно как в источнике («B,B1,C,C1,BE,CE,C1E»). */
    categories: z.string().trim().max(200).optional(),
    /** Заполнено, когда к кадровым данным приложены полные реквизиты ВУ. */
    license: driverImportLicenseSchema.optional(),
  })
  .strict();
export type DriverImportRecordInput = z.infer<typeof driverImportRecordSchema>;

/**
 * Должности, которым колонка «категории» означает водительское удостоверение. У машиниста в той
 * же колонке стоят категории удостоверения тракториста-машиниста, и коды у них те же буквы:
 * «B, C, D, E, F» самоходной машины — это не B, C и D автомобиля. Сопоставить их со справочником
 * ВУ значит выдать человеку допуск к автобусу, которого у него нет, — молча и в базе.
 *
 * Поэтому удостоверение заводится только там, где должность прямо называет водителя, а у всех
 * прочих категории уходят в отчёт нетронутыми: их внесёт администратор, когда в справочнике
 * появится вид документа «удостоверение тракториста-машиниста».
 */
export const DRIVER_JOB_TITLE_PREFIX = 'водител';

export function isDriverJobTitle(jobTitle: string): boolean {
  return jobTitle.trim().toLowerCase().startsWith(DRIVER_JOB_TITLE_PREFIX);
}

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
 * Файл выгрузки целиком. `source` и `note` описывают происхождение файла и в справочник не
 * попадают; `department` и `jobTitle` — значения по умолчанию для строк, где своих нет
 * (ADR 0049): подразделение становится комментарием трудового отношения, должность — должностью.
 *
 * `.strict()` здесь важнее обычного: лишнее поле в файле означает, что выгрузку делали по другому
 * шаблону, и молча проигнорировать его — значит завести людей не тем, чем собирались.
 */
export const driversImportFileSchema = z
  .object({
    source: z.string().trim().max(255).optional(),
    note: z.string().trim().max(2000).optional(),
    department: z.string().trim().max(255).optional(),
    jobTitle: z.string().trim().max(255).optional(),
    drivers: z
      .array(driverImportRecordSchema)
      .min(1, 'В выгрузке нет ни одной строки')
      .max(DRIVERS_IMPORT_MAX_RECORDS, `Не больше ${DRIVERS_IMPORT_MAX_RECORDS} строк за раз`),
  })
  .strict();
export type DriversImportFileInput = z.infer<typeof driversImportFileSchema>;

/**
 * Загрузка выгрузки. `dryRun` — не удобство, а обязательный первый шаг работы с чужим файлом:
 * заведение живых людей необратимо (обратной операции у наполнения нет — удаление человека это
 * учётное действие с аудитом), поэтому сначала показывается, что произойдёт.
 */
export const driversImportSchema = z
  .object({
    dryRun: z.boolean().optional().default(false),
    file: driversImportFileSchema,
  })
  .strict();
export type DriversImportInput = z.infer<typeof driversImportSchema>;
export type DriversImportBody = z.input<typeof driversImportSchema>;

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
  /** Заведён без удостоверения: в отбор под машину такой водитель не попадёт. */
  withoutLicense: { who: string; why: string }[];
  /** Коды, которых нет в справочнике категорий: их вносит администратор по оригиналу. */
  unknownCategories: { who: string; codes: string[] }[];
  /** Однофамилец среди заведённых раньше с другим СНИЛС — повод проверить, не один ли человек. */
  nameCollisions: { who: string; existing: string }[];
}

/** Предупреждение о пустых реквизитах — то же, что печатает CLI после наполнения. */
export const DRIVERS_IMPORT_LICENSE_HINT =
  'У заведённых удостоверений пустые серия, номер и сроки: в выгрузке их нет. Пока они пустые, ' +
  'водитель в отбор под машину не попадает: без номера удостоверения путевой лист печатается ' +
  'недействительным. Реквизиты вносит администратор в карточке водителя — заменой документа.';

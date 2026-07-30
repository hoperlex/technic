import { z } from 'zod';
import { baseListQuery, dateOnlySchema, uuidSchema } from './common';
import { personNameFields, personNamePartialFields } from './person-name';
import { snilsSchema } from './snils';

// ── Справочник водителей (ADR 0008, ADR 0037) ──
// Отдельной таблицы водителей нет: водитель — это физлицо (`persons`) с действующей
// специализацией `driver`, трудовым отношением (оттуда табельный номер) и водительским
// удостоверением (`person_credentials` вида `driver_license`) с категориями. Карточка собирает
// все четыре сущности в одну форму: заводить человека, потом специализацию, потом документ —
// три экрана вместо одного, и на каждом можно остановиться на полпути.
//
// Отсюда же берёт правила отбор водителя под машину (ADR 0037): «кто может сесть за эту машину
// в эту дату» считается по сроку документа, сроку категории и аннулированию — тем же условиям,
// что показывает карточка.

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

/** Открыта ли категория этим документом на дату: собственные сроки категории сужают срок документа. */
export function hasCategoryOn(license: DriverLicenseDto, code: string, on: string): boolean {
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

// ── Ввод ──

const seriesSchema = z.string().trim().max(20);
const numberSchema = z.string().trim().min(1, 'Номер обязателен').max(20);
const issuedBySchema = z.string().trim().max(255);
const personnelNoSchema = z.string().trim().max(50);
const jobTitleSchema = z.string().trim().max(255);
const phoneSchema = z.string().trim().max(50);
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

// ── Отбор водителя под машину (ADR 0037) ──

/**
 * Водитель в списке выбора при переводе заявки в работу. СНИЛС сюда не попадает намеренно: он
 * нужен бланку, а не выбору, и собирает его сервер. Персональные данные не выносятся на экран,
 * которым пользуется каждый, кто берёт заявки в работу, — карточка водителя закрыта своим правом.
 */
export interface DriverOptionDto {
  personId: string;
  fullName: string;
  personnelNo: string;
  /** «00 00 000001» — серия и номер, как напечатаны в удостоверении. */
  licenseNumber: string;
  licenseExpiresOn: string | null;
  /** `unverified` — водитель в списке, но с пометкой: проверка бумаги не отменяет допуска. */
  verificationStatus: CredentialVerificationStatus;
  categories: string[];
}

export interface DriverSelectionDto {
  /**
   * Категория, по которой сужен список («C», «CE» при рейсе с прицепом). `null` — требование у
   * машины не заведено, и по категории не сужали: пустое требование безопаснее неверного.
   */
  requiredCategory: string | null;
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

export const driverListQuerySchema = baseListQuery(DRIVER_SORT_FIELDS).extend({
  includeDeleted: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
export type DriverListQuery = z.infer<typeof driverListQuerySchema>;

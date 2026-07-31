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

/**
 * Реквизиты удостоверения не внесены. Так выглядят документы, заведённые первичным наполнением
 * справочника из кадровой выгрузки (`seed:drivers`): категории в ней есть, серии и номера нет.
 *
 * Отбор этим не сужается и выписку листа не останавливает — предупреждение, а не запрет. Но знать
 * о нём обязан тот, кто листом распорядится: номер удостоверения — обязательный реквизит
 * (приказ Минтранса № 390), и напечатанный без него лист недействителен. Молчать здесь нельзя:
 * кнопка отработает штатно, брак обнаружится у того, кто возьмёт бумагу в руки.
 *
 * Принимает уже склеенные серию с номером (`licenseNumberLabel`, `DriverOptionDto.licenseNumber`):
 * так правило одно и для карточки водителя, и для строки выбора, где сервер склеил их сам.
 */
export function licenseRequisitesMissing(numberLabel: string): boolean {
  return numberLabel.trim() === '';
}

/** Короткая пометка в строке списка — рядом с «документ не проверен». */
export const LICENSE_REQUISITES_MISSING_HINT = 'реквизиты ВУ не внесены';

/** Развёрнутое предупреждение там, где лист выписывают: последствие важнее пометки. */
export const LICENSE_REQUISITES_MISSING_WARNING =
  'У водителя не внесены серия и номер удостоверения. Лист выпишется, но графа «Удостоверение ' +
  'водителя» напечатается пустой, а без неё документ недействителен (приказ Минтранса № 390). ' +
  'Реквизиты вносит администратор в справочнике водителей.';

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

// ── Кадровая выгрузка (ADR 0047) ──

/**
 * Сколько строк принимается за раз. Ограничение не про производительность, а про происхождение
 * файла: кадровая выгрузка одного отдела — это десятки человек, и файл на тысячу строк означает,
 * что грузят не то, что собирались. Отказ по размеру объясним, молча заведённая тысяча — нет.
 */
export const DRIVERS_IMPORT_MAX_RECORDS = 500;

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
  'водитель в отбор попадает, но графа «Удостоверение водителя» в путевом листе печатается ' +
  'пустой. Реквизиты вносит администратор в карточке водителя — заменой документа.';

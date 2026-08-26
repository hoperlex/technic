import { z } from 'zod';
import { baseListQuery, uuidSchema } from './common';
import { vehicleStatusSchema, type VehicleStatus } from './vehicles';

// ── Прицепной реестр (план `docs/vehicle-trailers-plan.md`, Р7, Р8) ──
//
// Прицеп — **не** единица техники и в `vehicles` не лежит (Р7). Ту таблицу читают 74 запроса в 37
// файлах — заявки и назначения, рейсы и листы, гараж, показания, ТО, автозапчасти, — и прицепная
// строка в ней означала бы прицеп в списке заказываемой техники: его предложили бы назначить на
// заявку, потребовали бы показания одометра и категорию прав водителя. Своя таблица платит
// дублированием CRUD, но эта цена аддитивная: ломаться в ней нечему.
//
// Своего классификатора у прицепа поэтому нет и не заводится: видов ровно два, а тип ТС в портале
// отвечает за бланк и категорию прав — прицепу ни того, ни другого не полагается.

/**
 * «Тип ТС» из СТС прицепа. Полуприцеп впереди списка не по алфавиту: в парке шесть полуприцепов и
 * ни одного прицепа, и первым в выпадающем списке обязано стоять то, что выбирают почти всегда.
 */
export const TRAILER_KINDS = ['semi_trailer', 'trailer'] as const;
export const trailerKindSchema = z.enum(TRAILER_KINDS);
export type TrailerKind = (typeof TRAILER_KINDS)[number];

export const trailerKindLabels: Record<TrailerKind, string> = {
  semi_trailer: 'Полуприцеп',
  trailer: 'Прицеп',
};

// Состояние прицепа — те же `VEHICLE_STATUSES` / `vehicleStatusLabels` / `vehicleStatusColors`, что
// у техники (`./vehicles`), а не своё перечисление: «активен», «неактивен», «обслуживание» и
// «списан» значат для прицепа ровно то же самое, а второй словарь тех же четырёх слов разошёлся бы
// с первым при первой же правке — и в двух вкладках одного справочника одно состояние называлось бы
// по-разному.
//
// Отдельного состояния «прицеплен / отцеплен» здесь нет намеренно. На этот вопрос отвечает сама
// привязка — заполнена она или пуста, — и держать рядом с ней флаг значило бы завести второй
// источник того же факта: он разъезжается ровно в тот момент, когда привязку меняют командой, а
// флаг забывают переставить. Состояние говорит о самом прицепе (жив, в ремонте, списан), привязка —
// о том, где он сейчас стоит; смешивать их в одной колонке не за что.

/**
 * Слот бланка 4-П: граф прицепа в нём ровно две — «Прицеп 1» и «Прицеп 2». Номер слота живёт в паре
 * с тягачом (`UNIQUE (hitched_vehicle_id, hitch_position)`), поэтому он не «порядок в списке», а
 * место в шапке листа: третьего прицепа печатать некуда, и принимать его номер незачем.
 */
export const TRAILER_HITCH_POSITIONS = [1, 2] as const;
export type TrailerHitchPosition = (typeof TRAILER_HITCH_POSITIONS)[number];
export const trailerHitchPositionSchema = z.union([z.literal(1), z.literal(2)]);

/**
 * Марка прицепа («ШМИТЦ SPR-24») — **текст**, а не ссылка на `vehicle_models`.
 *
 * Модель в справочнике привязана к `vehicle_type_id` (составной FK `vehicles_model_type_fk`), и
 * сослаться на неё можно, только заведя прицепные типы в классификаторе техники — то самое, от чего
 * уводит отдельная таблица (Р7): тип оттуда сразу же попадает в списки заказа, в подбор под заявку
 * и в требования к правам водителя. В бланке графа так и называется — «(марка)» — и печатается
 * строкой; шести полуприцепам парка справочник моделей не даёт ничего, кроме этой двери.
 */
const trailerModelSchema = z.string().trim().min(1, 'Укажите марку прицепа').max(100);

/**
 * Госномер прицепа. Двадцать символов — столько же, сколько в графе рейса (`trailer1RegNumber`):
 * реквизит переезжает отсюда в шапку путевого листа, и обрезаться по дороге ему негде.
 */
const trailerRegNumberSchema = z.string().trim().min(1, 'Укажите госномер').max(20);

/** VIN — семнадцать знаков, но у прицепов в СТС пишут и заводской номер шасси; запас на него. */
const trailerVinSchema = z.string().trim().max(40);

/** Номер ПТС — той же длины, что у техники: документ один и тот же. */
const trailerPassportSchema = z.string().trim().max(100);

/** Границы года — те же, что в CHECK таблицы: расходиться проверке формы и базе не за что. */
const trailerYearSchema = z.number().int().min(1900).max(2100);

const trailerColorSchema = z.string().trim().max(50);

/**
 * Масса в килограммах. Верхняя граница — предел `integer` в БД: без неё лишний ноль из опечатки
 * доезжал бы до Postgres и возвращался пятисоткой «integer out of range» вместо внятного отказа
 * формы. Продуктового смысла у границы нет — прицепов тяжелее двух миллионов тонн не бывает.
 */
const trailerMassKgSchema = z.number().int().positive().max(2_147_483_647);

const trailerNoteSchema = z.string().trim().max(2000);

const MASS_ORDER_MESSAGE = 'Масса в снаряжённом состоянии не больше технически допустимой';

/**
 * Порядок масс проверяется только когда заданы обе: реквизиты СТС заполняют по бумаге, а бумага
 * бывает неполной. Одностороннюю правку («поставили макс. массу ниже прежней снаряжённой») ловит
 * CHECK `vehicle_trailers_mass_order` — телу PATCH второй половины пары не видно.
 */
const massOrderOk = (v: { maxMassKg?: number | null; curbMassKg?: number | null }): boolean =>
  v.maxMassKg == null || v.curbMassKg == null || v.curbMassKg <= v.maxMassKg;

/**
 * Заведение прицепа. Привязки к тягачу в теле нет вовсе — и это решение, а не пропуск (Р14):
 * слот уникален, и наивная запись «поставь в слот 1» упирается в `UNIQUE` вместо результата.
 * Привязку меняет отдельная команда `POST /vehicle-trailers/:id/hitch` с единым порядком
 * блокировок; будь она заодно полем карточки, одно и то же менялось бы двумя путями с разной
 * надёжностью.
 */
export const createVehicleTrailerSchema = z
  .object({
    kind: trailerKindSchema,
    model: trailerModelSchema,
    registrationNumber: trailerRegNumberSchema,
    vin: trailerVinSchema.optional().default(''),
    passportNumber: trailerPassportSchema.optional().default(''),
    manufacturedYear: trailerYearSchema.nullish(),
    color: trailerColorSchema.optional().default(''),
    /** Технически допустимая максимальная масса — графа СТС. */
    maxMassKg: trailerMassKgSchema.nullish(),
    /** Масса в снаряжённом состоянии — соседняя графа того же СТС. */
    curbMassKg: trailerMassKgSchema.nullish(),
    /** Собственник по СТС; необязателен — часть парка оформлена не на организацию портала. */
    ownerOrganizationId: uuidSchema.nullish(),
    status: vehicleStatusSchema.optional().default('active'),
    note: trailerNoteSchema.optional().default(''),
  })
  .strict()
  .refine(massOrderOk, { message: MASS_ORDER_MESSAGE, path: ['curbMassKg'] });
export type CreateVehicleTrailerInput = z.infer<typeof createVehicleTrailerSchema>;

/**
 * Правка карточки. Поля переобъявлены, а не получены `.partial()`: тот снимает обязательность, но
 * **не** `.default()` (подвох, оплаченный в `updateWarehouseSchema`), и PATCH одного статуса
 * затирал бы VIN, цвет и примечание пустой строкой.
 *
 * Привязки здесь нет по той же причине, что и в заведении: её меняет команда.
 */
export const updateVehicleTrailerSchema = z
  .object({
    kind: trailerKindSchema.optional(),
    model: trailerModelSchema.optional(),
    registrationNumber: trailerRegNumberSchema.optional(),
    vin: trailerVinSchema.optional(),
    passportNumber: trailerPassportSchema.optional(),
    manufacturedYear: trailerYearSchema.nullish(),
    color: trailerColorSchema.optional(),
    maxMassKg: trailerMassKgSchema.nullish(),
    curbMassKg: trailerMassKgSchema.nullish(),
    ownerOrganizationId: uuidSchema.nullish(),
    status: vehicleStatusSchema.optional(),
    note: trailerNoteSchema.optional(),
  })
  .strict()
  .refine(massOrderOk, { message: MASS_ORDER_MESSAGE, path: ['curbMassKg'] });
export type UpdateVehicleTrailerInput = z.infer<typeof updateVehicleTrailerSchema>;

/**
 * Тело команды «прицепить»: за какую машину и в какой слот. Отцепление тела не имеет — прицеп
 * назван в адресе, а сниматься ему больше неоткуда.
 *
 * Прежняя привязка перемещаемого прицепа и вытесняемый жилец слота в теле не называются: их
 * находит сервер под блокировкой (Р14, шаги 1–4). Приди они от клиента — команда исполняла бы
 * картину мира, устаревшую к моменту нажатия кнопки.
 */
export const hitchTrailerSchema = z
  .object({
    vehicleId: uuidSchema,
    position: trailerHitchPositionSchema,
  })
  .strict();
export type HitchTrailerInput = z.infer<typeof hitchTrailerSchema>;

/** Сортировка доступна во всех столбцах вкладки; ключ поля совпадает с ключом колонки. */
export const VEHICLE_TRAILER_SORT_FIELDS = [
  'kind',
  'registrationNumber',
  'model',
  'manufacturedYear',
  'passportNumber',
  'hitchedVehicle',
  'status',
  'createdAt',
] as const;

export const vehicleTrailerListQuerySchema = baseListQuery(VEHICLE_TRAILER_SORT_FIELDS).extend({
  status: vehicleStatusSchema.optional(),
  kind: trailerKindSchema.optional(),
  /**
   * Состав одной машины: чем закреплённое за ней спрашивает карточка техники и подстановка в рейс.
   * Отдельного «только свободные» здесь нет — таким запросом заведует форма привязки, а списку
   * справочника хватает того, что колонка «за какой машиной» видна и пустой.
   */
  hitchedVehicleId: uuidSchema.optional(),
  includeDeleted: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
export type VehicleTrailerListQuery = z.infer<typeof vehicleTrailerListQuerySchema>;

/**
 * Тягач в строке прицепа: столько, сколько нужно, чтобы назвать машину человеку. Оба реквизита
 * приезжают допускающими `null`, потому что такими они лежат в `vehicles`: госномер там
 * необязателен, марка — тоже. Прочерк вместо машины строка не рисует — за это отвечает показ.
 */
export interface VehicleTrailerVehicleRefDto {
  id: string;
  registrationNumber: string | null;
  modelName: string | null;
}

export interface VehicleTrailerDto {
  id: string;
  kind: TrailerKind;
  /** Марка строкой — см. `trailerModelSchema`: ссылки на справочник моделей у прицепа нет. */
  model: string;
  registrationNumber: string;
  vin: string;
  passportNumber: string;
  manufacturedYear: number | null;
  color: string;
  maxMassKg: number | null;
  curbMassKg: number | null;
  ownerOrganizationId: string | null;
  /**
   * Наименование собственника; `null` — прицеп числится за основной организацией портала, как и
   * весь парк. Отдельным полем, а не одним `ownerOrganizationId`: карточка повторяет СТС, где
   * собственник напечатан словами, и показывать вместо него uuid значило бы хранить графу, которую
   * нечем прочитать. Техника поля не имеет по обратной причине — она собственника и не показывает.
   */
  ownerOrganizationName: string | null;
  status: VehicleStatus;
  note: string;
  /** Исходное наименование строки выгрузки — как у техники: чем запись была до переноса. */
  sourceName: string;
  /**
   * За какой машиной стоит прицеп; `null` — ни за какой. Пара с `hitchPosition` заполнена и пуста
   * только целиком (CHECK `vehicle_trailers_hitch_pair`), поэтому «слот без машины» в строке
   * невозможен и разбирать такой случай показу не нужно.
   */
  hitchedVehicle: VehicleTrailerVehicleRefDto | null;
  hitchPosition: TrailerHitchPosition | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/**
 * Как прицеп называется в списках, подтверждениях и подписи под графами рейса: «ШМИТЦ SPR-24
 * ВХ933277». Марка и госномер через пробел — ровно так их склеивает `trailerLabelOf` в
 * `vehicle-routes.ts`, и это не совпадение: в бланке они стоят двумя соседними графами, и подпись
 * закрепления обязана читаться так же, как напечатанная строка листа. Разойдись эти две функции —
 * человек сверял бы «то же самое», написанное по-разному.
 *
 * Пустых половин у живой записи не бывает (обе графы обязательны), но `filter` оставлен: подпись
 * зовут и от неполных данных — из формы, где реквизит ещё вводят.
 */
/**
 * Ответ команды `POST /vehicle-trailers/:id/hitch`.
 *
 * Отдельным типом рядом с `VehicleTrailerDto`, а не карточкой прицепа: команда меняет **две**
 * строки, а не одну. Заняв чужой слот, она отцепляет прежнего жильца — и это не подробность её
 * работы, а второе изменение в базе, о котором обязан узнать тот, кто нажал кнопку. Промолчи
 * ответ — и диспетчер, поставивший свой полуприцеп в занятый слот, узнает о чужом отцеплении из
 * чужой жалобы.
 *
 * Тип живёт в контрактах, хотя это ответ, а не тело запроса: сервер и портал должны описывать его
 * одним объявлением. Два одинаковых интерфейса по разные стороны — это два места, где правку
 * забудут по очереди, и первым забудут то, где её не видно.
 */
export interface HitchTrailerResultDto {
  /** Прицеп после привязки — с заполненными `hitchedVehicle` и `hitchPosition`. */
  trailer: VehicleTrailerDto;
  /**
   * Законченная фраза о вытесненном: «Слот 1 занимал ШМИТЦ SPR-24 ВХ933277 — он отцеплен».
   * `null` — слот был свободен, и говорить не о чем.
   *
   * Фразой, а не кодом с реквизитами: портал показывает её отдельным тостом, и собирать текст на
   * той стороне значило бы завести вторую формулировку одного события — она разойдётся с этой при
   * первой же правке. Подпись вытесненного собирает `trailerTitle`, та же, что подписывает прицеп
   * в списках: в тосте человек обязан узнать ровно то, что видел в таблице.
   */
  notice: string | null;
}

export function trailerTitle(t: Pick<VehicleTrailerDto, 'model' | 'registrationNumber'>): string {
  return [t.model, t.registrationNumber]
    .map((v) => (v ?? '').trim())
    .filter(Boolean)
    .join(' ');
}

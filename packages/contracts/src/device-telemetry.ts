import { z } from 'zod';
import { uuidSchema } from './common';

/**
 * Телеметрия оргтехники: единый язык почтового приёма (Этап 1) и будущего коллектора (Этап 2).
 * План — `docs/office-equipment-mail-telemetry-plan.md`, форма исполнения —
 * `docs/office-equipment-mail-telemetry-agent-plan.md`.
 *
 * Четыре утверждения, из которых следует весь этот файл:
 *
 * 1. **Наблюдение и событие — разные сущности** (Р6). У наблюдения есть число, единица и
 *    накопительная природа; у события — код, важность и факт. Сложенные в одну форму, они через
 *    полгода начнут делить проверки, которых у половины строк нет.
 * 2. **Закрытая часть словаря не зависит от того, что пришло** (Р29). Коды метрик, событий,
 *    важности, источников и ошибок разбора перечислены здесь до первого живого письма; вендорский
 *    код едет открытой строкой `vendorCode` и правки контракта не требует. Ровно это и позволило
 *    снять зависимость словаря от разведки на аппарате.
 * 3. **Граница источника проходит по `source` и дальше не видна** (Р4). Всё, что ниже слоя
 *    нормализации — блок карточки, очередь, предупреждения, будущие месячные дельты, — про почту
 *    не знает вовсе. Это единственное обязательство Этапа 1 перед Этапом 2.
 * 4. **Профиль вендора не ходит в базу и не знает про карточки** (§8 плана). Он переводит письмо в
 *    поля; связывает поля с аппаратом отдельный слой. На этом стоит вся тестируемость разбора: его
 *    случаи гоняются на `.eml` без базы вовсе.
 *
 * ПОЧЕМУ ЭТОТ ФАЙЛ ЗАМОРОЖЕН РАНЬШЕ ОСТАЛЬНОГО КОДА. На него смотрят восемь параллельных пакетов
 * работ: приёмник, ручка, разбор, идентификация, оба экрана и профиль вендора. Правка «под себя»
 * посреди волны означала бы восемь реализаций по трём разным редакциям одного типа, и разошлись бы
 * они молча. Предложение об изменении едет текстом в отчёте пакета, а правит его оркестратор.
 */

// ── Источник данных ──

/**
 * Откуда приехало значение. Перечисление базы (`device_telemetry_source`), а не текст с проверкой:
 * набор закрыт и Этапом 2 не расширяется — у коллектора **один** код на все свои протоколы.
 *
 * Шестизначный `source` прежнего плана (`snmp|ipp|vendor|print_server|manual|import`) сюда не
 * переезжает намеренно: чем именно коллектор снял показание, — это его внутреннее дело, а порталу
 * важно одно различие, и оно про доверие к числу, а не про провод.
 */
export const TELEMETRY_SOURCES = ['email', 'collector', 'manual'] as const;
export type TelemetrySource = (typeof TELEMETRY_SOURCES)[number];

export const telemetrySourceLabels: Record<TelemetrySource, string> = {
  email: 'Письмо аппарата',
  collector: 'Локальный сборщик',
  manual: 'Ручной ввод',
};

// ── Метрики ──

/**
 * Коды измеряемых величин. Реестр **append-only**: переименование кода — таблица переноса в
 * миграции, а не тихая замена строки здесь (Р20). Причина прямая: разбор непривязанного письма
 * лежит снимком месяцами и применяется КАК ЕСТЬ, без сверки с нынешним реестром, — переименуй код,
 * и снимок станет мусором ровно в той очереди, которая лежит дольше всех.
 *
 * **Порядок объявления здесь — это порядок показа на экране** (наработка выше расходников). Он
 * держится договорённостью, а не полем сортировки, и дописывающему код это надо знать: строка,
 * вставленная в середину, переедет на экране туда же.
 *
 * Счётчики (первые пять) взяты из словаря показателей `docs/office-equipment-usage-plan.md` §2 —
 * заводить второй словарь под почту нельзя, иначе Этап 2 принесёт третий. Расходники (последние
 * три) пишутся здесь заново: в том словаре их нет ни одного, там только наработка.
 */
export const METRIC_CODES = [
  /** Штатный общий счётчик устройства: то, что аппарат считает «своей» наработкой. */
  'marker_life_total',
  /** Напечатанные стороны (оттиски). Лист двусторонней печати — это два оттиска. */
  'printed_impressions_total',
  /** Физические листы. Не равно оттискам, и у Ricoh единица счётчика настраиваемая. */
  'printed_sheets_total',
  'printed_mono_total',
  'printed_color_total',
  /** Остаток расходника в процентах: 0 — пусто, 100 — новый. */
  'supply_level_percent',
  /** Остаток ресурса в «страницах», как его объявляет сам аппарат. */
  'supply_remaining_pages',
  /** Счётчик замен расходника, если аппарат его сообщает. */
  'supply_replacements_total',
] as const;
export type MetricCode = (typeof METRIC_CODES)[number];

/** Единица измерения. Она — свойство МЕТРИКИ, а не строки наблюдения (Р22). */
export const METRIC_UNITS = ['impressions', 'sheets', 'pages', 'percent', 'count'] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

/** Подпись единицы: без неё число стоит голым — «12 480» вместо «12 480 оттисков». */
export const metricUnitLabels: Record<MetricUnit, string> = {
  impressions: 'оттисков',
  sheets: 'листов',
  pages: 'страниц',
  percent: '%',
  count: 'шт.',
};

/**
 * Единица каждой метрики — одним местом. Колонка `unit` у наблюдения хранит её снимок, и при
 * расхождении снимка с этим реестром письмо уходит в `failed`, а не пишется: две копии единицы,
 * которые «как-нибудь разойдутся», — это ровно то, от чего предостерегает правило одного места.
 */
export const metricUnits: Record<MetricCode, MetricUnit> = {
  marker_life_total: 'impressions',
  printed_impressions_total: 'impressions',
  printed_sheets_total: 'sheets',
  printed_mono_total: 'impressions',
  printed_color_total: 'impressions',
  supply_level_percent: 'percent',
  supply_remaining_pages: 'pages',
  supply_replacements_total: 'count',
};

export const metricLabels: Record<MetricCode, string> = {
  marker_life_total: 'Общий счётчик',
  printed_impressions_total: 'Напечатано оттисков',
  printed_sheets_total: 'Напечатано листов',
  printed_mono_total: 'Чёрно-белая печать',
  printed_color_total: 'Цветная печать',
  supply_level_percent: 'Остаток расходника',
  supply_remaining_pages: 'Остаток ресурса',
  supply_replacements_total: 'Замен расходника',
};

/**
 * Накопительные метрики умеют только расти, и на этом будут стоять будущие месячные дельты. У
 * уровня расходника всё наоборот: он падает от печати и прыгает вверх при замене картриджа.
 *
 * Различие объявлено здесь, а не выведено из имени кода: «догадайся по суффиксу `_total`» — это
 * правило, которое ломается на первом же исключении и ломается молча.
 */
export const metricIsCumulative: Record<MetricCode, boolean> = {
  marker_life_total: true,
  printed_impressions_total: true,
  printed_sheets_total: true,
  printed_mono_total: true,
  printed_color_total: true,
  supply_level_percent: false,
  supply_remaining_pages: false,
  supply_replacements_total: true,
};

// ── Разрез ──

/**
 * Разрез наблюдения (Р33): чей это тонер, какой барабан, какой лоток. **Обязательная часть
 * уникального ключа**, и потому — пустая строка вместо `NULL`.
 *
 * Зачем вообще. Пилот цветной (Ricoh Aficio MP C2011SP), и письмо об уровнях несёт четыре тонера
 * разом: K, C, M, Y. Один `source_ref` на всё письмо, один код метрики на четыре числа — без
 * разреза три значения из четырёх потерялись бы молча.
 *
 * Почему не `NULL` у счётчиков, где разреза не бывает: `NULL` в PostgreSQL не равен `NULL`, и
 * уникальный ключ перестал бы работать у всей группы наработки разом — повтор пачки коллектора,
 * двойное «привязать» и перечитывание удваивали бы ряд. Пустая строка означает «разреза нет» и
 * означает это значением.
 */
export const COMPONENT_NONE = '';

export const COMPONENT_CODES = [
  COMPONENT_NONE,
  'black',
  'cyan',
  'magenta',
  'yellow',
  'drum',
  'fuser',
  'waste',
  'tray1',
  'tray2',
  'tray3',
  'bypass',
] as const;
export type ComponentCode = (typeof COMPONENT_CODES)[number];

export const componentLabels: Record<ComponentCode, string> = {
  [COMPONENT_NONE]: '',
  black: 'Чёрный',
  cyan: 'Голубой',
  magenta: 'Пурпурный',
  yellow: 'Жёлтый',
  drum: 'Барабан',
  fuser: 'Печка',
  waste: 'Бункер отработки',
  tray1: 'Лоток 1',
  tray2: 'Лоток 2',
  tray3: 'Лоток 3',
  bypass: 'Обходной лоток',
};

// ── События ──

/**
 * Коды событий. Закрыт, и последний код — `other` — **законный исход, а не заглушка**: событие,
 * которого нет в словаре, приезжает как `other` с вендорской строкой и человеческим текстом, и
 * именно по накопленным `other` решают, заводить ли новый код.
 *
 * Отсюда и главное свойство этого реестра: он не ждёт первого живого письма. Не угадали код —
 * данные всё равно не потеряны.
 */
export const DEVICE_EVENT_CODES = [
  'toner_low',
  'toner_empty',
  'drum_low',
  'waste_full',
  'paper_empty',
  'paper_jam',
  'cover_open',
  'service_call',
  'other',
] as const;
export type DeviceEventCode = (typeof DEVICE_EVENT_CODES)[number];

export const deviceEventLabels: Record<DeviceEventCode, string> = {
  toner_low: 'Заканчивается тонер',
  toner_empty: 'Тонер закончился',
  drum_low: 'Ресурс барабана на исходе',
  waste_full: 'Бункер отработки заполнен',
  paper_empty: 'Закончилась бумага',
  paper_jam: 'Замятие бумаги',
  cover_open: 'Открыта крышка',
  service_call: 'Вызов сервисной службы',
  other: 'Прочее сообщение аппарата',
};

/**
 * Важность. Перечисление базы (`device_event_severity`): три значения, и расширять их нечем —
 * это шкала, а не словарь предметной области.
 */
export const DEVICE_EVENT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type DeviceEventSeverity = (typeof DEVICE_EVENT_SEVERITIES)[number];

/**
 * Подписи важности. Здесь, а не в экране: шкалу рисуют оба экрана модуля — блок карточки и
 * очередь разбора, — и две копии разошлись бы ровно в тот день, когда одну из них поправят.
 */
export const deviceEventSeverityLabels: Record<DeviceEventSeverity, string> = {
  info: 'Сообщение',
  warning: 'Внимание',
  critical: 'Критично',
};

/**
 * Важность по умолчанию для кода. Профиль вправе поднять её (аппарат сам сказал «вызов сервиса»),
 * но не обязан думать за весь словарь.
 */
export const deviceEventSeverityDefaults: Record<DeviceEventCode, DeviceEventSeverity> = {
  toner_low: 'warning',
  toner_empty: 'critical',
  drum_low: 'warning',
  waste_full: 'warning',
  paper_empty: 'warning',
  paper_jam: 'warning',
  cover_open: 'info',
  service_call: 'critical',
  other: 'info',
};

// ── Профили разбора ──

/**
 * Коды профилей. Профиль пишется **на семейство**, а не на модель и никогда на экземпляр (Р8):
 * Ricoh Aficio и Ricoh IM почти наверняка окажутся одним профилем с разными шаблонами полей.
 *
 * `unknown` — полноправный профиль, а не отсутствие профиля (Р13): письмо, которого мы не поняли,
 * обязано доехать до базы со статусом «не распознано» и лежать в очереди. Именно из этой очереди
 * берутся образцы для следующего профиля; молчаливое выбрасывание лишило бы нас единственного
 * источника знаний о парке.
 */
export const DEVICE_PROFILE_CODES = ['ricoh', 'kyocera', 'hp', 'pantum', 'unknown'] as const;
export type DeviceProfileCode = (typeof DEVICE_PROFILE_CODES)[number];

// ── Состояние письма ──

/**
 * Статус обработки письма (перечисление базы `device_message_status`).
 *
 * `unmatched` и `ambiguous` — не ошибки, а штатные исходы: письмо принято, разобрано, сохранено и
 * ждёт человека (§6 плана). Ни одна карточка при этом не тронута.
 */
export const DEVICE_MESSAGE_STATUSES = [
  'received',
  'parsed',
  'unmatched',
  'ambiguous',
  'unrecognized',
  'failed',
  'ignored',
] as const;
export type DeviceMessageStatus = (typeof DEVICE_MESSAGE_STATUSES)[number];

export const deviceMessageStatusLabels: Record<DeviceMessageStatus, string> = {
  received: 'Принято, ждёт разбора',
  parsed: 'Разобрано',
  unmatched: 'Аппарат не опознан',
  ambiguous: 'Подходит нескольким аппаратам',
  unrecognized: 'Формат не распознан',
  failed: 'Ошибка разбора',
  ignored: 'Отброшено',
};

/** Конечные статусы: работа по письму закончена, повторная сдача отвечает успехом сразу (§9.1, п. 5). */
export const DEVICE_MESSAGE_FINAL_STATUSES: readonly DeviceMessageStatus[] = [
  'parsed',
  'unmatched',
  'ambiguous',
  'unrecognized',
  'failed',
  'ignored',
];

export function isFinalDeviceMessageStatus(status: DeviceMessageStatus): boolean {
  return DEVICE_MESSAGE_FINAL_STATUSES.includes(status);
}

/**
 * Состояние сырья (перечисление базы `device_raw_state`). Заведено потому, что между заведением
 * строки и записью объекта в хранилище процесс может умереть, и без признака это состояние
 * неотличимо от нормального (§9.1, п. 3).
 *
 * `purged` — не «потеряно», а «вычищено по сроку»: на нём очередь прячет кнопку «перечитать»,
 * потому что перечитывать нечем, а падающая кнопка без объяснения хуже отсутствующей.
 */
export const DEVICE_RAW_STATES = ['absent', 'stored', 'purged'] as const;
export type DeviceRawState = (typeof DEVICE_RAW_STATES)[number];

// ── Ошибки разбора ──

/**
 * Класс отказа. Ось `transient | terminal` — не украшение журнала: от неё зависит, ждёт письмо в
 * ящике или закрывается строкой, и она же решает, растёт ли счётчик застревания (§9.1, п. 7).
 * Образец — `apps/worker/src/ticket-ocr/errors.ts`, где обе оси ставятся в точке отказа.
 */
export const DEVICE_ERROR_CLASSES = ['transient', 'terminal'] as const;
export type DeviceErrorClass = (typeof DEVICE_ERROR_CLASSES)[number];

/**
 * Коды отказов приёма и разбора. Текстом с проверкой, а не перечислением базы: набор пополняется по
 * ходу пилота, а `CREATE TYPE` на каждое пополнение стоил бы миграции с блокировкой.
 */
export const DEVICE_ERROR_CODES = [
  /** Тело больше потолка: не качалось вовсе, строка заведена конвертом (§9.1, п. 1). */
  'too_large',
  /** Ящик не наш: письмо адресовано не тому каналу. */
  'wrong_account',
  /** Конверт или MIME не разбираются. */
  'malformed',
  /** Профиль не опознан ни одним разборщиком — приезжает как `unrecognized`. */
  'no_profile',
  /** Профиль опознан, но обязательные поля не вычитались. */
  'extract_failed',
  /** Единица в снимке разошлась с реестром метрик (Р22). */
  'unit_mismatch',
  /** Приём остановлен рубильником — временный отказ, письмо ждёт. */
  'intake_disabled',
  /** Хранилище недоступно — временный отказ, письмо ждёт. */
  'storage_unavailable',
  /** Письмо закрыто счётчиком застревания после десятого захода (§9.1, п. 7). */
  'stuck',
  /** Отправитель вне списка доверенных (`DEVICE_MAIL_ALLOWED_SENDERS`). */
  'sender_not_allowed',
  /** Протокол сдачи нарушен: ни тела, ни причины его отсутствия. */
  'bad_submission',
] as const;
export type DeviceErrorCode = (typeof DEVICE_ERROR_CODES)[number];

export const deviceErrorClasses: Record<DeviceErrorCode, DeviceErrorClass> = {
  too_large: 'terminal',
  wrong_account: 'terminal',
  malformed: 'terminal',
  no_profile: 'terminal',
  extract_failed: 'terminal',
  unit_mismatch: 'terminal',
  intake_disabled: 'transient',
  storage_unavailable: 'transient',
  stuck: 'terminal',
  sender_not_allowed: 'terminal',
  bad_submission: 'terminal',
};

/**
 * Отказы, которые НЕ растят счётчик застревания: портал целиком не принимает, и письмо тут ни при
 * чём. Выключенный на сутки рубильник иначе выел бы десятки писем подряд, каждое по очереди
 * становясь головой пачки, — а Р28 обещает буквально «письмо остаётся в ящике и дождётся
 * включения».
 */
export const DEVICE_PAUSE_ERROR_CODES: readonly DeviceErrorCode[] = [
  'intake_disabled',
  'storage_unavailable',
];

export function isPauseErrorCode(code: DeviceErrorCode): boolean {
  return DEVICE_PAUSE_ERROR_CODES.includes(code);
}

/** Потолок заходов, после которого письмо закрывается как `stuck` (§9.1, п. 7). */
export const DEVICE_MAIL_STUCK_ATTEMPTS = 10;

/**
 * Код тела ответа при временном отказе приёма. Здесь, а не двумя литералами в ручке и приёмнике:
 * они живут в разных приложениях, и разошлись бы молча — приёмник просто перестал бы узнавать
 * паузу и погнал бы пачку дальше за непринятое письмо.
 */
export const DEVICE_MAIL_PAUSE_CODE = 'device_mail_paused';

/**
 * Почему письмо сдано конвертом без сырья. Единственная причина — переросток (§9.1, п. 1), и тип
 * назван отдельно, чтобы приёмник и ручка не расширяли его каждый по-своему.
 */
export const DEVICE_SKIP_REASONS = ['too_large'] as const;
export type DeviceSkipReason = (typeof DEVICE_SKIP_REASONS)[number];

// ── Ключи опознания ──

/**
 * Чем письмо связывается с карточкой. Порядок резолва — Р9 плана, и он важнее самого перечня:
 * первый однозначный выигрывает, «примерно подходит» не бывает.
 *
 * `host` и `fromAddress` в резолве НЕ участвуют сами по себе — только через подтверждённую
 * человеком привязку. IP не опознаёт никогда и ни при каких условиях: после DHCP по старому адресу
 * стоит другой принтер.
 */
export const DEVICE_IDENTITY_KINDS = [
  'serial',
  'inventory',
  'deviceName',
  'host',
  'envelopeTo',
  'fromAddress',
] as const;
export type DeviceIdentityKind = (typeof DEVICE_IDENTITY_KINDS)[number];

export const deviceIdentityLabels: Record<DeviceIdentityKind, string> = {
  serial: 'Серийный номер',
  inventory: 'Инвентарный номер',
  deviceName: 'Имя устройства',
  host: 'Сетевое имя',
  envelopeTo: 'Адрес получателя',
  fromAddress: 'Адрес отправителя',
};

/**
 * Ключи, по которым привязка применяется **пачкой** ко всем накопленным письмам (Р20). Остальные —
 * только к той строке, на которой нажали.
 *
 * Разделение не формальное. ИТ-служба сплошь и рядом прописывает парку один служебный адрес
 * отправителя; пачка по нему одним нажатием приписала бы сотни писем разных аппаратов одной
 * карточке — ровно то, чем открывается §6 плана, только мгновенно и без отката.
 */
export const DEVICE_IDENTIFYING_KINDS: readonly DeviceIdentityKind[] = [
  'serial',
  'inventory',
  'deviceName',
];

export function isIdentifyingKind(kind: DeviceIdentityKind): boolean {
  return DEVICE_IDENTIFYING_KINDS.includes(kind);
}

/**
 * Нормализация ключа опознания. **Ровно та форма, в которой лежат уникальные индексы номеров у
 * карточки** — `upper(btrim(...))`, — не «похожая», а та же: считай её иначе, и резолв перестанет
 * находить заведённое соседним местом.
 *
 * Отсюда две неочевидные строгости. Срезаются только пробелы по краям, как это делает `btrim`, — ни
 * табуляции, ни неразрывные пробелы, которых `btrim` не трогает. И внутренние пробелы **не
 * схлопываются**: у номера `3282 Z920584`, склеенного при заводе карточки из разорванной строки
 * учёта, схлопывание дало бы значение, которого в индексе нет, и резолв прошёл бы мимо живой
 * карточки.
 */
export function normalizeIdentityValue(raw: string): string {
  return raw.replace(/^ +| +$/gu, '').toUpperCase();
}

// ── Вход нормализатора ──

/**
 * Наблюдение, как его отдаёт профиль. Без `equipmentId` и без `sourceRef`: профиль не знает ни про
 * карточки, ни про строку письма — их подставляет слой применения. На этом стоит тестируемость
 * разбора на `.eml` без базы.
 */
export const deviceObservationInputSchema = z.object({
  metricCode: z.enum(METRIC_CODES),
  component: z.enum(COMPONENT_CODES).default(COMPONENT_NONE),
  /**
   * Число строкой, а не `number`. Счётчик за жизнь аппарата уходит за девять знаков, и путешествие
   * через JSON-число — это тихая потеря точности в тот день, когда её никто не ждёт.
   */
  value: z.string().regex(/^\d+(\.\d{1,3})?$/u),
  unit: z.enum(METRIC_UNITS),
  /** Время, объявленное аппаратом. Справочное: порядок ряда задаёт момент приёма (Р21). */
  deviceTime: z.string().datetime().nullable().default(null),
  /** Как поле звалось в письме — чтобы спор «почему так разобралось» решался без сырья. */
  rawLabel: z.string().max(200).default(''),
});
export type DeviceObservationInput = z.infer<typeof deviceObservationInputSchema>;

export const deviceEventInputSchema = z.object({
  eventCode: z.enum(DEVICE_EVENT_CODES),
  /**
   * Порядковый номер вхождения кода внутри одного источника. Полем, а не порядком строк в
   * массиве: снимок разбора лежит месяцами и применяется позже, и «номер восстановится из
   * порядка» — это договорённость, которую типы не стерегут, а перестановка ломает молча.
   */
  ordinal: z.number().int().nonnegative().default(0),
  severity: z.enum(DEVICE_EVENT_SEVERITIES),
  deviceTime: z.string().datetime().nullable().default(null),
  /** Код вендора как есть: без словаря и без проверки — открытая часть Р29. */
  vendorCode: z.string().max(100).default(''),
  text: z.string().max(2000).default(''),
});
export type DeviceEventInput = z.infer<typeof deviceEventInputSchema>;

/** Подсказки опознания, вычитанные профилем из письма. */
export const deviceIdentityHintsSchema = z.object({
  serial: z.string().max(200).nullable().default(null),
  inventory: z.string().max(200).nullable().default(null),
  deviceName: z.string().max(200).nullable().default(null),
  host: z.string().max(200).nullable().default(null),
  ip: z.string().max(60).nullable().default(null),
  model: z.string().max(200).nullable().default(null),
});
export type DeviceIdentityHints = z.infer<typeof deviceIdentityHintsSchema>;

/**
 * Итог разбора одного письма. Он же — **снимок**, который ложится в строку письма и применяется КАК
 * ЕСТЬ, когда человек привяжет аппарат (Р20). Потому здесь и лежит `parserVersion`: снимок обязан
 * помнить, какими правилами он сделан, а сверять его с нынешним реестром на применении нельзя —
 * иначе пополнение словаря превращает правильно разобранное письмо в ошибочное.
 */
export const parsedDeviceMessageSchema = z.object({
  profileCode: z.enum(DEVICE_PROFILE_CODES),
  parserVersion: z.number().int().nonnegative(),
  observations: z.array(deviceObservationInputSchema),
  events: z.array(deviceEventInputSchema),
  identity: deviceIdentityHintsSchema,
});
export type ParsedDeviceMessage = z.infer<typeof parsedDeviceMessageSchema>;

/**
 * Письмо в нейтральном виде — то, что видит профиль. Ни `Buffer`, ни потоков: профиль обязан быть
 * чистой функцией от этих полей, иначе его не прогнать на `.eml` без окружения.
 */
export interface DeviceMailContext {
  subject: string;
  fromAddress: string;
  envelopeTo: string;
  /** Заголовок письма. НЕ ссылка на строку: ссылка зовётся `mailMessageId`. */
  messageIdHeader: string;
  /** `Date` письма; `null` — заголовка не было (у старых прошивок бывает). */
  dateHeader: string | null;
  text: string;
  html: string;
  /** Таблицы HTML, уже приведённые к строкам ячеек: профилю незачем знать про разметку. */
  tables: readonly (readonly string[])[][];
  attachments: readonly { filename: string; contentType: string; text: string }[];
  headers: Readonly<Record<string, string>>;
}

/**
 * Профиль вендора. Три функции и ничего больше — это условие тестируемости: `detect` выбирает,
 * `parse` переводит, и ни одна из них не ходит в базу.
 *
 * `detect` возвращает уверенность 0…1, а не «да/нет»: письма вендоров похожи, и реестр обязан уметь
 * разрешать спор числом, а не порядком объявления.
 */
export interface DeviceProfile {
  code: DeviceProfileCode;
  version: number;
  detect(ctx: DeviceMailContext): number;
  parse(ctx: DeviceMailContext): Omit<ParsedDeviceMessage, 'profileCode' | 'parserVersion'>;
}

// ── Чтение: блок карточки ──

/** Размер страницы блока и очереди — как у существующих блоков карточки (`EQUIPMENT_BLOCK_PAGE_SIZE`). */
export const DEVICE_TELEMETRY_PAGE_SIZE = 20;
export const DEVICE_TELEMETRY_MAX_PAGE_SIZE = 100;

export const deviceTelemetryQuerySchema = z.object({
  cursor: z.string().max(400).optional(),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(DEVICE_TELEMETRY_MAX_PAGE_SIZE)
    .optional()
    .default(DEVICE_TELEMETRY_PAGE_SIZE),
});
export type DeviceTelemetryQuery = z.infer<typeof deviceTelemetryQuerySchema>;

/**
 * Курсор постраничного чтения — один кодек на все ленты модуля, но **не один курсор**.
 *
 * Здесь, а не в файлах маршрутов: блок карточки и очередь разбора листают ленты одинаковой формы, и
 * второй, несовместимый кодек появился бы молча — в тот день, когда второй экран начнут писать.
 *
 * ЛЕНТА ЗАПЕЧАТАНА В САМ КУРСОР, и это правка по находке пакета очереди: первая редакция звала
 * кодек «лентой событий» и выдавала обеим лентам одинаковые строки. Курсоры оказывались взаимно
 * читаемы — курсор блока карточки, подставленный в очередь, разбирался и становился якорем по
 * чужому ряду. Теперь чужая лента не декодируется вовсе, и маршрут отвечает отказом, а не первой
 * страницей чужого ряда.
 *
 * Отметка с микросекундами: две записи одной секунды — обычное дело для пачки писем, прочитанной
 * после паузы, и курсор, потерявший точность, уронил бы часть страницы.
 *
 * **ФОРМУ КУСКОВ КОДЕК НЕ ПРОВЕРЯЕТ, и это забота вызывающего.** Он стережёт ленту — чтобы
 * курсор соседнего ряда не разобрался и не стал якорем по чужим строкам, — а ключ порядка у
 * каждой ленты свой. Маршрут обязан прогнать разобранное через свою схему (время и
 * идентификатор) и ответить отказом: иначе куски уедут в SQL приведениями и уронят запрос
 * пятисоткой там, где честный ответ — «ссылка не читается, откройте заново».
 */
export const DEVICE_CURSOR_LANES = [
  'device-events',
  'device-mail-queue',
  'device-mail-identities',
] as const;
export type DeviceCursorLane = (typeof DEVICE_CURSOR_LANES)[number];

export interface DeviceCursor {
  observedAt: string;
  id: string;
}

export function encodeDeviceCursor(lane: DeviceCursorLane, cursor: DeviceCursor): string {
  return `1~${lane}~${cursor.observedAt}~${cursor.id}`;
}

/** `null` — курсор чужой ленты, битый или подделанный. Маршрут обязан ответить отказом. */
export function decodeDeviceCursor(lane: DeviceCursorLane, raw: string): DeviceCursor | null {
  const prefix = `1~${lane}~`;
  if (!raw.startsWith(prefix)) return null;
  const rest = raw.slice(prefix.length);
  const at = rest.lastIndexOf('~');
  if (at <= 0) return null;
  const observedAt = rest.slice(0, at);
  const id = rest.slice(at + 1);
  if (!observedAt || !id) return null;
  return { observedAt, id };
}

/** Последнее значение метрики в карточке. */
export interface DeviceMetricValueDto {
  metricCode: MetricCode;
  component: ComponentCode;
  value: string;
  unit: MetricUnit;
  /** Момент приёма порталом: он же задаёт порядок ряда (Р21). */
  observedAt: string;
  /** Время аппарата, если он его назвал. Лента показывает именно его. */
  deviceTime: string | null;
  source: TelemetrySource;
}

export interface DeviceEventDto {
  id: string;
  eventCode: DeviceEventCode;
  severity: DeviceEventSeverity;
  observedAt: string;
  deviceTime: string | null;
  source: TelemetrySource;
  vendorCode: string;
  text: string;
}

export interface DeviceTelemetryPageDto<T> {
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface DeviceTelemetryCardDto {
  /** Пусто — аппарат ещё не присылал писем. Это законное состояние, а не ошибка. */
  metrics: DeviceMetricValueDto[];
  events: DeviceTelemetryPageDto<DeviceEventDto>;
}

// ── Чтение: очередь разбора ──

export interface DeviceMailQueueItemDto {
  id: string;
  status: DeviceMessageStatus;
  rawState: DeviceRawState;
  receivedAt: string;
  deviceTime: string | null;
  fromAddress: string;
  /**
   * Адрес получателя. В строке очереди он нужен потому, что `envelopeTo` — законный род ключа
   * привязки: без него человек, выбравший этот род, набирал бы адрес руками, не видя его нигде.
   */
  envelopeTo: string;
  subject: string;
  profileCode: DeviceProfileCode | null;
  errorCode: DeviceErrorCode | null;
  errorText: string;
  /** Подсказки опознания из снимка: серийник, имя, IP — человеку, который будет привязывать. */
  identity: DeviceIdentityHints;
  /** Сколько наблюдений и событий ждёт применения. */
  observationCount: number;
  eventCount: number;
  /** Действие «перечитать» доступно только при `stored` — иначе перечитывать нечем. */
  canReparse: boolean;
  /**
   * Доступна ли отметка «просмотрено». Флагом, а не предикатом на экране, по той же причине, по
   * какой рядом стоит `canReparse`: доступность действия в этом портале считает сервер, и копия
   * правила на другой стороне разошлась бы молча.
   *
   * След «просмотрено» убирает строку из очереди НАВСЕГДА, поэтому он законен только там, где
   * другого выхода у письма нет: ни снимка к применению, ни сырья к перечитыванию. Письмо, ждущее
   * привязки, так закрывать нельзя — ненужное отбрасывают действием «игнорировать», и отбор пачки
   * его после этого не подберёт.
   */
  canReview: boolean;
}

/**
 * Состояние ящика в шапке очереди. Отдельной строкой, потому что застрявшее письмо по определению
 * может не иметь собственной строки в базе: тело не принято ни разу, а курсор стоит (§9.1, п. 8).
 */
export interface DeviceMailboxStateDto {
  account: string;
  lastPollAt: string | null;
  /**
   * Момент ПОСЛЕДНЕГО подтверждённого отказа по застрявшему письму, а не «стоит с». Второго в
   * схеме нет: `updated_at` ящика переписывает и успешный приём, и рост счётчика, — и поле,
   * названное «с какого времени стоит», обещало бы точность, которой у него нет.
   */
  cursorStuckAt: string | null;
  lastError: string;
  stuckAttempts: number;
}

export interface DeviceMailQueueDto {
  mailbox: DeviceMailboxStateDto[];
  items: DeviceTelemetryPageDto<DeviceMailQueueItemDto>;
}

// ── Действия очереди ──

export const deviceMailBindSchema = z.object({
  equipmentId: uuidSchema,
  kind: z.enum(DEVICE_IDENTITY_KINDS),
  /** Значение ключа как его увидел человек; нормализует сервер той же функцией, что и резолв. */
  value: z.string().min(1).max(200),
  note: z.string().max(500).default(''),
});
export type DeviceMailBindInput = z.infer<typeof deviceMailBindSchema>;

/**
 * Что вернулось после привязки. `appliedMessages` — не украшение отчёта: по опознающему ключу
 * привязка применяет ВСЕ подходящие накопленные письма, и человек обязан видеть, скольких она
 * коснулась.
 */
export interface DeviceMailBindResultDto {
  appliedMessages: number;
  observations: number;
  events: number;
  /**
   * Письма, которые отбор взял, а применить не удалось — снимка нет или он нечитаем. Молча
   * пометить их применёнными значило бы потерять; молча не считать — оставить человека в
   * уверенности, что очередь разобрана.
   */
  skippedMessages: number;
}

// ── Реестр ключей: заведение руками ──

/**
 * Роды ключей, которые человек заводит САМ — из карточки аппарата, не дожидаясь письма (план
 * `docs/office-equipment-mail-identity-ui-plan.md`, §6.1).
 *
 * Адресов здесь нет, и это не забывчивость. Адрес письма — свойство конверта, а не аппарата:
 * служебный ящик прописан парку целиком, и заведённый заранее «ключ по адресу» увёл бы к одной
 * карточке письма всего парка ещё до того, как их кто-нибудь увидит. Из очереди привязать по
 * адресу по-прежнему можно — но там она применяется к одному письму, на котором нажали.
 */
export const DEVICE_MANUAL_IDENTITY_KINDS = ['serial', 'inventory', 'deviceName', 'host'] as const;
export type DeviceManualIdentityKind = (typeof DEVICE_MANUAL_IDENTITY_KINDS)[number];

export function isManualIdentityKind(kind: DeviceIdentityKind): kind is DeviceManualIdentityKind {
  return (DEVICE_MANUAL_IDENTITY_KINDS as readonly DeviceIdentityKind[]).includes(kind);
}

export const deviceIdentityCreateSchema = z.object({
  equipmentId: uuidSchema,
  kind: z.enum(DEVICE_MANUAL_IDENTITY_KINDS),
  /** Значение как его видит человек; нормализует сервер той же функцией, что и резолв. */
  value: z.string().min(1).max(200),
  note: z.string().max(500).default(''),
});
export type DeviceIdentityCreateInput = z.infer<typeof deviceIdentityCreateSchema>;

/**
 * Снятие привязки. Примечание ОБЯЗАТЕЛЬНО, в отличие от заведения: снятие отвечает на вопрос
 * «почему полгода назад эти письма считались этим аппаратом, а теперь нет», и ответ на него,
 * кроме человека, дать некому.
 */
export const deviceIdentityRevokeSchema = z.object({
  note: z.string().min(1).max(500),
});
export type DeviceIdentityRevokeInput = z.infer<typeof deviceIdentityRevokeSchema>;

/**
 * Отбор реестра. Курсором, а не страницами: реестр пополняется разбором очереди прямо во время
 * просмотра, и нумерованные страницы при вставке в середину теряли бы строки молча — та же
 * причина, что у самой очереди.
 */
export const deviceIdentityQuerySchema = z.object({
  cursor: z.string().max(400).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(DEVICE_TELEMETRY_PAGE_SIZE),
  kind: z.enum(DEVICE_IDENTITY_KINDS).optional(),
  equipmentId: uuidSchema.optional(),
  /** Поиск по значению ключа: человек ищет серийник, который держит в руках. */
  search: z.string().max(200).optional(),
  /** Снятые привязки показываются по просьбе: они объясняют прошлое, а не работают. */
  includeRevoked: z.coerce.boolean().default(false),
});
export type DeviceIdentityQuery = z.infer<typeof deviceIdentityQuerySchema>;

export interface DeviceIdentityDto {
  id: string;
  kind: DeviceIdentityKind;
  value: string;
  equipmentId: string;
  /** Как аппарат назван в парке: модель плюс номер — тем же способом, что и в списке техники. */
  equipmentTitle: string;
  equipmentInventoryNumber: string;
  objectName: string;
  confirmedByName: string;
  confirmedAt: string;
  note: string;
  /** Снятая привязка остаётся видимой: по ней объясняют прошлое (план §5.1). */
  revokedAt: string | null;
  revokedByName: string;
  revokeNote: string;
}

/**
 * Сколько непривязанных писем применит этот ключ. Считается тем же отбором, что и применение, —
 * иначе кнопка обещала бы одно число, а делала другое.
 */
export interface DeviceIdentityApplyResultDto extends DeviceMailBindResultDto {
  /** Ключ, которым применяли: очередь и журнал обязаны уметь ответить «почему это он». */
  kind: DeviceIdentityKind;
  value: string;
}

// ── Правила разбора ──

/** Что правило добывает из письма. Одна таблица на оба рода — план §5.2. */
export const PARSE_RULE_TARGETS = ['identity', 'metric'] as const;
export type ParseRuleTarget = (typeof PARSE_RULE_TARGETS)[number];

export const parseRuleTargetLabels: Record<ParseRuleTarget, string> = {
  identity: 'Ключ опознания',
  metric: 'Показание',
};

/** Как ищем: метка перед значением или выражение с именованной группой `value`. */
export const PARSE_RULE_MATCH_KINDS = ['label', 'regex'] as const;
export type ParseRuleMatchKind = (typeof PARSE_RULE_MATCH_KINDS)[number];

export const parseRuleMatchKindLabels: Record<ParseRuleMatchKind, string> = {
  label: 'Метка перед значением',
  regex: 'Выражение',
};

/** Где искать. `any` — везде, где профиль ищет сам: тема, текст, таблицы письма и вложений. */
export const PARSE_RULE_SCOPES = ['any', 'subject', 'text', 'html', 'attachment'] as const;
export type ParseRuleScope = (typeof PARSE_RULE_SCOPES)[number];

export const parseRuleScopeLabels: Record<ParseRuleScope, string> = {
  any: 'Везде',
  subject: 'Тема письма',
  text: 'Текст письма',
  html: 'Таблицы письма',
  attachment: 'Вложения',
};

/**
 * Как читать найденное число. Две формы, и обе уже живут в разборе: обычное число и процент, у
 * которого дробная часть значима («40.5 %»), а группировка тысяч невозможна.
 */
export const PARSE_VALUE_FORMS = ['number', 'percent'] as const;
export type ParseValueForm = (typeof PARSE_VALUE_FORMS)[number];

export const parseValueFormLabels: Record<ParseValueForm, string> = {
  number: 'Число',
  percent: 'Проценты',
};

/** Роды ключей, которые правило вправе добывать. Адреса берутся из конверта и не ищутся. */
export const PARSE_RULE_IDENTITY_KINDS = DEVICE_MANUAL_IDENTITY_KINDS;

/** Потолок длины выражения. Он же барьер: длинное выражение — это почти всегда чужой текст. */
export const DEVICE_PARSE_RULE_EXPRESSION_MAX = 200;

/**
 * Сколько миллисекунд правилу дают на одно письмо. Выражение пишет человек, и катастрофический
 * возврат вешает разбор ВСЕЙ очереди, а не одного письма: тайм-аут — не оптимизация, а барьер.
 */
export const DEVICE_PARSE_RULE_TIMEOUT_MS = 50;

const parseRuleCommonShape = {
  matchKind: z.enum(PARSE_RULE_MATCH_KINDS),
  expression: z.string().min(1).max(DEVICE_PARSE_RULE_EXPRESSION_MAX),
  scope: z.enum(PARSE_RULE_SCOPES).default('any'),
  /** Профиль, для которого правило писано; `null` — для любого. */
  whenProfile: z.enum(DEVICE_PROFILE_CODES).nullable().default(null),
  whenFrom: z.string().max(200).default(''),
  whenSubject: z.string().max(200).default(''),
  /** Первое совпавшее правило своей цели выигрывает; порядок задаёт человек. */
  sortOrder: z.number().int().min(0).max(1000).default(100),
  isEnabled: z.boolean().default(true),
};

/**
 * Правило разбора. Различающим полем, а не «заполни нужное»: у правила ключа нет кода метрики, у
 * правила метрики нет рода ключа, и форма, позволяющая заполнить оба, рано или поздно их заполнит.
 *
 * ЕДИНИЦЫ У ПРАВИЛА НЕТ НИ ОДНОЙ СТРОКОЙ. Единица — свойство метрики (`metricUnits`), и второй её
 * носитель разошёлся бы с реестром на первой же правке.
 *
 * ОБЕ ВЕТВИ `.strict()`: правило ключа, которому дописали код метрики, — это ошибка человека, и
 * отвечать на неё надо `400` с именем поля. Молчаливое отбрасывание лишнего оставило бы его в
 * уверенности, что он завёл правило показания.
 */
export const deviceParseRuleInputSchema = z.discriminatedUnion('target', [
  z
    .object({
      target: z.literal('identity'),
      keyKind: z.enum(PARSE_RULE_IDENTITY_KINDS),
      ...parseRuleCommonShape,
    })
    .strict(),
  z
    .object({
      target: z.literal('metric'),
      metricCode: z.enum(METRIC_CODES),
      component: z.enum(COMPONENT_CODES).default(COMPONENT_NONE),
      valueForm: z.enum(PARSE_VALUE_FORMS).default('number'),
      ...parseRuleCommonShape,
    })
    .strict(),
]);
export type DeviceParseRuleInput = z.infer<typeof deviceParseRuleInputSchema>;

export interface DeviceParseRuleDto {
  id: string;
  target: ParseRuleTarget;
  /**
   * Заполнено у правила ключа, пусто у правила показания. Род УЖЕ, чем у привязки: адреса берутся
   * из конверта и правилами не ищутся, и тип обязан говорить это сам — иначе форма правила
   * предлагала бы выбрать то, чего разбор не умеет.
   */
  keyKind: DeviceManualIdentityKind | null;
  metricCode: MetricCode | null;
  component: ComponentCode | null;
  valueForm: ParseValueForm | null;
  matchKind: ParseRuleMatchKind;
  expression: string;
  scope: ParseRuleScope;
  whenProfile: DeviceProfileCode | null;
  whenFrom: string;
  whenSubject: string;
  sortOrder: number;
  isEnabled: boolean;
  updatedAt: string;
  updatedByName: string;
  /** Правило, ни разу не применявшееся, можно удалить совсем; остальные только выключают (Р4). */
  canDelete: boolean;
}

/** Исход резолва словами — для проверки правила на живом письме. */
export const DEVICE_IDENTITY_RESOLUTION_STATUSES = ['matched', 'unmatched', 'ambiguous'] as const;
export type DeviceIdentityResolutionStatus = (typeof DEVICE_IDENTITY_RESOLUTION_STATUSES)[number];

/**
 * Проверка правила на письме: черновик правила плюс письмо. Черновик, а не сохранённое правило, —
 * в этом весь смысл: посмотреть, ЧТО ПОЛУЧИТСЯ, человек обязан до того, как правило начнёт менять
 * разбор всего парка.
 */
export const deviceParseRulePreviewSchema = z.object({
  messageId: uuidSchema,
  rule: deviceParseRuleInputSchema,
});
export type DeviceParseRulePreviewInput = z.infer<typeof deviceParseRulePreviewSchema>;

export interface DeviceParseRulePreviewDto {
  /** Условия применимости (профиль, отправитель, тема) совпали. */
  applies: boolean;
  /** Выражение что-то нашло. */
  found: boolean;
  /** Как это написано в письме — дословно. */
  rawValue: string;
  /** Что ляжет: нормализованный ключ или число показания. */
  value: string;
  /** Подпись единицы у показания; у ключа пусто. */
  unitLabel: string;
  /**
   * Что сказал бы резолв с этим ключом. `null` у правила показания: показание само по себе аппарат
   * не опознаёт, и обещать обратное экрану нельзя.
   */
  resolution: {
    status: DeviceIdentityResolutionStatus;
    equipmentId: string | null;
    equipmentTitle: string;
  } | null;
  /** Объяснение словами: почему не применилось, почему не нашлось, чем опознало. */
  note: string;
}

import { COMPONENT_NONE, deviceEventSeverityDefaults, metricUnits } from '@technic/contracts';
import type {
  ComponentCode,
  DeviceEventCode,
  DeviceEventInput,
  DeviceEventSeverity,
  DeviceIdentityHints,
  DeviceMailContext,
  DeviceObservationInput,
  MetricCode,
  ParsedDeviceMessage,
} from '@technic/contracts';

/**
 * Общая часть профилей вендоров (план `docs/office-equipment-mail-telemetry-plan.md` §8).
 *
 * **Второго интерфейса профиля здесь нет и быть не может.** `DeviceProfile` объявлен в замороженном
 * контракте, и смысл заморозки ровно в том, что восемь параллельных пакетов работ читают одно
 * объявление. Этот файл — реэкспорт для удобства импорта плюс сборщики полей, и ни одна из его
 * функций не добавляет профилю обязанностей.
 *
 * Сборщики существуют по одной причине: **единица и важность по умолчанию берутся из реестра, а не
 * пишутся профилем руками**. Р22 обещает, что единица — свойство метрики; профиль, дописавший её
 * сам, разойдётся с реестром, и письмо уйдёт в `failed` (`unit_mismatch`) у нормализатора. Пусть
 * лучше он вовсе не сможет её назвать.
 */

export type { DeviceMailContext, DeviceProfile } from '@technic/contracts';

/** То, что отдаёт `parse`: код профиля и его версию подставляет нормализатор. */
export type ProfileParseResult = Omit<ParsedDeviceMessage, 'profileCode' | 'parserVersion'>;

/** Подсказок нет ни одной — это законное состояние, а не пропуск полей. */
export function emptyIdentityHints(): DeviceIdentityHints {
  return { serial: null, inventory: null, deviceName: null, host: null, ip: null, model: null };
}

export function emptyParseResult(): ProfileParseResult {
  return { observations: [], events: [], identity: emptyIdentityHints() };
}

/**
 * Границы длины подсказок опознания — те же, что в схеме контракта
 * (`deviceIdentityHintsSchema`): двести знаков на всё, кроме адреса сети.
 */
const IDENTITY_HINT_LIMIT = 200;
const IDENTITY_IP_LIMIT = 60;

function limitHint(value: string | null, limit: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, limit);
}

/**
 * Подсказки в границах контракта.
 *
 * Обрезка здесь — не педантизм, а спасение письма. Метка `Device Name:` со строкой в двести
 * пятьдесят знаков (прошивка пишет туда всё описание аппарата) не проходит схему снимка, и письмо
 * уходит в `failed` с пустым снимком — то есть **выпадает из очереди образцов**, а человек теряет
 * серийник и IP, по которым только и мог привязать его руками (Р13, Р20). Обрезанная подсказка
 * хуже целой, но она есть; отсутствующая не помогает никому.
 *
 * Пустая строка приводится к `null`: «метка нашлась, значения не было» — это отсутствие подсказки,
 * и хранить её значением значило бы предлагать человеку привязку по пустому ключу.
 */
export function limitIdentityHints(hints: DeviceIdentityHints): DeviceIdentityHints {
  return {
    serial: limitHint(hints.serial, IDENTITY_HINT_LIMIT),
    inventory: limitHint(hints.inventory, IDENTITY_HINT_LIMIT),
    deviceName: limitHint(hints.deviceName, IDENTITY_HINT_LIMIT),
    host: limitHint(hints.host, IDENTITY_HINT_LIMIT),
    ip: limitHint(hints.ip, IDENTITY_IP_LIMIT),
    model: limitHint(hints.model, IDENTITY_HINT_LIMIT),
  };
}

/**
 * Наблюдение с единицей **из реестра метрик**. Значение — уже приведённая строка (см.
 * `extract.parseNumericValue`): здесь оно не разбирается, потому что «как читать число» — знание
 * общее, а «какая метка что значит» — знание профиля.
 */
export function observation(params: {
  metricCode: MetricCode;
  value: string;
  component?: ComponentCode;
  deviceTime?: string | null;
  rawLabel?: string;
}): DeviceObservationInput {
  return {
    metricCode: params.metricCode,
    component: params.component ?? COMPONENT_NONE,
    value: params.value,
    unit: metricUnits[params.metricCode],
    deviceTime: params.deviceTime ?? null,
    rawLabel: (params.rawLabel ?? '').slice(0, 200),
  };
}

/**
 * Событие с важностью по умолчанию для кода. Профиль вправе поднять её — аппарат сам сказал «вызов
 * сервиса», — но не обязан держать в голове весь словарь.
 *
 * `vendorCode` и `text` — открытая часть Р29: код вендора как есть, без словаря и без проверки.
 */
export function deviceEvent(params: {
  eventCode: DeviceEventCode;
  severity?: DeviceEventSeverity;
  deviceTime?: string | null;
  vendorCode?: string;
  text?: string;
  ordinal?: number;
}): DeviceEventInput {
  return {
    eventCode: params.eventCode,
    severity: params.severity ?? deviceEventSeverityDefaults[params.eventCode],
    deviceTime: params.deviceTime ?? null,
    vendorCode: (params.vendorCode ?? '').slice(0, 100),
    text: (params.text ?? '').slice(0, 2000),
    /**
     * Ноль здесь — не «первое событие», а «номер ещё не назначен»: профиль не обязан считать
     * вхождения своего кода по всему письму. Настоящий номер проставляет `assignEventOrdinals` при
     * нормализации, и та же функция зовётся на применении снимка — иначе перечитывание разошлось бы
     * с первой записью ключом уникальности.
     */
    ordinal: params.ordinal ?? 0,
  };
}

/**
 * Время аппарата для полей `deviceTime` — из заголовка `Date`, если письмо не сказало иначе.
 * Справочное значение (Р21): порядок ряда задаёт момент приёма порталом, а не эти часы.
 */
export function deviceTimeOf(ctx: DeviceMailContext): string | null {
  return ctx.dateHeader;
}

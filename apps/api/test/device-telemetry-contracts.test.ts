import { describe, expect, it } from 'vitest';
import {
  COMPONENT_CODES,
  COMPONENT_NONE,
  DEVICE_ERROR_CLASSES,
  DEVICE_ERROR_CODES,
  DEVICE_EVENT_CODES,
  DEVICE_EVENT_SEVERITIES,
  DEVICE_IDENTIFYING_KINDS,
  DEVICE_IDENTITY_KINDS,
  DEVICE_MAIL_STUCK_ATTEMPTS,
  DEVICE_MESSAGE_FINAL_STATUSES,
  DEVICE_MESSAGE_STATUSES,
  DEVICE_PAUSE_ERROR_CODES,
  DEVICE_PROFILE_CODES,
  DEVICE_RAW_STATES,
  METRIC_CODES,
  METRIC_UNITS,
  TELEMETRY_SOURCES,
  componentLabels,
  deviceErrorClasses,
  deviceEventLabels,
  deviceEventSeverityDefaults,
  deviceIdentityLabels,
  deviceMessageStatusLabels,
  deviceObservationInputSchema,
  isFinalDeviceMessageStatus,
  isIdentifyingKind,
  isPauseErrorCode,
  metricIsCumulative,
  metricLabels,
  metricUnits,
  normalizeIdentityValue,
  encodeDeviceCursor,
  decodeDeviceCursor,
  DEVICE_CURSOR_LANES,
  parsedDeviceMessageSchema,
  telemetrySourceLabels,
} from '@technic/contracts';

/**
 * Словарь телеметрии оргтехники (план `docs/office-equipment-mail-telemetry-plan.md`, Р5, Р29, Р33).
 *
 * Тест лежит здесь, а не рядом с контрактами: у пакета контрактов прогон объявлен заглушкой
 * (`echo "contracts: no tests"`), и тест там не запустился бы никогда. Прецедент —
 * `user-email-change-contracts.test.ts`.
 *
 * Стережёт он ровно одно свойство, на котором стоит весь замысел: **закрытая часть словаря должна
 * оставаться закрытой и полной**. Восемь параллельных пакетов работ читают этот файл как единственный
 * источник кодов; код без подписи, единицы или важности — это не «недозаполненная таблица», а
 * реализация, которая додумает значение сама и разойдётся с соседней.
 */
describe('словарь телеметрии оргтехники', () => {
  const unique = (values: readonly string[]) => new Set(values).size === values.length;

  it('перечни не содержат повторов', () => {
    expect(unique(METRIC_CODES)).toBe(true);
    expect(unique(DEVICE_EVENT_CODES)).toBe(true);
    expect(unique(COMPONENT_CODES)).toBe(true);
    expect(unique(DEVICE_PROFILE_CODES)).toBe(true);
    expect(unique(DEVICE_MESSAGE_STATUSES)).toBe(true);
    expect(unique(DEVICE_RAW_STATES)).toBe(true);
    expect(unique(DEVICE_ERROR_CODES)).toBe(true);
    expect(unique(DEVICE_IDENTITY_KINDS)).toBe(true);
    expect(unique(TELEMETRY_SOURCES)).toBe(true);
  });

  /**
   * Пропуск здесь стоит дороже, чем кажется: метрика без единицы заставит разбор выдумать её на
   * месте, а проверка «снимок против реестра» (Р22) начнёт отправлять в `failed` правильные письма.
   */
  it('у каждой метрики есть единица, подпись и объявленная накопительность', () => {
    for (const code of METRIC_CODES) {
      expect(METRIC_UNITS, `единица метрики ${code}`).toContain(metricUnits[code]);
      expect(metricLabels[code]?.length ?? 0, `подпись метрики ${code}`).toBeGreaterThan(0);
      expect(typeof metricIsCumulative[code], `накопительность метрики ${code}`).toBe('boolean');
    }
  });

  it('накопительные метрики и уровни расходников разведены', () => {
    expect(metricIsCumulative.marker_life_total).toBe(true);
    // Уровень тонера падает от печати и прыгает вверх при замене: складывать его за период нельзя.
    expect(metricIsCumulative.supply_level_percent).toBe(false);
  });

  it('у каждого события есть подпись и важность по умолчанию', () => {
    for (const code of DEVICE_EVENT_CODES) {
      expect(deviceEventLabels[code]?.length ?? 0, `подпись события ${code}`).toBeGreaterThan(0);
      expect(DEVICE_EVENT_SEVERITIES, `важность события ${code}`).toContain(
        deviceEventSeverityDefaults[code],
      );
    }
  });

  /**
   * `other` — законный исход, а не заглушка (Р29): им приезжает событие, которого нет в словаре,
   * вместе с вендорской строкой. Убери его — и разбор начнёт терять то, чего не ждал.
   */
  it('у событий есть код «прочее», и он не критический', () => {
    expect(DEVICE_EVENT_CODES).toContain('other');
    expect(deviceEventSeverityDefaults.other).toBe('info');
  });

  it('разрез «нет разреза» — пустая строка, а не отсутствие значения', () => {
    expect(COMPONENT_NONE).toBe('');
    expect(COMPONENT_CODES).toContain(COMPONENT_NONE);
    for (const code of COMPONENT_CODES) {
      expect(typeof componentLabels[code], `подпись разреза ${code || 'нет разреза'}`).toBe(
        'string',
      );
    }
  });

  it('цветной аппарат разводится разрезами, а не кодами метрик', () => {
    // Письмо об уровнях у Ricoh Aficio MP C2011SP несёт четыре тонера одним кодом метрики (Р33).
    for (const component of ['black', 'cyan', 'magenta', 'yellow'] as const) {
      expect(COMPONENT_CODES).toContain(component);
    }
  });

  it('у каждого статуса письма есть подпись, а конечные статусы — подмножество всех', () => {
    for (const status of DEVICE_MESSAGE_STATUSES) {
      expect(deviceMessageStatusLabels[status]?.length ?? 0, `подпись статуса ${status}`).toBeGreaterThan(0);
    }
    for (const status of DEVICE_MESSAGE_FINAL_STATUSES) {
      expect(DEVICE_MESSAGE_STATUSES).toContain(status);
    }
    // `received` — единственный незавершённый: на нём стоит развилка повторной сдачи (§9.1, п. 5).
    expect(isFinalDeviceMessageStatus('received')).toBe(false);
    expect(DEVICE_MESSAGE_STATUSES.filter((s) => !isFinalDeviceMessageStatus(s))).toEqual([
      'received',
    ]);
  });

  it('у каждого кода отказа объявлен класс', () => {
    for (const code of DEVICE_ERROR_CODES) {
      expect(DEVICE_ERROR_CLASSES, `класс отказа ${code}`).toContain(deviceErrorClasses[code]);
    }
  });

  /**
   * Код паузы обязан быть временным, и это не тавтология: отнеси его к терминальным — и письмо
   * закроется строкой вместо того, чтобы дождаться включения рубильника (§9.1, п. 7).
   */
  it('коды паузы временные и счётчик застревания их не считает', () => {
    for (const code of DEVICE_PAUSE_ERROR_CODES) {
      expect(DEVICE_ERROR_CODES).toContain(code);
      expect(deviceErrorClasses[code], `класс кода паузы ${code}`).toBe('transient');
      expect(isPauseErrorCode(code)).toBe(true);
    }
    expect(isPauseErrorCode('malformed')).toBe(false);
    expect(DEVICE_MAIL_STUCK_ATTEMPTS).toBeGreaterThan(1);
  });

  it('опознающие ключи — подмножество ключей, и адреса в него не входят', () => {
    for (const kind of DEVICE_IDENTITY_KINDS) {
      expect(deviceIdentityLabels[kind]?.length ?? 0, `подпись ключа ${kind}`).toBeGreaterThan(0);
    }
    for (const kind of DEVICE_IDENTIFYING_KINDS) {
      expect(DEVICE_IDENTITY_KINDS).toContain(kind);
    }
    // Пачкой по адресу привязывать нельзя: у парка сплошь и рядом один служебный отправитель (Р20).
    expect(isIdentifyingKind('fromAddress')).toBe(false);
    expect(isIdentifyingKind('envelopeTo')).toBe(false);
    expect(isIdentifyingKind('serial')).toBe(true);
  });

  it('нормализация ключа совпадает с формой уникальных индексов карточки', () => {
    // `upper(btrim(...))` и ничего сверх: пробелы по краям, регистр — и всё.
    expect(normalizeIdentityValue('  e323m320679 ')).toBe('E323M320679');
    // Внутренний пробел НЕ схлопывается: у номера, склеенного из разорванной строки учёта,
    // схлопывание дало бы значение, которого в индексе нет, и резолв прошёл бы мимо живой карточки.
    expect(normalizeIdentityValue('3282 Z920584')).toBe('3282 Z920584');
    // Неразрывный пробел `btrim` не срезает — не срезаем и мы, иначе формы разойдутся.
    expect(normalizeIdentityValue('\u00a0w3 9m300123')).toBe('\u00a0W3 9M300123');
  });

  it('у каждого источника есть подпись', () => {
    for (const source of TELEMETRY_SOURCES) {
      expect(telemetrySourceLabels[source]?.length ?? 0, `подпись источника ${source}`).toBeGreaterThan(0);
    }
    // Коллектор Этапа 2 входит тем же словарём — это единственное обязательство Этапа 1 перед ним (Р4).
    expect(TELEMETRY_SOURCES).toContain('collector');
  });

  it('профиль «не понял» существует и он полноправный', () => {
    expect(DEVICE_PROFILE_CODES).toContain('unknown');
  });
});

describe('курсор постраничного чтения', () => {
  const sample = { observedAt: '2026-09-17T10:00:00.123456Z', id: '1f0b5d9e-0000-4000-8000-000000000001' };

  it('свой курсор читается обратно без потерь', () => {
    for (const lane of DEVICE_CURSOR_LANES) {
      expect(decodeDeviceCursor(lane, encodeDeviceCursor(lane, sample))).toEqual(sample);
    }
  });

  /**
   * Главное свойство, ради которого лента запечатана в сам курсор. До правки оба экрана модуля
   * выдавали одинаковые строки, и курсор ленты событий, подставленный в очередь разбора,
   * разбирался и становился якорем по чужому ряду — страница молча открывалась не с того места.
   */
  it('чужая лента не декодируется вовсе', () => {
    const events = encodeDeviceCursor('device-events', sample);
    expect(decodeDeviceCursor('device-mail-queue', events)).toBeNull();
    const queue = encodeDeviceCursor('device-mail-queue', sample);
    expect(decodeDeviceCursor('device-events', queue)).toBeNull();
  });

  it('мусор не читается и не бросает', () => {
    for (const raw of ['', '1~device-events~', 'что-то своё', '1~device-events~только-время']) {
      expect(decodeDeviceCursor('device-events', raw)).toBeNull();
    }
  });

  it('микросекунды переживают оборот', () => {
    // Пачка писем, прочитанная после паузы, ложится десятками строк в одну миллисекунду приёма:
    // курсор, потерявший точность, уронил бы часть страницы.
    const decoded = decodeDeviceCursor('device-events', encodeDeviceCursor('device-events', sample));
    expect(decoded?.observedAt).toBe('2026-09-17T10:00:00.123456Z');
  });
});

describe('схемы входа нормализатора', () => {
  it('значение наблюдения принимается строкой и держит длинный счётчик', () => {
    const parsed = deviceObservationInputSchema.parse({
      metricCode: 'marker_life_total',
      value: '123456789012',
      unit: 'impressions',
    });
    expect(parsed.value).toBe('123456789012');
    // Разрез по умолчанию — пустая строка, а не отсутствие: он часть уникального ключа (Р33).
    expect(parsed.component).toBe(COMPONENT_NONE);
    expect(parsed.deviceTime).toBeNull();
  });

  it('значение наблюдения не принимается числом с плавающей точкой из JSON', () => {
    const bad = deviceObservationInputSchema.safeParse({
      metricCode: 'marker_life_total',
      value: 123456789012,
      unit: 'impressions',
    });
    expect(bad.success).toBe(false);
  });

  it('снимок разбора несёт версию разборщика', () => {
    const snapshot = parsedDeviceMessageSchema.parse({
      profileCode: 'unknown',
      parserVersion: 1,
      observations: [],
      events: [],
      identity: {},
    });
    // Снимок применяется КАК ЕСТЬ через месяцы, и он обязан помнить, какими правилами сделан (Р20).
    expect(snapshot.parserVersion).toBe(1);
    expect(snapshot.identity.serial).toBeNull();
  });
});

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMPONENT_NONE } from '@technic/contracts';
import type {
  ComponentCode,
  DeviceMailContext,
  DeviceProfile,
  MetricCode,
} from '@technic/contracts';
import {
  allTables,
  findLabeledValue,
  findNumericValue,
  normalizeLabel,
  parseNumericValue,
  parsePercentValue,
  textLines,
} from '../src/services/device-mail/extract';
import { extractHtmlTables, parseDeviceMail } from '../src/services/device-mail/mime';
import {
  DeviceParseError,
  assignEventOrdinals,
  normalizeParsedMessage,
  normalizeProfileResult,
} from '../src/services/device-mail/normalize';
import {
  deviceEvent,
  emptyIdentityHints,
  observation,
  type ProfileParseResult,
} from '../src/services/device-mail/profiles/types';
import {
  UNKNOWN_PROFILE_CONFIDENCE,
  unknownProfile,
} from '../src/services/device-mail/profiles/unknown';

/**
 * Разбор письма аппарата: MIME, общая вычитка, профиль «не поняли» и нормализатор
 * (план `docs/office-equipment-mail-telemetry-plan.md` §8, §12; Р13, Р22, Р33).
 *
 * Гоняется на **синтетических** письмах, сочинённых этим же пакетом работ. Они не являются
 * доказательством пригодности ни одной модели МФУ — это проверка разборщика, и у каждого файла это
 * сказано словом в заголовках `X-Fixture-*`. Живые письма пилота приезжают отдельным каталогом
 * вместе с профилем вендора.
 *
 * Профиль в этом файле **свой, испытательный**. Причина прямая: вендорских профилей в первой волне
 * нет вовсе (они ждут разведки на аппаратах), а `unknown` наблюдений не даёт по определению — и
 * тогда проверять разрез `component` и порядковый номер события было бы не на чем. Испытательный
 * профиль написан ровно теми средствами `extract.ts`, которыми будет написан Ricoh: если их не
 * хватает на такое письмо, не хватит и на живое.
 */

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/device-mail/synthetic/', import.meta.url));

function fixtureNames(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.eml'))
    .sort();
}

function readFixture(name: string): Buffer {
  return readFileSync(`${FIXTURE_DIR}${name}`);
}

async function contextOf(name: string): Promise<DeviceMailContext> {
  return parseDeviceMail(readFixture(name), { envelopeTo: 'devices@portal.example.test' });
}

// ── Испытательный профиль ──

/** Счётчики: метка → код метрики. Обе локали прошивки сразу — их меняют вместе с языком меню. */
const COUNTER_SPECS: { metricCode: MetricCode; labels: string[] }[] = [
  { metricCode: 'marker_life_total', labels: ['общий счётчик', 'total counter'] },
  {
    metricCode: 'printed_impressions_total',
    labels: ['напечатано оттисков', 'printed impressions'],
  },
  { metricCode: 'printed_sheets_total', labels: ['напечатано листов', 'printed sheets'] },
  { metricCode: 'printed_mono_total', labels: ['чёрно-белая печать', 'mono prints'] },
  { metricCode: 'printed_color_total', labels: ['цветная печать', 'color prints'] },
];

/** Уровни расходников: метка → разрез. Порядок K, C, M, Y — он же порядок строк письма. */
const SUPPLY_SPECS: { component: ComponentCode; labels: string[] }[] = [
  { component: 'black', labels: ['тонер k', 'toner black', 'остаток тонера'] },
  { component: 'cyan', labels: ['тонер c', 'toner cyan'] },
  { component: 'magenta', labels: ['тонер m', 'toner magenta'] },
  { component: 'yellow', labels: ['тонер y', 'toner yellow'] },
];

/** Событие узнаётся по подстроке: в письме оно и метка строки, и значение ячейки состояния. */
const EVENT_SPECS: { eventCode: 'toner_low' | 'paper_jam' | 'cover_open'; needle: string }[] = [
  { eventCode: 'toner_low', needle: 'заканчивается тонер' },
  { eventCode: 'paper_jam', needle: 'замятие бумаги' },
  { eventCode: 'cover_open', needle: 'открыта крышка' },
];

/**
 * Поверхность, с которой читаются события. Есть HTML-таблицы — читаем их ячейки; нет — строки
 * текста и вложений. Правило нарочно простое и одно на письмо: разбирая обе поверхности сразу, мы
 * считали бы одно и то же событие дважды (у письма с таблицей `text` — её же плоский пересказ), а
 * `ordinal` обязан различать настоящие повторы, а не пересказы.
 */
function eventSurface(ctx: DeviceMailContext): string[] {
  if (ctx.tables.length > 0) return ctx.tables.flatMap((table) => table.flatMap((row) => [...row]));
  return textLines(ctx);
}

const syntheticProfile: DeviceProfile = {
  code: 'unknown',
  version: 1,
  detect: () => 0.5,
  parse: (ctx) => {
    const observations = [];
    for (const spec of COUNTER_SPECS) {
      const value = findNumericValue(ctx, spec.labels);
      if (value !== null) {
        observations.push(
          observation({ metricCode: spec.metricCode, value, rawLabel: spec.labels[0] }),
        );
      }
    }
    for (const spec of SUPPLY_SPECS) {
      const raw = findLabeledValue(ctx, spec.labels);
      const value = raw === null ? null : parsePercentValue(raw);
      if (value !== null) {
        observations.push(
          observation({
            metricCode: 'supply_level_percent',
            component: spec.component,
            value,
            rawLabel: spec.labels[0],
          }),
        );
      }
    }
    const events = [];
    for (const chunk of eventSurface(ctx)) {
      const normalized = normalizeLabel(chunk);
      for (const spec of EVENT_SPECS) {
        if (normalized.includes(spec.needle)) {
          events.push(
            deviceEvent({
              eventCode: spec.eventCode,
              vendorCode: chunk,
              text: chunk,
              deviceTime: ctx.dateHeader,
            }),
          );
        }
      }
    }
    return { observations, events, identity: unknownProfile.parse(ctx).identity };
  },
};

// ── Ожидания по каждому письму ──

interface Expectation {
  subject: string;
  serial: string;
  deviceName: string | null;
  ip: string | null;
  observations: [MetricCode, ComponentCode, string][];
  events: [string, number][];
}

const EXPECTED: Record<string, Expectation> = {
  '01-plain-counters.eml': {
    subject: 'Counter report SYN0001AA',
    serial: 'SYN0001AA',
    deviceName: 'SYN-MFP-01',
    ip: '10.20.30.41',
    observations: [
      ['marker_life_total', COMPONENT_NONE, '1234567'],
      ['printed_sheets_total', COMPONENT_NONE, '987654'],
      ['printed_mono_total', COMPONENT_NONE, '1100000'],
      ['printed_color_total', COMPONENT_NONE, '134567'],
      ['supply_level_percent', 'black', '45'],
    ],
    events: [],
  },
  '02-html-table-counters.eml': {
    subject: 'Отчёт о счётчиках SYN0002BB',
    serial: 'SYN0002BB',
    deviceName: 'SYN-MFP-02',
    ip: '10.20.30.42',
    observations: [
      ['marker_life_total', COMPONENT_NONE, '2000100'],
      ['printed_impressions_total', COMPONENT_NONE, '1750050'],
      ['supply_level_percent', 'black', '72'],
    ],
    events: [],
  },
  '03-multipart-csv.eml': {
    subject: 'Еженедельный отчёт SYN0003CC',
    serial: 'SYN0003CC',
    deviceName: 'SYN-MFP-03',
    ip: '10.20.30.43',
    observations: [
      ['marker_life_total', COMPONENT_NONE, '3141592'],
      ['printed_sheets_total', COMPONENT_NONE, '2718281'],
      ['supply_level_percent', 'black', '31'],
    ],
    events: [],
  },
  '04-windows-1251.eml': {
    subject: 'Аппарат SYN0004DD: замятие бумаги',
    serial: 'SYN0004DD',
    deviceName: 'SYN-MFP-04',
    ip: '10.20.30.44',
    observations: [['marker_life_total', COMPONENT_NONE, '4004004']],
    // Тело, затем вложение: замятие в теле — нулевое, во вложении — первое.
    events: [
      ['paper_jam', 0],
      ['cover_open', 0],
      ['paper_jam', 1],
    ],
  },
  '05-color-toner-levels.eml': {
    subject: 'Уровни тонера SYN0005EE',
    serial: 'SYN0005EE',
    deviceName: 'SYN-MFP-05',
    ip: '10.20.30.45',
    observations: [
      ['supply_level_percent', 'black', '8'],
      ['supply_level_percent', 'cyan', '62'],
      ['supply_level_percent', 'magenta', '47'],
      ['supply_level_percent', 'yellow', '5'],
    ],
    events: [
      ['toner_low', 0],
      ['toner_low', 1],
      ['cover_open', 0],
    ],
  },
};

describe('разбор письма аппарата', () => {
  it('каталог фикстур — пять писем, и все они объявлены синтетическими', async () => {
    const names = fixtureNames();
    expect(names).toEqual(Object.keys(EXPECTED).sort());
    for (const name of names) {
      const ctx = await contextOf(name);
      // Дисклеймер живёт в самом файле, а не в README каталога: письмо уедет в отчёт или в
      // обсуждение поодиночке, и там оно обязано отвечать за себя само.
      expect(ctx.headers['x-fixture-note']).toContain('СИНТЕТИЧЕСКОЕ');
      expect(ctx.headers['x-fixture-disclaimer']).toContain('Доказательством пригодности');
    }
  });

  it('MIME даёт заголовки, тексты и адреса', async () => {
    for (const [name, expected] of Object.entries(EXPECTED)) {
      const ctx = await contextOf(name);
      expect(ctx.subject, name).toBe(expected.subject);
      expect(ctx.fromAddress, name).toMatch(/@device\.example\.test$/u);
      expect(ctx.envelopeTo, name).toBe('devices@portal.example.test');
      expect(ctx.messageIdHeader, name).toContain('@device.example.test');
      expect(ctx.dateHeader, name).toBe(new Date(ctx.headers.date ?? '').toISOString());
    }
  });

  /**
   * У письма 03 заголовок `To` направлен на групповой адрес — так и бывает в жизни: ИТ-служба
   * прописывает парку рассылку, а в наш ящик письмо попадает конвертом. Без разного `To` проверка
   * адреса конверта не различала бы вообще ничего: смена приоритета в `mime.ts` прошла бы её.
   */
  it('адрес конверта приходит от приёмника, а заголовок остаётся заголовком', async () => {
    const name = '03-multipart-csv.eml';
    const ctx = await contextOf(name);
    expect(ctx.headers.to).toBe('office-devices-group@portal.example.test');
    expect(ctx.envelopeTo).toBe('devices@portal.example.test');

    // Приёмник адреса не назвал (прогон на `.eml` без IMAP) — умолчанием берётся `To`.
    const withoutEnvelope = await parseDeviceMail(readFixture(name));
    expect(withoutEnvelope.envelopeTo).toBe('office-devices-group@portal.example.test');
  });

  it('каждое письмо разбирается в ожидаемые наблюдения и события', async () => {
    for (const [name, expected] of Object.entries(EXPECTED)) {
      const ctx = await contextOf(name);
      const parsed = normalizeParsedMessage(syntheticProfile, ctx);
      expect(
        parsed.observations.map((item) => [item.metricCode, item.component, item.value]),
        name,
      ).toEqual(expected.observations);
      expect(
        parsed.events.map((item) => [item.eventCode, item.ordinal]),
        name,
      ).toEqual(expected.events);
      expect(parsed.identity.serial, name).toBe(expected.serial);
      expect(parsed.identity.deviceName, name).toBe(expected.deviceName);
      expect(parsed.identity.ip, name).toBe(expected.ip);
    }
  });

  it('единица наблюдения берётся из реестра метрик', async () => {
    const parsed = normalizeParsedMessage(
      syntheticProfile,
      await contextOf('01-plain-counters.eml'),
    );
    const units = Object.fromEntries(
      parsed.observations.map((item) => [item.metricCode, item.unit]),
    );
    expect(units.marker_life_total).toBe('impressions');
    expect(units.printed_sheets_total).toBe('sheets');
    expect(units.supply_level_percent).toBe('percent');
  });
});

describe('цветное письмо об уровнях тонера', () => {
  const NAME = '05-color-toner-levels.eml';

  it('даёт четыре строки одного кода метрики с разными разрезами (Р33)', async () => {
    const parsed = normalizeParsedMessage(syntheticProfile, await contextOf(NAME));
    const levels = parsed.observations.filter((item) => item.metricCode === 'supply_level_percent');
    expect(levels).toHaveLength(4);
    expect(levels.map((item) => item.component)).toEqual(['black', 'cyan', 'magenta', 'yellow']);
    expect(new Set(levels.map((item) => item.component)).size).toBe(4);
    expect(levels.map((item) => item.value)).toEqual(['8', '62', '47', '5']);
    for (const level of levels) expect(level.unit).toBe('percent');
  });

  /**
   * Номера утверждаются ПО СНИМКУ, без вызова хелпера: иначе проверялся бы хелпер, а снимок мог
   * уезжать в базу с нулями у всех событий — ровно то, что Р33 запрещает («номер назначает
   * разбор и кладёт в снимок»).
   */
  it('снимок несёт ordinal, и повторный разбор даёт те же номера', async () => {
    const first = normalizeParsedMessage(syntheticProfile, await contextOf(NAME));
    const second = normalizeParsedMessage(syntheticProfile, await contextOf(NAME));
    expect(first.events.map((item) => item.ordinal)).toEqual([0, 1, 0]);
    expect(first.events.map((item) => [item.eventCode, item.ordinal])).toEqual([
      ['toner_low', 0],
      ['toner_low', 1],
      ['cover_open', 0],
    ]);
    expect(second.events).toEqual(first.events);
    // Пересчёт снимка той же функцией ничего не меняет: операция идемпотентна, и применение
    // снимка (A4) считает номера ею же.
    expect(assignEventOrdinals(first.events)).toEqual(first.events);
  });

  it('разрез входит в ключ: четыре наблюдения не схлопываются в одно', async () => {
    const parsed = normalizeParsedMessage(syntheticProfile, await contextOf(NAME));
    const keys = parsed.observations.map((item) => `${item.metricCode}/${item.component}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('MIME: кодировки, таблицы и вложения', () => {
  it('windows-1251 в теле и теме, KOI8-R во вложении', async () => {
    const ctx = await contextOf('04-windows-1251.eml');
    expect(ctx.subject).toBe('Аппарат SYN0004DD: замятие бумаги');
    expect(ctx.text).toContain('Серийный номер: SYN0004DD');
    expect(ctx.text).toContain('Инвентарный номер: ИНВ-100-004');
    expect(ctx.attachments).toHaveLength(1);
    const journal = ctx.attachments[0]!;
    expect(journal.filename).toBe('journal.txt');
    expect(journal.text).toContain('Открыта крышка');
    expect(journal.text).toContain('Замятие бумаги');
  });

  it('таблица HTML приводится к строкам ячеек, неразрывный пробел числу не мешает', async () => {
    const ctx = await contextOf('02-html-table-counters.eml');
    expect(ctx.tables).toHaveLength(1);
    const table = ctx.tables[0]!;
    expect(table[0]).toEqual(['Показатель', 'Значение']);
    expect(table[1]).toEqual(['Серийный номер', 'SYN0002BB']);
    expect(table[5]).toEqual(['Общий счётчик', '2 000 100']);
    expect(parseNumericValue(table[5]![1]!)).toBe('2000100');
  });

  it('CSV-вложение становится такой же таблицей, как таблица письма', async () => {
    const ctx = await contextOf('03-multipart-csv.eml');
    expect(ctx.tables).toHaveLength(0);
    expect(ctx.attachments[0]?.contentType).toBe('text/csv');
    const tables = allTables(ctx);
    expect(tables).toHaveLength(1);
    expect(tables[0]![0]).toEqual(['Показатель', 'Значение']);
    expect(findLabeledValue(ctx, ['напечатано листов'])).toBe('2 718 281');
  });

  it('вложенная таблица становится отдельной, а незакрытая всё равно отдаётся', () => {
    const tables = extractHtmlTables(
      '<table><tr><td>внешняя</td><td><table><tr><td>внутренняя</td></tr></table></td></tr></table>' +
        '<table><tr><td>без закрытия</td>',
    );
    expect(tables).toEqual([[['внешняя', '']], [['внутренняя']], [['без закрытия']]]);
  });

  /**
   * `<td>метка<td>число` без закрывающих тегов — законный HTML и обычная вёрстка прошивки.
   * Проход, накапливающий текст только на следующем теге, терял здесь **последнюю колонку**, то
   * есть ровно значение; случай про незакрытую таблицу выше этого не ловил (`</td>` там закрыт).
   */
  it('последняя ячейка без закрывающего тега не теряется', () => {
    expect(extractHtmlTables('<table><tr><td>a<td>b')).toEqual([[['a', 'b']]]);
    expect(extractHtmlTables('<table><tr><td>Общий счётчик<td>1 234 567')).toEqual([
      [['Общий счётчик', '1 234 567']],
    ]);
  });

  it('текст вокруг вложенной таблицы не склеивается в одно слово', () => {
    const tables = extractHtmlTables(
      '<table><tr><td>внешняя<table><tr><td>внутренняя</td></tr></table>хвост</td></tr></table>',
    );
    expect(tables).toEqual([[['внешняя хвост']], [['внутренняя']]]);
  });
});

describe('общая вычитка чисел', () => {
  const NBSP = '\u00a0';

  it('читает разряды пробелами и запятую как дробную часть', () => {
    expect(parseNumericValue('1 234 567')).toBe('1234567');
    expect(parseNumericValue(`1${NBSP}234${NBSP}567`)).toBe('1234567');
    expect(parseNumericValue('12,5')).toBe('12.5');
    expect(parseNumericValue('1,234.56')).toBe('1234.56');
    expect(parseNumericValue('1.234,56')).toBe('1234.56');
    expect(parseNumericValue('0009')).toBe('9');
    expect(parseNumericValue('нет данных')).toBeNull();
  });

  it('счётчик за жизнь аппарата не теряет знаков', () => {
    expect(parseNumericValue('123 456 789 012 345 678')).toBe('123456789012345678');
  });

  /**
   * Пробельная группировка — вето на чтение трёх цифр как разрядов. Без него девятизначный
   * счётчик становился двенадцатизначным: пробелы снимались раньше проверки, и дробный хвост
   * «,999» читался как ещё одна тысяча.
   */
  it('пробельная группировка запрещает читать хвост из трёх цифр как разряды', () => {
    expect(parseNumericValue('999 999 999,999')).toBe('999999999.999');
    expect(parseNumericValue(`999${NBSP}999${NBSP}999,999`)).toBe('999999999.999');
    expect(parseNumericValue('1 234,5')).toBe('1234.5');
  });

  it('строгая группировка одним разделителем читается разрядами', () => {
    expect(parseNumericValue('1.234')).toBe('1234');
    expect(parseNumericValue('8,125')).toBe('8125');
    expect(parseNumericValue('9,999')).toBe('9999');
  });

  it('лишние знаки после запятой округляются по строке, а не через double', () => {
    expect(parseNumericValue('9,9999')).toBe('10');
    expect(parseNumericValue('123456789012,3456')).toBe('123456789012.346');
  });

  /**
   * Прошивочные `-1` и `-3` значат «датчика нет». Отдать их числом значит либо завести ряд с
   * отрицательной наработкой, либо (у процента) выдать пустой картридж за полный.
   */
  it('отрицательное — не число аппарата', () => {
    expect(parseNumericValue('-3')).toBeNull();
    expect(parseNumericValue('-1')).toBeNull();
    expect(parsePercentValue('-3')).toBeNull();
  });

  /** Жадный класс склеивал процент с датой, стоящей рядом, и выдавал 451009.203. */
  it('два числа рядом не склеиваются в одно', () => {
    expect(parseNumericValue('45 % 10.09.2026')).toBe('45');
    expect(parsePercentValue('45 % 10.09.2026')).toBe('45');
    expect(parseNumericValue('1 234 567 оттисков на 14.09.2026')).toBe('1234567');
  });

  /**
   * У процента разрядов не бывает: шкала 0…100. Общее правило читало бы остаток в восемь
   * процентов как восемь тысяч, а обрезка сверху доделывала бы подлог — «полный картридж».
   */
  it('процент считает запятую дробной всегда и обрезается только сверху', () => {
    expect(parsePercentValue('45 %')).toBe('45');
    expect(parsePercentValue('8,125')).toBe('8.125');
    expect(parsePercentValue('9,999')).toBe('9.999');
    expect(parsePercentValue('1,2345')).toBe('1.235');
    expect(parsePercentValue('110')).toBe('100');
    expect(parsePercentValue('100,5')).toBe('100');
  });
});

describe('профиль «не поняли»', () => {
  it('уверенность минимальна, но не нулевая: реестру нужно из чего выбирать (Р13)', () => {
    expect(UNKNOWN_PROFILE_CONFIDENCE).toBeGreaterThan(0);
    expect(UNKNOWN_PROFILE_CONFIDENCE).toBeLessThan(0.1);
  });

  it('на любом письме даёт ноль наблюдений и ноль событий, но вычитывает подсказки', async () => {
    for (const name of fixtureNames()) {
      const ctx = await contextOf(name);
      expect(unknownProfile.detect(ctx), name).toBe(UNKNOWN_PROFILE_CONFIDENCE);
      const parsed = normalizeParsedMessage(unknownProfile, ctx);
      expect(parsed.profileCode, name).toBe('unknown');
      expect(parsed.observations, name).toEqual([]);
      expect(parsed.events, name).toEqual([]);
      expect(parsed.identity.serial, name).toBe(EXPECTED[name]?.serial);
      expect(parsed.identity.ip, name).toBe(EXPECTED[name]?.ip);
    }
  });

  /**
   * Прошивка пишет в `Device Name` всё описание аппарата — двести пятьдесят знаков там не
   * редкость. Неподрезанная подсказка не проходит схему снимка, письмо уходит в `failed` с пустым
   * снимком, то есть вон из очереди образцов, а человек теряет серийник, по которому только и мог
   * привязать его руками.
   */
  it('длинные подсказки подрезаются по границам контракта, а письмо доезжает', async () => {
    const longName = 'СИНТЕТИЧЕСКОЕ ОПИСАНИЕ АППАРАТА '.repeat(10);
    expect(longName.length).toBeGreaterThan(200);
    const raw = Buffer.from(
      'From: printer-06@device.example.test\r\nTo: devices@portal.example.test\r\n' +
        'Subject: Long name\r\nDate: Mon, 14 Sep 2026 07:30:00 +0300\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n\r\n' +
        `Device Name: ${longName}\r\nSerial Number: SYN0006FF\r\nIP Address: 10.20.30.46\r\n`,
      'utf8',
    );
    const parsed = normalizeParsedMessage(unknownProfile, await parseDeviceMail(raw));
    expect(parsed.identity.deviceName).toHaveLength(200);
    expect(parsed.identity.deviceName).toBe(longName.trim().slice(0, 200));
    expect(parsed.identity.serial).toBe('SYN0006FF');
    expect(parsed.identity.ip).toBe('10.20.30.46');
  });

  it('письмо не о технике вовсе разбирается без ошибки и без подсказок', async () => {
    const raw = Buffer.from(
      'From: someone@example.test\r\nTo: devices@portal.example.test\r\n' +
        'Subject: Hello\r\nDate: Mon, 14 Sep 2026 07:00:00 +0300\r\n\r\nПривет.\r\n',
      'utf8',
    );
    const parsed = normalizeParsedMessage(unknownProfile, await parseDeviceMail(raw));
    expect(parsed.observations).toEqual([]);
    expect(parsed.identity.serial).toBeNull();
    expect(parsed.identity.ip).toBeNull();
  });
});

describe('нормализатор', () => {
  const stub = { code: 'unknown', version: 3 } as const;

  it('расхождение единицы со снимком — ошибка unit_mismatch, а не запись (Р22)', () => {
    const broken: ProfileParseResult = {
      observations: [
        {
          metricCode: 'supply_level_percent' as const,
          component: COMPONENT_NONE as ComponentCode,
          value: '50',
          unit: 'pages' as const,
          deviceTime: null,
          rawLabel: 'остаток',
        },
      ],
      events: [],
      identity: unknownProfile.parse({
        subject: '',
        fromAddress: '',
        envelopeTo: '',
        messageIdHeader: '',
        dateHeader: null,
        text: '',
        html: '',
        tables: [],
        attachments: [],
        headers: {},
      }).identity,
    };
    expect(() => normalizeProfileResult(stub, broken)).toThrow(DeviceParseError);
    try {
      normalizeProfileResult(stub, broken);
    } catch (error) {
      expect(error).toBeInstanceOf(DeviceParseError);
      expect((error as DeviceParseError).code).toBe('unit_mismatch');
      expect((error as DeviceParseError).errorClass).toBe('terminal');
    }
  });

  it('повторный разрез в одном письме упирается в ключ наблюдения до записи', async () => {
    const ctx = await contextOf('05-color-toner-levels.eml');
    const doubled = syntheticProfile.parse(ctx);
    doubled.observations.push(doubled.observations[0]!);
    expect(() => normalizeProfileResult(stub, doubled)).toThrow(/extract_failed/u);
  });

  /**
   * Кода нет в реестре метрик — причина своя. Сообщение «измеряется в «undefined»» отправляло бы
   * разбираться с реестром вместо профиля, а реестр append-only (Р20) сам собой не пополняется.
   */
  it('неизвестный код метрики называет свою причину', () => {
    const alien = {
      observations: [
        {
          metricCode: 'printed_a3_total',
          component: COMPONENT_NONE,
          value: '10',
          unit: 'impressions',
          deviceTime: null,
          rawLabel: 'A3',
        },
      ],
      events: [],
      identity: emptyIdentityHints(),
    } as unknown as ProfileParseResult;
    try {
      normalizeProfileResult(stub, alien);
      expect.unreachable('разбор обязан был отказать');
    } catch (error) {
      expect((error as DeviceParseError).code).toBe('extract_failed');
      expect((error as DeviceParseError).reason).toContain('нет в реестре метрик');
    }
  });

  /**
   * Сборка снимка стоит внутри того же `try`, что и вызов профиля. Малоформатный объект (нет
   * массива наблюдений) иначе ронял бы голый `TypeError`, а он снаружи читается как пауза и
   * останавливает ящик (§9.1, п. 7).
   */
  it('малоформатный ответ профиля — тоже строка с причиной, а не TypeError наружу', async () => {
    const sloppy = {
      code: 'unknown',
      version: 1,
      detect: () => 1,
      parse: () => ({ observations: null, events: null, identity: null }),
    } as unknown as DeviceProfile;
    const ctx = await contextOf('01-plain-counters.eml');
    try {
      normalizeParsedMessage(sloppy, ctx);
      expect.unreachable('разбор обязан был отказать');
    } catch (error) {
      expect(error).toBeInstanceOf(DeviceParseError);
      expect((error as DeviceParseError).code).toBe('extract_failed');
      expect((error as DeviceParseError).errorClass).toBe('terminal');
    }
  });

  it('падение профиля закрывается строкой, а не исключением наружу', async () => {
    const angry: DeviceProfile = {
      code: 'unknown',
      version: 1,
      detect: () => 1,
      parse: () => {
        throw new Error('прошивка прислала чушь');
      },
    };
    const ctx = await contextOf('01-plain-counters.eml');
    try {
      normalizeParsedMessage(angry, ctx);
      expect.unreachable('разбор обязан был отказать');
    } catch (error) {
      expect((error as DeviceParseError).code).toBe('extract_failed');
      expect((error as DeviceParseError).errorClass).toBe('terminal');
    }
  });

  it('снимок несёт код профиля и его версию: по ним отбирают на перечитывание (Р26)', async () => {
    const parsed = normalizeParsedMessage(unknownProfile, await contextOf('01-plain-counters.eml'));
    expect(parsed.profileCode).toBe('unknown');
    expect(parsed.parserVersion).toBe(unknownProfile.version);
  });
});

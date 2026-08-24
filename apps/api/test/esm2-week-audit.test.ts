import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ESM2_WEEK_REGISTRY, type Esm2WeekClass, type Esm2WeekEntry } from './esm2-week-registry';

/**
 * Храповик недельного допущения: реестр обязан совпадать с деревом, а `done` — иметь доказательство
 * (подэтап 4b плана `docs/assignment-periods-plan.md`, Ю9, У1;
 * [реестр](esm2-week-registry.ts), [раздача работы](../../../docs/assignment-periods-regression.md)).
 *
 * ЗАЧЕМ ОН. Реестр без храповика живёт неделю. Кто-нибудь заведёт восемнадцатый тест, вставляющий
 * лист «понедельник плюс шесть», в реестр его не впишет — и класс потребителей молча вырастет ровно
 * тем способом, каким он и вырос до двадцати с лишним. Здесь так не выйдет: файл, тронувший форму
 * листа, обязан быть в реестре, иначе набор красный.
 *
 * ПОЧЕМУ ПРИЗНАКИ ИМЕННО ТАКИЕ.
 *
 * - `sheet_period` — упоминание `period_from`/`period_to` в любом написании. Признак точный:
 *   этих колонок нет больше **ни у одной** таблицы схемы, только у `waybills`. Файл, который их
 *   написал, знает про границы листа, и знает он их сегодняшними.
 * - `sheet_insert` — файл вставляет лист в `waybills` **вместе с периодом**, то есть выписывает
 *   бумагу мимо сверки и границы придумывает сам. Рейсовые листы 4-П сюда не попадают: у них
 *   период пустой, и разрез их не касается.
 * - `week_sheet` — файл считает понедельник (`weekStartKey`) и при этом говорит про ЭСМ-2. Оба
 *   условия сразу, потому что понедельник считает и недельная заявка, к листам отношения не
 *   имеющая.
 * - `esm2_mention` — просто упоминание. Само по себе работы не требует, но в реестре стоять
 *   обязано: иначе «этот файл смотрели и он безобиден» и «этот файл не смотрели» неразличимы.
 *
 * ЧЕГО ХРАПОВИК НЕ ДЕЛАЕТ. Он не решает, к какому классу файл относится, — это работа человека.
 * Ошибку классификации он ловит в двух местах, и оба про `mention`: файл, выписывающий бумагу,
 * упоминанием быть не может вовсе, а файл, где границы листа просто написаны, обязан объявить их
 * декорацией отдельным полем. Всё остальное держится на `note`, и врать в ней можно — но врать
 * придётся письменно и на ревью.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Себя и реестр храповик не сканирует: в них признаки написаны текстом — регулярками и цитатами в
 * пояснениях, — и сканирование ловило бы собственное отражение.
 */
const SELF = new Set(['esm2-week-audit.test.ts', 'esm2-week-registry.ts']);

const MARKERS = {
  sheet_period: /period_from|periodFrom|period_to|periodTo/,
  sheet_insert: /(insert\(\s*waybills|insert\(schema\.waybills|INSERT INTO waybills)/i,
  week_sheet: /weekStartKey\s*\(/,
  esm2_mention: /esm2|Esm2|ESM-2|ЭСМ-2/,
} as const;

type Marker = keyof typeof MARKERS;

/** Признаки одного файла: что именно в нём выдаёт знание о форме листа. */
function markersOf(source: string): Marker[] {
  const found: Marker[] = [];
  if (MARKERS.sheet_period.test(source)) found.push('sheet_period');
  if (MARKERS.sheet_insert.test(source) && MARKERS.sheet_period.test(source)) {
    found.push('sheet_insert');
  }
  if (MARKERS.week_sheet.test(source) && MARKERS.esm2_mention.test(source)) {
    found.push('week_sheet');
  }
  if (MARKERS.esm2_mention.test(source)) found.push('esm2_mention');
  return found;
}

interface Scanned {
  file: string;
  markers: Marker[];
  source: string;
}

const scanned: Scanned[] = readdirSync(HERE)
  .filter((name) => name.endsWith('.ts') && !SELF.has(name))
  .sort()
  .map((file) => {
    const source = readFileSync(join(HERE, file), 'utf8');
    return { file, markers: markersOf(source), source };
  })
  .filter((entry) => entry.markers.length > 0);

const byFile = new Map<string, Scanned>(scanned.map((entry) => [entry.file, entry]));
const registryByFile = new Map<string, Esm2WeekEntry>(
  ESM2_WEEK_REGISTRY.map((entry) => [entry.file, entry]),
);

const of = (klass: Esm2WeekClass): Esm2WeekEntry[] =>
  ESM2_WEEK_REGISTRY.filter((entry) => entry.klass === klass);

describe('реестр недельного допущения ЭСМ-2 совпадает с деревом', () => {
  it('каждый файл с признаками формы листа классифицирован', () => {
    const missing = scanned
      .filter((entry) => !registryByFile.has(entry.file))
      .map((entry) => `${entry.file} (${entry.markers.join(', ')})`);
    expect(
      missing,
      'файл трогает форму листа ЭСМ-2, но в реестре его нет. Классифицируйте его в ' +
        '`esm2-week-registry.ts`: `sync` — проверяет поведение сверки; `consumer` — зашил ' +
        '«лист = неделя от понедельника»; `mention` — только упоминание',
    ).toEqual([]);
  });

  it('в реестре нет записей без файлов', () => {
    const orphans = ESM2_WEEK_REGISTRY.filter((entry) => !byFile.has(entry.file)).map(
      (entry) => entry.file,
    );
    expect(
      orphans,
      'файл переименован или удалён, а запись осталась — реестр перестаёт быть перечнем работы',
    ).toEqual([]);
  });

  it('`mention` не может выписывать бумагу', () => {
    // Первая из двух ошибок классификации, которые храповик ловит сам. Файл, вставляющий лист
    // вместе с периодом, границы придумывает — упоминанием это не бывает никогда.
    const wrong = of('mention')
      .filter((entry) => (byFile.get(entry.file)?.markers ?? []).includes('sheet_insert'))
      .map((entry) => entry.file);
    expect(
      wrong,
      'запись помечена `mention`, но файл сам вставляет лист с периодом — это `consumer`',
    ).toEqual([]);
  });

  it('`mention` с границами листа объявляет их декорацией явно', () => {
    /*
     * Вторая. Просто написанный `period_from` упоминанием быть может: границы стоят в фикстуре и
     * ни в одно утверждение не идут — так живут `waybill-template` (разметка бланка),
     * `garage-busy-forms` (таблица «занятость → бланк»), `linear-slices` (вхождение дня в
     * интервал). Запретить такое значило бы гнать в работу файлы, где работы нет.
     *
     * Но и молча пропускать нельзя: ровно так `mention` и становится свалкой. Поэтому claim
     * пишется отдельным полем — «посмотрел и утверждаю, что декорация», — и виден в диффе
     * строкой, а не тонет в пояснении.
     */
    const unclaimed = of('mention')
      .filter((entry) => (byFile.get(entry.file)?.markers ?? []).includes('sheet_period'))
      .filter((entry) => entry.periodIsDecoration !== true)
      .map((entry) => entry.file);
    expect(
      unclaimed,
      'файл помечен `mention`, но пишет `period_from`/`period_to`. Либо это `consumer`/`sync`, ' +
        'либо границы — декорация, и тогда так и надо сказать: `periodIsDecoration: true`',
    ).toEqual([]);
  });

  it('`periodIsDecoration` бывает только у `mention`', () => {
    const misplaced = ESM2_WEEK_REGISTRY.filter(
      (entry) => entry.periodIsDecoration && entry.klass !== 'mention',
    ).map((entry) => entry.file);
    expect(
      misplaced,
      'у `sync`, `consumer` и `target` границы листа предмет проверки, а не декорация',
    ).toEqual([]);
  });
});

describe('реестр отвечает, что с файлом делать', () => {
  it('у каждой записи есть пояснение', () => {
    const silent = ESM2_WEEK_REGISTRY.filter((entry) => entry.note.trim().length === 0).map(
      (entry) => entry.file,
    );
    expect(silent, 'запись без `note` не отличима от строки в списке файлов').toEqual([]);
  });

  it('у каждой незакрытой записи названа работа', () => {
    const vague = ESM2_WEEK_REGISTRY.filter(
      (entry) => entry.status === 'pending' && !entry.todo?.trim(),
    ).map((entry) => entry.file);
    expect(
      vague,
      '`pending` без `todo` — это «кто-нибудь разберётся», а волне 4b.2 нужно раздать работу',
    ).toEqual([]);
  });

  it('`sync` + `done` доказывается двумя прогонами в самом файле', () => {
    const unproven = of('sync')
      .filter((entry) => entry.status === 'done')
      // Файл, объявивший режим неприменимым, доказывается меткой, а не обёрткой (см. случай ниже).
      .filter((entry) => entry.readModeIrrelevant !== true)
      .filter((entry) => !(byFile.get(entry.file)?.source ?? '').includes('describeReadModes'))
      .map((entry) => entry.file);
    expect(
      unproven,
      'файл помечен закрытым, но `describeReadModes` в нём нет — значит второго набора ожиданий ' +
        'тоже нет, и после переключения чтения он упадёт в окно cutover',
    ).toEqual([]);
  });

  /*
   * Есть `sync`-файлы, у которых предмет проверки к режиму чтения не относится вовсе: порядок
   * захвата блокировок, гонки двух транзакций, перебор прав. Разрез задевает в них только
   * **адресацию** бумаги в фикстуре («лист недели» → «лист отрезка»), и обёртка двух прогонов там
   * была бы формальностью: обе половины совпадали бы навсегда, а не до этапа 5.
   *
   * Такому файлу разрешено закрываться без обёртки, но не молча: он обязан объявить
   * `readModeIrrelevant: true` в реестре и оставить метку `ЭСМ2-РАЗРЕЗ` в коде — ровно как
   * потребитель. Иначе категория станет лазейкой «обернуть лень, напишу что не нужно».
   */
  it('`sync` без обёртки закрывается только с объявленной причиной и меткой', () => {
    const claimed = of('sync').filter((entry) => entry.readModeIrrelevant === true);

    const notDone = claimed.filter((entry) => entry.status !== 'done').map((e) => e.file);
    expect(notDone, '`readModeIrrelevant` у незакрытой записи ничего не значит').toEqual([]);

    const unmarked = claimed
      .filter((entry) => !(byFile.get(entry.file)?.source ?? '').includes('ЭСМ2-РАЗРЕЗ'))
      .map((entry) => entry.file);
    expect(
      unmarked,
      'файл объявил режим неприменимым, но метки `ЭСМ2-РАЗРЕЗ` в нём нет — объяснения, ' +
        'по которому это можно проверить, не существует',
    ).toEqual([]);
  });

  it('`consumer` + `done` доказывается меткой в самом файле', () => {
    const unproven = of('consumer')
      .filter((entry) => entry.status === 'done')
      .filter((entry) => !(byFile.get(entry.file)?.source ?? '').includes('ЭСМ2-РАЗРЕЗ'))
      .map((entry) => entry.file);
    expect(
      unproven,
      'файл помечен закрытым, но метки `ЭСМ2-РАЗРЕЗ` в нём нет. Потребителя нечем проверить ' +
        'автоматически — единственное доказательство разбора это объяснение рядом с кодом',
    ).toEqual([]);
  });
});

/**
 * Гейт cutover. Обычным прогоном молчит: незакрытые записи — нормальное состояние подэтапа 4b, и
 * красить ими набор значило бы приучить всех к красному.
 *
 * Включается чеклистом этапа 5 — там вопрос стоит иначе: «остались ли файлы, которые соврут». Ответ
 * обязан быть числом, а не мнением:
 *
 *   ASSIGNMENT_CUTOVER_READY=1 npx vitest run test/esm2-week-audit.test.ts
 */
describe.skipIf(process.env.ASSIGNMENT_CUTOVER_READY !== '1')('готовность к cutover', () => {
  it('ни одного незакрытого потребителя', () => {
    const left = of('consumer')
      .filter((entry) => entry.status === 'pending')
      .map((entry) => `${entry.file}: ${entry.todo ?? ''}`);
    expect(left, 'эти файлы после переключения чтения не упадут, а соврут').toEqual([]);
  });

  it('ни одного непараметризованного проверяющего сверку', () => {
    const left = of('sync')
      .filter((entry) => entry.status === 'pending')
      .map((entry) => `${entry.file}: ${entry.todo ?? ''}`);
    expect(left, 'эти файлы упадут в окно `all_frozen` — то самое, ради чего затеян 4b').toEqual(
      [],
    );
  });
});

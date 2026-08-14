import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Сторож единственного места, где живёт режим заказа (ADR 0107, решение 2).
 *
 * Режим заявки — это `coalesce(vehicle_requests.is_linear_frozen, vehicle_types.is_linear)`, а не
 * признак справочника: заявку могло застать переключение, и до конца работы она ведётся по
 * снимку. Читателей семь, они самостоятельные, и забытый читатель **не ошибается вслух** — он
 * молча возвращает заявку на живой режим: замороженный заказ перестаёт занимать свою машину,
 * гараж показывает её свободной, и на те же дни ложится второй заказ.
 *
 * Поэтому прямое обращение к признаку типа в коде о заявках — ошибка, и ловится она здесь, а не
 * ревью: за две редакции плана гаражный `specialBusyExists` терялся дважды именно потому, что
 * собирается сырой строкой и на глаза не попадается.
 *
 * Форм две, и обе обязательны. `vehicleTypes.isLinear` — запрос drizzle; `is_linear` — сырой SQL
 * внутри `sql\`…\``. Ищи тест только первую, `specialBusyExists` прошёл бы мимо него молча.
 *
 * Список исключений открыт, но каждая строка в нём — с объяснением. Новый читатель обязан либо
 * позвать хелпер `src/db/linear-mode.ts`, либо осознанно пополнить список и написать, почему ему
 * нужен признак справочника, а не режим заявки.
 *
 * Тест уходит вместе с колонками снимка: когда режим снова станет вопросом к одному справочнику,
 * сторожить будет нечего.
 */

const SRC = new URL('../src', import.meta.url).pathname;

/**
 * Кому признак справочника нужен по существу — и почему.
 *
 * Общее у всех троих: они говорят про **тип**, а не про заявку. Режим заявки эти файлы не решают,
 * и подставлять им снимок было бы неверно ровно так же, как читателю заявки — справочник.
 */
const ALLOWED = new Map<string, string>([
  ['db/schema.ts', 'определение колонок: и признака типа, и снимка заявки — здесь они и объявлены'],
  [
    'db/linear-mode.ts',
    'сам хелпер: единственное место, где обе колонки сходятся в одно выражение',
  ],
  [
    'routes/vehicle-types.ts',
    'справочник типов: признак — его собственное поле, и переключает его тоже он',
  ],
  [
    'services/directory-transfer/defs/vehicles.ts',
    'обмен справочником файлом: колонка типа читается и пишется как поле справочника',
  ],
]);

/** Признак типа в запросе drizzle: `vehicleTypes.isLinear`, `orderedTypes.isLinear`, любой алиас. */
const DRIZZLE_READ = /\b\w*[Tt]ypes?\.isLinear\b/;
/** Он же в сыром SQL: `NOT ga_vt.is_linear`, `vt.is_linear` — псевдоним у каждого свой. */
const RAW_READ = /\bis_linear\b/;

/**
 * Что перед проверкой вычёркивается — и почему это не дыра в стороже.
 *
 * Колонка типа, **отданная хелперу аргументом**, — это и есть правильное чтение: именно её он и
 * сводит со снимком. Комментарии вычёркиваются по той же причине: объяснение «читаем режим, а не
 * `is_linear` справочника» стоит ровно там, где правка и сделана, и ругаться на него — значит
 * запретить объяснять. Снимок `is_linear_frozen` вычёркивается первым: он содержит имя признака
 * подстрокой, и без этого сторож заругался бы на каждого честного читателя.
 */
function meaningfulCode(text: string): string {
  return dropMarkedLines(text)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/is_linear_frozen/g, '')
    .replace(/isLinearFrozen/g, '')
    .replace(/requestIsLinear(?:Sql|RawSql)?\([\s\S]*?\)/g, '');
}

/**
 * Построчная отметка для случая, который вычеркнуть иначе нечем: признак типа читается **отдельным
 * запросом** и уходит в хелпер следующим выражением. Так делает статусная ручка — она берёт строку
 * типа `FOR SHARE` и только потом сводит её со снимком заявки, и связать два оператора регулярным
 * выражением невозможно.
 *
 * Отметка ставится строкой выше и обязана нести причину: `// linear-mode-ok: <почему>`. Это и есть
 * разница между «сторож обойдён» и «сторожу объяснили» — файл целиком в исключения не уезжает, и
 * следующий прямой читатель в нём будет пойман.
 */
const MARK = /\/\/\s*linear-mode-ok:\s*\S+/;

function dropMarkedLines(text: string): string {
  const lines = text.split('\n');
  return lines.map((line, i) => (i > 0 && MARK.test(lines[i - 1]!) ? '' : line)).join('\n');
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('режим заказа читается одним выражением', () => {
  it('прямых читателей признака типа нет нигде, кроме названных поимённо', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      if (ALLOWED.has(rel)) continue;
      const code = meaningfulCode(readFileSync(file, 'utf8'));
      if (DRIZZLE_READ.test(code) || RAW_READ.test(code)) offenders.push(rel);
    }

    expect(
      offenders,
      'режим заявки спрашивают у `requestIsLinear*` (src/db/linear-mode.ts): признак справочника ' +
        'не знает про заявки, застигнутые переключением, — либо позовите хелпер, либо пополните ' +
        'список исключений с объяснением',
    ).toEqual([]);
  });

  it('исключения перечислены с причиной и все существуют', () => {
    for (const [rel, why] of ALLOWED) {
      expect(why.length, `${rel}: причина исключения не названа`).toBeGreaterThan(20);
      expect(
        () => statSync(join(SRC, rel)),
        `${rel}: файла нет — список отстал от кода`,
      ).not.toThrow();
    }
  });
});

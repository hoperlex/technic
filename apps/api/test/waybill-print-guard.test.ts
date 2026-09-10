import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WAYBILL_CANCELLED_PRINT_MESSAGE } from '@technic/contracts';

/**
 * Сторож печати: лист, изменившийся, пока собирался его бланк (план
 * `docs/vehicle-request-actual-end-date-plan.md`, Р21).
 *
 * До правки снимка действующего листа сторожу хватало статуса: внутри окна рендера с листом могло
 * случиться ровно одно — аннулирование, — и изменившийся лист всегда переставал быть печатаемым.
 * Сокращение периода при закрытии заявки это допущение отменяет: номер тот же, статус тот же,
 * печатать по-прежнему можно, а даты в собранном бланке уже не те, что в базе. Отличает такой лист
 * только версия, и здесь проверяется, что печать её действительно спрашивает — на всех трёх путях,
 * которыми бумага уходит из портала (выгрузка, печать, пачка).
 *
 * **Почему это не db-тест.** Проверять надо не то, что база умеет менять строку, а то, что ручка
 * сверяет прочитанное с текущим и не пишет отметку о печати, которой не было. Живая база на этот
 * вопрос не отвечает лучше подмены, зато требует гонки в реальном времени — то есть теста,
 * который иногда проходит. Здесь «правка внутри окна рендера» назначается точно: подменённая
 * сборка бланка правит строку между чтением листа и сверкой, ровно там, где в бою успевает
 * коррекция.
 *
 * Строки листов подмена держит сама (`stored.sheets`), и обе выборки маршрута — чтение снимка и
 * сторожевая — идут к ней же: сверять версию с версией из того же места, откуда её и прочитали,
 * бессмысленно, а вот прочитать дважды с правкой посередине — это и есть проверяемое.
 */

interface Sheet {
  id: string;
  status: 'issued' | 'cancelled';
  version: number;
  number: number;
  prefix: string;
  numberWidth: number;
  formCode: string;
  data: Record<string, string>;
}

const stored = vi.hoisted(() => ({
  sheets: new Map<string, Sheet>(),
  audit: [] as Array<{ action: string; entityId?: string; metadata?: Record<string, unknown> }>,
  /** Сколько бланков уже собрано: пачка зовёт сборку по разу на лист. */
  renders: 0,
  /**
   * Что случается с листами, пока собирается бланк, и на каком по счёту бланке. Момент важен
   * именно у пачки: правка листа, чей бланк ещё не собран, гонкой не является — его прочитают уже
   * исправленным, и отказывать будет не в чем.
   */
  duringRender: null as null | ((rendered: number) => void),
}));

/**
 * Подмена базы: `select` для обеих выборок печати и `insert` для аудита.
 *
 * Строки отбираются по идентификаторам, найденным в условии, а не по разбору самого условия:
 * drizzle собирает `WHERE` в дерево кусков, и `eq(id, …)` с `inArray(id, […])` отличаются в нём
 * только формой. Обходом дерева берутся все известные идентификаторы — этого хватает обеим
 * выборкам, а лишних строк отбор и не вернёт: неизвестных листов в условии не бывает.
 */
vi.mock('../src/db/client', () => {
  const idsIn = (node: unknown, seen = new Set<unknown>()): string[] => {
    if (typeof node === 'string') return stored.sheets.has(node) ? [node] : [];
    if (!node || typeof node !== 'object' || seen.has(node)) return [];
    seen.add(node);
    return Object.values(node).flatMap((v) => idsIn(v, seen));
  };
  const rows = (where: unknown) => {
    const ids = [...new Set(idsIn(where))];
    // Копия, а не сама строка: живой Postgres отдаёт снимок на момент запроса, и общая ссылка
    // подсунула бы обработчику правку, случившуюся уже после его чтения, — то есть скрыла бы
    // ровно ту гонку, ради которой тест и написан.
    return ids
      .map((id) => stored.sheets.get(id))
      .filter((row) => row !== undefined)
      .map((row) => ({ ...row }));
  };
  const thenable = (value: unknown[]) => ({
    then: (ok: (v: unknown[]) => unknown, fail?: (e: unknown) => unknown) =>
      Promise.resolve(value).then(ok, fail),
  });
  const query = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: (w: unknown) => thenable(rows(w)) }),
        where: (w: unknown) => thenable(rows(w)),
      }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        stored.audit.push(row as (typeof stored.audit)[number]);
        return thenable([]);
      },
    }),
  };
  return { db: query, pingDb: async () => {} };
});

/**
 * Сборка бланка — то самое окно, внутри которого лист успевают изменить. Настоящая подстановка
 * значений здесь не нужна: сверяется версия строки, а не содержимое ячеек.
 */
vi.mock('../src/services/office-template', () => ({
  renderOfficeTemplate: () => {
    stored.renders += 1;
    stored.duringRender?.(stored.renders);
    return { bytes: new Uint8Array([1, 2, 3]), missing: [] };
  },
}));

/** Конвертера в тестовой среде нет, и печать проверяется без него: окно гонки шире его самого. */
vi.mock('../src/services/office-pdf', () => ({
  PrintAborted: class PrintAborted extends Error {},
  renderPdf: async () => Buffer.from('pdf'),
  renderPdfBatch: async (docs: Uint8Array[]) => docs.map(() => Buffer.from('pdf')),
}));
vi.mock('../src/services/pdf-merge', () => ({
  mergePdfs: async () => Buffer.from('pdf'),
}));

/** Права проверяются своими тестами; здесь нужен только тот, кого запишет аудит. */
vi.mock('../src/auth/plugin', () => ({
  requirePrincipal: () => ({ id: 'user-1' }),
}));

vi.mock('../src/config', () => ({
  config: { logLevel: 'silent', isDev: false, isProd: false, files: { maxSize: 1 } },
}));

const waybillsRoutes = (await import('../src/routes/waybills')).default;
const { errorHandler } = await import('../src/lib/error-handler');

const SERIES = { prefix: '4П ', numberWidth: 6 };

/** Идентификаторы листов: схема маршрута требует UUID, и до ручки другой ключ не доходит. */
const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const THIRD = '33333333-3333-4333-8333-333333333333';

function sheet(id: string, number: number, version = 1): Sheet {
  return {
    id,
    status: 'issued',
    version,
    number,
    ...SERIES,
    formCode: '4p',
    data: {},
  };
}

/** Напечатанный номер — тот же, каким его назовёт отказ: считается формулой портала, не строкой. */
const displayed = (number: number) => `${SERIES.prefix}${String(number).padStart(6, '0')}`;

async function buildTestApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.decorate('authenticate', async () => {});
  app.decorate('requirePermission', () => async () => {});
  await app.register(waybillsRoutes, { prefix: '/api/v1/waybills' });
  await app.ready();
  return app;
}

let app: Awaited<ReturnType<typeof buildTestApp>>;

beforeEach(async () => {
  stored.sheets.clear();
  stored.audit.length = 0;
  stored.renders = 0;
  stored.duringRender = null;
  app = await buildTestApp();
});

/**
 * Правка листа внутри окна рендера: снимок меняется, номер и статус остаются прежними — так
 * выглядит сокращение периода при закрытии заявки со стороны печати.
 *
 * `atRender` — на сборке какого по счёту бланка это случается. У одиночной печати он всегда первый,
 * у пачки правка обязана прийтись **после** сборки бланка этого листа: иначе он будет прочитан уже
 * исправленным, и расхождения не возникнет вовсе.
 */
function trimDuringRender(id: string, atRender = 1): void {
  stored.duringRender = (rendered) => {
    if (rendered !== atRender) return;
    const row = stored.sheets.get(id)!;
    row.version += 1;
  };
}

const printOne = (id: string) => app.inject({ method: 'GET', url: `/api/v1/waybills/${id}/print` });
const exportOne = (id: string) =>
  app.inject({ method: 'GET', url: `/api/v1/waybills/${id}/export` });
const printBatch = (ids: string[]) =>
  app.inject({ method: 'POST', url: '/api/v1/waybills/print-batch', payload: { ids } });

describe('печать сверяет версию листа после сборки бланка', () => {
  it('нетронутый лист печатается, и версия уходит в аудит', async () => {
    stored.sheets.set(FIRST, sheet(FIRST, 41, 7));

    const res = await printOne(FIRST);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    // Версия в отметке — не украшение: после первой же правки только по ней и восстановимо, какой
    // именно вариант листа уехал на площадку.
    expect(stored.audit).toHaveLength(1);
    expect(stored.audit[0]!.action).toBe('waybill.print');
    expect(stored.audit[0]!.metadata).toMatchObject({ version: 7 });
  });

  it('лист, правленный пока собирался бланк, бумагой не отдаётся и отметки о печати не оставляет', async () => {
    stored.sheets.set(FIRST, sheet(FIRST, 41));
    trimDuringRender(FIRST);

    const res = await printOne(FIRST);
    expect(res.statusCode, res.body).toBe(409);
    // Номер назван, а поручение — «откройте печать заново»: убирать из выбора здесь нечего, лист
    // никуда не делся, изменился документ.
    expect(res.json().message).toContain(displayed(41));
    expect(res.json().message).toContain('пока готовился файл');
    expect(res.json().message).not.toBe(WAYBILL_CANCELLED_PRINT_MESSAGE);
    expect(stored.audit).toHaveLength(0);
  });

  it('выгрузка сверяет версию наравне с печатью: файл правят в редакторе и печатают уже из него', async () => {
    stored.sheets.set(FIRST, sheet(FIRST, 42));
    trimDuringRender(FIRST);

    const changed = await exportOne(FIRST);
    expect(changed.statusCode, changed.body).toBe(409);
    expect(changed.json().message).toContain('пока готовился файл');
    expect(stored.audit).toHaveLength(0);

    // А нетронутый лист выгружается, и версия попадает в отметку так же, как у печати.
    const intact = await exportOne(FIRST);
    expect(intact.statusCode, intact.body).toBe(200);
    expect(stored.audit).toHaveLength(1);
    expect(stored.audit[0]!.action).toBe('waybill.export');
    expect(stored.audit[0]!.metadata).toMatchObject({ version: 2 });
  });

  it('исчезнувший лист — тоже расхождение: бланк собран по строке, которой больше нет', async () => {
    stored.sheets.set(FIRST, sheet(FIRST, 43));
    stored.duringRender = () => stored.sheets.delete(FIRST);

    const res = await printOne(FIRST);
    expect(res.statusCode, res.body).toBe(409);
    // Номер назвать нечем — он ушёл вместе со строкой, — но отказ всё равно происходит.
    expect(res.json().message).toContain('пока готовился файл');
    expect(stored.audit).toHaveLength(0);
  });

  it('аннулирование называется первым: поручение точнее, чем «откройте печать заново»', async () => {
    stored.sheets.set(FIRST, sheet(FIRST, 44));
    stored.duringRender = () => {
      const row = stored.sheets.get(FIRST)!;
      row.status = 'cancelled';
      row.version += 1;
    };

    const res = await printOne(FIRST);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().message).toBe(WAYBILL_CANCELLED_PRINT_MESSAGE);
    expect(stored.audit).toHaveLength(0);
  });
});

describe('пачка сверяет версии всех листов', () => {
  const batch = () => {
    stored.sheets.set(FIRST, sheet(FIRST, 51, 3));
    stored.sheets.set(SECOND, sheet(SECOND, 52, 4));
    stored.sheets.set(THIRD, sheet(THIRD, 53, 5));
  };

  it('правка одного листа отменяет всю пачку и называет именно его номер', async () => {
    batch();
    // Бланк второго листа уже собран, третий ещё собирается — то самое окно, в котором коррекция
    // или закрытие заявки успевают тронуть чужую бумагу.
    trimDuringRender(SECOND, 3);

    const res = await printBatch([FIRST, SECOND, THIRD]);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().message).toContain(displayed(52));
    // Соседи в отказе не перечисляются: их бланки верны, и убирать из выбора надо не их.
    expect(res.json().message).not.toContain(displayed(51));
    expect(res.json().message).not.toContain(displayed(53));
    // Пачка уходит одним документом: отметки не должно остаться ни у одного листа, включая верные.
    expect(stored.audit).toHaveLength(0);
  });

  it('целая пачка печатается, и у каждого листа в отметке своя версия', async () => {
    batch();

    const res = await printBatch([FIRST, SECOND, THIRD]);
    expect(res.statusCode, res.body).toBe(200);
    expect(
      stored.audit.map((row) => [row.entityId, (row.metadata as { version: number }).version]),
    ).toEqual([
      [FIRST, 3],
      [SECOND, 4],
      [THIRD, 5],
    ]);
  });
});

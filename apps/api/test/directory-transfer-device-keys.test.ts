import { describe, expect, it, vi } from 'vitest';
import type { AnyDirectory, RowContext } from '../src/services/directory-transfer/types';

/**
 * Описание справочника «Ключи опознания аппаратов» для обмена файлом (ADR 0073, план
 * `docs/office-equipment-mail-identity-ui-plan.md`, §8).
 *
 * Проверяется то, ради чего описание и существует: файл, который портал только что отдал, он же
 * обязан принять без единой правки, а строка, которую пускать нельзя, обязана отвергаться
 * человеческими словами и ДО записи. Правила здесь не свои — их задаёт резолв: ключ нормализуется
 * ровно так же, как его сравнивает опознание, а карточка ищется по инвентарному номеру, потому что
 * он заполнен у всех карточек парка, а серийный — у трёх четвертей.
 *
 * База не поднимается: описание — это разбор и печать ячеек плюс проверка ссылки, а окружение со
 * ссылками собрано здесь руками.
 */

vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: 'https://portal.test',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/technic_test',
    JWT_PUBLIC_KEY_PEM: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----',
    COOKIE_SECRET: 'test-cookie-secret-value',
    CSRF_SECRET: 'test-csrf-secret-value',
    S3_ENDPOINT: 'https://s3.test.local',
    S3_BUCKET: 'test-bucket',
    S3_ACCESS_KEY_ID: 'test-key',
    S3_SECRET_ACCESS_KEY: 'test-secret',
  });
});

vi.mock('../src/db/client', () => ({ db: { execute: vi.fn(), select: vi.fn() } }));

const { deviceKeyDirectories } = await import(
  '../src/services/directory-transfer/defs/device-keys'
);

const dir: AnyDirectory = deviceKeyDirectories.find((d) => d.key === 'device-mail-keys')!;

/** Окружение: живые карточки по инвентарному номеру в нормализованной форме. */
const env = { byInventory: new Map([['3282', 'eq-1'], ['ДР-77', 'eq-2']]) };

type Cells = Record<string, string>;

interface TestContext extends RowContext {
  problems: string[];
}

function testContext(row = 7): TestContext {
  const problems: string[] = [];
  return { row, problems, fail: (m) => problems.push(m), warn: () => {} };
}

function cellsOf(model: unknown): Cells {
  const out: Cells = {};
  for (const column of dir.columns(env)) out[column.header] = column.get(model);
  return out;
}

function applyCells(model: unknown, cells: Cells, ctx: RowContext): void {
  for (const column of dir.columns(env)) {
    const text = cells[column.header];
    if (text === undefined || !column.set) continue;
    column.set(model, text, ctx);
  }
}

const row = {
  id: 'key-1',
  kind: 'serial',
  value: 'W512P900123',
  equipmentId: 'eq-1',
  inventoryNumber: '3282',
  note: 'по табличке на корпусе',
};

describe('справочник «Ключи опознания аппаратов»', () => {
  it('выгруженная строка возвращается загрузкой без единой правки', () => {
    const model = dir.model(row, env);
    const ctx = testContext();
    const parsed = dir.blank();
    applyCells(parsed, cellsOf(model), ctx);
    expect(ctx.problems).toEqual([]);
    expect(cellsOf(parsed)).toEqual(cellsOf(model));
  });

  it('значение ключа нормализуется так же, как его сравнивает резолв', () => {
    const ctx = testContext();
    const model = dir.blank();
    applyCells(
      model,
      {
        'Чем связываем': 'Серийный номер',
        'Значение ключа': '  w512p900123  ',
        'Инвентарный номер аппарата': '3282',
        Примечание: '',
      },
      ctx,
    );
    expect(ctx.problems).toEqual([]);
    // Верхний регистр и срезанные края — та же форма, в какой ключ лежит в базе.
    expect((model as { value: string }).value).toBe('W512P900123');
  });

  it('неизвестный род ключа отвергается словами и перечисляет допустимые', () => {
    const ctx = testContext();
    const model = dir.blank();
    applyCells(
      model,
      {
        'Чем связываем': 'IP-адрес',
        'Значение ключа': '10.10.0.7',
        'Инвентарный номер аппарата': '3282',
        Примечание: '',
      },
      ctx,
    );
    expect(ctx.problems.join(' ')).toContain('неизвестный род ключа');
    // IP не опознаёт никогда — его нет среди родов вовсе, и файл обязан сказать это прямо.
    expect(ctx.problems.join(' ')).toContain('Серийный номер');
  });

  it('пустое значение ключа отвергается: опознавать по нему нечего', () => {
    const ctx = testContext();
    const model = dir.blank();
    applyCells(
      model,
      {
        'Чем связываем': 'Имя устройства',
        'Значение ключа': '   ',
        'Инвентарный номер аппарата': '3282',
        Примечание: '',
      },
      ctx,
    );
    expect(ctx.problems.join(' ')).toContain('пустое значение ключа');
  });

  it('карточка ищется по инвентарному номеру, и незнакомый номер отвергает строку', () => {
    const ok = testContext();
    const found = { ...dir.blank(), kind: 'serial', value: 'X', inventoryNumber: '3282' };
    dir.check?.(found, ok, env);
    expect(ok.problems).toEqual([]);
    expect((found as { equipmentId: string }).equipmentId).toBe('eq-1');

    const bad = testContext();
    const missing = { ...dir.blank(), kind: 'serial', value: 'X', inventoryNumber: 'НЕТ-ТАКОГО' };
    dir.check?.(missing, bad, env);
    expect(bad.problems.join(' ')).toContain('НЕТ-ТАКОГО');
  });

  it('строка без инвентарного номера отвергается до записи', () => {
    const ctx = testContext();
    const model = { ...dir.blank(), kind: 'serial', value: 'X', inventoryNumber: '' };
    dir.check?.(model, ctx, env);
    expect(ctx.problems.join(' ')).toContain('не указан инвентарный номер');
  });

  it('ключ строки — род плюс значение, как у уникального индекса живых привязок', () => {
    expect(dir.keyOf({ ...dir.blank(), kind: 'serial', value: 'W512P900123' })).toBe(
      'serial|W512P900123',
    );
    // Значение не собралось — ключа нет: об этом уже сказала ошибка разбора.
    expect(dir.keyOf(dir.blank())).toBe('');
  });
});

import { describe, expect, it } from 'vitest';
import {
  createMechModelSchema,
  mechModelListQuerySchema,
  mechModelNameKey,
  updateMechModelSchema,
} from '@technic/contracts';

/**
 * Контракт справочника моделей механизации (план `docs/mechanization-models-directory-plan.md`,
 * этап Э1).
 *
 * Здесь проверяется то, что живёт в схемах и в одной функции: формат кода, неизменяемость кода
 * после заведения и нормализация наименования. Совпадение нормализации с базой — вопрос не к этому
 * файлу, а к `mech-models.db.test.ts`: доказать его можно только запросом в Postgres.
 */

describe('код модели механизации', () => {
  it('принимает то, что порождает транслитерация наименования', () => {
    const parsed = createMechModelSchema.parse({
      code: 'vibroplita-reversivnaya-wacker-dpu-3070n',
      name: 'Виброплита реверсивная Wacker DPU 3070Н',
    });
    expect(parsed.code).toBe('vibroplita-reversivnaya-wacker-dpu-3070n');
    // Умолчания те же, что у колонок в базе: строка, заведённая формой без порядка, встаёт в конец.
    expect(parsed.sortOrder).toBe(100);
    expect(parsed.isActive).toBe(true);
  });

  it('отвергает всё, что отвергнет CHECK базы: кириллицу, прописные, подчёркивание, края', () => {
    const bad = [
      'Виброплита', // кириллица — CHECK ждёт латиницу
      'Vibroplita-Wacker', // прописные: в базе их не бывает
      'vibroplita_wacker', // подчёркивание — код типа мусора, а не модели
      'vibroplita--wacker', // двойной дефис: ошибка генератора кода
      '-vibroplita', // край
      'vibroplita-', // край
      '3070n-wacker', // первый знак — цифра
    ];
    for (const code of bad) {
      const res = createMechModelSchema.safeParse({ code, name: 'Виброплита' });
      expect(res.success, code).toBe(false);
    }
  });

  it('длину кода меряет по самому длинному из присланного списка, а не по 50 знакам', () => {
    // 91 знак — «Компрессорная винтовая электрическая стационарная станция ЗИФ-СВЭ-5/0,7 G без
    // кожуха». Обрежь код короче — и коды соседних моделей перестанут различаться хвостом.
    const long = `kompressornaya-${'a'.repeat(76)}`;
    expect(long.length).toBe(91);
    expect(createMechModelSchema.safeParse({ code: long, name: 'Компрессорная' }).success).toBe(
      true,
    );
    const tooLong = `kompressornaya-${'a'.repeat(90)}`;
    expect(createMechModelSchema.safeParse({ code: tooLong, name: 'Компрессорная' }).success).toBe(
      false,
    );
  });

  it('правкой не меняется: код — ключ строки в файле обмена, а не поле формы', () => {
    const res = updateMechModelSchema.safeParse({ code: 'drugoy-kod' });
    expect(res.success).toBe(false);
  });
});

describe('наименование модели механизации', () => {
  it('приезжает без краевых пробелов — как его и кладёт сид', () => {
    const parsed = createMechModelSchema.parse({
      code: 'vibroplita-mikasa-mvb-85',
      name: '  Виброплита Mikasa MVB-85  ',
    });
    expect(parsed.name).toBe('Виброплита Mikasa MVB-85');
  });

  it('пометки заказчика — часть наименования, а не мусор', () => {
    for (const name of [
      'Виброплита реверсивная Wacker DPU 3760Н (см)',
      'Компрессор XAS970 Dd Euro Box сер.№06253380730709',
      'Компрессор поршневой стационарный С416 б/у',
      'Станок резьбонарезной Rex NP50A 1/2"-2" в комплекте с подставкой',
    ]) {
      const parsed = createMechModelSchema.parse({ code: 'kod-pozicii', name });
      expect(parsed.name).toBe(name);
    }
  });

  it('из одних пробельных знаков не заводится: такое наименование ничего не различает', () => {
    expect(createMechModelSchema.safeParse({ code: 'pustaya', name: '   ' }).success).toBe(false);
    expect(updateMechModelSchema.safeParse({ name: '\t' }).success).toBe(false);
  });
});

describe('ключ наименования', () => {
  it('регистр и повторные пробелы модель не различают', () => {
    const key = mechModelNameKey('Виброплита реверсивная Wacker DPU 3070Н');
    expect(mechModelNameKey('ВИБРОПЛИТА РЕВЕРСИВНАЯ WACKER DPU 3070Н')).toBe(key);
    expect(mechModelNameKey('Виброплита  реверсивная\tWacker DPU 3070Н ')).toBe(key);
  });

  it('всё остальное различает: разделять слова — не работа нормализации', () => {
    expect(mechModelNameKey('Виброплита')).not.toBe(mechModelNameKey('Вибро плита'));
    expect(mechModelNameKey('DPU 3060Н')).not.toBe(mechModelNameKey('DPU 3070Н'));
    // Кириллическая «Н» и латинская «H» — разные знаки, и это НЕ придирка: в присланном списке
    // соседствуют «Wacker DPU 3070Н» (кириллица) и «Mikasa MVC-F60H» (латиница).
    expect(mechModelNameKey('Wacker DPU 3070Н')).not.toBe(mechModelNameKey('Wacker DPU 3070H'));
  });

  it('неразрывный пробел не схлопывается: так же на него смотрит и Postgres', () => {
    // `\s` в JavaScript шире, чем в Postgres. Схлопни его здесь — и сервер отвечал бы «имя
    // свободно» там, где уникальный индекс вставку отвергает.
    expect(mechModelNameKey('Wacker\u00A0DPU')).not.toBe(mechModelNameKey('Wacker DPU'));
  });
});

describe('список моделей', () => {
  it('активность приходит строкой запроса и становится булевым', () => {
    expect(mechModelListQuerySchema.parse({ isActive: 'true' }).isActive).toBe(true);
    expect(mechModelListQuerySchema.parse({ isActive: 'false' }).isActive).toBe(false);
    expect(mechModelListQuerySchema.parse({}).isActive).toBeUndefined();
  });

  it('сортировка — только по объявленным полям', () => {
    expect(mechModelListQuerySchema.safeParse({ sortBy: 'name' }).success).toBe(true);
    expect(mechModelListQuerySchema.safeParse({ sortBy: 'nameKey' }).success).toBe(false);
  });
});

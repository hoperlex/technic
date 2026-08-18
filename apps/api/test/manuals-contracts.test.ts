import { describe, expect, it } from 'vitest';
import { createManualSchema, updateManualSchema } from '@technic/contracts';

/**
 * Контракт руководств пользователя (`docs/manuals-plan.md`). Форма ведения отдаёт «Порядок»
 * числовым полем antd, а очищенное числовое поле присылает `null` — и это не то же самое, что
 * `0`: администратор стирает число, когда хочет «пусть будет как у всех», а не «поставь в самое
 * начало». `z.coerce.number()` без нянченья превратил бы такой `null` в `0` (`Number(null)`), и
 * руководство молча встало бы первым в окне у всех — при том, что `.default(100)` в схеме стоит:
 * он срабатывает только на `undefined`.
 *
 * Отсюда состав проверок: оба тела, и в каждом три состояния поля — заданное, пропущенное и
 * очищенное. Разовый прогон схемы такую регрессию не ловит: приведение прячется внутри `coerce`,
 * и вернуть его назад можно одной правкой, не заметив.
 */

/** Минимальное руководство: название и ссылка. Остальное схема доставляет умолчаниями. */
const minimal = {
  title: 'Краткая инструкция по созданию заявок',
  url: 'https://disk.360.yandex.ru/i/x',
};

describe('контракт заведения руководства', () => {
  it('порядок берётся из формы, а пропущенный и стёртый одинаково дают умолчание 100', () => {
    expect(createManualSchema.parse({ ...minimal, sortOrder: 200 }).sortOrder).toBe(200);
    // Поле в форме есть всегда, но заполнять его никто не обязан: заведённое без раздумий
    // руководство встаёт в общий ряд.
    expect(createManualSchema.parse(minimal).sortOrder).toBe(100);
    // Та же строка, что и выше, — но пришедшая от очищенного поля. Без разбора `null` здесь
    // стоял бы `0`, то есть руководство впереди всех заведённых до него.
    expect(createManualSchema.parse({ ...minimal, sortOrder: null }).sortOrder).toBe(100);
  });

  it('ноль остаётся нулём: «в начало» — законное намерение, а не сбой', () => {
    // Проверка не про умолчание, а про его границу: разбор `null` не должен заодно съесть
    // осмысленный `0`, который администратор поставил руками.
    expect(createManualSchema.parse({ ...minimal, sortOrder: 0 }).sortOrder).toBe(0);
    // Строка из тела запроса по-прежнему приводится к числу, а мусор — по-прежнему отказ.
    expect(createManualSchema.parse({ ...minimal, sortOrder: '250' }).sortOrder).toBe(250);
    expect(createManualSchema.safeParse({ ...minimal, sortOrder: 'первым' }).success).toBe(false);
  });
});

describe('контракт правки руководства', () => {
  it('стёртый порядок не правит поле, а не обнуляет его', () => {
    const cleared = updateManualSchema.parse({ sortOrder: null });
    // Колонка объявлена `NOT NULL`, и до `UPDATE` такое поле доходить не должно вовсе: drizzle
    // отбрасывает `undefined`, а `null` попытался бы записаться и уронил бы правку.
    expect(cleared.sortOrder).toBeUndefined();
    expect(Object.entries(cleared).filter(([, v]) => v !== undefined)).toEqual([]);
  });

  it('заданный порядок правится, а пропущенное поле остаётся непроставленным', () => {
    expect(updateManualSchema.parse({ sortOrder: 10 }).sortOrder).toBe(10);
    expect(updateManualSchema.parse({ sortOrder: 0 }).sortOrder).toBe(0);
    // Правка одного названия порядка не касается: умолчание при правке не подставляется —
    // иначе переименование возвращало бы к заводскому виду поле, которого не трогали.
    const renamed = updateManualSchema.parse({ title: 'Инструкция по заявкам' });
    expect(renamed.sortOrder).toBeUndefined();
  });
});

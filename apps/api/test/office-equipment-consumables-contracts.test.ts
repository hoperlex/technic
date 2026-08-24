import { describe, expect, it } from 'vitest';
import {
  baseListQuery,
  createOfficeEquipmentConsumableSchema,
  OFFICE_EQUIPMENT_CONSUMABLE_SORT_FIELDS,
  OFFICE_EQUIPMENT_CONSUMABLE_STOCK_FILTERS,
  officeEquipmentConsumableListQuerySchema,
  type OfficeEquipmentConsumableStockEntryDto,
  officeEquipmentConsumableStockSchema,
  updateOfficeEquipmentConsumableSchema,
} from '@technic/contracts';

/**
 * Схемы справочника расходников (план `docs/office-equipment-consumables-plan.md`, Р5–Р7, Р9).
 *
 * Проверяется не «zod работает», а решения плана — те, которые молча разъезжаются между формой и
 * сервером. Их здесь три рода:
 *
 * 1. **Чего схема не принимает вовсе.** Остаток убран из правки карточки (Р7): приняв количество и
 *    не записав его, портал соврал бы человеку — «сохранено» при неизменившемся остатке и пустом
 *    журнале.
 * 2. **Что подставляется само.** Каждый `.default()` — это значение, которого человек в форме не
 *    видел, но которое уедет в базу; поэтому умолчание проверяется по значению, а не по факту
 *    «поле необязательное».
 * 3. **Где умолчание переопределено.** `sortOrder` базовой схемы — `desc`, и перечень пришёл бы от
 *    «Тонера» к «Картриджу», то есть задом наперёд (Р9).
 *
 * Нормализация кода здесь намеренно не проверяется: правило написания живёт функцией базы
 * `office_equipment_consumable_code_key` (она же стоит в уникальном индексе и в `CHECK`), а вторая
 * копия правила на TypeScript завела бы в справочник второй «тот же» код. Схема снимает только края.
 */

const MODEL_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_MODEL_ID = '22222222-2222-4222-8222-222222222222';

/** Минимальная карточка: код номенклатуры и наименование как в учётной системе, вместе с «(шт)». */
const minimal = {
  code: 'Б0000014256',
  name: 'Тонер-картридж Pantum PC-211EV (шт)',
};

describe('контракт заведения расходника', () => {
  it('требует код и наименование; остальное подставляется умолчанием', () => {
    const parsed = createOfficeEquipmentConsumableSchema.parse(minimal);
    // Остаток по умолчанию нулевой: заведение с нулём — не событие, а отсутствие событий, и первой
    // строки журнала при нём не будет (Р7).
    expect(parsed.quantity).toBe(0);
    expect(parsed.isActive).toBe(true);
    expect(parsed.comment).toBe('');
    // Цвета нет у чёрно-белой позиции, и это `null`, а не пустая строка: «нет цвета» обязано иметь
    // одно представление — того же требует `CHECK` в базе.
    expect(parsed.color).toBeNull();
    // Пустой набор моделей законен: код прислали, а к какому аппарату он подходит — вопрос к
    // ИТ-службе (§7), и ждать ответа, не заводя строку, значит потерять её совсем.
    expect(parsed.modelIds).toEqual([]);

    expect(() => createOfficeEquipmentConsumableSchema.parse({ code: minimal.code })).toThrow();
    expect(() => createOfficeEquipmentConsumableSchema.parse({ name: minimal.name })).toThrow();
    // Пробелы содержимым не считаются: тримминг идёт до проверки длины.
    expect(() =>
      createOfficeEquipmentConsumableSchema.parse({ ...minimal, code: '   ' }),
    ).toThrow();
    expect(() =>
      createOfficeEquipmentConsumableSchema.parse({ ...minimal, name: '   ' }),
    ).toThrow();
  });

  it('ошибка отказа называет поле и говорит словами формы', () => {
    const noCode = createOfficeEquipmentConsumableSchema.safeParse({ ...minimal, code: '' });
    expect(noCode.success).toBe(false);
    expect(noCode.error?.issues[0]?.path).toEqual(['code']);
    expect(noCode.error?.issues[0]?.message).toBe('Укажите код номенклатуры');

    const noName = createOfficeEquipmentConsumableSchema.safeParse({ ...minimal, name: '' });
    expect(noName.success).toBe(false);
    expect(noName.error?.issues[0]?.path).toEqual(['name']);
    expect(noName.error?.issues[0]?.message).toBe('Укажите наименование расходника');
  });

  it('снимает края, но написание кода не трогает — его правило живёт в базе', () => {
    const parsed = createOfficeEquipmentConsumableSchema.parse({
      code: '  б0000014256  ',
      name: '  Тонер-картридж Pantum PC-211EV (шт)  ',
      comment: '  из счёта от 12.08  ',
    });
    expect(parsed.name).toBe('Тонер-картридж Pantum PC-211EV (шт)');
    expect(parsed.comment).toBe('из счёта от 12.08');
    // Регистр схема не поднимает и внутренние пробелы не удаляет: то и другое делает
    // `office_equipment_consumable_code_key` в маршруте, и это единственная копия правила.
    expect(parsed.code).toBe('б0000014256');
  });

  it('держит границы длин: код 2–50, наименование 2–255, цвет до 60, комментарий до 2000', () => {
    const ok = createOfficeEquipmentConsumableSchema.parse({
      code: 'Б'.repeat(50),
      name: 'Т'.repeat(255),
      color: 'ц'.repeat(60),
      comment: 'к'.repeat(2000),
    });
    expect(ok.code).toHaveLength(50);
    expect(ok.name).toHaveLength(255);

    expect(() =>
      createOfficeEquipmentConsumableSchema.parse({ ...minimal, code: 'Б'.repeat(51) }),
    ).toThrow();
    expect(() =>
      createOfficeEquipmentConsumableSchema.parse({ ...minimal, name: 'Т'.repeat(256) }),
    ).toThrow();
    expect(() =>
      createOfficeEquipmentConsumableSchema.parse({ ...minimal, color: 'ц'.repeat(61) }),
    ).toThrow();
    expect(() =>
      createOfficeEquipmentConsumableSchema.parse({ ...minimal, comment: 'к'.repeat(2001) }),
    ).toThrow();
    // Код из одного символа не опознаёт позицию ни в счёте, ни в выгрузке.
    expect(() => createOfficeEquipmentConsumableSchema.parse({ ...minimal, code: 'Б' })).toThrow();
    expect(() => createOfficeEquipmentConsumableSchema.parse({ ...minimal, name: 'Т' })).toThrow();
  });

  /**
   * Цвет — свободная строка, а не перечень: источник приносит и CMYK, и «комплект», и поставщицкое
   * «чёрный увеличенный» (развилка от 21.08, Р5). Проверяется здесь ровно то, что записано в схеме:
   * какие значения проходят и во что превращается «пусто».
   */
  it('цвет: любое слово, но «пусто» приводится к `null` тремя разными путями', () => {
    for (const color of ['чёрный', 'комплект', 'чёрный увеличенный', 'Cyan']) {
      expect(createOfficeEquipmentConsumableSchema.parse({ ...minimal, color }).color, color).toBe(
        color,
      );
    }
    expect(
      createOfficeEquipmentConsumableSchema.parse({ ...minimal, color: '  жёлтый  ' }).color,
    ).toBe('жёлтый');
    // Три вида «цвета нет» — поля нет, пустая строка из очищенного поля формы и явный `null` —
    // дают одно значение: два представления «пусто» развели бы позиции по колонке фильтра.
    expect(createOfficeEquipmentConsumableSchema.parse(minimal).color).toBeNull();
    expect(createOfficeEquipmentConsumableSchema.parse({ ...minimal, color: '' }).color).toBeNull();
    expect(
      createOfficeEquipmentConsumableSchema.parse({ ...minimal, color: '   ' }).color,
    ).toBeNull();
    expect(
      createOfficeEquipmentConsumableSchema.parse({ ...minimal, color: null }).color,
    ).toBeNull();
  });

  it('начальный остаток — целое от нуля до миллиона и только числом', () => {
    expect(createOfficeEquipmentConsumableSchema.parse({ ...minimal, quantity: 12 }).quantity).toBe(
      12,
    );
    expect(
      createOfficeEquipmentConsumableSchema.parse({ ...minimal, quantity: 1_000_000 }).quantity,
    ).toBe(1_000_000);
    // Верхняя граница — не учётное правило, а защита от опечатки: «120» вместо «12» в поле ввода от
    // правды ничем не отличается, а склада на миллион картриджей у ИТ-службы нет.
    expect(() =>
      createOfficeEquipmentConsumableSchema.parse({ ...minimal, quantity: 1_000_001 }),
    ).toThrow();
    expect(() =>
      createOfficeEquipmentConsumableSchema.parse({ ...minimal, quantity: -1 }),
    ).toThrow();
    expect(() =>
      createOfficeEquipmentConsumableSchema.parse({ ...minimal, quantity: 1.5 }),
    ).toThrow();
    // Строка не приводится к числу намеренно: остаток шлёт числовое поле формы, а «12 шт» из
    // вставленного буфера обмена обязано быть отказом, а не двенадцатью.
    expect(() =>
      createOfficeEquipmentConsumableSchema.parse({ ...minimal, quantity: '12' }),
    ).toThrow();
  });

  it('набор моделей принимается и пустым, и заполненным, но только ссылками (Р6)', () => {
    expect(
      createOfficeEquipmentConsumableSchema.parse({ ...minimal, modelIds: [] }).modelIds,
    ).toEqual([]);
    expect(
      createOfficeEquipmentConsumableSchema.parse({
        ...minimal,
        modelIds: [MODEL_ID, OTHER_MODEL_ID],
      }).modelIds,
    ).toEqual([MODEL_ID, OTHER_MODEL_ID]);
    // Именем модель здесь не называют: один картридж подходит трём аппаратам, и разбор написаний
    // на этой стороне завёл бы четвёртую, несуществующую модель.
    expect(() =>
      createOfficeEquipmentConsumableSchema.parse({ ...minimal, modelIds: ['Pantum P2500'] }),
    ).toThrow();
    expect(() =>
      createOfficeEquipmentConsumableSchema.parse({ ...minimal, modelIds: MODEL_ID }),
    ).toThrow();
  });

  it('погашенную позицию заводят сразу — флагом, а не отсутствием строки (Р11)', () => {
    expect(
      createOfficeEquipmentConsumableSchema.parse({ ...minimal, isActive: false }).isActive,
    ).toBe(false);
  });
});

describe('контракт правки карточки расходника', () => {
  /**
   * Ключевое решение Р7: остаток меняется только своей ручкой `POST /:id/stock`. В схеме правки он
   * объявлен `z.never()`, а не выброшен молча — принятое и не записанное количество показало бы
   * человеку «сохранено» там, где остаток остался прежним и в журнал ничего не легло.
   */
  it('количество правкой карточки не принимается вовсе — у остатка своя ручка', () => {
    const refused = updateOfficeEquipmentConsumableSchema.safeParse({ quantity: 5 });
    expect(refused.success).toBe(false);
    const issue = refused.error?.issues[0];
    // Причина отказа читается прямо из ошибки: поле не «лишнее» и не «неверного вида» — от него
    // не ждут никакого значения.
    expect(issue?.path).toEqual(['quantity']);
    expect(issue?.code === 'invalid_type' && issue.expected).toBe('never');

    // Ни нулём, ни `null` его тоже не прислать: «обнулить остаток» — такое же событие с причиной.
    expect(updateOfficeEquipmentConsumableSchema.safeParse({ quantity: 0 }).success).toBe(false);
    expect(updateOfficeEquipmentConsumableSchema.safeParse({ quantity: null }).success).toBe(false);
    // Правка остальных полей от этого не страдает: запрет адресован одному полю, а не форме.
    expect(updateOfficeEquipmentConsumableSchema.parse({ comment: 'уточнили' }).comment).toBe(
      'уточнили',
    );
  });

  it('правка без поля ничего не подставляет и ничего не затирает', () => {
    const parsed = updateOfficeEquipmentConsumableSchema.parse({ name: 'Тонер Pantum PC-211EV' });
    expect(parsed.name).toBe('Тонер Pantum PC-211EV');
    // Умолчания заведения здесь обязаны молчать: `.partial()` снимает обязательность, но не
    // `.default()`, и PATCH без поля иначе гасил бы позицию, стирал комментарий и цвет.
    expect(parsed.isActive).toBeUndefined();
    expect(parsed.color).toBeUndefined();
    expect(parsed.comment).toBeUndefined();
    expect(parsed.code).toBeUndefined();
    expect(parsed.modelIds).toBeUndefined();
    expect(updateOfficeEquipmentConsumableSchema.parse({}).isActive).toBeUndefined();

    // Пустое тело законно: PATCH присылает изменившееся, а «ничего не изменилось» — не ошибка.
    expect(updateOfficeEquipmentConsumableSchema.safeParse({}).success).toBe(true);
  });

  it('пустой набор моделей снимает все связи, отсутствие поля их не трогает', () => {
    // Это разные просьбы, и различает их только наличие ключа в теле.
    expect(updateOfficeEquipmentConsumableSchema.parse({ modelIds: [] }).modelIds).toEqual([]);
    expect(updateOfficeEquipmentConsumableSchema.parse({}).modelIds).toBeUndefined();
    expect(updateOfficeEquipmentConsumableSchema.parse({ modelIds: [MODEL_ID] }).modelIds).toEqual([
      MODEL_ID,
    ]);
  });

  it('правка снимает цвет пустой строкой, а гасит позицию флагом', () => {
    // Очищенное поле формы приезжает пустой строкой, и она означает «цвета нет», то есть `null`.
    expect(updateOfficeEquipmentConsumableSchema.parse({ color: '' }).color).toBeNull();
    expect(updateOfficeEquipmentConsumableSchema.parse({ color: 'пурпурный' }).color).toBe(
      'пурпурный',
    );
    expect(updateOfficeEquipmentConsumableSchema.parse({ color: null }).color).toBeNull();
    expect(updateOfficeEquipmentConsumableSchema.parse({ isActive: false }).isActive).toBe(false);
  });

  it('правка не пропускает то, чего не пропускает заведение', () => {
    expect(updateOfficeEquipmentConsumableSchema.safeParse({ code: '' }).success).toBe(false);
    expect(updateOfficeEquipmentConsumableSchema.safeParse({ name: '  ' }).success).toBe(false);
    expect(updateOfficeEquipmentConsumableSchema.safeParse({ color: 'ц'.repeat(61) }).success).toBe(
      false,
    );
    expect(updateOfficeEquipmentConsumableSchema.safeParse({ modelIds: ['мфу'] }).success).toBe(
      false,
    );
  });
});

describe('контракт правки остатка', () => {
  const stock = { quantity: 10, expectedQuantity: 12, reason: 'выдали два в бухгалтерию' };

  it('требует новое значение, виденное значение и причину — все три', () => {
    const parsed = officeEquipmentConsumableStockSchema.parse(stock);
    expect(parsed.quantity).toBe(10);
    expect(parsed.expectedQuantity).toBe(12);
    expect(parsed.reason).toBe('выдали два в бухгалтерию');

    for (const key of ['quantity', 'expectedQuantity', 'reason'] as const) {
      const { [key]: _dropped, ...rest } = stock;
      const refused = officeEquipmentConsumableStockSchema.safeParse(rest);
      expect(refused.success, key).toBe(false);
      expect(refused.error?.issues[0]?.path, key).toEqual([key]);
    }
  });

  /**
   * `expectedQuantity` — не «для совместимости»: без него два кладовщика, открывшие карточку с
   * числом 12, запишут «12 → 10» и «12 → 8», и цепочка журнала станет враньём при верном итоге.
   * Различить «я видел 12» и «мне всё равно» после этого нечем, поэтому поле обязательно, а не
   * необязательно с умолчанием.
   */
  it('виденное значение обязательно и умолчания не имеет', () => {
    expect(
      officeEquipmentConsumableStockSchema.safeParse({ quantity: 10, reason: 'выдали два' })
        .success,
    ).toBe(false);
    expect(
      officeEquipmentConsumableStockSchema.safeParse({ ...stock, expectedQuantity: undefined })
        .success,
    ).toBe(false);
    // Ноль виденным значением законен: первая правка карточки, заведённой без остатка, идёт от нуля.
    expect(
      officeEquipmentConsumableStockSchema.parse({ ...stock, expectedQuantity: 0, quantity: 12 })
        .expectedQuantity,
    ).toBe(0);
  });

  it('причина обязательна, тримится и не бывает отпиской в один символ', () => {
    expect(
      officeEquipmentConsumableStockSchema.parse({ ...stock, reason: '  списали два  ' }).reason,
    ).toBe('списали два');
    expect(officeEquipmentConsumableStockSchema.safeParse({ ...stock, reason: '' }).success).toBe(
      false,
    );
    expect(
      officeEquipmentConsumableStockSchema.safeParse({ ...stock, reason: '   ' }).success,
    ).toBe(false);
    // «12 → 4» с причиной «-» читать через месяц так же нечем, как без причины вовсе.
    expect(officeEquipmentConsumableStockSchema.safeParse({ ...stock, reason: '.' }).success).toBe(
      false,
    );
    const long = officeEquipmentConsumableStockSchema.safeParse({
      ...stock,
      reason: 'п'.repeat(1000),
    });
    expect(long.success).toBe(true);
    expect(
      officeEquipmentConsumableStockSchema.safeParse({ ...stock, reason: 'п'.repeat(1001) })
        .success,
    ).toBe(false);
  });

  it('оба числа — целые от нуля до миллиона', () => {
    expect(officeEquipmentConsumableStockSchema.parse({ ...stock, quantity: 0 }).quantity).toBe(0);
    for (const bad of [-1, 1.5, 1_000_001, '10']) {
      expect(
        officeEquipmentConsumableStockSchema.safeParse({ ...stock, quantity: bad }).success,
        `quantity=${String(bad)}`,
      ).toBe(false);
      expect(
        officeEquipmentConsumableStockSchema.safeParse({ ...stock, expectedQuantity: bad }).success,
        `expectedQuantity=${String(bad)}`,
      ).toBe(false);
    }
  });

  /**
   * Равенство нового и текущего схема не отбивает намеренно: это не ошибка ввода, а повторное
   * нажатие кнопки. Маршрут в таком случае выходит без записи — журнал не должен пухнуть от
   * событий «10 → 10», и ограничение базы такую строку всё равно не пропустит (Р7, шаг 3).
   */
  it('повторное нажатие тем же числом схемой не отбивается', () => {
    expect(
      officeEquipmentConsumableStockSchema.parse({ ...stock, quantity: 12, expectedQuantity: 12 })
        .quantity,
    ).toBe(12);
  });

  it('вид события и ссылку на заявку тело правки не несёт', () => {
    // `entry_kind = 'manual'` и пустые ссылки ставит сама ручка: выдать ручную правку за списание
    // по заявке клиент не может, и лишние ключи до маршрута не доезжают.
    const parsed = officeEquipmentConsumableStockSchema.parse({
      ...stock,
      entryKind: 'issue',
      serviceRequestId: '33333333-3333-4333-8333-333333333333',
      // Обе ссылки, а не одна: `CHECK` связок в базе требует их парой, и подделать выдачу можно
      // было бы только вместе. Проверка отбрасывания обязана перечислять ровно то же, что
      // перечисляет ограничение.
      serviceRequestConsumableId: '55555555-5555-4555-8555-555555555555',
    });
    expect(parsed).toEqual(stock);
    expect('entryKind' in parsed).toBe(false);
    expect('serviceRequestId' in parsed).toBe(false);
    expect('serviceRequestConsumableId' in parsed).toBe(false);
  });

  /**
   * Обратная половина того же решения: наружу вид события и ссылки **отдаются** — лента журнала
   * читается людьми, и «−2» без ответа «почему» её и портит. Проверяют это `expect`'ы в теле, а не
   * аннотация типа: почему на компилятор здесь полагаться нельзя, сказано там же.
   */
  it('строка журнала отдаёт вид события и ссылки, которых нет во входе', () => {
    const manual: OfficeEquipmentConsumableStockEntryDto = {
      id: '44444444-4444-4444-8444-444444444444',
      seq: 1,
      entryKind: 'manual',
      serviceRequestId: null,
      serviceRequestConsumableId: null,
      quantityBefore: 0,
      quantityAfter: 12,
      reason: 'первичный ввод остатка',
      changedByName: 'Иванов И. И.',
      createdAt: '2026-08-21T10:00:00.000Z',
    };
    /*
     * У ручной правки пусты ОБЕ ссылки — это и отличает её от выдачи (Р7), и проверяются они здесь
     * обе. Аннотация типа тут не страхует: `apps/api/tsconfig.json` не включает каталог `test/`, а
     * vitest типы не проверяет, — фикстура, забывшая обязательное поле DTO, прошла бы и
     * `pnpm typecheck`, и прогон. Поэтому недостающее поле ловится не компилятором, а вот этим
     * `expect`.
     */
    expect(manual.serviceRequestId).toBeNull();
    expect(manual.serviceRequestConsumableId).toBeNull();
    // Первое событие карточки начинается с нуля: до него в журнале пусто, а пустой журнал значит ноль.
    expect(manual.quantityBefore).toBe(0);
  });
});

describe('контракт списка расходников', () => {
  it('сортирует по наименованию вверх — умолчание базовой схемы здесь переопределено', () => {
    // Ловушка: `baseListQuery` ставит умолчанием `desc`, и перечень пришёл бы от «Тонера» к
    // «Картриджу», то есть задом наперёд. Проверяется именно значение по умолчанию, а не то, что
    // поле принимается.
    expect(baseListQuery(OFFICE_EQUIPMENT_CONSUMABLE_SORT_FIELDS).parse({}).sortOrder).toBe('desc');
    expect(officeEquipmentConsumableListQuerySchema.parse({}).sortOrder).toBe('asc');
    expect(officeEquipmentConsumableListQuerySchema.parse({ sortOrder: 'desc' }).sortOrder).toBe(
      'desc',
    );

    // Поле сортировки схема умолчанием не задаёт: «наименование» приходит четвёртым аргументом
    // `orderByFrom` в маршруте. Умолчание в двух местах разъехалось бы, поэтому здесь — `undefined`,
    // но само поле обязано оставаться допустимым: иначе умолчание маршрута промахнётся мимо
    // разрешённых колонок.
    expect(officeEquipmentConsumableListQuerySchema.parse({}).sortBy).toBeUndefined();
    expect(officeEquipmentConsumableListQuerySchema.parse({ sortBy: 'name' }).sortBy).toBe('name');
  });

  it('сортируют четырьмя полями, и счётчика «в парке» среди них нет (Р9, Р12)', () => {
    expect(OFFICE_EQUIPMENT_CONSUMABLE_SORT_FIELDS).toEqual([
      'name',
      'code',
      'quantity',
      'updatedAt',
    ]);
    for (const sortBy of OFFICE_EQUIPMENT_CONSUMABLE_SORT_FIELDS) {
      expect(officeEquipmentConsumableListQuerySchema.parse({ sortBy }).sortBy, sortBy).toBe(
        sortBy,
      );
    }
    // «Сколько таких аппаратов в парке» считается в области смотрящего, и порядок строк, зависящий
    // от того, кто смотрит, читался бы как ошибка портала.
    for (const sortBy of ['modelsCount', 'models', 'color', 'comment', 'id']) {
      const refused = officeEquipmentConsumableListQuerySchema.safeParse({ sortBy });
      expect(refused.success, sortBy).toBe(false);
      expect(refused.error?.issues[0]?.message, sortBy).toBe('Недопустимое поле сортировки');
    }
  });

  it('фильтрует по модели, наличию и активности — и только объявленными значениями', () => {
    const q = officeEquipmentConsumableListQuerySchema.parse({
      modelId: MODEL_ID,
      stock: 'out_of_stock',
      isActive: 'true',
      search: '  Pantum  ',
    });
    expect(q.modelId).toBe(MODEL_ID);
    expect(q.stock).toBe('out_of_stock');
    expect(q.isActive).toBe(true);
    expect(q.search).toBe('Pantum');
    expect(officeEquipmentConsumableListQuerySchema.parse({ isActive: 'false' }).isActive).toBe(
      false,
    );

    expect(OFFICE_EQUIPMENT_CONSUMABLE_STOCK_FILTERS).toEqual(['in_stock', 'out_of_stock']);
    for (const stock of OFFICE_EQUIPMENT_CONSUMABLE_STOCK_FILTERS) {
      expect(officeEquipmentConsumableListQuerySchema.parse({ stock }).stock, stock).toBe(stock);
    }
    // Третьего значения у наличия нет: «мало осталось» — это минимальный остаток, которого в
    // справочнике пока не заведено (§10).
    expect(officeEquipmentConsumableListQuerySchema.safeParse({ stock: 'low' }).success).toBe(
      false,
    );
    expect(officeEquipmentConsumableListQuerySchema.safeParse({ stock: '' }).success).toBe(false);
    expect(officeEquipmentConsumableListQuerySchema.safeParse({ isActive: 'да' }).success).toBe(
      false,
    );
    expect(officeEquipmentConsumableListQuerySchema.safeParse({ modelId: 'Pantum' }).success).toBe(
      false,
    );
  });

  it('без фильтров список полный, а страница — первая и на сто строк', () => {
    const q = officeEquipmentConsumableListQuerySchema.parse({});
    // Фильтра нет — «любая», а не «активная»: погашенную позицию из справочника не убирают, и
    // спрашивают её тем же переключателем.
    expect(q.isActive).toBeUndefined();
    expect(q.stock).toBeUndefined();
    expect(q.modelId).toBeUndefined();
    expect(q.search).toBeUndefined();
    expect(q.page).toBe(1);
    expect(q.pageSize).toBe(100);
    // Размер страницы — из перечня, а не любое число: своим числом клиент выгрузил бы весь
    // справочник одним запросом.
    expect(officeEquipmentConsumableListQuerySchema.parse({ pageSize: '200' }).pageSize).toBe(200);
    expect(officeEquipmentConsumableListQuerySchema.safeParse({ pageSize: '150' }).success).toBe(
      false,
    );
    expect(officeEquipmentConsumableListQuerySchema.safeParse({ page: '0' }).success).toBe(false);
  });
});

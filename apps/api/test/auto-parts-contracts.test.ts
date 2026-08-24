import { describe, expect, it } from 'vitest';
import {
  AUTO_PART_SORT_FIELDS,
  AUTO_PART_STOCK_FILTERS,
  autoPartListQuerySchema,
  autoPartStockSchema,
  baseListQuery,
  createAutoPartSchema,
  type AutoPartStockEntryDto,
  updateAutoPartSchema,
} from '@technic/contracts';

/**
 * Схемы склада автозапчастей (план `docs/auto-parts-plan.md`, Р3, Р8, Р9, Р12, Р13, Р21).
 *
 * Проверяется не «zod работает», а решения плана — те, которые молча разъезжаются между формой и
 * сервером. Их здесь четыре рода:
 *
 * 1. **Чего схема не принимает вовсе.** Остаток убран из правки карточки (Р3): приняв количество и
 *    не записав его, портал соврал бы человеку — «сохранено» при неизменившемся остатке, пустом
 *    журнале и неспрошенном праве `autoParts.stock`.
 * 2. **Что подставляется само.** Каждый `.default()` — значение, которого человек в форме не видел,
 *    но которое уедет в базу; поэтому умолчание проверяется по значению, а не по факту «поле
 *    необязательное». Единица измерения здесь главная: «5» без неё — не число, а загадка (Р9).
 * 3. **Что схема отбивает словами вместо ограничения базы.** «Ровно одна ссылка» в строке
 *    применимости повторяет `CHECK auto_part_applicability_target_check` намеренно: без неё тело
 *    ушло бы в базу и вернулось пятисоткой с именем ограничения (Р8).
 * 4. **Где вопросы разные, а поля похожи.** `vehicleId` — подбор под машину, `vehicleModelId` —
 *    отбор по разметке; сочетание отбивается, а не разрешается молчаливым предпочтением (Р21).
 *
 * Написание артикула здесь намеренно НЕ проверяется: правило живёт функцией базы
 * `auto_part_code_key` (она же стоит в уникальных индексах и в `CHECK`), а вторая копия правила на
 * TypeScript завела бы в справочник второй «тот же» артикул. Схема снимает только края.
 */

const MODEL_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_MODEL_ID = '22222222-2222-4222-8222-222222222222';
const TYPE_ID = '33333333-3333-4333-8333-333333333333';
const VEHICLE_ID = '44444444-4444-4444-8444-444444444444';

/** Минимальная карточка: механик заводит позицию одним наименованием, до всякой номенклатуры. */
const minimal = { name: 'Ремень генератора' };

describe('контракт заведения автозапчасти', () => {
  it('требует одно наименование; остальное подставляется умолчанием', () => {
    const parsed = createAutoPartSchema.parse(minimal);
    expect(parsed.name).toBe('Ремень генератора');
    // Артикул НЕОБЯЗАТЕЛЕН (Р12) — главное отличие от расходников оргтехники, где код приезжает
    // выгрузкой. «Кода нет» имеет одно представление, `null`: два разных «пустых» значения
    // развалили бы уникальность пары «наименование + артикул».
    expect(parsed.code).toBeNull();
    // Единица по умолчанию — «шт» (Р9). Не подсказка в поле, а значение: пустой единицы не бывает
    // (`CHECK auto_parts_unit_not_blank_check`), а большинство позиций считают штуками.
    expect(parsed.unit).toBe('шт');
    // Заведение с нулём — не событие, а отсутствие событий: первой строки журнала при нём не будет
    // («0 → 0» не пропустит `CHECK`), и права на склад оно не требует (Р3, Р10).
    expect(parsed.quantity).toBe(0);
    expect(parsed.isActive).toBe(true);
    expect(parsed.comment).toBe('');
    // Пустая применимость законна: к чему деталь подходит — вопрос к механику, и ждать ответа, не
    // заводя позицию, значит потерять её совсем (Р8).
    expect(parsed.applicability).toEqual([]);

    expect(createAutoPartSchema.safeParse({}).success).toBe(false);
    // Пробелы содержимым не считаются: тримминг идёт до проверки длины.
    expect(createAutoPartSchema.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('пустой артикул любым из трёх написаний становится `null`, а не пустой строкой', () => {
    expect(createAutoPartSchema.parse(minimal).code).toBeNull();
    expect(createAutoPartSchema.parse({ ...minimal, code: '' }).code).toBeNull();
    expect(createAutoPartSchema.parse({ ...minimal, code: '   ' }).code).toBeNull();
    expect(createAutoPartSchema.parse({ ...minimal, code: null }).code).toBeNull();
    // Заполненный артикул схема лишь обрезает по краям: регистр поднимает и внутренние пробелы
    // удаляет `auto_part_code_key` в маршруте, и это единственная копия правила.
    expect(createAutoPartSchema.parse({ ...minimal, code: '  mann w914/2  ' }).code).toBe(
      'mann w914/2',
    );
  });

  it('держит границы длин: артикул до 50, наименование 2–255, единица 1–20', () => {
    const ok = createAutoPartSchema.parse({
      code: 'A'.repeat(50),
      name: 'Р'.repeat(255),
      unit: 'е'.repeat(20),
      comment: 'к'.repeat(2000),
    });
    expect(ok.code).toHaveLength(50);
    expect(ok.name).toHaveLength(255);
    expect(ok.unit).toHaveLength(20);

    expect(createAutoPartSchema.safeParse({ ...minimal, code: 'A'.repeat(51) }).success).toBe(
      false,
    );
    expect(createAutoPartSchema.safeParse({ name: 'Р'.repeat(256) }).success).toBe(false);
    expect(createAutoPartSchema.safeParse({ ...minimal, unit: 'е'.repeat(21) }).success).toBe(
      false,
    );
    expect(createAutoPartSchema.safeParse({ ...minimal, unit: '' }).success).toBe(false);
    expect(createAutoPartSchema.safeParse({ ...minimal, comment: 'к'.repeat(2001) }).success).toBe(
      false,
    );
    // Односимвольное наименование не различает позиции даже для того, кто его завёл, а поиск по
    // нему отбирает половину справочника. Артикул из одного символа при этом законен — он не
    // выдумывается, а переписывается с коробки.
    expect(createAutoPartSchema.safeParse({ name: 'Р' }).success).toBe(false);
    expect(createAutoPartSchema.parse({ ...minimal, code: 'A' }).code).toBe('A');
  });

  it('единица измерения — любое слово склада, а не перечень (Р9)', () => {
    for (const unit of ['шт', 'л', 'компл', 'м', 'банка', 'кг']) {
      expect(createAutoPartSchema.parse({ ...minimal, unit }).unit, unit).toBe(unit);
    }
    expect(createAutoPartSchema.parse({ ...minimal, unit: '  л  ' }).unit).toBe('л');
  });

  it('начальный остаток — целое от нуля до миллиона и только числом', () => {
    expect(createAutoPartSchema.parse({ ...minimal, quantity: 12 }).quantity).toBe(12);
    expect(createAutoPartSchema.parse({ ...minimal, quantity: 1_000_000 }).quantity).toBe(
      1_000_000,
    );
    // Верхняя граница — не учётное правило, а защита от опечатки: «120» вместо «12» от правды
    // ничем не отличается, а склада на миллион болтов у гаража нет.
    for (const bad of [1_000_001, -1, 1.5, '12']) {
      expect(
        createAutoPartSchema.safeParse({ ...minimal, quantity: bad }).success,
        `quantity=${String(bad)}`,
      ).toBe(false);
    }
  });

  /**
   * Р8: строка применимости — ЛИБО модель, ЛИБО тип. Проверка схемой, а не `z.union` двух форм:
   * союз отвечает на ошибку перебором веток, и приславший обе ссылки прочитал бы про обе сразу
   * вместо одного внятного «выберите что-то одно».
   */
  it('в строке применимости ровно одна ссылка — ни двух, ни нуля', () => {
    const byModel = createAutoPartSchema.parse({
      ...minimal,
      applicability: [{ vehicleModelId: MODEL_ID }],
    });
    expect(byModel.applicability).toEqual([{ vehicleModelId: MODEL_ID, vehicleTypeId: null }]);
    const byType = createAutoPartSchema.parse({
      ...minimal,
      applicability: [{ vehicleTypeId: TYPE_ID }],
    });
    expect(byType.applicability).toEqual([{ vehicleModelId: null, vehicleTypeId: TYPE_ID }]);
    // Обе ссылки означали бы «подходит этой модели И всем машинам её типа», где второе поглощает
    // первое; ни одной — разметку, не размечающую ничего.
    const both = createAutoPartSchema.safeParse({
      ...minimal,
      applicability: [{ vehicleModelId: MODEL_ID, vehicleTypeId: TYPE_ID }],
    });
    expect(both.success).toBe(false);
    expect(both.error?.issues[0]?.message).toBe(
      'В строке применимости указывается либо модель, либо тип техники — что-то одно',
    );
    expect(
      createAutoPartSchema.safeParse({ ...minimal, applicability: [{}] }).success,
      'строка без ссылок',
    ).toBe(false);
    expect(
      createAutoPartSchema.safeParse({
        ...minimal,
        applicability: [{ vehicleModelId: null, vehicleTypeId: null }],
      }).success,
      'обе ссылки пусты',
    ).toBe(false);
    // Именем модель здесь не называют: разбор написаний на этой стороне завёл бы вторую,
    // несуществующую модель.
    expect(
      createAutoPartSchema.safeParse({ ...minimal, applicability: [{ vehicleModelId: 'КамАЗ' }] })
        .success,
    ).toBe(false);
  });

  it('повтор в разметке отбивается словами, а не ключом базы', () => {
    const twice = createAutoPartSchema.safeParse({
      ...minimal,
      applicability: [{ vehicleModelId: MODEL_ID }, { vehicleModelId: MODEL_ID }],
    });
    expect(twice.success).toBe(false);
    expect(twice.error?.issues[0]?.message).toBe(
      'Модель или тип указаны в применимости дважды — уберите повтор',
    );
    // Разные оси не считаются повтором: «эта модель» и «весь её тип» — разные утверждения, и
    // позиция, размеченная обеими, законна (в подборе она придёт один раз, рангом 0 — Р21).
    expect(
      createAutoPartSchema.safeParse({
        ...minimal,
        applicability: [{ vehicleModelId: MODEL_ID }, { vehicleTypeId: TYPE_ID }],
      }).success,
    ).toBe(true);
    // Потолок — защита от тела, в котором приехал весь справочник моделей: деталь, подходящая двум
    // сотням моделей, размечается ТИПОМ.
    const many = Array.from({ length: 201 }, (_, i) => ({
      vehicleModelId: `1111111${String(i).padStart(4, '0')}-1111-4111-8111-111111111111`.slice(-36),
    }));
    expect(createAutoPartSchema.safeParse({ ...minimal, applicability: many }).success).toBe(false);
  });

  it('погашенную позицию заводят сразу — флагом, а не отсутствием строки (Р11)', () => {
    expect(createAutoPartSchema.parse({ ...minimal, isActive: false }).isActive).toBe(false);
  });
});

describe('контракт правки автозапчасти', () => {
  /**
   * Ключевое решение Р3: остаток меняется только своей ручкой `POST /:id/stock`. В схеме правки он
   * объявлен `z.never()`, а не выброшен молча — принятое и не записанное количество показало бы
   * человеку «сохранено» там, где остаток остался прежним и в журнал ничего не легло.
   */
  it('количество правкой карточки не принимается вовсе — у остатка своя ручка', () => {
    const refused = updateAutoPartSchema.safeParse({ quantity: 5 });
    expect(refused.success).toBe(false);
    const issue = refused.error?.issues[0];
    // Причина отказа читается прямо из ошибки: поле не «лишнее» и не «неверного вида» — от него не
    // ждут никакого значения.
    expect(issue?.path).toEqual(['quantity']);
    expect(issue?.code === 'invalid_type' && issue.expected).toBe('never');

    // Ни нулём, ни `null` его тоже не прислать: «обнулить остаток» — такое же событие с причиной.
    expect(updateAutoPartSchema.safeParse({ quantity: 0 }).success).toBe(false);
    expect(updateAutoPartSchema.safeParse({ quantity: null }).success).toBe(false);
    // Правка остальных полей от этого не страдает: запрет адресован одному полю, а не форме.
    expect(updateAutoPartSchema.parse({ comment: 'уточнили' }).comment).toBe('уточнили');
  });

  it('правка без поля ничего не подставляет и ничего не затирает', () => {
    const parsed = updateAutoPartSchema.parse({ name: 'Ремень генератора 6PK1200' });
    expect(parsed.name).toBe('Ремень генератора 6PK1200');
    // Умолчания заведения здесь обязаны молчать: `.partial()` снимает обязательность, но не
    // `.default()`, и PATCH без поля иначе ставил бы единицу «шт», поднимал флаг активности и
    // стирал комментарий.
    expect(parsed.unit).toBeUndefined();
    expect(parsed.isActive).toBeUndefined();
    expect(parsed.comment).toBeUndefined();
    expect(parsed.code).toBeUndefined();
    expect(parsed.applicability).toBeUndefined();
    expect(updateAutoPartSchema.parse({}).unit).toBeUndefined();
    // Пустое тело законно: PATCH присылает изменившееся, а «ничего не изменилось» — не ошибка.
    expect(updateAutoPartSchema.safeParse({}).success).toBe(true);
  });

  it('пустой набор применимости снимает всю разметку, отсутствие поля её не трогает', () => {
    // Это разные просьбы, и различает их только наличие ключа в теле (Р18 — то же правило, что у
    // строк акта обслуживания).
    expect(updateAutoPartSchema.parse({ applicability: [] }).applicability).toEqual([]);
    expect(updateAutoPartSchema.parse({}).applicability).toBeUndefined();
    expect(
      updateAutoPartSchema.parse({ applicability: [{ vehicleTypeId: TYPE_ID }] }).applicability,
    ).toEqual([{ vehicleModelId: null, vehicleTypeId: TYPE_ID }]);
  });

  it('правка снимает артикул пустой строкой, а гасит позицию флагом', () => {
    // Очищенное поле формы приезжает пустой строкой, и она означает «артикула нет», то есть `null`.
    expect(updateAutoPartSchema.parse({ code: '' }).code).toBeNull();
    expect(updateAutoPartSchema.parse({ code: null }).code).toBeNull();
    expect(updateAutoPartSchema.parse({ code: '21126-1006040' }).code).toBe('21126-1006040');
    expect(updateAutoPartSchema.parse({ isActive: false }).isActive).toBe(false);
  });

  it('правка не пропускает того, чего не пропускает заведение', () => {
    expect(updateAutoPartSchema.safeParse({ name: '  ' }).success).toBe(false);
    expect(updateAutoPartSchema.safeParse({ unit: '' }).success).toBe(false);
    expect(updateAutoPartSchema.safeParse({ code: 'A'.repeat(51) }).success).toBe(false);
    expect(
      updateAutoPartSchema.safeParse({
        applicability: [{ vehicleModelId: MODEL_ID, vehicleTypeId: TYPE_ID }],
      }).success,
    ).toBe(false);
  });
});

describe('контракт правки остатка', () => {
  const stock = { quantity: 10, expectedQuantity: 12, reason: 'продали два на сторону' };

  it('требует новое значение, виденное значение и причину — все три', () => {
    const parsed = autoPartStockSchema.parse(stock);
    expect(parsed).toEqual(stock);

    for (const key of ['quantity', 'expectedQuantity', 'reason'] as const) {
      const { [key]: _dropped, ...rest } = stock;
      const refused = autoPartStockSchema.safeParse(rest);
      expect(refused.success, key).toBe(false);
      expect(refused.error?.issues[0]?.path, key).toEqual([key]);
    }
  });

  /**
   * `expectedQuantity` — не «для совместимости»: без него два механика, открывшие карточку с числом
   * 12, запишут «12 → 10» и «12 → 8», и цепочка журнала станет враньём при верном итоге. Различить
   * «я видел 12» и «мне всё равно» после этого нечем, поэтому поле обязательно, а не необязательно
   * с умолчанием.
   */
  it('виденное значение обязательно и умолчания не имеет', () => {
    expect(autoPartStockSchema.safeParse({ quantity: 10, reason: 'списали два' }).success).toBe(
      false,
    );
    expect(autoPartStockSchema.safeParse({ ...stock, expectedQuantity: undefined }).success).toBe(
      false,
    );
    // Ноль виденным значением законен: первая правка карточки, заведённой без остатка, идёт от нуля.
    expect(
      autoPartStockSchema.parse({ ...stock, expectedQuantity: 0, quantity: 12 }).expectedQuantity,
    ).toBe(0);
  });

  it('причина обязательна, тримится и не бывает отпиской в один символ', () => {
    expect(autoPartStockSchema.parse({ ...stock, reason: '  пересчитали  ' }).reason).toBe(
      'пересчитали',
    );
    for (const reason of ['', '   ', '.']) {
      expect(autoPartStockSchema.safeParse({ ...stock, reason }).success, reason).toBe(false);
    }
    expect(autoPartStockSchema.safeParse({ ...stock, reason: 'п'.repeat(1000) }).success).toBe(
      true,
    );
    expect(autoPartStockSchema.safeParse({ ...stock, reason: 'п'.repeat(1001) }).success).toBe(
      false,
    );
  });

  it('оба числа — целые от нуля до миллиона', () => {
    expect(autoPartStockSchema.parse({ ...stock, quantity: 0 }).quantity).toBe(0);
    for (const bad of [-1, 1.5, 1_000_001, '10']) {
      expect(
        autoPartStockSchema.safeParse({ ...stock, quantity: bad }).success,
        `quantity=${String(bad)}`,
      ).toBe(false);
      expect(
        autoPartStockSchema.safeParse({ ...stock, expectedQuantity: bad }).success,
        `expectedQuantity=${String(bad)}`,
      ).toBe(false);
    }
  });

  /**
   * Равенство нового и текущего схема не отбивает намеренно: это не ошибка ввода, а повторное
   * нажатие кнопки. Маршрут в таком случае выходит без записи (`entry: null`) — журнал не должен
   * пухнуть от событий «10 → 10», и ограничение базы такую строку всё равно не пропустит.
   */
  it('повторное нажатие тем же числом схемой не отбивается', () => {
    expect(
      autoPartStockSchema.parse({ ...stock, quantity: 12, expectedQuantity: 12 }).quantity,
    ).toBe(12);
  });

  it('вид события и ссылку на акт тело правки не несёт', () => {
    // `entry_kind = 'manual'` и пустую ссылку на акт ставит сама ручка: выдать ручную правку за
    // расход по обслуживанию клиент не может, а `.strict()` отбивает попытку прислать их.
    const refused = autoPartStockSchema.safeParse({
      ...stock,
      entryKind: 'issue',
      maintenanceId: '55555555-5555-4555-8555-555555555555',
    });
    expect(refused.success).toBe(false);
  });

  /**
   * Обратная половина того же решения: наружу вид события и реквизиты акта **отдаются** — лента
   * журнала читается людьми, и «−2» без ответа «почему» её и портит. Проверяют это `expect`'ы в
   * теле, а не аннотация типа: `apps/api/tsconfig.json` не включает каталог `test/`, а vitest типы
   * не проверяет, — фикстура, забывшая обязательное поле DTO, прошла бы и типизацию, и прогон.
   */
  it('строка журнала отдаёт вид события и реквизиты акта, которых нет во входе', () => {
    const manual: AutoPartStockEntryDto = {
      id: '66666666-6666-4666-8666-666666666666',
      seq: 1,
      entryKind: 'manual',
      maintenanceId: null,
      maintenanceVehicleId: null,
      maintenanceVehicleLabel: null,
      maintenancePerformedOn: null,
      quantityBefore: 0,
      quantityAfter: 12,
      reason: 'Заведение карточки: начальный остаток',
      changedByName: 'Иванов И. И.',
      createdAt: '2026-08-24T10:00:00.000Z',
    };
    // У ручной правки пусты ВСЕ ЧЕТЫРЕ поля акта — порознь они не бывают (`CHECK
    // auto_part_stock_links_check`), и проверяются здесь все четыре.
    expect(manual.maintenanceId).toBeNull();
    expect(manual.maintenanceVehicleId).toBeNull();
    expect(manual.maintenanceVehicleLabel).toBeNull();
    expect(manual.maintenancePerformedOn).toBeNull();
    // Первое событие карточки начинается с нуля: до него в журнале пусто, а пустой журнал — это ноль.
    expect(manual.quantityBefore).toBe(0);
  });
});

describe('контракт списка автозапчастей', () => {
  it('сортирует по наименованию вверх — умолчание базовой схемы здесь переопределено', () => {
    // Ловушка: `baseListQuery` ставит умолчанием `desc`, и перечень пришёл бы от «Я» к «А».
    expect(baseListQuery(AUTO_PART_SORT_FIELDS).parse({}).sortOrder).toBe('desc');
    expect(autoPartListQuerySchema.parse({}).sortOrder).toBe('asc');
    expect(autoPartListQuerySchema.parse({ sortOrder: 'desc' }).sortOrder).toBe('desc');
    // Поле сортировки схема умолчанием не задаёт: «наименование» приходит четвёртым аргументом
    // `orderByFrom` в маршруте, и умолчание в двух местах разъехалось бы.
    expect(autoPartListQuerySchema.parse({}).sortBy).toBeUndefined();
  });

  it('сортируют четырьмя полями, и счётчика применимости среди них нет (Р13)', () => {
    expect(AUTO_PART_SORT_FIELDS).toEqual(['name', 'code', 'quantity', 'updatedAt']);
    for (const sortBy of AUTO_PART_SORT_FIELDS) {
      expect(autoPartListQuerySchema.parse({ sortBy }).sortBy, sortBy).toBe(sortBy);
    }
    // Длина разметки говорит не о детали, а о том, насколько механик успел её разметить, и порядок
    // строк по такому числу читался бы как оценка позиции.
    for (const sortBy of ['applicability', 'applicabilityRank', 'unit', 'id']) {
      const refused = autoPartListQuerySchema.safeParse({ sortBy });
      expect(refused.success, sortBy).toBe(false);
      expect(refused.error?.issues[0]?.message, sortBy).toBe('Недопустимое поле сортировки');
    }
  });

  it('фильтрует по наличию, активности, модели и типу — и только объявленными значениями', () => {
    const q = autoPartListQuerySchema.parse({
      stock: 'out_of_stock',
      isActive: 'true',
      vehicleModelId: MODEL_ID,
      search: '  фильтр масл  ',
    });
    expect(q.stock).toBe('out_of_stock');
    expect(q.isActive).toBe(true);
    expect(q.vehicleModelId).toBe(MODEL_ID);
    expect(q.search).toBe('фильтр масл');
    expect(autoPartListQuerySchema.parse({ vehicleTypeId: TYPE_ID }).vehicleTypeId).toBe(TYPE_ID);

    expect(AUTO_PART_STOCK_FILTERS).toEqual(['in_stock', 'out_of_stock']);
    for (const stock of AUTO_PART_STOCK_FILTERS) {
      expect(autoPartListQuerySchema.parse({ stock }).stock, stock).toBe(stock);
    }
    // Третьего значения у наличия нет: «мало осталось» — это минимальный остаток, которого выпуск
    // не заводит (§12).
    expect(autoPartListQuerySchema.safeParse({ stock: 'low' }).success).toBe(false);
    expect(autoPartListQuerySchema.safeParse({ isActive: 'да' }).success).toBe(false);
    expect(autoPartListQuerySchema.safeParse({ vehicleModelId: 'КамАЗ' }).success).toBe(false);
  });

  /**
   * Р21: `vehicleId` — не фильтр, а подбор, и с отбором по разметке он не сочетается. «Что подходит
   * этой машине» и «что размечено этой моделью» — разные вопросы, и молчаливое предпочтение одного
   * другому читалось бы как ошибка портала.
   */
  it('подбор по машине не сочетается с отбором по модели и типу', () => {
    expect(autoPartListQuerySchema.parse({ vehicleId: VEHICLE_ID }).vehicleId).toBe(VEHICLE_ID);
    for (const extra of [{ vehicleModelId: MODEL_ID }, { vehicleTypeId: TYPE_ID }]) {
      const refused = autoPartListQuerySchema.safeParse({ vehicleId: VEHICLE_ID, ...extra });
      expect(refused.success, JSON.stringify(extra)).toBe(false);
      expect(refused.error?.issues[0]?.path).toEqual(['vehicleId']);
    }
    // Без машины оба отбора по разметке уживаются друг с другом: это сужение, а не спор.
    expect(
      autoPartListQuerySchema.safeParse({ vehicleModelId: MODEL_ID, vehicleTypeId: TYPE_ID })
        .success,
    ).toBe(true);
    expect(
      autoPartListQuerySchema.safeParse({ vehicleId: VEHICLE_ID, stock: 'in_stock' }).success,
      'наличие подбору не мешает',
    ).toBe(true);
    expect(autoPartListQuerySchema.safeParse({ vehicleId: OTHER_MODEL_ID }).success).toBe(true);
  });

  it('без фильтров список полный, а страница — первая и на сто строк', () => {
    const q = autoPartListQuerySchema.parse({});
    // Фильтра нет — «любая», а не «активная»: погашенную позицию из справочника не убирают, и
    // спрашивают её тем же переключателем.
    expect(q.isActive).toBeUndefined();
    expect(q.stock).toBeUndefined();
    expect(q.vehicleId).toBeUndefined();
    expect(q.vehicleModelId).toBeUndefined();
    expect(q.vehicleTypeId).toBeUndefined();
    expect(q.search).toBeUndefined();
    expect(q.page).toBe(1);
    expect(q.pageSize).toBe(100);
    // Размер страницы — из перечня, а не любое число: своим числом клиент выгрузил бы весь
    // справочник одним запросом.
    expect(autoPartListQuerySchema.parse({ pageSize: '200' }).pageSize).toBe(200);
    expect(autoPartListQuerySchema.safeParse({ pageSize: '150' }).success).toBe(false);
    expect(autoPartListQuerySchema.safeParse({ page: '0' }).success).toBe(false);
  });
});

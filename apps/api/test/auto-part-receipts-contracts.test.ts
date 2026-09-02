import { describe, expect, it } from 'vitest';
import {
  autoPartReceiptListQuerySchema,
  autoPartReceiptSummaryQuerySchema,
  createReceiptSchema,
  moscowDateKeyOf,
  RECEIPT_FUTURE_DATE_MESSAGE,
  RECEIPT_MAX_AMOUNT,
  RECEIPT_MAX_FILES,
  RECEIPT_MAX_LINES,
  RECEIPT_MAX_QUANTITY,
  RECEIPT_NO_FILES_MESSAGE,
  RECEIPT_NO_LINES_MESSAGE,
  receiptDeletionMarkSchema,
  receiptVersionQuerySchema,
  shiftDateKey,
  updateReceiptSchema,
  vehiclePartsSpendQuerySchema,
  vehiclePartsSpendSnapshotQuerySchema,
} from '@technic/contracts';

/**
 * Схемы чеков на автозапчасти (план `docs/auto-part-receipts-plan.md`, §10; решения Р1а, Р6, Р8—Р13).
 *
 * Проверяется не «zod работает», а решения плана — те, что молча разъезжаются между формой и
 * сервером либо между схемой и базой. Их здесь четыре рода:
 *
 * 1. **Чего в схеме нет вовсе.** Итога (Р11) и `seq` (§6): оба считает сервер, и `.strict()` — это
 *    и есть механизм обещания «свой итог прислать нельзя». В обычном `z.object` присланный `total`
 *    молча отбросился бы, и «нельзя» означало бы всего лишь «не подействует».
 * 2. **Что подставляется само.** Каждый `.default()` — значение, которого человек в форме не
 *    видел, но которое уедет в базу: единица «шт», пустой продавец, `vehicleId: null` («не
 *    отнесено», Р8). Поэтому умолчание проверяется по значению, а не по факту «поле необязательное».
 * 3. **Границы, которых не задаёт тип.** `z.int()` здешнего zod пропускает `3_000_000_000`, а
 *    `integer` в PostgreSQL — нет; `1250.355` уехало бы в `numeric(14,2)` и молча округлилось базой.
 *    Оба обязаны получить отказ ПОЛЕМ (ADR 0094), а не пятисоткой из глубины транзакции.
 * 4. **Где правило живёт схемой, а не обработчиком.** «Без файла чека не существует» (Р6) — в
 *    обеих схемах, и заведения, и правки: иначе первое держалось бы ровно до первой правки.
 *    Версия (Р12) — во всех местах, где её спрашивают, включая `?version=` у DELETE.
 *
 * Живая база тут не нужна и не используется: предмет — разбор тела, а не запись. Всё, что схема
 * проверить не может (своя ли машина, хватает ли прав, сходится ли версия), живёт в
 * `auto-part-receipts.db.test.ts`.
 */

const TODAY = moscowDateKeyOf(new Date());
const VEHICLE_ID = '11111111-1111-4111-8111-111111111111';
const FILE_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_FILE_ID = '33333333-3333-4333-8333-333333333333';

/** Минимальный законный чек: дата, номер, один скан и одна строка. Меньше — уже не чек. */
const minimal = {
  purchasedOn: TODAY,
  documentNumber: 'ЧЕК-1',
  fileIds: [FILE_ID],
  lines: [{ name: 'Фильтр масляный', quantity: 1, amount: 1250.35 }],
};

/** Строка чека с обязательным минимумом — остальное схема подставляет сама. */
function line(over: Record<string, unknown> = {}) {
  return { name: 'Фильтр масляный', quantity: 1, amount: 100, ...over };
}

function receipt(over: Record<string, unknown> = {}) {
  return { ...minimal, ...over };
}

/** Поля, названные в отказе: форма подсвечивает ячейку, а не показывает тост поверх таблицы. */
function paths(input: unknown, schema: { safeParse: (v: unknown) => { error?: unknown } }) {
  const result = schema.safeParse(input) as {
    success: boolean;
    error?: { issues: { path: (string | number)[]; message: string }[] };
  };
  expect(result.success).toBe(false);
  return (result.error?.issues ?? []).map((issue) => issue.path.join('.'));
}

function messages(input: unknown, schema: { safeParse: (v: unknown) => { error?: unknown } }) {
  const result = schema.safeParse(input) as {
    success: boolean;
    error?: { issues: { message: string }[] };
  };
  expect(result.success).toBe(false);
  return (result.error?.issues ?? []).map((issue) => issue.message);
}

describe('контракт заведения чека на автозапчасти', () => {
  it('минимум — дата, номер, скан и строка; остальное подставляется умолчанием', () => {
    const parsed = createReceiptSchema.parse(minimal);
    expect(parsed.purchasedOn).toBe(TODAY);
    // Продавец необязателен, а номер обязателен, и это не непоследовательность (Р1а): номер есть у
    // каждого чека, а название магазина на кассовой ленте бывает нечитаемо.
    expect(parsed.sellerName).toBe('');
    expect(parsed.note).toBe('');
    expect(parsed.lines[0]).toEqual({
      // «Не отнесено» — законное состояние (Р8), и требовать от формы явный `null` значило бы
      // описывать умолчание дважды.
      vehicleId: null,
      name: 'Фильтр масляный',
      quantity: 1,
      // Единица подписывает число, а не участвует в счёте: «5» без неё — не количество, а загадка.
      unit: 'шт',
      amount: 1250.35,
      note: '',
    });
  });

  it('поля итога нет вовсе — ни обязательного, ни необязательного (Р11)', () => {
    // Главное утверждение файла. Обещание «сумму чека считает сервер» держится не обработчиком, а
    // тем, что прислать свою сумму НЕЛЬЗЯ: без `.strict()` лишний `total` молча отбросился бы, и
    // портал ответил бы «сохранено» на тело, половину которого он не прочитал.
    expect(createReceiptSchema.safeParse({ ...minimal, total: 5000 }).success).toBe(false);
    expect(messages({ ...minimal, total: 5000 }, createReceiptSchema).join(' ')).toContain('total');
    expect('total' in createReceiptSchema.parse(minimal)).toBe(false);
    expect('unassignedTotal' in createReceiptSchema.parse(minimal)).toBe(false);
    // Та же дверь у правки: схема правки — это схема заведения плюс версия, и лишнее поле она
    // отбивает тем же `.strict()`.
    expect(updateReceiptSchema.safeParse({ ...minimal, version: 0, total: 5000 }).success).toBe(
      false,
    );
  });

  it('`seq` в строке не принимается: порядок задаёт массив (§6)', () => {
    // Присланный клиентом `seq` пришлось бы сверять с порядком массива и решать, кто прав при
    // расхождении, — а расходятся они на первой же строке, вставленной посередине.
    const body = { ...minimal, lines: [line({ seq: 1 })] };
    expect(createReceiptSchema.safeParse(body).success).toBe(false);
    // Отказ называет СТРОКУ, а не чек целиком: `lines.0` — путь, по которому форма подсветит
    // нужную ячейку (ADR 0094).
    expect(paths(body, createReceiptSchema)).toContain('lines.0');
    expect(messages(body, createReceiptSchema).join(' ')).toContain('seq');
  });

  it('номер чека обязателен и непуст: пробелы содержимым не считаются (Р1а)', () => {
    expect(createReceiptSchema.parse(receipt({ documentNumber: '  0001  ' })).documentNumber).toBe(
      '0001',
    );
    expect(createReceiptSchema.safeParse(receipt({ documentNumber: '' })).success).toBe(false);
    expect(createReceiptSchema.safeParse(receipt({ documentNumber: '   ' })).success).toBe(false);
    expect(paths(receipt({ documentNumber: '' }), createReceiptSchema)).toContain('documentNumber');
    expect(
      createReceiptSchema.parse(receipt({ documentNumber: 'Ч'.repeat(100) })).documentNumber,
    ).toHaveLength(100);
    expect(
      createReceiptSchema.safeParse(receipt({ documentNumber: 'Ч'.repeat(101) })).success,
    ).toBe(false);
  });

  it('без скана чека не существует — в обеих схемах, а не только при заведении (Р6)', () => {
    // Второе правило Р6 важнее первого: без него первое держалось бы ровно до первой правки, и чек
    // без бумаги появлялся бы вторым шагом вместо первого.
    expect(messages(receipt({ fileIds: [] }), createReceiptSchema)).toContain(
      RECEIPT_NO_FILES_MESSAGE,
    );
    expect(messages({ ...minimal, fileIds: [], version: 0 }, updateReceiptSchema)).toContain(
      RECEIPT_NO_FILES_MESSAGE,
    );
    // «Поля не прислали» у правки — тот же чек без бумаги, что и пустой список: правка отдаёт
    // документ целиком, и умолчания у сканов нет ни у одной из двух схем.
    const { fileIds: _fileIds, ...noFiles } = minimal;
    expect(createReceiptSchema.safeParse(noFiles).success).toBe(false);
    expect(updateReceiptSchema.safeParse({ ...noFiles, version: 0 }).success).toBe(false);

    const many = Array.from(
      { length: RECEIPT_MAX_FILES },
      (_, i) => `${i}`.padStart(8, '0') + '-1111-4111-8111-111111111111',
    );
    expect(createReceiptSchema.parse(receipt({ fileIds: many })).fileIds).toHaveLength(
      RECEIPT_MAX_FILES,
    );
    expect(
      createReceiptSchema.safeParse(receipt({ fileIds: [...many, OTHER_FILE_ID] })).success,
    ).toBe(false);
  });

  it('строк не меньше одной и не больше сотни', () => {
    // Чек без строк — бумага, о которой портал ничего не говорит: ни суммы, ни машин, ни ответа
    // «сколько вложено», ради которого раздел и заведён.
    expect(messages(receipt({ lines: [] }), createReceiptSchema)).toContain(
      RECEIPT_NO_LINES_MESSAGE,
    );
    const many = Array.from({ length: RECEIPT_MAX_LINES }, () => line());
    expect(createReceiptSchema.parse(receipt({ lines: many })).lines).toHaveLength(
      RECEIPT_MAX_LINES,
    );
    expect(createReceiptSchema.safeParse(receipt({ lines: [...many, line()] })).success).toBe(
      false,
    );
  });

  it('дата чека: задним числом законна без ограничений, завтрашняя — нет (Р13)', () => {
    expect(createReceiptSchema.parse(receipt({ purchasedOn: '2020-01-31' })).purchasedOn).toBe(
      '2020-01-31',
    );
    const tomorrow = shiftDateKey(TODAY, 1);
    // Отказ приходит ПОЛЕМ и словами (ADR 0094): «завтра» — ошибка ввода, о которой человеку надо
    // сказать, а не кодом нарушения из базы. `CHECK` тут и не поставить: `CURRENT_DATE` считает
    // день по зоне сессии, а сессии приложения живут в UTC.
    expect(messages(receipt({ purchasedOn: tomorrow }), createReceiptSchema)).toContain(
      RECEIPT_FUTURE_DATE_MESSAGE,
    );
    expect(paths(receipt({ purchasedOn: tomorrow }), createReceiptSchema)).toContain('purchasedOn');
    expect(createReceiptSchema.safeParse(receipt({ purchasedOn: '2026-02-31' })).success).toBe(
      false,
    );
    expect(createReceiptSchema.safeParse(receipt({ purchasedOn: '01.09.2026' })).success).toBe(
      false,
    );
  });

  it('количество — целое, положительное и с потолком предмета (Р10)', () => {
    expect(
      createReceiptSchema.parse(receipt({ lines: [line({ quantity: 1 })] })).lines[0]!.quantity,
    ).toBe(1);
    expect(
      createReceiptSchema.parse(receipt({ lines: [line({ quantity: RECEIPT_MAX_QUANTITY })] }))
        .lines[0]!.quantity,
    ).toBe(RECEIPT_MAX_QUANTITY);
    // Ноль — это не строка чека, а её отсутствие: снимают её удалением из набора.
    expect(createReceiptSchema.safeParse(receipt({ lines: [line({ quantity: 0 })] })).success).toBe(
      false,
    );
    expect(
      createReceiptSchema.safeParse(receipt({ lines: [line({ quantity: -1 })] })).success,
    ).toBe(false);
    // Дробное отвергнуто вместе с решением заказчика (Р10): при целом количестве копейки живут
    // ровно в одном месте — в сумме строки.
    expect(
      createReceiptSchema.safeParse(receipt({ lines: [line({ quantity: 4.75 })] })).success,
    ).toBe(false);
    // Тот самый случай, ради которого потолок и заведён: `3_000_000_000` — безопасное целое, его
    // `z.int()` пропускает, а `integer` в PostgreSQL нет. Отказ обязан прийти отсюда, полем, а не
    // пятисоткой из глубины транзакции.
    const huge = receipt({ lines: [line({ quantity: 3_000_000_000 })] });
    expect(createReceiptSchema.safeParse(huge).success).toBe(false);
    expect(paths(huge, createReceiptSchema)).toContain('lines.0.quantity');
    expect(
      createReceiptSchema.safeParse(
        receipt({ lines: [line({ quantity: RECEIPT_MAX_QUANTITY + 1 })] }),
      ).success,
    ).toBe(false);
  });

  it('деньги — числом, неотрицательные, с копейкой шагом (Р9)', () => {
    expect(
      createReceiptSchema.parse(receipt({ lines: [line({ amount: 0 })] })).lines[0]!.amount,
    ).toBe(0);
    expect(
      createReceiptSchema.parse(receipt({ lines: [line({ amount: RECEIPT_MAX_AMOUNT })] }))
        .lines[0]!.amount,
    ).toBe(RECEIPT_MAX_AMOUNT);
    expect(
      createReceiptSchema.safeParse(receipt({ lines: [line({ amount: -0.01 })] })).success,
    ).toBe(false);
    expect(
      createReceiptSchema.safeParse(receipt({ lines: [line({ amount: RECEIPT_MAX_AMOUNT + 1 })] }))
        .success,
    ).toBe(false);
    // Третий знак после запятой: без `multipleOf` число уехало бы в `numeric(14,2)` и молча
    // округлилось базой — портал показал бы не то, что набрали, и итог разошёлся бы с суммой строк.
    const fraction = receipt({ lines: [line({ amount: 1250.355 })] });
    expect(createReceiptSchema.safeParse(fraction).success).toBe(false);
    expect(paths(fraction, createReceiptSchema)).toContain('lines.0.amount');
    // Строкой деньги не принимаются вовсе: `coerce` превратил бы `null` в ноль, и «сумма не
    // указана» стало бы законной строкой «за ноль рублей».
    expect(
      createReceiptSchema.safeParse(receipt({ lines: [line({ amount: '100' })] })).success,
    ).toBe(false);
    expect(
      createReceiptSchema.safeParse(receipt({ lines: [line({ amount: null })] })).success,
    ).toBe(false);
  });

  it('наименование и единица непусты, машина в строке — необязательна (Р7, Р8)', () => {
    expect(createReceiptSchema.safeParse(receipt({ lines: [line({ name: '' })] })).success).toBe(
      false,
    );
    expect(createReceiptSchema.safeParse(receipt({ lines: [line({ name: '   ' })] })).success).toBe(
      false,
    );
    expect(
      createReceiptSchema.safeParse(receipt({ lines: [line({ name: 'Ф'.repeat(301) })] })).success,
    ).toBe(false);
    expect(createReceiptSchema.safeParse(receipt({ lines: [line({ unit: '' })] })).success).toBe(
      false,
    );
    expect(
      createReceiptSchema.safeParse(receipt({ lines: [line({ unit: 'е'.repeat(21) })] })).success,
    ).toBe(false);
    expect(
      createReceiptSchema.parse(receipt({ lines: [line({ vehicleId: VEHICLE_ID })] })).lines[0]!
        .vehicleId,
    ).toBe(VEHICLE_ID);
    expect(
      createReceiptSchema.parse(receipt({ lines: [line({ vehicleId: null })] })).lines[0]!
        .vehicleId,
    ).toBeNull();
    // Что машина СВОЯ, схема не проверяет и проверить не может: справочник ей недоступен, и правило
    // живёт сервером (Р21) — см. db-набор.
    expect(
      createReceiptSchema.safeParse(receipt({ lines: [line({ vehicleId: 'КамАЗ' })] })).success,
    ).toBe(false);
    // Две строки «фильтр масляный» на одну машину — обычное дело (разные цены, разные позиции у
    // продавца), и схема их не отбивает намеренно: складывать их за механика значило бы
    // переписывать бумагу.
    expect(
      createReceiptSchema.parse(
        receipt({ lines: [line({ vehicleId: VEHICLE_ID }), line({ vehicleId: VEHICLE_ID })] }),
      ).lines,
    ).toHaveLength(2);
  });
});

describe('контракт версии: её спрашивают все четыре мутации (Р12)', () => {
  it('правка требует версию, и она же — единственное отличие от заведения', () => {
    expect(updateReceiptSchema.parse({ ...minimal, version: 3 }).version).toBe(3);
    expect(updateReceiptSchema.safeParse(minimal).success).toBe(false);
    expect(paths(minimal, updateReceiptSchema)).toContain('version');
    expect(updateReceiptSchema.safeParse({ ...minimal, version: -1 }).success).toBe(false);
    expect(updateReceiptSchema.safeParse({ ...minimal, version: 1.5 }).success).toBe(false);
    // Пометки в теле правки нет вовсе (§2.3): очередь администратора не должна опустошаться заодно
    // с исправлением опечатки, и `.strict()` — это и есть механизм обещания.
    expect(
      updateReceiptSchema.safeParse({ ...minimal, version: 0, deletionReason: 'ошибка' }).success,
    ).toBe(false);
  });

  it('пометка на удаление: непустая причина и версия (Р12)', () => {
    expect(receiptDeletionMarkSchema.parse({ reason: '  дубль чека  ', version: 2 })).toEqual({
      reason: 'дубль чека',
      version: 2,
    });
    // «Предлагаю удалить, а зачем не скажу» — это не просьба, а загадка; того же требует пара
    // `CHECK` в базе: причина есть ровно у помеченного.
    expect(receiptDeletionMarkSchema.safeParse({ reason: '', version: 0 }).success).toBe(false);
    expect(receiptDeletionMarkSchema.safeParse({ reason: '   ', version: 0 }).success).toBe(false);
    expect(
      receiptDeletionMarkSchema.safeParse({ reason: 'п'.repeat(1001), version: 0 }).success,
    ).toBe(false);
    expect(receiptDeletionMarkSchema.safeParse({ reason: 'дубль' }).success).toBe(false);
    expect(
      receiptDeletionMarkSchema.safeParse({ reason: 'дубль', version: 0, force: true }).success,
    ).toBe(false);
  });

  it('`?version=` у снятия пометки и удаления: строка из адреса приводится к числу', () => {
    // Тела у DELETE нет, поэтому версия приезжает строкой — тем же приёмом, что у удаления акта ТО.
    expect(receiptVersionQuerySchema.parse({ version: '3' }).version).toBe(3);
    expect(receiptVersionQuerySchema.parse({ version: '0' }).version).toBe(0);
    // Снятие вслепую сняло бы пометку, поставленную уже ПОСЛЕ того, как экран был открыт, — то есть
    // ответило бы не на ту просьбу. Поэтому параметр обязателен, а не «по умолчанию последняя».
    expect(receiptVersionQuerySchema.safeParse({}).success).toBe(false);
    expect(receiptVersionQuerySchema.safeParse({ version: '-1' }).success).toBe(false);
    expect(receiptVersionQuerySchema.safeParse({ version: 'последняя' }).success).toBe(false);
    expect(receiptVersionQuerySchema.safeParse({ version: '1', force: 'true' }).success).toBe(
      false,
    );
  });
});

describe('контракт отбора: лента, сводка и окно машины', () => {
  it('период по дате чека, обе границы необязательны, порядок границ проверяется', () => {
    const parsed = autoPartReceiptListQuerySchema.parse({ from: '2026-08-01', to: '2026-08-31' });
    expect(parsed.from).toBe('2026-08-01');
    expect(parsed.sortOrder).toBe('desc');
    // «За всё время» — законный вопрос к разделу, который только что завели.
    expect(autoPartReceiptListQuerySchema.parse({}).from).toBeUndefined();
    expect(
      paths({ from: '2026-08-31', to: '2026-08-01' }, autoPartReceiptListQuerySchema),
    ).toContain('to');
    expect(
      paths({ from: '2026-08-31', to: '2026-08-01' }, autoPartReceiptSummaryQuerySchema),
    ).toContain('to');
    expect(paths({ from: '2026-08-31', to: '2026-08-01' }, vehiclePartsSpendQuerySchema)).toContain(
      'to',
    );
  });

  it('«помеченные к удалению» — три состояния, а не флаг', () => {
    // Снятый переключатель («не фильтровать») и выбранное «нет» отвечают на разные вопросы.
    expect(autoPartReceiptListQuerySchema.parse({}).deletionMarked).toBeUndefined();
    expect(autoPartReceiptListQuerySchema.parse({ deletionMarked: 'true' }).deletionMarked).toBe(
      true,
    );
    expect(autoPartReceiptListQuerySchema.parse({ deletionMarked: 'false' }).deletionMarked).toBe(
      false,
    );
    expect(autoPartReceiptListQuerySchema.safeParse({ deletionMarked: '1' }).success).toBe(false);
  });

  it('сортировка — только по реквизитам шапки; итога среди них нет', () => {
    expect(autoPartReceiptListQuerySchema.parse({ sortBy: 'purchasedOn' }).sortBy).toBe(
      'purchasedOn',
    );
    expect(autoPartReceiptListQuerySchema.parse({ sortBy: 'documentNumber' }).sortBy).toBe(
      'documentNumber',
    );
    // Итог складывается из строк, и «самые дорогие чеки» — вопрос не к ленте документов, а к
    // отчёту, которого этот выпуск не заводит (§12).
    expect(autoPartReceiptListQuerySchema.safeParse({ sortBy: 'total' }).success).toBe(false);
    // У сводки страниц и сортировки нет вовсе: она отвечает про то, что видно целиком.
    expect(autoPartReceiptSummaryQuerySchema.safeParse({ sortBy: 'purchasedOn' }).success).toBe(
      false,
    );
    expect(autoPartReceiptSummaryQuerySchema.safeParse({ page: '1' }).success).toBe(false);
  });

  it('снапшот сумм: машины строкой через запятую, пустое значение законно', () => {
    // Повтор `ids=a&ids=b` Fastify разбирает в массив, только пока значений больше одного, и на
    // единственной машине схема получила бы строку, — поэтому разбор свой.
    expect(
      vehiclePartsSpendSnapshotQuerySchema.parse({ ids: `${VEHICLE_ID}, ${FILE_ID}` }).ids,
    ).toEqual([VEHICLE_ID, FILE_ID]);
    expect(vehiclePartsSpendSnapshotQuerySchema.parse({ ids: VEHICLE_ID }).ids).toEqual([
      VEHICLE_ID,
    ]);
    // «На странице нет ни одной машины» — законный вопрос, а не отказ: колонка пустой страницы
    // гаража не должна ронять запрос.
    expect(vehiclePartsSpendSnapshotQuerySchema.parse({ ids: '' }).ids).toEqual([]);
    expect(vehiclePartsSpendSnapshotQuerySchema.safeParse({ ids: 'не-uuid' }).success).toBe(false);
    expect(vehiclePartsSpendSnapshotQuerySchema.safeParse({}).success).toBe(false);
    // День среза необязателен — его считает сервер московским «сегодня» (Р14).
    expect(
      vehiclePartsSpendSnapshotQuerySchema.parse({ ids: VEHICLE_ID, to: '2026-08-31' }).to,
    ).toBe('2026-08-31');
    expect(vehiclePartsSpendSnapshotQuerySchema.parse({ ids: VEHICLE_ID }).to).toBeUndefined();
  });
});

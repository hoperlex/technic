import { describe, expect, it } from 'vitest';
import {
  acceptServiceRequestSchema,
  approveServiceEstimateSchema,
  assignServiceSchema,
  attachServiceFilesSchema,
  completeServiceRequestSchema,
  createServiceRequestSchema,
  declineServiceRequestSchema,
  formatServiceRequestNumber,
  isServiceClosingDocument,
  isServiceRequestClosed,
  isServiceRequestEditable,
  parseServiceRequestNumberSearch,
  putServiceEstimateSchema,
  reopenServiceEstimateSchema,
  reworkServiceRequestSchema,
  SERVICE_FILE_KINDS,
  SERVICE_REQUEST_STATUSES,
  serviceCommentSchema,
  serviceEstimateItemSchema,
  type ServiceFileKind,
  serviceRequestListQuerySchema,
  serviceStatusChangeSchema,
  setServiceUrgencySchema,
  startServiceRequestSchema,
  submitServiceEstimateSchema,
  updateServiceRequestSchema,
  warrantyClaimSchema,
} from '@technic/contracts';

/**
 * Схемы модуля заявок на обслуживание оргтехники (ADR 0085).
 *
 * Схема живёт в общем пакете, потому что каждое её правило спрашивают двое — форма портала и
 * сервер, — и разъехавшись, они дают либо кнопку, ведущую в 422, либо принятое сервером тело,
 * которого форма собрать не умеет. Поэтому проверяется не «zod работает», а решения модуля: чего
 * сервер из тела не принимает вовсе, что без объяснения не проходит и что подставляется само.
 */

const UUID = '11111111-1111-4111-8111-111111111111';
const OTHER_UUID = '22222222-2222-4222-8222-222222222222';

/**
 * Изменяющие ручки модуля и минимальное тело каждой — без `version` (Р30). Перечень один на все
 * проверки версии: ручка, заведённая без версии, обязана попасть сюда строкой и уронить тест,
 * потому что «сохранил поверх чужой правки» иначе останется незамеченным до продакшена.
 */
const MUTATIONS: [
  name: string,
  schema: { safeParse: (v: unknown) => { success: boolean } },
  body: object,
][] = [
  ['PATCH /:id — правка заявки', updateServiceRequestSchema, {}],
  ['PATCH /:id/service — назначение', assignServiceSchema, { serviceCounterpartyId: UUID }],
  ['PATCH /:id/decline — отказ', declineServiceRequestSchema, { reason: 'занят до конца месяца' }],
  ['PATCH /:id/start — в диагностику', startServiceRequestSchema, {}],
  ['PUT /:id/estimate — состав сметы', putServiceEstimateSchema, { items: [] }],
  ['PATCH /:id/estimate/submit — предъявление', submitServiceEstimateSchema, {}],
  ['PATCH /:id/estimate/approval — согласование', approveServiceEstimateSchema, { approved: true }],
  [
    'PATCH /:id/estimate/reopen — переоткрытие',
    reopenServiceEstimateSchema,
    { reason: 'нужен термоузел' },
  ],
  [
    'PATCH /:id/complete — закрытие',
    completeServiceRequestSchema,
    { completedOn: '2026-08-12', items: [] },
  ],
  ['PATCH /:id/accept — приёмка', acceptServiceRequestSchema, {}],
  ['PATCH /:id/rework — возврат', reworkServiceRequestSchema, { reason: 'подача не работает' }],
  ['PATCH /:id/status — отмена и откаты', serviceStatusChangeSchema, { status: 'cancelled' }],
  [
    'PATCH /:id/service-comment — примечание',
    serviceCommentSchema,
    { serviceComment: 'во вторник' },
  ],
];

describe('версия обязательна во всех изменяющих ручках (Р30)', () => {
  it('без версии тело не принимается ни одной ручкой', () => {
    for (const [name, schema, body] of MUTATIONS) {
      expect(schema.safeParse(body).success, `${name}: без версии`).toBe(false);
      expect(schema.safeParse({ ...body, version: 0 }).success, `${name}: с версией`).toBe(true);
    }
  });

  it('версия — целое неотрицательное число, а не строка из формы', () => {
    for (const [name, schema, body] of MUTATIONS) {
      expect(schema.safeParse({ ...body, version: -1 }).success, `${name}: -1`).toBe(false);
      expect(schema.safeParse({ ...body, version: 1.5 }).success, `${name}: дробная`).toBe(false);
      expect(schema.safeParse({ ...body, version: '3' }).success, `${name}: строка`).toBe(false);
    }
  });

  /**
   * Заведение и подшивка файла версии не спрашивают, и это не пропуск: заводимой заявки ещё нет, а
   * подшивка документа заявку не меняет — она добавляет строку в её список файлов (§8.3), и
   * конкурировать здесь не с чем.
   */
  it('заведение заявки и подшивка документа версии не требуют', () => {
    expect(
      createServiceRequestSchema.safeParse({
        officeEquipmentId: UUID,
        description: 'не печатает',
        responsibleName: 'Иванов И. И.',
        responsiblePhone: '9000000000',
      }).success,
    ).toBe(true);
    expect(attachServiceFilesSchema.safeParse({ fileIds: [UUID] }).success).toBe(true);
  });
});

describe('заведение и правка заявки', () => {
  /** Минимально полная заявка: техника, неисправность и заявитель с телефоном (Р49). */
  const NEW_REQUEST = {
    officeEquipmentId: UUID,
    description: 'не захватывает бумагу',
    responsibleName: 'Иванов И. И.',
    responsiblePhone: '+7 (900) 000 00 00',
  };

  it('требует единицу, описание неисправности и заявителя; отдел подставляется пустым', () => {
    const parsed = createServiceRequestSchema.parse({
      ...NEW_REQUEST,
      description: '  не захватывает бумагу  ',
    });
    expect(parsed.description).toBe('не захватывает бумагу');
    expect(parsed.responsibleName).toBe('Иванов И. И.');
    // Номер приводится к виду хранения схемой, а не обработчиком: мимо неё не пройдёт ни форма,
    // ни импорт, ни прямой запрос (ADR 0066).
    expect(parsed.responsiblePhone).toBe('9000000000');
    expect(parsed.comment).toBe('');
    expect(parsed.fileIds).toEqual([]);
    expect(parsed.isUrgent).toBe(false);
    // «Заявка объектная, от площадки» — это `null`, а не пропущенное поле, и подставлять сюда
    // отдел автора схема не берётся: сотрудник соседнего отдела чинит «чужой» принтер чаще, чем
    // кажется (§8).
    expect(parsed.customerDepartmentId).toBeUndefined();
  });

  /**
   * Контакт заявителя обязателен на сервере, а не только в форме (Р49). До этой проверки портал
   * помечал оба поля `required`, а схема принимала пустые строки — заявка без контакта заводилась
   * любым клиентом мимо формы, и именно её сервис получал первой.
   */
  it('заявка без заявителя и телефона не заводится', () => {
    expect(
      createServiceRequestSchema.safeParse({ ...NEW_REQUEST, responsibleName: '' }).success,
    ).toBe(false);
    expect(
      createServiceRequestSchema.safeParse({ ...NEW_REQUEST, responsiblePhone: '' }).success,
    ).toBe(false);
    expect(
      createServiceRequestSchema.safeParse({ ...NEW_REQUEST, responsiblePhone: '123' }).success,
    ).toBe(false);
  });

  it('«не печатает» описанием не считается: неисправность нужна словами', () => {
    expect(
      createServiceRequestSchema.safeParse({ ...NEW_REQUEST, description: 'ааа' }).success,
    ).toBe(false);
    expect(
      createServiceRequestSchema.safeParse({ description: 'не захватывает бумагу' }).success,
    ).toBe(false);
    expect(
      createServiceRequestSchema.safeParse({ ...NEW_REQUEST, officeEquipmentId: 'нет' }).success,
    ).toBe(false);
  });

  /**
   * Срочность — пара «флаг + причина» (Р56), и обе половины проверяются в обе стороны: флаг без
   * объяснения превращает признак в общий фон, а причина без флага ничего не объявляет.
   */
  it('срочность без причины и причина без срочности не проходят', () => {
    expect(createServiceRequestSchema.safeParse({ ...NEW_REQUEST, isUrgent: true }).success).toBe(
      false,
    );
    expect(
      createServiceRequestSchema.safeParse({
        ...NEW_REQUEST,
        isUrgent: false,
        urgencyReason: 'очень надо',
      }).success,
    ).toBe(false);
    const parsed = createServiceRequestSchema.parse({
      ...NEW_REQUEST,
      isUrgent: true,
      urgencyReason: '  единственный принтер на площадке  ',
    });
    expect(parsed.isUrgent).toBe(true);
    expect(parsed.urgencyReason).toBe('единственный принтер на площадке');
  });

  /**
   * У правки значения по умолчанию нет намеренно: `PATCH` присылает только изменившееся, и
   * `default(false)` означал бы, что правка телефона молча снимает срочность. Пару в этом случае
   * сверяет сервер по склеенному состоянию — схема видит половину.
   */
  it('правка без полей срочности их не трогает', () => {
    const parsed = updateServiceRequestSchema.parse({
      version: 3,
      comment: 'перезвонить после 15',
    });
    expect(parsed.isUrgent).toBeUndefined();
    expect(parsed.urgencyReason).toBeUndefined();
  });

  it('своя ручка срочности требует пару целиком', () => {
    expect(setServiceUrgencySchema.safeParse({ isUrgent: true, version: 1 }).success).toBe(false);
    expect(
      setServiceUrgencySchema.safeParse({
        isUrgent: true,
        urgencyReason: 'встал приём заявок',
        version: 1,
      }).success,
    ).toBe(true);
    // Снятие причины не требует: она снимается вместе с флагом.
    expect(setServiceUrgencySchema.safeParse({ isUrgent: false, version: 1 }).success).toBe(true);
  });

  /** Правка заявки — только «Новой» (§5.3): дальше за заявкой стоят договорённости с исполнителем. */
  it('правится заявка, которую ещё не начали вести', () => {
    // Статуса два: «Новая» и «Согласована ИТ» (Р51). Виза отвечает на «нужен ли внешний ремонт», а
    // не на «как он описан», и запирать ею правку значило бы заводить новую заявку из-за опечатки.
    expect(isServiceRequestEditable('new')).toBe(true);
    expect(isServiceRequestEditable('it_approved')).toBe(true);
    for (const status of SERVICE_REQUEST_STATUSES.filter(
      (s) => s !== 'new' && s !== 'it_approved',
    )) {
      expect(isServiceRequestEditable(status), status).toBe(false);
    }
    // Закрытая заявка — «Принята» и «Отменена»: ни хода, ни правки ей больше не положено.
    expect(isServiceRequestClosed('accepted')).toBe(true);
    expect(isServiceRequestClosed('cancelled')).toBe(true);
    for (const status of SERVICE_REQUEST_STATUSES.filter(
      (s) => s !== 'accepted' && s !== 'cancelled',
    )) {
      expect(isServiceRequestClosed(status), status).toBe(false);
    }
  });

  it('правка приходит частями: менять одно поле, не пересылая остальные', () => {
    const parsed = updateServiceRequestSchema.parse({ dueDate: null, version: 3 });
    expect(parsed.dueDate).toBe(null);
    expect(parsed.description).toBeUndefined();
    expect(
      updateServiceRequestSchema.safeParse({ dueDate: '2026-02-31', version: 1 }).success,
    ).toBe(false);
  });
});

describe('смета', () => {
  const item = { kind: 'part', name: 'Ролик подачи', unitPrice: 1800 };

  it('количество по умолчанию одно, цена ноль допустима, гарантия — необязательное обещание', () => {
    const parsed = serviceEstimateItemSchema.parse(item);
    expect(parsed.quantity).toBe(1);
    expect(parsed.warrantyMonths).toBeUndefined();
    expect(serviceEstimateItemSchema.parse({ ...item, unitPrice: 0 }).unitPrice).toBe(0);
    expect(serviceEstimateItemSchema.safeParse({ ...item, unitPrice: -1 }).success).toBe(false);
    expect(serviceEstimateItemSchema.safeParse({ ...item, quantity: 0 }).success).toBe(false);
    expect(serviceEstimateItemSchema.safeParse({ ...item, warrantyMonths: 0 }).success).toBe(false);
    expect(serviceEstimateItemSchema.safeParse({ ...item, warrantyMonths: 121 }).success).toBe(
      false,
    );
    expect(serviceEstimateItemSchema.safeParse({ ...item, kind: 'work' }).success).toBe(false);
  });

  /**
   * Состав передаётся целиком: смета — документ, и «добавить строку» без остальных строк не имеет
   * смысла. Пустой список разрешён — это черновик; предъявить пустую смету не даёт сервер, а не
   * схема (§8.1).
   */
  it('состав приходит целиком, пустой список — черновик', () => {
    expect(putServiceEstimateSchema.parse({ items: [], version: 0 }).items).toEqual([]);
    expect(putServiceEstimateSchema.safeParse({ items: [item], version: 0 }).success).toBe(true);
    expect(
      putServiceEstimateSchema.safeParse({
        items: Array.from({ length: 201 }, () => item),
        version: 0,
      }).success,
    ).toBe(false);
  });
});

/**
 * Закрытие работ (§8.1). Итог сервер **не принимает**: он считает его из строк в пяти шагах
 * транзакции. Пришли итог телом — сумма строк и итог разошлись бы молча, и спор с сервисом решался
 * бы числом, которое прислал сам сервис.
 */
describe('закрытие работ', () => {
  const base = { completedOn: '2026-08-12', items: [{ id: UUID, performed: true }], version: 4 };

  it('итог не принимается телом ни под одним именем', () => {
    const parsed = completeServiceRequestSchema.parse({
      ...base,
      totalAmount: 6200,
      finalTotalAmount: 6200,
      estimatedTotalAmount: 7100,
    });
    expect(parsed).not.toHaveProperty('totalAmount');
    expect(parsed).not.toHaveProperty('finalTotalAmount');
    expect(parsed).not.toHaveProperty('estimatedTotalAmount');
  });

  it('дата выполнения обязательна, отметка факта — у каждой строки', () => {
    const { completedOn: _drop, ...noDate } = base;
    expect(completeServiceRequestSchema.safeParse(noDate).success).toBe(false);
    expect(completeServiceRequestSchema.safeParse({ ...base, items: [{ id: UUID }] }).success).toBe(
      false,
    );
    expect(
      completeServiceRequestSchema.safeParse({ ...base, items: [{ performed: false }] }).success,
    ).toBe(false);
    // Фактическое количество и дата гарантии — уточнения: пусто означает «как в смете» и «посчитай
    // сам от даты выполнения».
    const parsed = completeServiceRequestSchema.parse({
      ...base,
      items: [{ id: UUID, performed: true, actualQuantity: 1, warrantyUntil: '2027-02-12' }],
    });
    expect(parsed.items[0]?.warrantyUntil).toBe('2027-02-12');
  });

  /**
   * Скидка по акту — строго отрицательная сумма: «корректировка» с плюсом означала бы удорожание
   * при закрытии, а поднять цену или объём после согласования сметы нечем (Р12). Причина скидки
   * хранится своим полем, и связывает их с суммой ручка закрытия, а не схема.
   */
  it('скидка бывает только со знаком минус', () => {
    expect(
      completeServiceRequestSchema.parse({ ...base, adjustmentAmount: -900 }).adjustmentAmount,
    ).toBe(-900);
    expect(completeServiceRequestSchema.safeParse({ ...base, adjustmentAmount: 0 }).success).toBe(
      false,
    );
    expect(completeServiceRequestSchema.safeParse({ ...base, adjustmentAmount: 900 }).success).toBe(
      false,
    );
    // Без скидки поля нет вовсе, а причина приходит пустой строкой — «скидки не было».
    expect(completeServiceRequestSchema.parse(base).adjustmentReason).toBe('');
  });
});

/**
 * Согласование сметы — одна ручка на «да» и «нет»: у них одно право, одна область и один момент.
 * Причина обязательна только у отказа: «согласовано» объяснений не требует, а «отклонено» без них
 * оставляет сервис гадать, что переделывать.
 */
describe('согласование сметы', () => {
  it('отказ без причины не проходит, согласие без причины — проходит', () => {
    expect(approveServiceEstimateSchema.safeParse({ approved: false, version: 2 }).success).toBe(
      false,
    );
    expect(
      approveServiceEstimateSchema.safeParse({
        approved: false,
        reason: 'ищем дешевле',
        version: 2,
      }).success,
    ).toBe(true);
    expect(approveServiceEstimateSchema.safeParse({ approved: true, version: 2 }).success).toBe(
      true,
    );
    // Ошибка адресована полю причины: форме нужно подсветить именно его.
    const failed = approveServiceEstimateSchema.safeParse({ approved: false, version: 2 });
    expect(failed.success).toBe(false);
    if (!failed.success) expect(failed.error.issues[0]?.path).toEqual(['reason']);
  });

  it('причина — объяснение, а не отписка из двух букв', () => {
    expect(
      approveServiceEstimateSchema.safeParse({ approved: false, reason: 'не', version: 2 }).success,
    ).toBe(false);
    // То же правило у остальных ручек с причиной: отказ, переоткрытие и возврат на доработку.
    expect(declineServiceRequestSchema.safeParse({ reason: '  ', version: 1 }).success).toBe(false);
    expect(reopenServiceEstimateSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(reworkServiceRequestSchema.safeParse({ version: 1 }).success).toBe(false);
    // У отмены причина в теле необязательна: обязательность задаёт дуга перехода
    // (`serviceStatusChangeRequiresReason`), и проверяет её ручка — та же схема обслуживает откаты.
    expect(serviceStatusChangeSchema.parse({ status: 'cancelled', version: 1 }).reason).toBe('');
    expect(serviceStatusChangeSchema.safeParse({ status: 'закрыта', version: 1 }).success).toBe(
      false,
    );
  });

  it('переназначение объясняют, первое назначение — нет', () => {
    // Причина у назначения необязательна схемой: у первого назначения объяснять нечего, а при
    // переназначении её требует ручка — там у прежнего сервиса отбирают работу.
    expect(assignServiceSchema.parse({ serviceCounterpartyId: UUID, version: 1 }).comment).toBe('');
    expect(
      assignServiceSchema.safeParse({ serviceCounterpartyId: UUID, reason: 'не', version: 1 })
        .success,
    ).toBe(false);
  });
});

/**
 * Гарантийное обращение (Р26): не флаг «гарантийная», а ответ на вопрос, по чьей гарантии
 * обращаются. У источника `item` обязательна ссылка на строку прошлого ремонта, у `equipment` её
 * быть не должно — гарантия поставщика висит на самой единице, и «позиция ремонта» у неё
 * означала бы спор, которого не с кем вести.
 */
describe('источник гарантийного обращения', () => {
  it('ремонт — со ссылкой на позицию, техника — без неё', () => {
    expect(warrantyClaimSchema.safeParse({ source: 'item' }).success).toBe(false);
    expect(warrantyClaimSchema.safeParse({ source: 'item', itemId: UUID }).success).toBe(true);
    expect(warrantyClaimSchema.safeParse({ source: 'equipment', itemId: UUID }).success).toBe(
      false,
    );
    expect(warrantyClaimSchema.safeParse({ source: 'equipment' }).success).toBe(true);
    // Ошибка обеих веток адресована ссылке: подсвечивать нужно выбор позиции.
    const failed = warrantyClaimSchema.safeParse({ source: 'item' });
    if (!failed.success) expect(failed.error.issues[0]?.path).toEqual(['itemId']);
  });

  it('обычная заявка источника не называет вовсе', () => {
    expect(warrantyClaimSchema.safeParse({}).success).toBe(true);
    expect(warrantyClaimSchema.safeParse({ source: null, itemId: null }).success).toBe(true);
    expect(warrantyClaimSchema.safeParse({ source: 'warranty' }).success).toBe(false);
    // В заявку она вкладывается целиком — и заведением, и правкой.
    expect(
      createServiceRequestSchema.safeParse({
        officeEquipmentId: UUID,
        description: 'опять не печатает',
        responsibleName: 'Иванов И. И.',
        responsiblePhone: '9000000000',
        warrantyClaim: { source: 'item', itemId: OTHER_UUID },
      }).success,
    ).toBe(true);
    expect(
      updateServiceRequestSchema.safeParse({ warrantyClaim: { source: 'item' }, version: 1 })
        .success,
    ).toBe(false);
  });
});

describe('номер заявки', () => {
  it('показывается с префиксом «СО»', () => {
    expect(formatServiceRequestNumber(14)).toBe('СО-14');
    expect(formatServiceRequestNumber(1)).toBe('СО-1');
  });

  it('ищется в любом написании: с префиксом, без него и в нижнем регистре', () => {
    expect(parseServiceRequestNumberSearch('СО-14')).toBe(14);
    expect(parseServiceRequestNumberSearch('со-14')).toBe(14);
    expect(parseServiceRequestNumberSearch('со14')).toBe(14);
    expect(parseServiceRequestNumberSearch('14')).toBe(14);
    expect(parseServiceRequestNumberSearch('  СО-014  ')).toBe(14);
    // Свой номер портал показывает и находит: круг замыкается.
    expect(parseServiceRequestNumberSearch(formatServiceRequestNumber(207))).toBe(207);
  });

  /**
   * `null` — не «номер не найден», а «это не номер»: тогда строка идёт обычным поиском по модели и
   * номерам техники, и «Kyocera» не превращается в поиск заявки № 0.
   */
  it('мусор номером не считается — строка уходит в обычный поиск', () => {
    for (const junk of ['', '   ', 'СО-', 'со', 'Kyocera', '14a', 'СО-14-2', '-5', '0', '00']) {
      expect(parseServiceRequestNumberSearch(junk), junk).toBe(null);
    }
    // Номер длиннее девяти цифр — не номер: `identity` таких не выдаёт, а regex без предела
    // пропускал бы в запрос строку любой длины.
    expect(parseServiceRequestNumberSearch('1234567890')).toBe(null);
    expect(parseServiceRequestNumberSearch('999999999')).toBe(999_999_999);
  });
});

describe('список заявок', () => {
  it('по умолчанию — живые заявки без единого фильтра', () => {
    const parsed = serviceRequestListQuerySchema.parse({});
    // Архив (ADR 0070) не показывается, пока его не попросили: так список видит и тот, у кого
    // права на архив нет вовсе.
    expect(parsed.archive).toBe('exclude');
    expect(parsed.page).toBe(1);
    expect(parsed.pageSize).toBe(100);
    expect(parsed.sortOrder).toBe('desc');
    // Флаговые фильтры приходят строками из query и превращаются в «нет», пока их не включили:
    // `undefined` в предикате области означал бы фильтр, применённый наполовину.
    expect(parsed.waitingOnMe).toBe(false);
    expect(parsed.mine).toBe(false);
    expect(parsed.overdue).toBe(false);
    expect(parsed.awaitingDocuments).toBe(false);
    expect(parsed.warrantyClaim).toBe(false);
    expect(parsed.status).toBeUndefined();
  });

  it('флаги включаются строкой «true», всё остальное значит «нет»', () => {
    const on = serviceRequestListQuerySchema.parse({
      waitingOnMe: 'true',
      mine: 'true',
      overdue: 'true',
      awaitingDocuments: 'true',
      warrantyClaim: 'true',
    });
    expect([on.waitingOnMe, on.mine, on.overdue, on.awaitingDocuments, on.warrantyClaim]).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(serviceRequestListQuerySchema.parse({ mine: 'false' }).mine).toBe(false);
    // Значение не из перечня — отказ, а не молчаливое «нет»: опечатка в клиенте иначе показала бы
    // человеку не тот список.
    expect(serviceRequestListQuerySchema.safeParse({ mine: 'yes' }).success).toBe(false);
  });

  it('архив принимает три состояния, сортировка — только свои поля', () => {
    expect(serviceRequestListQuerySchema.parse({ archive: 'only' }).archive).toBe('only');
    expect(serviceRequestListQuerySchema.parse({ archive: 'include' }).archive).toBe('include');
    expect(serviceRequestListQuerySchema.safeParse({ archive: 'deleted' }).success).toBe(false);
    expect(serviceRequestListQuerySchema.parse({ sortBy: 'statusChangedAt' }).sortBy).toBe(
      'statusChangedAt',
    );
    expect(serviceRequestListQuerySchema.safeParse({ sortBy: 'final_total_amount' }).success).toBe(
      false,
    );
    expect(serviceRequestListQuerySchema.safeParse({ status: 'закрыта' }).success).toBe(false);
    expect(serviceRequestListQuerySchema.safeParse({ objectId: '12' }).success).toBe(false);
  });
});

/**
 * Виды документов (Р29). Закрывающие бумаги подшивают и после приёмки — «акт пришлю завтра» иначе
 * означало бы потерянную бумагу; вложение после терминального статуса не принимается.
 */
describe('документы заявки', () => {
  it('закрывающими считаются акт, счёт и гарантийный талон', () => {
    const closing = SERVICE_FILE_KINDS.filter((kind: ServiceFileKind) =>
      isServiceClosingDocument(kind),
    );
    expect([...closing]).toEqual(['act', 'invoice', 'warranty_card']);
  });

  it('подшивается пачка файлов с видом, по умолчанию — вложение', () => {
    expect(attachServiceFilesSchema.parse({ fileIds: [UUID] }).kind).toBe('attachment');
    expect(attachServiceFilesSchema.parse({ fileIds: [UUID], kind: 'act' }).kind).toBe('act');
    expect(attachServiceFilesSchema.safeParse({ fileIds: [] }).success).toBe(false);
    expect(attachServiceFilesSchema.safeParse({ fileIds: [UUID], kind: 'photo' }).success).toBe(
      false,
    );
  });
});

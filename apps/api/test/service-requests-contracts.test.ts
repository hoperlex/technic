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
  hasServiceClosingDocument,
  isServiceClosingDocument,
  isServiceRequestClosed,
  isServiceRequestDeletable,
  isServiceRequestEditable,
  parseServiceRequestNumberSearch,
  serviceHasExecutors,
  serviceMailRepeatable,
  putServiceEstimateSchema,
  reopenServiceEstimateSchema,
  reworkServiceRequestSchema,
  SERVICE_FILE_KINDS,
  SERVICE_REQUEST_SORT_FIELDS,
  SERVICE_REQUEST_STATUSES,
  serviceCommentSchema,
  serviceEstimateItemSchema,
  type ServiceFileKind,
  serviceHoldSchema,
  serviceRequestChangeLabels,
  type ServiceRequestFileDto,
  serviceRequestKindLabels,
  serviceRequestListQuerySchema,
  serviceRequestNeedsClosingDocument,
  serviceResumeSchema,
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
  ['PATCH /:id/start — принять в работу', startServiceRequestSchema, {}],
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
  ['PATCH /:id/hold — заморозка', serviceHoldSchema, { reason: 'ждём запчасть с завода' }],
  ['PATCH /:id/resume — возобновление', serviceResumeSchema, {}],
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

  /**
   * Правка заявки — только «Новой», за которую ещё никто не отвечает (§6.1, Р14). Условие
   * СМЕНИЛО ОСНОВАНИЕ: пока «Новая» означала «ещё не назначена», на вопрос отвечал статус, а после
   * слияния (Р2) назначенная заявка тоже зовётся «Новой» — и `status === 'new'` молча открыл бы
   * правку заявки, которую исполнитель уже прочитал и по которой договорился. Поэтому предикат
   * принимает СТРОКУ, и проверяется здесь именно вторая половина условия.
   */
  it('правится «Новая», за которую ещё никто не отвечает', () => {
    const unassigned = { serviceCounterpartyId: null, executorCount: 0 };
    expect(isServiceRequestEditable({ status: 'new', ...unassigned })).toBe(true);
    // Назначенная сервисная компания закрывает правку, поимённых строк у неё не бывает вовсе.
    expect(
      isServiceRequestEditable({ status: 'new', serviceCounterpartyId: UUID, executorCount: 0 }),
    ).toBe(false);
    // Поимённый исполнитель — то же самое: договорённость уже есть.
    expect(
      isServiceRequestEditable({ status: 'new', serviceCounterpartyId: null, executorCount: 1 }),
    ).toBe(false);
    // Отложенную не правят (Р110): заморозка останавливает ход заявки, и правка её предмета была
    // бы ходом мимо остановки — даже если отложили как раз «Новую». Такую возвращают и правят.
    expect(isServiceRequestEditable({ status: 'on_hold', ...unassigned })).toBe(false);
    // И закрытой она при этом не считается (Р109): техника ждёт этого же ремонта, и вторую заявку
    // на ту же единицу завести нельзя.
    expect(isServiceRequestClosed('on_hold')).toBe(false);
    // Ни один другой статус правки не открывает — включая мёртвые: заявок в них не бывает.
    for (const status of SERVICE_REQUEST_STATUSES.filter((s) => s !== 'new')) {
      expect(isServiceRequestEditable({ status, ...unassigned }), status).toBe(false);
    }
    // Закрытая заявка — «Закрыта» и «Отменена»: ни хода, ни правки ей больше не положено.
    expect(isServiceRequestClosed('accepted')).toBe(true);
    expect(isServiceRequestClosed('cancelled')).toBe(true);
    for (const status of SERVICE_REQUEST_STATUSES.filter(
      (s) => s !== 'accepted' && s !== 'cancelled',
    )) {
      expect(isServiceRequestClosed(status), status).toBe(false);
    }
  });

  /**
   * Повтор письма спрашивается тем же составом исполнителей (Р14), и это не копия предыдущего
   * правила, а второй его повод: письмо «Новой» зовёт службу РАЗОБРАТЬ заявку, и повторять его
   * после назначения незачем — задание исполнителю ушло своим письмом, привязанным к действию.
   * Оставь мы `status === 'new'`, кнопка осталась бы на месте, а письмо звало бы разбирать заявку,
   * которую уже разобрали.
   */
  it('повторяется письмо «Новой» без исполнителей и письмо отмены', () => {
    expect(
      serviceMailRepeatable({ status: 'new', serviceCounterpartyId: null, executorCount: 0 }),
    ).toBe(true);
    expect(
      serviceMailRepeatable({ status: 'new', serviceCounterpartyId: UUID, executorCount: 0 }),
    ).toBe(false);
    expect(
      serviceMailRepeatable({ status: 'new', serviceCounterpartyId: null, executorCount: 1 }),
    ).toBe(false);
    // Отмена повторяется при любом составе: письмо шлют, чтобы не выезжали зря, — и как раз тому,
    // кого успели назначить.
    expect(
      serviceMailRepeatable({ status: 'cancelled', serviceCounterpartyId: UUID, executorCount: 2 }),
    ).toBe(true);
    // Событие письма привязано ко входу в статус, и повторяются ровно эти два.
    for (const status of SERVICE_REQUEST_STATUSES.filter((s) => s !== 'new' && s !== 'cancelled')) {
      expect(
        serviceMailRepeatable({ status, serviceCounterpartyId: null, executorCount: 0 }),
        status,
      ).toBe(false);
    }
  });

  /**
   * Удаление отвязано от правки (В20), и слияние статусов этого НЕ ИЗМЕНИЛО: удаляли «Новую» и
   * «Назначенную» — то есть заявку до того, как за неё взялись, — оба состояния теперь зовутся
   * «Новой», и один `new` покрывает ровно тот же набор заявок, что покрывала прежняя пара. Записано
   * это здесь затем, чтобы следующая правка не приняла совпадение с правкой за недосмотр: условия
   * РАЗНЫЕ — правка требует ещё и отсутствия исполнителей, и расходятся они теперь не на статусе, а
   * на составе.
   */
  it('удаляется «Новая» — в том числе назначенная, и дальше ни одна', () => {
    expect(isServiceRequestDeletable('new')).toBe(true);
    // Мёртвые статусы (`0197`, `0224`) не удаляются: заявок в них не бывает. «Назначенная» среди
    // них — её набор заявок целиком перешёл к «Новой».
    expect(isServiceRequestDeletable('assigned')).toBe(false);
    expect(isServiceRequestDeletable('it_approved')).toBe(false);
    // Дальше — ни при каких условиях: с «В работе» по заявке уже могли списать расходники (Р6), и
    // архивная заявка означала бы списание без основания.
    for (const status of SERVICE_REQUEST_STATUSES.filter((s) => s !== 'new')) {
      expect(isServiceRequestDeletable(status), status).toBe(false);
    }
    // Два правила расходятся на назначенной «Новой»: удалить её можно — работа не начиналась, —
    // а править уже нельзя. Держись они на одном условии, разъехались бы на первой же правке.
    const assigned = { status: 'new', serviceCounterpartyId: UUID, executorCount: 0 } as const;
    expect(isServiceRequestDeletable(assigned.status)).toBe(true);
    expect(isServiceRequestEditable(assigned)).toBe(false);
    // Признак у обоих правил один и тот же, и спрашивается он по строке, а не по статусу.
    expect(serviceHasExecutors(assigned)).toBe(true);
  });

  it('правка приходит частями: менять одно поле, не пересылая остальные', () => {
    const parsed = updateServiceRequestSchema.parse({ comment: 'звонить с 9 до 12', version: 3 });
    expect(parsed.comment).toBe('звонить с 9 до 12');
    expect(parsed.description).toBeUndefined();
    expect(parsed.responsibleName).toBeUndefined();
    expect(updateServiceRequestSchema.safeParse({ description: 'ааа', version: 1 }).success).toBe(
      false,
    );
  });

  /**
   * «Желаемый срок» убран отовсюду (Р115): срок, который ничего не запирает и никого не будит,
   * через месяц стоит просроченным у половины заявок и перестаёт что-либо значить — давность
   * читается возрастом в статусе. Проверяется тем, что поле **не доезжает** до сервера: схема
   * молча выбрасывает его, а не сохраняет в объект, который дальше уходит в `UPDATE`.
   */
  it('желаемого срока в теле больше нет: старый клиент его пришлёт, а сервер не примет', () => {
    const created = createServiceRequestSchema.parse({
      officeEquipmentId: UUID,
      description: 'не захватывает бумагу',
      responsibleName: 'Иванов И. И.',
      responsiblePhone: '9000000000',
      dueDate: '2026-09-01',
    });
    expect(created).not.toHaveProperty('dueDate');
    const updated = updateServiceRequestSchema.parse({ dueDate: '2026-09-01', version: 3 });
    expect(updated).not.toHaveProperty('dueDate');
    // Подпись `dueDate` в истории при этом осталась (Р121): записи прошлых месяцев несут этот ключ,
    // и без строки словаря человек читал бы в истории сырое имя поля.
    expect(serviceRequestChangeLabels.dueDate).toBe('Желаемый срок');
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
 * Согласование объёма работ — одна ручка на «да» и «нет»: у них одно право, одна область и один
 * момент. Статуса «согласовано» не меняет (Р8) — заявка остаётся в «В работе», — а «не согласовано»
 * закрывает её отменой, и потому спрашивает не одно объяснение, а два.
 */
describe('согласование объёма работ', () => {
  /**
   * Причина и решение — РАЗНЫЕ вопросы (Р12), и одним полем они не отвечаются: причина говорит,
   * *почему* объём не согласован («вдвое дороже нового аппарата»), решение — *что делаем вместо*
   * («меняем, заявка на закупку заведена»). Причина уходит комментарием в историю, решение — своей
   * колонкой заявки, и спор по отклонённой заявке начинается именно с решения.
   */
  it('отказ без причины и без решения не проходит, согласие без них — проходит', () => {
    expect(approveServiceEstimateSchema.safeParse({ approved: false, version: 2 }).success).toBe(
      false,
    );
    // Одной причины мало: без решения отменённая заявка не отвечает, что делают вместо ремонта.
    expect(
      approveServiceEstimateSchema.safeParse({
        approved: false,
        reason: 'ищем дешевле',
        version: 2,
      }).success,
    ).toBe(false);
    // И одного решения мало: причина уходит в историю, и без неё пара строк перехода не объясняет
    // ничего.
    expect(
      approveServiceEstimateSchema.safeParse({
        approved: false,
        resolution: 'меняем аппарат, заявка на закупку заведена',
        version: 2,
      }).success,
    ).toBe(false);
    expect(
      approveServiceEstimateSchema.safeParse({
        approved: false,
        reason: 'ищем дешевле',
        resolution: 'меняем аппарат, заявка на закупку заведена',
        version: 2,
      }).success,
    ).toBe(true);
    expect(approveServiceEstimateSchema.safeParse({ approved: true, version: 2 }).success).toBe(
      true,
    );
    // Ошибки адресованы своим полям: форме нужно подсветить именно их, а не общий заголовок.
    const failed = approveServiceEstimateSchema.safeParse({ approved: false, version: 2 });
    expect(failed.success).toBe(false);
    if (!failed.success) {
      expect(failed.error.issues.map((issue) => issue.path)).toEqual([['reason'], ['resolution']]);
    }
  });

  /**
   * Пометка «ремонт нецелесообразен, аппарат под замену» — теперь ОТВЕТ ЧЕЛОВЕКА, а не вывод ручки
   * (Р12): визы ИТ, которая ставила её сама, больше нет, и решение «менять» принимает тот же, кто
   * смотрит на объём работ. Умолчание при этом ложное: молчание формы — это «не рекомендована».
   */
  it('замена аппарата приходит галочкой и по умолчанию не рекомендована', () => {
    expect(
      approveServiceEstimateSchema.parse({ approved: true, version: 2 }).replacementRecommended,
    ).toBe(false);
    expect(
      approveServiceEstimateSchema.parse({
        approved: false,
        reason: 'дороже нового аппарата',
        resolution: 'меняем, заявка на закупку заведена',
        replacementRecommended: true,
        version: 2,
      }).replacementRecommended,
    ).toBe(true);
  });

  it('причина — объяснение, а не отписка из двух букв', () => {
    expect(
      approveServiceEstimateSchema.safeParse({
        approved: false,
        reason: 'не',
        resolution: 'меняем аппарат',
        version: 2,
      }).success,
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
 * Заморозка и возврат (Р103–Р107). Две ручки на одну пару дуг: своя дуга — своя схема, иначе
 * проверка условия перехода разъехалась бы с проверкой данных этого перехода.
 *
 * Причина у заморозки обязательна, потому что даты «отложена до» у неё нет вовсе (Р107): «Отложена
 * · 12 дней» без объяснения не отвечает, ждут запчасть, деньги до квартала или решение заказчика, —
 * и через месяц такой статус читается как «про эту заявку забыли».
 */
describe('заморозка и возврат', () => {
  it('заморозка без причины не проходит, отписка из двух букв — тоже', () => {
    expect(serviceHoldSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(serviceHoldSchema.safeParse({ reason: '', version: 1 }).success).toBe(false);
    expect(serviceHoldSchema.safeParse({ reason: '   ', version: 1 }).success).toBe(false);
    expect(serviceHoldSchema.safeParse({ reason: 'жд', version: 1 }).success).toBe(false);
    // Причина приводится к виду хранения самой схемой: в списке её читают как есть.
    expect(serviceHoldSchema.parse({ reason: '  ждём запчасть  ', version: 1 }).reason).toBe(
      'ждём запчасть',
    );
  });

  /**
   * Куда вернуть, клиент не присылает: исходный статус сервер берёт из самой заявки (Р104).
   * Разреши мы выбирать цель телом — «Отложена» стала бы вторым входом в цикл, в обход виз, сметы и
   * назначения, а старая копия портала отправила бы заявку в статус из прошлого.
   */
  it('возврат принимает пустой комментарий, а цель — не принимает вовсе', () => {
    expect(serviceResumeSchema.parse({ version: 2 }).comment).toBe('');
    expect(serviceResumeSchema.parse({ comment: '  запчасть пришла  ', version: 2 }).comment).toBe(
      'запчасть пришла',
    );
    const parsed = serviceResumeSchema.parse({
      status: 'in_work',
      heldFromStatus: 'diagnostics',
      version: 2,
    });
    expect(parsed).not.toHaveProperty('status');
    expect(parsed).not.toHaveProperty('heldFromStatus');
    // Причина у возврата не требуется: её сказали, когда откладывали.
    expect(serviceResumeSchema.safeParse({ version: 2 }).success).toBe(true);
    expect(serviceResumeSchema.safeParse({ comment: 'а'.repeat(1001), version: 2 }).success).toBe(
      false,
    );
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
    expect(parsed.awaitingDocuments).toBe(false);
    expect(parsed.warrantyClaim).toBe(false);
    expect(parsed.urgent).toBe(false);
    expect(parsed.status).toBeUndefined();
  });

  it('флаги включаются строкой «true», всё остальное значит «нет»', () => {
    const on = serviceRequestListQuerySchema.parse({
      waitingOnMe: 'true',
      mine: 'true',
      awaitingDocuments: 'true',
      warrantyClaim: 'true',
      urgent: 'true',
    });
    expect([on.waitingOnMe, on.mine, on.awaitingDocuments, on.warrantyClaim, on.urgent]).toEqual([
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
    // Отложенная — обычное значение фильтра статуса: заявка открыта (Р109), и отобрать «что у нас
    // стоит» человек должен уметь тем же способом, что и остальное.
    expect(serviceRequestListQuerySchema.parse({ status: 'on_hold' }).status).toBe('on_hold');
  });

  /**
   * Просрочка ушла вместе с полем «Желаемый срок» (Р115): фильтр «Просроченные» и сортировка по
   * сроку отбирали по дате, которую никто не выдерживал, — давность заявки читается возрастом в
   * статусе (`statusChangedAt`). Проверяется отказом, а не тишиной: сортировка по несуществующему
   * полю иначе показала бы человеку список в произвольном порядке.
   */
  it('ни фильтра «просроченные», ни сортировки по сроку больше нет', () => {
    expect(serviceRequestListQuerySchema.safeParse({ sortBy: 'dueDate' }).success).toBe(false);
    expect([...SERVICE_REQUEST_SORT_FIELDS]).not.toContain('dueDate');
    // Флаг из старой ссылки в закладке сервер молча выбрасывает, а не отбирает по нему: поля, по
    // которому считалась просрочка, в заявке уже нет.
    const parsed = serviceRequestListQuerySchema.parse({ overdue: 'true' });
    expect(parsed).not.toHaveProperty('overdue');
    // Возраст в статусе остался и сортируется — это и есть замена сроку.
    expect([...SERVICE_REQUEST_SORT_FIELDS]).toContain('statusChangedAt');
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

  /**
   * Планка приёмки (Р112): хватает **любого** закрывающего документа — акта, счёта или гарантийного
   * талона. Ответ булев, а не перечень недостающих видов: три тега «нет: акт / нет: счёт / нет:
   * талон» читались бы как «нужны все три», а запирает приёмку отсутствие всех сразу. Одна функция
   * на сервер и портал: разойдись они — кнопка приёмки вела бы в 422.
   */
  it('приёмку открывает любой закрывающий документ, а вложение и смета — ни один', () => {
    const file = (kind: ServiceFileKind): ServiceRequestFileDto => ({
      id: UUID,
      filename: `${kind}.pdf`,
      contentType: 'application/pdf',
      size: 1024,
      kind,
      attachedAt: '2026-08-19T09:00:00.000Z',
    });
    for (const kind of ['act', 'invoice', 'warranty_card'] as const) {
      expect(hasServiceClosingDocument({ files: [file(kind)] }), kind).toBe(true);
    }
    // Фотография принтера и смета работу не закрывают: по ним не платят и их не подшивают к акту.
    expect(hasServiceClosingDocument({ files: [file('attachment')] })).toBe(false);
    expect(hasServiceClosingDocument({ files: [file('estimate')] })).toBe(false);
    expect(hasServiceClosingDocument({ files: [file('attachment'), file('estimate')] })).toBe(
      false,
    );
    // Заявка без единого файла — тот самый случай, ради которого планку и заводили.
    expect(hasServiceClosingDocument({ files: [] })).toBe(false);
    // Комплекта не требуется (§8): счёта достаточно, даже когда акта нет.
    expect(hasServiceClosingDocument({ files: [file('attachment'), file('invoice')] })).toBe(true);
  });

  /**
   * Кому документ обязателен (Н8, В7): планка стоит **только внешнему сервису** — за его работу
   * платят, и бумага основание платежа. Свой сисадмин и замена картриджа закрываются без неё.
   *
   * Вид в условии не лишний, хотя заявка на расходники сервису сегодня не назначается: правило,
   * опирающееся на одного исполнителя, начнёт требовать акт в тот день, когда картриджи повезёт
   * подрядчик. Проверяются поэтому все четыре сочетания, а не одно рабочее.
   */
  it('документ обязателен сервисному ремонту — и больше никому', () => {
    const repairByService = { kind: 'repair', serviceCounterpartyId: UUID } as const;
    expect(serviceRequestNeedsClosingDocument(repairByService)).toBe(true);
    // Инхаус-ремонт: исполнитель свой, платить по акту некому.
    expect(
      serviceRequestNeedsClosingDocument({ kind: 'repair', serviceCounterpartyId: null }),
    ).toBe(false);
    // Расходники: ни у своего, ни у подрядчика бумаги не требуют — везли картридж, а не ремонт.
    expect(
      serviceRequestNeedsClosingDocument({ kind: 'consumable', serviceCounterpartyId: UUID }),
    ).toBe(false);
    expect(
      serviceRequestNeedsClosingDocument({ kind: 'consumable', serviceCounterpartyId: null }),
    ).toBe(false);
    // Два вида и обе подписи — на случай, если словарь видов начнёт расти молча.
    expect(Object.keys(serviceRequestKindLabels).sort()).toEqual(['consumable', 'repair']);
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

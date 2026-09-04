import { describe, expect, it } from 'vitest';
import {
  type AccessSubject,
  attachableServiceFileKinds,
  canAttachServiceFile,
  isServiceFileKindVisible,
  projectHistoryForAudience,
  projectServiceRequestForAudience,
  type RequestHistoryEntryDto,
  SERVICE_FILE_KINDS,
  SERVICE_HISTORY_CHANGE_AUDIENCE,
  SERVICE_REQUEST_FIELD_AUDIENCE,
  SERVICE_REQUEST_STATUSES,
  type ServiceExecutorAssignment,
  type ServiceFileKind,
  type ServiceRequestDto,
  serviceRequestAudienceOf,
  serviceRequestChangeLabels,
  visibleServiceFileKinds,
} from '@technic/contracts';

/**
 * Разграничение карточки заявки на обслуживание по аудиториям (план
 * `docs/office-equipment-requester-card-plan.md`, §7.1) — без базы и без приложения.
 *
 * Проверяется здесь не «функции работают», а **решения плана**: кому деньги открыты и по какому
 * основанию, что именно вычищается заявителю, что остаётся, и — главное — что забыть поле или ключ
 * нельзя. Механизм заведён в портале впервые (прецедента серверной проекции DTO по читателю не
 * было), и цена ошибки в нём не «некрасиво», а «утекло»; ловить такие ошибки db-тестом дороже, а
 * проекция проверяема без базы целиком.
 */

const UUID = '11111111-1111-4111-8111-111111111111';

/** Держатель права: аудиторию ему открывает `serviceRequests.finance`, а не роль и не назначение. */
const OPERATOR: AccessSubject = { role: 'shtab', addons: ['office_equipment_operator'] };
/** Заказчик: заводит заявки, но денег по ним не видит. */
const CUSTOMER: AccessSubject = { role: 'shtab' };
/**
 * Внутренний исполнитель: право `execute` есть, `finance` — нет, и деньги ему открывает НАЗНАЧЕНИЕ.
 *
 * Собран назначенным полномочием, а не надстройкой: обе сегодняшние надстройки модуля несут
 * `finance`, и на них эту ветку не проверить вовсе. Набор `office_equipment_executor` — предмет
 * соседнего плана профилей и в дереве его пока нет; ветка от этого не страдает — она про факт
 * назначения, а не про набор, и субъект здесь ровно то, чем этот набор станет.
 */
const EXECUTOR: AccessSubject = {
  role: 'shtab',
  grantPermissions: ['serviceRequests.execute'],
};
/** Оператор сервисной компании: назначается контрагент целиком, поимённых строк у него не бывает. */
const SERVICE_COMPANY: AccessSubject = { role: 'operator', counterpartyType: 'service' };

const NOT_ASSIGNED: ServiceExecutorAssignment = {
  actsForAssignedCounterparty: false,
  isNamedExecutor: false,
};
const NAMED: ServiceExecutorAssignment = {
  actsForAssignedCounterparty: false,
  isNamedExecutor: true,
};
const ASSIGNED_COUNTERPARTY: ServiceExecutorAssignment = {
  actsForAssignedCounterparty: true,
  isNamedExecutor: false,
};

const file = (kind: ServiceFileKind) => ({
  id: `file-${kind}`,
  filename: `${kind}.pdf`,
  contentType: 'application/pdf',
  size: 1024,
  kind,
  attachedAt: '2026-08-14T10:00:00.000Z',
});

/**
 * Образец, где заполнено ВСЁ: и деньги, и факт закрытия, и все пять видов документов.
 *
 * Пустых полей в нём нет намеренно — иначе «поле обнулилось» и «поле и так было пустым» читались бы
 * одинаково, и проверка обнуления доказывала бы ровно ничего.
 */
const FULL: ServiceRequestDto = {
  audience: 'finance',
  id: UUID,
  num: 14,
  displayNumber: 'СО-14',
  kind: 'repair',
  status: 'accepted',
  statusChangedAt: '2026-08-20T09:00:00.000Z',
  waitingOn: 'nobody',
  heldFromStatus: null,
  holdReason: '',
  equipment: {
    id: UUID,
    name: 'Ricoh MP 2014',
    serialNumber: 'G1234567',
    inventoryNumber: '00-000123',
    typeName: 'МФУ',
    location: 'Корпус 3, каб. 214',
    /*
     * Срок гарантии единицы (Ф3 плана кандидата) — поле блока предмета, которого в образце не
     * было: `test` не типизируется (`tsconfig` включает только `src` и `scripts`), и пропуск
     * компилятор не поймал. Заполнено, как и всё здесь, намеренно: закрыто оно НЕ этой картой, а
     * правом справочника в сборке DTO, и пустое значение читалось бы как «карта его всё-таки
     * режет».
     */
    warrantyUntil: '2027-03-01',
  },
  /*
   * Сообщение о технике (план кандидатов, §9). В образце оно стоит РЯДОМ с заполненным
   * `equipment`, хотя в жизни у одной заявки бывает что-то одно: образец проверяет не связность
   * состояний, а полноту карты решений, и пустое поле здесь означало бы «решения по нему нет».
   * Исход взят отказом — единственный, у которого непуста причина, а она и есть то, что могло бы
   * быть вычтено у заявителя.
   */
  equipmentCandidate: {
    id: UUID,
    status: 'rejected',
    declaredModel: 'Kyocera ECOSYS M3145',
    serialNumber: 'K4711',
    inventoryNumber: '00-000999',
    decisionReason: 'В кабинете 214 стоит другой аппарат',
  },
  object: { id: UUID, code: 'ОБ-1', name: 'Площадка «Северная»' },
  objectOverridden: true,
  objectMismatch: true,
  customerDepartment: { id: UUID, code: 'ОТ-1', name: 'Бухгалтерия' },
  equipmentDepartment: { id: UUID, code: 'ОТ-2', name: 'ПТО' },
  requesterPlace: { kind: 'department', id: UUID, name: 'Бухгалтерия' },
  description: 'не захватывает бумагу',
  responsibleName: 'Иванов И. И.',
  responsiblePhone: '9000000000',
  isUrgent: true,
  urgencyReason: 'закрываем месяц',
  service: { id: UUID, name: 'Сервисный центр «Копир»' },
  executors: [{ userId: UUID, name: 'Петров П. П.', assignedAt: '2026-08-14T08:00:00.000Z' }],
  itApproval: { by: UUID, byName: 'Сидоров С. С.', at: '2026-08-13T08:00:00.000Z', auto: false },
  warrantyClaim: {
    source: 'item',
    itemId: UUID,
    itemName: 'Ролик подачи',
    sourceRequestNum: 9,
  },
  estimateRevision: 3,
  estimatePendingRevision: 3,
  estimateSubmittedAt: '2026-08-15T12:00:00.000Z',
  estimatedTotalAmount: 7100,
  approval: { by: UUID, byName: 'Сидоров С. С.', at: '2026-08-16T12:00:00.000Z', revision: 3 },
  items: [
    {
      id: UUID,
      kind: 'part',
      name: 'Ролик подачи',
      quantity: 1,
      unitPrice: 1800,
      amount: 1800,
      performed: true,
      actualQuantity: 1,
      actualAmount: 1800,
      warrantyMonths: 6,
      warrantyUntil: '2027-02-14',
      warrantyUntilManual: false,
    },
  ],
  consumables: [
    {
      id: UUID,
      consumableId: UUID,
      code: 'Д0000093569',
      name: 'Тонер Ricoh 201',
      color: null,
      requestedQuantity: 2,
      issuedQuantity: 2,
      issueNote: '',
    },
  ],
  completion: {
    completedAt: '2026-08-18T15:00:00.000Z',
    totalAmount: 6900,
    adjustmentAmount: -200,
    adjustmentReason: 'скидка постоянному клиенту',
  },
  acceptedByName: 'Сидоров С. С.',
  acceptedAt: '2026-08-20T09:00:00.000Z',
  acceptanceSource: 'human',
  replacementRecommended: false,
  rejectionResolution: '',
  comment: 'звонить после 15:00',
  serviceComment: 'ждём ролик с завода',
  chat: {
    canWrite: true,
    participantSides: ['customer'],
    total: 4,
    unreadMine: 1,
    unreadOthers: true,
    lastSeq: 4,
    readThroughSeq: 3,
  },
  files: SERVICE_FILE_KINDS.map(file),
  createdByName: 'Иванов И. И.',
  createdAt: '2026-08-12T07:00:00.000Z',
  updatedAt: '2026-08-20T09:00:00.000Z',
  deletedAt: null,
  version: 7,
};

describe('аудитория заявки: право или назначение', () => {
  /**
   * Два положительных основания и ни одного отрицательного (Р1). Проверяется не только «кому
   * открыто», но и что назначение работает ПОСТРОЧНО: тот же субъект с тем же токеном на
   * неназначенной заявке — уже `requester`.
   */
  it('право открывает деньги везде, назначение — ровно на своей заявке', () => {
    expect(serviceRequestAudienceOf(OPERATOR, NOT_ASSIGNED)).toBe('finance');
    expect(serviceRequestAudienceOf(SERVICE_COMPANY, ASSIGNED_COUNTERPARTY)).toBe('finance');
    // Назначенный поимённо исполнитель с `execute`: деньги открывает факт назначения.
    expect(serviceRequestAudienceOf(EXECUTOR, NAMED)).toBe('finance');
    // Он же без назначения — заявка его базовой области, и денег в ней он не видит.
    expect(serviceRequestAudienceOf(EXECUTOR, NOT_ASSIGNED)).toBe('requester');
    // Заказчик со строкой назначения, но без `execute`: одной строки мало — предикат исполнителя
    // спрашивает право в паре с назначением, и подмена условия своим сломала бы именно этот случай.
    expect(serviceRequestAudienceOf(CUSTOMER, NAMED)).toBe('requester');
    expect(serviceRequestAudienceOf(CUSTOMER, NOT_ASSIGNED)).toBe('requester');
    expect(serviceRequestAudienceOf(null, ASSIGNED_COUNTERPARTY)).toBe('requester');
    // Наблюдатель денег не видит (решение заказчика, §12 п. 3): роль читает модуль целиком, но
    // права `finance` в матрице у неё нет.
    expect(serviceRequestAudienceOf({ role: 'observer' }, NOT_ASSIGNED)).toBe('requester');
  });
});

describe('проекция карточки', () => {
  const projected = projectServiceRequestForAudience(FULL, 'requester');

  it('финансовой аудитории не достаётся ни одной правки', () => {
    expect(projectServiceRequestForAudience(FULL, 'finance')).toBe(FULL);
  });

  /** Таблица Р4 построчно: что именно видит заявитель вместо денег. */
  it('заявителю обнуляются деньги и состав работ', () => {
    expect(projected.audience).toBe('requester');
    expect(projected.items).toEqual([]);
    expect(projected.estimatedTotalAmount).toBeNull();
    expect(projected.estimateSubmittedAt).toBeNull();
    expect(projected.estimatePendingRevision).toBeNull();
    expect(projected.estimateRevision).toBe(0);
    expect(projected.approval).toBeNull();
    expect(projected.completion?.totalAmount).toBeNull();
    expect(projected.completion?.adjustmentAmount).toBeNull();
    expect(projected.completion?.adjustmentReason).toBe('');
  });

  /**
   * Вторая половина того же решения, и она не менее важна: план ТОЛЬКО ВЫЧИТАЕТ, и лишняя вычтенная
   * строка — такой же дефект, как оставленная сумма. «Работы закрыты 18 августа» — не деньги, а
   * факт, которого заявитель ждёт больше всего остального в этой карточке.
   */
  it('оставленное не тронуто: дата закрытия, расходники, обсуждение, исполнители', () => {
    expect(projected.completion?.completedAt).toBe(FULL.completion?.completedAt);
    expect(projected.consumables).toEqual(FULL.consumables);
    expect(projected.chat).toEqual(FULL.chat);
    expect(projected.executors).toEqual(FULL.executors);
    expect(projected.service).toEqual(FULL.service);
    expect(projected.itApproval).toEqual(FULL.itApproval);
    expect(projected.serviceComment).toBe(FULL.serviceComment);
    expect(projected.description).toBe(FULL.description);
    expect(projected.status).toBe(FULL.status);
  });

  it('в списке файлов остаются только видимые виды', () => {
    expect(projected.files.map((f) => f.kind)).toEqual(['attachment', 'warranty_card']);
  });

  /**
   * Проекция применяется и к ответам действий, поэтому двойное применение обязано ничего не менять.
   * Держится это тем, что все подстановки — константы, а фильтр файлов повторно ничего не находит;
   * проверка стоит потому, что нарушить это легко первой же «умной» подстановкой вида
   * «уменьшить ревизию на единицу».
   */
  it('проекция идемпотентна', () => {
    expect(projectServiceRequestForAudience(projected, 'requester')).toEqual(projected);
  });

  /**
   * Незакрытая заявка: вложенная карта обязана оставить `null` нулём, а не собрать из него объект с
   * пустыми полями. «Закрытия не было» и «закрытие есть, но без сумм» — разные состояния, и портал
   * различает их именно так.
   */
  it('пустое закрытие остаётся пустым', () => {
    const open = projectServiceRequestForAudience(
      { ...FULL, status: 'in_work', completion: null },
      'requester',
    );
    expect(open.completion).toBeNull();
  });

  /**
   * Исходный объект остаётся целым: сборка ответа зовёт проекцию поверх готового DTO, и порча
   * оригинала означала бы, что соседний читатель того же кэша получил урезанную карточку.
   */
  it('исходное DTO не меняется', () => {
    expect(FULL.items).toHaveLength(1);
    expect(FULL.files).toHaveLength(SERVICE_FILE_KINDS.length);
    expect(FULL.completion?.totalAmount).toBe(6900);
  });

  /**
   * Структурный сторож Р5 — ВТОРОЙ рубеж, а не основной: полноту держит компилятор
   * (`satisfies AudiencePolicy<ServiceRequestDto>`), а эвристика ловит очевидно ошибочную
   * классификацию `all` у нового денежного поля. Обход рекурсивный: сумма, спрятанная во вложенном
   * объекте, тем и опасна, что в глаза не бросается.
   */
  it('в ответе заявителя не осталось ни одного денежного значения', () => {
    const money = /amount|price|estimate|approval|cost|total/i;
    const walk = (value: unknown, path: string): void => {
      if (value == null) return;
      // Обсуждение из обхода исключено, и это не поблажка: `chat.total` — счётчик реплик, а не
      // рубли, и эвристика по имени поля тут отвечает неверно. Лента остаётся заявителю целиком по
      // решению плана (Г4), поэтому «денег» в ней ищет не тест, а граница.
      if (path === 'dto.chat') return;
      if (Array.isArray(value)) {
        value.forEach((item, i) => walk(item, `${path}[${i}]`));
        return;
      }
      if (typeof value === 'object') {
        for (const [key, nested] of Object.entries(value)) {
          if (money.test(key) && typeof nested === 'number' && nested !== 0) {
            throw new Error(`денежное значение уехало заявителю: ${path}.${key} = ${nested}`);
          }
          walk(nested, `${path}.${key}`);
        }
      }
    };
    expect(() => walk(projected, 'dto')).not.toThrow();
  });
});

describe('закрытые карты решений', () => {
  /**
   * Полнота карты полей держится компилятором, а не этим тестом: поле, добавленное в
   * `ServiceRequestDto` без строки в карте, ломает `satisfies` — сборка не соберётся. Здесь
   * проверяется вторая сторона того же — что карта не отстала от образца: ключ, которого в DTO нет,
   * компилятор пропустил бы (лишние ключи `satisfies` объектного типа не запрещает), а проекция
   * молча подставила бы значение в несуществующее поле.
   */
  it('карта полей совпадает с составом DTO ключ в ключ', () => {
    expect(Object.keys(SERVICE_REQUEST_FIELD_AUDIENCE).sort()).toEqual(Object.keys(FULL).sort());
  });

  /**
   * Ключи истории и подписи истории — один перечень (`ServiceRequestChangeKey` выведен из словаря
   * подписей). Проверка стоит на случай, если карту аудиторий однажды объявят своим списком:
   * разъехавшись, они дали бы либо строку с сырым именем поля, либо изменение, о котором никто не
   * решал.
   */
  it('карта истории покрывает все ключи изменений', () => {
    expect(Object.keys(SERVICE_HISTORY_CHANGE_AUDIENCE).sort()).toEqual(
      Object.keys(serviceRequestChangeLabels).sort(),
    );
  });

  /** Новый вид документа обязан получить решение: перечень видимых выводится из той же таблицы. */
  it('видимость решена у каждого вида документа', () => {
    for (const kind of SERVICE_FILE_KINDS) {
      expect(typeof isServiceFileKindVisible(kind, 'requester'), kind).toBe('boolean');
      expect(isServiceFileKindVisible(kind, 'finance'), kind).toBe(true);
    }
  });
});

describe('видимость и подшивка документов', () => {
  /** Матрица §4.1: заявителю остаются его собственные вложения и гарантийный талон. */
  it('заявитель видит вложение и гарантийный талон, финансовая аудитория — все пять', () => {
    expect(visibleServiceFileKinds('requester')).toEqual(['attachment', 'warranty_card']);
    expect(visibleServiceFileKinds('finance')).toEqual([...SERVICE_FILE_KINDS]);
  });

  /**
   * Заявитель кладёт единственный вид, и только в тех статусах, где его принимают вообще. Правило
   * статуса при этом общее: аудитория ничего к нему не прибавляет — она вычитает.
   *
   * Стороной заявитель тут не ограничен ни разу, и это не пропуск: у `attachment` стороны нет
   * вовсе (`attachedBySide: ['any']`) — фотографию поломки грузит тот, кто заявку и завёл.
   */
  it('заявитель кладёт только вложение, и только по правилу статуса', () => {
    for (const status of SERVICE_REQUEST_STATUSES) {
      const requester = attachableServiceFileKinds(status, 'requester', CUSTOMER, NOT_ASSIGNED);
      expect(
        requester.every((kind) => kind === 'attachment'),
        status,
      ).toBe(true);
      // Всё, что аудитории разрешено, разрешено и по статусу — и наоборот: вложение, принимаемое
      // в этом статусе, заявителю не запрещают. Сторона у сравниваемого субъекта полная
      // (исполнитель), иначе сравнение упёрлось бы в неё, а не в статус.
      expect(requester, status).toEqual(
        attachableServiceFileKinds(status, 'finance', EXECUTOR, NAMED).filter(
          (kind) => kind === 'attachment',
        ),
      );
    }
    expect(canAttachServiceFile('attachment', 'new', 'requester', CUSTOMER, NOT_ASSIGNED)).toBe(
      true,
    );
    expect(canAttachServiceFile('invoice', 'in_work', 'requester', CUSTOMER, NOT_ASSIGNED)).toBe(
      false,
    );
    // Закрытая заявка вложений не принимает ни у кого: после приёмки она принимает бумаги и ничего
    // не отдаёт (Р16, Р29).
    expect(
      canAttachServiceFile('attachment', 'accepted', 'requester', CUSTOMER, NOT_ASSIGNED),
    ).toBe(false);
    expect(canAttachServiceFile('attachment', 'accepted', 'finance', EXECUTOR, NAMED)).toBe(false);
  });

  /**
   * Сегодняшний перечень статусов у финансовой аудитории не меняется ни на один вид — это условие
   * совместимости выката: «Ведение», ИТ-служба и сервис обязаны увидеть ровно то, что видели.
   * Таблица переехала в контракты из маршрута, и переезд не имеет права ничего поправить «заодно».
   *
   * Субъект здесь — назначенный исполнитель: слой стороны (Р3 плана аудита исполнителей) проверяет
   * соседний случай, а этот про статусы, и посторонняя сторона превратила бы его в проверку двух
   * правил сразу — упади он, было бы не видно, какое из них поехало.
   */
  it('перечень статусов финансовой аудитории — прежняя таблица маршрута', () => {
    const before: Record<ServiceFileKind, string[]> = {
      attachment: ['new', 'in_work', 'done'],
      estimate: ['in_work'],
      act: ['in_work', 'done', 'accepted', 'cancelled'],
      invoice: ['in_work', 'done', 'accepted', 'cancelled'],
      warranty_card: ['in_work', 'done', 'accepted', 'cancelled'],
    };
    for (const kind of SERVICE_FILE_KINDS) {
      const allowed = SERVICE_REQUEST_STATUSES.filter((status) =>
        canAttachServiceFile(kind, status, 'finance', EXECUTOR, NAMED),
      );
      expect([...allowed], kind).toEqual(before[kind]);
    }
  });

  /**
   * ВТОРОЙ СЛОЙ ПОДШИВКИ — СТОРОНА (план аудита исполнителей, Р3), остаток находки Н2.
   *
   * Аудитория отвечает на вопрос «видны ли этому читателю деньги заявки», и `finance` бывает
   * сквозным: у ИТ-службы он выдан набором на всю компанию. Пока подшивку решала одна аудитория,
   * держатель `finance` без всякого отношения к работе клал акт или счёт — а именно наличие любого
   * из них снимает планку закрывающего документа, и подрядчик закрывал работу под чужой бумагой.
   *
   * Проверяется здесь ровно эта разница: тот же вид, тот же статус, та же аудитория, разные стороны.
   */
  it('закрывающий документ кладёт сторона, а не финансовая аудитория', () => {
    // Держатель `finance` без стороны — та самая ИТ-служба: `execute` у неё есть, но заявка не её,
    // и `serviceRequests.status` («Ведение») ей не выдают.
    const IT_SERVICE: AccessSubject = {
      role: 'shtab',
      grantPermissions: ['serviceRequests.execute', 'serviceRequests.finance'],
    };
    expect(serviceRequestAudienceOf(IT_SERVICE, NOT_ASSIGNED)).toBe('finance');
    for (const kind of ['act', 'invoice', 'warranty_card', 'estimate'] as const) {
      expect(canAttachServiceFile(kind, 'in_work', 'finance', IT_SERVICE, NOT_ASSIGNED), kind).toBe(
        false,
      );
      // Назначение ту же учётку и допускает: сторона — это факт по ЭТОЙ заявке, а не должность.
      expect(canAttachServiceFile(kind, 'in_work', 'finance', IT_SERVICE, NAMED), kind).toBe(true);
    }
    // Вложение стороны не спрашивает — иначе половина заявок осталась бы без фотографии поломки.
    expect(canAttachServiceFile('attachment', 'new', 'finance', IT_SERVICE, NOT_ASSIGNED)).toBe(
      true,
    );
  });

  /**
   * «Ведение» — вторая сторона закрывающих документов и НЕ сторона объёма работ (Р3). Различие
   * рабочее: акт приходит почтой, и сканирует его тот, кто ведёт заявку, — а предложить объём работ
   * за исполнителя означало бы подписать собственное согласование.
   */
  it('«Ведение» кладёт акт и счёт, но не объём работ', () => {
    for (const kind of ['act', 'invoice', 'warranty_card'] as const) {
      expect(canAttachServiceFile(kind, 'in_work', 'finance', OPERATOR, NOT_ASSIGNED), kind).toBe(
        true,
      );
    }
    expect(canAttachServiceFile('estimate', 'in_work', 'finance', OPERATOR, NOT_ASSIGNED)).toBe(
      false,
    );
    // Сервисная компания — сторона исполнителя ровно на назначенной ей заявке (`isServiceExecutor`).
    expect(
      canAttachServiceFile(
        'estimate',
        'in_work',
        'finance',
        SERVICE_COMPANY,
        ASSIGNED_COUNTERPARTY,
      ),
    ).toBe(true);
    expect(
      canAttachServiceFile('estimate', 'in_work', 'finance', SERVICE_COMPANY, NOT_ASSIGNED),
    ).toBe(false);
  });
});

describe('история заявки', () => {
  const entry = (
    kind: RequestHistoryEntryDto['kind'],
    changes: RequestHistoryEntryDto['changes'],
  ): RequestHistoryEntryDto => ({
    id: `${kind}-1`,
    kind,
    at: '2026-08-15T12:00:00.000Z',
    actorId: UUID,
    actorName: 'Петров П. П.',
    fromStatus: null,
    toStatus: null,
    comment: '',
    changes,
  });

  const ENTRIES: RequestHistoryEntryDto[] = [
    entry('estimateSubmitted', [
      {
        field: 'estimateItemsAdded',
        from: null,
        to: 'Запчасть «Ролик подачи», 1 × 1800,00 ₽',
      },
    ]),
    entry('documentAttached', [
      { field: 'filesAdded', from: null, to: 'фото.jpg, Счёт: s.pdf, Гарантийный талон: g.pdf' },
    ]),
    entry('updated', [{ field: 'description', from: 'не берёт бумагу', to: 'не захватывает' }]),
    entry('completed', [{ field: 'itemsNotPerformed', from: null, to: 'Тормозная площадка' }]),
    // Ключ из записей прошлых месяцев: поле сняли, а строка аудита осталась.
    entry('updated', [{ field: 'unknownLegacyField', from: '1', to: '2' }]),
  ];

  it('финансовая аудитория получает историю целиком', () => {
    expect(projectHistoryForAudience(ENTRIES, 'finance')).toEqual(ENTRIES);
  });

  /**
   * Событие с опустевшим списком изменений НЕ выбрасывается: «Объём работ предъявлен» без цифр —
   * это и есть ответ на вопрос «что происходило с моей заявкой», а выброшенное событие оставило бы
   * в ленте провал, который читается как поломка портала.
   */
  it('заявителю остаются события, но не цифры', () => {
    const projected = projectHistoryForAudience(ENTRIES, 'requester');
    expect(projected).toHaveLength(ENTRIES.length);
    expect(projected[0].kind).toBe('estimateSubmitted');
    expect(projected[0].changes).toEqual([]);
    expect(projected[3].changes).toEqual([]);
    // Правка заявки не трогается вовсе.
    expect(projected[2].changes).toEqual(ENTRIES[2].changes);
    // Ни одна сгенерированная строка не содержит знака рубля.
    for (const item of projected) {
      for (const change of item.changes) {
        expect(`${change.from ?? ''}${change.to ?? ''}`).not.toContain('₽');
      }
    }
  });

  it('перечень файлов режется по видимым видам, а событие остаётся', () => {
    const projected = projectHistoryForAudience(ENTRIES, 'requester');
    expect(projected[1].changes).toEqual([
      { field: 'filesAdded', from: null, to: 'фото.jpg, Гарантийный талон: g.pdf' },
    ]);
  });

  /**
   * FAIL-CLOSED, и это отдельный случай, а не следствие соседних: ключ, которого карта не знает,
   * СКРЫВАЕТСЯ. Обратное умолчание означало бы, что снятое денежное поле всплывает в истории само —
   * и всплывает молча, потому что строки, которая бы это разрешила, никто не писал.
   */
  it('неизвестный ключ заявителю не показывается', () => {
    const projected = projectHistoryForAudience(ENTRIES, 'requester');
    expect(projected[4].changes).toEqual([]);
    expect(projected[4].kind).toBe('updated');
  });
});

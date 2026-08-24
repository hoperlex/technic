import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WASTE_TICKET_TOLERANCES,
  type StoredWasteTicketResolution,
  type WasteTicketCheckInputs,
  type WasteTicketCheckRequest,
  type WasteTicketCheckTicket,
  type WasteTicketChecksInput,
  type WasteTicketCompletion,
  wasteTicketCheckFingerprint,
  wasteTicketChecks,
} from '../src/services/waste-ticket-checks';
import {
  wasteTicketNumberFuzzy,
  wasteTicketNumberKey,
} from '../src/services/waste-ticket-normalize';

// Сверка талонов с заявкой (ADR 0114, план `docs/waste-ticket-ocr-plan.md`, Р15–Р21).
// Фикстуры синтетические: репозиторий публичный, настоящих сканов, номеров и ФИО в тестах нет.

const OPERATOR = 'operator-1';
const OTHER_OPERATOR = 'operator-2';
const PAGE_SHA = 'a'.repeat(64);
const OTHER_PAGE_SHA = 'b'.repeat(64);

const REQUEST: WasteTicketCheckRequest = {
  requestedVolumeM3: 40,
  deliveryAt: new Date('2026-08-17T09:00:00.000Z'),
  objectAddress: 'Волоколамское шоссе, 71к14',
  objectName: 'Площадка на Волоколамском',
  operatorCounterpartyId: OPERATOR,
};

const COMPLETION: WasteTicketCompletion = {
  volumeM3: 40,
  removedOn: '2026-08-17',
  removedOnSource: 'entered',
};

/** Историческое закрытие: дня вывоза нет и он НЕ выдумывается (Р19). */
const HISTORIC: WasteTicketCompletion = {
  volumeM3: 40,
  removedOn: null,
  removedOnSource: 'unknown',
};

function ticket(over: Partial<WasteTicketCheckTicket> = {}): WasteTicketCheckTicket {
  const numberRaw = over.numberRaw ?? '30476';
  return {
    id: 't1',
    numberRaw,
    numberKey: wasteTicketNumberKey(numberRaw),
    numberFuzzy: wasteTicketNumberFuzzy(numberRaw),
    issuedOn: '2026-08-17',
    volumeM3: 20,
    workKind: 'removal',
    addressRaw: 'Волоколамское ш. 71/14',
    status: 'confirmed',
    operatorCounterpartyId: OPERATOR,
    pageId: 'page-1',
    pageSha256: PAGE_SHA,
    duplicateOverride: false,
    ...over,
  };
}

/** Две бумаги по 20 м³ на одном кадре — обычная пачка от перевозчика. */
function twoTickets(): WasteTicketCheckTicket[] {
  return [ticket({ id: 't1', numberRaw: '30476' }), ticket({ id: 't2', numberRaw: '30477' })];
}

function run(over: Partial<WasteTicketChecksInput> = {}) {
  return wasteTicketChecks({
    request: REQUEST,
    completion: COMPLETION,
    tickets: twoTickets(),
    ...over,
  });
}

function codes(result: ReturnType<typeof run>): string[] {
  return result.checks.map((c) => c.code);
}

function messageOf(result: ReturnType<typeof run>, code: string): string {
  return result.checks.find((c) => c.code === code)?.message ?? '';
}

describe('сверка молчит, когда всё сошлось', () => {
  it('две бумаги по 20 м³ против закрытия на 40 — ни одного замечания', () => {
    const result = run();
    expect(result.checks).toEqual([]);
    expect(result.ticketsVolumeM3).toBe(40);
    expect(result.preliminary).toBe(false);
    expect(result.acceptanceAllowed).toBe(true);
    expect(result.badge).toEqual({ errors: 0, warnings: 0, pendingConfirmation: 0 });
  });

  it('талонов нет вовсе — сверять нечего, «в талонах 0 м³» не пишется', () => {
    // О том, что распознавание не отработало, говорит состояние файла (Р29), а не сверка.
    expect(run({ tickets: [] }).checks).toEqual([]);
  });
});

describe('объём: сумма против факта и против заявки (Р18)', () => {
  it('недогруз — жёсткое расхождение с закрытием', () => {
    const result = run({ completion: { ...COMPLETION, volumeM3: 48 } });
    expect(codes(result)).toEqual(['volume_mismatch']);
    expect(messageOf(result, 'volume_mismatch')).toBe('В талонах 40 м³, в закрытии 48 м³');
    // Расхождение по объёму — про деньги, поэтому красное.
    expect(result.checks[0]!.severity).toBe('error');
    // Проверка заявочная: предмет пустой, и принятие у неё одно на заявку.
    expect(result.checks[0]!.subjectKey).toBe('');
  });

  it('перегруз против заявленного — мягкое предупреждение', () => {
    const result = run({ request: { ...REQUEST, requestedVolumeM3: 30 } });
    expect(codes(result)).toEqual(['volume_over_request']);
    expect(messageOf(result, 'volume_over_request')).toBe(
      'В талонах 40 м³, в заявке 30 м³ — на 33 % больше заказанного',
    );
    expect(result.checks[0]!.severity).toBe('warning');
  });

  it('перегруз в пределах допуска плана молчит', () => {
    // 40 против 38 — это 5 %, а терпится 10 %.
    expect(run({ request: { ...REQUEST, requestedVolumeM3: 38 } }).checks).toEqual([]);
  });

  it('недогруз против заявки замечанием не считается', () => {
    // Заказали 60, вывезли 40 — вывезли столько, сколько было; сверка с фактом при этом сходится.
    const result = run({
      request: { ...REQUEST, requestedVolumeM3: 60 },
      completion: { ...COMPLETION, volumeM3: 40 },
    });
    expect(result.checks).toEqual([]);
  });

  it('допуск объёма поднимается параметром, а не пересчётом на месте', () => {
    const tickets = [
      ticket({ id: 't1', volumeM3: 19.5 }),
      ticket({ id: 't2', numberRaw: '30477' }),
    ];
    expect(run({ tickets }).checks.map((c) => c.code)).toEqual(['volume_mismatch']);
    expect(
      run({ tickets, tolerances: { ...DEFAULT_WASTE_TICKET_TOLERANCES, volumeM3: 0.5 } }).checks,
    ).toEqual([]);
  });

  it('талон простоя в сумму не входит и объёма не требует', () => {
    const tickets = [
      ticket({ id: 't1', volumeM3: 20 }),
      ticket({ id: 't2', numberRaw: '30477', volumeM3: 20 }),
      // «Простой с 9:10 по 10:10» — объёма на такой бумаге нет законно.
      ticket({ id: 't3', numberRaw: '30478', workKind: 'idle', volumeM3: null }),
    ];
    const result = run({ tickets });
    expect(result.checks).toEqual([]);
    expect(result.ticketsVolumeM3).toBe(40);
  });

  it('нечитаемый объём у вывоза называется прямо в замечании', () => {
    const tickets = [
      ticket({ id: 't1', volumeM3: 20 }),
      ticket({ id: 't2', numberRaw: '30477', volumeM3: null }),
    ];
    expect(messageOf(run({ tickets }), 'volume_mismatch')).toBe(
      'В талонах 20 м³, в закрытии 40 м³; объём не прочитан у 1 талона',
    );
  });

  it('закрытие весом с талонами вывоза не сверяется', () => {
    // Металлолом закрывается весовой квитанцией (ADR 0067), кубов в закрытии нет вовсе.
    expect(run({ completion: { ...COMPLETION, volumeM3: null } }).checks).toEqual([]);
  });
});

describe('предварительный результат и разбор (Р15)', () => {
  it('неподтверждённые талоны считаются, но результат помечен «предварительно»', () => {
    const tickets = [
      ticket({ id: 't1', status: 'confirmed' }),
      ticket({ id: 't2', numberRaw: '30477', status: 'unconfirmed' }),
    ];
    const result = run({ tickets, completion: { ...COMPLETION, volumeM3: 48 } });
    expect(result.preliminary).toBe(true);
    // Принять расхождение нельзя: отпечаток снимался бы с промежуточного состояния.
    expect(result.acceptanceAllowed).toBe(false);
    expect(result.checks[0]!.preliminary).toBe(true);
    expect(messageOf(result, 'volume_mismatch')).toBe(
      'В талонах 40 м³ (1 из 2 не подтверждён), в закрытии 48 м³',
    );
    expect(result.badge.pendingConfirmation).toBe(1);
  });

  it('множественное число в счётчике неподтверждённых', () => {
    const tickets = [
      ticket({ id: 't1', status: 'unconfirmed' }),
      ticket({ id: 't2', numberRaw: '30477', status: 'unconfirmed' }),
    ];
    expect(
      messageOf(run({ tickets, completion: { ...COMPLETION, volumeM3: 48 } }), 'volume_mismatch'),
    ).toBe('В талонах 40 м³ (2 из 2 не подтверждены), в закрытии 48 м³');
  });

  it('отклонённый талон не участвует ни в одной проверке', () => {
    const tickets = [
      ...twoTickets(),
      // «Это не талон»: шапка бланка или приписка с проходной, прочитанная как строка.
      ticket({ id: 't3', numberRaw: '30476', status: 'dismissed', volumeM3: 100 }),
    ];
    const result = run({ tickets });
    expect(result.checks).toEqual([]);
    expect(result.ticketsVolumeM3).toBe(40);
    expect(result.badge.pendingConfirmation).toBe(0);
  });
});

describe('дата талона против дня вывоза (Р19)', () => {
  it('жёсткая сверка идёт против введённого дня вывоза', () => {
    const result = run({ completion: { ...COMPLETION, removedOn: '2026-08-19' } });
    expect(codes(result)).toEqual(['date_mismatch', 'date_mismatch']);
    expect(result.checks[0]!.subjectKey).toBe('t1');
    expect(messageOf(result, 'date_mismatch')).toBe(
      'Дата талона 17.08.2026, дата вывоза 19.08.2026 — расхождение 2 дня',
    );
  });

  it('историческому закрытию дата не выдумывается', () => {
    // `removed_on` пуст, источник `unknown` — жёсткой сверки нет, план в допуске.
    expect(run({ completion: HISTORIC }).checks).toEqual([]);
  });

  it('без дня вывоза дата сверяется с плановой и мягко', () => {
    const tickets = [
      ticket({ id: 't1', issuedOn: '2026-08-19' }),
      ticket({ id: 't2', numberRaw: '30477', issuedOn: '2026-08-25' }),
    ];
    const result = run({ tickets, completion: HISTORIC });
    // Два дня от плана — календарь, восемь — повод посмотреть.
    expect(codes(result)).toEqual(['date_mismatch']);
    expect(result.checks[0]!.subjectKey).toBe('t2');
    expect(messageOf(result, 'date_mismatch')).toBe(
      'Дата вывоза в закрытии не указана; дата талона 25.08.2026 расходится с плановой 17.08.2026 на 8 дней',
    );
  });

  it('непрочитанная дата замечания не порождает', () => {
    const tickets = [
      ticket({ id: 't1', issuedOn: null }),
      ticket({ id: 't2', numberRaw: '30477' }),
    ];
    expect(run({ tickets, completion: { ...COMPLETION, removedOn: '2026-08-19' } }).checks).toEqual(
      [expect.objectContaining({ code: 'date_mismatch', subjectKey: 't2' })],
    );
  });
});

describe('адрес талона против объекта заявки (Р18)', () => {
  it('сокращение адреса замечания не даёт', () => {
    // «Волоколамское ш. 71/14» и «Волоколамское шоссе, 71к14» — один и тот же въезд.
    expect(run().checks).toEqual([]);
  });

  it('бумага с чужой площадки видна', () => {
    const tickets = [
      ticket({ id: 't1' }),
      ticket({ id: 't2', numberRaw: '30477', addressRaw: 'Садовническая, 76' }),
    ];
    const result = run({ tickets });
    expect(codes(result)).toEqual(['address_mismatch']);
    expect(result.checks[0]!.severity).toBe('warning');
    expect(messageOf(result, 'address_mismatch')).toBe(
      'Адрес талона «Садовническая, 76» не похож на объект заявки «Волоколамское шоссе, 71к14»',
    );
  });

  it('пустой адрес талона и объект без адреса сравнению не подлежат', () => {
    const tickets = [
      ticket({ id: 't1', addressRaw: '' }),
      ticket({ id: 't2', numberRaw: '30477' }),
    ];
    expect(run({ tickets }).checks).toEqual([]);
    expect(
      run({
        request: { ...REQUEST, objectAddress: '', objectName: '' },
        tickets: [ticket({ id: 't1', addressRaw: 'Садовническая, 76' })],
        completion: { ...COMPLETION, volumeM3: 20 },
      }).checks,
    ).toEqual([]);
  });

  it('площадку узнают и по названию объекта', () => {
    const tickets = [ticket({ id: 't1', addressRaw: 'Автозаводская, лот 33' })];
    const result = run({
      tickets,
      completion: { ...COMPLETION, volumeM3: 20 },
      request: { ...REQUEST, objectAddress: '', objectName: 'Автозаводская, лот 33' },
    });
    expect(result.checks).toEqual([]);
  });
});

describe('уникальность: бумага и номер (Р17)', () => {
  it('точный повтор скана виден по хэшу растра', () => {
    const tickets = [
      ticket({ id: 't1', pageId: 'page-1' }),
      // Тот же лист, приложенный вторым файлом: страница другая, растр тот же.
      ticket({ id: 't2', numberRaw: '30477', pageId: 'page-2' }),
    ];
    const result = run({ tickets });
    expect(codes(result)).toEqual(['duplicate_number']);
    expect(result.checks[0]!.subjectKey).toBe('t2');
    expect(messageOf(result, 'duplicate_number')).toBe('Тот же скан уже приложен к этой заявке');
  });

  it('два талона с одного кадра дублем не считаются', () => {
    // На трети снимков по два талона — требовать «один талон на кадр» бессмысленно.
    expect(run().checks).toEqual([]);
  });

  it('повтор номера в области оператора — расхождение', () => {
    const tickets = [
      ticket({ id: 't1' }),
      ticket({ id: 't2', pageId: 'page-2', pageSha256: OTHER_PAGE_SHA }),
    ];
    const result = run({ tickets });
    expect(codes(result)).toEqual(['duplicate_number']);
    expect(messageOf(result, 'duplicate_number')).toBe(
      'Номер 30476 уже предъявлен другим талоном этой заявки',
    );
  });

  it('клапан «это разные бумаги» снимает замечание о номере', () => {
    const tickets = [
      ticket({ id: 't1' }),
      ticket({
        id: 't2',
        pageId: 'page-2',
        pageSha256: OTHER_PAGE_SHA,
        duplicateOverride: true,
      }),
    ];
    expect(run({ tickets }).checks).toEqual([]);
  });

  it('похожий номер — предупреждение, а не запрет', () => {
    const tickets = [
      ticket({ id: 't1', numberRaw: '30476' }),
      // «ЗО476» рукой и «30476» типографски — поисковая нормализация их сводит (Р16).
      ticket({ id: 't2', numberRaw: 'ЗО476', pageId: 'page-2', pageSha256: OTHER_PAGE_SHA }),
    ];
    const result = run({ tickets });
    expect(codes(result)).toEqual(['similar_number']);
    expect(result.checks[0]!.severity).toBe('warning');
    expect(messageOf(result, 'similar_number')).toBe(
      'Похожий номер у того же перевозчика: ЗО476 и 30476',
    );
  });

  it('тот же номер у другого перевозчика — предупреждение', () => {
    const tickets = [
      ticket({ id: 't1' }),
      ticket({
        id: 't2',
        pageId: 'page-2',
        pageSha256: OTHER_PAGE_SHA,
        operatorCounterpartyId: OTHER_OPERATOR,
      }),
    ];
    const result = run({ tickets });
    expect(codes(result)).toEqual(['duplicate_number_other_operator']);
    expect(messageOf(result, 'duplicate_number_other_operator')).toBe(
      'Тот же номер 30476 стоит у талона другого перевозчика',
    );
  });

  it('сосед из чужой заявки называется только тому, кто вправе её читать (Р28)', () => {
    const named = run({
      neighbours: [
        { ticketId: 't1', kind: 'number', requestLabel: 'М-812 от 15.08.2026', number: '30476' },
      ],
    });
    expect(messageOf(named, 'duplicate_number')).toBe(
      'Номер 30476 уже предъявлен по заявке М-812 от 15.08.2026',
    );

    const hidden = run({
      neighbours: [{ ticketId: 't1', kind: 'number', requestLabel: null, number: '30476' }],
    });
    expect(messageOf(hidden, 'duplicate_number')).toBe(
      'Номер 30476 уже предъявлен по другой заявке',
    );
  });

  it('несколько поводов на один талон складываются в одно замечание', () => {
    // Ключ принятия — пара «проверка + предмет», и второй строкой это замечание стало бы
    // непринимаемым.
    const result = run({
      neighbours: [
        { ticketId: 't1', kind: 'page', requestLabel: 'М-812', number: '' },
        { ticketId: 't1', kind: 'number', requestLabel: 'М-812', number: '30476' },
      ],
    });
    expect(codes(result)).toEqual(['duplicate_number']);
    expect(messageOf(result, 'duplicate_number')).toBe(
      'Тот же скан уже предъявлен по заявке М-812; Номер 30476 уже предъявлен по заявке М-812',
    );
  });

  it('значок в списке считает расхождения и предупреждения раздельно (Р24)', () => {
    const tickets = [
      ticket({ id: 't1', status: 'unconfirmed' }),
      ticket({
        id: 't2',
        pageId: 'page-2',
        pageSha256: OTHER_PAGE_SHA,
        addressRaw: 'Садовническая, 76',
      }),
    ];
    const result = run({ tickets });
    // ⛔ повтор номера · ⚠️ чужой адрес · ⏳ один талон ждёт подтверждения.
    expect(result.badge).toEqual({ errors: 1, warnings: 1, pendingConfirmation: 1 });
  });
});

describe('отпечаток входа принятого расхождения (Р21)', () => {
  const inputs: WasteTicketCheckInputs = {
    request: REQUEST,
    completion: { ...COMPLETION, volumeM3: 48 },
    tickets: twoTickets(),
    tolerances: DEFAULT_WASTE_TICKET_TOLERANCES,
  };

  const fingerprint = (over: Partial<WasteTicketCheckInputs> = {}): string =>
    wasteTicketCheckFingerprint({
      ...inputs,
      ...over,
      checkCode: 'volume_mismatch',
      subjectKey: '',
    });

  const base = fingerprint();

  it('одинаковый вход даёт одинаковый отпечаток, а перестановка талонов его не двигает', () => {
    expect(fingerprint()).toBe(base);
    expect(fingerprint({ tickets: [...twoTickets()].reverse() })).toBe(base);
  });

  it('разные проверки и разные предметы — разные отпечатки', () => {
    expect(
      wasteTicketCheckFingerprint({ ...inputs, checkCode: 'date_mismatch', subjectKey: '' }),
    ).not.toBe(base);
    expect(
      wasteTicketCheckFingerprint({ ...inputs, checkCode: 'volume_mismatch', subjectKey: 't1' }),
    ).not.toBe(base);
  });

  // Каждая строка — величина из Р21: изменилась любая, и принятие перестаёт действовать само.
  it('правка фактического объёма роняет отпечаток', () => {
    expect(fingerprint({ completion: { ...COMPLETION, volumeM3: 50 } })).not.toBe(base);
  });

  it('правка дня вывоза роняет отпечаток', () => {
    expect(
      fingerprint({ completion: { ...COMPLETION, volumeM3: 48, removedOn: '2026-08-19' } }),
    ).not.toBe(base);
  });

  it('правка заявленного объёма роняет отпечаток', () => {
    expect(fingerprint({ request: { ...REQUEST, requestedVolumeM3: 60 } })).not.toBe(base);
  });

  it('правка плановой даты роняет отпечаток', () => {
    expect(
      fingerprint({ request: { ...REQUEST, deliveryAt: new Date('2026-08-18T09:00:00.000Z') } }),
    ).not.toBe(base);
  });

  it('смена области оператора роняет отпечаток', () => {
    expect(
      fingerprint({ request: { ...REQUEST, operatorCounterpartyId: OTHER_OPERATOR } }),
    ).not.toBe(base);
  });

  it('правка допуска роняет отпечаток', () => {
    expect(
      fingerprint({ tolerances: { ...DEFAULT_WASTE_TICKET_TOLERANCES, volumeM3: 0.5 } }),
    ).not.toBe(base);
    expect(
      fingerprint({ tolerances: { ...DEFAULT_WASTE_TICKET_TOLERANCES, volumeOverPlanRatio: 0.2 } }),
    ).not.toBe(base);
    expect(
      fingerprint({ tolerances: { ...DEFAULT_WASTE_TICKET_TOLERANCES, planDateDays: 5 } }),
    ).not.toBe(base);
  });

  it('правка состава подтверждённых талонов роняет отпечаток', () => {
    const [first, second] = twoTickets();
    expect(fingerprint({ tickets: [first!] })).not.toBe(base);
    expect(
      fingerprint({ tickets: [first!, second!, ticket({ id: 't3', numberRaw: '30478' })] }),
    ).not.toBe(base);
    expect(fingerprint({ tickets: [first!, { ...second!, volumeM3: 25 }] })).not.toBe(base);
    expect(fingerprint({ tickets: [first!, { ...second!, issuedOn: '2026-08-18' }] })).not.toBe(
      base,
    );
    expect(fingerprint({ tickets: [first!, { ...second!, numberKey: '30999' }] })).not.toBe(base);
  });

  it('вид работ и адрес талона тоже входят в отпечаток', () => {
    const [first, second] = twoTickets();
    // Перевод бумаги в простой меняет сумму — принятое расхождение по объёму обязано слететь.
    expect(fingerprint({ tickets: [first!, { ...second!, workKind: 'idle' }] })).not.toBe(base);
    // Исправленный адрес — вход четвёртой проверки.
    expect(
      fingerprint({ tickets: [first!, { ...second!, addressRaw: 'Садовническая, 76' }] }),
    ).not.toBe(base);
    expect(fingerprint({ request: { ...REQUEST, objectAddress: 'Садовническая, 76' } })).not.toBe(
      base,
    );
  });

  it('появившийся неподтверждённый талон роняет отпечаток', () => {
    // Принять расхождение можно только при нуле неразобранных (Р15), а новая бумага меняет и
    // сумму, и текст замечания.
    const [first, second] = twoTickets();
    expect(
      fingerprint({
        tickets: [first!, second!, ticket({ id: 't3', numberRaw: '30478', status: 'unconfirmed' })],
      }),
    ).not.toBe(base);
  });

  it('отклонённый талон в отпечатке не участвует', () => {
    const [first, second] = twoTickets();
    expect(
      fingerprint({
        tickets: [first!, second!, ticket({ id: 't3', numberRaw: '30478', status: 'dismissed' })],
      }),
    ).toBe(base);
  });

  // Золотое значение: смена алгоритма или версии обязана быть осознанной, а не случайной —
  // молча поехавший отпечаток снял бы все принятые расхождения разом.
  it('отпечаток закреплён золотым значением', () => {
    expect(base).toBe('3778b24f95724111602443c94b6bc527fb643d20048c0dd039cdd7b982e7e233');
  });
});

describe('принятое расхождение возвращается само (Р21)', () => {
  const inputs: WasteTicketCheckInputs = {
    request: REQUEST,
    completion: { ...COMPLETION, volumeM3: 48 },
    tickets: twoTickets(),
    tolerances: DEFAULT_WASTE_TICKET_TOLERANCES,
  };

  const accepted: StoredWasteTicketResolution = {
    checkCode: 'volume_mismatch',
    subjectKey: '',
    inputFingerprint: wasteTicketCheckFingerprint({
      ...inputs,
      checkCode: 'volume_mismatch',
      subjectKey: '',
    }),
    acceptedByName: 'Иванов И.',
    acceptedAt: '2026-08-19T11:00:00.000Z',
    comment: 'недогруз согласован с оператором',
  };

  it('пока вход тот же — замечание помечено принятым и в значок не идёт', () => {
    const result = wasteTicketChecks({ ...inputs, resolutions: [accepted] });
    expect(result.checks[0]!.resolution).toEqual({
      acceptedByName: 'Иванов И.',
      acceptedAt: '2026-08-19T11:00:00.000Z',
      comment: 'недогруз согласован с оператором',
    });
    expect(result.badge.errors).toBe(0);
  });

  it('поправили факт — принятие перестало действовать, замечание вернулось', () => {
    const result = wasteTicketChecks({
      ...inputs,
      completion: { ...COMPLETION, volumeM3: 50 },
      resolutions: [accepted],
    });
    // Недействующее принятие в ответе не появляется вовсе: серое «снято» про висящее расхождение
    // было бы прямой ложью.
    expect(result.checks[0]!.resolution).toBeNull();
    expect(result.badge.errors).toBe(1);
  });

  it('принятие чужой проверки на замечание не переносится', () => {
    const result = wasteTicketChecks({
      ...inputs,
      completion: { ...COMPLETION, volumeM3: 48, removedOn: '2026-08-19' },
      resolutions: [accepted],
    });
    expect(result.checks.find((c) => c.code === 'date_mismatch')?.resolution).toBeNull();
  });
});

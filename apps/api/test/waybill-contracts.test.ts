import { describe, expect, it } from 'vitest';
import {
  cancelWaybillSchema,
  canCancelWaybill,
  canPrintWaybill,
  DEFAULT_TYPE_WAYBILL_FORM,
  esm2Periods,
  esm2Required,
  esm2SyncPlan,
  esm2WeekDays,
  formatWaybillNumber,
  isPassengerTypeForm,
  printWaybillsBatchSchema,
  selectedWaybillsLabel,
  WAYBILL_PRINT_BATCH_LIMIT,
  TYPE_WAYBILL_FORM_CODES,
  typeWaybillFormCodeSchema,
  typeWaybillFormOf,
  WAYBILL_FORM_CODES,
  WAYBILL_STATUSES,
  waybillDisplayNumber,
  waybillFormLabels,
  waybillFormShortLabels,
  waybillRequirement,
  waybillStatusLabels,
  snapshotForPrint,
} from '@technic/contracts';

/**
 * Путевой лист — документ строгой отчётности (ADR 0037): его ищут и сверяют по номеру, поэтому
 * печатное представление номера обязано быть одним и тем же в журнале, на бланке и в разговоре.
 */

describe('номер путевого листа', () => {
  it('печатается с ведущими нулями до ширины серии', () => {
    expect(formatWaybillNumber(4897, 8)).toBe('00004897');
    expect(formatWaybillNumber(1, 8)).toBe('00000001');
  });

  it('номер длиннее ширины не обрезается: потерянная цифра — другой документ', () => {
    expect(formatWaybillNumber(123456789, 8)).toBe('123456789');
  });

  it('с серией читается так, как напечатан на бланке', () => {
    expect(waybillDisplayNumber('260604-646-', 4897, 8)).toBe('260604-646-00004897');
  });

  it('без серии остаётся один номер — префикс у новой серии пуст', () => {
    expect(waybillDisplayNumber('', 4897, 8)).toBe('00004897');
  });
});

describe('состояния и бланки', () => {
  it('черновика у листа нет: он рождается выданным', () => {
    expect(WAYBILL_STATUSES).toEqual(['issued', 'cancelled']);
  });

  it('у каждого состояния и бланка есть подпись — их читает человек', () => {
    expect(WAYBILL_STATUSES.filter((s) => !waybillStatusLabels[s])).toEqual([]);
    expect(WAYBILL_FORM_CODES.filter((f) => !waybillFormLabels[f])).toEqual([]);
  });

  it('бланки объявлены все три, хотя выписывается пока один', () => {
    expect(WAYBILL_FORM_CODES).toContain('4p');
    expect(WAYBILL_FORM_CODES).toContain('leg3');
    expect(WAYBILL_FORM_CODES).toContain('esm2');
  });
});

/**
 * Бланк типа ТС в справочнике (ADR 0065). Тип отвечает на вопрос «каким бланком», а не
 * «выписывается ли»: на второй отвечает принадлежность машины.
 */
describe('бланк, закреплённый за типом ТС', () => {
  it('типу закрепляют 4-П или форму № 3 — ЭСМ-2 портал выписывает сам по заявке', () => {
    expect(TYPE_WAYBILL_FORM_CODES).toEqual(['4p', 'leg3']);
    expect(typeWaybillFormCodeSchema.safeParse('esm2').success).toBe(false);
    expect(typeWaybillFormCodeSchema.safeParse('4p').success).toBe(true);
    expect(typeWaybillFormCodeSchema.safeParse('leg3').success).toBe(true);
  });

  it('умолчание — 4-П: у собственной техники лист есть всегда', () => {
    expect(DEFAULT_TYPE_WAYBILL_FORM).toBe('4p');
    expect(typeWaybillFormOf(false)).toBe('4p');
  });

  /*
   * Признак «легковой транспорт» и код формы — одно знание в двух видах: справочник спрашивает
   * человека про транспорт, а хранит бланк. Перевод обязан ходить в обе стороны без потерь,
   * иначе чекбокс откроется снятым у типа, который уже переведён на форму № 3.
   */
  it('«легковой транспорт» и код формы переводятся друг в друга без потерь', () => {
    expect(typeWaybillFormOf(true)).toBe('leg3');
    expect(isPassengerTypeForm('leg3')).toBe(true);
    expect(isPassengerTypeForm('4p')).toBe(false);
    for (const isPassenger of [true, false]) {
      expect(isPassengerTypeForm(typeWaybillFormOf(isPassenger))).toBe(isPassenger);
    }
  });

  it('ЭСМ-2 легковым признаком не является: у него свой путь выписки', () => {
    expect(isPassengerTypeForm('esm2')).toBe(false);
  });
});

/**
 * На какой рейс выписывается лист (ADR 0037 п. 1, ADR 0041).
 *
 * Ограничение идёт и по типу заявки, и по виду ТС — и это не тавтология: заявку на технику для
 * работы на объекте можно завести и на самосвал, у которого бланк за типом закреплён. Рейса,
 * маршрута и груза у такой заявки нет, а значит, нет и путевого листа.
 *
 * Разница между «не выписывается, потому что…» и «не выписывается вовсе» — не косметика: первое
 * форма показывает текстом (отсутствие блока читалось бы как поломка), второе не показывает
 * ничем, потому что упоминать нечего.
 */
describe('на какой рейс выписывается путевой лист', () => {
  const dumpTruck = { ownership: 'own', formCode: '4p', typeName: 'Самосвалы' } as const;

  it('грузоперевозка собственной машиной с бланком — выписывается', () => {
    expect(waybillRequirement({ requestType: 'freight_transport', ...dumpTruck })).toEqual({
      formCode: '4p',
      reason: null,
    });
  });

  it('заказ техники на объект — не выписывается и не объясняется: у заявки нет рейса', () => {
    expect(waybillRequirement({ requestType: 'special_equipment', ...dumpTruck })).toEqual({
      formCode: null,
      reason: null,
    });
  });

  it('заказ техники на объект не спасает даже машина с бланком: решает вид заявки', () => {
    const onSite = waybillRequirement({
      requestType: 'special_equipment',
      ownership: 'rental',
      formCode: '4p',
      typeName: 'Самосвалы',
    });
    // Ни «арендодатель выпишет», ни «бланка нет»: об аренде говорить нечего там, где документа
    // не существует в принципе.
    expect(onSite).toEqual({ formCode: null, reason: null });
  });

  it('аренда под грузоперевозку — причина текстом: лист выписывает арендодатель', () => {
    const rental = waybillRequirement({
      requestType: 'freight_transport',
      ownership: 'rental',
      formCode: '4p',
    });
    expect(rental.formCode).toBeNull();
    expect(rental.reason).toContain('арендодатель');
  });

  /**
   * Отказа «у типа не заведён бланк» больше нет (ADR 0065): у собственной техники лист есть
   * всегда, а тип отвечает только на вопрос, каким бланком. Прежнее пустое значение колонки
   * молча отключало документ у каждого типа, заведённого через справочник.
   */
  it('собственная техника получает бланк своего типа — отказать тут больше нечему', () => {
    for (const formCode of ['4p', 'leg3'] as const) {
      const own = waybillRequirement({
        requestType: 'freight_transport',
        ownership: 'own',
        formCode,
      });
      expect(own.formCode).toBe(formCode);
      expect(own.reason).toBeNull();
    }
  });
});

/**
 * Граница правки листа (ADR 0037 п. 9 в редакции ADR 0052): по день выезда включительно лист
 * аннулируют и выписывают заново, со следующего дня — нет. Лист выписывают с маршрута утром дня
 * выезда, и запрет в этот же день означал бы, что испорченный бланк не списать никогда, а рейс,
 * им замороженный, не пересобрать.
 */
describe('до какого дня лист можно аннулировать', () => {
  const trip = { issuedForDate: '2026-08-10' };

  it('накануне — можно', () => {
    expect(canCancelWaybill(trip, '2026-08-09')).toBe(true);
  });

  it('в день выезда — можно: лист выписан этим же утром', () => {
    expect(canCancelWaybill(trip, '2026-08-10')).toBe(true);
  });

  it('задним числом — нет: рейс состоялся', () => {
    expect(canCancelWaybill(trip, '2026-08-11')).toBe(false);
  });

  /**
   * У ЭСМ-2 граница другая — конец недели работ. Считать её по дате листа (это понедельник)
   * значило бы запретить правку со вторника: досрочное завершение, объявленное в среду, не смогло
   * бы переписать бланк, который всю эту неделю лежит у машиниста.
   */
  it('у недельного листа граница — последний день периода, а не дата составления', () => {
    const week = { issuedForDate: '2026-08-31', periodTo: '2026-09-06' };
    expect(canCancelWaybill(week, '2026-09-02')).toBe(true);
    expect(canCancelWaybill(week, '2026-09-06')).toBe(true);
    expect(canCancelWaybill(week, '2026-09-07')).toBe(false);
  });

  it('аннулирование без причины не принимается: в журнале должно быть видно, почему', () => {
    expect(cancelWaybillSchema.safeParse({ reason: '   ' }).success).toBe(false);
    expect(cancelWaybillSchema.safeParse({ reason: 'испорчен при печати' }).success).toBe(true);
  });
});

/**
 * ЭСМ-2 — лист на неделю работы строительной машины на площадке (миграция 0087).
 *
 * Единица бланка — календарная неделя: семь строк «пн…вс» и недельные итоги. Резать срок по
 * границе месяца не приходится, хотя графа «месяца» в бланке одна: у недели, перешедшей в
 * следующий месяц, туда печатаются оба номера («08–09») — ширины хватает.
 *
 * Даты в тестах — 2026 года: 04.08 вторник, 31.08 понедельник.
 */
describe('срок заявки, разрезанный на недельные листы', () => {
  it('однодневный срок — один лист на этот день', () => {
    expect(esm2Periods('2026-08-04', '2026-08-04')).toEqual([
      { from: '2026-08-04', to: '2026-08-04' },
    ]);
  });

  it('пустая дата окончания читается как однодневный срок', () => {
    expect(esm2Periods('2026-08-04', null)).toEqual([{ from: '2026-08-04', to: '2026-08-04' }]);
  });

  it('первый лист обрывается воскресеньем, а не седьмым днём срока', () => {
    // Срок со вторника: первая неделя листа — вт…вс, а не вт…пн следующей.
    expect(esm2Periods('2026-08-04', '2026-08-20')).toEqual([
      { from: '2026-08-04', to: '2026-08-09' },
      { from: '2026-08-10', to: '2026-08-16' },
      { from: '2026-08-17', to: '2026-08-20' },
    ]);
  });

  it('неделя через границу месяца остаётся одним листом', () => {
    const weeks = esm2Periods('2026-08-27', '2026-09-09');
    expect(weeks).toEqual([
      { from: '2026-08-27', to: '2026-08-30' },
      { from: '2026-08-31', to: '2026-09-06' },
      { from: '2026-09-07', to: '2026-09-09' },
    ]);
  });

  it('високосный февраль и переход года считаются календарём, а не арифметикой', () => {
    expect(esm2Periods('2028-02-28', '2028-03-01')).toEqual([
      { from: '2028-02-28', to: '2028-03-01' },
    ]);
    expect(esm2Periods('2026-12-28', '2027-01-05')).toEqual([
      { from: '2026-12-28', to: '2027-01-03' },
      { from: '2027-01-04', to: '2027-01-05' },
    ]);
  });

  it('конец раньше начала листов не даёт: такого срока не существует', () => {
    expect(esm2Periods('2026-08-10', '2026-08-04')).toEqual([]);
  });

  it('в листе семь дней недели целиком, но объект — только в дни срока', () => {
    const days = esm2WeekDays({ from: '2026-08-06', to: '2026-08-09' });
    expect(days.map((d) => d.date)).toEqual([
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
      '2026-08-07',
      '2026-08-08',
      '2026-08-09',
    ]);
    // Понедельник, вторник и среда вне срока: строки печатаются, графа объекта — пустой.
    expect(days.map((d) => d.inPeriod)).toEqual([false, false, false, true, true, true, true]);
  });
});

describe('кому выписывается ЭСМ-2', () => {
  const own = {
    requestType: 'special_equipment' as const,
    status: 'confirmed' as const,
    ownership: 'own' as const,
  };

  it('заказ техники на объект на своей машине — да', () => {
    expect(esm2Required(own)).toBe(true);
  });

  it('грузоперевозка — нет: у неё лист на рейс', () => {
    expect(esm2Required({ ...own, requestType: 'freight_transport' })).toBe(false);
  });

  it('арендная техника — нет: лист на неё выписывает арендодатель', () => {
    expect(esm2Required({ ...own, ownership: 'rental' })).toBe(false);
  });

  it('заявка вне работы — нет: листов у неё быть не должно', () => {
    expect(esm2Required({ ...own, status: 'new' })).toBe(false);
    expect(esm2Required({ ...own, status: 'cancelled' })).toBe(false);
    // Закрытая — да: работа состоялась, и бумага по ней остаётся выданной.
    expect(esm2Required({ ...own, status: 'done' })).toBe(true);
  });

  it('архивная — нет', () => {
    expect(esm2Required({ ...own, deletedAt: '2026-08-01T00:00:00Z' })).toBe(false);
  });
});

/**
 * Сверка бумаги с заявкой — сердце ведения ЭСМ-2 порталом. Выданный лист не правится никогда:
 * изменить содержание можно только аннулированием номера и выпиской нового. И столь же твёрдо
 * обратное: сошлось — не трогаем, иначе каждое сохранение заявки жгло бы бланки.
 */
describe('сверка недельных листов с заявкой', () => {
  const VEHICLE = 'vehicle-1';
  const DRIVER = 'driver-1';
  const sheet = (
    id: string,
    from: string,
    to: string,
    over: Partial<{ vehicleId: string; driverPersonId: string }> = {},
  ) => ({
    id,
    periodFrom: from,
    periodTo: to,
    vehicleId: VEHICLE,
    driverPersonId: DRIVER,
    ...over,
  });

  it('листов нет — выписываются все недели срока', () => {
    const plan = esm2SyncPlan({
      wanted: esm2Periods('2026-08-04', '2026-08-16'),
      existing: [],
      vehicleId: VEHICLE,
      driverPersonId: DRIVER,
      today: '2026-08-04',
    });
    expect(plan.cancel).toEqual([]);
    expect(plan.issue).toHaveLength(2);
  });

  it('всё сошлось — сверка молчит: ни один номер не сгорает', () => {
    const plan = esm2SyncPlan({
      wanted: esm2Periods('2026-08-04', '2026-08-16'),
      existing: [sheet('a', '2026-08-04', '2026-08-09'), sheet('b', '2026-08-10', '2026-08-16')],
      vehicleId: VEHICLE,
      driverPersonId: DRIVER,
      today: '2026-08-04',
    });
    expect(plan).toEqual({ cancel: [], issue: [] });
  });

  it('срок сокращён — лишние недели аннулируются, текущая выписывается заново', () => {
    // Досрочное завершение 12.08 при сроке до 16.08: неделя 10–16 становится 10–12.
    const plan = esm2SyncPlan({
      wanted: esm2Periods('2026-08-04', '2026-08-12'),
      existing: [
        sheet('a', '2026-08-04', '2026-08-09'),
        sheet('b', '2026-08-10', '2026-08-16'),
        sheet('c', '2026-08-17', '2026-08-23'),
      ],
      vehicleId: VEHICLE,
      driverPersonId: DRIVER,
      today: '2026-08-12',
    });
    // Первая неделя уже отработана — её не трогают; вторая переписывается, третьей не будет.
    expect(plan.cancel).toEqual(['b', 'c']);
    expect(plan.issue).toEqual([{ from: '2026-08-10', to: '2026-08-12' }]);
  });

  it('отработанная неделя не трогается и не выписывается заново', () => {
    // Лист недели 04–09 закрыт прошедшим временем: его нельзя ни аннулировать, ни продублировать.
    const plan = esm2SyncPlan({
      wanted: [{ from: '2026-08-05', to: '2026-08-09' }],
      existing: [sheet('a', '2026-08-04', '2026-08-09')],
      vehicleId: VEHICLE,
      driverPersonId: DRIVER,
      today: '2026-08-20',
    });
    expect(plan).toEqual({ cancel: [], issue: [] });
  });

  it('срок продлён — добавляются только новые недели', () => {
    const plan = esm2SyncPlan({
      wanted: esm2Periods('2026-08-04', '2026-08-16'),
      existing: [sheet('a', '2026-08-04', '2026-08-09')],
      vehicleId: VEHICLE,
      driverPersonId: DRIVER,
      today: '2026-08-04',
    });
    expect(plan.cancel).toEqual([]);
    expect(plan.issue).toEqual([{ from: '2026-08-10', to: '2026-08-16' }]);
  });

  it('сменилась машина — лист переписывается: в бланке напечатана другая', () => {
    const plan = esm2SyncPlan({
      wanted: esm2Periods('2026-08-04', '2026-08-09'),
      existing: [sheet('a', '2026-08-04', '2026-08-09')],
      vehicleId: 'vehicle-2',
      driverPersonId: DRIVER,
      today: '2026-08-04',
    });
    expect(plan.cancel).toEqual(['a']);
    expect(plan.issue).toEqual([{ from: '2026-08-04', to: '2026-08-09' }]);
  });

  it('сменился машинист — то же самое: правкой бланка это не решается', () => {
    const plan = esm2SyncPlan({
      wanted: esm2Periods('2026-08-04', '2026-08-09'),
      existing: [sheet('a', '2026-08-04', '2026-08-09', { driverPersonId: 'driver-2' })],
      vehicleId: VEHICLE,
      driverPersonId: DRIVER,
      today: '2026-08-04',
    });
    expect(plan.cancel).toEqual(['a']);
    expect(plan.issue).toHaveLength(1);
  });

  it('заявка ушла из работы — аннулируется всё неотработанное, и ничего не выписывается', () => {
    const plan = esm2SyncPlan({
      wanted: [],
      existing: [sheet('a', '2026-08-04', '2026-08-09'), sheet('b', '2026-08-10', '2026-08-16')],
      vehicleId: null,
      driverPersonId: null,
      today: '2026-08-04',
    });
    expect(plan.cancel).toEqual(['a', 'b']);
    expect(plan.issue).toEqual([]);
  });
});

describe('подписи форм в журнале', () => {
  it('у каждого бланка есть короткая подпись — полная в колонку не влезает', () => {
    for (const code of WAYBILL_FORM_CODES) {
      expect(waybillFormShortLabels[code].length).toBeLessThan(waybillFormLabels[code].length);
    }
  });
});

/**
 * Печать листа, выписанного до того, как графа «заказчик, телефон» стала печатать контакты рейса.
 * Бланк уже размечен новым ключом, а в снимке такого ключа нет — и повторная печать выдала бы
 * документ, отличный от того, что лежит у водителя.
 */
describe('снимок старого листа при печати', () => {
  it('графе контактов достаётся то, чем она была на момент выдачи', () => {
    const legacy = {
      customer_name: 'ЖК «Северный»',
      task2_customer: 'Склад №3',
      task_from: 'с. Укурей',
    };
    expect(snapshotForPrint(legacy)).toMatchObject({
      task_contacts: 'ЖК «Северный»',
      task2_contacts: 'Склад №3',
      task3_contacts: '',
      task4_contacts: '',
      // Прочие графы снимка печатаются как были: подмена касается одной графы.
      customer_name: 'ЖК «Северный»',
      task_from: 'с. Укурей',
    });
  });

  /*
   * Признак — отсутствие ключа, а не пустое значение: у нового листа пустые контакты значат «в
   * заявке их не было», и наименование заказчика в этой графе было бы выдумкой портала.
   */
  it('новый снимок не трогается — даже когда контактов в заявке не было', () => {
    const fresh = { customer_name: 'ЖК «Северный»', task_contacts: '', task2_customer: 'Склад №3' };
    expect(snapshotForPrint(fresh)).toBe(fresh);
  });
});

/**
 * Бумага у аннулированного листа.
 *
 * Прежде испорченный бланк печатали и выгружали наравне с выданным — его подшивают к журналу. Но
 * напечатанный аннулированный лист неотличим от действующего: те же реквизиты, тот же номер, — и
 * попав к водителю, он ездит документом, которого уже нет. Правило одно на портал и на сервер:
 * кнопка не должна обещать того, чем ручка ответит отказом.
 */
describe('печать и выгрузка по состоянию листа', () => {
  it('выданный печатается, аннулированный — нет', () => {
    expect(canPrintWaybill('issued')).toBe(true);
    expect(canPrintWaybill('cancelled')).toBe(false);
  });
});

/**
 * Пачка листов одним документом. Предел здесь не про сервер, а про бумагу: полсотни бланков A4 —
 * это уже пачка в лотке, и он же держит время сборки (каждый лист переводит в PDF LibreOffice).
 */
describe('печать пачкой', () => {
  const uuid = (n: number) => `1111111${n}-1111-4111-8111-111111111111`;

  it('пустой список не принимается: печатать нечего', () => {
    expect(printWaybillsBatchSchema.safeParse({ ids: [] }).success).toBe(false);
  });

  it('сверх предела не принимается', () => {
    const ids = Array.from({ length: WAYBILL_PRINT_BATCH_LIMIT + 1 }, () => uuid(1));
    expect(printWaybillsBatchSchema.safeParse({ ids }).success).toBe(false);
  });

  it('обычный выбор проходит', () => {
    expect(printWaybillsBatchSchema.safeParse({ ids: [uuid(1), uuid(2)] }).success).toBe(true);
  });

  /** Подпись виджета склоняет «лист» — её читают десятки раз на дню. */
  it('счётчик выбранного склоняется по-русски', () => {
    expect(selectedWaybillsLabel(1)).toBe('Выбрано 1 лист');
    expect(selectedWaybillsLabel(2)).toBe('Выбрано 2 листа');
    expect(selectedWaybillsLabel(5)).toBe('Выбрано 5 листов');
    expect(selectedWaybillsLabel(11)).toBe('Выбрано 11 листов');
    expect(selectedWaybillsLabel(21)).toBe('Выбрано 21 лист');
    expect(selectedWaybillsLabel(112)).toBe('Выбрано 112 листов');
  });
});

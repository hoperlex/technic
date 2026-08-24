import { describe, expect, it } from 'vitest';
import {
  backdateGuard,
  cancelWaybillSchema,
  canCancelWaybill,
  canCorrectWaybill,
  canPrintWaybill,
  correctionFloorDateKey,
  WAYBILL_CORRECTION_DAYS,
  DEFAULT_TYPE_WAYBILL_FORM,
  esm2Mode,
  esm2Periods,
  esm2RequestedPeriods,
  esm2SyncPlan,
  esm2WeekDays,
  formatNameWithInitials,
  formatWaybillDate,
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

/*
 * ЭСМ2-РАЗРЕЗ. Юнит-тест контрактов: базы у него нет, и обёртка двух режимов неприменима
 * технически. По смыслу тоже: он проверяет чистые функции разреза, а не выбор режима чтения.
 *
 * Что разойдётся на этапе 5: сигнатура и содержимое `issue` — сегодня это голые `Esm2Period`, а
 * станет план с `issueKey`, машиной и человеком. Фикстуры `canCancelWaybill`/`canCorrectWaybill`
 * замену переживут: правило «граница прошедшего — по `periodTo`» от длины листа не зависит.
 */

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

/**
 * Дата на бланке пишется по-русски: ISO-запись в графе «Дата» читается заводским штампом, а не днём
 * выезда. Вид один на оба бланка и на обе даты, что туда идут, — дату листа и выдачу удостоверения.
 */
describe('дата путевого листа', () => {
  it('печатается днём, месяцем и годом', () => {
    expect(formatWaybillDate('2026-08-23')).toBe('23.08.2026');
    expect(formatWaybillDate('2026-01-01')).toBe('01.01.2026');
  });

  it('пустая дата остаётся пустой: графу допишут от руки, а «..» портал не печатает', () => {
    expect(formatWaybillDate('')).toBe('');
  });

  it('не похожее на дату возвращается как есть — уже переложенную дату не трогаем дважды', () => {
    expect(formatWaybillDate('23.08.2026')).toBe('23.08.2026');
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
 * Единое правило заднего числа (ADR 0101, Р29). Один предикат на все входы — заведение рейса,
 * выписку листа, заведение и правку заявки, сверку ЭСМ-2, аннулирование, коррекцию и перенос, —
 * потому что граница, посчитанная в каждом входе по-своему, разъезжается: сегодня она отказывает
 * там, где соседняя ручка тем же телом отвечает согласием.
 *
 * Дни считаются от эффективной даты операции; какая дата эффективная, решает таблица §4 плана, и
 * этот файл её не проверяет — здесь только сама граница.
 */
describe('задним числом: право, глубина и причина', () => {
  const TODAY = '2026-08-12';
  /** Полномочный проситель: право есть, причина написана, предел не снят. */
  const dispatcher = { today: TODAY, allowed: true, unlimited: false, hasReason: true };

  it('сегодня и вперёд — обычная работа: ни права, ни причины', () => {
    expect(
      backdateGuard({ ...dispatcher, effectiveDate: TODAY, allowed: false, hasReason: false }),
    ).toEqual({ ok: true, backdated: false });
    expect(
      backdateGuard({
        ...dispatcher,
        effectiveDate: '2026-09-01',
        allowed: false,
        hasReason: false,
      }),
    ).toEqual({ ok: true, backdated: false });
  });

  it('вчера — уже задним числом: с правом и причиной проходит и помечается', () => {
    expect(backdateGuard({ ...dispatcher, effectiveDate: '2026-08-11' })).toEqual({
      ok: true,
      backdated: true,
    });
  });

  /**
   * `backdated` в успехе — не украшение: им вызывающий решает, заводить ли запись операции (Р16) и
   * писать ли причину в лист (Р35). Пометив сегодняшнюю выписку коррекцией, портал наполнил бы
   * фильтр журнала (Р28) обычной дневной работой.
   */
  it('признак коррекции ставится только прошлому', () => {
    const today = backdateGuard({ ...dispatcher, effectiveDate: TODAY });
    const past = backdateGuard({ ...dispatcher, effectiveDate: '2026-08-11' });
    expect(today.ok === true && today.backdated).toBe(false);
    expect(past.ok === true && past.backdated).toBe(true);
  });

  it('ровно 30 дней — ещё граница диспетчера, 31-й — уже нет', () => {
    const edge = correctionFloorDateKey(TODAY);
    expect(edge).toBe('2026-07-13');
    expect(backdateGuard({ ...dispatcher, effectiveDate: edge }).ok).toBe(true);
    const beyond = backdateGuard({ ...dispatcher, effectiveDate: '2026-07-12' });
    expect(beyond).toEqual({ ok: false, code: 'limit', reason: expect.any(String) });
  });

  it('второе право снимает предел, но не заменяет первое и не отменяет причину', () => {
    const old = { ...dispatcher, effectiveDate: '2026-01-15' };
    expect(backdateGuard({ ...old, unlimited: true }).ok).toBe(true);
    // Право глубины в одиночку не значит ничего: прошлое открывает `waybills.correct`.
    expect(backdateGuard({ ...old, unlimited: true, allowed: false })).toMatchObject({
      ok: false,
      code: 'permission',
    });
    expect(backdateGuard({ ...old, unlimited: true, hasReason: false })).toMatchObject({
      ok: false,
      code: 'reason',
    });
  });

  /**
   * Коды машинные: по ним маршрут выбирает статус ответа (`permission` → 403, остальные → 422).
   * Один код на все отказы сделал бы отказ нечитаемым — «нет права», «слишком давно» и «нет
   * причины» это три разных поручения человеку.
   */
  it('каждый отказ называет свою причину', () => {
    const past = { today: TODAY, effectiveDate: '2026-08-11' };
    expect(
      backdateGuard({ ...past, allowed: false, unlimited: false, hasReason: true }),
    ).toMatchObject({ ok: false, code: 'permission' });
    expect(
      backdateGuard({ ...past, allowed: true, unlimited: false, hasReason: false }),
    ).toMatchObject({ ok: false, code: 'reason' });
    expect(
      backdateGuard({
        ...past,
        effectiveDate: '2026-06-01',
        allowed: true,
        unlimited: false,
        hasReason: true,
      }),
    ).toMatchObject({ ok: false, code: 'limit' });
  });

  /**
   * Порядок проверок — это то, что человек прочитает первым. Сначала называется то, чего он не
   * исправит здесь и сейчас: без права не поможет ни причина, ни давность, а за пределом глубины
   * не поможет написанное объяснение. Причина спрашивается последней — её проситель добавляет сам.
   */
  it('порядок отказов: право, затем глубина, затем причина', () => {
    const hopeless = {
      today: TODAY,
      effectiveDate: '2026-01-15',
      allowed: false,
      unlimited: false,
      hasReason: false,
    };
    expect(backdateGuard(hopeless)).toMatchObject({ code: 'permission' });
    expect(backdateGuard({ ...hopeless, allowed: true })).toMatchObject({ code: 'limit' });
    expect(backdateGuard({ ...hopeless, allowed: true, unlimited: true })).toMatchObject({
      code: 'reason',
    });
  });

  it('у отказа есть текст: его читает человек, а не только маршрут', () => {
    const denial = backdateGuard({
      today: TODAY,
      effectiveDate: '2026-08-11',
      allowed: false,
      unlimited: false,
      hasReason: false,
    });
    expect(denial.ok === false && denial.reason.trim()).not.toBe('');
  });

  it('глубина — тридцать дней, и считается она одним выражением на весь портал', () => {
    expect(WAYBILL_CORRECTION_DAYS).toBe(30);
    expect(correctionFloorDateKey('2026-03-05')).toBe('2026-02-03');
  });
});

/**
 * Подлежит ли коррекции сам лист (ADR 0101). Право и причину спрашивает `backdateGuard`; здесь
 * только то, что от субъекта не зависит: состояние номера и глубина.
 */
describe('какой лист подлежит коррекции', () => {
  const TODAY = '2026-08-12';
  const trip = { issuedForDate: '2026-08-11', status: 'issued' as const };

  it('вчерашний выданный — да, сегодняшний и будущий — тоже', () => {
    expect(canCorrectWaybill(trip, TODAY)).toBe(true);
    expect(canCorrectWaybill({ ...trip, issuedForDate: '2026-08-20' }, TODAY)).toBe(true);
  });

  /**
   * Аннулированный номер уже списан, и заменять в нём нечего: правят тот лист, что выписан взамен.
   * Разрешив обратное, портал получил бы два листа, заменяющих один номер, — и уникальный индекс
   * отказал бы уже в транзакции, после сгоревшей работы (Р32).
   */
  it('аннулированный — нет: цепочку правят с последнего звена', () => {
    expect(canCorrectWaybill({ ...trip, status: 'cancelled' }, TODAY)).toBe(false);
  });

  it('старше тридцати дней — только с правом глубины', () => {
    const old = { ...trip, issuedForDate: '2026-07-01' };
    expect(canCorrectWaybill(old, TODAY)).toBe(false);
    expect(canCorrectWaybill(old, TODAY, { unlimited: true })).toBe(true);
    // Аннулированный не оживает и правом глубины: причина отказа у него другая.
    expect(canCorrectWaybill({ ...old, status: 'cancelled' }, TODAY, { unlimited: true })).toBe(
      false,
    );
  });

  /**
   * У ЭСМ-2 граница считается по концу недели — тем же концом, каким её считает `canCancelWaybill`.
   * Взяв понедельник, портал отказал бы за шесть дней до настоящей границы.
   */
  it('у недельного листа глубина считается от последнего дня периода', () => {
    const week = { issuedForDate: '2026-07-06', periodTo: '2026-07-12', status: 'issued' as const };
    expect(canCorrectWaybill(week, '2026-08-11')).toBe(true);
    expect(canCorrectWaybill(week, '2026-08-12')).toBe(false);
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

  it('в листе семь дней недели целиком, а срок отмечен признаком дня', () => {
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
    // Понедельник, вторник и среда вне срока. На бумагу признак больше не идёт — объект стоит
    // один раз в шапке графы, — но неделя обязана знать, какие её дни заявкой оплачены.
    expect(days.map((d) => d.inPeriod)).toEqual([false, false, false, true, true, true, true]);
  });
});

describe('кому выписывается ЭСМ-2', () => {
  const own = {
    requestType: 'special_equipment' as const,
    status: 'confirmed' as const,
    ownership: 'own' as const,
    isLinear: false,
  };

  it('заказ техники на объект на своей машине — портал ведёт листы сам', () => {
    expect(esm2Mode(own)).toBe('auto');
  });

  it('грузоперевозка — нет: у неё лист на рейс', () => {
    expect(esm2Mode({ ...own, requestType: 'freight_transport' })).toBe('none');
  });

  it('арендная техника — нет: лист на неё выписывает арендодатель', () => {
    expect(esm2Mode({ ...own, ownership: 'rental' })).toBe('none');
  });

  it('заявка вне работы — нет: листов у неё быть не должно', () => {
    expect(esm2Mode({ ...own, status: 'new' })).toBe('none');
    expect(esm2Mode({ ...own, status: 'cancelled' })).toBe('none');
    // Закрытая — да: работа состоялась, и бумага по ней остаётся выданной.
    expect(esm2Mode({ ...own, status: 'done' })).toBe('auto');
  });

  it('архивная — нет', () => {
    expect(esm2Mode({ ...own, deletedAt: '2026-08-01T00:00:00Z' })).toBe('none');
  });

  /**
   * Линейная техника (ADR 0100): недели стояния на площадке у неё нет — машина вечером
   * возвращается на базу, — и листы наперёд портал не выписывает.
   */
  it('линейный заказ — по требованию: недели называет человек, а не срок заявки', () => {
    expect(esm2Mode({ ...own, isLinear: true })).toBe('on_demand');
    // Закрытая линейная — тоже `on_demand`: выписанное сверка ведёт до конца жизни заявки.
    expect(esm2Mode({ ...own, isLinear: true, status: 'done' })).toBe('on_demand');
  });

  it('линейность спрашивается последней: аренде и отмене она ничего не меняет', () => {
    // «Линейная арендная техника ничего не меняет» (ADR 0100): ЭСМ-2 на аренду не выписывался и
    // раньше, и признак типа не может этого включить.
    expect(esm2Mode({ ...own, isLinear: true, ownership: 'rental' })).toBe('none');
    expect(esm2Mode({ ...own, isLinear: true, status: 'cancelled' })).toBe('none');
    expect(esm2Mode({ ...own, isLinear: true, requestType: 'freight_transport' })).toBe('none');
  });
});

/**
 * Что человек уже попросил (ADR 0100 §5) — набор недель для режима `on_demand`. В `auto` его
 * задаёт срок заявки, а у линейного заказа портал таких решений не принимает: единственный след
 * просьбы — сами выписанные листы, подрезанные сроком.
 */
describe('недели, выписанные по требованию, подрезанные сроком', () => {
  const sheet = (from: string, to: string) => ({
    id: `w-${from}`,
    periodFrom: from,
    periodTo: to,
    vehicleId: 'vehicle-1',
    driverPersonId: 'driver-1',
  });

  it('листов нет — просить нечего: пустой набор', () => {
    expect(esm2RequestedPeriods([], '2026-08-04', '2026-08-16')).toEqual([]);
  });

  it('лист внутри срока возвращается как есть — сверке нечего переоформлять', () => {
    expect(
      esm2RequestedPeriods([sheet('2026-08-10', '2026-08-16')], '2026-08-04', '2026-08-20'),
    ).toEqual([{ from: '2026-08-10', to: '2026-08-16' }]);
  });

  it('срок сокращён — крайняя неделя подрезана, а выпавшая не возвращается вовсе', () => {
    const weeks = esm2RequestedPeriods(
      [
        sheet('2026-08-04', '2026-08-09'),
        sheet('2026-08-10', '2026-08-16'),
        sheet('2026-08-17', '2026-08-23'),
      ],
      '2026-08-04',
      '2026-08-12',
    );
    // Неделя 17–23 ушла за новый срок: её лист аннулируется, а замены не выписывается.
    expect(weeks).toEqual([
      { from: '2026-08-04', to: '2026-08-09' },
      { from: '2026-08-10', to: '2026-08-12' },
    ]);
  });

  it('начало срока сдвинуто вперёд — подрезается и левый край', () => {
    expect(
      esm2RequestedPeriods([sheet('2026-08-03', '2026-08-09')], '2026-08-06', '2026-08-09'),
    ).toEqual([{ from: '2026-08-06', to: '2026-08-09' }]);
  });

  it('продление срока недели не раздвигает: человек просил ровно эти дни', () => {
    expect(
      esm2RequestedPeriods([sheet('2026-08-10', '2026-08-12')], '2026-08-10', '2026-08-31'),
    ).toEqual([{ from: '2026-08-10', to: '2026-08-12' }]);
  });

  it('одну неделю двумя машинами подрезка не задваивает', () => {
    const week = [
      { ...sheet('2026-08-10', '2026-08-16'), id: 'a', vehicleId: 'vehicle-1' },
      { ...sheet('2026-08-10', '2026-08-16'), id: 'b', vehicleId: 'vehicle-2' },
    ];
    expect(esm2RequestedPeriods(week, '2026-08-10', '2026-08-16')).toEqual([
      { from: '2026-08-10', to: '2026-08-16' },
    ]);
  });

  it('пустая дата окончания читается как однодневный срок — тем же правилом, что и в `auto`', () => {
    expect(esm2RequestedPeriods([sheet('2026-08-10', '2026-08-16')], '2026-08-10', null)).toEqual([
      { from: '2026-08-10', to: '2026-08-10' },
    ]);
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
      mode: 'auto',
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
      mode: 'auto',
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
      mode: 'auto',
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
      mode: 'auto',
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
      mode: 'auto',
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
      mode: 'auto',
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
      mode: 'auto',
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
      // Ушедшая из работы заявка — это `none` (`esm2Mode`): листов у неё быть не должно вовсе.
      mode: 'none',
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

/**
 * Сверка линейного заказа (ADR 0100 §5). Это не «сверка выключена»: выданный бланк строгой
 * отчётности не вправе разойтись с заявкой, и сменённая машина по-прежнему жжёт номер. Разница
 * ровно одна — набор нужных недель берётся из того, что человек уже попросил, а не из срока.
 */
describe('сверка недельных листов линейного заказа', () => {
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

  it('листов нет — ни один не выписывается, хотя срок идёт', () => {
    const plan = esm2SyncPlan({
      mode: 'on_demand',
      // Даже если вызывающий посчитает недели сроком, режим их не пустит: это и есть его смысл.
      wanted: esm2Periods('2026-08-04', '2026-08-16'),
      existing: [],
      vehicleId: VEHICLE,
      driverPersonId: DRIVER,
      today: '2026-08-04',
    });
    expect(plan).toEqual({ cancel: [], issue: [] });
  });

  it('выписанная неделя внутри срока не трогается: сошлось — не жжём', () => {
    const existing = [sheet('a', '2026-08-10', '2026-08-16')];
    const plan = esm2SyncPlan({
      mode: 'on_demand',
      wanted: esm2RequestedPeriods(existing, '2026-08-04', '2026-08-31'),
      existing,
      vehicleId: VEHICLE,
      driverPersonId: null,
      today: '2026-08-04',
    });
    expect(plan).toEqual({ cancel: [], issue: [] });
  });

  /**
   * Машина у линейного заказа сверяется по той же границе, что и машинист (ADR 0100 §7): в бланке
   * стоит та единица, которую человек назвал при выписке, а «машина заявки» отвечает на другой
   * вопрос — какой техникой заказ взяли в работу. Сожги сверка этот номер, и недельный отчёт
   * второй машины оказался бы перепечатан на первую вместе с её моточасами.
   */
  it('сменилась машина заявки — выписанный лист не трогается', () => {
    const existing = [sheet('a', '2026-08-10', '2026-08-16')];
    const plan = esm2SyncPlan({
      mode: 'on_demand',
      wanted: esm2RequestedPeriods(existing, '2026-08-04', '2026-08-31'),
      existing,
      vehicleId: 'vehicle-2',
      driverPersonId: null,
      today: '2026-08-04',
    });
    expect(plan).toEqual({ cancel: [], issue: [] });
  });

  it('две машины в одной неделе — законная пара листов, а не расхождение', () => {
    const existing = [
      sheet('a', '2026-08-10', '2026-08-16'),
      sheet('b', '2026-08-10', '2026-08-16', { vehicleId: 'vehicle-2' }),
    ];
    const plan = esm2SyncPlan({
      mode: 'on_demand',
      wanted: esm2RequestedPeriods(existing, '2026-08-10', '2026-08-31'),
      existing,
      vehicleId: VEHICLE,
      driverPersonId: null,
      today: '2026-08-10',
    });
    expect(plan).toEqual({ cancel: [], issue: [] });
  });

  /** В `auto` правило прежнее: машина у заявки одна, и разошедшийся с ней лист переписывается. */
  it('обычный заказ: сменилась машина — лист переоформляется', () => {
    const existing = [sheet('a', '2026-08-10', '2026-08-16')];
    const plan = esm2SyncPlan({
      mode: 'auto',
      wanted: esm2Periods('2026-08-10', '2026-08-16'),
      existing,
      vehicleId: 'vehicle-2',
      driverPersonId: DRIVER,
      today: '2026-08-04',
    });
    expect(plan.cancel).toEqual(['a']);
    expect(plan.issue).toEqual([{ from: '2026-08-10', to: '2026-08-16' }]);
  });

  /**
   * У линейного заказа машинист свой на каждую неделю (ADR 0100 §6): человек называет его при
   * каждой выписке. Сверка, которую позвали не ради человека, обязана оставить недели как есть —
   * иначе смена срока пересадила бы всю бумагу на того, кто отработал одну неделю (ADR 0083).
   */
  it('разные машинисты по неделям — не расхождение, пока человека не назвали', () => {
    const existing = [
      sheet('a', '2026-08-10', '2026-08-16'),
      sheet('b', '2026-08-17', '2026-08-23', { driverPersonId: 'driver-2' }),
    ];
    const plan = esm2SyncPlan({
      mode: 'on_demand',
      wanted: esm2RequestedPeriods(existing, '2026-08-10', '2026-08-31'),
      existing,
      vehicleId: VEHICLE,
      driverPersonId: null,
      today: '2026-08-10',
    });
    expect(plan).toEqual({ cancel: [], issue: [] });
  });

  it('машиниста назвали этим же действием — расходящиеся листы переписываются', () => {
    const existing = [
      sheet('a', '2026-08-10', '2026-08-16'),
      sheet('b', '2026-08-17', '2026-08-23', { driverPersonId: 'driver-2' }),
    ];
    const plan = esm2SyncPlan({
      mode: 'on_demand',
      wanted: esm2RequestedPeriods(existing, '2026-08-10', '2026-08-31'),
      existing,
      vehicleId: VEHICLE,
      driverPersonId: 'driver-2',
      today: '2026-08-10',
    });
    expect(plan.cancel).toEqual(['a']);
    expect(plan.issue).toEqual([{ from: '2026-08-10', to: '2026-08-16' }]);
  });

  it('срок сокращён — крайняя неделя подрезается, выпавшая аннулируется без замены', () => {
    const existing = [
      sheet('a', '2026-08-10', '2026-08-16'),
      sheet('b', '2026-08-17', '2026-08-23'),
    ];
    const plan = esm2SyncPlan({
      mode: 'on_demand',
      wanted: esm2RequestedPeriods(existing, '2026-08-10', '2026-08-12'),
      existing,
      vehicleId: VEHICLE,
      driverPersonId: null,
      today: '2026-08-10',
    });
    expect(plan.cancel).toEqual(['a', 'b']);
    expect(plan.issue).toEqual([{ from: '2026-08-10', to: '2026-08-12' }]);
  });

  it('продлённый срок новых недель не приносит: их никто не просил', () => {
    const existing = [sheet('a', '2026-08-10', '2026-08-16')];
    const plan = esm2SyncPlan({
      mode: 'on_demand',
      wanted: esm2RequestedPeriods(existing, '2026-08-10', '2026-08-31'),
      existing,
      vehicleId: VEHICLE,
      driverPersonId: null,
      today: '2026-08-10',
    });
    expect(plan.issue).toEqual([]);
  });

  it('отработанная неделя не трогается и здесь: бланк уже заполнен заказчиком', () => {
    const existing = [sheet('a', '2026-08-10', '2026-08-16')];
    const plan = esm2SyncPlan({
      mode: 'on_demand',
      wanted: esm2RequestedPeriods(existing, '2026-08-10', '2026-08-12'),
      existing,
      vehicleId: 'vehicle-2',
      driverPersonId: null,
      today: '2026-08-20',
    });
    expect(plan).toEqual({ cancel: [], issue: [] });
  });

  it('заявка ушла из работы — линейная бумага аннулируется наравне с обычной', () => {
    const plan = esm2SyncPlan({
      // Ушедшая из работы заявка — `none` при любом признаке типа (`esm2Mode`).
      mode: 'none',
      wanted: [],
      existing: [sheet('a', '2026-08-10', '2026-08-16')],
      vehicleId: null,
      driverPersonId: null,
      today: '2026-08-10',
    });
    expect(plan.cancel).toEqual(['a']);
    expect(plan.issue).toEqual([]);
  });
});

/**
 * Сверка ЭСМ-2 под коррекцией (ADR 0101, Р11 и Р21). Два ключа и два разных запрета:
 * `unlockWaybillIds` открывает **выписанный** лист отработанной недели, `correction` разрешает
 * выписать прошедшую неделю, листа не имевшую. Оба приходят от сервера, уже спросившего право и
 * причину: тело запроса авторизацией не является.
 */
describe('сверка недельных листов при коррекции', () => {
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

  /**
   * Дыра 3 из §1 плана: неделя, добавленная сдвигом `dateFrom` назад, листа не имела — и потому в
   * `locked` не попадала вовсе. Сверка выписывала её сама: без права, без причины и без следа.
   */
  it('прошедшая неделя без контекста операции не выписывается', () => {
    const plan = esm2SyncPlan({
      mode: 'auto',
      wanted: esm2Periods('2026-08-03', '2026-08-09'),
      existing: [],
      vehicleId: VEHICLE,
      driverPersonId: DRIVER,
      today: '2026-08-12',
    });
    expect(plan).toEqual({ cancel: [], issue: [] });
  });

  it('с проверенным контекстом — выписывается: за неё спросили право и причину', () => {
    const plan = esm2SyncPlan({
      mode: 'auto',
      wanted: esm2Periods('2026-08-03', '2026-08-09'),
      existing: [],
      vehicleId: VEHICLE,
      driverPersonId: DRIVER,
      today: '2026-08-12',
      correction: { allowed: true },
    });
    expect(plan.issue).toEqual([{ from: '2026-08-03', to: '2026-08-09' }]);
  });

  /** Граница считается по концу недели — тем же концом, что и у `canCancelWaybill`. */
  it('неделя, кончающаяся сегодня, выписывается и без контекста', () => {
    const plan = esm2SyncPlan({
      mode: 'auto',
      wanted: [{ from: '2026-08-10', to: '2026-08-12' }],
      existing: [],
      vehicleId: VEHICLE,
      driverPersonId: DRIVER,
      today: '2026-08-12',
    });
    expect(plan.issue).toEqual([{ from: '2026-08-10', to: '2026-08-12' }]);
  });

  it('названный лист отработанной недели переоформляется, неназванный — нет', () => {
    const existing = [sheet('a', '2026-08-03', '2026-08-09')];
    const untouched = esm2SyncPlan({
      mode: 'auto',
      wanted: esm2Periods('2026-08-03', '2026-08-09'),
      existing,
      vehicleId: 'vehicle-2',
      driverPersonId: DRIVER,
      today: '2026-08-12',
      correction: { allowed: true },
    });
    // Без разблокировки прошедшая неделя остаётся при своём листе, даже когда машина разошлась:
    // машина эти дни отстояла, а заказчик заполнил оборот.
    expect(untouched).toEqual({ cancel: [], issue: [] });

    const corrected = esm2SyncPlan({
      mode: 'auto',
      wanted: esm2Periods('2026-08-03', '2026-08-09'),
      existing,
      vehicleId: 'vehicle-2',
      driverPersonId: DRIVER,
      today: '2026-08-12',
      unlockWaybillIds: ['a'],
      correction: { allowed: true },
    });
    expect(corrected.cancel).toEqual(['a']);
    expect(corrected.issue).toEqual([{ from: '2026-08-03', to: '2026-08-09' }]);
  });

  /**
   * Р11: в одной неделе у заявки законно живут листы двух машин (ADR 0100 п. 7). Понедельник как
   * ключ разблокировки сжёг бы оба; идентификатор трогает ровно тот, о котором просили.
   */
  it('две машины в одной неделе — правится только названный лист', () => {
    const existing = [
      sheet('a', '2026-08-03', '2026-08-09'),
      sheet('b', '2026-08-03', '2026-08-09', { vehicleId: 'vehicle-2' }),
    ];
    const plan = esm2SyncPlan({
      mode: 'on_demand',
      wanted: esm2RequestedPeriods(existing, '2026-08-03', '2026-08-09'),
      existing,
      vehicleId: VEHICLE,
      driverPersonId: 'driver-2',
      today: '2026-08-12',
      unlockWaybillIds: ['a'],
      correction: { allowed: true },
    });
    expect(plan.cancel).toEqual(['a']);
  });

  it('разблокировка без контекста операции замену не выписывает: сгоревший номер без бумаги', () => {
    // Крайний случай, ради которого оба ключа и передаются вместе: разблокировав лист, но не
    // разрешив прошедшую неделю, вызывающий получил бы аннулирование без перевыписки.
    const plan = esm2SyncPlan({
      mode: 'auto',
      wanted: esm2Periods('2026-08-03', '2026-08-09'),
      existing: [sheet('a', '2026-08-03', '2026-08-09')],
      vehicleId: 'vehicle-2',
      driverPersonId: DRIVER,
      today: '2026-08-12',
      unlockWaybillIds: ['a'],
    });
    expect(plan.cancel).toEqual(['a']);
    expect(plan.issue).toEqual([]);
  });

  it('без обоих ключей сверка ведёт себя ровно как прежде', () => {
    const existing = [sheet('a', '2026-08-10', '2026-08-16')];
    const plain = esm2SyncPlan({
      mode: 'auto',
      wanted: esm2Periods('2026-08-10', '2026-08-16'),
      existing,
      vehicleId: 'vehicle-2',
      driverPersonId: DRIVER,
      today: '2026-08-12',
    });
    expect(plain.cancel).toEqual(['a']);
    expect(plain.issue).toEqual([{ from: '2026-08-10', to: '2026-08-16' }]);
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
 * Печать листа, выписанного до того, как бланк размечали нынешними ключами. Файл шаблона читается с
 * диска на каждый запрос, а снимок берётся из `waybills.data`: размеченная после выдачи графа ищет
 * ключ, которого в снимке нет, и вышла бы из принтера пустой — то есть повторная печать выдала бы
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
    const fresh = {
      customer_name: 'Генеральный подрядчик',
      task_contacts: '',
      task2_customer: 'Склад №3',
      object_line: '',
      // Снимок нового листа несёт все ключи разом — в том числе расшифровку подписи: её пустота
      // тоже значит «данных не было», и достраивать её из полного ФИО нельзя.
      driver_short_name: '',
    };
    expect(snapshotForPrint(fresh)).toBe(fresh);
  });

  /*
   * Лист ЭСМ-2, выписанный до того, как объект переехал из семи дневных граф в шапку графы работ. В
   * старом снимке он лежит там, где стояла графа «Заказчик»: дневные графы нового бланка не
   * размечены, и без запасного хода объект исчез бы с бумаги вовсе.
   */
  it('старому недельному листу объект собирается из графы «Заказчик»', () => {
    const legacy = {
      customer_name: 'ЖК «Северный»',
      customer_address: 'г. Мытищи, ул. Стройка, 1',
      customer_phone: '+7 (900) 000 00 00',
      task_contacts: '',
      waybill_date: '2026-08-23',
      driver_license_issued_on: '2019-04-01',
    };
    const printed = snapshotForPrint(legacy);
    expect(printed.object_line).toBe('ЖК «Северный», г. Мытищи, ул. Стройка, 1');
    // Графа «Заказчик» печатается как выдана — объект напечатается дважды, и это принято
    // сознательно: повтор лучше потери.
    expect(printed.customer_name).toBe('ЖК «Северный»');
    expect(printed.customer_phone).toBe('+7 (900) 000 00 00');
    // Даты не перекладываются: выданный лист печатается как выдан (ADR 0037 п. 10), и старый
    // бланк выходит из принтера с ISO-датой, которая в нём напечатана.
    expect(printed.waybill_date).toBe('2026-08-23');
    expect(printed.driver_license_issued_on).toBe('2019-04-01');
  });

  it('у объекта без адреса запятой не остаётся: склейку делает сервер, а не бланк', () => {
    expect(snapshotForPrint({ customer_name: 'ЖК «Северный»' }).object_line).toBe('ЖК «Северный»');
    expect(snapshotForPrint({ task_contacts: '' }).object_line).toBe('');
  });

  it('пустой объект нового листа не подменяется заказчиком портала', () => {
    const fresh = {
      customer_name: 'Генеральный подрядчик',
      customer_address: 'г. Москва, ул. Полковая',
      task_contacts: '',
      object_line: '',
    };
    expect(snapshotForPrint(fresh).object_line).toBe('');
  });

  /*
   * Расшифровка подписи водителя у листа, выданного до того, как её стали печатать. Полное ФИО в
   * снимке есть всегда — иначе та же кнопка печатала бы на старом листе меньше, чем на соседнем.
   */
  it('старому листу расшифровка собирается из полного ФИО снимка', () => {
    const legacy = { driver_fio: 'Дегтярь Игорь Васильевич', task_contacts: '', object_line: '' };
    expect(snapshotForPrint(legacy).driver_short_name).toBe('Дегтярь И.В.');
  });

  it('пустая расшифровка нового листа остаётся пустой', () => {
    const fresh = {
      driver_fio: 'Дегтярь Игорь Васильевич',
      driver_short_name: '',
      task_contacts: '',
      object_line: '',
    };
    expect(snapshotForPrint(fresh).driver_short_name).toBe('');
  });
});

/**
 * Имя в графах бланка: расшифровка подписи водителя и контакт задания печатаются одним видом —
 * «Фамилия И.О.». Правило одно на оба места (`formatNameWithInitials`), потому что двух написаний
 * одной графы на бумаге быть не должно.
 */
describe('имя водителя видом бланка', () => {
  it('запись из трёх слов сокращается до фамилии с инициалами', () => {
    expect(formatNameWithInitials('Дегтярь Игорь Васильевич')).toBe('Дегтярь И.В.');
    expect(formatNameWithInitials('  Шералиев   Масрур Илхомович ')).toBe('Шералиев М.И.');
  });

  it('всё, что не три слова, печатается как есть: разбирать портал не берётся', () => {
    // Без отчества, с должностью рядом с фамилией, уже сокращённое — трогать нечего.
    expect(formatNameWithInitials('Иванов Иван')).toBe('Иванов Иван');
    expect(formatNameWithInitials('прораб Иванов Иван Иванович')).toBe(
      'прораб Иванов Иван Иванович',
    );
    expect(formatNameWithInitials('Иванов И.И.')).toBe('Иванов И.И.');
    expect(formatNameWithInitials('')).toBe('');
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

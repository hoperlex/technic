import { describe, expect, it } from 'vitest';
import {
  type WaybillFormCode,
  type WaybillIssueSource,
  type WaybillTrailerSource,
  type WaybillWarning,
  waybillIssueWarnings,
  canonicalWarningPayload,
} from '@technic/contracts';

/**
 * Предупреждения о прицепе при выписке (план `docs/vehicle-trailers-plan.md`, §14.5, Р22).
 *
 * Правило чистое, и здесь проверяется оно целиком: что считается дефектом бумаги, чего считать не
 * надо и как набор отзывается на перемены отпечатком. Того, чего чистая функция не видит — что
 * ключи сравнения действительно посчитал Postgres, — здесь нет намеренно: это проверяет
 * db-тест (`waybill-trailer-warnings.db.test.ts`), и подменить его юнитом нельзя. Функция
 * получает ключи готовыми и о том, кто их посчитал, не знает ничего.
 *
 * Последний рубеж перед бумагой (§14.1): форма чинит подстановку, пока окно открыто, а рейс,
 * собранный до закрепления, и заявка, положенная в готовый рейс, проходят мимо неё — и говорит о
 * них только выписка.
 */

const ROUTE_ID = 'route-1';

/** Источник без задания и водителя: здесь проверяется прицеп, а не строки. */
const sourceOf = (
  trailer: WaybillTrailerSource,
  formCode: WaybillFormCode | null = '4p',
): WaybillIssueSource => ({
  routeId: ROUTE_ID,
  routeNumber: 'Р-12',
  formCode,
  driver: null,
  points: [],
  trailer,
});

const slot = (n: 1 | 2, model: string, reg: string, regKey = reg.toUpperCase()) => ({
  slot: n,
  model,
  registrationNumber: reg,
  regKey: reg.trim() === '' ? '' : regKey,
});

const KRONE = {
  trailerId: 'tr-krone',
  model: 'КРОНА SDP27',
  registrationNumber: 'ЕН806277',
  regKey: 'EH806277',
};
const SCHMITZ = {
  trailerId: 'tr-schmitz',
  model: 'ШМИТЦ SPR-24',
  registrationNumber: 'ВХ933277',
  regKey: 'BX933277',
};

/** Коды набора без «пустого задания»: его в этих сценариях выдаёт каждый вызов (строк нет). */
const codesOf = (warnings: WaybillWarning[]): string[] =>
  warnings.map((w) => w.facts.code).filter((code) => code !== 'blank_task');

/** Предупреждения о прицепе — без «пустого задания», которое здесь только шум. */
const trailerOnly = (warnings: WaybillWarning[]): WaybillWarning[] =>
  warnings.filter((w) => w.facts.code !== 'blank_task');

const warn = (trailer: WaybillTrailerSource, formCode: WaybillFormCode | null = '4p') =>
  waybillIssueWarnings(sourceOf(trailer, formCode));

describe('бланк решает, спрашивать ли о прицепе', () => {
  const blank: WaybillTrailerSource = {
    withTrailer: true,
    slots: [slot(1, '', ''), slot(2, '', '')],
    hitched: [KRONE],
  };

  it('4-П говорит: у него графы прицепа есть', () => {
    expect(codesOf(warn(blank))).toEqual(['hitched_trailer_missing']);
  });

  it('форма № 3 молчит: граф прицепа у неё нет вовсе (ADR 0071)', () => {
    expect(codesOf(warn(blank, 'leg3'))).toEqual([]);
  });

  it('ЭСМ-2 молчит по той же причине', () => {
    expect(codesOf(warn(blank, 'esm2'))).toEqual([]);
  });

  it('источник без прицепа молчит: не передали — нечего и считать', () => {
    expect(codesOf(waybillIssueWarnings({ ...sourceOf(blank), trailer: undefined }))).toEqual([]);
  });
});

describe('пустые графы', () => {
  it('галочка стоит, графы пусты, закрепления нет — говорится о бланке', () => {
    const warnings = warn({
      withTrailer: true,
      slots: [slot(1, '', ''), slot(2, '', '')],
      hitched: [],
    });
    expect(codesOf(warnings)).toEqual(['trailer_graphs_blank']);
    expect(trailerOnly(warnings)[0]!.message).toContain('напечатаются пустыми');
  });

  it('при живом закреплении «пустые графы» подавляются: о них сказано конкретнее', () => {
    // Одно предупреждение на одну новость (§14.5): «закреплён КРОНА, а в графах его нет» говорит
    // то же самое и точнее, а три строки об одном рейсе человек читать не станет.
    const warnings = warn({
      withTrailer: true,
      slots: [slot(1, '', ''), slot(2, '', '')],
      hitched: [KRONE, SCHMITZ],
    });
    expect(codesOf(warnings)).toEqual(['hitched_trailer_missing', 'hitched_trailer_missing']);
    expect(warnings.map((w) => w.message).join(' ')).toContain('КРОНА SDP27 ЕН806277');
  });

  it('рейс без прицепа о графах не спрашивают: он описан определённо', () => {
    expect(
      codesOf(warn({ withTrailer: false, slots: [slot(1, '', ''), slot(2, '', '')], hitched: [] })),
    ).toEqual([]);
  });

  it('а про закрепление говорится и без галочки', () => {
    // Ровно так выглядел случай с прода: заявку положили в готовый рейс, галочка осталась снятой,
    // и лист уехал без прицепа молча.
    expect(
      codesOf(
        warn({ withTrailer: false, slots: [slot(1, '', ''), slot(2, '', '')], hitched: [KRONE] }),
      ),
    ).toEqual(['hitched_trailer_missing']);
  });
});

describe('неполная пара граф', () => {
  it('марка есть, госномера нет — дефект бумаги, названный слотом', () => {
    const warnings = warn({
      withTrailer: true,
      slots: [slot(1, 'КРОНА SDP27', ''), slot(2, '', '')],
      hitched: null,
    });
    expect(codesOf(warnings)).toEqual(['trailer_graphs_incomplete']);
    expect(trailerOnly(warnings)[0]!.facts).toMatchObject({
      slot: 1,
      missing: 'registrationNumber',
    });
  });

  it('госномер есть, марки нет — тот же дефект, другая половина', () => {
    const warnings = warn({
      withTrailer: true,
      slots: [slot(1, '', ''), slot(2, '', 'ЕН806277', 'EH806277')],
      hitched: null,
    });
    expect(
      warnings.map((w) => w.facts).filter((f) => f.code === 'trailer_graphs_incomplete'),
    ).toMatchObject([{ slot: 2, missing: 'model' }]);
  });

  it('полная пара молчит, и пустая молчит тоже', () => {
    expect(
      codesOf(
        warn({
          withTrailer: true,
          slots: [slot(1, 'КРОНА SDP27', 'ЕН806277', KRONE.regKey), slot(2, '', '')],
          hitched: null,
        }),
      ),
    ).toEqual([]);
  });
});

describe('сверка с реестром', () => {
  const withKrone: WaybillTrailerSource = {
    withTrailer: true,
    slots: [slot(1, 'КРОНА SDP27', 'ЕН806277', KRONE.regKey), slot(2, '', '')],
    hitched: [KRONE],
  };

  it('закреплённый прицеп стоит в графах — молчание', () => {
    expect(codesOf(warn(withKrone))).toEqual([]);
  });

  it('ключи сравниваются, а не написание: «ен 806277» и «ЕН806277» — один прицеп', () => {
    // Ключ считает `vehicle_reg_normalize` при сборке контекста; правило сравнивает только его.
    expect(
      codesOf(
        warn({
          ...withKrone,
          slots: [slot(1, 'КРОНА SDP27', 'ен 806277', KRONE.regKey), slot(2, '', '')],
        }),
      ),
    ).toEqual([]);
  });

  it('в графах другой прицеп — о закреплённом говорится', () => {
    expect(
      codesOf(
        warn({
          ...withKrone,
          slots: [slot(1, 'ШМИТЦ SPR-24', 'ВХ933277', SCHMITZ.regKey), slot(2, '', '')],
        }),
      ),
    ).toEqual(['hitched_trailer_missing']);
  });

  it('два закрепления — две строки, по одной на прицеп', () => {
    const warnings = warn({ ...withKrone, hitched: [KRONE, SCHMITZ] });
    expect(codesOf(warnings)).toEqual(['hitched_trailer_missing']);
    expect(warnings.map((w) => w.facts)).toContainEqual({
      code: 'hitched_trailer_missing',
      routeId: ROUTE_ID,
      trailerId: SCHMITZ.trailerId,
    });
  });

  it('исторический рейс о реестре не спрашивают: `hitched: null` — «не спрашивали»', () => {
    // Реестр хранит сегодняшнее закрепление, а коррекция правит состоявшийся день (§14.5).
    expect(
      codesOf(
        warn({ withTrailer: true, slots: [slot(1, '', ''), slot(2, '', '')], hitched: null }),
      ),
    ).toEqual(['trailer_graphs_blank']);
  });
});

describe('отпечаток расходится вместе с положением дел (Р21)', () => {
  /*
   * Отпечаток сервер берёт `sha256` от канонического вида набора (`warningsFingerprint`), и
   * сравнивать здесь достаточно сам канонический вид: хеш — оформление, а расходятся или нет две
   * подтверждаемые картины, решает он.
   */
  const fingerprintOf = (trailer: WaybillTrailerSource) => canonicalWarningPayload(warn(trailer));

  it('перецепили прицеп — прежнее подтверждение силы не имеет', () => {
    const before = fingerprintOf({
      withTrailer: true,
      slots: [slot(1, '', ''), slot(2, '', '')],
      hitched: [KRONE],
    });
    const after = fingerprintOf({
      withTrailer: true,
      slots: [slot(1, '', ''), slot(2, '', '')],
      hitched: [SCHMITZ],
    });
    expect(after).not.toBe(before);
  });

  it('дефект переехал из первого слота во второй — набор уже другой', () => {
    const first = fingerprintOf({
      withTrailer: true,
      slots: [slot(1, 'КРОНА SDP27', ''), slot(2, '', '')],
      hitched: null,
    });
    const second = fingerprintOf({
      withTrailer: true,
      slots: [slot(1, '', ''), slot(2, 'КРОНА SDP27', '')],
      hitched: null,
    });
    expect(second).not.toBe(first);
  });

  it('сменилась недостающая половина пары — тоже другой', () => {
    const noReg = fingerprintOf({
      withTrailer: true,
      slots: [slot(1, 'КРОНА SDP27', ''), slot(2, '', '')],
      hitched: null,
    });
    const noModel = fingerprintOf({
      withTrailer: true,
      slots: [slot(1, '', 'ЕН806277', KRONE.regKey), slot(2, '', '')],
      hitched: null,
    });
    expect(noModel).not.toBe(noReg);
  });
});

import { describe, expect, it } from 'vitest';
import {
  trailerGraphsFilled,
  trailerSubstitution,
  type TrailerSubstitution,
} from '@entities/vehicle-route';

/**
 * Правило подстановки прицепа (план `docs/vehicle-trailers-plan.md`, §14, Р20).
 *
 * Чистая функция проверяется здесь целиком, а окна — сценарными тестами
 * (`trailer-substitution.test.tsx`): правило одно на пять окон, и прогнанное через рендер оно
 * пряталось бы за поломками формы, запросов и антовских выпадашек.
 *
 * Проверяются не только названные случаи, но и **все комбинации входных флагов**: их 64, руками
 * такую таблицу не читают, поэтому свойства правила записаны утверждениями и прогоняются по
 * полному перебору. Именно перебор ловит то, на чём правило сломалось в прошлый раз, — сочетание
 * «галочка стоит, графы пусты», которое ни в одном словесном сценарии не значилось.
 */

interface Input {
  hasHitched: boolean;
  keepOwnGraphs: boolean;
  vehicleChanged: boolean;
  withTrailer: boolean;
  graphsFilled: boolean;
  isTractor: boolean;
}

const BOOLEANS = [false, true] as const;

/** Все 64 сочетания входов: правило обязано отвечать на каждое, а не на семь удобных. */
const ALL: Input[] = BOOLEANS.flatMap((hasHitched) =>
  BOOLEANS.flatMap((keepOwnGraphs) =>
    BOOLEANS.flatMap((vehicleChanged) =>
      BOOLEANS.flatMap((withTrailer) =>
        BOOLEANS.flatMap((graphsFilled) =>
          BOOLEANS.map((isTractor) => ({
            hasHitched,
            keepOwnGraphs,
            vehicleChanged,
            withTrailer,
            graphsFilled,
            isTractor,
          })),
        ),
      ),
    ),
  ),
);

/** Точка отсчёта именованных случаев: от неё они и отличаются одним-двумя флагами. */
const BASE: Input = {
  hasHitched: true,
  keepOwnGraphs: false,
  vehicleChanged: false,
  withTrailer: false,
  graphsFilled: false,
  isTractor: false,
};

const decide = (over: Partial<Input>): TrailerSubstitution =>
  trailerSubstitution({
    hasHitched: true,
    keepOwnGraphs: false,
    vehicleChanged: false,
    withTrailer: false,
    graphsFilled: false,
    isTractor: false,
    ...over,
  });

/** Читаемое имя случая: без него падение перебора показывает булев винегрет без подсказки. */
const name = (input: Input): string =>
  [
    input.hasHitched ? 'закрепление есть' : 'закрепления нет',
    input.keepOwnGraphs ? 'правка записи' : 'заведение',
    input.vehicleChanged ? 'машину сменили' : 'машина та же',
    input.withTrailer ? 'галочка стоит' : 'галочки нет',
    input.graphsFilled ? 'графы заполнены' : 'графы пусты',
    input.isTractor ? 'тягач' : 'не тягач',
  ].join(', ');

describe('trailerSubstitution — названные случаи (Р20)', () => {
  it('правка рейса: заполненные графы закрепление не вытесняет', () => {
    expect(decide({ keepOwnGraphs: true, withTrailer: true, graphsFilled: true })).toEqual({
      graphs: 'keep',
      tractorDefault: false,
    });
  });

  it('правка рейса: галочка при пустых графах — подстановка, ей нечего вытеснять', () => {
    // Тот самый случай, из-за которого тягач с закреплённым полуприцепом печатал пустой бланк:
    // галочка у него встаёт сама, и прежнее правило читало её как «рейс уже описал прицеп».
    expect(decide({ keepOwnGraphs: true, withTrailer: true, graphsFilled: false })).toEqual({
      graphs: 'substitute',
      tractorDefault: false,
    });
  });

  it('правка рейса: снятая галочка — решение записи, и подстановка его не отменяет', () => {
    // Голый тягач в ремонт и обратно (§4.4): рейс описан как «без прицепа» так же определённо,
    // как рейс с полуприцепом, — и до этой работы получал прицеп обратно вместе с галочкой.
    expect(decide({ keepOwnGraphs: true, withTrailer: false, isTractor: true })).toEqual({
      graphs: 'keep',
      tractorDefault: false,
    });
  });

  it('правка рейса: спрятанные графы при снятой галочке тоже считаются своими', () => {
    // Поля прицепа при снятой галочке уходят со страницы, но значения остаются в форме
    // (`preserve` у rc-field-form). Подставлять поверх них нечего: рейс сказал «без прицепа».
    expect(decide({ keepOwnGraphs: true, withTrailer: false, graphsFilled: true })).toEqual({
      graphs: 'keep',
      tractorDefault: false,
    });
  });

  it('окно заведения подставляет закрепление, ничего не спрашивая о графах', () => {
    expect(decide({ keepOwnGraphs: false, withTrailer: true, graphsFilled: true })).toEqual({
      graphs: 'substitute',
      tractorDefault: false,
    });
  });

  it('смена машины на закреплённую подставляет поверх чужих граф', () => {
    expect(
      decide({ keepOwnGraphs: true, vehicleChanged: true, withTrailer: true, graphsFilled: true }),
    ).toEqual({ graphs: 'substitute', tractorDefault: false });
  });

  it('смена машины на незакреплённую очищает графы прежней', () => {
    // Хуже пустой графы только чужой госномер: пустую допишут от руки, а напечатанный чужой
    // прочитают как правду.
    expect(
      decide({ hasHitched: false, vehicleChanged: true, withTrailer: true, graphsFilled: true }),
    ).toEqual({ graphs: 'clear', tractorDefault: false });
  });

  it('смена машины на незакреплённый тягач очищает графы и ставит галочку', () => {
    expect(
      decide({ hasHitched: false, vehicleChanged: true, graphsFilled: true, isTractor: true }),
    ).toEqual({ graphs: 'clear', tractorDefault: true });
  });

  it('заведение рейса тягачом без закрепления: только галочка, графы не трогаются', () => {
    expect(decide({ hasHitched: false, isTractor: true })).toEqual({
      graphs: 'keep',
      tractorDefault: true,
    });
  });

  it('правка рейса тягачом без закрепления не трогает даже галочку', () => {
    // `keep` обязан быть полным бездействием: пока галочка ставилась внутри него, «не трогать
    // запись» означало «не трогать, кроме галочки», и снятая рукой вставала обратно.
    expect(decide({ hasHitched: false, keepOwnGraphs: true, isTractor: true })).toEqual({
      graphs: 'keep',
      tractorDefault: false,
    });
  });
});

describe('trailerSubstitution — тип машины ещё не известен', () => {
  it('графы решаются как обычно, а галочка по типу не ставится', () => {
    // Справочник типов приезжает отдельным запросом, и графы его не ждут: живое закрепление не
    // должно стоять из-за медленного или упавшего списка (§14, Р21).
    expect(trailerSubstitution({ ...BASE, hasHitched: true, isTractor: undefined })).toEqual({
      graphs: 'substitute',
      tractorDefault: false,
    });
    expect(
      trailerSubstitution({
        ...BASE,
        hasHitched: false,
        vehicleChanged: true,
        graphsFilled: true,
        isTractor: undefined,
      }),
    ).toEqual({ graphs: 'clear', tractorDefault: false });
    // Тот же вход с известным типом отличается ровно галочкой.
    expect(
      trailerSubstitution({
        ...BASE,
        hasHitched: false,
        vehicleChanged: true,
        graphsFilled: true,
        isTractor: true,
      }),
    ).toEqual({ graphs: 'clear', tractorDefault: true });
  });
});

describe('trailerSubstitution — свойства на всех 64 сочетаниях', () => {
  it('подстановка бывает только при живом закреплении', () => {
    for (const input of ALL) {
      if (trailerSubstitution(input).graphs === 'substitute') {
        expect(input.hasHitched, name(input)).toBe(true);
      }
    }
  });

  it('очистка бывает только при смене машины и только без закрепления', () => {
    for (const input of ALL) {
      if (trailerSubstitution(input).graphs === 'clear') {
        expect([input.vehicleChanged, input.hasHitched], name(input)).toEqual([true, false]);
      }
    }
  });

  it('после смены машины графы никогда не остаются как есть', () => {
    // Они описывают уже не ту единицу: либо подставлены закреплением новой, либо очищены.
    for (const input of ALL.filter((i) => i.vehicleChanged)) {
      expect(trailerSubstitution(input).graphs, name(input)).not.toBe('keep');
    }
  });

  it('судьба граф от типа машины не зависит вовсе', () => {
    // Тягач решает галочку, а не графы: перепутать это — значит подставить полуприцеп по типу
    // машины, а не по тому, что за ней закреплено.
    for (const input of ALL) {
      expect(trailerSubstitution({ ...input, isTractor: true }).graphs, name(input)).toBe(
        trailerSubstitution({ ...input, isTractor: false }).graphs,
      );
    }
  });

  it('галочка тягача встаёт только у тягача, только без закрепления и только не в правке', () => {
    for (const input of ALL) {
      const { tractorDefault } = trailerSubstitution(input);
      if (!tractorDefault) continue;
      expect(input.isTractor, name(input)).toBe(true);
      // При живом закреплении галочку ставит сама подстановка — вторым решением она была бы
      // сказана дважды.
      expect(input.hasHitched, name(input)).toBe(false);
      // Открытая запись неприкосновенна: галочку в ней поставил или снял человек.
      expect(input.keepOwnGraphs && !input.vehicleChanged, name(input)).toBe(false);
    }
  });

  it('открытая запись без смены машины: своё не трогается ни в графах, ни в галочке', () => {
    for (const input of ALL.filter((i) => i.keepOwnGraphs && !i.vehicleChanged)) {
      const decision = trailerSubstitution(input);
      expect(decision.tractorDefault, name(input)).toBe(false);
      const expected =
        input.hasHitched && input.withTrailer && !input.graphsFilled ? 'substitute' : 'keep';
      expect(decision.graphs, name(input)).toBe(expected);
    }
  });
});

describe('trailerGraphsFilled — что считается заполненной графой', () => {
  it('пустые графы не заполнены, любая непустая — заполнена', () => {
    expect(trailerGraphsFilled({})).toBe(false);
    expect(
      trailerGraphsFilled({
        trailer1Model: '',
        trailer1RegNumber: '',
        trailer2Model: '',
        trailer2RegNumber: '',
      }),
    ).toBe(false);
    expect(trailerGraphsFilled({ trailer1Model: 'КРОНА SDP27' })).toBe(true);
    expect(trailerGraphsFilled({ trailer2RegNumber: 'ЕН806277' })).toBe(true);
  });

  it('пробелы графой не считаются: подстановку не запирают пробелом', () => {
    expect(trailerGraphsFilled({ trailer1Model: '   ', trailer1RegNumber: '\t' })).toBe(false);
  });

  it('галочка на ответ не влияет: графы — это марка и госномер', () => {
    expect(trailerGraphsFilled({ withTrailer: true })).toBe(false);
  });
});

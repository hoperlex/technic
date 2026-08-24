import { describe, expect, it } from 'vitest';
import {
  type AssignmentChangeRow,
  type AssignmentTerm,
  assignmentEffectRange,
  assignmentSegments,
  assignmentStateOn,
  type DriverState,
  sameAssignmentState,
  sameDriverState,
} from '../src/services/assignment-history';

/**
 * Свёртка истории назначения (`docs/assignment-periods-plan.md`, Р1–Р3, Р19, Р24).
 *
 * Функции чистые, и проверяется здесь ровно то, ради чего они вынесены отдельно от базы: состав
 * дня выводится из разреженных изменений, а не хранится, — значит ошибиться свёртка может молча.
 * Неверный отрезок не падает и не пишет в лог: он печатает недельный бланк ЭСМ-2 на другого
 * человека, и заметит это тот, кто возьмёт бумагу в руки.
 *
 * Три сюжета, которые сами по себе выглядят краем, а на деле рядовые: независимость шкал (машину
 * меняют одной дверью, человека — другой, и у одной даты законно стоят две строки), погашенные
 * строки (правка истории ничего не переписывает, а гасит и вставляет заново) и `unknown` — день,
 * про который известно, что бумага была, но не известно, чья.
 */

// Читаемые идентификаторы вместо uuid: в отчёте о падении «B вместо A» понятнее любого ключа.
const term: AssignmentTerm = { dateFrom: '2026-08-01', dateTo: '2026-08-31' };

let counter = 0;

/** Изменение машины: непустая машина — единственное значение этой шкалы (CHECK §6). */
function vehicle(
  effectiveDate: string,
  vehicleId: string,
  extra: Partial<AssignmentChangeRow> = {},
): AssignmentChangeRow {
  counter += 1;
  return {
    id: `change-${counter}`,
    effectiveDate,
    dimension: 'vehicle',
    vehicleId,
    driverPersonId: null,
    driverState: null,
    origin: 'assignment',
    changeGroupId: `group-${counter}`,
    supersededAt: null,
    ...extra,
  };
}

/** Изменение машиниста: человек есть только у `set`, у прочих состояний колонка пуста. */
function driver(
  effectiveDate: string,
  state: DriverState['state'],
  personId: string | null = null,
  extra: Partial<AssignmentChangeRow> = {},
): AssignmentChangeRow {
  counter += 1;
  return {
    id: `change-${counter}`,
    effectiveDate,
    dimension: 'driver',
    vehicleId: null,
    driverPersonId: state === 'set' ? personId : null,
    driverState: state,
    // `unknown` человек не заводит: его источники — бэкфилл и остаток заполнения (Р19).
    origin: state === 'unknown' ? 'backfill' : 'machinist_change',
    changeGroupId: `group-${counter}`,
    supersededAt: null,
    ...extra,
  };
}

/** Погашенная строка: правка гасит прежнюю и вставляет новую, отмена — гасит без замены (Р3). */
function cancelled(row: AssignmentChangeRow): AssignmentChangeRow {
  return { ...row, supersededAt: new Date('2026-08-19T10:00:00Z') };
}

/** Короткая запись отрезка для сравнения целыми списками: «с — по — чем — с кем». */
function shape(segments: ReturnType<typeof assignmentSegments>): string[] {
  return segments.map((segment) => {
    const person =
      segment.driver === null
        ? '—'
        : segment.driver.state === 'set'
          ? segment.driver.personId
          : segment.driver.state;
    return `${segment.from}..${segment.to} ${segment.vehicle?.vehicleId ?? '—'} ${person}`;
  });
}

describe('состав на дату', () => {
  it('пустая история — обе шкалы не заданы', () => {
    expect(assignmentStateOn([], '2026-08-10')).toEqual({ vehicle: null, driver: null });
  });

  it('до первого изменения состава нет, после последнего он продолжается', () => {
    const changes = [vehicle('2026-08-05', 'A'), driver('2026-08-05', 'set', 'Иванов')];
    expect(assignmentStateOn(changes, '2026-08-04')).toEqual({ vehicle: null, driver: null });
    expect(assignmentStateOn(changes, '2026-08-05').vehicle).toEqual({ vehicleId: 'A' });
    // Конца у изменения нет: его задаёт следующее изменение, а не календарь.
    expect(assignmentStateOn(changes, '2027-03-01').driver).toEqual({
      state: 'set',
      personId: 'Иванов',
    });
  });

  /*
   * Главное свойство модели (Р3): «не менялось» — это отсутствие строки, а не значение. Свернись
   * шкалы вместе, смена машины стёрла бы машиниста, которого никто не менял.
   */
  it('шкалы независимы: изменение одной другую не трогает', () => {
    const changes = [
      vehicle('2026-08-01', 'A'),
      driver('2026-08-01', 'set', 'Иванов'),
      vehicle('2026-08-10', 'B'),
    ];
    expect(assignmentStateOn(changes, '2026-08-15')).toEqual({
      vehicle: { vehicleId: 'B' },
      driver: { state: 'set', personId: 'Иванов' },
    });
  });

  it('одна шкала без другой: машина есть, машиниста ещё не называли', () => {
    expect(assignmentStateOn([vehicle('2026-08-01', 'A')], '2026-08-10')).toEqual({
      vehicle: { vehicleId: 'A' },
      driver: null,
    });
    expect(assignmentStateOn([driver('2026-08-01', 'set', 'Иванов')], '2026-08-10').vehicle).toBe(
      null,
    );
  });

  /*
   * Три состояния шкалы человека (Р19) не сводятся ни друг к другу, ни к «шкала не задана»:
   * `cleared` — решение отдать бланк арендодателю, `unknown` — признание, что историю дня
   * восстановить нечем, и бумага там уже выдана неизвестно на кого.
   */
  it('снятый машинист, неизвестный машинист и незаданная шкала — три разных ответа', () => {
    const cleared = assignmentStateOn([driver('2026-08-01', 'cleared')], '2026-08-10').driver;
    const unknown = assignmentStateOn([driver('2026-08-01', 'unknown')], '2026-08-10').driver;
    expect(cleared).toEqual({ state: 'cleared' });
    expect(unknown).toEqual({ state: 'unknown' });
    expect(assignmentStateOn([], '2026-08-10').driver).toBe(null);
    expect(sameDriverState(cleared, unknown)).toBe(false);
    expect(sameDriverState(cleared, null)).toBe(false);
  });

  it('погашенные строки в счёт не идут — ни правленые, ни отменённые', () => {
    const changes = [
      driver('2026-08-01', 'set', 'Иванов'),
      cancelled(driver('2026-08-10', 'set', 'Петров')),
      cancelled(vehicle('2026-08-10', 'B')),
      vehicle('2026-08-01', 'A'),
    ];
    expect(assignmentStateOn(changes, '2026-08-20')).toEqual({
      vehicle: { vehicleId: 'A' },
      driver: { state: 'set', personId: 'Иванов' },
    });
  });

  it('порядок строк в выборке на ответ не влияет', () => {
    const changes = [
      driver('2026-08-15', 'set', 'Петров'),
      driver('2026-08-01', 'set', 'Иванов'),
      vehicle('2026-08-10', 'B'),
      vehicle('2026-08-01', 'A'),
    ];
    expect(assignmentStateOn(changes, '2026-08-20')).toEqual({
      vehicle: { vehicleId: 'B' },
      driver: { state: 'set', personId: 'Петров' },
    });
    expect(assignmentStateOn([...changes].reverse(), '2026-08-20')).toEqual(
      assignmentStateOn(changes, '2026-08-20'),
    );
  });
});

/*
 * Заявка месяца, в которой машина менялась дважды, а машинист трижды, и ни одна дата не совпала.
 * Она же — общий стенд для отрезков и диапазонов: разъезжаются шкалы именно на такой истории.
 */
const busy: AssignmentChangeRow[] = [
  vehicle('2026-08-01', 'A', { id: 'v-start' }),
  vehicle('2026-08-10', 'B', { id: 'v-second', origin: 'reassignment' }),
  vehicle('2026-08-20', 'C', { id: 'v-third', origin: 'reassignment' }),
  driver('2026-08-01', 'set', 'Иванов', { id: 'd-start', origin: 'assignment' }),
  driver('2026-08-05', 'set', 'Петров', { id: 'd-second' }),
  driver('2026-08-15', 'cleared', null, { id: 'd-third' }),
  driver('2026-08-25', 'set', 'Сидоров', { id: 'd-fourth' }),
];

describe('отрезки постоянного состава', () => {
  it('пустая история — один отрезок на весь срок, и он ничей', () => {
    expect(assignmentSegments([], term)).toEqual([
      { from: '2026-08-01', to: '2026-08-31', vehicle: null, driver: null },
    ]);
  });

  it('срок без даты окончания — один день (Р24)', () => {
    const segments = assignmentSegments(busy, { dateFrom: '2026-08-12', dateTo: null });
    expect(shape(segments)).toEqual(['2026-08-12..2026-08-12 B Петров']);
  });

  it('перевёрнутого срока не существует — отрезков нет', () => {
    expect(assignmentSegments(busy, { dateFrom: '2026-08-31', dateTo: '2026-08-01' })).toEqual([]);
  });

  it('обе шкалы режут срок, и режут его порознь', () => {
    expect(shape(assignmentSegments(busy, term))).toEqual([
      '2026-08-01..2026-08-04 A Иванов',
      '2026-08-05..2026-08-09 A Петров',
      '2026-08-10..2026-08-14 B Петров',
      '2026-08-15..2026-08-19 B cleared',
      '2026-08-20..2026-08-24 C cleared',
      '2026-08-25..2026-08-31 C Сидоров',
    ]);
  });

  /*
   * Изменение до начала срока продолжает действовать, а не начинается заново: открой оно отрезок,
   * первый день срока получил бы границу документа там, где ничего не происходило.
   */
  it('изменения до начала срока задают состав первого дня, но отрезка не открывают', () => {
    const segments = assignmentSegments(busy, { dateFrom: '2026-08-12', dateTo: '2026-08-18' });
    expect(shape(segments)).toEqual([
      '2026-08-12..2026-08-14 B Петров',
      '2026-08-15..2026-08-18 B cleared',
    ]);
  });

  it('изменение за концом срока дремлет и отрезков не открывает (Р24)', () => {
    const segments = assignmentSegments([...busy, driver('2026-09-05', 'set', 'Кузнецов')], term);
    expect(shape(segments).at(-1)).toBe('2026-08-25..2026-08-31 C Сидоров');
  });

  /*
   * Отмена возвращает шкалу к предыдущему значению (Р3), и срок остаётся с двумя соседними
   * отрезками одного состава. Не схлопни их — на одну неделю ушло бы два бланка на одного и того
   * же человека, и второй пришлось бы объяснять бухгалтерии (Р12).
   */
  it('соседние отрезки одинакового состава схлопываются', () => {
    const changes = [
      vehicle('2026-08-01', 'A'),
      driver('2026-08-01', 'set', 'Иванов'),
      cancelled(driver('2026-08-10', 'set', 'Петров')),
      driver('2026-08-20', 'set', 'Иванов'),
    ];
    expect(shape(assignmentSegments(changes, term))).toEqual(['2026-08-01..2026-08-31 A Иванов']);
  });

  it('погашенное изменение срок не режет', () => {
    const changes = [vehicle('2026-08-01', 'A'), cancelled(vehicle('2026-08-10', 'B'))];
    expect(shape(assignmentSegments(changes, term))).toEqual(['2026-08-01..2026-08-31 A —']);
  });

  /*
   * `unknown` на левом краю — типичный бэкфилл: бумага за первые недели есть, а кто в ней написан,
   * история не знает. На правом — остаток частичного заполнения (Ш4): человека назвали на свой
   * отрезок, а границу «дальше опять неизвестно» поставил сервер.
   */
  it('unknown на краю срока: слева от заполнения и справа от него', () => {
    const changes = [
      vehicle('2026-08-01', 'A'),
      driver('2026-08-01', 'unknown'),
      driver('2026-08-10', 'set', 'Иванов', { origin: 'known_fill' }),
      driver('2026-08-21', 'unknown', null, { origin: 'unknown_remainder' }),
    ];
    expect(shape(assignmentSegments(changes, term))).toEqual([
      '2026-08-01..2026-08-09 A unknown',
      '2026-08-10..2026-08-20 A Иванов',
      '2026-08-21..2026-08-31 A unknown',
    ]);
  });

  it('unknown в середине срока не сливается с соседями', () => {
    const changes = [
      vehicle('2026-08-01', 'A'),
      driver('2026-08-01', 'set', 'Иванов'),
      driver('2026-08-10', 'unknown'),
      driver('2026-08-20', 'set', 'Иванов'),
    ];
    expect(shape(assignmentSegments(changes, term))).toEqual([
      '2026-08-01..2026-08-09 A Иванов',
      '2026-08-10..2026-08-19 A unknown',
      '2026-08-20..2026-08-31 A Иванов',
    ]);
  });

  it('две строки одной даты дают одну границу, а не отрезок в ноль дней', () => {
    const changes = [
      vehicle('2026-08-01', 'A'),
      driver('2026-08-01', 'set', 'Иванов'),
      // Уход в аренду: vehicle-изменение и порождённая им `cleared` — одно решение, одна группа.
      vehicle('2026-08-10', 'B', { changeGroupId: 'пара' }),
      driver('2026-08-10', 'cleared', null, { changeGroupId: 'пара', origin: 'reassignment' }),
    ];
    expect(shape(assignmentSegments(changes, term))).toEqual([
      '2026-08-01..2026-08-09 A Иванов',
      '2026-08-10..2026-08-31 B cleared',
    ]);
  });
});

describe('диапазон одного изменения', () => {
  it('логический диапазон кончается днём перед следующим изменением своей шкалы', () => {
    expect(assignmentEffectRange(busy, 'v-second', term)).toEqual({
      logical: { from: '2026-08-10', to: '2026-08-19' },
      inTerm: { from: '2026-08-10', to: '2026-08-19' },
    });
  });

  /*
   * Соседняя шкала диапазон не режет (Р11): смена машины 10 августа стоит внутри срока Петрова, и
   * прими её свёртка за границу — мартовский driver-якорь получил бы право снимать чужие подписи.
   */
  it('изменение соседней шкалы диапазон не обрывает', () => {
    expect(assignmentEffectRange(busy, 'd-second', term)?.logical).toEqual({
      from: '2026-08-05',
      to: '2026-08-14',
    });
  });

  it('у последнего изменения шкалы конца нет, а бумажный диапазон обрывается сроком', () => {
    expect(assignmentEffectRange(busy, 'd-fourth', term)).toEqual({
      logical: { from: '2026-08-25', to: null },
      inTerm: { from: '2026-08-25', to: '2026-08-31' },
    });
  });

  it('изменение до начала срока: бумажный диапазон начинается со срока', () => {
    const changes = [vehicle('2026-07-20', 'A', { id: 'до-срока' })];
    expect(assignmentEffectRange(changes, 'до-срока', term)).toEqual({
      logical: { from: '2026-07-20', to: null },
      inTerm: { from: '2026-08-01', to: '2026-08-31' },
    });
  });

  /*
   * Дремлющее изменение (Р24): срок кончился, человека поставили с даты за ним ради будущего
   * продления. Логический диапазон у него есть — иначе продление не оживило бы его, — а бумажного
   * нет, и требовать по нему разблокировок и постусловия не с чего.
   */
  it('дремлющее изменение: логический диапазон есть, бумажного нет', () => {
    const changes = [...busy, driver('2026-09-05', 'set', 'Кузнецов', { id: 'дремлет' })];
    expect(assignmentEffectRange(changes, 'дремлет', term)).toEqual({
      logical: { from: '2026-09-05', to: null },
      inTerm: null,
    });
    // Продлили срок — то же изменение стало обычным, безо всякой правки строки.
    expect(
      assignmentEffectRange(changes, 'дремлет', { dateFrom: '2026-08-01', dateTo: '2026-09-30' })
        ?.inTerm,
    ).toEqual({ from: '2026-09-05', to: '2026-09-30' });
  });

  it('однодневный срок: изменение попадает в него только своим днём', () => {
    const day: AssignmentTerm = { dateFrom: '2026-08-12', dateTo: null };
    expect(assignmentEffectRange(busy, 'v-second', day)?.inTerm).toEqual({
      from: '2026-08-12',
      to: '2026-08-12',
    });
    expect(assignmentEffectRange(busy, 'v-third', day)?.inTerm).toBe(null);
  });

  it('чужой и погашенный ключ диапазона не имеют', () => {
    expect(assignmentEffectRange(busy, 'такого-нет', term)).toBe(null);
    const changes = [cancelled(vehicle('2026-08-10', 'B', { id: 'погашено' }))];
    expect(assignmentEffectRange(changes, 'погашено', term)).toBe(null);
  });

  it('погашенное изменение чужой диапазон не укорачивает', () => {
    const changes = [
      vehicle('2026-08-01', 'A', { id: 'первое' }),
      cancelled(vehicle('2026-08-10', 'B')),
      vehicle('2026-08-20', 'C'),
    ];
    expect(assignmentEffectRange(changes, 'первое', term)?.logical).toEqual({
      from: '2026-08-01',
      to: '2026-08-19',
    });
  });
});

describe('сравнение состава', () => {
  it('состав считается одинаковым по обеим шкалам сразу', () => {
    const state = assignmentStateOn(busy, '2026-08-12');
    expect(sameAssignmentState(state, assignmentStateOn(busy, '2026-08-14'))).toBe(true);
    // 15 августа сменился только человек — состав уже другой.
    expect(sameAssignmentState(state, assignmentStateOn(busy, '2026-08-15'))).toBe(false);
    // 10 августа сменилась только машина.
    expect(sameAssignmentState(state, assignmentStateOn(busy, '2026-08-09'))).toBe(false);
  });

  it('один и тот же человек на разных машинах — не тот же состав', () => {
    expect(
      sameAssignmentState(
        { vehicle: { vehicleId: 'A' }, driver: { state: 'set', personId: 'Иванов' } },
        { vehicle: { vehicleId: 'B' }, driver: { state: 'set', personId: 'Иванов' } },
      ),
    ).toBe(false);
  });
});

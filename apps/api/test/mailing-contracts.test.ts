import { describe, expect, it } from 'vitest';
import {
  createMailingScheduleSchema,
  MAILING_WINDOW_MAX_DAYS,
  MAILING_WINDOW_MAX_FROM,
  updateMailingScheduleSchema,
} from '@technic/contracts';

/**
 * Правила применимости полей расписания рассылки (ADR 0075, ADR 0093).
 *
 * Проверяются схемой, а не только ограничениями таблицы, и потому проверяются здесь. CHECK —
 * последняя защита от кривой записи, но человеку он ничего не объясняет: отказ приходит именем
 * ограничения, поле в форме по нему не подсветить, а часть правил (пустой перечень при режиме
 * «перечисленные») в CHECK не выражается вовсе — они про соседнюю таблицу.
 *
 * Цена ошибки здесь тихая и потому неприятная: расписание, сохранённое в состоянии «выполняется
 * никогда» или «получателей ноль», выглядит в списке настроенным и включённым. О том, что письма
 * не приходят, узнают не от портала.
 */

const OBJECT_ID = '11111111-1111-4111-8111-111111111111';
const DEPARTMENT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

/** Сводка в минимально законном виде: от неё отталкиваются проверки «чего не хватает». */
const digest = {
  type: 'role_digest' as const,
  name: 'Вечерняя сводка',
  sendAt: '18:00',
  windowFromDays: 1,
  windowDays: 1,
  roles: ['shtab' as const],
};

/** Задание водителям: аудитории и содержания у него не бывает — получателей задаёт наличие рейса. */
const driverRoutes = {
  type: 'driver_routes' as const,
  name: 'Задание на завтра',
  sendAt: '18:00',
  windowFromDays: 1,
  windowDays: 1,
};

/**
 * Поля, на которые схема указала при отказе. Сравнивать надо именно их, а не сам факт отказа:
 * форма подсвечивает поле по пути ошибки, и правило, сработавшее «не за то», уводит человека
 * править не ту настройку.
 */
function badFields(schema: typeof createMailingScheduleSchema, input: unknown): string[] {
  const result = schema.safeParse(input);
  if (result.success) return [];
  return [...new Set(result.error.issues.map((i) => i.path.join('.')))];
}

describe('createMailingScheduleSchema: умолчания', () => {
  it('сводка сохраняется с полным набором дней и отбором «все»', () => {
    const parsed = createMailingScheduleSchema.parse(digest);
    // Ни одна из этих настроек в форме не обязательна, и умолчание каждой — рабочее состояние:
    // «каждый день», «обе таблицы», «все площадки и все получатели», «заявки своей области».
    expect(parsed.runWeekdays).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(parsed.showTrips).toBe(true);
    expect(parsed.showOnsite).toBe(true);
    expect(parsed.scopeMode).toBe('all');
    expect(parsed.recipientMode).toBe('all');
    expect(parsed.requestScope).toBe('scope');
    // Новая рассылка заводится выключенной: сначала настраивают, потом включают.
    expect(parsed.isEnabled).toBe(false);
  });

  it('задание водителям проходит без ролей и аудитории вовсе', () => {
    const parsed = createMailingScheduleSchema.parse(driverRoutes);
    expect(parsed.roles).toEqual([]);
    expect(parsed.recipientUserIds).toEqual([]);
  });
});

describe('createMailingScheduleSchema: дни выполнения', () => {
  it('пустой набор дней отвергается: «никогда» выражается флагом «выключено»', () => {
    // Расписание с пустым набором дней выглядит включённым и не срабатывает ни разу. Отличить
    // такое от настроенного по списку расписаний нельзя — только по отсутствию писем.
    expect(badFields(createMailingScheduleSchema, { ...digest, runWeekdays: [] })).toEqual([
      'runWeekdays',
    ]);
    // Правило общее для обоих типов: у задания водителям день срабатывания жил в той же колонке.
    expect(badFields(createMailingScheduleSchema, { ...driverRoutes, runWeekdays: [] })).toEqual([
      'runWeekdays',
    ]);
  });

  it('повтор дня недели отвергается: в закрытом списке это сбой формы', () => {
    expect(badFields(createMailingScheduleSchema, { ...digest, runWeekdays: [1, 1] })).toEqual([
      'runWeekdays',
    ]);
  });

  it('день вне 1..7 не проходит', () => {
    // Счёт ISO: 1 — понедельник, 7 — воскресенье. Ноль в наборе означал бы воскресенье в чужом
    // счёте, и рассылка ушла бы не в тот день, а не упала.
    expect(badFields(createMailingScheduleSchema, { ...digest, runWeekdays: [0] })).toEqual([
      'runWeekdays.0',
    ]);
    expect(badFields(createMailingScheduleSchema, { ...digest, runWeekdays: [8] })).toEqual([
      'runWeekdays.0',
    ]);
  });
});

describe('createMailingScheduleSchema: окно данных', () => {
  it('окно обязательно у обоих типов: без него письмо не про что', () => {
    // Умолчания у окна нет намеренно: «на завтра» и «на сегодня» — разные рассылки, и подставить
    // одну вместо другой значит отправить задание не про те сутки.
    const { windowFromDays: _f, windowDays: _d, ...noWindow } = digest;
    expect(badFields(createMailingScheduleSchema, noWindow)).toEqual([
      'windowFromDays',
      'windowDays',
    ]);
    const { windowFromDays: _f2, windowDays: _d2, ...noWindowDriver } = driverRoutes;
    expect(badFields(createMailingScheduleSchema, noWindowDriver)).toEqual([
      'windowFromDays',
      'windowDays',
    ]);
  });

  it('окно смотрит только вперёд и не длиннее месяца', () => {
    // Отрицательное начало — это ретроспектива, которой у сводки больше нет вовсе (ADR 0093 п. 2).
    expect(badFields(createMailingScheduleSchema, { ...digest, windowFromDays: -1 })).toEqual([
      'windowFromDays',
    ]);
    expect(badFields(createMailingScheduleSchema, { ...digest, windowDays: 0 })).toEqual([
      'windowDays',
    ]);
    expect(
      badFields(createMailingScheduleSchema, {
        ...digest,
        windowFromDays: MAILING_WINDOW_MAX_FROM + 1,
      }),
    ).toEqual(['windowFromDays']);
    expect(
      badFields(createMailingScheduleSchema, {
        ...digest,
        windowDays: MAILING_WINDOW_MAX_DAYS + 1,
      }),
    ).toEqual(['windowDays']);
    // Границы включительно: «через тридцать дней на тридцать один» — законная настройка.
    expect(
      createMailingScheduleSchema.parse({
        ...digest,
        windowFromDays: MAILING_WINDOW_MAX_FROM,
        windowDays: MAILING_WINDOW_MAX_DAYS,
      }).windowDays,
    ).toBe(MAILING_WINDOW_MAX_DAYS);
  });
});

describe('createMailingScheduleSchema: содержание сводки', () => {
  it('сводка без ролей отвергается: получателей ей взять неоткуда', () => {
    // Роль — единственный источник адресатов сводки. Без неё рассылка каждое утро отработает
    // вхолостую, и в истории запусков это будет выглядеть как успешный запуск.
    expect(badFields(createMailingScheduleSchema, { ...digest, roles: [] })).toEqual(['roles']);
  });

  it('роль, указанная дважды, отвергается', () => {
    expect(
      badFields(createMailingScheduleSchema, { ...digest, roles: ['shtab', 'shtab'] }),
    ).toEqual(['roles']);
  });

  it('сводка без единой таблицы отвергается', () => {
    // Обе галочки сняты — письмо соберётся пустым и не отправится: выключается такая рассылка
    // флагом, а не снятием содержания.
    expect(
      badFields(createMailingScheduleSchema, { ...digest, showTrips: false, showOnsite: false }),
    ).toEqual(['showTrips']);
    // Одной таблицы достаточно: сводка только про технику на объектах — обычная настройка.
    expect(createMailingScheduleSchema.parse({ ...digest, showTrips: false }).showOnsite).toBe(
      true,
    );
  });
});

describe('createMailingScheduleSchema: аудитория сводки', () => {
  it('режим «перечисленные» с пустым перечнем отвергается', () => {
    // Это то же «никогда не выполняется», записанное второй раз: отбор пустым перечнем не найдёт
    // ни одного получателя, а форма покажет выбранный режим.
    expect(badFields(createMailingScheduleSchema, { ...digest, scopeMode: 'selected' })).toEqual([
      'objectIds',
    ]);
    expect(
      badFields(createMailingScheduleSchema, { ...digest, recipientMode: 'selected' }),
    ).toEqual(['recipientUserIds']);
    // Оси площадок и отделов хватает одной: рассылка на один отдел без единой площадки законна.
    expect(
      createMailingScheduleSchema.parse({
        ...digest,
        scopeMode: 'selected',
        departmentIds: [DEPARTMENT_ID],
      }).departmentIds,
    ).toEqual([DEPARTMENT_ID]);
  });

  it('режим «все» с непустым перечнем отвергается', () => {
    // Перечень, сохранённый рядом с «все», однажды применили бы вместо него — и рассылка молча
    // сузилась бы до набора, отмеченного год назад.
    expect(
      badFields(createMailingScheduleSchema, {
        ...digest,
        scopeMode: 'all',
        objectIds: [OBJECT_ID],
      }),
    ).toEqual(['objectIds']);
    expect(
      badFields(createMailingScheduleSchema, {
        ...digest,
        scopeMode: 'all',
        departmentIds: [DEPARTMENT_ID],
      }),
    ).toEqual(['objectIds']);
    expect(
      badFields(createMailingScheduleSchema, {
        ...digest,
        recipientMode: 'all',
        recipientUserIds: [USER_ID],
      }),
    ).toEqual(['recipientUserIds']);
  });
});

describe('createMailingScheduleSchema: чужие поля у задания водителям', () => {
  it('роли-получатели заданию водителям запрещены', () => {
    // Кому уходит задание, решает наличие рейса в окне, а не роль. Сохранённая роль означала бы,
    // что настройка есть, а не работает.
    expect(badFields(createMailingScheduleSchema, { ...driverRoutes, roles: ['shtab'] })).toEqual([
      'roles',
    ]);
  });

  it('аудитория заданию водителям запрещена целиком', () => {
    expect(
      badFields(createMailingScheduleSchema, { ...driverRoutes, recipientUserIds: [USER_ID] }),
    ).toEqual(['recipientUserIds']);
    expect(
      badFields(createMailingScheduleSchema, { ...driverRoutes, objectIds: [OBJECT_ID] }),
    ).toEqual(['recipientUserIds', 'objectIds']);
  });

  it('исключённые водители и даты остаются законными у обоих типов', () => {
    // Водители в отбор не входят: их выбирает рейс, и «не слать этому» выражается исключением.
    const parsed = createMailingScheduleSchema.parse({
      ...driverRoutes,
      excludedPersonIds: [USER_ID],
      excludedRunDates: ['2026-08-10'],
      excludedRouteDates: ['2026-08-11'],
    });
    expect(parsed.excludedPersonIds).toEqual([USER_ID]);
    expect(parsed.excludedRouteDates).toEqual(['2026-08-11']);
  });
});

describe('updateMailingScheduleSchema', () => {
  it('правка проходит те же правила, что и заведение', () => {
    // Правила навешены на объект отдельно для создания и правки: пропущенная на правке проверка
    // означает, что кривое состояние заводится в два шага — сохранить верно, потом испортить.
    expect(
      badFields(updateMailingScheduleSchema, { ...digest, version: 3, runWeekdays: [] }),
    ).toEqual(['runWeekdays']);
    expect(badFields(updateMailingScheduleSchema, { ...digest, version: 3, roles: [] })).toEqual([
      'roles',
    ]);
  });

  it('версия обязательна: правка расписания идёт с проверкой на одновременность', () => {
    expect(badFields(updateMailingScheduleSchema, digest)).toEqual(['version']);
  });
});

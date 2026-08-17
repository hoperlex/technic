import { describe, expect, it } from 'vitest';
import {
  type FreightAction,
  type FreightTripRow,
  type LinearDayRow,
  type LinearWorkAction,
  type VehicleRoutePointDto,
  taskRowLayout,
  waybillTaskRows,
} from '@technic/contracts';

/**
 * Строки задания бланка и их бюджет (план `docs/route-trips-plan.md`, Р11, Р11а, Р11б).
 *
 * Две разные вещи, и обе решают, что напечатается на бумаге строгой отчётности.
 *
 * **Порядок строк** обязан быть определён до конца: от него зависят `slot`, номер талона (первые
 * четыре у 4-П), заказчик в шапке и отпечаток предупреждений. Зависеть от того, как строки вернул
 * SQL, они не могут — иначе повторная выписка того же рейса дала бы другой документ.
 *
 * **Бюджет** решает, что не поместится. Считается он в ширине, а не в знаках: единица ширины
 * колонки Excel — это цифра «0» шрифта книги (Arial 8 pt), а графы задания набраны кеглем 6 pt, и
 * посимвольный предел занижает ёмкость примерно в 1.7 раза. Практическое последствие — свёрнутый в
 * «+N» второй контакт, который сегодня печатается и помещается. Консервативность держит ширина
 * **неизвестного** глифа, а не единица счёта.
 */

const load = (
  position: number,
  requestNum: number,
  tripNum: number,
  /**
   * Позиция роли **внутри точки** (миграция `0146`) — не путать с `position` выше, который здесь
   * задаёт позицию парной точки. Ею разводятся строки, у которых совпала пара точек: база держит
   * её различной у ролей одной точки (`UNIQUE (point_id, position)`).
   */
  rolePosition = tripNum,
): FreightAction => ({
  position: rolePosition,
  kind: 'freight',
  ref: { kind: 'freight', requestId: `req-${requestNum}`, tripId: `t-${requestNum}-${tripNum}` },
  role: 'load',
  cargoLabel: '10 м³',
  pairPosition: position,
  displayNumber: `ТС-${requestNum}/${tripNum}`,
  requestNum,
  tripNum,
  customerName: 'ЖК Северный',
  contactName: 'Иванов И.И.',
  contactPhone: '+7 916 123-45-67',
  addressMismatch: false,
});

const unload = (
  position: number,
  requestNum: number,
  tripNum: number,
  rolePosition = tripNum,
): FreightAction => ({
  ...load(position, requestNum, tripNum, rolePosition),
  role: 'unload',
});

const work = (requestNum: number): LinearWorkAction => ({
  kind: 'linear',
  ref: { kind: 'linear', requestId: `req-${requestNum}`, workDate: '2026-08-12' },
  role: 'work',
  displayNumber: `ТС-${requestNum} · 12.08`,
  requestNum,
  tripNum: 0,
  customerName: 'Объект «Восточный»',
  contactName: 'Кузнецов К.К.',
  contactPhone: '+7 900 555-11-22',
  addressMismatch: false,
});

const point = (
  position: number,
  location: string,
  actions: (FreightAction | LinearWorkAction)[],
): VehicleRoutePointDto => ({
  id: `p${position}`,
  position,
  location,
  address: { source: 'resolved', fiasId: `f${position}` },
  arrivalTime: '',
  comment: '',
  actions,
  contacts: [{ name: 'Иванов И.И.', phone: '+7 916 123-45-67' }],
});

describe('порядок строк задания', () => {
  /**
   * Три сценария заказчика из §2 плана собираются одной моделью. Здесь — первый: в A грузим обе
   * ездки заявки 40, в B выгружаем 40/1 и грузим 41/1, в C — 40/2, в D — 41/1.
   */
  it('строки идут по позиции погрузки, при равенстве — по позиции разгрузки', () => {
    const rows = waybillTaskRows([
      point(1, 'A', [load(2, 40, 1), load(4, 40, 2)]),
      point(2, 'B', [unload(1, 40, 1), load(3, 41, 1)]),
      point(3, 'D', [unload(2, 41, 1)]),
      point(4, 'C', [unload(1, 40, 2)]),
    ]);

    expect(rows.map((r) => r.displayNumber)).toEqual(['ТС-40/1', 'ТС-40/2', 'ТС-41/1']);
    expect(rows.map((r) => r.slot)).toEqual([1, 2, 3]);
    expect(rows.map((r) => [r.from, r.to])).toEqual([
      ['A', 'B'],
      ['A', 'C'],
      ['B', 'D'],
    ]);
  });

  /**
   * Случай, который прежняя редакция плана пропускала: две **повторные** ездки `A→B` стоят на одних
   * и тех же точках и по первым двум ключам неразличимы. Развести их могло бы только что-то третье
   * — иначе порядок строк, а с ним и номера талонов, зависел бы от того, как их вернул SQL.
   *
   * Сначала третьим ключом был номер заявки. Он давал детерминизм, но не ответ: кто из заказчиков
   * подпишет талон первым, решал порядок заведения заявок. С миграцией `0146` третий ключ — позиция
   * роли на точке, то есть решение диспетчера «какую ездку грузим первой» ([ADR 0068](../../docs/adr/0068-route-requests-by-form.md) п. 2
   * сделал этот порядок решением о подписях). Номера остались хвостом на битые данные.
   */
  it('повторные ездки на одних точках упорядочены позицией роли, а не номерами', () => {
    const points = [
      point(1, 'A', [load(2, 40, 2, 2), load(2, 41, 1, 3), load(2, 40, 1, 1)]),
      point(2, 'B', [unload(1, 40, 2, 2), unload(1, 41, 1, 3), unload(1, 40, 1, 1)]),
    ];

    expect(waybillTaskRows(points).map((r) => r.displayNumber)).toEqual([
      'ТС-40/1',
      'ТС-40/2',
      'ТС-41/1',
    ]);
    // Тот же набор в обратном порядке даёт тот же документ.
    expect(
      waybillTaskRows(points.map((p) => ({ ...p, actions: [...p.actions].reverse() }))),
    ).toEqual(waybillTaskRows(points));
  });

  /**
   * Смешанный день не распадается на «упорядоченные ездки» и «неупорядоченные дни» (Р5а): линейный
   * день встаёт в общий порядок по позиции своей единственной точки, и «откуда» у него пусто, ровно
   * как печатает код сегодня (ADR 0100 §10).
   */
  it('линейный день встаёт по позиции своей точки и печатается без «откуда»', () => {
    const rows = waybillTaskRows(
      [
        point(1, 'Карьер', [load(3, 40, 1)]),
        point(2, 'Объект «Восточный»', [work(77)]),
        point(3, 'ЖК Северный', [unload(1, 40, 1)]),
      ],
      new Map([['linear:req-77:2026-08-12', 'планировка площадки']]),
    );

    expect(rows.map((r) => r.displayNumber)).toEqual(['ТС-40/1', 'ТС-77 · 12.08']);
    const linear = rows[1] as LinearDayRow;
    expect(linear.kind).toBe('linear');
    expect(linear.from).toBe('');
    expect(linear.to).toBe('Объект «Восточный»');
    // Характер работ — содержимое графы «Груз» у такого дня: другого места под него в бланке нет.
    expect(linear.workNote).toBe('планировка площадки');
  });

  /** Полуразложенная ездка строкой задания не становится: печатать «куда» нечем. */
  it('ездка с одним концом строкой не становится', () => {
    expect(waybillTaskRows([point(1, 'A', [load(0, 40, 1)])])).toEqual([]);
  });
});

const freightRow = (over: Partial<FreightTripRow> = {}): FreightTripRow => ({
  kind: 'freight',
  ref: { kind: 'freight', requestId: 'req-40', tripId: 't-40-1' },
  slot: 1,
  from: 'Карьер Сычёво',
  to: 'ЖК Северный, к. 3',
  contacts: [],
  displayNumber: 'ТС-40/1',
  requestNum: 40,
  tripNum: 1,
  cargoLabel: '10 м³',
  cargoNote: '',
  ...over,
});

const contact = (name: string, phone: string): { name: string; phone: string } => ({ name, phone });

describe('бюджет строки: графы 1–4', () => {
  /**
   * Главная проверка отсутствия регресса. Сегодня графа печатает два контакта — погрузки и
   * разгрузки, — и `routeContactsLabel` не сворачивает вообще ничего. Бюджет обязан оставить эти
   * два на бумаге: свернувший их в «+N» бюджет ухудшил бы уже выданный документооборот.
   */
  it('два контакта влезают в графу целиком', () => {
    const layout = taskRowLayout(
      freightRow({
        contacts: [
          contact('Кузнецова Анна Владимировна', '+7 914 123-45-67'),
          contact('Петров Пётр Петрович', '+7 903 765-43-21'),
        ],
      }),
      'columns',
    );

    expect(layout.ok).toBe(true);
    if (!layout.ok) return;
    expect(layout.hidden).toEqual([]);
    expect(layout.contacts.split('\n')).toHaveLength(2);
    // Ни одного свёрнутого: пометки «+N» в графе нет. Сравнивать со знаком «+» нельзя — его несёт
    // сам номер («+7 (914) …»), и такой ассерт падал бы на исправной графе.
    expect(layout.contacts).not.toMatch(/\+\d+$/mu);
    // Имя сокращается до «Фамилия И.О.» — и меряется бюджетом уже сокращённым.
    expect(layout.contacts).toContain('Кузнецова А.В.');
  });

  it('третий контакт сворачивается в «+N» и перечисляется в hidden', () => {
    const layout = taskRowLayout(
      freightRow({
        contacts: [
          contact('Кузнецова Анна Владимировна', '+7 914 123-45-67'),
          contact('Петров Пётр Петрович', '+7 903 765-43-21'),
          contact('Сидоров Семён Семёнович', '+7 905 111-22-33'),
        ],
      }),
      'columns',
    );

    expect(layout.ok).toBe(true);
    if (!layout.ok) return;
    expect(layout.contacts).toContain('+1');
    expect(layout.hidden).toHaveLength(1);
    // «+N» приписан к последней напечатанной подписи, а не съел под себя строку.
    expect(layout.contacts.split('\n')).toHaveLength(2);
  });

  /**
   * Порядок свёртывания: комментарий к грузу уходит первым — «песок, звонить за час» полезно, но по
   * нему не попадают на объект. Количество при этом остаётся: без него неизвестно, что везём.
   */
  it('комментарий к грузу отбрасывается раньше контактов', () => {
    const layout = taskRowLayout(
      freightRow({
        cargoNote: 'песок мытый, звонить за час до выезда',
        contacts: [contact('Иванов И.И.', '+7 916 123-45-67')],
      }),
      'columns',
    );

    expect(layout.ok).toBe(true);
    if (!layout.ok) return;
    expect(layout.cargo).toBe('10 м³');
    expect(layout.hidden).toHaveLength(1);
    expect(layout.contacts).not.toContain('+1');
  });

  /**
   * Адреса не режутся никогда. Молча обрезать адрес по границе ячейки нельзя — ровно эта беда уже
   * была с наименованием машины в ЭСМ-2 (ADR 0060), — а сокращать его правилом значит гадать, что в
   * «Московская обл., Волоколамский р-н, …» лишнее. Поэтому исход второй, и он **блокирующий**.
   */
  /**
   * Граница между «сократить и предупредить» и «не дать выписать» стоит там, где от адреса
   * остаётся меньше половины (Р11а). Обычный областной адрес её не переходит — и это главное:
   * до переработки такой лист **выписывался**, Excel уносил хвост за границу ячейки, но документ
   * существовал. Заменив молчаливое обрезание на запрет, портал отнял бы у диспетчера то, что он
   * делал вчера, и требовал бы сокращать адрес руками на каждом областном объекте.
   */
  it('областной адрес печатается сокращённым и попадает в свёрнутое, а не блокирует', () => {
    const from =
      'Московская область, Волоколамский городской округ, деревня Сычёво, карьер нерудных материалов, весовая № 2';
    const layout = taskRowLayout(freightRow({ from }), 'columns');

    expect(layout.ok).toBe(true);
    if (!layout.ok) return;
    // У обрыва виден обрыв: огрызок без многоточия водитель прочтёт как полный адрес.
    expect(layout.from.endsWith('…')).toBe(true);
    expect(layout.from.length).toBeLessThan(from.length);
    // Свёрнутое не исчезает: по нему выписка поднимет `task_row_overflow`, а письмо и кабинет
    // покажут адрес целиком.
    expect(layout.hidden).toContain(from);
  });

  /**
   * А вот патология блокирует. Адрес в заявке допускает тысячу знаков; обрезав такой по графе, мы
   * оставили бы одну область — по такому документу ехать некуда, и жечь на него номер бланка
   * незачем.
   */
  it('адрес, от которого осталось бы меньше половины, выписку блокирует', () => {
    const layout = taskRowLayout(freightRow({ from: 'Ш'.repeat(400) }), 'columns');

    expect(layout.ok).toBe(false);
    if (layout.ok) return;
    expect(layout.code).toBe('required_fields_overflow');
    expect(layout.fields).toEqual(['from']);
  });
});

describe('бюджет строки: общая ячейка строк 5–7', () => {
  /**
   * У строк 5–7 граф нет ни одной: адрес, груз и контакты делят одну объединённую ячейку блока
   * доп. задания (ADR 0068). Поэтому и мерить их надо вместе — по той самой строке, которую
   * соберёт `routeExtraTaskLine`, а не по каждому полю отдельно.
   */
  it('с длинными адресами не влезает и второй контакт', () => {
    const row = freightRow({
      from: 'Московская обл., Волоколамский городской округ, дер. Сычёво, карьер',
      to: 'Москва, ЖК «Северный», корпус 3, стройплощадка, ворота 4',
      contacts: [
        contact('Кузнецова Анна Владимировна', '+7 914 123-45-67'),
        contact('Петров Пётр Петрович', '+7 903 765-43-21'),
      ],
    });

    const columns = taskRowLayout(row, 'columns');
    const cell = taskRowLayout(row, 'single-cell');

    // В графах те же данные помещаются: там у контактов своя ячейка.
    expect(columns.ok && columns.hidden).toEqual([]);
    expect(cell.ok).toBe(true);
    if (!cell.ok) return;
    expect(cell.hidden.length).toBeGreaterThan(0);
    expect(cell.contacts).toMatch(/\+\d+$/mu);
  });

  it('короткие адреса пускают в ячейку оба контакта', () => {
    const layout = taskRowLayout(
      freightRow({
        from: 'Карьер',
        to: 'ЖК Северный',
        contacts: [
          contact('Иванов И.И.', '+7 916 123-45-67'),
          contact('Петров П.П.', '+7 903 765-43-21'),
        ],
      }),
      'single-cell',
    );

    expect(layout.ok).toBe(true);
    if (!layout.ok) return;
    expect(layout.hidden).toEqual([]);
    expect(layout.contacts).not.toMatch(/\+\d+$/mu);
  });

  /**
   * Обязательные поля могут не поместиться и вдвоём, поместившись поодиночке: ячейка одна на всё
   * задание. Комментарий уже отброшен, контакты уже свёрнуты — режется самое длинное из адресов,
   * и полный уходит в свёрнутое. Блокировать здесь нельзя по той же причине, что и в графах: до
   * переработки такая строка печаталась.
   */
  it('когда не помещаются и обязательные поля, режется самое длинное, а не блокируется', () => {
    const from =
      'Московская область, Волоколамский городской округ, деревня Сычёво, карьер нерудных материалов, весовая № 2, въезд со стороны Волоколамского шоссе';
    const to =
      'Москва, Северный административный округ, жилой комплекс «Северный», корпус 3, стройплощадка, ворота № 4';
    const layout = taskRowLayout(freightRow({ from, to }), 'single-cell');

    expect(layout.ok).toBe(true);
    if (!layout.ok) return;
    // Самое длинное — «откуда»: сокращать короткое, оставив рядом длинное, значит терять адрес
    // там, где он и так читался.
    expect(layout.hidden).toContain(from);
    expect(layout.from.endsWith('…')).toBe(true);
  });

  /** Патология блокирует и здесь — правило у ячейки и у граф одно. */
  it('поле, от которого осталось бы меньше половины, блокирует и в общей ячейке', () => {
    const layout = taskRowLayout(freightRow({ from: 'Ш'.repeat(400) }), 'single-cell');

    expect(layout.ok).toBe(false);
    if (layout.ok) return;
    expect(layout.fields).toContain('from');
  });
});

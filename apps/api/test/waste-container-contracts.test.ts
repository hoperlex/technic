import { describe, expect, it } from 'vitest';
import {
  assignWasteOperatorSchema,
  checkContainerOwner,
  containerOwnerMismatch,
  createWasteRequestSchema,
  MAX_CONTAINERS_PER_REQUEST,
  presentGroupLabel,
  usesContainerGroup,
  usesContainerType,
  wasteRequestListQuerySchema,
  wasteSubjectLabel,
} from '@technic/contracts';

/**
 * Контейнеры на объекте (ADR 0054): у единицы есть владелец — оператор её заявки установки, —
 * а заявка на замену и снятие несёт количество. Здесь проверяется то, что стоит на границе:
 * какие поля схема принимает у какого типа заявки и чем кончается расхождение «вывозит не тот,
 * кто привёз».
 *
 * Само присутствие считает БД (view `present_container_groups`), и сколько единиц осталось —
 * вопрос к ней, а не к схеме: она не знает ни объекта, ни того, что на нём стоит.
 */

const OBJECT_ID = '11111111-1111-4111-8111-111111111111';
const TYPE_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_A = '33333333-3333-4333-8333-333333333333';
const OPERATOR_B = '44444444-4444-4444-8444-444444444444';
const WASTE_TYPE_ID = '55555555-5555-4555-8555-555555555555';

/** Заявка на завтра к 10:00 МСК — рабочее окно и «не раньше сегодня» проверяются отдельно. */
function deliveryAt(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(7, 0, 0, 0);
  return d;
}

function removal(over: Record<string, unknown> = {}) {
  return {
    objectId: OBJECT_ID,
    requestType: 'container_removal',
    containerTypeId: TYPE_ID,
    containerOwnerCounterpartyId: OWNER_A,
    deliveryAt: deliveryAt(),
    responsibleName: 'Петров П. П.',
    responsiblePhone: '+7 900 000-00-01',
    ...over,
  };
}

describe('у каких операций есть владелец и количество', () => {
  it('только замена и снятие — установка привозит свой контейнер, вывоз их не касается', () => {
    expect(usesContainerGroup('container_replace')).toBe(true);
    expect(usesContainerGroup('container_removal')).toBe(true);
    expect(usesContainerGroup('container_install')).toBe(false);
    expect(usesContainerGroup('waste_removal')).toBe(false);
    expect(usesContainerGroup('metal_removal')).toBe(false);
  });

  // Тип контейнера — предмет контейнерных операций и только их: вывоз мусора техники не называет
  // (ADR 0022), у металлолома нет и её (ADR 0067).
  it('тип контейнера — предмет только контейнерных операций', () => {
    expect(usesContainerType('container_install')).toBe(true);
    expect(usesContainerType('container_replace')).toBe(true);
    expect(usesContainerType('container_removal')).toBe(true);
    expect(usesContainerType('waste_removal')).toBe(false);
    expect(usesContainerType('metal_removal')).toBe(false);
  });
});

describe('контракт заявки с контейнерами', () => {
  it('по умолчанию заявка снимает один контейнер', () => {
    expect(createWasteRequestSchema.parse(removal()).containersCount).toBe(1);
  });

  it('принимает количество в границах и отвергает вне их', () => {
    expect(createWasteRequestSchema.parse(removal({ containersCount: 3 })).containersCount).toBe(3);
    expect(() => createWasteRequestSchema.parse(removal({ containersCount: 0 }))).toThrow();
    expect(() =>
      createWasteRequestSchema.parse(removal({ containersCount: MAX_CONTAINERS_PER_REQUEST + 1 })),
    ).toThrow();
  });

  // Молча привести количество к единице значило бы потерять то, что человек ввёл руками, —
  // в отличие от техники у вывоза, которую отбрасывает сервер: её никто не вводил.
  it('не принимает количество и владельца у типов, где контейнер не стоит на объекте', () => {
    const install = { requestType: 'container_install', containerOwnerCounterpartyId: undefined };
    expect(() =>
      createWasteRequestSchema.parse(removal({ ...install, containersCount: 2 })),
    ).toThrow();
    expect(() =>
      createWasteRequestSchema.parse(
        removal({ requestType: 'container_install', containerOwnerCounterpartyId: OWNER_A }),
      ),
    ).toThrow();
    expect(() =>
      createWasteRequestSchema.parse(
        removal({
          requestType: 'waste_removal',
          containerTypeId: undefined,
          containerOwnerCounterpartyId: undefined,
          wasteTypeId: WASTE_TYPE_ID,
          volumeM3: 20,
          containersCount: 2,
        }),
      ),
    ).toThrow();
  });

  // Заявка на металлолом — самая короткая в модуле (ADR 0067): объект, дата, ответственный.
  // Ни контейнера, ни типа мусора, ни объёма у неё нет, и требовать их схема не должна.
  it('принимает вывоз металлолома без предмета заявки', () => {
    const parsed = createWasteRequestSchema.parse(
      removal({
        requestType: 'metal_removal',
        containerTypeId: undefined,
        containerOwnerCounterpartyId: undefined,
      }),
    );
    expect(parsed.requestType).toBe('metal_removal');
    expect(parsed.containerTypeId).toBeUndefined();
    expect(parsed.wasteTypeId).toBeUndefined();
    expect(parsed.volumeM3).toBeUndefined();
    expect(parsed.containersCount).toBe(1);
  });

  // Предмета у неё нет, а значит нет и строки предмета: «—» в списке честнее выдуманного
  // контейнера, которого заявка не заказывала.
  it('предмет заявки на металлолом пуст', () => {
    expect(
      wasteSubjectLabel({
        requestType: 'metal_removal',
        containerTypeName: null,
        containersCount: 1,
        volumeM3: null,
      }),
    ).toBe('—');
  });

  // Владельца может не быть: установку заводили без оператора, и группа «не указан» — обычная.
  it('принимает снятие без владельца', () => {
    const parsed = createWasteRequestSchema.parse(
      removal({ containerOwnerCounterpartyId: undefined }),
    );
    expect(parsed.containerOwnerCounterpartyId).toBeUndefined();
  });

  it('назначение оператора принимает причину вывоза чужого контейнера', () => {
    const parsed = assignWasteOperatorSchema.parse({
      operatorCounterpartyId: OPERATOR_B,
      ownerMismatchReason: '  контейнеры переданы по акту  ',
      version: 2,
    });
    expect(parsed.ownerMismatchReason).toBe('контейнеры переданы по акту');
    // Пустая причина — это не подтверждение: подтверждение и есть объяснение.
    expect(() =>
      assignWasteOperatorSchema.parse({
        operatorCounterpartyId: OPERATOR_B,
        ownerMismatchReason: '   ',
        version: 2,
      }),
    ).toThrow();
  });
});

describe('вывозит тот, кто привёз', () => {
  const subject = (over: Record<string, unknown> = {}) => ({
    requestType: 'container_removal' as const,
    operatorCounterpartyId: OPERATOR_B,
    containerOwnerCounterpartyId: OWNER_A,
    ...over,
  });

  it('свой контейнер снимает свой оператор — говорить не о чем', () => {
    const own = subject({ operatorCounterpartyId: OWNER_A });
    expect(containerOwnerMismatch(own)).toBe(false);
    expect(checkContainerOwner(own)).toBe('ok');
  });

  // Оба случая — «данных нет», а не «всё в порядке»: запрет здесь был бы запретом отсутствия
  // данных. Именно поэтому правило не встало колом на заявках, заведённых до ADR 0054.
  it('молчит, пока оператор не назначен или владелец не известен', () => {
    expect(checkContainerOwner(subject({ operatorCounterpartyId: null }))).toBe('ok');
    expect(checkContainerOwner(subject({ containerOwnerCounterpartyId: null }))).toBe('ok');
  });

  it('снятие чужого контейнера просит причину и проходит с ней', () => {
    expect(checkContainerOwner(subject())).toBe('reasonRequired');
    expect(checkContainerOwner(subject(), true)).toBe('reasonGiven');
  });

  // Замена чужого контейнера — смена владельца единицы на площадке, и одной заявкой она
  // описывается только ценой вранья в учёте.
  it('замену чужого контейнера не пропускает даже с причиной', () => {
    const replace = subject({ requestType: 'container_replace' });
    expect(checkContainerOwner(replace)).toBe('splitRequired');
    expect(checkContainerOwner(replace, true)).toBe('splitRequired');
  });

  it('к вывозу мусора и установке правило не относится', () => {
    expect(checkContainerOwner(subject({ requestType: 'waste_removal' }))).toBe('ok');
    expect(checkContainerOwner(subject({ requestType: 'container_install' }))).toBe('ok');
  });
});

describe('подписи для человека', () => {
  it('группа присутствия называет тип, владельца и количество', () => {
    expect(
      presentGroupLabel({
        containerTypeName: 'Контейнер 8 м³',
        ownerName: 'ООО «ЭкоТранс»',
        quantity: 2,
      }),
    ).toBe('Контейнер 8 м³ — ООО «ЭкоТранс» (2 шт.)');
    expect(
      presentGroupLabel({ containerTypeName: 'Контейнер 20 м³', ownerName: null, quantity: 1 }),
    ).toBe('Контейнер 20 м³ — оператор не указан (1 шт.)');
  });

  it('предмет заявки показывает количество, только когда контейнер не один', () => {
    const base = { requestType: 'container_removal' as const, volumeM3: null };
    expect(
      wasteSubjectLabel({ ...base, containerTypeName: 'Контейнер 8 м³', containersCount: 2 }),
    ).toBe('Контейнер 8 м³ × 2');
    expect(
      wasteSubjectLabel({ ...base, containerTypeName: 'Контейнер 8 м³', containersCount: 1 }),
    ).toBe('Контейнер 8 м³');
  });

  it('у вывоза мусора остаётся объём, а тип из старых заявок не показывается', () => {
    expect(
      wasteSubjectLabel({
        requestType: 'waste_removal',
        containerTypeName: 'Самосвал 25 м³',
        containersCount: 1,
        volumeM3: 20,
      }),
    ).toBe('20 м³');
  });
});

describe('фильтр списка по предмету', () => {
  // Вид целиком — свой параметр, а не значение `containerTypeId`: тот проверяется как uuid, и
  // слово «truck» в нём кончилось бы отказом схемы вместо отбора.
  it('вид принимается только известный', () => {
    expect(wasteRequestListQuerySchema.safeParse({ containerKind: 'cont' }).success).toBe(true);
    expect(wasteRequestListQuerySchema.safeParse({ containerKind: 'truck' }).success).toBe(true);
    expect(wasteRequestListQuerySchema.safeParse({ containerKind: 'все' }).success).toBe(false);
    expect(wasteRequestListQuerySchema.parse({}).containerKind).toBeUndefined();
  });

  it('вид и позиция справочника уживаются в одном запросе', () => {
    const q = wasteRequestListQuerySchema.parse({
      containerKind: 'cont',
      containerTypeId: TYPE_ID,
    });
    expect(q.containerKind).toBe('cont');
    expect(q.containerTypeId).toBe(TYPE_ID);
  });
});

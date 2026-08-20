import { describe, expect, it } from 'vitest';
import {
  busyWaybillForm,
  busyWaybillForms,
  type GarageBusyEntry,
  type GarageEsm2Busy,
  type GarageRouteBusy,
  type GarageSpecialBusy,
  type RoutePurpose,
  type VehicleOwnership,
  type WaybillFormCode,
} from '@technic/contracts';

/**
 * Бланк работы дня (план «Гараж: правки интерфейса», Р5–Р6).
 *
 * Правило отвечает на вопрос диспетчера «какую бумагу мне по этому дню вести», и ответом ему бланк,
 * которым работа **закрывается**, а не тот, который уже выписан: у заказа спецтехники листа на
 * текущую неделю может ещё не быть, а бланк у него всё равно один — ЭСМ-2.
 *
 * Проверяется здесь чистое правило, без базы: по нему пойдут и колонка, и фильтр вкладки, и
 * рассыпься оно — экран показал бы линейную машину в отборе «4-П» как единственную правду, спрятав
 * её от отбора «ЭСМ-2».
 */

function routeBusy(
  purpose: RoutePurpose,
  formCode: WaybillFormCode,
  ownership: VehicleOwnership = 'own',
): GarageRouteBusy {
  return {
    kind: 'route',
    routeId: 'route-1',
    displayNumber: 'Р-12',
    purpose,
    vehicleId: 'v-1',
    vehicleLabel: 'Е646СК799',
    vehicleModelName: 'КамАЗ 65201',
    vehicleOwnership: ownership,
    vehicleWaybillFormCode: formCode,
    driverPersonId: 'p-1',
    driverName: 'Иванов Иван Иванович',
    requests: [],
    moveFrom: '',
    moveTo: '',
    sourceRequest: null,
    waybill: null,
  };
}

function specialBusy(ownership: VehicleOwnership = 'own'): GarageSpecialBusy {
  return {
    kind: 'special',
    requestId: 'req-1',
    displayNumber: 'ТС-205',
    status: 'confirmed',
    customerName: 'Бета-объект',
    dateFrom: '2026-08-17',
    dateTo: '2026-08-23',
    vehicleId: 'v-2',
    vehicleLabel: 'В010ОР799',
    vehicleModelName: 'Экскаватор ЭО-2621',
    vehicleOwnership: ownership,
    // Бланк типа у машины стоит свой, и здесь он намеренно не 4-П: заказ спецтехники обязан
    // отвечать ЭСМ-2 независимо от того, чем закрывается рейс той же машины.
    vehicleWaybillFormCode: 'leg3',
    shift: null,
    earlyEndPending: false,
  };
}

function esm2Busy(ownership: VehicleOwnership = 'own'): GarageEsm2Busy {
  return {
    kind: 'esm2',
    waybillId: 'w-9',
    number: 'ЭСМ-00000004',
    status: 'issued',
    periodFrom: '2026-08-17',
    periodTo: '2026-08-23',
    vehicleId: 'v-1',
    vehicleLabel: 'Е646СК799',
    vehicleModelName: 'КамАЗ 65201',
    vehicleOwnership: ownership,
    vehicleWaybillFormCode: '4p',
    driverPersonId: 'p-1',
    driverName: 'Иванов Иван Иванович',
    sourceRequest: null,
  };
}

describe('бланк одной работы', () => {
  /**
   * Перегон идёт по 4-П любым типом: экскаватор едет по дорогам общего пользования как
   * транспортное средство, и документ у этой поездки один. Легковой бланк типа здесь взят
   * намеренно — если правило начнёт спрашивать тип, тест это увидит.
   */
  it('перегон — 4-П независимо от бланка типа', () => {
    expect(busyWaybillForm(routeBusy('delivery', 'leg3'))).toBe('4p');
    expect(busyWaybillForm(routeBusy('pickup', 'leg3'))).toBe('4p');
    expect(busyWaybillForm(routeBusy('delivery', '4p'))).toBe('4p');
  });

  it('грузовой рейс — бланком типа машины', () => {
    expect(busyWaybillForm(routeBusy('freight', 'leg3'))).toBe('leg3');
    expect(busyWaybillForm(routeBusy('freight', '4p'))).toBe('4p');
  });

  /**
   * Аренда бланка не имеет ни в одном из видов: лист на такую машину выписывает арендодатель.
   * Рейс на арендную машину сегодня не заводится (`assertRouteVehicle`), но правило обязано
   * читаться целиком здесь, а не «работать, пока где-то в другом файле держится ограничение».
   */
  it('арендная машина — бланка нет', () => {
    expect(busyWaybillForm(routeBusy('freight', '4p', 'rental'))).toBeNull();
    expect(busyWaybillForm(specialBusy('rental'))).toBeNull();
    expect(busyWaybillForm(esm2Busy('rental'))).toBeNull();
  });

  /**
   * Заказ спецтехники отвечает ЭСМ-2 даже без выписанного листа: в занятости он бывает только
   * нелинейный (ADR 0100 §12), а такой заказ ведётся недельными листами сам.
   */
  it('заказ спецтехники — ЭСМ-2, лист недели для этого не нужен', () => {
    expect(busyWaybillForm(specialBusy())).toBe('esm2');
  });

  it('недельный лист — ЭСМ-2', () => {
    expect(busyWaybillForm(esm2Busy())).toBe('esm2');
  });
});

describe('бланки дня', () => {
  /**
   * Два бланка в одном дне — обычный день линейного заказа: машина выехала рейсом (4-П) и работает
   * на площадке по листу ЭСМ-2, выписанному по требованию (ADR 0100, режим `on_demand`). Ради
   * такого дня ответ и стал набором.
   */
  it('рейс и недельный лист одного дня дают два бланка без повторов', () => {
    const day: GarageBusyEntry[] = [
      routeBusy('freight', '4p'),
      esm2Busy(),
      routeBusy('pickup', '4p'),
    ];
    expect(busyWaybillForms(day)).toEqual(['4p', 'esm2']);
  });

  it('свободный день — бланков нет вовсе', () => {
    expect(busyWaybillForms([])).toEqual([]);
    expect(busyWaybillForms([routeBusy('freight', '4p', 'rental')])).toEqual([]);
  });
});

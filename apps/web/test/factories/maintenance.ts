import {
  maintenanceState,
  type VehicleMaintenanceDto,
  type VehicleMaintenanceSummaryDto,
} from '@technic/contracts';

/**
 * Ответы модуля техобслуживания (план «Показания техники», Р10—Р14).
 *
 * Состояние в фабрике не задаётся руками, а считается `maintenanceState` — той же функцией, что
 * зовёт сервер (Р24). Причина не в экономии строк: впиши сюда `state: 'ok'` рядом с
 * `kmSince: 9 500`, и тест начал бы проверять портал на данных, которых сервер не отдаёт, — а
 * половина правил состояния как раз про то, какое число с каким флагом чем оказывается.
 */

/** Запись ТО: акт с датой, пробегом и номером; правок ещё не было (`updatedByName` пуст). */
export function maintenanceRecord(
  overrides: Partial<VehicleMaintenanceDto> = {},
): VehicleMaintenanceDto {
  return {
    id: 'm-1',
    vehicleId: 'v-1',
    performedOn: '2026-06-10',
    odometerKm: 120000,
    documentNumber: 'Акт № 128',
    note: '',
    // Скан акта приходит с именем, типом и размером — по ним форма и журнал рисуют ссылку.
    files: [],
    version: 0,
    createdAt: '2026-06-11T08:00:00.000Z',
    createdByName: 'Механиков Михаил Иванович',
    updatedAt: '2026-06-11T08:00:00.000Z',
    updatedByName: '',
    /*
     * Строк расхода нет, движений склада не было, акт действующий: три отдельных умолчания, а не
     * одно — строки снимали правкой, а движения по ним оставались навсегда (Р6).
     *
     * `parts` в фабрике живёт, потому что живёт в DTO: до заморозки (план
     * `docs/auto-part-receipts-plan.md`, Р22) сервер поле отдаёт, и ответ без него был бы не тем
     * ответом, который приходит порталу. Читать его портал перестал — на пустом массиве это и
     * проверяется.
     */
    parts: [],
    hasPartMovements: false,
    voidedAt: null,
    voidedByName: '',
    voidReason: '',
    ...overrides,
  };
}

/**
 * Сводка машины. По умолчанию — обслуженная машина с целой цепочкой показаний: 8 340 км с
 * последнего ТО, оба флага опущены.
 */
export function maintenanceSummary(
  overrides: Partial<VehicleMaintenanceSummaryDto> = {},
): VehicleMaintenanceSummaryDto {
  const base = {
    vehicleId: 'v-1',
    vehicleLabel: 'КамАЗ 65115 · А123ВС799',
    maintenanceBasis: 'odometer' as const,
    lastOdometer: { km: 128340, measuredOn: '2026-07-22' },
    lastMaintenance: maintenanceRecord(),
    kmSince: 8340,
    chainBroken: false,
    lowerBound: false,
    ...overrides,
  };
  return {
    ...base,
    // Состояние — ровно то, которое отдал бы сервер по этим же числам. Заданное явно уважается:
    // им проверяют, что портал показывает пришедшее, а не считает своё.
    state:
      overrides.state ??
      maintenanceState({
        basis: base.maintenanceBasis,
        kmSince: base.kmSince,
        chainBroken: base.chainBroken,
        lowerBound: base.lowerBound,
      }),
  };
}

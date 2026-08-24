import { describe, expect, it } from 'vitest';
import {
  ASSIGNMENT_CHANGE_ORIGINS,
  ASSIGNMENT_DIMENSIONS,
  ASSIGNMENT_HISTORY_STATES,
  ASSIGNMENT_OPERATION_OUTCOMES,
  ASSIGNMENT_SUPERSEDE_KINDS,
  DRIVER_STATE_KINDS,
  assignmentAcknowledgementsSchema,
  assignmentChangeTargetSchema,
  assignmentCommandSchema,
  changeVehicleAssignmentExtrasSchema,
  driverStateSchema,
  knownFillSchema,
  knownFillsSchema,
  machinistAnchorsSchema,
  operationInputSchema,
  periodApplySchema,
  periodPreviewSchema,
  repairSchema,
  tailResolutionSchema,
} from '@technic/contracts';

/**
 * Контракты периодов назначения (план `docs/assignment-periods-plan.md`, §7).
 *
 * Проверяется здесь ровно то, что схема и обязана решать сама: форма тела. Всё, для чего нужны
 * заявка, права и блокировка — исход операции (Р32), принадлежность машины, границы дыр `unknown`,
 * — остаётся серверу, и требовать этого от схемы значило бы завести вторую редакцию его правил.
 */

const PERSON = '11111111-1111-4111-8111-111111111111';
const OTHER_PERSON = '22222222-2222-4222-8222-222222222222';
const GROUP = '33333333-3333-4333-8333-333333333333';
const CHANGE = '44444444-4444-4444-8444-444444444444';
const OPERATION = '55555555-5555-4555-8555-555555555555';
const VEHICLE = '66666666-6666-4666-8666-666666666666';

const handshake = {
  version: 3,
  previewFingerprint: 'a'.repeat(64),
};

const operation = { operationId: OPERATION, reason: 'Восстановление истории по путевым листам' };

describe('словарь модели совпадает с DDL (§6)', () => {
  it('перечисления те же слова, что в CHECK таблицы', () => {
    expect(ASSIGNMENT_DIMENSIONS).toEqual(['vehicle', 'driver']);
    expect(DRIVER_STATE_KINDS).toEqual(['set', 'cleared', 'unknown']);
    expect(ASSIGNMENT_CHANGE_ORIGINS).toEqual([
      'assignment',
      'reassignment',
      'machinist_change',
      'backfill',
      'tail_resolution',
      'known_fill',
      'unknown_remainder',
    ]);
    expect(ASSIGNMENT_SUPERSEDE_KINDS).toEqual(['replaced', 'cancelled']);
    expect(ASSIGNMENT_HISTORY_STATES).toEqual(['empty', 'materialized', 'ready']);
    expect(ASSIGNMENT_OPERATION_OUTCOMES).toEqual(['none', 'assignment_tail', 'crew']);
  });

  it('состояние машиниста — union: `unknown` с названным человеком не собирается (Р19)', () => {
    expect(driverStateSchema.safeParse({ state: 'set', personId: PERSON }).success).toBe(true);
    expect(driverStateSchema.safeParse({ state: 'cleared' }).success).toBe(true);
    expect(driverStateSchema.safeParse({ state: 'unknown' }).success).toBe(true);
    expect(driverStateSchema.safeParse({ state: 'unknown', personId: PERSON }).success).toBe(false);
    expect(driverStateSchema.safeParse({ state: 'set' }).success).toBe(false);
  });
});

describe('envelope журнала (OperationInput)', () => {
  it('причина непуста: строка коррекции без объяснения физически невозможна', () => {
    expect(operationInputSchema.safeParse(operation).success).toBe(true);
    expect(operationInputSchema.safeParse({ operationId: OPERATION, reason: '   ' }).success).toBe(
      false,
    );
    expect(operationInputSchema.safeParse({ reason: 'без ключа' }).success).toBe(false);
  });
});

describe('якоря машиниста (Р16)', () => {
  it('принимает набор без верхнего предела: коррекция бывает и на дюжину границ (Б3)', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      effectiveDate: `2026-03-${String(i + 1).padStart(2, '0')}`,
      driverPersonId: PERSON,
    }));
    expect(machinistAnchorsSchema.safeParse(many).success).toBe(true);
  });

  it('две фамилии на одну дату — противоречие внутри тела', () => {
    const res = machinistAnchorsSchema.safeParse([
      { effectiveDate: '2026-03-01', driverPersonId: PERSON },
      { effectiveDate: '2026-03-01', driverPersonId: OTHER_PERSON },
    ]);
    expect(res.success).toBe(false);
  });

  it('пустой список отвергается: он ничего не сообщает', () => {
    expect(machinistAnchorsSchema.safeParse([]).success).toBe(false);
  });

  it('заявка в якоре не называется — якоря принимают только однозаявочные двери (Р22)', () => {
    const res = machinistAnchorsSchema.safeParse([
      { effectiveDate: '2026-03-01', driverPersonId: PERSON, requestId: CHANGE },
    ]);
    expect(res.success).toBe(false);
  });
});

describe('решение хвоста (Р31)', () => {
  it('ставки есть только у `history_wins`', () => {
    expect(tailResolutionSchema.safeParse({ kind: 'assignment_wins' }).success).toBe(true);
    expect(
      tailResolutionSchema.safeParse({ kind: 'assignment_wins', pricePerHour: 1200 }).success,
    ).toBe(false);
    expect(
      tailResolutionSchema.safeParse({ kind: 'history_wins', pricePerHour: 1200, shiftHours: 8 })
        .success,
    ).toBe(true);
  });

  it('ставки необязательны: «у арендной хотя бы одна» знает сервер, а не схема', () => {
    expect(tailResolutionSchema.safeParse({ kind: 'history_wins' }).success).toBe(true);
  });
});

describe('заполнение `unknown` — отрезок, а не перечень дней (Ц4)', () => {
  it('корректный отрезок принимается', () => {
    expect(
      knownFillSchema.safeParse({ from: '2026-01-01', to: '2026-03-31', personId: PERSON }).success,
    ).toBe(true);
  });

  it('конец раньше начала — отрезка не существует', () => {
    const res = knownFillSchema.safeParse({
      from: '2026-03-31',
      to: '2026-01-01',
      personId: PERSON,
    });
    expect(res.success).toBe(false);
    expect(res.error?.issues[0]?.path).toEqual(['to']);
  });

  it('один день — законный отрезок', () => {
    expect(
      knownFillSchema.safeParse({ from: '2026-01-01', to: '2026-01-01', personId: PERSON }).success,
    ).toBe(true);
  });

  it('пересечение отрезков отвергается: два человека на один день', () => {
    const res = knownFillsSchema.safeParse([
      { from: '2026-01-01', to: '2026-02-28', personId: PERSON },
      { from: '2026-02-01', to: '2026-03-31', personId: OTHER_PERSON },
    ]);
    expect(res.success).toBe(false);
  });

  it('соседние отрезки без пересечения проходят', () => {
    expect(
      knownFillsSchema.safeParse([
        { from: '2026-01-01', to: '2026-01-31', personId: PERSON },
        { from: '2026-02-01', to: '2026-02-28', personId: OTHER_PERSON },
      ]).success,
    ).toBe(true);
  });
});

describe('рукопожатие по каждому листу (Б4)', () => {
  it('ключ — номер листа в плане десятичной записью', () => {
    expect(
      assignmentAcknowledgementsSchema.safeParse({ '0': 'f'.repeat(64), '1': 'e'.repeat(64) })
        .success,
    ).toBe(true);
  });

  it('ведущий нуль отвергается: `01` и `1` подтвердили бы один лист дважды', () => {
    expect(assignmentAcknowledgementsSchema.safeParse({ '01': 'f'.repeat(64) }).success).toBe(
      false,
    );
  });

  it('нечисловой ключ отвергается', () => {
    expect(assignmentAcknowledgementsSchema.safeParse({ esm2: 'f'.repeat(64) }).success).toBe(
      false,
    );
  });
});

describe('цель команды (Р10)', () => {
  it('адресуется идентификатором или логическим ключом', () => {
    expect(assignmentChangeTargetSchema.safeParse({ changeId: CHANGE }).success).toBe(true);
    expect(
      assignmentChangeTargetSchema.safeParse({ dimension: 'vehicle', effectiveDate: '2026-04-01' })
        .success,
    ).toBe(true);
  });

  it('смешанная цель отвергается: два адреса одной строки могут разойтись', () => {
    expect(
      assignmentChangeTargetSchema.safeParse({
        changeId: CHANGE,
        dimension: 'vehicle',
        effectiveDate: '2026-04-01',
      }).success,
    ).toBe(false);
  });
});

describe('команда истории: две формы, а не три (Р13)', () => {
  it('`set` меняет только машиниста', () => {
    const res = assignmentCommandSchema.safeParse({
      ...handshake,
      kind: 'set',
      dimension: 'driver',
      effectiveDate: '2026-03-16',
      driverPersonId: PERSON,
    });
    expect(res.success).toBe(true);
  });

  it('`set` шкалы `vehicle` этой дверью не ходит — машину меняют своей (Р7)', () => {
    expect(
      assignmentCommandSchema.safeParse({
        ...handshake,
        kind: 'set',
        dimension: 'vehicle',
        effectiveDate: '2026-03-16',
        vehicleId: VEHICLE,
      }).success,
    ).toBe(false);
  });

  it('`set` без человека отвергается: снятие машиниста — спутник смены техники, а не команда', () => {
    expect(
      assignmentCommandSchema.safeParse({
        ...handshake,
        kind: 'set',
        dimension: 'driver',
        effectiveDate: '2026-03-16',
        driverPersonId: null,
      }).success,
    ).toBe(false);
  });

  it('`cancel` носит цель и то же рукопожатие: отмена тратит бланки так же, как заведение', () => {
    const res = assignmentCommandSchema.safeParse({
      ...handshake,
      kind: 'cancel',
      target: { dimension: 'vehicle', effectiveDate: '2026-04-01' },
      unlockFingerprint: 'b'.repeat(64),
      acknowledgements: { '0': 'c'.repeat(64) },
      operation,
    });
    expect(res.success).toBe(true);
  });

  it('отпечаток необязателен в схеме: первый вызов предпросмотра его и вычисляет', () => {
    expect(
      assignmentCommandSchema.safeParse({
        version: 3,
        kind: 'set',
        dimension: 'driver',
        effectiveDate: '2026-03-16',
        driverPersonId: PERSON,
      }).success,
    ).toBe(true);
  });

  it('версия обязательна всегда: без неё команда не знает, что переписывает', () => {
    expect(
      assignmentCommandSchema.safeParse({
        kind: 'set',
        dimension: 'driver',
        effectiveDate: '2026-03-16',
        driverPersonId: PERSON,
      }).success,
    ).toBe(false);
  });
});

describe('дверь ремонта: две взаимоисключающие ветки (Ю1)', () => {
  it('ремонт с якорями и решением хвоста — законное тело', () => {
    const res = repairSchema.safeParse({
      ...handshake,
      mode: 'repair',
      anchors: [{ effectiveDate: '2026-03-01', driverPersonId: PERSON }],
      tailResolution: { kind: 'assignment_wins' },
      operation,
    });
    expect(res.success).toBe(true);
  });

  it('ремонт с заполнением `unknown` и восстановлением из архива — тоже', () => {
    const res = repairSchema.safeParse({
      ...handshake,
      mode: 'repair',
      restore: true,
      knownFills: [{ from: '2026-01-01', to: '2026-01-31', personId: PERSON }],
      operation,
    });
    expect(res.success).toBe(true);
  });

  it('отмена заполнения — законное тело своей ветки', () => {
    const res = cancelFillBody();
    expect(repairSchema.safeParse(res).success).toBe(true);
  });

  it('ремонт без единой работы отвергается: причина без предмета в журнале не нужна', () => {
    const res = repairSchema.safeParse({ ...handshake, mode: 'repair', operation });
    expect(res.success).toBe(false);
  });

  it('`restore` работой не считается: снятие архива делает своя ручка', () => {
    expect(
      repairSchema.safeParse({ ...handshake, mode: 'repair', restore: true, operation }).success,
    ).toBe(false);
  });

  it('`cancel_fill` вместе с `knownFills` отвергается: смысл команды выяснялся бы по составу тела', () => {
    const res = repairSchema.safeParse({
      ...cancelFillBody(),
      knownFills: [{ from: '2026-01-01', to: '2026-01-31', personId: PERSON }],
    });
    expect(res.success).toBe(false);
  });

  it('`cancel_fill` вместе с якорями отвергается по той же причине', () => {
    const res = repairSchema.safeParse({
      ...cancelFillBody(),
      anchors: [{ effectiveDate: '2026-03-01', driverPersonId: PERSON }],
    });
    expect(res.success).toBe(false);
  });

  it('`cancel_fill` вместе с решением хвоста отвергается по той же причине', () => {
    const res = repairSchema.safeParse({
      ...cancelFillBody(),
      tailResolution: { kind: 'assignment_wins' },
    });
    expect(res.success).toBe(false);
  });

  it('`cancel_fill` без цели отвергается: снимать нечего', () => {
    const { target: _target, ...rest } = cancelFillBody();
    expect(repairSchema.safeParse(rest).success).toBe(false);
  });

  it('`target` в ветке ремонта отвергается: восстановление цели не имеет', () => {
    const res = repairSchema.safeParse({
      ...handshake,
      mode: 'repair',
      anchors: [{ effectiveDate: '2026-03-01', driverPersonId: PERSON }],
      target: { changeGroupId: GROUP },
    });
    expect(res.success).toBe(false);
  });

  it('режим обязателен: без него ветку выбирать нечем', () => {
    expect(repairSchema.safeParse({ ...handshake, anchors: [] }).success).toBe(false);
  });

  it('общая часть у веток одна: рукопожатия нужны отмене ровно так же', () => {
    const res = repairSchema.safeParse({
      ...cancelFillBody(),
      restore: true,
      unlockFingerprint: 'b'.repeat(64),
      acknowledgements: { '0': 'c'.repeat(64) },
    });
    expect(res.success).toBe(true);
  });
});

function cancelFillBody() {
  return {
    ...handshake,
    mode: 'cancel_fill' as const,
    target: { changeGroupId: GROUP },
    operation,
  };
}

/**
 * Блок смены техники — только то, что периоды назначения добавляют существующему телу
 * `changeVehicleAssignmentSchema`: машина, ставки, рейс и версия остаются там, где и были.
 */
describe('блок смены техники', () => {
  it('несёт якоря, оба отпечатка часов и коррекционную цель', () => {
    const res = changeVehicleAssignmentExtrasSchema.safeParse({
      previewFingerprint: 'a'.repeat(64),
      anchors: [{ effectiveDate: '2026-03-01', driverPersonId: PERSON }],
      clearedShiftsFingerprint: 'd'.repeat(64),
      unlockFingerprint: 'b'.repeat(64),
      correction: { target: { changeId: CHANGE } },
      operation,
    });
    expect(res.success).toBe(true);
  });

  it('версии в блоке нет: её несёт та же схема, что машину и ставки', () => {
    expect(
      changeVehicleAssignmentExtrasSchema.safeParse({
        previewFingerprint: 'a'.repeat(64),
        version: 3,
      }).success,
    ).toBe(false);
  });

  it('списка разблокировок полем HTTP не бывает — только отпечаток (В1)', () => {
    expect(
      changeVehicleAssignmentExtrasSchema.safeParse({
        previewFingerprint: 'a'.repeat(64),
        unlockWaybillIds: [CHANGE],
      }).success,
    ).toBe(false);
  });

  it('причина внутрь коррекционного блока не входит: она общая у всех команд', () => {
    expect(
      changeVehicleAssignmentExtrasSchema.safeParse({
        previewFingerprint: 'a'.repeat(64),
        correction: { target: { changeId: CHANGE }, reason: 'ехала другая' },
      }).success,
    ).toBe(false);
  });
});

describe('дверь срока', () => {
  it('предпросмотр знает только семантику: версия и границы', () => {
    expect(periodPreviewSchema.safeParse({ version: 2, dateTo: '2026-04-30' }).success).toBe(true);
    expect(periodPreviewSchema.safeParse({ version: 2, dateTo: null }).success).toBe(true);
  });

  it('предпросмотр отпечатка не принимает — он его вычисляет (Л1)', () => {
    expect(
      periodPreviewSchema.safeParse({ version: 2, previewFingerprint: 'a'.repeat(64) }).success,
    ).toBe(false);
  });

  it('боевое тело носит отпечаток и подтверждение погашаемых групп (Д2)', () => {
    const res = periodApplySchema.safeParse({
      version: 2,
      dateTo: '2026-03-31',
      previewFingerprint: 'a'.repeat(64),
      cancelGroupsFingerprint: 'e'.repeat(64),
      operation,
    });
    expect(res.success).toBe(true);

    /*
     * Отпечаток необязателен **в схеме** и обязателен на сервере — как у команды машиниста и
     * коррекции. Разница видна человеку: тело без отпечатка получает 409 «посмотрите последствия
     * заново», а не 400 «поле обязательно». Первое объясняет, что делать; второе выглядит поломкой
     * клиента. Само требование держит шаг 7 канона, и его проверяет db-тест двери.
     */
    expect(periodApplySchema.safeParse({ version: 2, dateTo: '2026-03-31' }).success).toBe(true);
    // Пустой отпечаток схема по-прежнему не пропускает: это не «нет отпечатка», а испорченный.
    expect(
      periodApplySchema.safeParse({ version: 2, dateTo: '2026-03-31', previewFingerprint: '  ' })
        .success,
    ).toBe(false);
  });

  it('старых полей заднего числа в теле нет: они переехали в общий `operation`', () => {
    expect(
      periodApplySchema.safeParse({
        version: 2,
        dateTo: '2026-03-31',
        previewFingerprint: 'a'.repeat(64),
        backdateReason: 'продлили задним числом',
      }).success,
    ).toBe(false);
  });
});

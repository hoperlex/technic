import { describe, expect, it, vi } from 'vitest';
import { MAX_ASSIGNED_GRANTS, type GrantStatement, type Permission } from '@technic/contracts';
// Только типы: значения модуля берутся ниже через `await import`, уже после подмены соединения.
import type {
  AssignedGrant,
  GrantStatementIssueCode,
  PlannedGrant,
} from '../src/services/grant-catalog';

// База подменена, и это не срез углов: проверяемые функции её не касаются вовсе — состояние им
// приносит вызывающий, прочитав его под блокировками. Соседний модуль (`user-scopes`) держит
// соединение значением, а конфиг проверяет окружение при импорте, — подмена снимает и то и другое
// тем же приёмом, каким это сделано у механики обмена справочником.
vi.mock('../src/db/client', () => ({ db: {} }));
// Модуль сессий подменён по той же причине и тем же приёмом. `user-scopes` с ADR 0144 гасит сессии
// сам, в своей транзакции, поэтому импортирует `auth/sessions`, а тот читает конфиг при загрузке —
// и валится на пустом окружении, куда бы его ни притащили. Проверяемого здесь он не касается вовсе.
vi.mock('../src/auth/sessions', () => ({ revokeAllForUsersTx: async () => {} }));

const {
  assertGrantVersions,
  assignedGrantLimitIssue,
  attributeGrantDelta,
  grantOperationOutcome,
  grantSubjectOf,
  planGrantStatements,
} = await import('../src/services/grant-catalog');

/*
 * Высказывание о полномочиях в теле учётки (план «полномочия назначаются в окне учётки», §4–§5):
 * диапазон разницы, полнота, границы молчания, версии, барьеры итога и раскладка дельты.
 *
 * Без базы, и это не экономия на db-тесте: правил здесь шесть, они переплетены, и каждое из них —
 * отказ, который иначе выясняется в бою. Маршрут читает состояние под блокировками и приносит его
 * сюда готовым, поэтому проверять их построчно можно и нужно тем же способом, каким проверяется
 * дифф учётки (`user-audit-diff.test.ts`).
 */

// Идентификаторы упорядочены как строки: по ним же считается порядок событий журнала и порядок
// захвата блокировок, поэтому «первый» и «второй» в тестах — это именно A и B.
const ID = {
  a: '11111111-1111-4111-8111-111111111111',
  b: '22222222-2222-4222-8222-222222222222',
  c: '33333333-3333-4333-8333-333333333333',
} as const;

function grant(id: string, over: Partial<PlannedGrant> = {}): PlannedGrant {
  return {
    id,
    code: `grant_${id.slice(0, 1)}`,
    name: `Набор ${id.slice(0, 1)}`,
    version: 1,
    permissions: [],
    roles: [],
    ...over,
  };
}

function held(id: string, over: Partial<AssignedGrant> = {}): AssignedGrant {
  return {
    ...grant(id, over),
    assignmentId: `assignment-${id}`,
    origin: 'manual',
    ...over,
  };
}

function said(id: string, selected: boolean, version = 1): GrantStatement {
  return { id, version, selected };
}

function catalogOf(...list: PlannedGrant[]): Map<string, PlannedGrant> {
  return new Map(list.map((item) => [item.id, item]));
}

function codes(
  violations: readonly { code: GrantStatementIssueCode }[],
): GrantStatementIssueCode[] {
  return violations.map((violation) => violation.code);
}

describe('диапазон разницы и снятие (Р4)', () => {
  it('снимает управляемое назначение и не трогает несовместимое с итоговой ролью', () => {
    const managed = held(ID.a, { roles: ['site'] });
    const outside = held(ID.b, { roles: ['shtab'] });
    const plan = planGrantStatements({
      assignments: [managed, outside],
      roleBefore: 'site',
      roleAfter: 'site',
      // Про несовместимое назначение форма не высказывается вовсе: оно вне диапазона, и операция о
      // нём ничего не решает.
      statements: [said(ID.a, false)],
      catalog: catalogOf(),
    });
    expect(plan.violations).toEqual([]);
    expect(plan.toRevoke.map((row) => row.id)).toEqual([ID.a]);
    expect(plan.toAssign).toEqual([]);
    expect(plan.grantsAfter.map((row) => row.id)).toEqual([ID.b]);
  });

  it('выдаёт отмеченный набор из каталога и оставляет уже выданный', () => {
    const kept = held(ID.a, { roles: ['site'] });
    const fresh = grant(ID.c, { roles: ['site'] });
    const plan = planGrantStatements({
      assignments: [kept],
      roleBefore: 'site',
      roleAfter: 'site',
      statements: [said(ID.a, true), said(ID.c, true)],
      catalog: catalogOf(fresh),
    });
    expect(plan.violations).toEqual([]);
    expect(plan.toAssign.map((row) => row.id)).toEqual([ID.c]);
    expect(plan.toRevoke).toEqual([]);
    expect(plan.grantsAfter.map((row) => row.id)).toEqual([ID.a, ID.c]);
  });

  it('отмеченный набор вне диапазона итоговой роли отклоняется, а не выдаётся', () => {
    const plan = planGrantStatements({
      assignments: [],
      roleBefore: 'shtab',
      roleAfter: 'shtab',
      statements: [said(ID.c, true)],
      catalog: catalogOf(grant(ID.c, { roles: ['site'] })),
    });
    expect(codes(plan.violations)).toEqual(['incompatible']);
    expect(plan.toAssign).toEqual([]);
  });

  it('набора, названного отмеченным, больше нет — гонка с удалением, а не ошибка ввода', () => {
    const plan = planGrantStatements({
      assignments: [],
      roleBefore: 'site',
      roleAfter: 'site',
      statements: [said(ID.c, true)],
      catalog: catalogOf(),
    });
    expect(codes(plan.violations)).toEqual(['unknown']);
    expect(plan.violations[0]!.grants).toEqual([{ id: ID.c, name: null }]);
  });
});

describe('взведённое переводом ролей не снимается формой (Р4, §4.3)', () => {
  it('снятие управляемого `origin = migration` отклоняется до расчёта разницы', () => {
    const migrated = held(ID.a, { roles: ['site'], origin: 'migration' });
    const plan = planGrantStatements({
      assignments: [migrated],
      roleBefore: 'site',
      roleAfter: 'site',
      statements: [said(ID.a, false)],
      catalog: catalogOf(),
    });
    expect(codes(plan.violations)).toEqual(['migration_locked']);
    // Не вычитание из разницы: снятия не происходит вовсе, и состояние остаётся прежним.
    expect(plan.toRevoke).toEqual([]);
    expect(plan.grantsAfter.map((row) => row.id)).toEqual([ID.a]);
  });

  it('то же назначение вне диапазона роли гаснет без отказа: снимать его никто не просит', () => {
    const migrated = held(ID.a, { roles: ['site'], origin: 'migration' });
    const plan = planGrantStatements({
      assignments: [migrated],
      roleBefore: 'site',
      roleAfter: 'shtab',
      // Строка обязана прийти (назначение переключается сменой роли), и `false` здесь —
      // подтверждение гашения, а не команда снять.
      statements: [said(ID.a, false)],
      catalog: catalogOf(),
    });
    expect(plan.violations).toEqual([]);
    expect(plan.toRevoke).toEqual([]);
    expect(plan.grantsAfter.map((row) => row.id)).toEqual([ID.a]);
  });
});

describe('полнота высказывания (§4.2)', () => {
  it('управляемое назначение, не названное в теле, — отказ, а не тихий отзыв', () => {
    const plan = planGrantStatements({
      assignments: [held(ID.a, { roles: ['site'] })],
      roleBefore: 'site',
      roleAfter: 'site',
      statements: [],
      catalog: catalogOf(),
    });
    expect(codes(plan.violations)).toEqual(['incomplete']);
    expect(plan.violations[0]!.grants).toEqual([{ id: ID.a, name: 'Набор 1' }]);
    expect(plan.toRevoke).toEqual([]);
  });

  it('то же назначение, названное `selected: false`, снимается: «не показали» и «сняли» различимы', () => {
    const plan = planGrantStatements({
      assignments: [held(ID.a, { roles: ['site'] })],
      roleBefore: 'site',
      roleAfter: 'site',
      statements: [said(ID.a, false)],
      catalog: catalogOf(),
    });
    expect(plan.violations).toEqual([]);
    expect(plan.toRevoke.map((row) => row.id)).toEqual([ID.a]);
  });

  it('переключаемое сменой роли назначение обязано быть названо, хоть оно и вне диапазона', () => {
    const plan = planGrantStatements({
      assignments: [held(ID.a, { roles: ['site'] })],
      roleBefore: 'site',
      roleAfter: 'shtab',
      statements: [],
      catalog: catalogOf(),
    });
    expect(codes(plan.violations)).toEqual(['incomplete']);
  });

  it('пустое тело законно, когда высказываться не о чем', () => {
    const plan = planGrantStatements({
      assignments: [held(ID.b, { roles: ['shtab'] })],
      roleBefore: 'site',
      roleAfter: 'site',
      statements: [],
      catalog: catalogOf(),
    });
    expect(plan.violations).toEqual([]);
    expect(plan.grantsAfter.map((row) => row.id)).toEqual([ID.b]);
  });

  it('полномочия без роли не выдаются: сначала должность', () => {
    const plan = planGrantStatements({
      assignments: [],
      roleBefore: null,
      roleAfter: null,
      statements: [said(ID.c, true)],
      catalog: catalogOf(grant(ID.c, { roles: ['site'] })),
    });
    expect(codes(plan.violations)).toEqual(['role_required']);
  });
});

describe('границы молчания (§4.2)', () => {
  it('запроса без поля достаточно, пока роль не меняет действие назначений', () => {
    const plan = planGrantStatements({
      assignments: [held(ID.a, { roles: ['site'] })],
      roleBefore: 'site',
      roleAfter: 'site',
      statements: undefined,
      catalog: catalogOf(),
    });
    expect(plan.violations).toEqual([]);
    expect(plan.toAssign).toEqual([]);
    expect(plan.toRevoke).toEqual([]);
    expect(plan.grantsAfter.map((row) => row.id)).toEqual([ID.a]);
  });

  it('молчание не зажигает состав: `shtab → site` отклоняется и называет набор', () => {
    const plan = planGrantStatements({
      assignments: [held(ID.a, { roles: ['site'] })],
      roleBefore: 'shtab',
      roleAfter: 'site',
      statements: undefined,
      catalog: catalogOf(),
    });
    expect(codes(plan.violations)).toEqual(['silence_forbidden']);
    expect(plan.violations[0]!.grants).toEqual([{ id: ID.a, name: 'Набор 1' }]);
  });

  it('молчание не гасит состав: обратный переход отклоняется тем же правилом', () => {
    const plan = planGrantStatements({
      assignments: [held(ID.a, { roles: ['site'] })],
      roleBefore: 'site',
      roleAfter: 'shtab',
      statements: undefined,
      catalog: catalogOf(),
    });
    expect(codes(plan.violations)).toEqual(['silence_forbidden']);
  });

  it('смена роли молчанием не задевает назначение, несовместимое с обеими ролями', () => {
    const plan = planGrantStatements({
      assignments: [held(ID.a, { roles: ['department'] })],
      roleBefore: 'site',
      roleAfter: 'shtab',
      statements: undefined,
      catalog: catalogOf(),
    });
    expect(plan.violations).toEqual([]);
  });
});

describe('версии участвующих наборов (Р7)', () => {
  it('сверяются выдаваемые, снимаемые и переключаемые — а соседний набор не мешает', () => {
    const revoked = held(ID.a, { roles: ['site'], version: 4 });
    const toggling = held(ID.b, { roles: ['site'], version: 7 });
    const fresh = grant(ID.c, { roles: ['site'], version: 2 });
    const plan = planGrantStatements({
      assignments: [
        revoked,
        toggling,
        held('44444444-4444-4444-8444-444444444444', { roles: ['shtab', 'site'], version: 9 }),
      ],
      roleBefore: 'shtab',
      roleAfter: 'site',
      statements: [
        said(ID.a, false, 4),
        said(ID.b, true, 7),
        said(ID.c, true, 2),
        // Сосед совместим с обеими ролями и остаётся как есть: его версию операция не сверяет,
        // иначе чужая правка соседнего набора заставляла бы переоткрывать форму.
        said('44444444-4444-4444-8444-444444444444', true, 1),
      ],
      catalog: catalogOf(fresh),
    });
    expect(plan.violations).toEqual([]);
    expect(plan.versionsToCheck.map((check) => check.grantId)).toEqual([ID.a, ID.b, ID.c]);
    expect(plan.versionsToCheck.map((check) => check.expected)).toEqual([4, 7, 2]);
  });

  it('гасимое сменой роли назначение тоже сверяется: подтверждают состав, который перестаёт действовать', () => {
    const plan = planGrantStatements({
      assignments: [held(ID.a, { roles: ['site'], version: 3 })],
      roleBefore: 'site',
      roleAfter: 'shtab',
      statements: [said(ID.a, false, 3)],
      catalog: catalogOf(),
    });
    expect(plan.versionsToCheck).toEqual([
      { grantId: ID.a, name: 'Набор 1', expected: 3, actual: 3 },
    ]);
  });

  it('разошедшаяся версия — 409 с именем набора, совпавшая проходит молча', () => {
    expect(() =>
      assertGrantVersions([{ grantId: ID.a, name: 'Заказ техники', expected: 2, actual: 3 }]),
    ).toThrowError(/Заказ техники/);
    expect(() =>
      assertGrantVersions([{ grantId: ID.a, name: 'Заказ техники', expected: 3, actual: 3 }]),
    ).not.toThrow();
  });
});

describe('предел назначений по итогу (§4.2)', () => {
  it('итог ровно в пределе законен, а следующее назначение отклоняется', () => {
    expect(assignedGrantLimitIssue(MAX_ASSIGNED_GRANTS)).toBeNull();
    expect(assignedGrantLimitIssue(MAX_ASSIGNED_GRANTS + 1)).toContain(String(MAX_ASSIGNED_GRANTS));
  });

  it('план считает предел по итогу, а не по длине высказывания', () => {
    // Полная замена: снимается столько же, сколько выдаётся, — итог остаётся в пределе, хотя строк
    // в теле вдвое больше.
    const assignments = Array.from({ length: MAX_ASSIGNED_GRANTS }, (_unused, index) =>
      held(`aaaaaaaa-0000-4000-8000-${String(index).padStart(12, '0')}`, { roles: ['site'] }),
    );
    const fresh = Array.from({ length: MAX_ASSIGNED_GRANTS }, (_unused, index) =>
      grant(`bbbbbbbb-0000-4000-8000-${String(index).padStart(12, '0')}`, { roles: ['site'] }),
    );
    const replacement = planGrantStatements({
      assignments,
      roleBefore: 'site',
      roleAfter: 'site',
      statements: [
        ...assignments.map((row) => said(row.id, false)),
        ...fresh.map((row) => said(row.id, true)),
      ],
      catalog: catalogOf(...fresh),
    });
    expect(replacement.violations).toEqual([]);
    expect(replacement.grantsAfter).toHaveLength(MAX_ASSIGNED_GRANTS);

    const overflow = planGrantStatements({
      assignments,
      roleBefore: 'site',
      roleAfter: 'site',
      statements: [...assignments.map((row) => said(row.id, true)), said(fresh[0]!.id, true)],
      catalog: catalogOf(...fresh),
    });
    expect(codes(overflow.violations)).toEqual(['limit_exceeded']);
    expect(overflow.toAssign).toEqual([]);
  });
});

describe('итог субъекта считается с гейтом совместимости (Р5)', () => {
  const estimate: Permission = 'serviceRequests.estimate';
  const approveEstimate: Permission = 'serviceRequests.approveEstimate';

  it('набор, несовместимый с новой ролью, прав не даёт', () => {
    const subject = grantSubjectOf({
      role: 'shtab',
      counterpartyType: null,
      grants: [grant(ID.a, { roles: ['site'], permissions: [estimate] })],
    });
    expect(subject.grantPermissions).toEqual([]);
  });

  it('конфликт обязанностей ловится суммой двух наборов, а не составом одного', () => {
    const first = grant(ID.a, { roles: ['manager'], permissions: [estimate] });
    const second = grant(ID.b, { roles: ['manager'], permissions: [approveEstimate] });
    const outcome = grantOperationOutcome({
      before: { role: 'manager', counterpartyType: null, grants: [first] },
      after: { role: 'manager', counterpartyType: null, grants: [first, second] },
      assigned: [second],
    });
    expect(outcome.violations.map((violation) => violation.code)).toEqual(['duty_conflict']);
    // Барьер итога не приписан набору: половину пары даёт первый набор, и виновником назван бы не тот.
    expect(outcome.violations[0]!.message).not.toContain('Набор 2');
  });

  it('тот же конфликт не возникает, если второй набор новой роли не действует', () => {
    const first = grant(ID.a, { roles: ['manager'], permissions: [estimate] });
    const second = grant(ID.b, { roles: ['site'], permissions: [approveEstimate] });
    const outcome = grantOperationOutcome({
      before: { role: 'manager', counterpartyType: null, grants: [first] },
      after: { role: 'manager', counterpartyType: null, grants: [first, second] },
      assigned: [],
    });
    expect(outcome.violations).toEqual([]);
    expect(outcome.delta).toEqual({ added: [], removed: [] });
  });

  it('барьер требований считается по итогу и называет недостающее право', () => {
    const mailings = grant(ID.a, { roles: ['manager'], permissions: ['mailings.manage'] });
    const outcome = grantOperationOutcome({
      before: { role: 'manager', counterpartyType: null, grants: [] },
      after: { role: 'manager', counterpartyType: null, grants: [mailings] },
      assigned: [mailings],
    });
    expect(outcome.violations.map((violation) => violation.code)).toEqual(['requirement_missing']);
    expect(outcome.violations[0]!.requires).toBe('mailings.read');
  });

  it('роль водителя полномочий не принимает, и барьер называет причину', () => {
    const broken = grant(ID.a, { roles: ['driver'], permissions: [] });
    const outcome = grantOperationOutcome({
      before: { role: 'driver', counterpartyType: null, grants: [] },
      after: { role: 'driver', counterpartyType: null, grants: [broken] },
      assigned: [broken],
    });
    expect(outcome.violations.map((violation) => violation.code)).toEqual(['role_not_grantable']);
  });

  it('смена роли зажигает состав выданного набора — без единой выдачи', () => {
    // Право взято такое, которого нет ни у одной из двух ролей: иначе «зажёг набор» неотличимо от
    // «дала роль», и тест подтверждал бы не гейт, а матрицу.
    const audit = grant(ID.a, { roles: ['site'], permissions: ['audit.read'] });
    const lit = grantOperationOutcome({
      before: { role: 'shtab', counterpartyType: null, grants: [audit] },
      after: { role: 'site', counterpartyType: null, grants: [audit] },
      assigned: [],
    });
    expect(lit.permissionsAfter).toContain('audit.read');
    expect(lit.delta.added).toContain('audit.read');

    // Обратный переход тем же гейтом состав гасит, а строку назначения не трогает вовсе.
    const dimmed = grantOperationOutcome({
      before: { role: 'site', counterpartyType: null, grants: [audit] },
      after: { role: 'shtab', counterpartyType: null, grants: [audit] },
      assigned: [],
    });
    expect(dimmed.permissionsAfter).not.toContain('audit.read');
    expect(dimmed.delta.removed).toContain('audit.read');
  });
});

describe('раскладка итоговой дельты по событиям (§5.2)', () => {
  const read: Permission = 'vehicleRequests.read';
  const create: Permission = 'vehicleRequests.create';
  const approve: Permission = 'vehicleRequests.approve';

  it('замена набора с общим правом не пишет по нему ни «снято», ни «добавлено»', () => {
    const events = attributeGrantDelta({
      // Итоговая дельта: общее право не появилось и не ушло — доступ не прерывался ни на мгновение.
      delta: { added: [create], removed: [approve] },
      revoked: [{ id: ID.a, permissions: [read, approve] }],
      assigned: [{ id: ID.b, permissions: [read, create] }],
    });
    expect(events).toEqual([
      { operation: 'revoke', grantId: ID.a, added: [], removed: [approve] },
      { operation: 'assign', grantId: ID.b, added: [create], removed: [] },
    ]);
  });

  it('право, которое дают два выдаваемых набора, попадает в событие первого по `grant_id`', () => {
    const events = attributeGrantDelta({
      delta: { added: [read, create], removed: [] },
      revoked: [],
      assigned: [
        { id: ID.b, permissions: [read, create] },
        { id: ID.a, permissions: [read] },
      ],
    });
    expect(events).toEqual([
      { operation: 'assign', grantId: ID.a, added: [read], removed: [] },
      // «Сверх уже имеющегося не дал» — пустая добавка, а не повтор права.
      { operation: 'assign', grantId: ID.b, added: [create], removed: [] },
    ]);
  });

  it('отзывы идут до выдач, а сумма событий равна итоговой дельте без погашений', () => {
    const events = attributeGrantDelta({
      delta: { added: [create], removed: [approve] },
      revoked: [
        { id: ID.c, permissions: [approve] },
        { id: ID.b, permissions: [] },
      ],
      assigned: [{ id: ID.a, permissions: [create] }],
    });
    expect(events.map((event) => [event.operation, event.grantId])).toEqual([
      ['revoke', ID.b],
      ['revoke', ID.c],
      ['assign', ID.a],
    ]);
    expect(events.flatMap((event) => event.removed)).toEqual([approve]);
    expect(events.flatMap((event) => event.added)).toEqual([create]);
  });

  it('право, ушедшее не из-за набора, не приписывается ни одному событию', () => {
    const events = attributeGrantDelta({
      // Право отобрала смена роли: снятый набор его не давал вовсе.
      delta: { added: [], removed: [approve] },
      revoked: [{ id: ID.a, permissions: [read] }],
      assigned: [],
    });
    expect(events).toEqual([{ operation: 'revoke', grantId: ID.a, added: [], removed: [] }]);
  });
});

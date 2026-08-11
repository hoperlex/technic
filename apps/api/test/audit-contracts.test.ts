import { describe, expect, it } from 'vitest';
import {
  USER_AUDIT_ACTIONS,
  auditQuerySchema,
  describeAuditEntry,
  userAuditActionLabels,
  type AuditEntryDto,
} from '@technic/contracts';

// Контракт подвкладки «Аудит»: разбор фильтров и строка события для человека. Описатель живёт в
// контрактах именно ради этой проверки — формулировку ячейки таблицы тестом не поймать.

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';

function entry(action: string, metadata: Record<string, unknown> = {}): AuditEntryDto {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    createdAt: '2026-08-10T09:00:00.000Z',
    action,
    actorUserId: ACTOR_ID,
    actorName: 'Иванов Иван Иванович',
    entityType: 'user',
    entityId: TARGET_ID,
    targetName: 'Петров Пётр Петрович',
    targetEmail: 'petrov@example.com',
    metadata,
  };
}

describe('фильтры журнала аудита', () => {
  it('принимает набор действий через запятую', () => {
    const q = auditQuerySchema.parse({
      actions: 'user.approve_registration,user.reject_registration,auth.password_reset_requested',
    });
    expect(q.actions).toEqual([
      'user.approve_registration',
      'user.reject_registration',
      'auth.password_reset_requested',
    ]);
  });

  it('пустой набор — не ошибка, а «фильтра нет»: снятые галочки обычное состояние формы', () => {
    expect(auditQuerySchema.parse({ actions: '' }).actions).toEqual([]);
    expect(auditQuerySchema.parse({}).actions).toBeUndefined();
  });

  it('отвергает действие вне реестра — перечень закрытый (Р10)', () => {
    expect(() => auditQuerySchema.parse({ actions: 'user.deactivate' })).toThrow();
    // Опечатка в середине набора не должна проходить мимо только потому, что соседи целы.
    expect(() => auditQuerySchema.parse({ actions: 'user.delete,user.purgee' })).toThrow();
    // Входов в реестре нет намеренно: их тысячи, и они утопили бы административные действия.
    expect(USER_AUDIT_ACTIONS).not.toContain('auth.login');
    expect(() => auditQuerySchema.parse({ actions: 'auth.login' })).toThrow();
  });

  it('разбирает цель, актора и период', () => {
    const q = auditQuerySchema.parse({
      entityType: 'user',
      entityId: TARGET_ID,
      actorUserId: ACTOR_ID,
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-10T23:59:59.999Z',
    });
    expect(q.entityId).toBe(TARGET_ID);
    expect(q.actorUserId).toBe(ACTOR_ID);
    expect(q.from?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(q.to?.toISOString()).toBe('2026-08-10T23:59:59.999Z');
  });

  it('не принимает произвольного актора и чужое поле сортировки', () => {
    expect(() => auditQuerySchema.parse({ actorUserId: 'Иванов' })).toThrow();
    expect(() => auditQuerySchema.parse({ sortBy: 'actorName' })).toThrow();
    expect(auditQuerySchema.parse({ sortBy: 'createdAt' }).sortBy).toBe('createdAt');
  });
});

describe('описатель строки журнала', () => {
  it('даёт осмысленную строку каждому действию реестра', () => {
    for (const action of USER_AUDIT_ACTIONS) {
      const text = describeAuditEntry(entry(action));
      expect(text.length).toBeGreaterThan(0);
      // Главное требование: читателю показывают событие, а не код действия из базы.
      expect(text).not.toBe(action);
      expect(text).toBe(userAuditActionLabels[action]);
    }
  });

  it('собирает смену роли по значениям из metadata', () => {
    const text = describeAuditEntry(
      entry('user.update', { role: { from: 'dispatcher', to: 'manager' } }),
    );
    expect(text).toBe('Смена роли: Диспетчер → Менеджер');
  });

  it('различает активацию и деактивацию — своего действия у них нет', () => {
    expect(describeAuditEntry(entry('user.update', { isActive: { from: true, to: false } }))).toBe(
      'Учётная запись деактивирована',
    );
    expect(describeAuditEntry(entry('user.update', { isActive: { from: false, to: true } }))).toBe(
      'Учётная запись активирована',
    );
  });

  it('называет роль у одобренной заявки и у заведённой учётки', () => {
    expect(describeAuditEntry(entry('user.approve_registration', { role: 'dispatcher' }))).toBe(
      'Заявка одобрена: назначена роль Диспетчер',
    );
    expect(
      describeAuditEntry(
        entry('user.create', { role: 'shtab', addons: ['office_equipment_operator'] }),
      ),
    ).toBe('Учётная запись создана: назначена роль Штаб, надстройки: Оператор (оргтехника)');
  });

  it('называет оба адреса у смены почты (ADR 0092)', () => {
    // Прежнего адреса после смены нет больше нигде — в учётке лежит уже новый, — а вопрос разбора
    // звучит «с какого адреса и на какой увели вход».
    expect(
      describeAuditEntry(
        entry('user.change_email', {
          oldEmail: 'ivanov@su10.ru',
          newEmail: 'i.ivanov@su10.ru',
        }),
      ),
    ).toBe('Адрес электронной почты изменён: ivanov@su10.ru → i.ivanov@su10.ru');
    // Половины пары не бывает: «изменён на новый» без прежнего не отвечает ни на один вопрос.
    expect(describeAuditEntry(entry('user.change_email', { newEmail: 'i.ivanov@su10.ru' }))).toBe(
      'Адрес электронной почты изменён',
    );
  });

  it('старая запись без значений остаётся общей строкой — задним числом журнал не дополняется (Р12)', () => {
    expect(describeAuditEntry(entry('user.update'))).toBe('Учётная запись изменена');
    // Тем же остаются записи с одними булевыми флагами, какими правка писалась до дополнения.
    expect(
      describeAuditEntry(entry('user.update', { roleChanged: true, deactivated: false })),
    ).toBe('Учётная запись изменена');
  });

  it('действие вне реестра возвращается своим кодом: описатель не должен молчать', () => {
    expect(describeAuditEntry(entry('waste_request.create'))).toBe('waste_request.create');
  });
});

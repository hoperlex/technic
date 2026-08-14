import { describe, expect, it } from 'vitest';
import {
  USER_AUDIT_ACTIONS,
  USER_AUDIT_FIELDS,
  auditChangesOf,
  auditQuerySchema,
  describeAuditEntry,
  userAuditActionLabels,
  userAuditFieldLabels,
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
    targetRole: 'dispatcher',
    targetIsActive: true,
    targetDeletedAt: null,
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

  it('разбирает отбор по данным учётной записи (ADR 0109)', () => {
    const q = auditQuerySchema.parse({
      targetRole: 'mechanic',
      targetIsActive: 'false',
      targetObjectId: TARGET_ID,
      targetCounterpartyId: ACTOR_ID,
    });
    expect(q.targetRole).toBe('mechanic');
    expect(q.targetIsActive).toBe(false);
    expect(q.targetObjectId).toBe(TARGET_ID);
    expect(q.targetCounterpartyId).toBe(ACTOR_ID);
    expect(() => auditQuerySchema.parse({ targetRole: 'кладовщик' })).toThrow();
  });

  it('по умолчанию показывает и архивные учётки: журнал рассказывает о прошлом', () => {
    // Умолчание расходится с остальными списками портала (`exclude`, ADR 0070) намеренно: самый
    // частый вопрос к журналу — что стало с учёткой, которой больше нет.
    expect(auditQuerySchema.parse({}).targetArchive).toBe('include');
    expect(auditQuerySchema.parse({ targetArchive: 'only' }).targetArchive).toBe('only');
    expect(() => auditQuerySchema.parse({ targetArchive: 'archived' })).toThrow();
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

  it('перечисляет в заголовке правки то, что менялось, — по группам полей', () => {
    // Правок в один приём бывает по пять-шесть: «изменена» обо всём подряд не отвечает ни на что,
    // а все значения в заголовке не помещаются в строку таблицы. Объекты, добавленные и снятые
    // одной правкой, названы один раз — это одно решение администратора, а не два.
    const text = describeAuditEntry(
      entry('user.update', {
        changes: [
          { field: 'role', from: 'Диспетчер', to: 'Менеджер' },
          { field: 'objectsAdded', from: null, to: 'СУ-10' },
          { field: 'objectsRemoved', from: null, to: 'Склад №2' },
        ],
      }),
    );
    expect(text).toBe('Учётная запись изменена: роль, объекты');
  });

  it('действие вне реестра возвращается своим кодом: описатель не должен молчать', () => {
    expect(describeAuditEntry(entry('waste_request.create'))).toBe('waste_request.create');
  });
});

describe('изменения события журнала', () => {
  it('у каждого поля есть подпись — иначе в строке окажется код колонки', () => {
    for (const field of USER_AUDIT_FIELDS) {
      expect(userAuditFieldLabels[field]?.length).toBeGreaterThan(0);
    }
  });

  it('отдаёт записанный перечень как есть', () => {
    const changes = auditChangesOf(
      entry('user.update', {
        changes: [
          { field: 'phone', from: '+7 (900) 000-00-00', to: '+7 (901) 111-11-11' },
          { field: 'addonsRevoked', from: null, to: 'Оператор (оргтехника)' },
        ],
      }),
    );
    expect(changes).toEqual([
      { field: 'phone', from: '+7 (900) 000-00-00', to: '+7 (901) 111-11-11' },
      { field: 'addonsRevoked', from: null, to: 'Оператор (оргтехника)' },
    ]);
  });

  it('восстанавливает пары из записей, сделанных до перечня', () => {
    // Смена роли и активность писались готовыми парами (ADR 0088) — читателю разница в том, каким
    // годом сделана запись, видна быть не должна.
    expect(auditChangesOf(entry('user.update', { role: { from: 'dispatcher', to: 'manager' } })))
      .toEqual([{ field: 'role', from: 'Диспетчер', to: 'Менеджер' }]);
    expect(auditChangesOf(entry('user.update', { isActive: { from: true, to: false } }))).toEqual([
      { field: 'isActive', from: 'открыт', to: 'закрыт' },
    ]);
    // Заведение учётки и одобрение заявки писали роль одним значением: это «стало».
    expect(auditChangesOf(entry('user.approve_registration', { role: 'dispatcher' }))).toEqual([
      { field: 'role', from: null, to: 'Диспетчер' },
    ]);
    // Оба адреса у смены почты (ADR 0092): прежнего после смены нет больше нигде.
    expect(
      auditChangesOf(
        entry('user.change_email', { oldEmail: 'ivanov@su10.ru', newEmail: 'i.ivanov@su10.ru' }),
      ),
    ).toEqual([{ field: 'email', from: 'ivanov@su10.ru', to: 'i.ivanov@su10.ru' }]);
  });

  it('о правке без значений говорит прямо, а не додумывает её', () => {
    // Область видимости писалась одним признаком «менялось». Придумать за него состав объектов
    // нельзя, а промолчать — значит потерять правку из истории вовсе.
    expect(auditChangesOf(entry('user.update', { scopeChanged: true, roleChanged: false }))).toEqual(
      [{ field: 'scope', from: null, to: null }],
    );
    expect(auditChangesOf(entry('user.update'))).toEqual([]);
    expect(describeAuditEntry(entry('user.update'))).toBe('Учётная запись изменена');
  });

  it('не пропускает в перечень мусор из metadata', () => {
    const changes = auditChangesOf(
      entry('user.update', { changes: [{ field: 'role', from: 'Диспетчер', to: 'Механик' }, 42] }),
    );
    expect(changes).toEqual([{ field: 'role', from: 'Диспетчер', to: 'Механик' }]);
  });
});

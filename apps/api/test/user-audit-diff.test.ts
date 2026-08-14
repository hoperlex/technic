import { describe, expect, it } from 'vitest';
import type { UserAccountDto } from '@technic/contracts';
import { userAuditChanges } from '../src/services/user-audit-diff';

// Дифф учётной записи (ADR 0109): что портал кладёт в журнал при заведении и правке. Считается по
// паре карточек и без базы — ровно поэтому его и можно проверить построчно.

function account(over: Partial<UserAccountDto> = {}): UserAccountDto {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'ivanov@su10.ru',
    lastName: 'Иванов',
    firstName: 'Иван',
    middleName: 'Иванович',
    fullName: 'Иванов Иван Иванович',
    phone: '9000000000',
    requestedRole: null,
    requestedObject: '',
    requestedCompany: '',
    requestedComment: '',
    role: 'dispatcher',
    isActive: true,
    mustChangePassword: false,
    emailVerifiedAt: null,
    constructionObjects: [{ id: 'o-1', code: 'СУ-10', name: 'СУ-10' }],
    departments: [],
    addons: [],
    counterpartyId: null,
    counterpartyName: null,
    counterpartyType: null,
    person: null,
    deletedAt: null,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...over,
  };
}

describe('изменения учётной записи для журнала', () => {
  it('пишет пары «было → стало» по каждому изменённому полю', () => {
    const changes = userAuditChanges(
      account(),
      account({ role: 'mechanic', phone: '9011111111', isActive: false }),
    );
    expect(changes).toEqual([
      { field: 'phone', from: '+7 (900) 000 00 00', to: '+7 (901) 111 11 11' },
      { field: 'role', from: 'Диспетчер', to: 'Механик' },
      { field: 'isActive', from: 'открыт', to: 'закрыт' },
    ]);
  });

  it('молчит, когда правка ничего не изменила', () => {
    // Сохранение формы без правок — обычное дело, и строка «изменена» без единого значения
    // читалась бы как потерянные детали.
    expect(userAuditChanges(account(), account())).toEqual([]);
  });

  it('показывает разницу набора, а не его состав', () => {
    // Вопрос к журналу всегда про разницу: что человеку открыли и что закрыли. Составы по десять
    // площадок в двух колонках глазами не сравнить.
    const changes = userAuditChanges(
      account({
        constructionObjects: [
          { id: 'o-1', code: 'СУ-10', name: 'СУ-10' },
          { id: 'o-2', code: 'СК-2', name: 'Склад №2' },
        ],
      }),
      account({
        constructionObjects: [
          { id: 'o-1', code: 'СУ-10', name: 'СУ-10' },
          { id: 'o-3', code: 'СУ-14', name: 'СУ-14' },
        ],
      }),
    );
    expect(changes).toEqual([
      { field: 'objectsAdded', from: null, to: 'СУ-14' },
      { field: 'objectsRemoved', from: null, to: 'Склад №2' },
    ]);
  });

  it('называет снятую надстройку: следа от неё в учётке не остаётся', () => {
    const changes = userAuditChanges(
      account({ addons: ['office_equipment_operator'] }),
      account({ addons: [] }),
    );
    expect(changes).toEqual([
      { field: 'addonsRevoked', from: null, to: 'Оператор (оргтехника)' },
    ]);
  });

  it('у заведённой учётки записывает состав, а не пары', () => {
    // Слева показывать нечего: учётки до этого события не было. Доступ пишется всегда — заведённая
    // активной учётка и заготовка «на потом» по одной роли неразличимы.
    const changes = userAuditChanges(
      null,
      account({ isActive: false, addons: ['office_equipment_operator'] }),
    );
    expect(changes).toEqual([
      { field: 'role', from: null, to: 'Диспетчер' },
      { field: 'isActive', from: null, to: 'закрыт' },
      { field: 'objectsAdded', from: null, to: 'СУ-10' },
      { field: 'addonsGranted', from: null, to: 'Оператор (оргтехника)' },
    ]);
  });

  it('называет работника по имени: идентификатор в журнале ничего не объясняет', () => {
    const person = {
      id: 'p-1',
      lastName: 'Петров',
      firstName: 'Пётр',
      middleName: 'Петрович',
      fullName: 'Петров Пётр Петрович',
      phone: '',
      email: '',
      deletedAt: null,
    };
    const changes = userAuditChanges(account({ role: 'driver' }), account({ role: 'driver', person }));
    expect(changes).toEqual([{ field: 'person', from: '—', to: 'Петров Пётр Петрович' }]);
  });
});

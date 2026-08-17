import type {
  GrantCardDto,
  GrantDto,
  GrantHolderDto,
  GrantImpactDto,
  UserAccountDto,
} from '@technic/contracts';

/**
 * Наборы полномочий, их выдачи и предпросмотры последствий (ADR 0106) для сценарных тестов портала.
 *
 * Общая фабрика на два файла проверок — каталога с конструктором и реестра выдач: набор в них один и
 * тот же, и разъехавшиеся копии описывали бы два разных «Аудитора». Ответы серверных ручек здесь
 * собираются целиком (`GrantCardDto`, `GrantImpactDto`), потому что проверка держится за HTTP-контракт:
 * тест, собравший тело наполовину, проверял бы не портал, а собственную фикстуру.
 */

/** Отпечаток последствий: 64 шестнадцатеричных знака — иначе схема сервера тело не примет. */
export const HASH = 'a'.repeat(64);
/** Второй отпечаток: им отвечает предпросмотр, перечитанный после 409. */
export const NEXT_HASH = 'b'.repeat(64);

export const CUSTOM_ID = '11111111-1111-1111-1111-111111111111';
export const SYSTEM_ID = '22222222-2222-2222-2222-222222222222';
export const SHTAB_ID = '33333333-3333-3333-3333-333333333333';
export const MANAGER_ID = '44444444-4444-4444-4444-444444444444';
export const DRIVER_ID = '55555555-5555-5555-5555-555555555555';

/** Пользовательский набор: собран администратором в проде, правится и выдаётся. */
export const CUSTOM: GrantDto = {
  id: CUSTOM_ID,
  code: 'auditor',
  name: 'Аудитор',
  description: 'Читает журнал действий',
  isSystem: false,
  version: 3,
  permissions: ['audit.read'],
  unknownPermissions: [],
  roles: ['shtab'],
  holderCount: 2,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-10T10:00:00.000Z',
};

/** Системный: состав и код живут в коде портала, и правке он не подлежит вовсе (решение 2). */
export const SYSTEM: GrantDto = {
  ...CUSTOM,
  id: SYSTEM_ID,
  code: 'office_equipment_it_approver',
  name: 'Согласование ИТ',
  description: 'Виза ИТ-службы',
  isSystem: true,
  version: 1,
  permissions: ['serviceRequests.approveIt', 'officeEquipment.read'],
  roles: ['shtab', 'manager'],
  holderCount: 0,
};

export function holder(over: Partial<GrantHolderDto> = {}): GrantHolderDto {
  return {
    assignmentId: 'a-1',
    userId: SHTAB_ID,
    fullName: 'Штабов Степан Сергеевич',
    email: 'shtab@example.test',
    role: 'shtab',
    roleMismatch: false,
    isActive: true,
    isArchived: false,
    grantedAt: '2026-08-11T09:00:00.000Z',
    grantedByName: 'Админов Антон',
    origin: 'manual',
    ...over,
  };
}

/**
 * Держатель, чья роль вышла из списка совместимых: выдача жива, прав по ней нет. Именно про него
 * §13.1 требует сказать словами, а не только тегом, — молчаливый массовый отзыв опаснее
 * несоответствия, поэтому назначение остаётся, и объяснять его приходится экрану.
 *
 * Автор и время выдачи свои: одинаковые строки у двух держателей не показали бы, что ответ берётся
 * из назначения, а не из набора.
 */
export const MISMATCHED = holder({
  assignmentId: 'a-2',
  userId: MANAGER_ID,
  fullName: 'Менеджеров Максим',
  email: 'manager@example.test',
  role: 'manager',
  roleMismatch: true,
  grantedByName: 'Кадровиков Кирилл',
  grantedAt: '2026-08-12T06:30:00.000Z',
});

/** Карточка набора с реестром выдач: двое держателей, у одного роль вне списка. */
export function grantCard(over: Partial<GrantCardDto> = {}): GrantCardDto {
  return { ...CUSTOM, holders: [holder(), MISMATCHED], ...over };
}

/** Предпросмотр правки: один затронутый держатель, барьеры не нарушены. */
export function grantImpact(over: Partial<GrantImpactDto> = {}): GrantImpactDto {
  return {
    operation: 'update',
    grantId: CUSTOM_ID,
    grantCode: CUSTOM.code,
    grantName: CUSTOM.name,
    userId: null,
    version: CUSTOM.version,
    users: [
      {
        userId: SHTAB_ID,
        fullName: 'Штабов Степан Сергеевич',
        role: 'shtab',
        added: ['mailings.read'],
        removed: [],
        roleMismatch: false,
      },
    ],
    violations: [],
    holders: [],
    expectedImpactHash: HASH,
    ...over,
  };
}

function account(over: Partial<UserAccountDto> = {}): UserAccountDto {
  return {
    id: SHTAB_ID,
    email: 'shtab@example.test',
    lastName: 'Штабов',
    firstName: 'Степан',
    middleName: 'Сергеевич',
    fullName: 'Штабов Степан Сергеевич',
    phone: '',
    requestedRole: null,
    requestedObject: '',
    requestedCompany: '',
    requestedComment: '',
    role: 'shtab',
    isActive: true,
    mustChangePassword: false,
    emailVerifiedAt: '2026-08-01T10:00:00.000Z',
    constructionObjects: [],
    departments: [],
    addons: [],
    grantCodes: [],
    permissions: [],
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

/**
 * Учётки для выдачи: подходящая по роли, неподходящая и водитель, которому наборы не выдаются ни
 * одним способом. Три, а не одна: список выбора обязан отсеять двух последних, и проверить это на
 * одной подходящей учётке нечем.
 */
export const GRANT_ACCOUNTS: UserAccountDto[] = [
  account(),
  account({
    id: MANAGER_ID,
    fullName: 'Менеджеров Максим',
    lastName: 'Менеджеров',
    firstName: 'Максим',
    middleName: '',
    role: 'manager',
    email: 'manager@example.test',
  }),
  account({
    id: DRIVER_ID,
    fullName: 'Водителев Виктор',
    lastName: 'Водителев',
    firstName: 'Виктор',
    middleName: '',
    role: 'driver',
    email: 'driver@example.test',
  }),
];

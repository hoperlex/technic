import { describe, expect, it } from 'vitest';
import { userListQuerySchema } from '@technic/contracts';

// Фильтры списка учёток: разбор query. Проверяется то, что клиент присылает строками, а список
// понимает значениями, — и то, чего он присылать не должен.

const OBJECT_ID = '11111111-1111-4111-8111-111111111111';
const COUNTERPARTY_ID = '22222222-2222-4222-8222-222222222222';

describe('фильтры списка пользователей', () => {
  it('разбирает объект, контрагента, пожелание и период регистрации', () => {
    const q = userListQuerySchema.parse({
      constructionObjectId: OBJECT_ID,
      counterpartyId: COUNTERPARTY_ID,
      requestedRole: 'site_staff',
      createdFrom: '2026-07-01',
      createdTo: '2026-07-31',
    });
    expect(q.constructionObjectId).toBe(OBJECT_ID);
    expect(q.counterpartyId).toBe(COUNTERPARTY_ID);
    expect(q.requestedRole).toBe('site_staff');
    expect(q.createdFrom).toBe('2026-07-01');
    expect(q.createdTo).toBe('2026-07-31');
  });

  it('флаги приходят строками, а наружу выходят булевыми; не переданный флаг не задан', () => {
    expect(userListQuerySchema.parse({ includeDeleted: 'true' }).includeDeleted).toBe(true);
    expect(userListQuerySchema.parse({ includeDeleted: 'false' }).includeDeleted).toBe(false);
    // Разница существенна: «архив не просили» и «архив просили не показывать» — одно и то же
    // для выборки, но `pending` тем же флагом отличает «все» от «только рассмотренные».
    expect(userListQuerySchema.parse({}).includeDeleted).toBeUndefined();
    expect(userListQuerySchema.parse({ pending: 'true' }).pending).toBe(true);
  });

  it('не принимает несуществующую дату — регулярное выражение её пропускает', () => {
    expect(() => userListQuerySchema.parse({ createdFrom: '2026-02-31' })).toThrow();
    expect(() => userListQuerySchema.parse({ createdTo: '31.07.2026' })).toThrow();
  });

  it('не принимает произвольную строку вместо ссылки на справочник и чужое пожелание', () => {
    expect(() => userListQuerySchema.parse({ constructionObjectId: 'Объект 1' })).toThrow();
    expect(() => userListQuerySchema.parse({ counterpartyId: '42' })).toThrow();
    // Пожелание — свой перечень, а не роль портала (ADR 0034): «Штаба» в нём нет.
    expect(() => userListQuerySchema.parse({ requestedRole: 'shtab' })).toThrow();
  });

  it('сортировка по объектам недоступна: у учётки их набор (ADR 0039)', () => {
    expect(() => userListQuerySchema.parse({ sortBy: 'constructionObjectName' })).toThrow();
    expect(userListQuerySchema.parse({ sortBy: 'createdAt' }).sortBy).toBe('createdAt');
  });
});

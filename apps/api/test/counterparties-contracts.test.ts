import { describe, expect, it } from 'vitest';
import {
  allowedStatusTransitions,
  canTransitionStatus,
  createCounterpartySchema,
  createUserSchema,
  isValidInn,
  updateCounterpartySchema,
} from '@technic/contracts';

const OPERATOR_ID = '11111111-1111-4111-8111-111111111111';

describe('ИНН контрагента', () => {
  it('принимает 10- и 12-значные ИНН с верной контрольной суммой', () => {
    expect(isValidInn('7707083893')).toBe(true); // юрлицо
    expect(isValidInn('500100732259')).toBe(true); // ИП
  });

  it('отклоняет опечатку в одной цифре — то, чего формат не видит', () => {
    expect(isValidInn('7707083894')).toBe(false);
    expect(isValidInn('500100732258')).toBe(false);
  });

  it('отклоняет неверную длину и нецифровые символы', () => {
    expect(isValidInn('123')).toBe(false);
    expect(isValidInn('77070838930')).toBe(false);
    expect(isValidInn('77О7083893')).toBe(false); // кириллическая «О»
  });
});

describe('контракт контрагента', () => {
  it('требует тип, наименование и ИНН; синонимы необязательны', () => {
    const parsed = createCounterpartySchema.parse({
      type: 'operator',
      name: '  ООО «Эко-Вывоз»  ',
      inn: '7707083893',
    });
    expect(parsed.name).toBe('ООО «Эко-Вывоз»');
    expect(parsed.synonyms).toEqual([]);
    expect(parsed.isActive).toBe(true);
  });

  it('не принимает ИНН неверного формата и чужие типы', () => {
    expect(() =>
      createCounterpartySchema.parse({ type: 'contractor', name: 'Ромашка', inn: '123' }),
    ).toThrow();
    expect(() =>
      createCounterpartySchema.parse({ type: 'supplier', name: 'Ромашка', inn: '7707083893' }),
    ).toThrow();
  });

  it('принимает арендодателя ТС — роль наравне с остальными, ИНН обязателен и ей', () => {
    const lessor = createCounterpartySchema.parse({
      type: 'vehicle_lessor',
      name: 'ООО «ЭВЕРЕНТ»',
      inn: '7734432462',
    });
    expect(lessor.type).toBe('vehicle_lessor');
    expect(() =>
      createCounterpartySchema.parse({ type: 'vehicle_lessor', name: 'ООО «ЭВЕРЕНТ»' }),
    ).toThrow();
  });

  it('пустой список синонимов означает «снять все», отсутствие поля — «не трогать»', () => {
    expect(updateCounterpartySchema.parse({ synonyms: [] }).synonyms).toEqual([]);
    expect(updateCounterpartySchema.parse({ name: 'Ромашка' }).synonyms).toBeUndefined();
  });
});

describe('роль «Оператор»', () => {
  it('учётка оператора без контрагента не создаётся', () => {
    const base = {
      email: 'op@example.com',
      fullName: 'Оператор Вывоза',
      password: 'password12345',
    };
    expect(() => createUserSchema.parse({ ...base, role: 'operator' })).toThrow();
    expect(
      createUserSchema.parse({ ...base, role: 'operator', counterpartyId: OPERATOR_ID })
        .counterpartyId,
    ).toBe(OPERATOR_ID);
    // Остальным ролям контрагент не нужен.
    expect(() => createUserSchema.parse({ ...base, role: 'dispatcher' })).not.toThrow();
  });

  it('оператору доступен единственный переход: «В работе» → «Выполнена»', () => {
    expect(allowedStatusTransitions('confirmed', 'operator')).toEqual(['done']);
    expect(canTransitionStatus('confirmed', 'done', 'operator')).toBe(true);
  });

  it('оператор не подтверждает, не отменяет и не откатывает заявки', () => {
    expect(canTransitionStatus('new', 'confirmed', 'operator')).toBe(false);
    expect(canTransitionStatus('confirmed', 'cancelled', 'operator')).toBe(false);
    expect(canTransitionStatus('done', 'confirmed', 'operator')).toBe(false);
    expect(allowedStatusTransitions('new', 'operator')).toEqual([]);
  });
});

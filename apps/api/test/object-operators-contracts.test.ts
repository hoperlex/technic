import { describe, expect, it } from 'vitest';
import {
  createCounterpartySchema,
  createObjectSchema,
  updateCounterpartySchema,
  updateObjectSchema,
} from '@technic/contracts';

const OBJECT_ID = '22222222-2222-4222-8222-222222222222';
const OPERATOR_ID = '11111111-1111-4111-8111-111111111111';

describe('привязка «объект ↔ оператор вывоза»', () => {
  it('набор операторов необязателен при создании объекта', () => {
    const parsed = createObjectSchema.parse({ code: 'АЛ13', name: 'ЖК ALIA' });
    expect(parsed.operatorIds).toEqual([]);
  });

  it('правится с обеих сторон одним и тем же приёмом — полным списком', () => {
    expect(
      createObjectSchema.parse({ code: 'АЛ13', name: 'ЖК ALIA', operatorIds: [OPERATOR_ID] }),
    ).toMatchObject({ operatorIds: [OPERATOR_ID] });
    expect(
      createCounterpartySchema.parse({
        type: 'operator',
        name: 'ООО «Эко-Вывоз»',
        inn: '7707083893',
        objectIds: [OBJECT_ID],
      }).objectIds,
    ).toEqual([OBJECT_ID]);
  });

  it('в PATCH пустой список означает «снять все», отсутствие поля — «не трогать»', () => {
    expect(updateObjectSchema.parse({ operatorIds: [] }).operatorIds).toEqual([]);
    expect(updateObjectSchema.parse({ name: 'ЖК ALIA' }).operatorIds).toBeUndefined();
    expect(updateCounterpartySchema.parse({ objectIds: [] }).objectIds).toEqual([]);
    expect(updateCounterpartySchema.parse({ name: 'Ромашка' }).objectIds).toBeUndefined();
  });

  // Регрессия: `.partial()` не снимает `.default()`, и PATCH одного поля подставлял бы значения
  // по умолчанию остальным — снимая все привязки объекта и затирая адрес.
  it('PATCH объекта не подставляет значения по умолчанию соседним полям', () => {
    expect(updateObjectSchema.parse({ name: 'ЖК ALIA' })).toEqual({ name: 'ЖК ALIA' });
  });

  it('идентификаторы проверяются как uuid', () => {
    expect(() => updateObjectSchema.parse({ operatorIds: ['не-uuid'] })).toThrow();
    expect(() => updateCounterpartySchema.parse({ objectIds: ['не-uuid'] })).toThrow();
  });
});

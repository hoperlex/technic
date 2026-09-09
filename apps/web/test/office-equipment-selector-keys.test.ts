import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { officeEquipmentKeys } from '@entities/office-equipment';

/**
 * КЭШ СЕЛЕКТОРА ПРЕДМЕТА ЗАЯВКИ НЕ ПЕРЕСЕКАЕТСЯ С КЭШЕМ ОБЫЧНОЙ КАРТОЧКИ (план
 * `docs/office-equipment-request-subject-plan.md`, Р1, вторая причина).
 *
 * ЧТО ЗДЕСЬ ЗАЩИЩАЕТСЯ. Селектор отвечает по ВСЕМУ активному парку — от трёх набранных символов, —
 * а список и карточка справочника сужены областью учётки. Дочитка выбранного, положенная под ключ
 * `detail`, отдала бы запись вне области следующему, кто откроет карточку из вкладки справочника:
 * ответ он получил бы из кэша, и виновата была бы не ручка, а react-query. Такое расхождение не
 * ломает ни один запрос и не пишет ни строчки в лог — его видно только глазами на экране, поэтому
 * граница и проверяется отдельно.
 *
 * ПРОВЕРЯЕТСЯ НАСТОЯЩИМ `QueryClient`, а не сравнением массивов: сравнение ключей у TanStack Query
 * префиксное и посегментное, и пересказ этого правила подтверждал бы наши представления о нём, а
 * не само правило. Тот же приём, что в `query-keys.test.ts`.
 */
const EQUIPMENT_ID = 'e1111111-1111-4111-8111-111111111111';

describe('ключи выбора предмета заявки', () => {
  const seed = () => {
    const client = new QueryClient();
    client.setQueryData(officeEquipmentKeys.detail(EQUIPMENT_ID), 'карточка справочника');
    client.setQueryData(officeEquipmentKeys.selectorPicked(EQUIPMENT_ID), 'проекция селектора');
    client.setQueryData(officeEquipmentKeys.options('SN-1'), 'выдача справочника');
    client.setQueryData(officeEquipmentKeys.selectorOptions('SN-1'), 'выдача селектора');
    return client;
  };

  it('дочитка селектора и карточка справочника — разные записи кэша по одному и тому же id', () => {
    const client = seed();
    // Главное утверждение файла: запись вне области не подменяет собой карточку, которую человек
    // открывает из вкладки справочника.
    expect(client.getQueryData(officeEquipmentKeys.detail(EQUIPMENT_ID))).toBe(
      'карточка справочника',
    );
    expect(client.getQueryData(officeEquipmentKeys.selectorPicked(EQUIPMENT_ID))).toBe(
      'проекция селектора',
    );
  });

  it('выдачи не делят запись даже при одинаковом наборе', () => {
    // Обе спрашиваются одним и тем же словом, но отвечают разным кругом строк: у справочника —
    // своя область, у селектора — весь активный парк.
    const client = seed();
    expect(client.getQueryData(officeEquipmentKeys.options('SN-1'))).toBe('выдача справочника');
    expect(client.getQueryData(officeEquipmentKeys.selectorOptions('SN-1'))).toBe(
      'выдача селектора',
    );
  });

  it('семейство селектора гасится отдельно от карточек справочника', async () => {
    const client = seed();
    await client.invalidateQueries({ queryKey: ['office-equipment', 'selector'] });

    const invalidated = (key: readonly unknown[]) =>
      client.getQueryState(key)?.isInvalidated ?? false;
    expect(invalidated(officeEquipmentKeys.selectorPicked(EQUIPMENT_ID))).toBe(true);
    expect(invalidated(officeEquipmentKeys.selectorOptions('SN-1'))).toBe(true);
    expect(invalidated(officeEquipmentKeys.detail(EQUIPMENT_ID))).toBe(false);
    expect(invalidated(officeEquipmentKeys.options('SN-1'))).toBe(false);
  });

  it('корень сущности накрывает и селектор: заведённая карточка обязана доехать до обеих выдач', async () => {
    // Общий корень — вторая половина решения: развести записи и при этом сохранить одну кнопку
    // «обновить всё, что про оргтехнику».
    const client = seed();
    await client.invalidateQueries({ queryKey: officeEquipmentKeys.root });

    expect(client.getQueryState(officeEquipmentKeys.selectorOptions('SN-1'))?.isInvalidated).toBe(
      true,
    );
    expect(client.getQueryState(officeEquipmentKeys.options('SN-1'))?.isInvalidated).toBe(true);
  });

  it('набранное нормализуется так же, как у выдачи справочника', () => {
    // Пустая строка, пробелы и «не искали» — один и тот же вопрос: разными записями кэша они
    // означали бы два одинаковых запроса подряд на каждом закрытии списка.
    expect(officeEquipmentKeys.selectorOptions('  ')).toEqual(
      officeEquipmentKeys.selectorOptions(undefined),
    );
    expect(officeEquipmentKeys.selectorOptions(' SN-1 ')).toEqual(
      officeEquipmentKeys.selectorOptions('SN-1'),
    );
  });
});

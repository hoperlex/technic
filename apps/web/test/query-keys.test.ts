import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { createQueryKeys } from '@shared/api';

/**
 * Фабрика ключей запросов. Имена здесь синтетические: фабрика лежит в shared и не должна знать ни
 * заявок, ни объектов — тест, написанный на доменных словах, скрыл бы нарушение этой границы.
 *
 * Проверяется не форма ради формы: на ней держится точечная инвалидация. Промах в префиксе не
 * ломает ничего заметного — запрос просто не обновится (или обновится лишний), и увидят это уже
 * на экране, а не в тестах.
 */

interface SampleParams {
  page: number;
  search?: string;
}

const sampleKeys = createQueryKeys('sample', {
  options: (p: { activeOnly: boolean }) => ['options', p],
  list: (p: SampleParams) => ['list', p],
  detail: (id: string) => ['detail', id],
  summary: () => ['summary'],
});

describe('createQueryKeys', () => {
  it('собирает ключ от корня сущности', () => {
    expect(sampleKeys.root).toEqual(['sample']);
    expect(sampleKeys.summary()).toEqual(['sample', 'summary']);
    expect(sampleKeys.detail('s-1')).toEqual(['sample', 'detail', 's-1']);
  });

  it('кладёт параметры в ключ как есть — по ним TanStack Query и различает запросы', () => {
    expect(sampleKeys.options({ activeOnly: true })).toEqual([
      'sample',
      'options',
      { activeOnly: true },
    ]);
    expect(sampleKeys.list({ page: 2, search: 'абв' })).toEqual([
      'sample',
      'list',
      { page: 2, search: 'абв' },
    ]);
  });

  it('корень — начало любого ключа сущности', () => {
    for (const key of [
      sampleKeys.summary(),
      sampleKeys.detail('s-1'),
      sampleKeys.list({ page: 1 }),
      sampleKeys.options({ activeOnly: false }),
    ]) {
      expect(key.slice(0, sampleKeys.root.length)).toEqual([...sampleKeys.root]);
    }
  });

  it('семейство — начало ключей своих элементов', () => {
    // Иначе `invalidateQueries({ queryKey: ['sample', 'detail'] })` не накроет ни одной карточки:
    // сравнение у TanStack Query префиксное, посегментное, без разбора «похожести».
    expect(sampleKeys.detail('s-1').slice(0, 2)).toEqual(['sample', 'detail']);
    expect(sampleKeys.detail('s-2').slice(0, 2)).toEqual(['sample', 'detail']);
    expect(sampleKeys.list({ page: 1 }).slice(0, 2)).toEqual(['sample', 'list']);
  });

  it('одинаковые аргументы дают эквивалентные ключи', () => {
    // Ключи сравниваются по значению (`hashKey` — стабильный JSON), поэтому важно равенство
    // содержимого, а не ссылки: два вызова обязаны попасть в одну запись кэша.
    expect(sampleKeys.detail('s-1')).toEqual(sampleKeys.detail('s-1'));
    expect(sampleKeys.list({ page: 3, search: 'к' })).toEqual(
      sampleKeys.list({ page: 3, search: 'к' }),
    );
    expect(sampleKeys.detail('s-1')).not.toBe(sampleKeys.detail('s-1'));
    expect(sampleKeys.detail('s-1')).not.toEqual(sampleKeys.detail('s-2'));
  });

  it('ключи различают семейства и параметры', () => {
    expect(sampleKeys.list({ page: 1 })).not.toEqual(sampleKeys.list({ page: 2 }));
    expect(sampleKeys.summary()).not.toEqual(sampleKeys.detail('summary'));
  });

  /**
   * Ради этого всё и затевалось: точечная инвалидация вместо гашения корня целиком. Проверяется
   * настоящим `QueryClient`, а не пересказом его правил — иначе тест подтверждал бы наши
   * представления о префиксном сравнении, а не само сравнение.
   */
  describe('инвалидация по префиксу', () => {
    const seed = () => {
      const client = new QueryClient();
      client.setQueryData(sampleKeys.detail('s-1'), 'карточка 1');
      client.setQueryData(sampleKeys.detail('s-2'), 'карточка 2');
      client.setQueryData(sampleKeys.list({ page: 1 }), 'список');
      client.setQueryData(sampleKeys.summary(), 'сводка');
      return client;
    };

    const invalidated = (client: QueryClient, key: readonly unknown[]) =>
      client.getQueryState(key)?.isInvalidated ?? false;

    it('корень накрывает всю сущность', async () => {
      const client = seed();
      await client.invalidateQueries({ queryKey: sampleKeys.root });

      expect(invalidated(client, sampleKeys.detail('s-1'))).toBe(true);
      expect(invalidated(client, sampleKeys.list({ page: 1 }))).toBe(true);
      expect(invalidated(client, sampleKeys.summary())).toBe(true);
    });

    it('семейство накрывает свои ключи и не трогает соседние', async () => {
      const client = seed();
      await client.invalidateQueries({ queryKey: ['sample', 'detail'] });

      expect(invalidated(client, sampleKeys.detail('s-1'))).toBe(true);
      expect(invalidated(client, sampleKeys.detail('s-2'))).toBe(true);
      expect(invalidated(client, sampleKeys.list({ page: 1 }))).toBe(false);
      expect(invalidated(client, sampleKeys.summary())).toBe(false);
    });

    it('конкретный ключ гасит только себя', async () => {
      const client = seed();
      await client.invalidateQueries({ queryKey: sampleKeys.detail('s-1') });

      expect(invalidated(client, sampleKeys.detail('s-1'))).toBe(true);
      expect(invalidated(client, sampleKeys.detail('s-2'))).toBe(false);
    });

    it('ключи разных сущностей не пересекаются', async () => {
      const otherKeys = createQueryKeys('other', { detail: (id: string) => ['detail', id] });
      const client = seed();
      client.setQueryData(otherKeys.detail('s-1'), 'чужая карточка');

      await client.invalidateQueries({ queryKey: sampleKeys.root });

      expect(invalidated(client, otherKeys.detail('s-1'))).toBe(false);
    });
  });

  it('не отдаёт имя root описателю', () => {
    const keys = createQueryKeys('sample', {
      // @ts-expect-error имя root занято корнем сущности: описатель, затерший его, оставил бы
      // сущность без инвалидации целиком, и заметили бы это только на экране
      root: (id: string) => ['root', id],
    });
    expect(keys.root).toEqual(['sample']);
  });

  it('ключ пригоден как queryKey без приведения типов', () => {
    const client = new QueryClient();
    // Проверка типов, а не поведения: `setQueryData` принимает `readonly unknown[]`, и если бы
    // фабрика теряла форму ключа, здесь бы упал `tsc`, а не этот expect.
    client.setQueryData(sampleKeys.list({ page: 1 }), 'значение');
    expect(client.getQueryData(sampleKeys.list({ page: 1 }))).toBe('значение');
  });
});

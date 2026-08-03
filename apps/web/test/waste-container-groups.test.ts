import { describe, expect, it } from 'vitest';
import type { PresentContainerGroupDto } from '@technic/contracts';
import {
  containerGroupKey,
  containerGroupOptions,
  findContainerGroup,
  parseContainerGroupKey,
  presentGroupsHint,
} from '../src/pages/waste/containerGroups';

/**
 * Выбор контейнера в заявке на замену и снятие (ADR 0054). Форма спрашивает одним полем — «какой
 * контейнер трогаем», — потому что тип без владельца ответа не даёт: на площадке стоят две
 * одинаковых бочки от разных операторов, и это разные группы.
 *
 * Здесь проверяется, что значение поля переживает дорогу туда и обратно: ключ собирается из
 * группы, разбирается в тип с владельцем и находит свою группу в списке. Ошибка тут тихая —
 * заявка уходит на сервер с чужим владельцем и гасит не тот контейнер.
 */

const groups: PresentContainerGroupDto[] = [
  {
    objectId: 'obj-1',
    containerTypeId: 'ct-8',
    containerTypeName: 'Контейнер 8 м³',
    ownerCounterpartyId: 'cp-1',
    ownerName: 'ООО «ЭкоТранс»',
    quantity: 2,
  },
  {
    objectId: 'obj-1',
    containerTypeId: 'ct-8',
    containerTypeName: 'Контейнер 8 м³',
    ownerCounterpartyId: 'cp-2',
    ownerName: 'ООО «Вторресурс»',
    quantity: 1,
  },
  {
    objectId: 'obj-1',
    containerTypeId: 'ct-20',
    containerTypeName: 'Контейнер 20 м³',
    ownerCounterpartyId: null,
    ownerName: null,
    quantity: 3,
  },
];

describe('ключ группы присутствия', () => {
  // Один тип и два владельца — то самое, ради чего поле стало одним: по типу эти группы
  // неразличимы, и выбор «Контейнер 8 м³» без владельца означал бы «какой-нибудь».
  it('различает группы одного типа от разных операторов', () => {
    expect(containerGroupKey(groups[0]!)).not.toBe(containerGroupKey(groups[1]!));
  });

  it('разбирается обратно в тип и владельца', () => {
    expect(parseContainerGroupKey(containerGroupKey(groups[0]!))).toEqual({
      containerTypeId: 'ct-8',
      ownerCounterpartyId: 'cp-1',
    });
  });

  // Группа без владельца — обычная: установку заводили без оператора либо заявка старше
  // ADR 0054. Пустая правая часть ключа обязана вернуться именно как null, а не как ''.
  it('держит группу без владельца', () => {
    const key = containerGroupKey(groups[2]!);
    expect(parseContainerGroupKey(key)).toEqual({
      containerTypeId: 'ct-20',
      ownerCounterpartyId: null,
    });
    expect(findContainerGroup(groups, key)).toBe(groups[2]);
  });

  it('ничего не выбрано — группы нет', () => {
    expect(findContainerGroup(groups, undefined)).toBeUndefined();
  });
});

describe('подписи выбора', () => {
  it('каждая группа названа типом, владельцем и количеством', () => {
    expect(containerGroupOptions(groups).map((o) => o.label)).toEqual([
      'Контейнер 8 м³ — ООО «ЭкоТранс» (2 шт.)',
      'Контейнер 8 м³ — ООО «Вторресурс» (1 шт.)',
      'Контейнер 20 м³ — оператор не указан (3 шт.)',
    ]);
  });

  it('подсказка перечисляет, кто и что держит на площадке', () => {
    expect(presentGroupsHint(groups)).toBe(
      'На объекте сейчас: ООО «ЭкоТранс» — Контейнер 8 м³ × 2; ' +
        'ООО «Вторресурс» — Контейнер 8 м³ × 1; оператор не указан — Контейнер 20 м³ × 3',
    );
  });

  // Пустая площадка — это сведения, а не их отсутствие: молчание читалось бы как «не спросили».
  it('пустой объект говорит, что контейнеров нет', () => {
    expect(presentGroupsHint([])).toBe('На объекте сейчас нет контейнеров');
  });
});

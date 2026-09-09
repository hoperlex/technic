import type { OfficeEquipmentRequestOptionDto } from '@technic/contracts';
import { json, type RouteMap } from '../http';
import { list } from './common';

/**
 * Единица справочника ГЛАЗАМИ ФОРМЫ ЗАЯВКИ — проекция селектора (план
 * `docs/office-equipment-request-subject-plan.md`, Р1).
 *
 * Отдельная фабрика от карточки `OfficeEquipmentDto`, потому что это разные ответы разных ручек:
 * у проекции нет ни типа, ни модели, ни состояния, ни комментария — по ней от трёх набранных
 * символов виден весь активный парк компании, и учётные реквизиты по нему не раздаются. Общая
 * фикстура на оба ответа обещала бы полю то, чего сервер ему не отдаёт.
 *
 * Умолчание — «аппарат ваш»: обе области истинны. Так выглядит обычная заявка, и сценарий про
 * чужую площадку обязан сказать это явно — иначе половина существующих проверок молча поехала бы
 * на предупреждении, которого никто не ждал.
 */
export function equipmentSelectorOption(
  over: Partial<OfficeEquipmentRequestOptionDto> = {},
): OfficeEquipmentRequestOptionDto {
  return {
    id: 'oe-1',
    name: 'Kyocera M3145',
    serialNumber: '',
    inventoryNumber: '0012345',
    object: { id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' },
    ownerDepartment: null,
    location: 'Корпус 3, каб. 214',
    warrantyUntil: null,
    isActive: true,
    // Обе области — своя: `false` здесь означает предупреждение под полем и пересобранный состав
    // заказчика (Р5, Р6), и ставится оно сценарием, которому это и нужно.
    inOwnScope: true,
    objectInOwnScope: true,
    ...over,
  };
}

/**
 * Отбор выдачи — КАК НА СЕРВЕРЕ (`searchCondition`): по модели, обоим номерам и месту разом. Мок,
 * ищущий по одной подписи, доказывал бы обратное тому, ради чего поиск и переносили на сервер:
 * серийный номер в подпись не печатается вовсе.
 *
 * Порог в три символа здесь не воспроизводится, и это не упрощение: сужение по нему считает
 * сервер (`OFFICE_EQUIPMENT_SELECTOR_SEARCH_MIN`), а портал своего числа не знает и знать не
 * должен — проверять в портальном тесте нечего.
 */
function matches(unit: OfficeEquipmentRequestOptionDto, term: string | null): boolean {
  if (!term) return true;
  const needle = term.toLocaleLowerCase('ru');
  return [unit.name, unit.serialNumber, unit.inventoryNumber, unit.location].some((field) =>
    field.toLocaleLowerCase('ru').includes(needle),
  );
}

/**
 * Пара ручек селектора одним куском: их спрашивает поле «Какой аппарат» всякой открытой формы
 * заявки (Р1, Р3). Дочитка отвечает независимо от набранного — выбранное уже выбрано, — поэтому
 * ищет она по всему переданному парку, а не по срезу выдачи.
 *
 * Обычная выдача справочника (`GET /office-equipment`) сюда не входит намеренно: её спрашивают
 * соседи с другими нуждами — окно расходников заявки (ему нужна модель) и объединение кандидата, —
 * и мок, отвечающий за обе разом, скрыл бы, кто из них куда ходит.
 */
export function equipmentSelectorRoutes(units: OfficeEquipmentRequestOptionDto[]): RouteMap {
  return {
    'GET /office-equipment/selector': ({ query }) =>
      json(list(units.filter((unit) => matches(unit, query.get('search'))))),
    'GET /office-equipment/selector/:id': ({ params }) => {
      const found = units.find((unit) => unit.id === params.id);
      return found
        ? json(found)
        : json({ code: 'not_found', message: 'Единица оргтехники не найдена' }, 404);
    },
  };
}

import {
  officeEquipmentPlaceWords,
  SERVICE_REQUEST_NO_EQUIPMENT,
  type ServiceRequestDto,
} from '@technic/contracts';

/**
 * Предмет заявки словами: что показать вместо аппарата и площадки, когда их нет (Р8 плана
 * `docs/office-equipment-consumables-and-purchase-plan.md`, ADR 0146, решение 7).
 *
 * ЗАЧЕМ ОБЩИЙ МОДУЛЬ. Одну и ту же заявку без аппарата рисуют семь мест: строка списка, карточка
 * на телефоне, карточка заявки, шапка окна действия, форма правки, архив и реестр гарантий. Ответ
 * у всех обязан быть один — иначе «Без аппарата» в списке и прочерк в карточке прочитались бы как
 * два разных состояния, и человек пошёл бы искать разницу, которой нет. Слова берутся из
 * константы контрактов: их же говорят письмо, заголовок действия и выгрузка.
 *
 * ПОЧЕМУ НЕ ПРОЧЕРК. Пустое место и «—» в портале означают «данных нет» — то есть либо не
 * догрузилось, либо забыли заполнить. Заявка без аппарата — законное состояние, а не пробел, и
 * называться оно обязано словами.
 *
 * Функции берут `Pick`, а не всю заявку: их зовут и оттуда, где на руках снимок из двух полей
 * (подбор заказчика), и требование целого DTO заставило бы собирать заглушку.
 */

/** Как называется аппарат заявки; у заявки без предмета — «Без аппарата», а не пустая строка. */
export function serviceRequestEquipmentName(request: Pick<ServiceRequestDto, 'equipment'>): string {
  return request.equipment?.name ?? SERVICE_REQUEST_NO_EQUIPMENT;
}

/**
 * Площадка заявки — «код — наименование»; `null` — площадки нет вовсе.
 *
 * Пустеет она только вместе с аппаратом и только у заявки «от отдела»: у аппарата площадка есть
 * всегда (`CHECK` предмета, Р7). Поэтому `null` здесь читается как «эта заявка не про площадку», а
 * не как «площадку не показали», — и строку с ней место показа обязано убрать целиком.
 */
export function serviceRequestObjectLabel(
  request: Pick<ServiceRequestDto, 'object'>,
): string | null {
  const { object } = request;
  return object ? `${object.code} — ${object.name}` : null;
}

/**
 * «Где стоит» одной строкой: площадка и место внутри неё. `null` — сказать нечего, и строка не
 * рисуется вовсе: у заявки без аппарата нет ни снимка места, ни площадки.
 */
export function serviceRequestPlaceLine(
  request: Pick<ServiceRequestDto, 'equipment' | 'object'>,
): string | null {
  const parts = [serviceRequestObjectLabel(request), request.equipment?.location].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Where the unit stands now, as one line (ADR 0215); `null` — nothing moved since filing, and the
 * request's own snapshot above is still the answer.
 *
 * `?? null` on purpose: a portal bundle may talk to a server that predates the field, and "field
 * absent" means the same as "nothing moved" — there is no place to show.
 */
export function serviceRequestCurrentPlaceLine(
  request: Pick<ServiceRequestDto, 'currentPlace'>,
): string | null {
  const place = request.currentPlace ?? null;
  if (!place) return null;
  return officeEquipmentPlaceWords({
    objectCode: place.object.code,
    objectName: place.object.name,
    location: place.location,
    state: place.state,
    stateNote: place.stateNote,
  });
}

/**
 * "Where to go" for a single line (phone card): the current place after a move, the snapshot
 * otherwise. The prefix says which one it is — without it a moved unit's line would read as the
 * place the request was filed for.
 */
export function serviceRequestWhereToGoLine(
  request: Pick<ServiceRequestDto, 'equipment' | 'object' | 'currentPlace'>,
): string | null {
  const now = serviceRequestCurrentPlaceLine(request);
  return now ? `Сейчас: ${now}` : serviceRequestPlaceLine(request);
}

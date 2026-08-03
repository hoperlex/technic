import { presentGroupLabel, type PresentContainerGroupDto } from '@technic/contracts';

// Контейнеры, стоящие на площадке (ADR 0054): что, чьё и сколько. Форма спрашивает про них
// одним полем — «какой контейнер трогаем», — потому что тип без владельца ответа не даёт: на
// объекте могут стоять две одинаковых бочки от разных операторов, и это разные группы.
//
// Здесь всё, что нужно полям формы: ключ выбора, разбор ключа обратно и подсказка «что стоит на
// объекте». Тексты живут рядом друг с другом, чтобы форма, окно назначения и предупреждение о
// чужом контейнере говорили одними словами.

/**
 * Значение поля выбора: тип и владелец вместе. Одно поле — один ответ; хранить их порознь
 * значило бы допустить пару «тип от одного, владелец от другого», которой на площадке нет.
 *
 * Владелец может быть не известен — тогда правая часть пустая: группа «оператор не указан»
 * такая же настоящая, как остальные.
 */
export function containerGroupKey(
  g: Pick<PresentContainerGroupDto, 'containerTypeId' | 'ownerCounterpartyId'>,
): string {
  return `${g.containerTypeId}:${g.ownerCounterpartyId ?? ''}`;
}

export interface ParsedGroupKey {
  containerTypeId: string;
  ownerCounterpartyId: string | null;
}

export function parseContainerGroupKey(key: string): ParsedGroupKey {
  const [containerTypeId = '', owner = ''] = key.split(':');
  return { containerTypeId, ownerCounterpartyId: owner || null };
}

export function containerGroupOptions(
  groups: readonly PresentContainerGroupDto[],
): { value: string; label: string }[] {
  return groups.map((g) => ({ value: containerGroupKey(g), label: presentGroupLabel(g) }));
}

export function findContainerGroup(
  groups: readonly PresentContainerGroupDto[],
  key: string | undefined,
): PresentContainerGroupDto | undefined {
  return key ? groups.find((g) => containerGroupKey(g) === key) : undefined;
}

/**
 * Подсказка под полем оператора: кто уже работает на этой площадке и что там стоит. У замены и
 * снятия она объясняет правило «вывозит тот, кто привёз», у установки и вывоза мусора отвечает
 * на тот же вопрос «кого звать» — поэтому показывается у заявки любого типа.
 *
 * Пустой объект — это сведения, а не их отсутствие: «контейнеров нет» тоже ответ, и молчание
 * читалось бы как «не спрашивали».
 */
export function presentGroupsHint(groups: readonly PresentContainerGroupDto[]): string {
  if (groups.length === 0) return 'На объекте сейчас нет контейнеров';
  const parts = groups.map(
    (g) => `${g.ownerName ?? 'оператор не указан'} — ${g.containerTypeName} × ${g.quantity}`,
  );
  return `На объекте сейчас: ${parts.join('; ')}`;
}

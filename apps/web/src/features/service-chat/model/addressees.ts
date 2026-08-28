import {
  SERVICE_CHAT_SIDES,
  serviceChatSideLabels,
  type SendServiceChatMessageInput,
  type ServiceChatSide,
} from '@technic/contracts';

/**
 * Кому адресована реплика: одно поле выбора на стороны и на людей — потому что человек отвечает
 * на один вопрос «кому», а не на два. Значения поэтому помечены видом: `side:service` против
 * `user:<uuid>`. Склеенный список без пометки пришлось бы разбирать угадыванием «uuid это или
 * сторона», и первый же исполнитель с именем-uuid оказался бы стороной (та же причина, по которой
 * и ручка принимает два списка, §3.3 плана).
 */
export type AddresseeValue = `side:${ServiceChatSide}` | `user:${string}`;

export interface AddresseeOption {
  value: AddresseeValue;
  label: string;
  /**
   * Выбран «Всем участникам» — остальные пункты гаснут. Зеркало серверной проверки (§3.3): «всем»
   * и «ещё вот этому» противоречат друг другу, а при подсчёте яркости такая пара давала бы
   * двойной учёт одной реплики. Гасим, а не отбиваем при отправке: запрет, объяснённый после
   * нажатия, читается как поломка.
   */
  disabled?: boolean;
}

/** Умолчание поля — «Всем участникам»: реплика без адресата не бывает (§3.3). */
export const DEFAULT_ADDRESSEES: AddresseeValue[] = ['side:all'];

/**
 * Состав поля «Кому»: все стороны словаря плюс назначенные исполнители поимённо.
 *
 * Стороны показываются ВСЕ, включая «Сервисному центру» у заявки без исполнителя (решение опроса):
 * реплика дождётся назначенного, и прятать адресата до назначения значило бы терять вопрос,
 * который как раз и задают, пока исполнителя ищут.
 *
 * Поимённые кандидаты — `request.executors`, а не отдельный список из DTO: сервер сверяет
 * поимённого адресата с теми же строками назначения и отвечает 422 на постороннего. Третий
 * список означал бы ещё одно место, которое может разойтись с этой проверкой.
 */
export function addresseeOptions(
  executors: readonly { userId: string; name: string }[],
  selected: readonly AddresseeValue[],
): AddresseeOption[] {
  const allChosen = selected.includes('side:all');
  return [
    ...SERVICE_CHAT_SIDES.map((side) => ({
      value: `side:${side}` as AddresseeValue,
      label: serviceChatSideLabels[side],
      disabled: allChosen && side !== 'all',
    })),
    ...executors.map((executor) => ({
      value: `user:${executor.userId}` as AddresseeValue,
      label: executor.name,
      disabled: allChosen,
    })),
  ];
}

/**
 * Выбор «Всем участникам» гасит остальные пункты — и уже сделанный выбор тоже. Иначе человек,
 * отметивший сначала сторону, а потом «всем», отправил бы противоречивую пару и получил 400 от
 * схемы: правило серверное, и портал обязан выражать его до нажатия, а не после.
 */
export function normalizeAddressees(
  next: readonly AddresseeValue[],
  previous: readonly AddresseeValue[],
): AddresseeValue[] {
  const addedAll = next.includes('side:all') && !previous.includes('side:all');
  if (addedAll) return ['side:all'];
  return [...next];
}

/** Разбор помеченных значений в два списка ручки: сторонами и учётками они и хранятся (§3.3). */
export function splitAddressees(
  values: readonly AddresseeValue[],
): SendServiceChatMessageInput['addressees'] {
  const sides: ServiceChatSide[] = [];
  const users: string[] = [];
  for (const value of values) {
    if (value.startsWith('side:')) sides.push(value.slice('side:'.length) as ServiceChatSide);
    else users.push(value.slice('user:'.length));
  }
  return { sides, users };
}

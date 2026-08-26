import { AuditOutlined } from '@ant-design/icons';
import type { MobilePrimaryAction } from '@shared/ui';
import { useTicketAudit } from './useTicketAudit';

/**
 * Вход в аудит с телефона.
 *
 * Круглая кнопка списка занята созданием заявки, и второй такой у списка быть не может — место
 * второстепенных действий на телефоне — панель рядом с фильтрами (ADR 0030). Без этой строки
 * держатель права открывал бы окно только присланной ссылкой: на узком экране кнопки из панели
 * десктопа не показываются вовсе, и вход пропадал бы ровно у того, кому право выдали поимённо.
 *
 * Действие, а не компонент: панель списка принимает описания, а не разметку, — так она сама решает,
 * где их разместить и как подписать.
 */
export function useTicketAuditMobileAction(allowed: boolean): MobilePrimaryAction | undefined {
  const { open } = useTicketAudit();
  if (!allowed) return undefined;
  return { label: 'Аудит распознавания', icon: <AuditOutlined />, onClick: open };
}

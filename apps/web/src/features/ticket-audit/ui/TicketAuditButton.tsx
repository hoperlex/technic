import { Button } from 'antd';
import { AuditOutlined } from '@ant-design/icons';
import { useTicketAudit } from '../model/useTicketAudit';

/**
 * Вход в аудит распознавания — кнопка в панели реестра вывоза.
 *
 * Право спрашивает вызывающий и передаёт сюда: слайс не знает, откуда портал берёт полномочия, а
 * страница знает — и там же стоят все остальные проверки той же панели. Без права кнопки нет
 * вовсе: право сильное (держатель видит адреса всех площадок и сканы талонов всех операторов), и
 * показывать вход, ведущий в отказ, здесь незачем.
 */
export function TicketAuditButton({ allowed }: { allowed: boolean }) {
  const { open } = useTicketAudit();
  if (!allowed) return null;
  return (
    <Button icon={<AuditOutlined />} onClick={open}>
      Аудит распознавания
    </Button>
  );
}

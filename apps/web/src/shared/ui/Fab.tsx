import { Button } from 'antd';
import type { MobilePrimaryAction } from './listControls';

/**
 * Главное действие списка круглой кнопкой над нижней навигацией (ADR 0030). На десктопе
 * «Создать заявку» стоит в шапке страницы; на телефоне шапка отдана фильтрам, а создание —
 * действие, за которым в список и заходят, поэтому оно остаётся на экране всегда.
 */
export function Fab({ label, icon, onClick }: MobilePrimaryAction) {
  return (
    <Button
      type="primary"
      shape="circle"
      size="large"
      className="list-fab"
      icon={icon}
      aria-label={label}
      onClick={onClick}
    />
  );
}

import type { ReactNode } from 'react';

export interface MobileNavItem {
  key: string;
  icon: ReactNode;
  /** Полное название раздела: оно же — доступное имя кнопки. */
  label: string;
  /** Подпись под иконкой: «Администрирование» в четверть экрана 360 px не помещается. */
  short: string;
}

interface Props {
  items: MobileNavItem[];
  selectedKey: string;
  onSelect: (key: string) => void;
}

/**
 * Нижняя навигация мобильного режима (ADR 0030): разделов у роли не больше четырёх, и каждый
 * достижим одним касанием в зоне большого пальца. Состав пунктов приходит уже отфильтрованным
 * по правам — здесь он не проверяется повторно.
 */
export function MobileNav({ items, selectedKey, onSelect }: Props) {
  if (items.length === 0) return null;
  return (
    <nav className="mobile-nav" aria-label="Разделы портала">
      {items.map((item) => {
        const active = item.key === selectedKey;
        return (
          <button
            key={item.key}
            type="button"
            className={`mobile-nav__item${active ? ' mobile-nav__item--active' : ''}`}
            aria-label={item.label}
            aria-current={active ? 'page' : undefined}
            onClick={() => onSelect(item.key)}
          >
            <span className="mobile-nav__icon">{item.icon}</span>
            <span className="mobile-nav__label">{item.short}</span>
          </button>
        );
      })}
    </nav>
  );
}

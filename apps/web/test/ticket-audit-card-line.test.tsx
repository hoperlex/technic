import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CardLine, ColumnTitle } from '../src/features/ticket-audit/ui/CardLine';

/**
 * The caption pair shared by the four «Аудит талонов» row views. It replaced four local copies that
 * differed in one thing only — whether the caption carries a definition — so both branches are
 * pinned here: a lost branch would silently turn the event feed's field names into fake metrics, or
 * strip the definitions from the metrics.
 */
describe('строка раскрытия аудита талонов', () => {
  it('подпись показателя раскрывает определение по наведению', async () => {
    render(<ColumnTitle title="Исправлено" hint="Человек изменил прочитанное моделью значение" />);

    const caption = screen.getByText('Исправлено');
    // A metric caption reads as an ordinary title, not as a muted field name.
    expect(caption.closest('.ant-typography-secondary')).toBeNull();
    fireEvent.mouseEnter(caption);
    expect(await screen.findByText('Человек изменил прочитанное моделью значение')).toBeTruthy();
  });

  it('подпись без определения приглушена', () => {
    render(<ColumnTitle title="Автор" />);

    expect(screen.getByText('Автор').closest('.ant-typography-secondary')).not.toBeNull();
  });

  it('подпись и значение стоят в одной строке', () => {
    render(
      <CardLine title="Разборов" hint="Машинных разборов">
        <span>12</span>
      </CardLine>,
    );

    const row = screen.getByText('Разборов').closest('.ant-space');
    expect(row).not.toBeNull();
    expect(row!.contains(screen.getByText('12'))).toBe(true);
  });
});

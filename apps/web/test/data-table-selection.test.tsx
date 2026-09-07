import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DataTable, listScopeKey, type CardConfig } from '../src/shared/ui';
import { DESKTOP_VIEWPORT, MOBILE_VIEWPORT, setViewport } from './viewport';

/**
 * Общие правила выбора строк в списках портала (план массовых действий, Р13–Р15).
 *
 * Проверяется не разметка, а три правила, которые нельзя оставлять на усмотрение страницы:
 * выбор гаснет при смене того, что видно; потолок пачки не обрезает набор молча; на телефоне,
 * где карточка чекбокса не имеет, полосы выбора нет. Четвёртое — что список, не объявивший
 * отпечатка отбора, ведёт себя как раньше: журнал путевых листов уже печатает пачками, и правила
 * заводились так, чтобы его не переписывать.
 */

interface Row {
  id: string;
  name: string;
}

const ROWS: Row[] = [
  { id: 'r1', name: 'Лист 1' },
  { id: 'r2', name: 'Лист 2' },
  { id: 'r3', name: 'Лист 3' },
];

const columns = [
  { key: 'name', title: 'Лист', dataIndex: 'name', width: 160 },
  { key: 'actions', title: 'Действия', fixed: 'right' as const, width: 120 },
];

interface ListProps {
  scopeKey?: string;
  maxSelected?: number;
  card?: CardConfig<Row>;
  initialKeys?: string[];
  disabled?: (record: Row) => string | null;
  onSelect?: (keys: string[]) => void;
}

/**
 * Список с выбором и своим состоянием — как у страницы: ключи живут у неё, а `DataTable` только
 * говорит, каким им быть. Проверять гашение выбора на неуправляемом списке было бы нечестно:
 * половина правила как раз в том, что о гашении узнаёт страница.
 */
function List({ scopeKey, maxSelected, card, initialKeys = [], disabled, onSelect }: ListProps) {
  const [keys, setKeys] = useState<string[]>(initialKeys);
  return (
    <DataTable<Row>
      columns={columns}
      data={ROWS}
      total={ROWS.length}
      page={1}
      pageSize={50}
      card={card}
      onChange={vi.fn()}
      selection={{
        keys,
        onChange: (next) => {
          onSelect?.(next);
          setKeys(next);
        },
        scopeKey,
        maxSelected,
        disabled,
        bar: (selected) => <span>Выбрано {selected.length}</span>,
      }}
    />
  );
}

const rowOf = (name: string): HTMLElement => screen.getByText(name).closest('tr')!;
const boxOf = (name: string): HTMLInputElement =>
  rowOf(name).querySelector('input[type="checkbox"]')!;
/** Заголовок таблица рисует дважды (видимая шапка и слой измерения) — берём первый. */
const headBox = (): HTMLInputElement =>
  screen.getAllByLabelText('Выбрать всё на странице')[0] as HTMLInputElement;
const selectedText = () => screen.queryByText(/Выбрано/)?.textContent ?? null;

/** Отбор, при котором набирали выбор: страница, сортировка, фильтры, поиск и очередь-пресет. */
const SCOPE = {
  page: 1,
  pageSize: 50,
  sortBy: 'number',
  sortOrder: 'desc',
  status: undefined,
  search: '',
  preset: 'urgent',
};

describe('выбор гаснет при смене того, что видно', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['страница', { ...SCOPE, page: 2 }],
    ['размер страницы', { ...SCOPE, pageSize: 100 }],
    ['сортировка', { ...SCOPE, sortOrder: 'asc' }],
    ['фильтр', { ...SCOPE, status: 'issued' }],
    ['поиск', { ...SCOPE, search: '646' }],
    ['очередь-пресет', { ...SCOPE, preset: 'documents' }],
  ];

  for (const [what, next] of cases) {
    it(`${what}: набранный выбор снят и у списка, и у страницы`, () => {
      const onSelect = vi.fn<(keys: string[]) => void>();
      const { rerender } = render(<List scopeKey={listScopeKey(SCOPE)} onSelect={onSelect} />);

      fireEvent.click(boxOf('Лист 1'));
      expect(selectedText()).toBe('Выбрано 1');

      rerender(<List scopeKey={listScopeKey(next)} onSelect={onSelect} />);

      // Полоса гаснет в том же рендере: сказать «Выбрано 1» про другой отбор нельзя даже на миг.
      expect(selectedText()).toBeNull();
      expect(boxOf('Лист 1').checked).toBe(false);
      // И страница об этом узнаёт: ключи живут у неё, и в действие ушли бы именно они.
      expect(onSelect).toHaveBeenLastCalledWith([]);
    });
  }

  it('тот же отбор, записанный иначе, выбор не трогает', () => {
    const onSelect = vi.fn<(keys: string[]) => void>();
    const { rerender } = render(<List scopeKey={listScopeKey(SCOPE)} onSelect={onSelect} />);
    fireEvent.click(boxOf('Лист 2'));

    // Порядок ключей в объекте параметров зависит от того, каким `setParams` его собрали
    // последним, а пустая строка и `undefined` — это одинаково «фильтр не задан».
    rerender(
      <List
        scopeKey={listScopeKey({
          preset: 'urgent',
          pageSize: 50,
          sortOrder: 'desc',
          page: 1,
          sortBy: 'number',
        })}
        onSelect={onSelect}
      />,
    );

    expect(selectedText()).toBe('Выбрано 1');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('пустой выбор странице не сообщается', () => {
    const onSelect = vi.fn<(keys: string[]) => void>();
    const { rerender } = render(<List scopeKey={listScopeKey(SCOPE)} onSelect={onSelect} />);

    rerender(<List scopeKey={listScopeKey({ ...SCOPE, page: 3 })} onSelect={onSelect} />);

    // Листание пустым списком не должно стоить странице лишней перерисовки.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('без отпечатка отбора выбор живёт, пока его не снимут — как в журнале путевых листов', () => {
    const onSelect = vi.fn<(keys: string[]) => void>();
    const { rerender } = render(<List onSelect={onSelect} />);

    fireEvent.click(boxOf('Лист 1'));
    rerender(<List onSelect={onSelect} />);

    expect(selectedText()).toBe('Выбрано 1');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe('потолок выбора', () => {
  it('строка сверх потолка не берётся молча и объясняет отказ', async () => {
    const onSelect = vi.fn<(keys: string[]) => void>();
    render(<List maxSelected={2} onSelect={onSelect} />);

    fireEvent.click(boxOf('Лист 1'));
    fireEvent.click(boxOf('Лист 2'));
    expect(selectedText()).toBe('Выбрано 2');

    const third = boxOf('Лист 3');
    expect(third.disabled).toBe(true);
    fireEvent.click(third);

    // Набор остался тем, что человек составил: ни третьей строки, ни тихо выброшенной первой.
    expect(selectedText()).toBe('Выбрано 2');
    expect(onSelect).toHaveBeenLastCalledWith(['r1', 'r2']);

    fireEvent.mouseEnter(third.closest('td')!.firstElementChild!);
    expect(await screen.findByText('Лимит 2; снимите часть строк')).toBeDefined();
  });

  it('снять выбор в упор в потолок можно всегда', () => {
    render(<List maxSelected={2} />);
    fireEvent.click(boxOf('Лист 1'));
    fireEvent.click(boxOf('Лист 2'));

    expect(boxOf('Лист 1').disabled).toBe(false);
    fireEvent.click(boxOf('Лист 1'));
    expect(selectedText()).toBe('Выбрано 1');
  });

  it('страница больше потолка не отмечается наполовину и говорит об этом заранее', async () => {
    const onSelect = vi.fn<(keys: string[]) => void>();
    render(<List maxSelected={2} onSelect={onSelect} />);

    const head = headBox();
    expect(head.disabled).toBe(true);
    fireEvent.click(head);

    // Взять из страницы столько, сколько влезло, значило бы отдать в действие набор, который
    // составил порядок сортировки, а не человек.
    expect(selectedText()).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.mouseEnter(head.closest('th')!.firstElementChild!);
    expect(await screen.findByText(/Лимит 2; на странице 3/)).toBeDefined();
  });

  it('страница, помещающаяся в потолок, отмечается целиком', () => {
    render(<List maxSelected={3} />);
    fireEvent.click(headBox());
    expect(selectedText()).toBe('Выбрано 3');
  });

  it('доменный запрет сильнее потолка и не исчезает, когда строки снимут', () => {
    render(
      <List
        maxSelected={3}
        disabled={(r) => (r.id === 'r3' ? 'Аннулированный не печатают' : null)}
      />,
    );

    // Не выбирается вовсе, хотя до потолка ещё далеко: причина у этой строки своя.
    expect(boxOf('Лист 3').disabled).toBe(true);
    fireEvent.click(headBox());
    expect(selectedText()).toBe('Выбрано 2');
  });
});

describe('телефон', () => {
  const card: CardConfig<Row> = { title: (r) => r.name };

  it('в карточном списке нет ни чекбоксов, ни полосы выбора', () => {
    setViewport(MOBILE_VIEWPORT);
    const { container } = render(<List card={card} initialKeys={['r1', 'r2']} />);

    // Полоса без чекбоксов — управление тем, чего на этом экране ни снять, ни добавить: выбор
    // попадает сюда с десктопа того же сеанса.
    expect(container.querySelectorAll('input[type="checkbox"]').length).toBe(0);
    expect(selectedText()).toBeNull();
  });

  it('тот же выбор на десктопе полосу показывает', () => {
    setViewport(DESKTOP_VIEWPORT);
    render(<List card={card} initialKeys={['r1', 'r2']} />);
    expect(selectedText()).toBe('Выбрано 2');
  });

  it('на телефоне без карточек колонка выбора остаётся, и полоса при ней', () => {
    setViewport(MOBILE_VIEWPORT);
    // Журнал путевых листов на телефоне остаётся таблицей: чекбоксы в строках есть, и печать
    // пачкой оттуда работает — граница Р15 проходит по карточке, а не по устройству.
    render(<List initialKeys={['r1']} />);
    expect(boxOf('Лист 1').checked).toBe(true);
    expect(selectedText()).toBe('Выбрано 1');
  });
});

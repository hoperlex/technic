import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DataTable, type CardConfig, type TableChange } from '../src/components/DataTable';
import { FilterSheet } from '../src/components/FilterSheet';
import type { FilterDefinition } from '../src/components/listControls';
import { sortOptionsFrom } from '../src/components/listControls';
import { DESKTOP_VIEWPORT, MOBILE_VIEWPORT, setViewport } from './viewport';

/**
 * Список на телефоне (ADR 0030). Проверяется не вид, а то, что функциональность списка никуда
 * не делась: действия строки доступны, фильтры уходят в параметры одним заходом, а листание
 * не сбрасывает ни сортировку, ни фильтры.
 */

interface Row {
  id: string;
  num: number;
  objectName: string;
}

const rows: Row[] = [
  { id: 'a', num: 128, objectName: 'ЖК Северный' },
  { id: 'b', num: 129, objectName: 'ЖК Южный' },
];

const columns = [
  { key: 'num', title: '№', dataIndex: 'num', sorter: true, width: 90 },
  { key: 'objectName', title: 'Объект', dataIndex: 'objectName', sorter: true },
  { key: 'actions', title: 'Действия', fixed: 'right' as const, width: 120 },
];

function renderList(card: CardConfig<Row> | undefined, onChange = vi.fn()) {
  return render(
    <DataTable<Row>
      columns={columns}
      card={card}
      data={rows}
      total={2}
      page={1}
      pageSize={50}
      sortBy="num"
      sortOrder="desc"
      onChange={onChange}
    />,
  );
}

describe('представление списка', () => {
  it('на телефоне с описанием карточки строки показываются карточками', () => {
    setViewport(MOBILE_VIEWPORT);
    renderList({ title: (r) => `№ ${r.num}`, primary: (r) => r.objectName });
    expect(screen.getByText('№ 128')).toBeDefined();
    expect(screen.getByText('ЖК Северный')).toBeDefined();
    expect(document.querySelector('.ant-table')).toBeNull();
  });

  it('на телефоне без описания карточки остаётся таблица с прокруткой', () => {
    setViewport(MOBILE_VIEWPORT);
    renderList(undefined);
    expect(document.querySelector('.ant-table')).not.toBeNull();
  });

  it('на десктопе таблица остаётся всегда', () => {
    setViewport(DESKTOP_VIEWPORT);
    renderList({ title: (r) => `№ ${r.num}` });
    expect(document.querySelector('.ant-table')).not.toBeNull();
  });
});

describe('действия карточки', () => {
  const cardWith = (onOpen: () => void, onEdit: () => void): CardConfig<Row> => ({
    title: (r) => `№ ${r.num}`,
    onOpen,
    actions: () => [
      { key: 'edit', label: 'Редактировать', onClick: onEdit },
      { key: 'delete', label: 'Удалить', danger: true, onClick: vi.fn() },
    ],
  });

  it('касание по карточке открывает запись', () => {
    setViewport(MOBILE_VIEWPORT);
    const onOpen = vi.fn();
    renderList(cardWith(onOpen, vi.fn()));
    fireEvent.click(screen.getByText('№ 128'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('касание по меню не открывает запись заодно', () => {
    setViewport(MOBILE_VIEWPORT);
    const onOpen = vi.fn();
    renderList(cardWith(onOpen, vi.fn()));
    fireEvent.click(screen.getAllByLabelText('Действия')[0]!);
    expect(onOpen).not.toHaveBeenCalled();
    // Действия названы словами: подсказка на иконке по касанию не открывается.
    expect(screen.getByText('Редактировать')).toBeDefined();
    expect(screen.getByText('Удалить')).toBeDefined();
  });

  it('пункт меню выполняет своё действие', () => {
    setViewport(MOBILE_VIEWPORT);
    const onEdit = vi.fn();
    renderList(cardWith(vi.fn(), onEdit));
    fireEvent.click(screen.getAllByLabelText('Действия')[0]!);
    fireEvent.click(screen.getByText('Редактировать'));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});

describe('листание на телефоне', () => {
  it('не сбрасывает сортировку и не трогает фильтры', () => {
    setViewport(MOBILE_VIEWPORT);
    const onChange = vi.fn<(change: TableChange) => void>();
    render(
      <DataTable<Row>
        columns={columns}
        card={{ title: (r) => `№ ${r.num}` }}
        data={rows}
        total={120}
        page={1}
        pageSize={50}
        sortBy="num"
        sortOrder="asc"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTitle('Next Page'));
    expect(onChange).toHaveBeenCalledWith({
      page: 2,
      pageSize: 50,
      sortBy: 'num',
      sortOrder: 'asc',
    });
    // filters отсутствует — значит «не менялись»: иначе поиск по столбцу терялся бы на второй
    // странице.
    expect(onChange.mock.calls[0]?.[0].filters).toBeUndefined();
  });
});

describe('шит фильтров', () => {
  const build = (onObject: (v?: string) => void, onStatus: (v?: string) => void) =>
    [
      {
        kind: 'select',
        key: 'objectId',
        label: 'Объект',
        value: 'obj-1',
        options: [
          { value: 'obj-1', label: 'ЖК Северный' },
          { value: 'obj-2', label: 'ЖК Южный' },
        ],
        disabled: true,
        onChange: onObject,
      },
      {
        kind: 'select',
        key: 'status',
        label: 'Статус',
        value: undefined,
        options: [
          { value: 'new', label: 'Новая' },
          { value: 'done', label: 'Выполнена' },
        ],
        onChange: onStatus,
      },
    ] satisfies FilterDefinition[];

  function openSheet(filters: FilterDefinition[]) {
    setViewport(MOBILE_VIEWPORT);
    return render(<FilterSheet open onClose={vi.fn()} filters={filters} />);
  }

  it('выбор значения не уходит в список до «Применить»', () => {
    const onStatus = vi.fn();
    openSheet(build(vi.fn(), onStatus));

    // Первый список — объект (он заблокирован), второй — статус.
    const selects = document.querySelectorAll('.ant-select-content');
    fireEvent.mouseDown(selects[1]!);
    fireEvent.click(screen.getByText('Выполнена'));
    expect(onStatus).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Применить'));
    expect(onStatus).toHaveBeenCalledWith('done');
  });

  it('«Применить» не трогает фильтры, которые не меняли', () => {
    const onObject = vi.fn();
    const onStatus = vi.fn();
    openSheet(build(onObject, onStatus));
    fireEvent.click(screen.getByText('Применить'));
    expect(onObject).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('«Сбросить» не снимает фильтр, зафиксированный ролью', () => {
    const onObject = vi.fn();
    const onStatus = vi.fn();
    openSheet(build(onObject, onStatus));
    fireEvent.click(screen.getByText('Сбросить'));
    fireEvent.click(screen.getByText('Применить'));
    // Объект у штаба остаётся выбранным, а пустой статус и был пустым — менять нечего.
    expect(onObject).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
  });
});

describe('поля сортировки', () => {
  it('берутся из сортируемых колонок', () => {
    expect(sortOptionsFrom(columns)).toEqual([
      { key: 'num', label: '№' },
      { key: 'objectName', label: 'Объект' },
    ]);
  });

  it('заголовок-разметка заменяется подписью, а без подписи поле пропускается', () => {
    const withNode = [
      { key: 'createdAt', title: <div>Дата</div>, sorter: true },
      { key: 'other', title: <div>Другое</div>, sorter: true },
    ];
    expect(sortOptionsFrom(withNode, { createdAt: 'Дата создания' })).toEqual([
      { key: 'createdAt', label: 'Дата создания' },
    ]);
  });
});

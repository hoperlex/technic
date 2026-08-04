import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { DataTable, type CardConfig, type TableChange } from '../src/shared/ui';
import { FilterSheet } from '../src/shared/ui';
import { ListToolbar } from '../src/shared/ui';
import type { FilterDefinition } from '../src/shared/ui';
import { sortOptionsFrom } from '../src/shared/ui';
import { ApprovalCell } from '../src/pages/vehicle/shared';
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

  it('переключатель уходит в список только по «Применить»', () => {
    const onToggle = vi.fn();
    setViewport(MOBILE_VIEWPORT);
    render(
      <FilterSheet
        open
        onClose={vi.fn()}
        filters={[
          {
            kind: 'toggle',
            key: 'includeDeleted',
            label: 'Показывать архив',
            value: false,
            onChange: onToggle,
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('switch'));
    expect(onToggle).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Применить'));
    expect(onToggle).toHaveBeenCalledWith(true);
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

describe('виза в карточке заявки ТС', () => {
  it('нажатие на кнопку визы не открывает карточку заодно', () => {
    setViewport(MOBILE_VIEWPORT);
    const onApprove = vi.fn();
    const onOpen = vi.fn();
    render(
      <DataTable<Row>
        columns={columns}
        card={{
          title: (r) => `№ ${r.num}`,
          onOpen,
          lines: [
            () => (
              <ApprovalCell
                status="new"
                deleted={false}
                approved={false}
                approvedByName={null}
                approvedAt={null}
                canApprove
                pending={false}
                onChange={onApprove}
              />
            ),
          ],
        }}
        data={[rows[0]!]}
        total={1}
        page={1}
        pageSize={50}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Согласовать' }));
    expect(onApprove).toHaveBeenCalledWith(true);
    expect(onOpen).not.toHaveBeenCalled();
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

/**
 * Поиск в панели списка (ADR 0042). На телефоне лупы в заголовке столбца нет — до неё там не
 * дотянуться, — поэтому строка поиска стоит на виду и уходит в параметры сама, с задержкой.
 */
describe('поиск в панели списка', () => {
  it('набранное уходит в список после паузы, а не по каждой букве', async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<ListToolbar search={{ value: undefined, onChange }} />);

    const field = screen.getByPlaceholderText('Поиск');
    fireEvent.change(field, { target: { value: 'ЖК' } });
    fireEvent.change(field, { target: { value: 'ЖК Сев' } });
    expect(onChange).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('ЖК Сев');
    vi.useRealTimers();
  });

  it('Enter отправляет сразу, а пустая строка снимает поиск', () => {
    const onChange = vi.fn();
    render(<ListToolbar search={{ value: 'ЖК', onChange }} />);

    const field = screen.getByDisplayValue('ЖК');
    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 13 });
    fireEvent.keyUp(field, { key: 'Enter', keyCode: 13 });

    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('панель без единого контрола не рисуется', () => {
    const { container } = render(<ListToolbar />);
    expect(container.querySelector('.list-toolbar')).toBeNull();
  });
});

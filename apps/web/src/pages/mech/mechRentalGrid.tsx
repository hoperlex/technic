import { Button, Dropdown, Space, Tooltip, Typography, type TableColumnsType } from 'antd';
import { EyeOutlined, MoreOutlined } from '@ant-design/icons';
import type { MechRequestDto } from '@technic/contracts';
import {
  mechDayLabel,
  mechDaysLeftLabel,
  mechRequesterLabel,
  mechRateLabel,
  MechPlaceCell,
  MechRateCell,
  MechRequesterCell,
} from '@entities/mech-request';
import { actionsColumn, type ActionSheetItem, type CardConfig } from '@shared/ui';

/**
 * Вкладка «В аренде»: колонки таблицы и карточка телефона (§7, Р13).
 *
 * Набор колонок свой, а не урезанный набор списка заявок, и порядок в нём обратный. Список заявок
 * читают по номеру — «что там с МХ-42», — а присутствие читают по площадке: «что у нас сейчас
 * стоит и до какого числа». Поэтому первой идёт площадка с адресом (по нему едут забирать), а
 * номер уезжает в конец: он здесь ключ к карточке, а не то, чем строку узнают.
 *
 * Чего в наборе нет и почему: **статуса** — все строки в одном состоянии по построению отбора
 * (Р2), и столбец повторял бы одно слово; **срока подачи** — план начала у выданной техники уже
 * неинтересен, его заменяет фактическая выдача; **ответственного и комментария** — их спрашивают у
 * карточки, а ширину они забирают у главного вопроса вкладки, остатка срока.
 *
 * «Сегодня» приходит сверху одним значением (Р12): остаток считается в таблице и в карточке, и
 * спроси каждая своё «сейчас» — список, открытый в полночь, показал бы часть строк по вчерашнему
 * дню.
 */
export interface MechRentalGridOptions {
  /** Московский день `YYYY-MM-DD`, посчитанный один раз на отрисовку вкладки. */
  today: string;
  actions: (request: MechRequestDto) => ActionSheetItem[];
  onOpen: (request: MechRequestDto) => void;
}

/**
 * Остаток срока — главный столбец вкладки: ради него её и открывают. Просрочка красная и жирная, а
 * не просто подписью: это единственная строка, из-за которой берут телефон и звонят арендодателю.
 *
 * Своей ячейкой, а не общей `MechTermCell` списка заявок: та показывает дату возврата с остатком
 * под ней, а здесь дата стоит отдельным столбцом (по ней сортируют), и остаток обязан быть
 * самостоятельным значением — иначе он повторял бы соседнюю ячейку.
 */
function MechLeftCell({ row, today }: { row: MechRequestDto; today: string }) {
  const left = mechDaysLeftLabel(row, today);
  if (!left) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <Typography.Text type={left.overdue ? 'danger' : undefined} strong={left.overdue}>
      {left.text}
    </Typography.Text>
  );
}

export function mechRentalColumns(opts: MechRentalGridOptions): TableColumnsType<MechRequestDto> {
  return [
    {
      // Площадка с адресом первой (Р13): вкладку открывают вопросом «что где стоит», и адрес —
      // второй вопрос к той же строке: куда ехать забирать.
      key: 'objectName',
      title: 'Площадка',
      dataIndex: 'objectName',
      width: 240,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) => <MechPlaceCell row={r} />,
    },
    {
      key: 'requesterName',
      title: 'Заявитель',
      dataIndex: 'departmentName',
      width: 180,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) => <MechRequesterCell row={r} />,
    },
    {
      key: 'kindName',
      title: 'Вид техники',
      dataIndex: 'kindName',
      width: 190,
      sorter: true,
    },
    {
      key: 'lessorName',
      title: 'Арендодатель',
      dataIndex: 'lessorName',
      width: 180,
      sorter: true,
      // У действующей аренды арендодатель есть всегда — договорённость стоит до выдачи (Р8), — но
      // прочерк оставлен: строка приходит с сервера, и врать про «не выбран» она не должна.
      render: (_v: unknown, r: MechRequestDto) =>
        r.lessorName ?? <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      key: 'rate',
      title: 'Ставка',
      dataIndex: 'rate',
      width: 130,
      align: 'right' as const,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) => (
        <MechRateCell rate={r.rate} rateUnit={r.rateUnit} />
      ),
    },
    {
      /*
       * Выдана — фактическая дата, а не плановая подача: у присутствия начало одно, и оно
       * случилось. Сортировки нет: `actualFrom` не значится в `MECH_REQUEST_SORT_FIELDS`, и
       * заголовок-сортировщик здесь означал бы 400 от сервера на первое же нажатие.
       */
      key: 'actualFrom',
      title: 'Выдана',
      dataIndex: 'actualFrom',
      width: 120,
      render: (_v: unknown, r: MechRequestDto) => mechDayLabel(r.actualFrom),
    },
    {
      key: 'plannedTo',
      title: 'План возврата',
      dataIndex: 'plannedTo',
      width: 140,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) => mechDayLabel(r.plannedTo),
    },
    {
      /*
       * Остаток — производная от плановой даты, а не колонка базы: сортировать по нему значит
       * сортировать по `plannedTo`, и в соседнем столбце это уже можно. Своего сортировщика у
       * него поэтому нет.
       */
      key: 'daysLeft',
      title: 'Осталось',
      width: 150,
      render: (_v: unknown, r: MechRequestDto) => <MechLeftCell row={r} today={opts.today} />,
    },
    {
      key: 'num',
      title: '№ заявки',
      dataIndex: 'displayNumber',
      width: 110,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) => r.displayNumber,
    },
    actionsColumn<MechRequestDto>((r) => {
      const items = opts.actions(r);
      return (
        <Space size={4}>
          <Tooltip title="Открыть заявку">
            <Button
              size="small"
              icon={<EyeOutlined />}
              aria-label="Открыть заявку"
              onClick={() => opts.onOpen(r)}
            />
          </Tooltip>
          {items.length > 0 && (
            <Dropdown
              trigger={['click']}
              menu={{
                items: items.map((item) => ({
                  key: item.key,
                  label: item.label,
                  danger: item.danger,
                  disabled: item.disabled,
                  title: item.disabledReason,
                })),
                onClick: ({ key }) => items.find((item) => item.key === key)?.onClick(),
              }}
            >
              <Button size="small" icon={<MoreOutlined />} aria-label="Действия" />
            </Dropdown>
          )}
        </Space>
      );
    }, 110),
  ];
}

/**
 * Карточка действующей аренды на телефоне (ADR 0030).
 *
 * В шапке — площадка, а не номер заявки: на вкладке присутствия строку узнают по месту, и номер
 * здесь нужен только тому, кто пойдёт открывать заявку. Он и стоит последней строкой, вместе со
 * сроком.
 *
 * Бейджа состояния нет: он был бы одинаков у всех карточек. Его место занимает остаток срока —
 * единственное, чем строки этой вкладки различаются по срочности.
 */
export function mechRentalCard(opts: MechRentalGridOptions): CardConfig<MechRequestDto> {
  return {
    title: (r) => r.objectName,
    badge: (r) => {
      const left = mechDaysLeftLabel(r, opts.today);
      return left ? (
        <Typography.Text type={left.overdue ? 'danger' : 'secondary'} strong={left.overdue}>
          {left.text}
        </Typography.Text>
      ) : null;
    },
    primary: (r) => r.kindName,
    lines: [
      // Адрес — куда ехать забирать; пустой не рисуется вовсе (карточка пропускает пустые строки).
      (r) => r.objectAddress.trim() || null,
      (r) => (r.departmentId ? `Заявитель: ${mechRequesterLabel(r)}` : null),
      (r) => (r.lessorName ? `${r.lessorName} · ${mechRateLabel(r.rate, r.rateUnit)}` : null),
      (r) =>
        `Выдана ${mechDayLabel(r.actualFrom)}, возврат ${mechDayLabel(r.plannedTo)} · ${r.displayNumber}`,
    ],
    onOpen: opts.onOpen,
    actions: (r) => [
      {
        key: 'open',
        label: 'Открыть заявку',
        icon: <EyeOutlined />,
        onClick: () => opts.onOpen(r),
      },
      ...opts.actions(r),
    ],
  };
}

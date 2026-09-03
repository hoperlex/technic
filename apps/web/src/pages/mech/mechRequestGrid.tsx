import { Button, Dropdown, Space, Tooltip, Typography, type TableColumnsType } from 'antd';
import { EyeOutlined, MoreOutlined } from '@ant-design/icons';
import type { MechRequestDto } from '@technic/contracts';
import {
  mechDayLabel,
  mechDaysLeftLabel,
  mechModelLabel,
  mechRateLabel,
  mechRequesterLabel,
  MechPlaceCell,
  MechRateCell,
  MechRequesterCell,
  MechStateTag,
  MechTermCell,
} from '@entities/mech-request';
import { actionsColumn, ExpandableCell, type ActionSheetItem, type CardConfig } from '@shared/ui';
import { FilesCell } from '../../components/FileLinks';
import { PhoneLink } from '../../components/PhoneField';

/**
 * Список аренд: колонки таблицы и карточка телефона из одних и тех же ячеек (§7).
 *
 * Набор один на все роли, в отличие от соседней оргтехники: у механизации стороны две — тот, кто
 * просит, и тот, кто договаривается, — и обе спрашивают у списка одно и то же. Прятать от
 * заявителя ставку было бы неверно: расходы относятся на него, и цену аренды он видит в своём же
 * бюджете.
 *
 * «Сегодня» приходит сверху одним значением (Р12): остаток срока считается в двух местах —
 * колонке и строке карточки, — и спроси каждое своё «сейчас», список, открытый в полночь, показал
 * бы часть строк по вчерашнему дню.
 */
export interface MechGridOptions {
  /** Московский день `YYYY-MM-DD`, посчитанный один раз на отрисовку списка. */
  today: string;
  actions: (request: MechRequestDto) => ActionSheetItem[];
  onOpen: (request: MechRequestDto) => void;
}

export function mechRequestColumns(opts: MechGridOptions): TableColumnsType<MechRequestDto> {
  return [
    {
      key: 'num',
      title: '№',
      dataIndex: 'displayNumber',
      width: 110,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) => r.displayNumber,
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
      // Площадка — место эксплуатации, и она есть у каждой заявки (Р17). Отдельно от заявителя:
      // у заявки отдела это разные вещи, и один столбец на оба смысла врал бы половине строк.
      key: 'objectName',
      title: 'Площадка',
      dataIndex: 'objectName',
      width: 200,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) => <MechPlaceCell row={r} />,
    },
    {
      /*
       * Ключ столбца остался `kindName` и после того, как одноимённая колонка ушла из базы
       * (ADR 0156, уборка Э3): он идентифицирует СТОЛБЕЦ, а не поле, сервер знает его в
       * `MECH_REQUEST_SORT_FIELDS` и сортирует по наименованию модели. Переименуй ключ — открытая
       * вкладка старой сборки получала бы 400 на сортировку, которую сама же и предлагает.
       */
      key: 'kindName',
      title: 'Модель',
      dataIndex: 'mechModelName',
      width: 190,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) => mechModelLabel(r),
    },
    // Срок — две колонки одной подписи: «с» и «по» отвечают на разные вопросы («когда начали»,
    // «когда возвращать»), и сортировка по ним нужна разная.
    {
      key: 'plannedFrom',
      title: 'Подача',
      dataIndex: 'plannedFrom',
      width: 110,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) => mechDayLabel(r.plannedFrom),
    },
    {
      key: 'plannedTo',
      title: 'Возврат',
      dataIndex: 'plannedTo',
      width: 140,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) => <MechTermCell row={r} today={opts.today} />,
    },
    {
      key: 'status',
      title: 'Статус',
      dataIndex: 'status',
      width: 190,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) => <MechStateTag row={r} />,
    },
    {
      key: 'lessorName',
      title: 'Арендодатель',
      dataIndex: 'lessorName',
      width: 180,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) =>
        r.lessorName ?? <Typography.Text type="secondary">не выбран</Typography.Text>,
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
      key: 'responsibleName',
      title: 'Ответственный',
      dataIndex: 'responsibleName',
      width: 180,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) => (
        <div style={{ lineHeight: 1.35 }}>
          <div>{r.responsibleName || '—'}</div>
          {/* Номер ссылкой `tel:`: арендодатель везёт технику к человеку, а не к адресу, и по
              этому контакту в списке именно звонят (ADR 0066). */}
          {r.responsiblePhone && <PhoneLink phone={r.responsiblePhone} />}
        </div>
      ),
    },
    {
      key: 'files',
      title: 'Файлы',
      dataIndex: 'files',
      width: 110,
      render: (_v: unknown, r: MechRequestDto) => <FilesCell files={r.files} />,
    },
    {
      key: 'comment',
      title: 'Комментарий',
      dataIndex: 'comment',
      width: 220,
      sorter: true,
      // Комментарий длинный и читают его не всегда: свёрнутая ячейка не растит строку списка.
      render: (_v: unknown, r: MechRequestDto) => <ExpandableCell>{r.comment}</ExpandableCell>,
    },
    {
      key: 'createdAt',
      title: 'Заведена',
      dataIndex: 'createdAt',
      width: 160,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) => (
        <div style={{ lineHeight: 1.35 }}>
          <div>{mechDayLabel(r.createdAt.slice(0, 10))}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.createdByName}
          </Typography.Text>
        </div>
      ),
    },
    actionsColumn<MechRequestDto>((r) => {
      const items = opts.actions(r);
      return (
        <Space size={4}>
          <Tooltip title="Открыть карточку">
            <Button
              size="small"
              icon={<EyeOutlined />}
              aria-label="Открыть карточку"
              onClick={() => opts.onOpen(r)}
            />
          </Tooltip>
          {items.length > 0 && (
            // Действий у заявки бывает пять и больше (взять в работу, выдача, снятие, завершение,
            // дублирование) — иконками они заняли бы полстроки, поэтому уходят в меню.
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
 * Карточка аренды на телефоне (ADR 0030): номер и состояние в шапке, дальше — что арендуем, где
 * стоит и до какого числа.
 *
 * Порядок строк не повторяет порядок колонок: на узком экране первым читают предмет («виброплита»),
 * а не заявителя — заявитель у своей же роли всегда один и тот же. Пустые строки карточка не
 * рисует вовсе: прочерк на телефоне читается как недогруженная запись.
 */
export function mechRequestCard(opts: MechGridOptions): CardConfig<MechRequestDto> {
  return {
    title: (r) => r.displayNumber,
    badge: (r) => <MechStateTag row={r} />,
    primary: (r) => mechModelLabel(r),
    lines: [
      (r) => r.objectName,
      // Заявитель показывается строкой только у заявки отдела: у заявки самой площадки он равен
      // строке выше, и повторять его значило бы занять высоту карточки тем же самым.
      (r) => (r.departmentId ? `Заявитель: ${mechRequesterLabel(r)}` : null),
      (r) => `Срок: ${mechDayLabel(r.plannedFrom)} — ${mechDayLabel(r.plannedTo)}`,
      // Остаток и просрочка — строкой: подсказок на телефоне нет, а это главный вопрос к аренде.
      (r) => mechDaysLeftLabel(r, opts.today)?.text ?? null,
      (r) => (r.lessorName ? `${r.lessorName} · ${mechRateLabel(r.rate, r.rateUnit)}` : null),
      // Причина отмены — строкой: на десктопе она живёт подсказкой на теге, а подсказок здесь нет.
      (r) => (r.cancelReason ? `Причина отмены: ${r.cancelReason}` : null),
    ],
    onOpen: opts.onOpen,
    actions: (r) => [
      {
        key: 'open',
        label: 'Открыть карточку',
        icon: <EyeOutlined />,
        onClick: () => opts.onOpen(r),
      },
      ...opts.actions(r),
    ],
  };
}

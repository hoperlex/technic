import type { ReactNode } from 'react';
import { Button, Space, Tag, Tooltip, Typography, type TableColumnType } from 'antd';
import { DeleteOutlined, FileTextOutlined } from '@ant-design/icons';
import type { AutoPartApplicabilityDto, AutoPartDto } from '@technic/contracts';
import { actionsColumn, NO_ROW_CLICK, RowActionButton, textColumn, type CardConfig } from '@shared/ui';

/**
 * Как перечень автозапчастей выглядит списком: колонки таблицы и карточка строки на телефоне
 * (план `docs/auto-parts-plan.md`, §8, Р11, Р13; приём `officeEquipmentConsumableGrid`).
 *
 * Отдельным модулем от самой вкладки: там остаётся работа с данными — запросы, отбор, счётчики,
 * мутации и окна, — а описание представления читается целиком, не пролистывая их. Обе фабрики
 * принимают действия, а не берут их из контекста: строка одинакова и в таблице, и в карточке, и
 * различать их должно одно место.
 */

/** Отказ сервера в удалении — им же объясняется и выключенная кнопка (Р11). */
const HAS_HISTORY_HINT =
  'По автозапчасти есть движение остатка: журнал не подчищают, снимите «Активна» вместо удаления';

/**
 * Почему остаток не правится прямо в строке: он меняется событием с причиной и автором, а не
 * ячейкой таблицы (Р3). Подпись стоит один раз, полосой под отборами, — тег в каждой строке
 * объяснял бы одно и то же двадцать раз.
 */
export const STOCK_HINT =
  'Остаток правится своим окном — кнопкой «Изменить остаток» в карточке позиции: у каждого изменения спрашивают причину, и оно ложится в журнал. Ноль — то, что пора заказывать.';

/**
 * Подложка строки с нулевым остатком. Вкладку открывают вопросом «что заказывать», и ноль —
 * единственный ответ, ради которого её листают (§8): красным тегом он виден в своей колонке, а
 * подложкой — в строке целиком, боковым зрением.
 *
 * Ставится через `onCell` каждой колонки, а не `rowClassName` таблицы: `DataTable` такого пропса
 * наружу не отдаёт (у него один свой класс — «строка открывается нажатием»), а расширять общий
 * компонент ради одной вкладки значило бы менять список, которым живёт весь портал.
 */
const ZERO_ROW_BG = '#fff2f0';

/** Ячейка строки: пустая для позиции с остатком, подложенная — для нулевой. */
const zeroCell = (part: AutoPartDto) =>
  part.quantity === 0 ? { style: { background: ZERO_ROW_BG } } : {};

export interface AutoPartGridActions {
  /**
   * Ведение справочника (Р10): заведение, правка, гашение и удаление позиции вместе с её
   * применимостью. Право роли механиков; менеджер и диспетчер вкладку видят, но только читают.
   *
   * В строке от него зависит одно действие — удаление. Правка и остаток живут в карточке, и это
   * не экономия места: строку правят, глядя на журнал, а он приходит только с карточкой.
   */
  canManage: boolean;
  /**
   * Открыть карточку — главное действие строки (концепт с. 2, п. 3): в ней и реквизиты, и
   * применимость, и остаток с кнопкой, и лента журнала. Читает её всякий, кому виден гараж (Р10).
   */
  onOpen: (part: AutoPartDto) => void;
  onDelete: (part: AutoPartDto) => void;
}

/**
 * Подпись строки применимости (Р8). Вид ссылки назван словом, а не цветом тега: «Самосвалы» без
 * него читается и как модель, и как тип, а это разные утверждения — «подходит вот этой марке» и
 * «подходит всем машинам такого рода».
 *
 * У модели рядом стоит её тип: имя модели уникально **в пределах типа**, и одинокое «65115» не
 * отвечает, чей это самосвал.
 */
export function applicabilityLabel(row: AutoPartApplicabilityDto): string {
  if (row.vehicleModel) {
    return `Модель · ${row.vehicleModel.name} (${row.vehicleModel.vehicleTypeName})`;
  }
  return `Тип · ${row.vehicleType?.name ?? '—'}`;
}

/** Тег применимости: модель и тип разного цвета — их и различают с одного взгляда. */
export function applicabilityTag(row: AutoPartApplicabilityDto): ReactNode {
  return (
    <Tag key={row.id} color={row.vehicleModel ? 'blue' : 'purple'} style={{ marginInlineEnd: 4 }}>
      {applicabilityLabel(row)}
    </Tag>
  );
}

/** Сколько тегов помещается в колонку списка; остальные сворачиваются в «+N» с подсказкой. */
const TAGS_IN_ROW = 2;

/**
 * Остаток тегом: зелёный — есть, красный — ноль (§8). Единица стоит рядом с числом всегда: на
 * складе гаража лежат штуки, литры, комплекты и метры, и «5» без единицы — это не число, а
 * загадка (Р9).
 */
export function stockTag(part: AutoPartDto): ReactNode {
  return (
    <Tag color={part.quantity === 0 ? 'red' : 'green'} style={{ marginInlineEnd: 0 }}>
      {part.quantity} {part.unit}
    </Tag>
  );
}

/** Применимость строкой списка: два тега и «+N» — целиком она читается в карточке. */
function applicabilityCell(part: AutoPartDto): ReactNode {
  if (part.applicability.length === 0) {
    // Пустая разметка законна (Р8) и всё же требует объяснения: такая деталь не найдётся отбором
    // «что подходит этой машине» и не поднимется в подборе формы акта.
    return (
      <Tooltip title="Применимость не указана: деталь не найдётся отбором по модели и типу и не поднимется в подборе формы акта">
        <Typography.Text type="secondary">—</Typography.Text>
      </Tooltip>
    );
  }
  const shown = part.applicability.slice(0, TAGS_IN_ROW);
  const rest = part.applicability.length - shown.length;
  return (
    <Tooltip title={part.applicability.map(applicabilityLabel).join(', ')}>
      <span>
        {shown.map(applicabilityTag)}
        {rest > 0 && <Tag style={{ marginInlineEnd: 0 }}>+{rest}</Tag>}
      </span>
    </Tooltip>
  );
}

export function autoPartColumns({
  canManage,
  onOpen,
  onDelete,
}: AutoPartGridActions): TableColumnType<AutoPartDto>[] {
  const columns: TableColumnType<AutoPartDto>[] = [
    textColumn<AutoPartDto>({
      key: 'name',
      title: 'Наименование',
      dataIndex: 'name',
      // Поиск живёт в панели над таблицей, а не лупой в заголовке: сервер ищет сразу по двум
      // полям — наименованию и коду, — и лупа у одного столбца обещала бы поиск только по нему.
      searchable: false,
      render: (_v, r) => (
        <>
          {r.name}
          {r.comment && (
            <>
              <br />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {r.comment}
              </Typography.Text>
            </>
          )}
        </>
      ),
    }),
    textColumn<AutoPartDto>({
      key: 'code',
      title: 'Код',
      dataIndex: 'code',
      searchable: false,
      width: 150,
      // Кода может не быть вовсе (Р12) — это законное состояние позиции, а не незаполненное поле,
      // и прочерк говорит об этом прямо: пустую ячейку читают как недоделку справочника.
      render: (value: unknown) =>
        (value as string | null) || <Typography.Text type="secondary">—</Typography.Text>,
    }),
    {
      key: 'unit',
      title: 'Ед.',
      dataIndex: 'unit',
      width: 90,
      // Сортировки нет: среди полей контракта единицы нет, и сортируемый заголовок обещал бы
      // порядок, на который маршрут ответит 400.
    },
    textColumn<AutoPartDto>({
      key: 'quantity',
      title: 'Остаток',
      dataIndex: 'quantity',
      searchable: false,
      width: 120,
      // Сортировка по остатку — то, ради чего во вкладку заходят перед заказом: срез «что
      // заказывать» читают снизу, с нулей (Р13), и он же заменяет собой минимальный остаток,
      // которого этот выпуск не заводит.
      render: (_v, r) => stockTag(r),
    }),
    {
      key: 'applicability',
      title: 'Применимость',
      width: 260,
      // Сортировки по длине разметки сервер не принимает — и правильно: она говорит не о детали, а
      // о том, насколько механик успел её разметить.
      render: (_value: unknown, r: AutoPartDto) => applicabilityCell(r),
    },
    {
      key: 'isActive',
      title: 'Статус',
      dataIndex: 'isActive',
      width: 120,
      // Тем же поводом: активности среди полей сортировки контракта нет.
      render: (value: unknown) => (
        <Tag color={value ? 'green' : 'default'}>{value ? 'Активна' : 'Погашена'}</Tag>
      ),
    },
    // Строка действий есть у всех: карточку с журналом читают по `garage.read` (Р10) — ответить
    // «есть ли на складе фильтр» должен всякий, кому виден гараж. Различается набор действий в ней.
    actionsColumn<AutoPartDto>(
      (r) => (
        <Space>
          <RowActionButton
            title="Открыть карточку"
            icon={<FileTextOutlined />}
            onClick={() => onOpen(r)}
          />
          {/*
           * Удаление доступно, пока по позиции нет ни одного движения остатка: так убирают
           * опечатку первого дня. Дальше историю не подчищают — её держит `ON DELETE RESTRICT`
           * журнала, а не доброта маршрута (Р11).
           *
           * Кнопка обёрнута руками: antd гасит события указателя на выключенной кнопке, и своя
           * подсказка `RowActionButton` на ней не открылась бы — запрет остался бы без объяснения.
           */}
          {canManage && (
            <Tooltip title={r.hasStockHistory ? HAS_HISTORY_HINT : 'Удалить'}>
              <span>
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  aria-label="Удалить"
                  disabled={r.hasStockHistory}
                  onClick={() => onDelete(r)}
                />
              </span>
            </Tooltip>
          )}
        </Space>
      ),
      canManage ? 110 : 80,
    ),
  ];

  // Подложка нулевой строки надевается здесь, разом на все колонки: забыть её у новой колонки
  // иначе означало бы полосатую строку. Колонка действий отдана нажатиям целиком (`NO_ROW_CLICK`)
  // и своё `onCell` уже имеет — его условие переносится сюда, иначе промах мимо кнопки открывал бы
  // карточку.
  return columns.map((column) => ({
    ...column,
    onCell: (r: AutoPartDto) => ({
      ...(column.key === 'actions' ? { className: NO_ROW_CLICK } : {}),
      ...zeroCell(r),
    }),
  }));
}

/** Строка списка на телефоне (ADR 0030, ADR 0042): та же запись, другой способ показать. */
export function autoPartCard({
  canManage,
  onOpen,
  onDelete,
}: AutoPartGridActions): CardConfig<AutoPartDto> {
  return {
    title: (r) => r.name,
    badge: (r) => stockTag(r),
    // Код и единица одной строкой: код бывает пуст (Р12), и «шт» тогда остаётся один — это лучше,
    // чем прочерк ради формы.
    primary: (r) => [r.code, r.unit].filter(Boolean).join(' · '),
    lines: [
      (r) =>
        r.applicability.length === 0
          ? 'Применимость не указана'
          : `Подходит: ${r.applicability.map(applicabilityLabel).join(', ')}`,
      // Погашенную позицию карточка называет словом: цвет тега остатка занят наличием, и второй
      // зелёный тег рядом читался бы как часть числа.
      (r) => (r.isActive ? null : 'Позиция погашена'),
      (r) => r.comment || null,
    ],
    // Касание по карточке ведёт туда, где человек и так работает, — в саму карточку позиции: она
    // открыта всем, кому виден гараж, и в ней же живут остаток с журналом.
    onOpen,
    actions: (r) => [
      { key: 'open', label: 'Открыть карточку', onClick: () => onOpen(r) },
      ...(canManage
        ? [
            {
              key: 'delete',
              label: 'Удалить',
              danger: true,
              // Тот же признак, что и у кнопки в таблице: движение остатка запирает удаление (Р11).
              disabled: r.hasStockHistory,
              onClick: () => onDelete(r),
            },
          ]
        : []),
    ],
  };
}

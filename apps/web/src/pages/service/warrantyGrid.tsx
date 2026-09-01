import { Button, Space, Tag, Typography, type TableColumnType } from 'antd';
import {
  SERVICE_REQUEST_NO_EQUIPMENT,
  warrantyRowKindLabels,
  type ServiceWarrantyRowDto,
  type WarrantyRowKind,
} from '@technic/contracts';
import { textColumn, type CardConfig } from '@shared/ui';
import { WarrantyTag } from '@entities/office-equipment';

/**
 * Реестр действующих гарантий списком (§9.5): колонки таблицы и карточка строки на телефоне.
 *
 * Строка реестра — не заявка и не единица техники, а **носитель гарантии**: либо сама единица
 * (гарантия поставщика), либо выполненная позиция ремонта. Поэтому колонка «На что» стоит рядом с
 * техникой: без неё две строки одного аппарата — «до 12.03.2027» и «до 01.09.2026» — читались бы
 * как противоречие, хотя это гарантия на сам аппарат и гарантия на заменённый ролик.
 */

export interface WarrantyGridActions {
  /** Завести обращение по гарантии: у гарантии поставщика свой путь — форма заявки (Р26). */
  canClaim: boolean;
  onClaim: (row: ServiceWarrantyRowDto) => void;
  /** Открыть заявку-источник: у гарантии поставщика её нет. */
  onOpenRequest: (row: ServiceWarrantyRowDto) => void;
}

const kindColors: Record<WarrantyRowKind, string> = {
  equipment: 'blue',
  repair: 'purple',
};

/**
 * Как названа техника строки. У гарантии на работу по заявке БЕЗ аппарата (Р8) наименование пусто
 * строкой — снимок брать было неоткуда, — и реестр называет её теми же словами, что заявка и
 * письмо: строка обязана остаться видимой и опознаваемой, а пустая клетка читалась бы как сбой
 * выдачи. Гарантия на работу существует и там, где предмета в справочнике нет вовсе.
 */
function equipmentTitle(row: ServiceWarrantyRowDto): string {
  return row.equipmentName || SERVICE_REQUEST_NO_EQUIPMENT;
}

/** Номера второй строкой — ими единицу опознают, а называют её моделью. */
function numbers(row: ServiceWarrantyRowDto): string {
  return [
    row.inventoryNumber && `инв. ${row.inventoryNumber}`,
    row.serialNumber && `SN ${row.serialNumber}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * «Осталось» словами. Реестр показывает только действующие гарантии, поэтому отрицательных
 * значений здесь не бывает; ноль — «последний день», и это не то же самое, что «истекла».
 */
function daysLeftText(days: number | null): string {
  if (days === null) return '';
  if (days === 0) return 'последний день';
  return `${days} дн.`;
}

export function warrantyColumns({
  canClaim,
  onClaim,
  onOpenRequest,
}: WarrantyGridActions): TableColumnType<ServiceWarrantyRowDto>[] {
  return [
    textColumn<ServiceWarrantyRowDto>({
      key: 'equipment',
      title: 'Техника',
      dataIndex: 'equipmentName',
      searchable: true,
      render: (_v, r) => (
        <>
          {equipmentTitle(r)}
          <br />
          <Typography.Text type="secondary">{numbers(r)}</Typography.Text>
        </>
      ),
    }),
    textColumn<ServiceWarrantyRowDto>({
      key: 'type',
      title: 'Тип',
      dataIndex: 'typeName',
      sortable: false,
      searchable: false,
      width: 150,
    }),
    textColumn<ServiceWarrantyRowDto>({
      key: 'object',
      title: 'Объект',
      dataIndex: 'objectName',
      sortable: false,
      searchable: false,
      width: 190,
      render: (_v, r) => (
        <>
          {r.objectName}
          {r.departmentName && (
            <>
              <br />
              <Typography.Text type="secondary">{r.departmentName}</Typography.Text>
            </>
          )}
        </>
      ),
    }),
    textColumn<ServiceWarrantyRowDto>({
      key: 'subject',
      title: 'На что гарантия',
      dataIndex: 'subject',
      sortable: false,
      searchable: false,
      render: (_v, r) => (
        <Space orientation="vertical" size={2}>
          <Tag color={kindColors[r.kind]}>{warrantyRowKindLabels[r.kind]}</Tag>
          <span>{r.subject}</span>
        </Space>
      ),
    }),
    textColumn<ServiceWarrantyRowDto>({
      key: 'warrantyUntil',
      title: 'Действует',
      dataIndex: 'warrantyUntil',
      searchable: false,
      width: 200,
      render: (_v, r) => (
        <Space orientation="vertical" size={2}>
          <WarrantyTag until={r.warrantyUntil} />
          <Typography.Text type="secondary">{daysLeftText(r.daysLeft)}</Typography.Text>
        </Space>
      ),
    }),
    textColumn<ServiceWarrantyRowDto>({
      key: 'source',
      title: 'Источник',
      dataIndex: 'displayNumber',
      sortable: false,
      searchable: false,
      width: 150,
      render: (_v, r) =>
        r.requestId ? (
          // Ссылкой, а не текстом: спор по гарантии начинается с того, что открывают ту заявку
          // и смотрят, что именно тогда сделали (ADR 0074).
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => onOpenRequest(r)}>
            {r.displayNumber}
          </Button>
        ) : (
          <Typography.Text type="secondary">поставщик</Typography.Text>
        ),
    }),
    ...(canClaim
      ? [
          {
            key: 'claim',
            title: '',
            width: 190,
            // Кнопки нет у строки без единицы (Р8): обращение по гарантии заводится выбором
            // аппарата, и предлагать его там, где аппарата не существует, значило бы обещать окно,
            // которое не откроется. Сама строка остаётся — гарантия на работу от этого не исчезает.
            render: (_v: unknown, r: ServiceWarrantyRowDto) =>
              r.equipmentId && (
                <Button size="small" onClick={() => onClaim(r)}>
                  Заявка по гарантии
                </Button>
              ),
          },
        ]
      : []),
  ];
}

/**
 * Карточка строки на телефоне (ADR 0042). Заголовок — техника, `primary` — на что гарантия: с
 * телефона реестр смотрят, когда аппарат уже сломался, и первым делом ищут, покрыт ли этот ремонт.
 */
export function warrantyCard({
  canClaim,
  onClaim,
  onOpenRequest,
}: WarrantyGridActions): CardConfig<ServiceWarrantyRowDto> {
  return {
    title: (r) => equipmentTitle(r),
    badge: (r) => <WarrantyTag until={r.warrantyUntil} />,
    primary: (r) => r.subject,
    lines: [
      (r) => numbers(r) || null,
      (r) => `${warrantyRowKindLabels[r.kind]}${r.displayNumber ? ` · ${r.displayNumber}` : ''}`,
      (r) => r.objectName,
      (r) => (r.daysLeft === null ? null : `Осталось: ${daysLeftText(r.daysLeft)}`),
    ],
    actions: (r) => [
      // То же правило, что и в колонке: без единицы обращение заводить нечем (Р8).
      ...(canClaim && r.equipmentId
        ? [{ key: 'claim', label: 'Заявка по гарантии', onClick: () => onClaim(r) }]
        : []),
      ...(r.requestId
        ? [{ key: 'source', label: `Открыть ${r.displayNumber}`, onClick: () => onOpenRequest(r) }]
        : []),
    ],
  };
}

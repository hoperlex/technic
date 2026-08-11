import { Descriptions, Space, Typography } from 'antd';
import type { ServiceRequestDto } from '@technic/contracts';
import { WarrantyTag } from '@entities/office-equipment';

/**
 * Реквизиты предмета заявки в форме (план модернизации, Р48, Р57): наименование, номера, объект и
 * место внутри него.
 *
 * Показываются, а не подразумеваются: до этого блока заказчик отправлял заявку, видя одну строку
 * выпадающего списка, — а в саму заявку уходили снимком именно эти поля, и опознаёт по ним аппарат
 * сервис, который приедет.
 *
 * Источников два, и они разные по существу. При заведении реквизиты берутся из **справочника**
 * (единицу ещё выбирают, и показать надо то, что уйдёт в снимок). При правке — из самой **заявки**:
 * карточку могли переименовать и перевезти, а решение принимали по тому, что было тогда.
 */
export function ServiceRequestSubject({
  request,
  selected,
}: {
  /** Правка существующей заявки: реквизиты берутся из её снимка. */
  request: ServiceRequestDto | null;
  /** Выбранная в справочнике единица; у правки её нет — поле выключено. */
  selected?: {
    name: string;
    serialNumber: string;
    inventoryNumber: string;
    objectLabel: string;
    location: string;
    warrantyUntil: string | null;
  };
}) {
  const dash = <Typography.Text type="secondary">—</Typography.Text>;

  if (request) {
    return (
      <Descriptions
        size="small"
        column={1}
        style={{ marginBottom: 16 }}
        labelStyle={{ width: 140 }}
        items={[
          { key: 'name', label: 'Наименование', children: request.equipment.name },
          {
            key: 'numbers',
            label: 'Номера',
            children: `инв. № ${request.equipment.inventoryNumber || '—'} · сер. № ${
              request.equipment.serialNumber || '—'
            }`,
          },
          {
            key: 'object',
            label: 'Объект',
            children: [
              `${request.object.code} — ${request.object.name}`,
              request.equipment.location,
            ]
              .filter(Boolean)
              .join(' · '),
          },
        ]}
      />
    );
  }

  if (!selected) return null;

  return (
    <Descriptions
      size="small"
      column={1}
      style={{ marginBottom: 16 }}
      labelStyle={{ width: 140 }}
      items={[
        { key: 'name', label: 'Наименование', children: selected.name },
        {
          key: 'numbers',
          label: 'Номера',
          children: (
            <Space size={12} wrap>
              <span>инв. № {selected.inventoryNumber || dash}</span>
              <span>сер. № {selected.serialNumber || dash}</span>
            </Space>
          ),
        },
        {
          key: 'object',
          label: 'Объект',
          children: (
            <Space size={8} wrap>
              <span>{selected.objectLabel}</span>
              {selected.location && (
                <Typography.Text type="secondary">{selected.location}</Typography.Text>
              )}
            </Space>
          ),
        },
        {
          key: 'warranty',
          label: 'Гарантия на технику',
          children: <WarrantyTag until={selected.warrantyUntil} />,
        },
      ]}
    />
  );
}

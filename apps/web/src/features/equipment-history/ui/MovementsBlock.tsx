import { Space, Table, Tag, Typography } from 'antd';
import { Link } from 'react-router';
import { EQUIPMENT_BLOCK_PAGE_SIZE, type EquipmentMovementRowDto } from '@technic/contracts';
import { officeEquipmentApi, officeEquipmentKeys } from '@entities/office-equipment';
import { formatDate } from '../../../utils/format';
import { EquipmentBlockView, useEquipmentBlockPages } from './blockPages';
import { placeOf, stateOf } from './place';

/**
 * Блок «Перемещения» (Р4): где аппарат стоял и почему уехал.
 *
 * Единственный из трёх блоков, где событие журнала и строка совпадают один в один: блок ничего к
 * журналу не добавляет и ничего из него не прячет. Поэтому и строка повторяет журнал целиком —
 * обе стороны с уточнением состояния (план п. 12, Р5), отдел, дата, причина, комментарий, автор,
 * заявка и признак «подтверждено заявленное место» (Р8).
 */
export function MovementsBlock({ equipmentId }: { equipmentId: string }) {
  const pages = useEquipmentBlockPages<EquipmentMovementRowDto>({
    queryKey: officeEquipmentKeys.movements(equipmentId, EQUIPMENT_BLOCK_PAGE_SIZE),
    load: (query) => officeEquipmentApi.movements(equipmentId, query),
    pageSize: EQUIPMENT_BLOCK_PAGE_SIZE,
  });

  return (
    <EquipmentBlockView pages={pages} empty="Аппарат не переезжал: стоит там, где его завели">
      <Table<EquipmentMovementRowDto>
        size="small"
        rowKey="id"
        dataSource={pages.items}
        pagination={false}
        columns={[
          {
            key: 'on',
            title: 'Дата',
            width: 110,
            // Дата переезда — бизнес-дата: технику увозят в пятницу, а заносят в понедельник.
            render: (_v, r) => formatDate(r.movedOn),
          },
          {
            key: 'where',
            title: 'Откуда → куда',
            render: (_v, r) => (
              <div style={{ lineHeight: 1.4 }}>
                <div>
                  {placeOf(
                    r.fromObject.code,
                    r.fromLocation,
                    stateOf(r.fromState, r.fromStateNote),
                  )}{' '}
                  →{' '}
                  <strong>
                    {placeOf(r.toObject.code, r.toLocation, stateOf(r.toState, r.toStateNote))}
                  </strong>
                </div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Отдел: {r.fromDepartment?.name ?? 'не закреплена'} →{' '}
                  {r.toDepartment?.name ?? 'не закреплена'}
                </Typography.Text>
              </div>
            ),
          },
          {
            key: 'why',
            title: 'Почему',
            width: 240,
            render: (_v, r) => (
              <div style={{ lineHeight: 1.4 }}>
                <div>{r.reason}</div>
                {r.comment && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {r.comment}
                  </Typography.Text>
                )}
                <Space size={6} wrap>
                  {r.serviceRequestNum !== null && (
                    <Link to={`/office-equipment?tab=requests&open=${r.serviceRequestId}`}>
                      СО-{r.serviceRequestNum}
                    </Link>
                  )}
                  {/* «Этим переездом разобрано расхождение, о котором сообщил заявитель» (п. 12,
                      Р8): факт о заявке, а не о самом переезде, и потому назван словами. */}
                  {r.confirmsDeclaredPlace && <Tag color="green">Место подтверждено</Tag>}
                </Space>
              </div>
            ),
          },
          {
            key: 'who',
            title: 'Кто',
            width: 170,
            render: (_v, r) => (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {r.movedByName || '—'}
              </Typography.Text>
            ),
          },
        ]}
      />
    </EquipmentBlockView>
  );
}

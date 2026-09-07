import { Table, Typography } from 'antd';
import {
  EQUIPMENT_BLOCK_PAGE_SIZE,
  EQUIPMENT_CHANGE_NO_DETAILS_LABEL,
  type EquipmentChangeRowDto,
} from '@technic/contracts';
import { officeEquipmentApi, officeEquipmentKeys } from '@entities/office-equipment';
import { formatDateTime } from '../../../utils/format';
import { EquipmentBlockView, useEquipmentBlockPages } from './blockPages';
import { fieldLabels } from './fieldLabels';

/**
 * Блок «Ручные правки» (Р3): что человек менял в карточке, кто и когда.
 *
 * Срок гарантии поставщика приходит сюда обычной строкой изменения — при том, что в ленте у него
 * своё событие (Н7, К5). Двоения нет: это разные экраны с разными вопросами. Блок отвечает «что
 * правил человек», и срок гарантии — ровно такая правка; лента отвечает «что происходило с
 * гарантией», и там у неё своя дорожка вместе с истечением и гарантиями ремонтов.
 *
 * ЗАПИСЬ БЕЗ ПОДРОБНОСТЕЙ — ЭТО СТРОКА, А НЕ ПРОПУСК (Н5). Аудит до появления диффа деталей не
 * несёт, и лента такие записи пропускает молча. Здесь они честно называются: «правок не было» и
 * «правки были, но подробностей не сохранилось» — разные утверждения, и первое было бы неправдой.
 */
export function ChangesBlock({ equipmentId }: { equipmentId: string }) {
  const pages = useEquipmentBlockPages<EquipmentChangeRowDto>({
    queryKey: officeEquipmentKeys.changes(equipmentId, EQUIPMENT_BLOCK_PAGE_SIZE),
    load: (query) => officeEquipmentApi.changes(equipmentId, query),
    pageSize: EQUIPMENT_BLOCK_PAGE_SIZE,
  });

  return (
    <EquipmentBlockView pages={pages} empty="Карточку ни разу не правили с тех пор, как завели">
      <Table<EquipmentChangeRowDto>
        size="small"
        rowKey="id"
        dataSource={pages.items}
        pagination={false}
        columns={[
          {
            key: 'at',
            title: 'Дата',
            width: 150,
            // Со временем, а не одной датой: правок карточки в один день бывает несколько, и
            // порядок внутри дня без времени читается как случайный (Н8).
            render: (_v, r) => formatDateTime(r.at),
          },
          {
            key: 'what',
            title: 'Что изменилось',
            render: (_v, r) =>
              r.changes.length === 0 ? (
                <Typography.Text type="secondary">
                  {EQUIPMENT_CHANGE_NO_DETAILS_LABEL}
                </Typography.Text>
              ) : (
                <div style={{ lineHeight: 1.4 }}>
                  {r.changes.map((change) => (
                    <div key={change.field}>
                      <Typography.Text type="secondary">
                        {fieldLabels[change.field] ?? change.field}:
                      </Typography.Text>{' '}
                      {change.from ?? '—'} → <strong>{change.to ?? '—'}</strong>
                    </div>
                  ))}
                </div>
              ),
          },
          {
            key: 'who',
            title: 'Кто',
            width: 180,
            render: (_v, r) => (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {r.actorName ?? '—'}
              </Typography.Text>
            ),
          },
        ]}
      />
    </EquipmentBlockView>
  );
}

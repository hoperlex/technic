import { Table } from 'antd';
import { EQUIPMENT_BLOCK_PAGE_SIZE, type EquipmentRequestRowDto } from '@technic/contracts';
import { officeEquipmentApi, officeEquipmentKeys } from '@entities/office-equipment';
import { EquipmentBlockView, useEquipmentBlockPages } from './blockPages';
import {
  EquipmentRequestDates,
  EquipmentRequestExecutors,
  EquipmentRequestLink,
  EquipmentRequestMismatch,
  EquipmentRequestOutcome,
  EquipmentRequestStatus,
  EquipmentRequestWarranties,
} from './requestRow';

/** Подпись пустоты — одна на вкладку и на секцию карточки: рассказ про заявки один (К7). */
export const REQUESTS_EMPTY_TEXT = 'Заявок на обслуживание по этому аппарату не было';

/**
 * Блок «Связанные заявки» (план истории тремя блоками, Р2): ОДНА ЗАЯВКА — ОДНА СТРОКА.
 *
 * Ровно то, чего нет в ленте: там заявка занимает до четырёх строк — событие плюс шаги «в работе»,
 * «принята», «отменена» (Н2), — и у аппарата с десятью ремонтами лента открывается сорока
 * строками, где половина повторяет номер соседней. Здесь строка отвечает на семь вопросов сразу:
 * что за заявка, о чём, кто делал, когда завели, когда правили в последний раз, чем кончилось и
 * что ещё на гарантии.
 *
 * Вкладка показывается только тому, у кого есть `serviceRequests.read`: ручка без него отвечает
 * `403`, и спрашивать её ради отказа незачем (Р11). Решает это окно — блок про право не знает.
 */
export function RequestsBlock({ equipmentId }: { equipmentId: string }) {
  const pages = useEquipmentBlockPages<EquipmentRequestRowDto>({
    queryKey: officeEquipmentKeys.requests(equipmentId, EQUIPMENT_BLOCK_PAGE_SIZE),
    load: (query) => officeEquipmentApi.requests(equipmentId, query),
    pageSize: EQUIPMENT_BLOCK_PAGE_SIZE,
  });

  return (
    <EquipmentBlockView
      pages={pages}
      // «Заявок не было» — утверждение о технике, и оно верно ровно в области смотрящего. «Не
      // положено видеть» здесь сказать нечем: у такого читателя вкладки нет вовсе.
      empty={REQUESTS_EMPTY_TEXT}
    >
      <Table<EquipmentRequestRowDto>
        size="small"
        rowKey="id"
        dataSource={pages.items}
        pagination={false}
        columns={[
          {
            key: 'request',
            title: 'Заявка',
            width: 160,
            render: (_v, r) => (
              <div style={{ lineHeight: 1.6 }}>
                <div>
                  <EquipmentRequestLink row={r} />
                </div>
                <EquipmentRequestStatus row={r} />
              </div>
            ),
          },
          {
            key: 'summary',
            title: 'Что делали',
            render: (_v, r) => (
              <div style={{ lineHeight: 1.4 }}>
                <div>{r.summary}</div>
                <EquipmentRequestExecutors executors={r.executors} />
                <EquipmentRequestWarranties warranties={r.warranties} />
                <EquipmentRequestMismatch row={r} />
              </div>
            ),
          },
          {
            key: 'dates',
            title: 'Даты',
            width: 130,
            render: (_v, r) => <EquipmentRequestDates row={r} />,
          },
          {
            key: 'outcome',
            title: 'Итог',
            width: 170,
            render: (_v, r) => <EquipmentRequestOutcome row={r} />,
          },
        ]}
      />
    </EquipmentBlockView>
  );
}

/** Сколько строк блока показывает секция карточки (Р7): пять — вместо молчаливой обрезки десятью. */
export const REQUESTS_PREVIEW_LIMIT = 5;

/**
 * Первые строки того же блока — секции «Обслуживание и гарантии» в карточке техники (Р7).
 *
 * ТОТ ЖЕ ЗАПРОС И ТОТ ЖЕ КЛЮЧ, что у вкладки, только предел другой. До этого плана про заявки по
 * аппарату рассказывали три места и рассказывали по-разному (Н1): секция — последние десять без
 * ответа «а было ли больше», лента — те же заявки событиями вперемешку с шагами, реестр — отбором
 * по технике. Теперь место одно, и правило обрезки у него одно (К7).
 */
export function useEquipmentRequestsPreview(equipmentId: string, enabled: boolean) {
  return useEquipmentBlockPages<EquipmentRequestRowDto>({
    queryKey: officeEquipmentKeys.requests(equipmentId, REQUESTS_PREVIEW_LIMIT),
    load: (query) => officeEquipmentApi.requests(equipmentId, query),
    pageSize: REQUESTS_PREVIEW_LIMIT,
    enabled,
  });
}

import { Table, Typography } from 'antd';
import { tripCargoLabel, type VehicleRequestTripDto } from '@technic/contracts';
import { AddressCell } from '@entities/address';
import { ResponsibleValue } from '../../components/ResponsibleFields';
import { formatDateTime } from '../../utils/format';

/**
 * Ездки заявки в карточке: таблица и её ячейка «откуда/куда».
 *
 * Отдельным файлом, а не куском карточки: у таблицы своё правило показа (она появляется только
 * там, где ездок больше одной) и своё разделение с рейсом — порядок объезда принадлежит рейсу, а
 * не заказу. В карточке, отвечающей за десяток вкладок сразу, это правило читалось как верстка
 * одной из них.
 */

function TripEnd({
  location,
  meta,
  name,
  phone,
}: {
  location: string;
  meta: VehicleRequestTripDto['fromAddress'];
  name: string;
  phone: string;
}) {
  return (
    <div style={{ lineHeight: 1.35 }}>
      <AddressCell text={location} meta={meta} />
      <div style={{ fontSize: 12 }}>
        <ResponsibleValue name={name} phone={phone} />
      </div>
    </div>
  );
}

/**
 * Ездки заявки таблицей (Р1, §9 плана `docs/route-trips-plan.md`) — строкой на ездку, в порядке
 * их номеров.
 *
 * Показывается только там, где ездок больше одной: заявка с единственной (а до плана такими были
 * все — Р24) называет её парой полей «Погрузка/Разгрузка», как называла всегда. Таблица на одну
 * строку — это шапка, рамка и полоса прокрутки ради того, что помещается в два поля карточки.
 *
 * Порядка объезда здесь нет и быть не может: он принадлежит рейсу, а не заказу (Р1), и спрашивают
 * его у карточки маршрута. Эта таблица отвечает на «что заказчик просил везти», а не «в каком
 * порядке машина это объедет».
 *
 * Правки в ней нет и не будет: ездки правятся формой заявки (§4.1, `RequestTripsBlock`), а
 * карточка отвечает на «что заказано» — второй редактор того же списка разошёлся бы с первым.
 */
export function RequestTripsTable({ trips }: { trips: VehicleRequestTripDto[] }) {
  return (
    <Table<VehicleRequestTripDto>
      dataSource={trips}
      rowKey="id"
      size="small"
      pagination={false}
      // Адреса длинные, а окно карточки шире не становится: таблица прокручивается вбок сама,
      // не растягивая окно и не ломая раскладку на телефоне (ADR 0030).
      scroll={{ x: 'max-content' }}
      columns={[
        {
          key: 'num',
          title: '№',
          width: 64,
          // Номер ездки внутри заявки, а не позиция в списке: он неизменяем и не переиспользуется
          // (Р13а), и ровно им ездка названа в выданном листе — «ТС-40/2».
          render: (_v, t) => t.num,
        },
        {
          key: 'from',
          title: 'Погрузка',
          render: (_v, t) => (
            <TripEnd
              location={t.fromLocation}
              meta={t.fromAddress}
              name={t.fromResponsibleName}
              phone={t.fromResponsiblePhone}
            />
          ),
        },
        {
          key: 'to',
          title: 'Разгрузка',
          render: (_v, t) => (
            <TripEnd
              location={t.toLocation}
              meta={t.toAddress}
              name={t.toResponsibleName}
              phone={t.toResponsiblePhone}
            />
          ),
        },
        {
          key: 'cargo',
          title: 'Груз',
          width: 160,
          // Подпись груза — та же, что печатает бланк (`tripCargoLabel`): расхождение единиц между
          // карточкой и листом означало бы спор о том, что везли. Примечание ездки идёт второй
          // строкой — это оно объясняет «песок, звонить за час».
          render: (_v, t) => (
            <div style={{ lineHeight: 1.35 }}>
              <div>{tripCargoLabel(t) || '—'}</div>
              {!!t.comment && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t.comment}
                </Typography.Text>
              )}
            </div>
          ),
        },
        {
          key: 'scheduledAt',
          title: 'Подача',
          width: 150,
          // Своё время ездки (Р3) — уточняющее: пусто значит «как у заявки», и подписано это
          // словами. Прочерк читался бы как «времени нет вовсе», а оно есть — заявкино.
          render: (_v, t) =>
            t.scheduledAt ? (
              formatDateTime(t.scheduledAt)
            ) : (
              <Typography.Text type="secondary">как у заявки</Typography.Text>
            ),
        },
      ]}
    />
  );
}

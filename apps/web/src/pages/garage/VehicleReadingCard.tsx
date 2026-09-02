import { useState } from 'react';
import { Button, Skeleton, Space, Typography } from 'antd';
import dayjs from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import { vehicleReadingKeys, vehicleReadingsApi } from '@entities/vehicle-reading';
import { VehicleMaintenanceBlock } from '@features/vehicle-maintenance';
import { VehiclePartsSpendBlock } from '@features/vehicle-parts-spend';
import { ViewModal } from '@shared/ui';
import { useAuth } from '../../auth/AuthContext';
import { ReadingCardCounters } from './ReadingCardCounters';
import { ReadingCardTotals } from './ReadingCardTotals';
import { ReadingCardMonths } from './ReadingCardMonths';
import { ReadingCardChart } from './ReadingCardChart';
import { useVehicleSpendAddress } from './receiptsAddress';
import { VehiclePartsSpendModal } from './VehiclePartsSpendModal';
import { VehicleReadingsJournal } from './VehicleReadingsJournal';

/**
 * Карточка машины в сводке показаний (ADR 0103; план «Показания техники», Р2, Р29).
 *
 * Окно, а не область под списком, — по трём причинам, и все три уже решены в этом же разделе.
 * Во-первых, так открывается всё остальное в гараже: журнал показаний, карточка рейса, карточка
 * заявки — строка ведёт в окно, а список остаётся на месте. Во-вторых, карточка отвечает про одну
 * машину и живёт в адресе (`?vehicle=`): её открывают ссылкой из чужого сообщения, и раскрытая
 * панель под списком, до которой надо доскроллить, отвечала бы на этот адрес хуже окна, встающего
 * поверх. В-третьих, детализация — существующее окно журнала: панель под списком, из которой
 * всё равно открывается окно, экономит один слой ровно до первого нажатия.
 *
 * Открытие идёт в историю (`openVehicle`), поэтому «назад» закрывает карточку и возвращает к
 * списку, а не уносит со страницы.
 *
 * **Блок ТО стоит здесь композицией, а не полем ответа** (Р14а). Статистика приходит под
 * `vehicleReadings.read` и об обслуживании не знает; сводка ТО — под `vehicleMaintenance.read` и
 * своей ручкой. Карточка их складывает, и без права на ТО блок не рисуется и ничего не
 * запрашивает: он проверяет право сам, а заглушка «данных нет» на его месте отвечала бы за чужую
 * ручку и врала бы механику ровно про то, чем он занимается.
 */

const SHOWN_DATE = 'DD.MM.YYYY';

interface Props {
  vehicleId: string;
  /**
   * Подпись из строки сводки — на время загрузки. Своё имя машины приходит в ответе, но карточку
   * открывают и ссылкой, в которой строки списка ещё нет: тогда окно подписывается ответом.
   */
  vehicleLabel?: string;
  from: string;
  to: string;
  onClose: () => void;
}

export function VehicleReadingCard({ vehicleId, vehicleLabel, from, to, onClose }: Props) {
  /**
   * Журнал — второе окно поверх карточки, а не её часть. Он уже написан, уже умеет свои страницы и
   * свой период (Р25), и переписывать его строками внутри карточки значило бы завести второй ответ
   * на «что было по сменам».
   */
  const [journalOpen, setJournalOpen] = useState(false);

  /**
   * Окно «Запчасти машины» — третье окно этого экрана и единственное из трёх, живущее в адресе
   * (`?spend=`, Р15): оно же открывается из колонки гаража и из карточки чека, и ключ у всех троих
   * один. Право здесь про сам гараж (Р5), а не про показания: карточку открывает
   * `vehicleReadings.read`, а «сколько вложено в машину» читают все, кому виден гараж.
   *
   * Проверять вкладку тут незачем: карточка и так рисуется только своей, активной (`ReadingsStatsTab`).
   */
  const { can } = useAuth();
  const spend = useVehicleSpendAddress(can('garage.read'));

  const query = { from, to };
  const { data } = useQuery({
    queryKey: vehicleReadingKeys.card(vehicleId, query),
    queryFn: () => vehicleReadingsApi.card(vehicleId, query),
  });

  const label = data?.vehicleLabel || vehicleLabel || 'Показания машины';

  const title = (
    <Space orientation="vertical" size={0}>
      <span>{label}</span>
      <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 'normal' }}>
        показания за {dayjs(from).format(SHOWN_DATE)} — {dayjs(to).format(SHOWN_DATE)}
      </Typography.Text>
    </Space>
  );

  return (
    <ViewModal title={title} open onClose={onClose} width={1040} destroyOnHidden>
      {data ? (
        <Space orientation="vertical" size={16} style={{ display: 'flex' }}>
          <ReadingCardCounters card={data} />
          <ReadingCardTotals total={data.total} />
          <ReadingCardMonths months={data.months} total={data.total} />
          {/* Диаграмма — после таблицы (§7): она отвечает на «как шло», и вопрос этот задают,
              уже посмотрев «сколько». Ленивый чанк живёт внутри неё, а не здесь: карточка не
              должна знать, чем нарисованы столбики. */}
          <ReadingCardChart months={data.months} />
          {/* Обслуживание — свой ответ под своим правом (Р14а). Днём среза ему идёт конец периода
              карточки: срез марта не должен показывать майское ТО и майский одометр (Р16). */}
          <VehicleMaintenanceBlock vehicleId={vehicleId} vehicleLabel={label} on={to} />
          {/* Автозапчасти — тем же порядком и под своим правом (Р16): период карточки задаёт
              первую из двух цифр, вторая отвечает за всё время. */}
          <VehiclePartsSpendBlock
            vehicleId={vehicleId}
            from={from}
            to={to}
            href={spend.href(vehicleId)}
          />
          <div>
            <Button onClick={() => setJournalOpen(true)}>Показания по сменам</Button>
          </div>
        </Space>
      ) : (
        <Skeleton active paragraph={{ rows: 8 }} />
      )}

      {journalOpen && (
        <VehicleReadingsJournal
          vehicleId={vehicleId}
          vehicleLabel={label}
          /*
           * Журнал открывается ровно тем периодом, который показывает карточка: иначе смены,
           * из которых сложились её числа, и строки детализации отвечали бы про разные отрезки —
           * а открывают журнал именно затем, чтобы посмотреть, из чего сложилось число выше.
           */
          day={to}
          from={from}
          open
          onClose={() => setJournalOpen(false)}
        />
      )}

      {/* Окно перечня — внутри карточки, а не поверх страницы (ADR 0140): открыли его отсюда,
          и закрытие обязано вернуть в карточку, а не оставить её позади погашенной. Период
          карточки уходит в него начальным: цифра блока и перечень под ней отвечают про один
          отрезок. */}
      <VehiclePartsSpendModal
        /* Только про свою машину: ключ в адресе общий у трёх экранов, и `?vehicle=A&spend=B` —
           адрес несобранный, а не просьба показать B с подписью A. */
        vehicle={spend.id === vehicleId ? { id: vehicleId, label: data?.vehicleLabel } : null}
        from={from}
        to={to}
        onClose={spend.close}
      />
    </ViewModal>
  );
}

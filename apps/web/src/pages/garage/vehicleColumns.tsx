import type { useNavigate } from 'react-router';
import { Space, Tag, Typography, type TableColumnType } from 'antd';
import {
  type GarageVehicleDto,
  garageVehicleStateColors,
  garageVehicleStateLabels,
  vehicleClassificationLabel,
  type VehicleReadingDayState,
  vehicleReadingDayStateColors,
  vehicleReadingDayStateLabels,
  vehicleStatusLabels,
} from '@technic/contracts';
import { EntityLink, textColumn, type CardConfig } from '@shared/ui';
import type { AddressParam } from '@shared/lib';
import type { useMaintenanceColumn } from './maintenanceColumn';
import type { usePartsSpendColumn } from './partsSpendColumn';
import { vehicleCardHref } from './readingsAddress';
import { odometerCardLine, odometerColumn } from './odometerColumn';
import { BusyCell, busyLine, type useBusyRouteActions } from './shared';

/**
 * Строка вкладки «Техника» двумя видами списка: колонками таблицы и карточкой телефона (ADR 0030).
 * Оба собираются здесь и из одних и тех же полей ответа — врозь они однажды ответят про машину
 * разное, и разойдутся молча.
 *
 * Фабриками, а не готовыми постоянными: и колонки, и карточка замыкаются на день среза, право на
 * показания, адрес журнала и колонку обслуживания, а всё это приходит из хуков вкладки.
 *
 * Отдельным файлом, а не строками в `GarageVehiclesTab.tsx`: у вкладки бюджет длины
 * (`quality-budget.json`), и сборка колонок с карточкой в него не помещалась.
 */

/**
 * Строка среза вместе с состоянием показаний за день (ADR 0103, Р27). Тип расширен здесь, а не в
 * контракте гаража: этап показаний `packages/contracts` не трогает, а сервер поле уже отдаёт
 * (`routes/garage.ts`).
 */
export type VehicleRow = GarageVehicleDto & { readingState: VehicleReadingDayState };

/** На что замыкаются колонки и карточка: день среза, права и окна вкладки. */
type VehicleColumnsDeps = {
  /** День среза: он же уходит в адрес карточки машины (`cardHref`). */
  date: string;
  /** Право на сами показания (`vehicleReadings.read`): у среза дня своё (`garage.read`). */
  canReadReadings: boolean;
  /** Адрес журнала показаний — общий ключ вкладок гаража (`useJournalAddress`). */
  journal: AddressParam;
  /** Колонка ТО, строка и пункты карточки — со своим правом и своим окном. */
  maintenance: ReturnType<typeof useMaintenanceColumn<VehicleRow>>;
  /** Колонка «Запчасти, ₽» и вход в окно машины — под правом на сам гараж (Р5). */
  partsSpend: ReturnType<typeof usePartsSpendColumn<VehicleRow>>;
};

/** Состояние дня плюс причина недоступности: «в ремонте» объясняет тег, а не повторяет его. */
function stateCell(r: GarageVehicleDto) {
  return (
    <Space orientation="vertical" size={0}>
      <Tag color={garageVehicleStateColors[r.state]} style={{ marginInlineEnd: 0 }}>
        {garageVehicleStateLabels[r.state]}
      </Tag>
      {r.state === 'unavailable' && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {vehicleStatusLabels[r.status].toLowerCase()}
        </Typography.Text>
      )}
    </Space>
  );
}

/**
 * Третий путь строки (§7): карточка машины на вкладке «Показания» — статистика за месяц по день
 * среза. Период считает разбор адреса показаний, а не эта вкладка (`vehicleCardHref`).
 */
const cardHref = (id: string, date: string) => vehicleCardHref(id, date);

export function vehicleColumns({
  date,
  canReadReadings,
  journal,
  maintenance,
  partsSpend,
}: VehicleColumnsDeps): TableColumnType<VehicleRow>[] {
  // Ключ колонки — он же поле сортировки на сервере (GARAGE_VEHICLE_SORT_FIELDS).
  return [
    {
      ...textColumn<VehicleRow>({
        key: 'registrationNumber',
        title: 'Техника',
        dataIndex: 'label',
        width: 210,
        render: (_v, r) => (
          <Space orientation="vertical" size={0}>
            <span>{r.label}</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {[r.modelName, r.garageNumber ? `гар. № ${r.garageNumber}` : null]
                .filter(Boolean)
                .join(' · ')}
            </Typography.Text>
          </Space>
        ),
      }),
    },
    {
      key: 'typeName',
      title: 'Тип',
      dataIndex: 'typeName',
      width: 200,
      sorter: true,
      // Позиция классификатора (ADR 0028): категория, а без неё — сам тип.
      render: (_v, r) =>
        vehicleClassificationLabel({ typeName: r.typeName, categoryName: r.categoryName }),
    },
    {
      key: 'state',
      title: 'Состояние',
      width: 130,
      sorter: true,
      defaultSortOrder: 'ascend',
      render: (_v, r) => stateCell(r),
    },
    {
      key: 'busy',
      title: 'Занятость',
      render: (_v, r) => <BusyCell entries={r.busy} />,
    },
    {
      key: 'readings',
      title: 'Показания',
      width: 140,
      /**
       * Состояние дня по показаниям — одно значение из пяти, старшинством сверху вниз (Р27).
       * Оба входа в модуль показаний стоят под ним и только у тех, кому положены сами показания: у
       * среза своё право (`garage.read`), а цифры и подписи водителей — данные модуля показаний.
       * Журнал отвечает «что было по сменам», карточка — «сколько вышло за период» (§7).
       */
      render: (_v, r) => (
        <Space orientation="vertical" size={2} align="start">
          <Tag color={vehicleReadingDayStateColors[r.readingState]} style={{ marginInlineEnd: 0 }}>
            {vehicleReadingDayStateLabels[r.readingState]}
          </Tag>
          {canReadReadings && (
            <Space size={8} wrap>
              <EntityLink to={journal.href(r.id)} title="Открыть журнал показаний">
                журнал
              </EntityLink>
              <EntityLink to={cardHref(r.id, date)} title="Открыть статистику машины за период">
                статистика
              </EntityLink>
            </Space>
          )}
        </Space>
      ),
    },
    /*
     * Одометр — колонка модуля показаний, а не гаража (Р16): у среза своё право (`garage.read`),
     * а цифры приборов открывает `vehicleReadings.read`. Проверка здесь не украшение к серверной:
     * без права сервер поля не присылает вовсе, и колонка без этого условия стояла бы у механика
     * пустым столбцом прочерков — то есть врала бы, что показаний нет.
     */
    ...(canReadReadings ? [odometerColumn<VehicleRow>()] : []),
    // Колонка ТО — под своим правом (Р14) и своим ответом: у механика она стоит там, где у
    // диспетчера одометр, и наоборот.
    ...maintenance.columns,
    /*
     * Запчасти — рядом с ТО и по той же причине, что и оно: обе колонки про содержание машины, а
     * не про её день. Права на показания эта не требует вовсе (Р5): «сколько вложено в машину»
     * спрашивает всякий, кому виден гараж, и у механика она стоит ровно такая же, как у
     * диспетчера.
     */
    ...partsSpend.columns,
    {
      key: 'drivers',
      title: 'Водители',
      width: 200,
      render: (_v, r) =>
        r.drivers.length === 0 ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Space orientation="vertical" size={0}>
            {r.drivers.map((driver) => (
              <span key={driver.personId}>{driver.fullName}</span>
            ))}
          </Space>
        ),
    },
  ];
}

/** Карточка телефона: машина и её состояние в шапке, занятость — строками (ADR 0030). */
export function vehicleCard({
  date,
  canReadReadings,
  journal,
  maintenance,
  partsSpend,
  navigate,
  routeActions,
}: VehicleColumnsDeps & {
  /** Переход к статистике машины пунктом шита: ссылок в строках карточки нет. */
  navigate: ReturnType<typeof useNavigate>;
  /** Рейсы дня пунктами действий (`useBusyRouteActions`): право хук спрашивает сам. */
  routeActions: ReturnType<typeof useBusyRouteActions>;
}): CardConfig<VehicleRow> {
  return {
    title: (r) => r.label,
    badge: (r) => (
      <Tag color={garageVehicleStateColors[r.state]}>{garageVehicleStateLabels[r.state]}</Tag>
    ),
    primary: (r) =>
      vehicleClassificationLabel({ typeName: r.typeName, categoryName: r.categoryName }),
    lines: [
      (r) => (r.busy.length === 0 ? 'на этот день ничего не назначено' : null),
      ...Array.from({ length: 3 }, (_, i) => (r: VehicleRow) => {
        const entry = r.busy[i];
        return entry ? busyLine(entry) : null;
      }),
      (r) => (r.drivers.length === 0 ? null : r.drivers.map((d) => d.fullName).join(', ')),
      // Состояние показаний — строкой, а не вторым бейджем: в шапке карточки уже стоит состояние
      // дня, и два тега рядом читались бы как одно противоречивое.
      (r) => `показания: ${vehicleReadingDayStateLabels[r.readingState]}`,
      // Одометр приходит только с правом на показания, и своего условия строке не нужно: без права
      // поля в ответе нет, и строка молчит сама (`odometerCardLine`).
      (r) => odometerCardLine(r),
      // ТО — тем же порядком: без права на обслуживание состояния нет, и строка молчит сама.
      maintenance.cardLine,
      // Запчасти — так же: покупок за машиной не числится, и строка молчит, а не показывает ноль.
      partsSpend.cardLine,
    ],
    /*
     * Действия карточки. Рейсы дня стоят первыми: карточка отвечает про **этот день**, и «что там
     * за Р-12» спрашивают у неё чаще, чем месячную статистику машины; остальные пункты — про саму
     * машину и от выбранного дня почти не зависят.
     *
     * Пунктами, а не ссылками в строках, всё это по одной причине: касание по карточке уже занято
     * журналом показаний, а третьего смысла у касания быть не может.
     */
    actions: (r) => [
      ...routeActions(r.busy),
      ...(canReadReadings
        ? [
            {
              key: 'stats',
              label: 'Статистика за период',
              onClick: () => navigate(cardHref(r.id, date)),
            },
          ]
        : []),
      ...maintenance.cardActions(r),
      ...partsSpend.cardActions(r),
    ],
    // На телефоне карточка открывает тот же журнал — и тем же путём, через адрес: ссылку,
    // присланную с телефона, коллега открывает на десктопе и видит ровно тот же день.
    onOpen: canReadReadings ? (r: VehicleRow) => journal.open(r.id) : undefined,
  };
}

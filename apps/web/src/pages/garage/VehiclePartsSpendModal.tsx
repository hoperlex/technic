import { useState } from 'react';
import { DatePicker, Skeleton, Space, Table, Typography, type TableColumnsType } from 'antd';
import dayjs from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import type { VehiclePartsSpendRowDto } from '@technic/contracts';
import { autoPartReceiptApi, autoPartReceiptKeys } from '@entities/auto-part-receipt';
import { EntityLink, SummaryBar, ViewModal } from '@shared/ui';
import { useIsMobile } from '@shared/lib';
import { formatMoney } from '../../utils/format';
import { useReceiptAddress } from './receiptsAddress';

/**
 * Окно «Запчасти машины» (план `docs/auto-part-receipts-plan.md`, Р15): один ответ на вопрос
 * «что купили этой машине» — итог сверху, период фильтром, перечень строк с их чеками.
 *
 * **Окно одно на три входа** — колонка «Запчасти, ₽» вкладки «Техника» (`partsSpendColumn.tsx`),
 * блок карточки машины (`@features/vehicle-parts-spend`) и техника, названная строкой карточки
 * чека. Второго перечня «что куплено машине» в портале не будет: две цифры разошлись бы в первый
 * же день. Отсюда и props — `vehicle`, а не «откуда открыли»: окно не знает своих входов.
 *
 * **Ничего здесь не считается.** Оба итога приходят одним ответом (§6): `total` — за период
 * запроса, `totalAllTime` — за всё время. Сложи портал сумму по показанным строкам, она разошлась
 * бы с карточкой чека на первом же округлении, а «всего» пришлось бы спрашивать вторым запросом —
 * то есть парой снимков, снятых в разные моменты.
 *
 * **Период необязателен** (§6, `vehiclePartsSpendQuerySchema`): без него окно показывает всё
 * время. Начальные границы задаёт вход — колонка отдаёт свой день среза, карточка машины свой
 * период, — иначе цифра, по которой нажали, и цифра в открывшемся окне отвечали бы про разные
 * отрезки.
 */

const DATE = 'YYYY-MM-DD';
const SHOWN_DATE = 'DD.MM.YYYY';

/**
 * Вкладка, на которой живёт карточка чека (`GaragePage`). Строка окна ведёт именно туда: ключ
 * `?receipt=` читает вкладка «Автозапчасти», и оставленный `?tab=vehicles` открыл бы адрес, на
 * который никто не отвечает.
 */
const PARTS_TAB = 'parts';

/** Машина глазами окна: идентификатор и то, как её звали там, откуда открыли. */
export interface SpendVehicle {
  id: string;
  /** Подпись на время загрузки: своё имя машины приходит в ответе (`vehicleLabel`). */
  label?: string;
}

interface Props {
  /** `null` — окно закрыто. */
  vehicle: SpendVehicle | null;
  /** Начальные границы периода: у колонки это день среза вкладки, у карточки — её период. */
  from?: string;
  to?: string;
  onClose: () => void;
}

/**
 * Строки перечня. Реквизиты чека приходят вместе со строкой (§6) — ни одного добора шапки здесь
 * нет: перечень за год это полсотни запросов ради даты и номера.
 */
function columnsOf(
  hrefOf: (receiptId: string) => string,
): TableColumnsType<VehiclePartsSpendRowDto> {
  return [
    {
      key: 'purchasedOn',
      title: 'Чек',
      width: 130,
      /*
       * Дата чека (Р13) — она же ссылка в карточку: по дате документа считаются все суммы окна, и
       * переход из строки один — «покажи бумагу, из которой это число». Номер под датой, а не
       * отдельной колонкой: вдвоём они и есть имя чека, и разводить их значит заставлять глаз
       * собирать его обратно.
       */
      render: (_v, row) => (
        <Space orientation="vertical" size={0}>
          <EntityLink to={hrefOf(row.receiptId)} title="Открыть карточку чека">
            {dayjs(row.purchasedOn).format(SHOWN_DATE)}
          </EntityLink>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            № {row.documentNumber}
          </Typography.Text>
        </Space>
      ),
    },
    { key: 'sellerName', title: 'Продавец', width: 220, render: (_v, row) => row.sellerName },
    {
      key: 'name',
      title: 'Наименование',
      // Дословно с бумаги (Р17): «фильтр масляный 2101-1012005» — то, по чему запчасть узнают в
      // следующий раз. Своего справочника наименований у чеков нет вовсе.
      render: (_v, row) => row.name,
    },
    {
      key: 'quantity',
      title: 'Кол-во',
      width: 110,
      align: 'right',
      render: (_v, row) => `${row.quantity} ${row.unit}`,
    },
    {
      key: 'amount',
      title: 'Сумма',
      width: 140,
      align: 'right',
      render: (_v, row) => formatMoney(row.amount),
    },
  ];
}

/**
 * Тело окна. Отдельным компонентом ради `key` по машине: период — состояние окна, а окно
 * переоткрывают на соседней машине, не закрывая списка. Без сброса вторая машина открывалась бы
 * периодом, заданным для первой, — и её «за период» отвечало бы на чужой вопрос.
 */
function SpendWindow({ vehicle, from, to, onClose }: Props & { vehicle: SpendVehicle }) {
  const isMobile = useIsMobile();
  const [period, setPeriod] = useState<{ from?: string; to?: string }>({ from, to });

  /**
   * Адрес карточки чека берётся у общего разбора ключей (`receiptsAddress`), а не собирается
   * строкой: имя ключа — договор трёх экранов, и второе его написание разъехалось бы с первым.
   * Права здесь нет и не спрашивается: чеки читают все, кому виден гараж (Р5), — от хука нужен
   * только адрес ссылки.
   */
  const receipt = useReceiptAddress(true);
  const hrefOf = (receiptId: string) => {
    const next = new URLSearchParams(receipt.href(receiptId));
    next.set('tab', PARTS_TAB);
    return `?${next.toString()}`;
  };

  const query = {
    ...(period.from ? { from: period.from } : {}),
    ...(period.to ? { to: period.to } : {}),
  };
  const { data, isFetching } = useQuery({
    queryKey: autoPartReceiptKeys.vehicleSpend(vehicle.id, query),
    queryFn: () => autoPartReceiptApi.vehicleSpend(vehicle.id, query),
  });

  const label = data?.vehicleLabel || vehicle.label || 'машина';
  const narrowed = Boolean(period.from || period.to);
  const money = (v: number | undefined) => (v == null ? '—' : formatMoney(v));

  return (
    <ViewModal
      title={`Запчасти — ${label}`}
      open
      onClose={onClose}
      width={1000}
      destroyOnHidden
      bodyStyle={{
        ...(isMobile ? { height: '100%' } : { height: '70vh' }),
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        overflow: 'hidden',
      }}
    >
      <Space size={[12, 8]} wrap style={{ flex: '0 0 auto' }}>
        <DatePicker.RangePicker
          format={SHOWN_DATE}
          style={{ width: 260 }}
          // Обе границы необязательны: «за всё время» — законный вопрос к машине, и он же
          // умолчание окна, открытого без периода.
          allowEmpty={[true, true]}
          placeholder={['Чеки с', 'по']}
          value={[period.from ? dayjs(period.from) : null, period.to ? dayjs(period.to) : null]}
          onChange={(range) =>
            setPeriod({
              from: range?.[0] ? range[0].format(DATE) : undefined,
              to: range?.[1] ? range[1].format(DATE) : undefined,
            })
          }
        />
        {/*
         * Итог сверху и оба сразу (Р15, Р16). «Всего» стоит рядом с «за период» ровно затем, чтобы
         * суженный период читался как сужение, а не как вся правда о машине: 12 000 ₽ за август
         * при 340 000 ₽ за всё время — это два разных ответа, и второй теряется, если его не
         * показать.
         */}
        <SummaryBar
          title="Куплено"
          items={
            narrowed
              ? [
                  { label: 'за период', value: money(data?.total) },
                  { label: 'всего', value: money(data?.totalAllTime) },
                ]
              : [{ label: 'всего', value: money(data?.totalAllTime) }]
          }
        />
      </Space>

      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>
        {data ? (
          <Table<VehiclePartsSpendRowDto>
            size="small"
            rowKey={(row) => row.lineId}
            columns={columnsOf(hrefOf)}
            dataSource={data.rows}
            loading={isFetching}
            /*
             * Страницы клиентские: ответ приходит перечнем целиком — тем же, из которого посчитан
             * итог сверху. Серверное листание развело бы список с этой цифрой, и «сумма не сходится
             * с показанным» разбирали бы глазами.
             */
            pagination={{ pageSize: 25, hideOnSinglePage: true, showSizeChanger: false }}
            locale={{
              emptyText: narrowed
                ? 'За выбранный период на эту машину запчастей не покупали'
                : 'На эту машину запчастей не покупали',
            }}
          />
        ) : (
          <Skeleton active paragraph={{ rows: 6 }} />
        )}
      </div>
    </ViewModal>
  );
}

export function VehiclePartsSpendModal({ vehicle, from, to, onClose }: Props) {
  if (!vehicle) return null;
  return <SpendWindow key={vehicle.id} vehicle={vehicle} from={from} to={to} onClose={onClose} />;
}

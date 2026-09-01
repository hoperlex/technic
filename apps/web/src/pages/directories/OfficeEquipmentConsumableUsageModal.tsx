import { useState } from 'react';
import {
  App,
  Button,
  DatePicker,
  Select,
  Space,
  Table,
  Typography,
  type TableColumnsType,
} from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  officeEquipmentTitle,
  SERVICE_REQUEST_NO_EQUIPMENT,
  type OfficeEquipmentConsumableUsageRowDto,
} from '@technic/contracts';
import { Link } from 'react-router';
import { SummaryBar, ViewModal } from '@shared/ui';
import { errorMessage, useIsMobile } from '@shared/lib';
import {
  officeEquipmentConsumablePickerQuery,
  officeEquipmentConsumableKeys,
  officeEquipmentConsumablesApi,
} from '@entities/office-equipment';
import { formatDateTime } from '../../utils/format';

/**
 * Расход расходников за период (наброски переработки заявок, Р10; опрос В18).
 *
 * ЗАЧЕМ ЭКРАН. Справочник отвечает «сколько лежит сейчас», карточка позиции — «что с ней
 * происходило». Заказ на квартал составляют по третьему вопросу: сколько ушло за прошлый и на что
 * именно. Собрать его из ленты журнала руками нельзя — она по одной позиции и без аппаратов.
 *
 * ЧТО ПОКАЗЫВАЕТ. Строка — «заявка × позиция × человек» (контракт): кто, сколько, на какой аппарат
 * и по какой заявке. Числа считает сервер по журналу движения склада — тем же источником, что и
 * остаток, — а портал их только печатает. Своей суммы у экрана нет и быть не должно: посчитай он
 * итог по показанным строкам, обрезанный потолком отчёт показал бы неверный расход.
 *
 * ОКНОМ, А НЕ ВКЛАДКОЙ, — по той же причине, что и сам справочник картриджей (Р8): расход
 * спрашивают, стоя в номенклатуре, и уводить его на отдельную страницу значило бы заставлять
 * возвращаться.
 */

const DATE = 'YYYY-MM-DD';
const SHOWN_DATE = 'DD.MM.YYYY';

/** Позиция строкой: код и наименование. Код первым — по нему сверяют со счётом поставщика. */
function positionOf(row: OfficeEquipmentConsumableUsageRowDto): string {
  return [row.code, row.name, row.color].filter(Boolean).join(' · ');
}

function columnsOf(): TableColumnsType<OfficeEquipmentConsumableUsageRowDto> {
  return [
    {
      key: 'at',
      title: 'Когда',
      width: 150,
      render: (_v, row) => (
        <Typography.Text type="secondary">{formatDateTime(row.at)}</Typography.Text>
      ),
    },
    {
      key: 'request',
      title: 'Заявка',
      width: 110,
      // Ссылка ведёт в раздел и открывает ту самую заявку (ADR 0074): «кому и зачем» читают в ней.
      render: (_v, row) => (
        <Link to={`/office-equipment?tab=requests&open=${row.requestId}`}>{row.displayNumber}</Link>
      ),
    },
    {
      key: 'equipment',
      title: 'Аппарат',
      /*
       * Выдача бывает и по заявке БЕЗ аппарата — отдел просит тонер «на склад» (Р8). Строка обязана
       * остаться в отчёте: итоги считаются по журналу целиком, и потеряй отчёт такую строку, суммы
       * под ним перестали бы сходиться с показанным — спор о числах разбирают глазами.
       *
       * Поэтому не прочерк и не пустая клетка, а те же слова, что стоят в заявке и в письме: пустое
       * место здесь читалось бы как «аппарат не записали», то есть как дефект учёта.
       */
      render: (_v, row) => {
        // Три поля проверяются вместе, а не одно из них: по контракту они пустеют разом — это один
        // аппарат, а не три независимых реквизита, и «имя есть, номеров нет» означало бы, что
        // сервер отдал полстроки.
        const { equipmentName: name, equipmentInventoryNumber: inv } = row;
        const sn = row.equipmentSerialNumber;
        if (name === null || inv === null || sn === null) return SERVICE_REQUEST_NO_EQUIPMENT;
        return officeEquipmentTitle({ name, inventoryNumber: inv, serialNumber: sn });
      },
    },
    { key: 'position', title: 'Позиция', render: (_v, row) => positionOf(row) },
    {
      key: 'quantity',
      title: 'Расход',
      width: 100,
      align: 'right',
      /*
       * Выдача и возврат показываются рядом с итогом, а не вместо него, и только там, где возврат
       * был: строка «выдали 3, вернули 1, расход 2» объясняет число, а «расход 2» в одиночку
       * заставляет искать объяснение в заявке. Ноль при ненулевых слагаемых — законный исход
       * (съездили, выдали, вернули), и он обязан читаться именно так, а не как «ничего не было».
       */
      render: (_v, row) => (
        <Space orientation="vertical" size={0} style={{ alignItems: 'flex-end' }}>
          <Typography.Text strong>{row.quantity}</Typography.Text>
          {row.returned > 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              выдано {row.issued}, возврат {row.returned}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    { key: 'actor', title: 'Кто выдал', width: 200, render: (_v, row) => row.actorName },
  ];
}

export function OfficeEquipmentConsumableUsageModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const isMobile = useIsMobile();

  /**
   * Умолчание — текущий месяц с первого числа по сегодня: расход спрашивают месяцем, и период,
   * начинающийся с сегодняшнего дня, открывал бы отчёт пустым у всех.
   */
  const [period, setPeriod] = useState<[string, string]>([
    dayjs().startOf('month').format(DATE),
    dayjs().format(DATE),
  ]);
  const [consumableId, setConsumableId] = useState<string | undefined>();

  const query = { from: period[0], to: period[1], consumableId };

  const { data, isFetching } = useQuery({
    queryKey: officeEquipmentConsumableKeys.usage(query),
    queryFn: () => officeEquipmentConsumablesApi.usage(query),
    enabled: open,
  });

  const { data: options = [], isFetching: optionsLoading } = useQuery({
    ...officeEquipmentConsumablePickerQuery(),
    enabled: open,
  });

  /**
   * Выгрузка — мутацией, а не запросом: файл не кэшируют и не перезапрашивают по сроку годности,
   * его отдают один раз по нажатию. Отказ показывается словами: браузер на неудачной загрузке
   * молчит, и без тоста человек решил бы, что кнопка не работает.
   */
  const exportMut = useMutation({
    mutationFn: () => officeEquipmentConsumablesApi.usageExport(query),
    onError: (e) => message.error(errorMessage(e)),
  });

  const rows = data?.rows ?? [];

  return (
    <ViewModal
      title="Расход расходников за период"
      open={open}
      onClose={onClose}
      width={1100}
      // Период и отбор в следующий раз спрашивают другие: собрать окно заново дешевле, чем тащить
      // за собой прошлый заход.
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
          allowClear={false}
          value={[dayjs(period[0]), dayjs(period[1])]}
          onChange={(v) => {
            if (v?.[0] && v[1]) setPeriod([v[0].format(DATE), v[1].format(DATE)]);
          }}
        />
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="Все позиции"
          style={{ width: 320 }}
          loading={optionsLoading}
          options={options}
          value={consumableId}
          onChange={(v: string | undefined) => setConsumableId(v)}
        />
        <Button
          icon={<DownloadOutlined />}
          loading={exportMut.isPending}
          onClick={() => exportMut.mutate()}
        >
          Выгрузить
        </Button>
        {/* Итоги — с сервера и по всему периоду: показанные строки могут быть обрезаны потолком. */}
        <SummaryBar
          title="За период"
          items={[
            { label: 'расход', value: (data?.totalIssued ?? 0) - (data?.totalReturned ?? 0) },
            { label: 'выдано', value: data?.totalIssued ?? 0 },
            { label: 'возврат', value: data?.totalReturned ?? 0 },
          ]}
        />
      </Space>

      <Typography.Text type="secondary" style={{ flex: '0 0 auto', fontSize: 12 }}>
        Расход считается по движению склада: выдачи за вычетом возвратов. Ручные правки остатка в
        него не входят — они видны в журнале самой позиции.
      </Typography.Text>

      {data?.truncated && (
        // Молча урезанный отчёт читается как полный, и заказ составят по нему.
        <Typography.Text type="warning" style={{ flex: '0 0 auto', fontSize: 12 }}>
          Показаны не все строки: период слишком велик. Итоги посчитаны по всему периоду — чтобы
          увидеть строки целиком, сузьте период или выберите позицию.
        </Typography.Text>
      )}

      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>
        <Table<OfficeEquipmentConsumableUsageRowDto>
          size="small"
          rowKey={(row) => `${row.requestId}:${row.consumableId}:${row.actorName}`}
          columns={columnsOf()}
          dataSource={rows}
          loading={isFetching}
          // Страницы клиентские: отчёт приходит целиком одним ответом — тем же, из которого
          // собирается файл, — и серверное листание развело бы экран с выгрузкой.
          pagination={{ pageSize: 50, hideOnSinglePage: true, showSizeChanger: false }}
          locale={{ emptyText: 'За выбранный период со склада ничего не выдавали' }}
        />
      </div>
    </ViewModal>
  );
}

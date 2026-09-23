import { useEffect, useState } from 'react';
import { App, Button, Input, Space, Typography } from 'antd';
import { PrinterOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import {
  canCancelWaybill,
  canPrintWaybill,
  selectedWaybillsLabel,
  WAYBILL_CANCELLED_PRINT_MESSAGE,
  type WaybillDto,
  waybillFormLabels,
} from '@technic/contracts';
import { waybillsApi } from '@entities/waybill';
import { garageKeys } from '@entities/garage';
import { DataTable, listScopeKey, PageTableLayout, sortOptionsFrom } from '@shared/ui';
import { useRouteModal } from '@features/route-modal';
import { useDriverOptions, useOwnVehicleOptions } from './vehicle/shared';
import { waybillFiltersBar, waybillMobileFilters, type WaybillDateRange } from './waybills/filters';
// Подсказки метки «коррекция» и печати сокращённого листа — соседним файлом (Р12, Р13).
import { useWaybillJournalColumns } from './waybills/columns';
import { WaybillPrintModal, type PrintTarget } from '../components/WaybillPrint';
import { useListParams } from '@shared/lib';
import { useAuth } from '../auth/AuthContext';
import { errorMessage } from '../utils/format';

/**
 * Журнал учёта путевых листов (ADR 0037).
 *
 * Выписки здесь нет: лист выписывают из карточки маршрута (ADR 0050), а журнал только отвечает,
 * какие номера выданы, на какие машины и что с ними стало. Аннулированные из списка не исчезают —
 * пропуск в нумерации означает утраченный бланк, а не отменённый рейс.
 *
 * С уходом вкладки «Маршруты» (ADR 0120) журнал перестал быть тупиком: рейс он теперь называет
 * своей колонкой и открывает окном поверх себя — отобранный за месяц список при этом остаётся на
 * экране. Точкой входа в список рейсов журнал намеренно не стал: у механика и главного механика,
 * которые его и читают, прав на рейсы нет вовсе.
 */

const DATE = 'YYYY-MM-DD';
const today = () => dayjs().format(DATE);

export function WaybillsPage() {
  const { message, modal } = App.useApp();
  const { can } = useAuth();
  /** Рейс и заявка — окнами поверх журнала (ADR 0120): см. колонку «Маршрут» и талоны заказчиков. */
  const { openRoute, openRequest } = useRouteModal();
  const canCancel = can('waybills.cancel');
  const canAttach = can('waybills.files');
  /**
   * Списание бланка прошедшего дня (ADR 0101, Р20): та же кнопка, но за календарной границей и под
   * своим правом. Отдельной кнопки не заводится — действие одно и то же, «списать номер», а
   * различает их дата листа; вторая кнопка рядом означала бы, что человеку надо выбирать между
   * ними, хотя выбора у него нет.
   */
  const canCorrect = can('waybills.correct');
  const canCorrectDeep = can('waybills.correctBeyondLimit');
  const qc = useQueryClient();

  /**
   * Фильтры журнала — полосой над таблицей, как на остальных списках портала: часть значений
   * (техника, водитель) это справочники, которым в выпадашке столбца места нет, а период и
   * подавно. Раньше они были разделены надвое — период в шапке страницы, бланк и статус в
   * заголовках столбцов, — и «чем сейчас сужен журнал» приходилось собирать глазами по экрану.
   */
  const [range, setRange] = useState<[dayjs.Dayjs | null, dayjs.Dayjs | null] | null>(null);
  const { params, setParams, setSort, onTableChange } = useListParams<{
    status?: string;
    formCode?: string;
    vehicleId?: string;
    driverPersonId?: string;
    /** «Только коррекции» (ADR 0101 п. 20) — им журнал читает бухгалтерия. */
    correction?: string;
  }>({}, { searchKeys: [] });

  /** Смена любого фильтра возвращает журнал на первую страницу. */
  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  const { options: vehicleOptions, loading: vehiclesLoading } = useOwnVehicleOptions();
  /**
   * Отбор по водителю есть не у всех, кто читает журнал (ADR 0192). Площадка и отдел приходят сюда
   * набором «Путевые листы: просмотр и печать», а карточки водителей им закрыты (`drivers.read`,
   * ADR 0037): фамилию в строке журнала они видят — она напечатана в бланке, который у них на
   * руках, — а справочника людей компании не получают. Поэтому фильтр не просто прячется: без
   * права запрос за справочником не уходит вовсе.
   */
  const canReadDrivers = can('drivers.read');
  const { options: driverOptions, loading: driversLoading } = useDriverOptions(canReadDrivers);

  /**
   * Номер из адреса: сюда приходят по ссылке из маршрута и из карточки заявки — «что стало с этим
   * листом». Карточки у листа нет, журнал и есть карточка, поэтому вместо открытия окна список
   * сужается до одной строки. Поиск остаётся обычным — он стоит полем в панели фильтров, там его
   * видно и оттуда же сбрасывают.
   */
  const [searchParams] = useSearchParams();
  const numberParam = searchParams.get('number');
  useEffect(() => {
    if (!numberParam) return;
    setParams((p) => ({ ...p, search: numberParam, page: 1 }));
  }, [numberParam, setParams]);

  /**
   * Текст в поле поиска — своим состоянием: искомое приходит и снаружи (ссылка `?number=…`), и
   * поле обязано показывать, чем список сужен. Без этого журнал, открытый по ссылке, выглядел бы
   * отобранным неизвестно по чему.
   */
  const [searchText, setSearchText] = useState('');
  useEffect(() => setSearchText(params.search ?? ''), [params.search]);

  /**
   * Выбранные для печати пачкой листы (ADR 0041 в редакции массовой печати).
   *
   * Выбор живёт в пределах показанного списка: сменили страницу, отбор или период — он сбрасывается.
   * Иначе кнопка «Напечатать» отправляла бы в принтер листы, которых человек уже не видит, а
   * счётчик «выбрано 30» относился бы неизвестно к чему.
   */
  const [selected, setSelected] = useState<string[]>([]);
  const [printing, setPrinting] = useState<PrintTarget | null>(null);

  const query = {
    ...params,
    dateFrom: range?.[0]?.format(DATE),
    dateTo: range?.[1]?.format(DATE),
  };
  const { data, isFetching } = useQuery({
    queryKey: ['waybills', query],
    queryFn: () => waybillsApi.list(query),
  });

  const cancelMut = useMutation({
    mutationFn: ({
      id,
      reason,
      operationId,
    }: {
      id: string;
      reason: string;
      operationId: string;
    }) => waybillsApi.cancel(id, { reason, operationId }),
    onSuccess: () => {
      message.success('Лист аннулирован');
      void qc.invalidateQueries({ queryKey: ['waybills'] });
      // Аннулирование размораживает рейс: с выписанным листом его править нельзя, без него — можно.
      void qc.invalidateQueries({ queryKey: ['vehicle-routes'] });
      void qc.invalidateQueries({ queryKey: garageKeys.root });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const confirmCancel = (w: WaybillDto) => {
    let reason = '';
    const backdated = !canCancelWaybill(w, today());
    /**
     * Ключ операции (Р31) придумывается один раз на открытое окно, а не на каждую попытку отправки:
     * повторное нажатие после обрыва связи — это тот же самый ретрай, и сервер обязан вернуть по
     * нему прежний результат, а не списать номер во второй раз.
     */
    const operationId = crypto.randomUUID();
    modal.confirm({
      title: `Аннулировать лист ${w.number}?`,
      // Номер сгорает — для бланка строгой отчётности это норма, но человек должен знать заранее.
      content: (
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            Номер бланка сгорит, а маршрут разморозится: новый лист выписывают с него, когда состав
            рейса пересобран.
          </Typography.Text>
          {/* Прошедший день — это уже коррекция (ADR 0101): работа состоялась, бумага побывала на
              объекте, и списание такого номера остаётся в журнале с причиной и автором. Сказать об
              этом надо до нажатия, а не после: у сегодняшнего и вчерашнего листа кнопка одна. */}
          {backdated && (
            <Typography.Text type="warning">
              День листа прошёл: это коррекция задним числом. Она попадёт в журнал коррекций с вашим
              именем и причиной, а взамен ничего не выписывается — новый лист выписывают с рейса.
            </Typography.Text>
          )}
          <Input.TextArea
            rows={2}
            placeholder={
              backdated
                ? 'Причина: рейс не состоялся, лист выписан на другую машину…'
                : 'Причина: испорчен при печати, ошибка в реквизитах…'
            }
            onChange={(e) => {
              reason = e.target.value;
            }}
          />
        </Space>
      ),
      okText: 'Аннулировать',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: async () => {
        if (!reason.trim()) {
          message.error('Укажите причину');
          throw new Error('reason required');
        }
        await cancelMut.mutateAsync({ id: w.id, reason, operationId });
      },
    });
  };

  /**
   * Ссылка «заменил №… / заменён №…» (ADR 0101 п. 20) — сужением журнала до этого номера.
   *
   * Карточки у листа нет, журнал и есть карточка (`?number=…`), поэтому переход выглядит как
   * поиск: тот же путь, каким сюда приходят из маршрута и из заявки. Ссылка обязательна, а не
   * украшение — за один день в журнале стоят два номера, и без неё разрыв нумерации не объяснить
   * ничем: номер перевыписанного листа берётся из хвоста серии (Р10), вставить его рядом нельзя.
   */
  const numberLink = (label: string, number: string) => (
    <Typography.Link onClick={() => applyFilter({ search: number })}>
      {label} № {number}
    </Typography.Link>
  );

  const columns = useWaybillJournalColumns({
    canAttach,
    canCancel,
    canCorrect,
    canCorrectDeep,
    numberLink,
    onCancel: confirmCancel,
    openRequest,
    openRoute,
  });

  /**
   * Фильтры собираются рядом с журналом, но живут своим файлом: их шесть, и каждый описан дважды —
   * полосой для десктопа и описанием для шита телефона.
   */
  const filterOptions = {
    values: params,
    onChange: applyFilter,
    searchText,
    onSearchTextChange: setSearchText,
    range,
    onRangeChange: (next: WaybillDateRange) => {
      setRange(next);
      applyFilter({});
    },
    vehicles: { options: vehicleOptions, loading: vehiclesLoading },
    drivers: canReadDrivers ? { options: driverOptions, loading: driversLoading } : null,
  };

  return (
    <PageTableLayout
      filters={waybillFiltersBar(filterOptions)}
      mobile={{
        search: {
          value: params.search,
          placeholder: 'Номер листа',
          onChange: (v) => applyFilter({ search: v }),
        },
        filters: waybillMobileFilters(filterOptions),
        sort: {
          options: sortOptionsFrom(columns, { number: 'Номер', issuedForDate: 'На дату' }),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
      }}
    >
      <DataTable<WaybillDto>
        columns={columns}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        sortBy={params.sortBy}
        sortOrder={params.sortOrder}
        onChange={onTableChange}
        /*
         * Выбор строк — ради печати пачкой: день машины или день колонны печатают разом, и до
         * сих пор это значило открыть, напечатать и закрыть столько раз, сколько листов.
         * Аннулированные не выбираются вовсе: их не печатают ни поодиночке, ни в пачке.
         */
        selection={{
          keys: selected,
          onChange: setSelected,
          /*
           * Отпечаток — из того же запроса, которым загружен список: сменили страницу, период или
           * отбор, и в принтер уже не уйдут листы, которых человек на экране не видит.
           */
          scopeKey: listScopeKey(query),
          disabled: (r) => (canPrintWaybill(r.status) ? null : WAYBILL_CANCELLED_PRINT_MESSAGE),
          bar: (keys) => (
            <>
              <Typography.Text strong>{selectedWaybillsLabel(keys.length)}</Typography.Text>
              <Button
                type="primary"
                icon={<PrinterOutlined />}
                onClick={() =>
                  setPrinting({
                    ids: keys,
                    title:
                      keys.length === 1
                        ? 'Путевой лист'
                        : `Путевые листы: ${keys.length} в одном документе`,
                  })
                }
              >
                Напечатать
              </Button>
              <Button onClick={() => setSelected([])}>Снять выбор</Button>
            </>
          ),
        }}
      />

      {/* Пачка печатается тем же окном, что и один лист: сервер собирает бланки в один PDF, и
        диалог печати браузера остаётся один. */}
      <WaybillPrintModal target={printing} onClose={() => setPrinting(null)} />
      {/* Откуда берутся номера, которых в журнале не выписывают. Кнопки «Маршруты» здесь нет
        намеренно: список рейсов вызывают оттуда, где их ведут, а журнал читают механик и главный
        механик, у которых прав на рейсы нет вовсе, — кнопка обещала бы им запертую дверь. */}
      <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
        Листы на рейс ({waybillFormLabels['4p']}, {waybillFormLabels.leg3}) здесь не выписывают: их
        выдаёт карточка маршрута, когда состав рейса собран, — она открывается окном поверх того
        экрана, с которого о рейсе спросили. {waybillFormLabels.esm2} портал выписывает сам: заявку
        на технику берут в работу, и лист рождается на каждую неделю её срока.
      </Typography.Paragraph>
    </PageTableLayout>
  );
}

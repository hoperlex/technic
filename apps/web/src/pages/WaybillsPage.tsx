import { useEffect, useState } from 'react';
import { App, Button, Input, Space, Tag, Tooltip, Typography } from 'antd';
import { PrinterOutlined, StopOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import {
  canCancelWaybill,
  canCorrectWaybill,
  canPrintWaybill,
  selectedWaybillsLabel,
  WAYBILL_CANCELLED_PRINT_MESSAGE,
  WAYBILL_CORRECTION_LOCKED_MESSAGE,
  WAYBILL_LOCKED_MESSAGE,
  type WaybillDto,
  waybillFormLabels,
  waybillFormShortLabels,
  waybillStatusColors,
  waybillStatusLabels,
} from '@technic/contracts';
import { waybillsApi } from '../api/resources';
import { WaybillFilesCell } from '../components/WaybillFiles';
import { garageKeys } from '@entities/garage';
import { DataTable } from '@shared/ui';
import { EntityLink } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { actionsColumn, badgeColumn, textColumn } from '@shared/ui';
import { sortOptionsFrom } from '@shared/ui';
import { useDriverOptions, useOwnVehicleOptions } from './vehicle/shared';
import { waybillFiltersBar, waybillMobileFilters, type WaybillDateRange } from './waybills/filters';
import {
  ExportWaybillButton,
  PrintWaybillButton,
  WaybillPrintModal,
  type PrintTarget,
} from '../components/WaybillPrint';
import { useListParams } from '@shared/lib';
import { useAuth } from '../auth/AuthContext';
import { errorMessage } from '../utils/format';
import { vehicleRequestLink } from '../utils/links';

/**
 * Журнал учёта путевых листов (ADR 0037).
 *
 * Выписки здесь нет: лист выписывают с маршрута (ADR 0050), а журнал только отвечает, какие номера
 * выданы, на какие машины и что с ними стало. Аннулированные из списка не исчезают — пропуск в
 * нумерации означает утраченный бланк, а не отменённый рейс.
 */

const DATE = 'YYYY-MM-DD';
const today = () => dayjs().format(DATE);

export function WaybillsPage() {
  const { message, modal } = App.useApp();
  const { can } = useAuth();
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
  const { options: driverOptions, loading: driversLoading } = useDriverOptions();

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

  // Список сменился — выбор снят. Зависимость сама выдача, а не параметры запроса: перерисовка
  // теми же строками (обновление после печати) выбор не трогает, а другая страница или другой
  // отбор его обнуляют.
  useEffect(() => setSelected([]), [data]);

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
        <Space direction="vertical" style={{ width: '100%' }}>
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

  const columns = [
    textColumn<WaybillDto>({
      key: 'number',
      title: 'Номер',
      dataIndex: 'number',
      width: 240,
      // Поиск переехал в панель над таблицей: там его видно вместе с остальными сужениями.
      searchable: false,
      render: (_v, r) => (
        <Space direction="vertical" size={0}>
          <span>{r.number}</span>
          {/* Метка стоит у номера, а не в столбце статуса: статус отвечает, действует ли бланк, а
              это — откуда он такой взялся. Признак считает сервер по ссылке на операцию, поэтому
              метку получает и списанный задним числом лист, у которого замены нет вовсе. */}
          {r.isCorrection && (
            <Tooltip title={r.correctionReason || r.cancelReason || 'Правка задним числом'}>
              <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                коррекция
              </Tag>
            </Tooltip>
          )}
          {r.correctsNumber && numberLink('заменил', r.correctsNumber)}
          {r.correctedByNumber && numberLink('заменён', r.correctedByNumber)}
        </Space>
      ),
    }),
    // Полная подпись бланка в колонку не влезает, а на вопрос «какой это лист» отвечает и
    // короткая. Отбор по бланку — в панели фильтров, там для полной подписи место есть.
    badgeColumn<WaybillDto>({
      key: 'formCode',
      title: 'Форма',
      dataIndex: 'formCode',
      width: 110,
      labels: waybillFormShortLabels,
      // Сортировки по бланку сервер не знает (`WAYBILL_SORT_FIELDS`), и заголовок не должен её
      // обещать: отправленное поле схема отклонит, а список ответит ошибкой вместо строк.
      // Отбирают по бланку фильтром в панели — этот вопрос и задают.
      sortable: false,
    }),
    textColumn<WaybillDto>({
      key: 'issuedForDate',
      title: 'На дату',
      dataIndex: 'issuedForDate',
      width: 150,
      // У ЭСМ-2 в этой графе не день, а неделя работ: лист выписан на период, и одна дата в нём
      // ничего не значит — по ней не понять, какую неделю держит бланк.
      render: (_v, r) =>
        r.periodFrom && r.periodTo
          ? `${dayjs(r.periodFrom).format('DD.MM')} — ${dayjs(r.periodTo).format('DD.MM.YYYY')}`
          : dayjs(r.issuedForDate).format('DD.MM.YYYY'),
    }),
    textColumn<WaybillDto>({
      key: 'vehicleLabel',
      title: 'Техника',
      dataIndex: 'vehicleLabel',
      sortable: false,
      searchable: false,
      render: (_v, r) => (
        <Space direction="vertical" size={0}>
          <span>{r.vehicleLabel}</span>
          {r.withTrailer && (
            <Typography.Text type="secondary">с прицепом {r.trailerLabel}</Typography.Text>
          )}
        </Space>
      ),
    }),
    textColumn<WaybillDto>({
      key: 'driverName',
      title: 'Водитель',
      dataIndex: 'driverName',
      sortable: false,
      searchable: false,
      width: 220,
    }),
    textColumn<WaybillDto>({
      key: 'requests',
      title: 'Талоны заказчиков',
      dataIndex: 'requests',
      sortable: false,
      searchable: false,
      width: 260,
      render: (_v, r) =>
        r.requests.length === 0 ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Space direction="vertical" size={0}>
            {/* Номер талона ведёт к самой заявке: журнал отвечает, что за бланк выдан, а «что в
                нём за работа» спрашивают у заявки — и до сих пор искали её номер руками. */}
            {r.requests.map((link) => (
              <span key={link.requestId}>
                {link.slot}.{' '}
                <EntityLink
                  to={vehicleRequestLink(can, { id: link.requestId, status: link.status })}
                  title="Открыть заявку"
                >
                  {link.displayNumber}
                </EntityLink>{' '}
                — {link.objectName}
              </span>
            ))}
          </Space>
        ),
    }),
    // Скан заполненного бланка: у ЭСМ-2 оборот заполняет заказчик, у 4-П — отметки о выполнении.
    // Портал этих значений не разбирает, но журнал обязан отвечать, чем кончился выданный номер.
    textColumn<WaybillDto>({
      key: 'files',
      title: 'Файлы',
      dataIndex: 'files',
      sortable: false,
      searchable: false,
      width: 100,
      render: (_v, r) => <WaybillFilesCell waybillId={r.id} files={r.files} canEdit={canAttach} />,
    }),
    badgeColumn<WaybillDto>({
      key: 'status',
      title: 'Статус',
      dataIndex: 'status',
      width: 130,
      labels: waybillStatusLabels,
      colors: waybillStatusColors,
      // Как и у бланка: сортировки по статусу сервер не знает, а сужают по нему фильтром.
      sortable: false,
    }),
    // Причина отдельной колонкой, а не подписью к статусу: аннулированный лист объясняют, и
    // читают это объяснение вместе с номером, а не вместо него.
    //
    // Колонка одна на два вопроса, потому что вопрос один — «почему этот номер такой»: у
    // списанного бланка отвечает `cancelReason` (туда же уходит причина коррекции, Р35), у
    // выписанного взамен — `correctionReason`. Второй столбец, пустой у всего журнала, кроме
    // коррекций, отнял бы место у талонов заказчиков ради той же фразы.
    textColumn<WaybillDto>({
      key: 'cancelReason',
      title: 'Причина',
      dataIndex: 'cancelReason',
      sortable: false,
      searchable: false,
      width: 200,
      ellipsis: true,
      render: (_v, r) => r.cancelReason || r.correctionReason || '',
    }),
    actionsColumn<WaybillDto>((r) => {
      /*
       * Две границы, а не одна (ADR 0101, Р20). До конца дня листа бланк списывает всякий, у кого
       * есть `waybills.cancel`, — это дневная работа. Дальше начинается коррекция: право
       * `waybills.correct`, глубина `waybills.correctBeyondLimit` и обязательная причина.
       *
       * Правила те же, что у сервера, и функции те же (`canCancelWaybill`, `canCorrectWaybill`):
       * кнопка не должна предлагать того, чем ручка ответит отказом, и не должна запирать того,
       * что ручка примет.
       */
      const today0 = today();
      const editable =
        r.status === 'issued' &&
        (canCancelWaybill(r, today0) ||
          (canCorrect && canCorrectWaybill(r, today0, { unlimited: canCorrectDeep })));
      const lockedTitle = canCorrect ? WAYBILL_CORRECTION_LOCKED_MESSAGE : WAYBILL_LOCKED_MESSAGE;
      return (
        <Space>
          {/* Печать первой — ради неё лист и открывают (ADR 0041), а файл забирают тогда, когда
              бланк дополняют от руки в редакторе таблиц. У аннулированного не работает ни то, ни
              другое: номер списан, а напечатанный бланк неотличим от действующего.

              Синяя точка в углу кнопки — «эта бумага уже уходила»: печатали или выгружали, кто
              угодно и когда угодно, в том числе пачкой. */}
          <PrintWaybillButton
            waybillId={r.id}
            number={r.number}
            status={r.status}
            printedAt={r.printedAt}
          />
          <ExportWaybillButton
            waybillId={r.id}
            number={r.number}
            status={r.status}
            exportedAt={r.exportedAt}
          />
          {canCancel && (
            <Button
              size="small"
              danger
              icon={<StopOutlined />}
              disabled={!editable}
              // Причина запрета проговаривается подсказкой: выключенная кнопка без объяснения
              // читается как поломка.
              title={
                r.status === 'cancelled'
                  ? 'Лист уже аннулирован'
                  : !editable
                    ? lockedTitle
                    : canCancelWaybill(r, today0)
                      ? 'Аннулировать'
                      : 'Аннулировать задним числом: понадобится причина'
              }
              onClick={() => confirmCancel(r)}
            />
          )}
        </Space>
      );
    }),
  ];

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
    drivers: { options: driverOptions, loading: driversLoading },
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
      <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
        Листы на рейс ({waybillFormLabels['4p']}, {waybillFormLabels.leg3}) выписываются с маршрута
        — во вкладке «Маршруты» раздела «Заказ ТС», когда состав рейса собран.{' '}
        {waybillFormLabels.esm2} портал выписывает сам: заявку на технику берут в работу, и лист
        рождается на каждую неделю её срока.
      </Typography.Paragraph>
    </PageTableLayout>
  );
}

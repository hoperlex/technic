import { useState } from 'react';
import { Alert, App, Button, Descriptions, Space, Tag, Typography } from 'antd';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BLANK_WAYBILL_CONFIRM,
  canIssueWaybill,
  driverDocumentGapsWarning,
  isRouteEditable,
  canCancelWaybill,
  isRelocationPurpose,
  LINEAR_DAY_DOOR_MESSAGE,
  routeRequestCapacity,
  routePurposeLabels,
  moscowDateKeyOf,
  requestStatusColors,
  requestStatusLabels,
  ROUTE_FROZEN_MESSAGE,
  type VehicleRequestDto,
  type VehicleRouteDto,
  type VehicleRouteRequestDto,
  type WaybillFormCode,
  WAYBILL_COUPONS,
  WAYBILL_LOCKED_MESSAGE,
  waybillFormShortLabels,
  waybillStatusColors,
  waybillStatusLabels,
} from '@technic/contracts';
import { vehicleRequestsApi, vehicleRoutesApi, waybillsApi } from '../../api/resources';
import { garageKeys } from '@entities/garage';
import { AutoSelect } from '@shared/ui';
import { ViewModal } from '@shared/ui';
import { PrintWaybillButton } from '../../components/WaybillPrint';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';
import { formatDateOnly } from './shared';

/**
 * Карточка рейса: кто едет, с кем и в каком порядке.
 *
 * Порядок заявок — это строки задания бланка, поэтому переставляются они стрелками, а не
 * перетаскиванием: позиций от семи до десяти по бланку рейса, а стрелки одинаково работают и на
 * телефоне. В 4-П порядок ещё и значим: первые четыре строки несут отрывной талон заказчика,
 * остальные три — доп. задание.
 *
 * Выписанный лист карточку замораживает: состав, порядок и водитель правятся только до него —
 * бланк уже у водителя, и запись, разошедшаяся с бумагой на руках, хуже отсутствия записи
 * (ADR 0037 п. 9). Чтобы пересобрать рейс, лист аннулируют — тем же правом и с той же причиной,
 * что в журнале.
 */

interface Props {
  /** null — окно закрыто. */
  routeId: string | null;
  onClose: () => void;
  /** Список рейсов и список заявок после правки устарели — их обновляет вкладка. */
  onChanged: () => void;
  /**
   * Открыть правку реквизитов рейса: день, водитель, графы шапки. Отдельным окном, а не полями
   * прямо здесь: карточка отвечает на «что за рейс и что с ним делать», и поля ввода посреди
   * состава превратили бы её в форму.
   */
  onEdit?: (route: VehicleRouteDto) => void;
}

export function VehicleRouteModal({ routeId, onClose, onChanged, onEdit }: Props) {
  const { message, modal } = App.useApp();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [adding, setAdding] = useState<string | undefined>();

  const { data: route, isFetching } = useQuery({
    queryKey: ['vehicle-routes', routeId],
    queryFn: () => vehicleRoutesApi.get(routeId!),
    enabled: !!routeId,
  });

  const frozen = !!route && !isRouteEditable(route.waybill?.status ?? null);

  /**
   * Что можно положить в этот рейс: грузоперевозки в работе на собственной технике, поданные в
   * тот же день. Отбор тот же, что проверит сервер, — иначе список предлагал бы заявки, которые
   * он отклонит.
   *
   * Заказанный тип заявки список не сужает (ADR 0059): день машины собирают по объектам, а объекты
   * заказывают разное — самосвал и бортовой. Раньше такая заявка в рейс не вставала, и второй
   * объект приходилось везти отдельным рейсом. Расхождение с машиной рейса помечено в строке.
   *
   * Заявки чужих рейсов входят сюда наравне со свободными: переложить заявку из Р-7 в Р-9 — это
   * одно действие переноса, а не «вынуть и положить» двумя, между которыми заявка висит без
   * маршрута. Не входят только те, чей рейс заморожен выписанным листом: из бумаги, которая у
   * водителя, заявка исчезнуть не может.
   */
  const { data: candidates } = useQuery({
    queryKey: ['vehicle-requests', 'for-route', route?.routeDate],
    queryFn: () =>
      vehicleRequestsApi.list({
        status: 'confirmed',
        requestType: 'freight_transport',
        dateFrom: route!.routeDate,
        dateTo: route!.routeDate,
        page: 1,
        pageSize: 500,
      }),
    enabled: !!route && !frozen,
  });
  const free = (candidates?.items ?? []).filter(
    (r: VehicleRequestDto) =>
      r.assignment?.ownership === 'own' &&
      r.route?.id !== route?.id &&
      !(r.route && r.route.hasWaybill),
  );

  const afterChange = (updated: VehicleRouteDto) => {
    qc.setQueryData(['vehicle-routes', updated.id], updated);
    onChanged();
  };

  const fail = (e: unknown) => message.error(errorMessage(e));

  /** Заявка, выбранная в списке добавления: по её рейсу и различаются «положить» и «перенести». */
  const candidate = free.find((r) => r.id === adding) ?? null;

  const attach = useMutation({
    mutationFn: (requestId: string) => {
      const source = free.find((r) => r.id === requestId)?.route ?? null;
      return vehicleRoutesApi.attach(route!.id, {
        requestId,
        version: route!.version,
        // Перенос — операция над двумя рейсами, и исходный опознаётся парой «кто + версия»:
        // версии нумеруются в каждом рейсе отдельно, и одинокая совпала бы случайно.
        source: source ? { routeId: source.id, version: source.version } : undefined,
      });
    },
    onSuccess: (updated) => {
      setAdding(undefined);
      afterChange(updated);
    },
    onError: fail,
  });

  const detach = useMutation({
    mutationFn: (requestId: string) =>
      vehicleRoutesApi.detach(route!.id, requestId, route!.version),
    onSuccess: afterChange,
    onError: fail,
  });

  const reorder = useMutation({
    mutationFn: (requestIds: string[]) =>
      vehicleRoutesApi.order(route!.id, { requestIds, version: route!.version }),
    onSuccess: afterChange,
    onError: fail,
  });

  const issue = useMutation({
    mutationFn: () => vehicleRoutesApi.issueWaybill(route!.id, route!.version),
    onSuccess: (updated) => {
      message.success(`Путевой лист ${updated.waybill?.number ?? ''} выписан`);
      afterChange(updated);
    },
    onError: fail,
  });

  /**
   * Чего не хватает водителю рейса для бланка (ADR 0064): выписку это не останавливает, но графа
   * СНИЛСа или номера удостоверения останется в листе пустой, а лист с пустой графой
   * недействителен. Вид документа назван водительским жёстко: `driverGaps` его не несёт, а 4-П и
   * форму № 3 возит водитель (ADR 0095).
   */
  const formLabel = route?.formCode ? waybillFormShortLabels[route.formCode] : null;
  const driverGaps = route
    ? driverDocumentGapsWarning(route.driverGaps, 'driver_license', formLabel)
    : null;

  /** Рейс без заявок: лист по нему выписывается пустым бланком (ADR 0071). */
  const blank = !!route && !isRelocationPurpose(route.purpose) && route.requests.length === 0;

  /**
   * Пустые графы спрашиваются подтверждением, а не просто предупреждением над кнопкой: номер
   * бланка расходуется навсегда, и «выписал не глядя» здесь стоит дороже лишнего клика. Там, где
   * с документами всё в порядке, лишнего окна нет — лист выписывается сразу.
   *
   * Пустой бланк спрашивается тем же окном и всегда: задание в нём не печатается вовсе, и «забыл
   * положить заявки» от «выписываю пустой намеренно» отличает только человек.
   */
  const confirmIssue = () => {
    if (!driverGaps && !blank) {
      issue.mutate();
      return;
    }
    modal.confirm({
      title: blank ? 'Выписать пустой лист?' : 'Выписать лист с незаполненными графами?',
      content: (
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          {blank ? BLANK_WAYBILL_CONFIRM : driverGaps} {blank && driverGaps ? `${driverGaps} ` : ''}
          Номер бланка израсходуется: чтобы переписать лист, его придётся аннулировать.
        </Typography.Paragraph>
      ),
      okText: 'Всё равно выписать',
      cancelText: 'Отмена',
      onOk: () => issue.mutateAsync(),
    });
  };

  const cancelWaybill = useMutation({
    mutationFn: (reason: string) => waybillsApi.cancel(route!.waybill!.id, { reason }),
    onSuccess: async () => {
      message.success('Лист аннулирован — маршрут снова можно править');
      await qc.invalidateQueries({ queryKey: ['vehicle-routes'] });
      // Аннулированный лист остаётся в журнале со своим состоянием: там его и ищут, чтобы понять,
      // почему номер бланка израсходован.
      await qc.invalidateQueries({ queryKey: ['waybills'] });
      await qc.invalidateQueries({ queryKey: garageKeys.root });
      onChanged();
    },
    onError: fail,
  });

  /** Сдвиг строки: порядок уходит на сервер целиком — он переписывает его одним заходом. */
  const move = (index: number, delta: number) => {
    if (!route) return;
    const ids = route.requests.map((r) => r.requestId);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    reorder.mutate(ids);
  };

  const confirmCancelWaybill = () => {
    let reason = '';
    modal.confirm({
      title: `Аннулировать лист ${route?.waybill?.number}?`,
      content: (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            Номер бланка сгорит: после правки рейса выпишется новый.
          </Typography.Text>
          <textarea
            className="ant-input"
            rows={2}
            placeholder="Причина: испорчен при печати, сменился водитель…"
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
        await cancelWaybill.mutateAsync(reason);
      },
    });
  };

  const readiness = route
    ? canIssueWaybill({
        purpose: route.purpose,
        driverPersonId: route.driverPersonId,
        // Пустой бланк — право администратора (ADR 0071). Спрашивается тем же правилом, что и на
        // сервере: иначе кнопка обещала бы то, чего ручка не сделает.
        blankAllowed: can('waybills.issueBlank'),
        formCode: route.formCode,
        requests: route.requests,
        sourceRequest: route.sourceRequest,
        waybillStatus: route.waybill?.status ?? null,
      })
    : null;

  /** Перегон техники: состава у него нет, а задание печатается из самого рейса. */
  const relocation = !!route && isRelocationPurpose(route.purpose);

  /**
   * Есть ли куда положить ещё одну заявку. Сколько строк задания у рейса, решает его бланк
   * (ADR 0068): у 4-П семь, у формы № 3 — десять.
   */
  const canAddRequest =
    !!route &&
    !relocation &&
    !frozen &&
    route.requests.length < routeRequestCapacity(route.formCode);

  const waybillEditable =
    !!route?.waybill &&
    route.waybill.status === 'issued' &&
    // Лист рейса периода не имеет — граница у него по дню выезда (ЭСМ-2 сюда не попадает: у
    // недели работы машины на площадке рейса нет вовсе).
    canCancelWaybill(route.waybill, moscowDateKeyOf(new Date()));

  return (
    <ViewModal
      title={
        route ? `Маршрут ${route.displayNumber} · ${formatDateOnly(route.routeDate)}` : 'Маршрут'
      }
      open={!!routeId}
      onClose={onClose}
      width={720}
      destroyOnHidden
      footer={
        route && (
          <Space wrap>
            {/* Правка рейса — тем же правом, что и всё остальное в карточке: день переставляют и
              водителя меняют утром того же дня, ради этого карточку чаще всего и открывают. */}
            {onEdit && (
              <Button
                icon={<EditOutlined />}
                disabled={frozen}
                title={frozen ? ROUTE_FROZEN_MESSAGE : 'Изменить дату, водителя и реквизиты'}
                onClick={() => onEdit(route)}
              >
                Редактировать
              </Button>
            )}
            {/* Аннулированный лист печатать нельзя (`canPrintWaybill`) — кнопка о нём и не
              заикается: рейс уже разморожен, и говорить здесь надо о новом бланке, а не о
              списанном номере. */}
            {route.waybill && route.waybill.status !== 'cancelled' && (
              <PrintWaybillButton
                waybillId={route.waybill.id}
                number={route.waybill.number}
                status={route.waybill.status}
              />
            )}
            {route.waybill && can('waybills.cancel') && (
              <Button
                danger
                disabled={!waybillEditable}
                // Выключенная кнопка объясняет себя: иначе она читается как поломка.
                title={
                  route.waybill.status === 'cancelled'
                    ? 'Лист уже аннулирован'
                    : waybillEditable
                      ? 'Аннулировать лист'
                      : WAYBILL_LOCKED_MESSAGE
                }
                onClick={confirmCancelWaybill}
              >
                Аннулировать лист
              </Button>
            )}
            <Button
              type="primary"
              loading={issue.isPending}
              disabled={!readiness?.ok}
              title={readiness?.ok ? 'Выписать путевой лист' : readiness?.reason}
              onClick={confirmIssue}
            >
              Выписать лист
            </Button>
          </Space>
        )
      }
    >
      {route && (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Descriptions column={1} size="small">
            <Descriptions.Item label="Техника">
              {route.vehicleLabel}
              {route.withTrailer && ` · с прицепом ${route.trailerLabel}`}
            </Descriptions.Item>
            <Descriptions.Item label="Водитель">
              {route.driverName || <Tag color="orange">не назначен</Tag>}
            </Descriptions.Item>
            {/* Перегон: задание ему даёт не состав, а две строки «откуда — куда» (миграция 0082). */}
            {relocation && (
              <Descriptions.Item label={routePurposeLabels[route.purpose]}>
                {route.moveFrom} → {route.moveTo}
                {route.sourceRequest && ` · по заявке ${route.sourceRequest.displayNumber}`}
              </Descriptions.Item>
            )}
            <Descriptions.Item label="Путевой лист">
              {route.waybill ? (
                <Space>
                  {route.waybill.number}
                  <Tag color={waybillStatusColors[route.waybill.status]}>
                    {waybillStatusLabels[route.waybill.status]}
                  </Tag>
                </Space>
              ) : (
                <Typography.Text type="secondary">не выписан</Typography.Text>
              )}
            </Descriptions.Item>
          </Descriptions>

          {frozen && <Alert type="info" showIcon message={ROUTE_FROZEN_MESSAGE} />}
          {!frozen && readiness && !readiness.ok && (relocation || route.requests.length > 0) && (
            <Alert type="warning" showIcon message={readiness.reason} />
          )}
          {/* Пробелы документов водителя — до нажатия «Выписать лист», а не в подтверждении:
            назначить другого человека проще, пока бланк не израсходован. Замороженный рейс
            молчит — там лист уже напечатан, и говорить о пустых графах поздно. */}
          {!frozen && driverGaps && (
            <Alert
              type="warning"
              showIcon
              message="Документы водителя внесены не полностью"
              description={driverGaps}
            />
          )}

          {/* Состав — только у грузового рейса: задание из нескольких строк это про машину,
            которая за смену объезжает несколько площадок. Перегон везёт одну единицу техники по
            одной заявке. */}
          {!relocation && (
            <div>
              <Typography.Title level={5}>
                Заявки рейса ({route.requests.length} из {routeRequestCapacity(route.formCode)})
              </Typography.Title>
              {/* Форма № 3 задание не печатает (ADR 0071): порядок выполнения у легкового не
                гарантирован, и бланк выходит с реквизитами и пустым оборотом. Сказать об этом
                нужно там, где состав собирают, — иначе расхождение бумаги с рейсом обнаружат
                после печати. */}
              {route.formCode === 'leg3' && (
                <Typography.Paragraph type="secondary">
                  В бланке легкового задание не печатается: заявки остаются планом рейса, а в лист
                  не идут.
                </Typography.Paragraph>
              )}
              {route.requests.length === 0 && (
                <Typography.Paragraph type="secondary">
                  Рейс пуст: положите в него заявку, взятую в работу на эту машину и дату.
                  {can('waybills.issueBlank') &&
                    ' Либо выпишите пустой лист — с машиной, водителем и датой, но без задания.'}
                </Typography.Paragraph>
              )}
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {route.requests.map((item, index) => (
                  <RouteRequestRow
                    key={item.requestId}
                    item={item}
                    index={index}
                    total={route.requests.length}
                    formCode={route.formCode}
                    frozen={frozen}
                    busy={reorder.isPending || detach.isPending}
                    onMove={move}
                    onDetach={() => detach.mutate(item.requestId)}
                  />
                ))}
              </Space>
            </div>
          )}

          {canAddRequest && (
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Space.Compact style={{ width: '100%' }}>
                <AutoSelect
                  style={{ width: '100%' }}
                  value={adding}
                  onChange={(v) => setAdding(v as string)}
                  // Заявка чужого рейса подписана этим рейсом и строкой задания: диспетчер должен
                  // видеть, что забирает её у Р-7, а не берёт со свободных.
                  options={free.map((r) => ({
                    value: r.id,
                    label: [
                      r.requestType === 'freight_transport'
                        ? `${r.displayNumber} · ${r.loadingLocation} → ${r.unloadingLocation}`
                        : r.displayNumber,
                      // Заказанный тип заявки — когда он не совпадает с машиной рейса (ADR 0059).
                      // День машины собирают по объектам, а объекты заказывают разное: «заказан
                      // бортовой» в строке объясняет, почему заявка вообще тут оказалась.
                      r.vehicleTypeId !== route.vehicleTypeId
                        ? `заказан ${r.vehicleTypeName}`
                        : null,
                      r.route ? `из ${r.route.displayNumber}, строка ${r.route.position}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · '),
                  }))}
                  showSearch
                  optionFilterProp="label"
                  placeholder={
                    free.length > 0
                      ? 'Заявка в работе — свободная или из другого рейса'
                      : 'Подходящих заявок на эту дату нет'
                  }
                  disabled={free.length === 0}
                />
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  loading={attach.isPending}
                  disabled={!adding}
                  onClick={() => adding && attach.mutate(adding)}
                >
                  {candidate?.route ? 'Перенести' : 'Добавить'}
                </Button>
              </Space.Compact>
              {/* Рейс — источник истины о том, чем едут: заявка, переехавшая сюда с другой
                машины, поедет этой. Об этом говорят до нажатия, а не после. */}
              {candidate?.route && candidate.assignment?.vehicleId !== route.vehicleId && (
                <Typography.Text type="warning">
                  {candidate.displayNumber} поедет машиной этого рейса — {route.vehicleLabel}
                </Typography.Text>
              )}
              {/* Линейных заказов в этом списке нет и не будет: день кладут из карточки заявки, а
                рейс не знает, какой день срока в него ставят (ADR 0100 решение 8). Сказано это
                там, где их стали бы искать, — иначе отсутствие читалось бы как пропажа. */}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {LINEAR_DAY_DOOR_MESSAGE}
              </Typography.Text>
            </Space>
          )}
        </Space>
      )}
      {!route && isFetching && <Typography.Text type="secondary">Загружаем рейс…</Typography.Text>}
    </ViewModal>
  );
}

/**
 * Строка задания: номер по порядку, заказчик и маршрут груза. Отменённая или закрытая заявка
 * остаётся в рейсе историей (лист по ней уже выписан) — её помечает тег, и она же не даёт
 * выписать новый лист, пока её не убрали.
 */
function RouteRequestRow({
  item,
  index,
  total,
  formCode,
  frozen,
  busy,
  onMove,
  onDetach,
}: {
  item: VehicleRouteRequestDto;
  index: number;
  total: number;
  /** Бланк рейса: талоны заказчиков есть только у 4-П, и пометка строки — про него. */
  formCode: WaybillFormCode | null;
  frozen: boolean;
  busy: boolean;
  onMove: (index: number, delta: number) => void;
  onDetach: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        border: '1px solid var(--ant-color-border)',
        borderRadius: 8,
        padding: 8,
      }}
    >
      <Tag style={{ marginTop: 2 }}>{item.position}</Tag>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Space size={8} wrap>
          <strong>{item.displayNumber}</strong>
          <span>{item.customerName}</span>
          {/* День линейного заказа (ADR 0100 §2): строка стоит в рейсе ради одного дня срока, и
            читаться она обязана днём заказа, а не безымянной строкой задания. Дата совпадает с
            днём рейса по построению — она здесь затем, чтобы состав отвечал «что это за работа»
            без похода в заявку. */}
          {item.workDate && <Tag color="blue">день заказа {formatDateOnly(item.workDate)}</Tag>}
          {/* Талонов в бланке 4-П четыре, а строк задания семь (ADR 0068): заявка с пятой
            позиции печатается доп. заданием, и отрывного талона заказчик по ней не подпишет.
            Диспетчер видит это, пока рейс ещё собирается, — переставить заявку выше можно только
            здесь. Формы № 3 пометка не касается: талонов в ней нет вовсе, а задание она с
            появления ADR 0071 не печатает и целиком. */}
          {formCode === '4p' && item.position > WAYBILL_COUPONS && (
            <Tag>доп. задание, без талона</Tag>
          )}
          {item.status !== 'confirmed' && (
            <Tag color={requestStatusColors[item.status]}>{requestStatusLabels[item.status]}</Tag>
          )}
        </Space>
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {/* У заказа техники на объект нет ни погрузки с разгрузкой, ни тонн: в задание дня
              печатаются объект и характер работ из самой заявки (ADR 0100 решение 10). Общая
              строка показала бы голую стрелку между двумя пустыми адресами. */}
            {item.workDate
              ? 'День работ на объекте: в задание печатаются адрес площадки и характер работ'
              : `${item.loadingLocation} → ${item.unloadingLocation}${item.cargoLabel ? ` · ${item.cargoLabel}` : ''}`}
          </Typography.Text>
        </div>
      </div>
      {!frozen && (
        <Space>
          <Button
            size="small"
            icon={<ArrowUpOutlined />}
            title="Выше"
            aria-label={`Поднять ${item.displayNumber}`}
            disabled={index === 0 || busy}
            onClick={() => onMove(index, -1)}
          />
          <Button
            size="small"
            icon={<ArrowDownOutlined />}
            title="Ниже"
            aria-label={`Опустить ${item.displayNumber}`}
            disabled={index === total - 1 || busy}
            onClick={() => onMove(index, 1)}
          />
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            // Линейный день со стороны рейса снимается, но не добавляется (ADR 0100 решение 8):
            // «убрать заявку» о нём неправда — заявка остаётся, уходит один её день.
            title={item.workDate ? 'Снять день с рейса' : 'Убрать из маршрута'}
            aria-label={`Убрать ${item.displayNumber}`}
            disabled={busy}
            onClick={onDetach}
          />
        </Space>
      )}
    </div>
  );
}

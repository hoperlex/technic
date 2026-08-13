import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Form, Input, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  routeRequestCapacity,
  shiftDateKey,
  type VehicleRouteDto,
  type VehicleRouteRequestDto,
  WAYBILL_CORRECTION_CONFIRM,
} from '@technic/contracts';
import { vehicleRoutesApi } from '../../api/resources';
import { garageKeys } from '@entities/garage';
import { AutoSelect, FormGrid, FormModal } from '@shared/ui';
import { errorMessage } from '../../utils/format';
import { formatDateOnly } from './shared';

/**
 * Перенос заявки между рейсами прошедших дней (ADR 0101 п. 14, Р30): «оформили средой, а ехали
 * вторником».
 *
 * Отдельное окно от обычного переноса (`VehicleRouteTransferModal`), и не ради удобства, а потому
 * что цена действий разная. Обычный перенос двигает **план**: рейсы ещё не стали документами, и
 * стоит он ничего. Здесь оба рейса уже отработали и оба выписали бумагу — перенос списывает **два**
 * номера строгой отчётности и выписывает взамен два новых из хвоста серии (Р10). Поэтому окно
 * обязано назвать оба сгорающих номера **до** нажатия (§5 п. 2 плана), спросить причину и объяснить,
 * что заявка поедет машиной приёмника.
 *
 * Последствия и блокировки считает сервер тем же чтением, каким их показывает окно коррекции рейса
 * (`GET /vehicle-routes/:id/correction`) — по разу на каждую сторону. Второй расчёт в портале
 * разошёлся бы с первым, и окно обещало бы не то, что произойдёт.
 */

/** Сколько дней вокруг дня источника предлагать в приёмники. */
const NEIGHBOURHOOD_DAYS = 7;

interface Props {
  /** Рейс-источник; `null` — окно закрыто. */
  route: VehicleRouteDto | null;
  /** Переносимый талон источника. */
  request: VehicleRouteRequestDto | null;
  onClose: () => void;
  /** Перенос удался: обе стороны пришли из ответа — списки и карточки после этого не те же. */
  onDone: (result: { target: VehicleRouteDto; source: VehicleRouteDto }) => void;
}

export function VehicleRouteTransferCorrectionModal({ route, request, onClose, onDone }: Props) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<{ routeId?: string; reason: string }>();
  const targetId = Form.useWatch('routeId', form);

  /**
   * Ключ идемпотентности (Р31) и версии обоих рейсов фиксируются на **открытие** окна, а не на
   * попытку отправки. Отпечаток команды сервер считает со всего тела целиком, включая версии:
   * повтор после обрыва связи обязан прислать ровно то, что прислал в первый раз, — тело,
   * пересобранное со свежей версией, это уже другая команда, и ответом на неё будет 409, а не
   * прежний результат.
   */
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    if (!route) return;
    setOperationId(crypto.randomUUID());
    form.setFieldsValue({ routeId: undefined, reason: '' });
    // Зависимости — только идентификаторы рейса и заявки: следи эффект за объектами целиком, ключ
    // операции перескакивал бы на каждом обновлении карточки, а он обязан держаться неизменным всё
    // время, пока окно открыто (иначе повтор ушёл бы под новым ключом и сжёг вторую пару номеров).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route?.id, request?.requestId, form]);

  /**
   * Куда переносить: рейсы соседних дней. Окно недели с обеих сторон — это и есть предмет операции
   * («ехали не тем днём, каким оформили»), а весь журнал рейсов в выпадающем списке был бы не
   * подсказкой, а вторым списком рейсов. Свободная строка задания не фильтруется сервером: сколько
   * их у бланка, решает его форма (ADR 0068), и считает это портал тем же правилом.
   */
  const { data: candidates, isFetching } = useQuery({
    queryKey: ['vehicle-routes', 'transfer-correction', route?.id],
    queryFn: () =>
      vehicleRoutesApi.list({
        dateFrom: shiftDateKey(route!.routeDate, -NEIGHBOURHOOD_DAYS),
        dateTo: shiftDateKey(route!.routeDate, NEIGHBOURHOOD_DAYS),
        page: 1,
        pageSize: 200,
        sortBy: 'routeDate',
        sortOrder: 'asc',
      }),
    enabled: !!route,
  });

  const options = useMemo(
    () =>
      (candidates?.items ?? []).filter(
        (r: VehicleRouteDto) =>
          r.id !== route?.id &&
          // Перегон талонов заказчиков не несёт: там едет одна заявка-основание (ADR 0057).
          r.purpose === 'freight' &&
          r.requests.length < routeRequestCapacity(r.formCode),
      ),
    [candidates, route?.id],
  );
  const target = options.find((r) => r.id === targetId) ?? null;

  /*
   * Цена операции — с обеих сторон и тем же чтением, что у окна коррекции рейса. Спрашивается по
   * рейсу, а не одним запросом на пару: правила коррекции считаются для каждого рейса отдельно (у
   * них разные дни, а значит и разная глубина, Р37), и одна ручка на две стороны означала бы третий
   * набор тех же правил.
   */
  const sourcePreview = useQuery({
    queryKey: ['vehicle-routes', route?.id, 'correction'],
    queryFn: () => vehicleRoutesApi.correctionPreview(route!.id),
    enabled: !!route,
  });
  const targetPreview = useQuery({
    queryKey: ['vehicle-routes', targetId, 'correction'],
    queryFn: () => vehicleRoutesApi.correctionPreview(targetId!),
    enabled: !!targetId,
  });

  /** Что мешает переносу здесь и сейчас: отказать может любая из сторон (Р3, Р13, Р37). */
  const blocking = sourcePreview.data?.blocking ?? targetPreview.data?.blocking ?? null;
  /** Источник опустеет — второго листа ему не выпишут (Р22), и сказать это надо до нажатия. */
  const emptiesSource = (sourcePreview.data?.requests.length ?? 0) <= 1;

  const transfer = useMutation({
    mutationFn: (reason: string) =>
      vehicleRoutesApi.transferCorrection(target!.id, {
        operationId,
        version: target!.version,
        // Источник — парой «кто + версия»: версии нумеруются в каждом рейсе отдельно, и сервер
        // сверяет обе, потому что жжёт оба номера.
        source: { routeId: route!.id, version: route!.version },
        requestId: request!.requestId,
        reason,
      }),
    onSuccess: async (result) => {
      message.success(
        `${request!.displayNumber} перенесена в ${result.target.displayNumber}: выписан лист ${
          result.target.waybill?.number ?? ''
        }`,
      );
      qc.setQueryData(['vehicle-routes', result.target.id], result.target);
      qc.setQueryData(['vehicle-routes', result.source.id], result.source);
      // Журнал листов, заявки и гараж после переноса показывают другое: два списанных номера, новые
      // номера и другую машину дня.
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['waybills'] }),
        qc.invalidateQueries({ queryKey: ['vehicle-requests'] }),
        qc.invalidateQueries({ queryKey: garageKeys.root }),
      ]);
      onDone(result);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const submit = (v: { routeId?: string; reason: string }) => {
    if (!v.routeId) {
      message.error('Выберите рейс-приёмник');
      return;
    }
    if (blocking) {
      message.error(blocking.reason);
      return;
    }
    transfer.mutate(v.reason);
  };

  return (
    <FormModal
      title={
        request && route
          ? `${request.displayNumber} · перенести из ${route.displayNumber} задним числом`
          : 'Перенос между рейсами'
      }
      open={!!route && !!request}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={transfer.isPending}
      okText="Перенести и перевыписать листы"
      okDanger
      width={640}
    >
      <Form form={form} layout="vertical" onFinish={submit}>
        <FormGrid>
          {/* Отказ любой из сторон (Р3, Р13): состав обоих рейсов обязан быть в работе, потому что
            новые листы печатают задание по всему составу. Чинит это другой человек — окно называет
            какой. */}
          {blocking && (
            <FormGrid.Full>
              <Alert
                type="error"
                showIcon
                message="Перенести сейчас нельзя"
                description={
                  <>
                    {blocking.reason}
                    {blocking.requests.length > 0 && (
                      <div>Заявки: {blocking.requests.join(', ')}</div>
                    )}
                  </>
                }
              />
            </FormGrid.Full>
          )}

          <FormGrid.Full>
            <Form.Item
              name="routeId"
              label="Рейс-приёмник"
              rules={[{ required: true, message: 'Выберите рейс' }]}
              extra={`Рейсы за ${NEIGHBOURHOOD_DAYS} дней вокруг ${
                route ? formatDateOnly(route.routeDate) : 'дня источника'
              } со свободной строкой задания`}
            >
              <AutoSelect
                autoSelectSole={false}
                options={options.map((r) => ({
                  value: r.id,
                  label: [
                    formatDateOnly(r.routeDate),
                    r.displayNumber,
                    r.vehicleLabel,
                    r.driverName || 'водитель не назначен',
                    `${r.requests.length} из ${routeRequestCapacity(r.formCode)} заявок`,
                    // Номер листа приёмника — часть цены: он сгорит вместе с номером источника.
                    r.waybill && r.waybill.status !== 'cancelled'
                      ? `лист ${r.waybill.number}`
                      : 'листа нет',
                  ]
                    .filter(Boolean)
                    .join(' · '),
                }))}
                showSearch
                optionFilterProp="label"
                loading={isFetching}
                disabled={options.length === 0}
                placeholder={
                  options.length > 0 ? 'Куда ехала на самом деле' : 'Подходящих рейсов рядом нет'
                }
              />
            </Form.Item>
          </FormGrid.Full>

          {/* Оба сгорающих номера — до нажатия (§5 п. 2 плана). Пока приёмник не выбран, названа
            половина цены, и это честнее, чем молчать: номер источника сгорит в любом случае. */}
          <FormGrid.Full>
            <Alert
              type="warning"
              showIcon
              message="Что произойдёт с двумя рейсами"
              description={
                <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                  <li>
                    {sourcePreview.data?.waybill
                      ? `Номер ${sourcePreview.data.waybill.number} рейса ${route?.displayNumber} будет аннулирован.`
                      : `У рейса ${route?.displayNumber ?? ''} действующего листа нет — аннулировать нечего.`}{' '}
                    {emptiesSource
                      ? 'Этот талон в нём последний: рейс останется пустым, и второй лист на него не выпишется.'
                      : 'Взамен выпишется следующий по серии — уже без этого талона.'}
                  </li>
                  <li>
                    {target
                      ? targetPreview.data?.waybill
                        ? `Номер ${targetPreview.data.waybill.number} рейса ${target.displayNumber} будет аннулирован, взамен выпишется следующий по серии — с этим талоном.`
                        : `У рейса ${target.displayNumber} действующего листа нет — коррекция выпишет новый номер с этим талоном.`
                      : 'Выберите приёмник — его номер сгорит вторым.'}
                  </li>
                  {target && target.vehicleId !== route?.vehicleId && (
                    <li>
                      {request?.displayNumber} поедет машиной приёмника — {target.vehicleLabel}:
                      рейс источник истины о том, чем едут. Ставка останется прежней, о ней
                      договариваются по заявке.
                    </li>
                  )}
                  {target && target.routeDate !== route?.routeDate && (
                    <li>
                      День рейса сменится с {formatDateOnly(route!.routeDate)} на{' '}
                      {formatDateOnly(target.routeDate)}. Дата подачи самой заявки останется прежней
                      — её правят в карточке заявки, отдельной причиной.
                    </li>
                  )}
                  <li>{WAYBILL_CORRECTION_CONFIRM}</li>
                </ul>
              }
            />
          </FormGrid.Full>

          {/* Причина обязательна: она уходит в запись операции и печатается во все четыре листа —
            в оба списанных как причина аннулирования, в оба новых как причина коррекции (Р16, Р35). */}
          <FormGrid.Full>
            <Form.Item
              name="reason"
              label="Причина переноса"
              rules={[{ required: true, message: 'Укажите причину' }]}
              extra="Останется в журнале коррекций и в листах обоих рейсов"
            >
              <Input.TextArea
                rows={2}
                maxLength={2000}
                showCount
                placeholder="Например: заявку оформили средой, а машина отработала её во вторник"
              />
            </Form.Item>
          </FormGrid.Full>

          <FormGrid.Full>
            <Typography.Text type="secondary">
              Талон встанет в приёмнике последним. Порядок строк задания правится коррекцией самого
              рейса — «Исправить исполнение».
            </Typography.Text>
          </FormGrid.Full>
        </FormGrid>
      </Form>
    </FormModal>
  );
}

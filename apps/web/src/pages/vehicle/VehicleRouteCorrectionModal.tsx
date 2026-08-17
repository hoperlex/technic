import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Checkbox, Form, Input, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DRIVER_CATEGORY_MISMATCH_HINT,
  DRIVER_WORKED_ON_VEHICLE_HINT,
  driverDocumentGapsHint,
  driverWorkedOnVehicle,
  isRelocationPurpose,
  vehicleLabel,
  type VehicleDto,
  type VehicleRouteDto,
  vehicleStatusLabels,
  WAYBILL_CORRECTION_CONFIRM,
} from '@technic/contracts';
import { driversApi, vehicleRoutesApi, vehiclesApi, waybillsApi } from '../../api/resources';
import { garageKeys } from '@entities/garage';
import { AutoSelect, FormGrid, FormModal } from '@shared/ui';
import { errorMessage, formatDateTime } from '../../utils/format';
import { formatDateOnly } from './shared';

/**
 * Исправление исполнения рейса задним числом (ADR 0101, Р2).
 *
 * Окно правки и окно коррекции — разные окна, и это не удобство, а разная цена действия. Правка
 * меняет план: рейс ещё не стал документом, и стоит она ничего. Коррекция переписывает **уже
 * состоявшийся день**: действующий номер бланка сгорает, взамен уходит следующий по серии (Р10),
 * назначения заявок едут за машиной рейса, подписи объекта под днями снимаются (Р5), а подшитые к
 * старому листу файлы на новый не переезжают (Р34). Поэтому здесь обязательна причина и поэтому же
 * всё перечисленное человек читает **до** нажатия, а не узнаёт после (Р18, Р36).
 *
 * Последствия считает сервер тем же кодом, которым будет их исполнять
 * (`GET /vehicle-routes/:id/correction`): второй расчёт в портале разошёлся бы с первым — и окно
 * обещало бы не то, что произойдёт.
 */

interface FormValues {
  vehicleId: string;
  driverPersonId: string;
  withTrailer: boolean;
  trailer1Model: string;
  trailer1RegNumber: string;
  garageNumber: string;
  communicationKind: string;
  transportationKind: string;
  reason: string;
}

interface Props {
  /** null — окно закрыто. */
  route: VehicleRouteDto | null;
  onClose: () => void;
  /**
   * Рейс переписан: списки рейсов, заявок и журнал листов после этого не те же.
   *
   * С точками: коррекция пересобирает рейс целиком, и карточка кладёт ответ в кэш как есть — без
   * порядка объезда она показала бы пустой список остановок до следующей перечитки.
   */
  onSaved: (route: VehicleRouteDto) => void;
}

export function VehicleRouteCorrectionModal({ route, onClose, onSaved }: Props) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<FormValues>();

  /**
   * Ключ идемпотентности (Р31): придумывается **до** отправки и держится всё время, пока открыто
   * окно. Повтор после сетевого таймаута обязан вернуть результат прежней операции, а не сжечь
   * второй номер серии; поэтому же повторная отправка идёт тем же телом — отпечаток считается со
   * всей команды целиком, и пересобранное со свежей версией тело сервер повтором не признает.
   */
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    if (!route) return;
    setOperationId(crypto.randomUUID());
    form.setFieldsValue({
      vehicleId: route.vehicleId,
      driverPersonId: route.driverPersonId ?? undefined,
      withTrailer: route.withTrailer,
      trailer1Model: route.trailer1Model,
      trailer1RegNumber: route.trailer1RegNumber,
      garageNumber: route.garageNumber,
      communicationKind: route.communicationKind,
      transportationKind: route.transportationKind,
      reason: '',
    });
    // Зависимость — только идентификатор рейса: следи эффект за `route` целиком, ключ операции и
    // черновик формы перескакивали бы под рукой на каждом обновлении карточки, а ключ обязан
    // держаться неизменным всё время, пока окно открыто.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route?.id, form]);

  const vehicleId = Form.useWatch('vehicleId', form) ?? route?.vehicleId;
  const driverPersonId = Form.useWatch('driverPersonId', form);
  const withTrailer = Form.useWatch('withTrailer', form) ?? false;

  /** Последствия и блокировки — сервером, теми же правилами, которыми он их и исполнит. */
  const { data: preview, isFetching: previewLoading } = useQuery({
    queryKey: ['vehicle-routes', route?.id, 'correction'],
    queryFn: () => vehicleRoutesApi.correctionPreview(route!.id),
    enabled: !!route,
  });

  /**
   * Карточка действующего листа: отметки печати и выгрузки (Р18) и подшитые к номеру файлы (Р34).
   * Берутся из журнала, а не считаются заново: «уходила ли бумага» — вопрос журнала, и два разных
   * ответа на него хуже одного.
   */
  const { data: sheet } = useQuery({
    queryKey: ['waybills', preview?.waybill?.id],
    queryFn: () => waybillsApi.get(preview!.waybill!.id),
    enabled: !!preview?.waybill,
  });

  /**
   * Парк целиком, включая списанную и стоящую в ремонте технику (Р17): истории статусов у машины
   * нет, а исправляют задним числом как раз ту единицу, которую с тех пор списали. Состояние
   * названо в строке выбора — «поехала машина, которой сегодня нет в строю» человек должен видеть.
   */
  const { data: fleet, isFetching: fleetLoading } = useQuery({
    queryKey: ['vehicles', 'own', 'correction'],
    queryFn: () =>
      vehiclesApi.list({
        ownership: 'own',
        page: 1,
        pageSize: 500,
        sortBy: 'registrationNumber',
        sortOrder: 'asc',
      }),
    enabled: !!route,
  });

  const vehicleOptions = useMemo(
    () =>
      (fleet?.items ?? []).map((v: VehicleDto) => ({
        value: v.id,
        label: [
          vehicleLabel(v),
          v.modelName,
          v.status === 'active' ? null : vehicleStatusLabels[v.status].toLowerCase(),
        ]
          .filter((s): s is string => !!s)
          .join(' · '),
      })),
    [fleet],
  );

  /**
   * Кто мог сесть за эту машину **в день рейса**: отбор исторический (ADR 0101 п. 15), и уволенный
   * после рейса человек из списка не пропадает — иначе лист за прошлую неделю нельзя было бы
   * выписать на того, кто её и отработал.
   */
  const { data: selection, isFetching: driversLoading } = useQuery({
    queryKey: ['drivers', 'available', vehicleId, route?.routeDate, withTrailer],
    queryFn: () =>
      driversApi.available({ vehicleId: vehicleId!, on: route!.routeDate, withTrailer }),
    enabled: !!route && !!vehicleId,
  });

  const driverOptions = (selection?.drivers ?? []).map((d) => ({
    value: d.personId,
    label: [
      d.fullName,
      d.categories.join(', '),
      driverDocumentGapsHint(d.gaps, d.credentialTypeCode),
      d.matchesRequiredCategory ? null : DRIVER_CATEGORY_MISMATCH_HINT,
      driverWorkedOnVehicle(d) ? DRIVER_WORKED_ON_VEHICLE_HINT : null,
    ]
      .filter(Boolean)
      .join(' · '),
  }));

  const correct = useMutation({
    mutationFn: (v: FormValues) =>
      vehicleRoutesApi.correct(route!.id, {
        operationId,
        version: route!.version,
        vehicleId: v.vehicleId,
        driverPersonId: v.driverPersonId,
        trip: {
          withTrailer: v.withTrailer,
          // Реквизиты прицепа уходят только вместе с самим прицепом: без него сервер их не примет.
          trailer1Model: v.withTrailer ? (v.trailer1Model ?? '') : '',
          trailer1RegNumber: v.withTrailer ? (v.trailer1RegNumber ?? '') : '',
          trailer2Model: '',
          trailer2RegNumber: '',
          garageNumber: v.garageNumber ?? '',
          communicationKind: v.communicationKind ?? '',
          transportationKind: v.transportationKind ?? '',
        },
        reason: v.reason,
      }),
    onSuccess: async (updated) => {
      message.success(`Рейс исправлен, выписан лист ${updated.waybill?.number ?? ''}`);
      qc.setQueryData(['vehicle-routes', updated.id], updated);
      // Журнал листов и гараж после коррекции показывают другое: там списанный номер, новый номер
      // и другая машина дня.
      await qc.invalidateQueries({ queryKey: ['waybills'] });
      await qc.invalidateQueries({ queryKey: garageKeys.root });
      onSaved(updated);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  /** Меняет ли форма хоть что-то (Р31): тело, повторяющее рейс, сожгло бы номер впустую. */
  const changed =
    !!route &&
    (vehicleId !== route.vehicleId ||
      (driverPersonId ?? null) !== route.driverPersonId ||
      withTrailer !== route.withTrailer ||
      (form.getFieldValue('garageNumber') ?? '') !== route.garageNumber ||
      (form.getFieldValue('communicationKind') ?? '') !== route.communicationKind ||
      (form.getFieldValue('transportationKind') ?? '') !== route.transportationKind);

  const submit = (v: FormValues) => {
    if (preview?.blocking) {
      message.error(preview.blocking.reason);
      return;
    }
    if (!changed) {
      message.error('Коррекция должна что-то менять: иначе номер бланка сгорит впустую');
      return;
    }
    correct.mutate(v);
  };

  /** Заявки, у которых коррекция перепишет назначение: линейные дни в их число не входят. */
  const reassigned = (preview?.requests ?? []).filter(
    (r) => r.workDate === null && r.assignedVehicleId !== vehicleId,
  );
  const linearDays = (preview?.requests ?? []).filter((r) => r.workDate !== null);

  return (
    <FormModal
      title={route ? `Маршрут ${route.displayNumber} · исправить исполнение` : 'Коррекция рейса'}
      open={!!route}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={correct.isPending}
      okText="Исправить и выписать лист"
      okDanger
      width={720}
    >
      <Form<FormValues> form={form} layout="vertical" onFinish={submit}>
        <FormGrid>
          {/* Блокировка состава (Р3, Р13) читается первой: с закрытой или новой заявкой в рейсе
            коррекция невозможна, и чинит это другой человек — окно называет, какой именно. */}
          {preview?.blocking && (
            <FormGrid.Full>
              <Alert
                type="error"
                showIcon
                message="Рейс сейчас не исправить"
                description={
                  <>
                    {preview.blocking.reason}
                    {preview.blocking.requests.length > 0 && (
                      <div>Заявки: {preview.blocking.requests.join(', ')}</div>
                    )}
                  </>
                }
              />
            </FormGrid.Full>
          )}

          <FormGrid.Full>
            <Alert
              type="warning"
              showIcon
              message={`Что произойдёт с рейсом за ${route ? formatDateOnly(route.routeDate) : ''}`}
              description={
                <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                  <li>
                    {preview?.waybill
                      ? `Номер ${preview.waybill.number} будет аннулирован, взамен выпишется следующий по серии.`
                      : 'Действующего листа у рейса нет — коррекция выпишет новый номер.'}
                  </li>
                  {reassigned.length > 0 && (
                    <li>
                      Машину сменят заявки: {reassigned.map((r) => r.displayNumber).join(', ')} —
                      рейс источник истины о том, чем едут; ставки при этом не трогаются.
                    </li>
                  )}
                  {/* Линейный день (ADR 0100 п. 4): машина дня это машина рейса, а назначение
                    заказа отвечает за весь его срок и остаётся прежним. Сказать это нужно там же,
                    где перечислены сменившие машину, — иначе список прочтётся и про дни. */}
                  {linearDays.length > 0 && (
                    <li>
                      Дни линейных заказов ({linearDays.map((r) => r.displayNumber).join(', ')})
                      поедут машиной рейса. Назначение самих заказов не меняется — его правят в
                      карточке заявки.
                    </li>
                  )}
                  {(preview?.shifts ?? []).map((s) => (
                    <li key={`${s.requestId}@${s.date}`}>
                      Снимется подпись смены {s.displayNumber} за {formatDateOnly(s.date)}
                      {s.approvedByName ? ` (принял ${s.approvedByName})` : ''} — часы останутся,
                      подтвердить их придётся заново.
                    </li>
                  ))}
                  {sheet?.printedAt && (
                    <li>Лист уже печатали {formatDateTime(sheet.printedAt)}.</li>
                  )}
                  {sheet?.exportedAt && (
                    <li>Лист уже выгружали файлом {formatDateTime(sheet.exportedAt)}.</li>
                  )}
                  {(sheet?.files.length ?? 0) > 0 && (
                    <li>
                      К старому листу подшито файлов: {sheet!.files.length} — на новый номер они не
                      переедут, переподшейте вручную.
                    </li>
                  )}
                  <li>{WAYBILL_CORRECTION_CONFIRM}</li>
                </ul>
              }
            />
          </FormGrid.Full>

          {/* Машина правится только здесь (ADR 0082 п. 5 в редакции ADR 0101): «поедет другой
            машиной» в будущем это другое назначение, а в прошедшем дне рейс состоялся один. */}
          <Form.Item
            name="vehicleId"
            label="Машина рейса"
            rules={[{ required: true, message: 'Выберите машину' }]}
            extra="Списанная и стоящая в ремонте техника в списке есть: она могла работать в тот день"
          >
            <AutoSelect
              autoSelectSole={false}
              options={vehicleOptions}
              showSearch
              optionFilterProp="label"
              loading={fleetLoading}
              placeholder="Чем ехали на самом деле"
            />
          </Form.Item>

          <Form.Item
            name="driverPersonId"
            label="Водитель"
            rules={[{ required: true, message: 'Выберите водителя' }]}
            extra="Список — на день рейса: уволившийся после него из выбора не пропадает"
          >
            <AutoSelect
              autoSelectSole={false}
              options={driverOptions}
              showSearch
              optionFilterProp="label"
              loading={driversLoading}
              placeholder="Кто вёл на самом деле"
            />
          </Form.Item>

          {/* У формы № 3 граф прицепа нет вовсе (ADR 0071) — спрашивается он там, где печатается. */}
          {route?.formCode !== 'leg3' && (
            <>
              <FormGrid.Full>
                <Form.Item name="withTrailer" valuePropName="checked">
                  <Checkbox>Рейс был с прицепом</Checkbox>
                </Form.Item>
              </FormGrid.Full>
              {withTrailer && (
                <>
                  <Form.Item name="trailer1Model" label="Прицеп: марка">
                    <Input placeholder="СЗАП-8551" />
                  </Form.Item>
                  <Form.Item name="trailer1RegNumber" label="Прицеп: госномер">
                    <Input placeholder="АВ1234 77" />
                  </Form.Item>
                </>
              )}
            </>
          )}

          <Form.Item name="garageNumber" label="Гаражный номер">
            <Input placeholder="Из справочника техники, если пусто" />
          </Form.Item>
          <Form.Item name="communicationKind" label="Вид сообщения">
            <Input placeholder="городское" />
          </Form.Item>
          <Form.Item name="transportationKind" label="Вид перевозки">
            <Input placeholder="коммерческая" />
          </Form.Item>

          {/* Причина обязательна: она уходит в запись операции, в причину аннулирования старого
            листа и в новый лист (Р16, Р35) — и через два месяца отвечает на вопрос, почему за один
            день в журнале два номера. */}
          <FormGrid.Full>
            <Form.Item
              name="reason"
              label="Причина коррекции"
              rules={[{ required: true, message: 'Укажите причину' }]}
              extra="Останется в журнале, в аннулированном листе и в новом"
            >
              <Input.TextArea
                rows={2}
                maxLength={2000}
                placeholder="На рейс выехала другая машина: ТС-341 в ремонте"
              />
            </Form.Item>
          </FormGrid.Full>

          {route && isRelocationPurpose(route.purpose) && (
            <FormGrid.Full>
              <Typography.Text type="secondary">
                Это перегон техники: состава у него нет, и назначение заявки коррекция не трогает —
                машину заказа правят в его карточке.
              </Typography.Text>
            </FormGrid.Full>
          )}
          {previewLoading && (
            <FormGrid.Full>
              <Typography.Text type="secondary">Считаем последствия…</Typography.Text>
            </FormGrid.Full>
          )}
        </FormGrid>
      </Form>
    </FormModal>
  );
}

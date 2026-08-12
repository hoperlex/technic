import { useEffect, useMemo, useRef } from 'react';
import { App, Form, Typography } from 'antd';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  assignmentTitle,
  DRIVER_CATEGORY_MISMATCH_HINT,
  DRIVER_WORKED_ON_VEHICLE_HINT,
  driverDocumentGapsHint,
  driverWorkedOnVehicle,
  isRelocationPurpose,
  isRouteEditable,
  type PlanVehicleRequestDayBody,
  routeRequestCapacity,
  type SpecialEquipmentRequestDto,
  type VehicleDto,
  type VehicleRequestDaysDto,
  vehicleLabel,
} from '@technic/contracts';
import { driversApi, vehicleRequestsApi, vehicleRoutesApi, vehiclesApi } from '../../api/resources';
import { AutoSelect, FormGrid, FormModal, useFormBlockers } from '@shared/ui';
import { errorMessage } from '../../utils/format';
import { formatDateOnly } from './shared';

/**
 * Поставить день линейного заказа в рейс (ADR 0100 решение 8).
 *
 * День и объект известны до открытия окна: день — это строка таблицы «Дни работ», объект — сам
 * заказ. Спрашиваются ровно две вещи, которыми дни и отличаются друг от друга, — **какая машина
 * выходит и кто на ней**: пачка «распланировать неделю» умеет лишь повторить один выбор, а на
 * разные дни выезжают разные единицы и разные люди.
 *
 * Уже заведённый рейс этой машины на этот день предлагается первым и стоит умолчанием (план У13).
 * Без этого второй объект того же дня уехал бы новым маршрутом и новым бланком, тогда как в 4-П
 * семь строк задания (ADR 0068) — ровно затем, чтобы день машины помещался в один лист.
 *
 * Своим файлом, а не блоком таблицы дней: окно с формой, тремя запросами и мутацией —
 * самостоятельная вещь, как и соседняя выписка ЭСМ-2 по требованию.
 */

/** Выбор «завести новый маршрут»: значением поля, как и в форме перевода в работу. */
const NEW_ROUTE = 'new';

/** Собственный действующий парк — тот же список, из которого выписывают ЭСМ-2 по требованию. */
const FLEET_KEY = ['vehicles', 'linear-day'];

/**
 * Рейсы машины на день и графы шапки её прошлого рейса. Ключ той же формы, что в форме перевода в
 * работу: подсказка одна и та же, и второй раз тянуть её с сервера незачем.
 */
const suggestKey = (vehicleId: string | undefined, date: string) => [
  'vehicle-routes',
  'suggest',
  vehicleId,
  date,
];

/** Кто может сесть за эту машину в этот день — тем же ключом, что и при переводе в работу. */
const driversKey = (vehicleId: string | undefined, date: string) => [
  'drivers',
  'available',
  vehicleId,
  date,
  false,
];

interface Props {
  /**
   * Заявка и день, который ставят в рейс; `null` — окно закрыто. Заявка должна быть линейной, в
   * работе и на собственной машине — это проверила таблица дней правилом `canPlanDay`.
   */
  target: { request: SpecialEquipmentRequestDto; date: string } | null;
  onClose: () => void;
  /** План после планирования: таблицу дней ведёт вызывающий — он же владеет её кэшем. */
  onDone: (days: VehicleRequestDaysDto) => void;
}

interface FormValues {
  vehicleId?: string;
  /** Идентификатор готового рейса либо `NEW_ROUTE`. */
  routeId?: string;
  driverPersonId?: string;
}

export function VehicleDayRouteModal({ target, onClose, onDone }: Props) {
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const blockers = useFormBlockers(form);
  const request = target?.request ?? null;
  const date = target?.date ?? '';

  const vehicleId = Form.useWatch('vehicleId', form);
  const routeId = Form.useWatch('routeId', form);

  /**
   * Рейс выбран руками — подстановка его больше не трогает. Признак взводится первым же изменением
   * поля, а сбрасывается сменой дня и сменой машины: у другой единицы рейсы свои.
   */
  const routeTouched = useRef(false);

  /**
   * Поля сбрасываются при смене дня, а не при размонтировании: окно переиспользуется под соседние
   * дни срока, и оставшийся от вторника водитель читался бы как решение по среде.
   *
   * Машина подставляется назначенная — у линейного заказа это машина по умолчанию (ADR 0100
   * решение 4), ею закрывают большинство дней. Водитель не подставляется никогда (ADR 0083).
   */
  useEffect(() => {
    if (!target) return;
    routeTouched.current = false;
    form.setFieldsValue({
      vehicleId: target.request.assignment?.vehicleId,
      routeId: NEW_ROUTE,
      driverPersonId: undefined,
    });
  }, [target?.request.id, target?.date]);

  /**
   * Собственная техника парка: в рейс ходит только она — лист на арендную выписывает арендодатель.
   * Парк целиком, а не единицы заказанного типа: расхождение машины дня с назначением законно и
   * помечается, а не запрещается (ADR 0100 решение 4), — ради него признак и заведён.
   */
  const { data: fleet, isFetching: fleetLoading } = useQuery({
    queryKey: FLEET_KEY,
    queryFn: () =>
      vehiclesApi.list({
        status: 'active',
        ownership: 'own',
        page: 1,
        pageSize: 500,
        sortBy: 'registrationNumber',
        sortOrder: 'asc',
      }),
    enabled: !!target,
  });

  const vehicleOptions = useMemo(() => {
    const options = (fleet?.items ?? [])
      .map((v: VehicleDto) => ({
        value: v.id,
        label: [vehicleLabel(v), v.modelName, v.categoryName ?? v.typeName]
          .filter((s): s is string => !!s)
          .filter((s, i, all) => all.indexOf(s) === i)
          .join(' · '),
      }))
      .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    // Назначенная машина могла уйти из активного парка (сломалась, продана), а день ею всё равно
    // отработали. Без этой строки поле показало бы голый идентификатор.
    const assignment = request?.assignment;
    if (assignment && !options.some((o) => o.value === assignment.vehicleId)) {
      options.unshift({ value: assignment.vehicleId, label: assignmentTitle(assignment) });
    }
    return options;
  }, [fleet, request?.assignment]);

  /** Рейсы этой машины на этот день плюс графы шапки её прошлого рейса. */
  const { data: suggestion } = useQuery({
    queryKey: suggestKey(vehicleId, date),
    queryFn: () => vehicleRoutesApi.suggest({ vehicleId: vehicleId!, date }),
    enabled: !!target && !!vehicleId,
  });

  /**
   * Куда день можно положить: рейс со свободной строкой задания, не замороженный выписанным листом
   * и не перегон — у линейной техники перегона не бывает вовсе (ADR 0100 решение 9). Отбор тот же,
   * что проверит сервер: иначе список предлагал бы рейсы, которые он отклонит.
   */
  const routeOptions = (suggestion?.routes ?? []).filter(
    (r) =>
      !isRelocationPurpose(r.purpose) &&
      r.requests.length < routeRequestCapacity(r.formCode) &&
      isRouteEditable(r.waybill?.status ?? null),
  );

  /**
   * Умолчание поля «Рейс»: готовый рейс машины, если он есть. Пришедший позже ответ сервера
   * выбранное руками не переписывает — за этим и следит `routeTouched`.
   */
  useEffect(() => {
    if (routeTouched.current) return;
    form.setFieldsValue({ routeId: routeOptions[0]?.id ?? NEW_ROUTE });
  }, [suggestion?.routes]);

  /** Выбран готовый рейс: водитель и реквизиты выезда в нём уже свои, спрашивать их незачем. */
  const joined = routeOptions.find((r) => r.id === routeId) ?? null;

  /**
   * Водители на этот день — тем же отбором, что и при переводе в работу (ADR 0064): день линейной
   * машины печатается обычным 4-П, а в нём графы удостоверения и СНИЛСа. Никого из списка отбор не
   * убирает: пробелы документов помечают строку и объясняются подписью под полем.
   */
  const { data: selection, isFetching: driversLoading } = useQuery({
    queryKey: driversKey(vehicleId, date),
    queryFn: () => driversApi.available({ vehicleId: vehicleId!, on: date }),
    enabled: !!target && !!vehicleId && !joined,
  });
  const driverOptions = (selection?.drivers ?? []).map((d) => ({
    value: d.personId,
    label: [
      d.fullName,
      d.categories.join(', '),
      d.personnelNo && `таб. ${d.personnelNo}`,
      driverDocumentGapsHint(d.gaps, d.credentialTypeCode),
      d.matchesRequiredCategory ? null : DRIVER_CATEGORY_MISMATCH_HINT,
      driverWorkedOnVehicle(d) ? DRIVER_WORKED_ON_VEHICLE_HINT : null,
    ]
      .filter(Boolean)
      .join(' · '),
  }));

  const plan = useMutation({
    mutationFn: (v: FormValues) => {
      const body: PlanVehicleRequestDayBody =
        v.routeId && v.routeId !== NEW_ROUTE
          ? { routeId: v.routeId }
          : {
              newRoute: {
                vehicleId: v.vehicleId!,
                driverPersonId: v.driverPersonId ?? null,
                // Графы шапки наследуются от прошлого рейса машины — гаражный номер, вид сообщения
                // и перевозки описывают саму машину и правятся раз в сезон, а не в каждый рейс.
                // Спрашивать их у дня значило бы задавать один и тот же вопрос по разу в сутки.
                ...(suggestion?.trip ? { trip: suggestion.trip } : {}),
              },
            };
      return vehicleRequestsApi.planDay(request!.id, date, body);
    },
    onSuccess: (days) => {
      message.success(`День ${formatDateOnly(date)} поставлен в рейс`);
      onDone(days);
    },
    // Отказы сервера здесь именные — «День вне срока заявки», «день уже стоит в рейсе», — и ложатся
    // на своё поле (ADR 0094). Тост остаётся для того, у чего поля нет: гонки двух диспетчеров и
    // замороженного листом рейса.
    onError: (e) => {
      if (!blockers.fromApi(e)) message.error(errorMessage(e));
    },
  });

  return (
    <FormModal
      title={target ? `День ${formatDateOnly(date)} в рейс` : 'День в рейс'}
      open={!!target}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={plan.isPending}
      okText="Поставить в рейс"
      width={640}
    >
      <Form<FormValues>
        form={form}
        layout="vertical"
        onFinish={(v) => plan.mutate(v)}
        {...blockers.formProps}
      >
        <FormGrid>
          <FormGrid.Full>
            <Typography.Paragraph type="secondary">
              {request ? `Заявка ${request.displayNumber} · ${request.objectName}. ` : ''}
              День и объект уже известны — остаётся сказать, какая машина выходит и кто на ней.
              Работа дня напечатается строкой задания в путевом листе рейса.
            </Typography.Paragraph>
          </FormGrid.Full>

          {/* Машина спрашивается, а не берётся из назначения молча: у линейного заказа назначение —
            машина по умолчанию (ADR 0100 решение 4), и в конкретный день выезжает та, чьим рейсом
            день закрыт. Умолчанием стоит назначенная: ею работают чаще всего. */}
          <Form.Item
            name="vehicleId"
            label="Машина"
            rules={[{ required: true, message: 'Выберите машину' }]}
            extra="Подставлена машина заявки; на разные дни срока выходят разные единицы"
          >
            <AutoSelect
              options={vehicleOptions}
              showSearch
              optionFilterProp="label"
              loading={fleetLoading}
              placeholder="Выберите машину"
              notFoundContent="Собственной техники в работе нет"
              onChange={() => {
                // Рейсы у другой единицы свои: выбранный сбрасывается, а умолчание подставит
                // готовый рейс новой машины, как только придёт подсказка.
                routeTouched.current = false;
                form.setFieldsValue({ routeId: NEW_ROUTE, driverPersonId: undefined });
              }}
            />
          </Form.Item>

          {/* Готовый рейс машины на этот день стоит первым и умолчанием: второй объект того же дня
            должен попасть в тот же лист, пока в нём есть строки задания (ADR 0068), а не завести
            второй бланк на ту же машину и тот же день. */}
          <Form.Item
            name="routeId"
            label="Рейс"
            extra={
              routeOptions.length > 0
                ? 'У машины уже есть рейс на этот день — день встанет его строкой задания'
                : 'Рейсов этой машины на этот день нет — день заведёт новый маршрут'
            }
          >
            <AutoSelect
              options={[
                ...routeOptions.map((r) => ({
                  value: r.id,
                  label: [
                    r.displayNumber,
                    r.driverName || 'водитель не назначен',
                    `${r.requests.length} из ${routeRequestCapacity(r.formCode)} заявок`,
                  ].join(' · '),
                })),
                { value: NEW_ROUTE, label: 'Новый маршрут' },
              ]}
              showSearch
              optionFilterProp="label"
              placeholder="Выберите рейс"
              onChange={() => {
                routeTouched.current = true;
              }}
            />
          </Form.Item>

          {/* Водитель — пустым полем и необязательный, и это не забывчивость портала: рейс собирают
            заранее, человека ставят утром, а на разные дни выходят разные люди (ADR 0083). У
            готового рейса водитель уже свой — его и показываем, спрашивать второго незачем. */}
          <FormGrid.Full>
            {joined ? (
              <Form.Item label="Водитель">
                <Typography.Text type="secondary">
                  {joined.driverName
                    ? `Водитель рейса ${joined.displayNumber} — ${joined.driverName}`
                    : `В рейсе ${joined.displayNumber} водитель ещё не назначен: его ставят в карточке маршрута`}
                </Typography.Text>
              </Form.Item>
            ) : (
              <Form.Item
                name="driverPersonId"
                label="Водитель"
                extra="Необязательно: рейс собирают заранее, человека ставят утром — портал вчерашнего не подставляет"
              >
                <AutoSelect
                  autoSelectSole={false}
                  allowClear
                  options={driverOptions}
                  showSearch
                  optionFilterProp="label"
                  loading={driversLoading}
                  placeholder="Кто выходит в этот день"
                  notFoundContent="Подходящих водителей на этот день нет"
                />
              </Form.Item>
            )}
          </FormGrid.Full>
        </FormGrid>
      </Form>
    </FormModal>
  );
}

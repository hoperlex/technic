import { useEffect } from 'react';
import { App, DatePicker, Form, Input, Select, Typography } from 'antd';
import dayjs from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  communicationKindOptions,
  DEFAULT_COMMUNICATION_KIND,
  DRIVER_CATEGORY_MISMATCH_HINT,
  DRIVER_WORKED_ON_VEHICLE_HINT,
  driverDocumentGapsHint,
  driverWorkedOnVehicle,
  isRelocationPurpose,
  isRouteEditable,
  minRequestDateKey,
  moscowDateKeyOf,
  movedRouteDateKey,
  ROUTE_FROZEN_MESSAGE,
  routePurposeLabels,
  type VehicleRouteDto,
  WAYBILL_CORRECTION_DAYS,
} from '@technic/contracts';
import { driversApi, vehicleRoutesApi } from '../../api/resources';
import { vehicleRouteKeys } from '@entities/vehicle-route';
import { AutoSelect } from '@shared/ui';
import { FormGrid } from '@shared/ui';
import { FormModal } from '@shared/ui';
import { useIsMobile } from '@shared/lib';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';
import { TrailerFields, trailerTripBody } from './TrailerFields';
import { BackdateReasonField } from './VehicleBackdateFields';

/**
 * Правка рейса: день, водитель, реквизиты выезда, комментарий, а у перегона — «откуда — куда».
 *
 * До сих пор в карточке рейса менялся только состав: водителя ставили при переводе заявки в
 * работу, а перепутанный день чинили пересборкой рейса заново. Между тем правят рейс каждое утро —
 * человек заболел, машина не вышла, выезд сдвинулся на день.
 *
 * Дата переносит рейс вместе с заявками (сервер, `moveRouteToDate`): день рейса и день подачи —
 * одно и то же событие с двух сторон. Что именно переедет, окно называет до нажатия: диспетчер
 * должен видеть, что двигает не только строку рейса.
 *
 * Выписанный лист правку запрещает целиком (`isRouteEditable`): бумага уже у водителя, и запись,
 * разошедшаяся с ней, хуже отсутствия записи (ADR 0037 п. 9).
 *
 * Задним числом (ADR 0101 п. 4 и 6, Р29) окно спрашивает причину **только за дату**. Водитель,
 * реквизиты и комментарий прошлого рейса правятся как правились: пока листа нет, рейс —
 * планировочная запись, и права за её правку не спрашивает и сервер. Перенос дня — другое: вместе
 * с рейсом переезжает подача его заявок, то есть двигается календарь заказчика. Правило одно с
 * сервером (`movedRouteDateKey` плюс `minRequestDateKey`), потому что расходиться им нельзя: форма
 * не должна ни просить причину там, где ручка её не ждёт, ни отправлять то, чему ответят 403.
 */

const DATE = 'YYYY-MM-DD';

interface FormValues {
  routeDate: dayjs.Dayjs;
  driverPersonId?: string | null;
  withTrailer: boolean;
  trailer1Model: string;
  trailer1RegNumber: string;
  trailer2Model: string;
  trailer2RegNumber: string;
  garageNumber: string;
  communicationKind: string;
  transportationKind: string;
  comment: string;
  moveFrom?: string;
  moveTo?: string;
  /** Причина переноса дня в прошлое: спрашивается ровно тогда, когда её спросит сервер. */
  reason?: string;
}

interface Props {
  /** null — окно закрыто. */
  route: VehicleRouteDto | null;
  onClose: () => void;
  /** Рейс изменился: списки маршрутов и заявок после этого не те же. */
  onSaved: (route: VehicleRouteDto) => void;
}

export function VehicleRouteEditModal({ route, onClose, onSaved }: Props) {
  const { message, modal } = App.useApp();
  const isMobile = useIsMobile();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [form] = Form.useForm<FormValues>();
  const relocation = !!route && isRelocationPurpose(route.purpose);

  useEffect(() => {
    if (!route) return;
    form.setFieldsValue({
      reason: '',
      routeDate: dayjs(route.routeDate),
      driverPersonId: route.driverPersonId ?? undefined,
      withTrailer: route.withTrailer,
      trailer1Model: route.trailer1Model,
      trailer1RegNumber: route.trailer1RegNumber,
      trailer2Model: route.trailer2Model,
      trailer2RegNumber: route.trailer2RegNumber,
      garageNumber: route.garageNumber,
      // Пустая графа рейса открывается умолчанием: поле стало обязательным, и рейс, заведённый до
      // списка, иначе не дал бы сохранить ни смену водителя, ни перенос дня, пока кто-то не
      // выберет вид сообщения руками. Подставлять здесь нечем рисковать: листа у правимого рейса
      // нет вовсе (`isRouteEditable`), бумаги с пустой графой на руках тоже — переписать нечего.
      communicationKind: route.communicationKind || DEFAULT_COMMUNICATION_KIND,
      transportationKind: route.transportationKind,
      comment: route.comment,
      moveFrom: route.moveFrom,
      moveTo: route.moveTo,
    });
    // Зависимость — сам рейс: перерисовка после сохранения приходит новым объектом с новыми
    // значениями, и поля обязаны встать на них.
  }, [route, form]);

  const routeDate = Form.useWatch('routeDate', form);
  const withTrailer = Form.useWatch('withTrailer', form) ?? false;
  const communicationKind = Form.useWatch('communicationKind', form);
  const on = (routeDate ?? (route ? dayjs(route.routeDate) : null))?.format(DATE);

  const today = moscowDateKeyOf(new Date());
  /** Нижняя граница календаря в трёх режимах (Р37); `null` — границы нет (`correctBeyondLimit`). */
  const backdateFloor = minRequestDateKey(undefined, {
    correct: can('waybills.correct'),
    beyondLimit: can('waybills.correctBeyondLimit'),
  });
  /**
   * Эффективная дата переноса — та же более ранняя из двух, по которой спросит право сервер.
   * `null` — день не двигают вовсе, и заднего числа в правке нет.
   */
  const movedKey = route ? movedRouteDateKey(route.routeDate, routeDate?.format(DATE)) : null;
  /** Перенос задевает прошедший день: причина обязательна и здесь, и на сервере. */
  const backdated = movedKey !== null && movedKey < today;
  /**
   * Дата заперта целиком: собственный день рейса уже за границей глубины, а более ранней из двух
   * дат он и останется — значит любой перенос сервер отклонит (403 без права, 422 за пределом).
   * Прочие поля при этом правятся: рейс без листа — планировочная запись (ADR 0101 п. 6).
   */
  const moveLocked = !!route && backdateFloor !== null && route.routeDate < backdateFloor;

  /**
   * Прицепы, закреплённые за машиной рейса (план `docs/vehicle-trailers-plan.md`, §4.2.2). Графы
   * рейса окно берёт из самого рейса, а закрепление знает только сервер — за ним и идём той же
   * подсказкой, что зовут окна заведения. Рейсы и графы прошлого рейса из ответа здесь не нужны:
   * правка описывает рейс, который уже есть.
   */
  const { data: suggestion } = useQuery({
    queryKey: vehicleRouteKeys.suggest(route?.vehicleId, on),
    queryFn: () => vehicleRoutesApi.suggest({ vehicleId: route!.vehicleId, date: on! }),
    enabled: !!route && !!on,
  });

  /**
   * Кто может сесть за эту машину в этот день. Список подсказывает — пригодные первыми, с
   * пометками о категории и документах (ADR 0064), — но сам никого не выбирает: за руль человека
   * сажает диспетчер.
   */
  const { data: selection, isFetching: driversLoading } = useQuery({
    queryKey: ['drivers', 'available', route?.vehicleId, on, withTrailer],
    queryFn: () => driversApi.available({ vehicleId: route!.vehicleId, on: on!, withTrailer }),
    enabled: !!route && !!on,
  });

  const driverOptions = (selection?.drivers ?? []).map((d) => ({
    value: d.personId,
    label: [
      d.fullName,
      d.categories.join(', '),
      // Документ подписан по должности человека (ADR 0095): «без номера ВУ» у машиниста
      // экскаватора отправило бы искать не ту бумагу.
      driverDocumentGapsHint(d.gaps, d.credentialTypeCode),
      d.matchesRequiredCategory ? null : DRIVER_CATEGORY_MISMATCH_HINT,
      driverWorkedOnVehicle(d) ? DRIVER_WORKED_ON_VEHICLE_HINT : null,
    ]
      .filter(Boolean)
      .join(' · '),
  }));

  /** Выписанный лист замораживает рейс целиком: правки отклоняет и портал, и сервер. */
  const frozen = !!route && !isRouteEditable(route.waybill?.status ?? null);

  const save = useMutation({
    mutationFn: (v: FormValues) =>
      vehicleRoutesApi.update(route!.id, {
        version: route!.version,
        routeDate: v.routeDate.format(DATE),
        driverPersonId: v.driverPersonId ?? null,
        trip: {
          ...trailerTripBody(v),
          garageNumber: v.garageNumber ?? '',
          communicationKind: v.communicationKind ?? '',
          transportationKind: v.transportationKind ?? '',
        },
        comment: v.comment ?? '',
        ...(relocation ? { moveFrom: v.moveFrom, moveTo: v.moveTo } : {}),
        // Причина уходит только с переносом в прошлое: на обычной правке сервер её не спрашивает, и
        // отправленная «на всякий случай» она означала бы задний ход там, где его нет.
        ...(backdated ? { reason: v.reason } : {}),
      }),
    onSuccess: (updated) => {
      message.success('Маршрут изменён');
      qc.setQueryData(['vehicle-routes', updated.id], updated);
      onSaved(updated);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  /**
   * Перенос дня спрашивается отдельно: вместе с рейсом переедет подача его заявок, а это уже не
   * запись в плане, а изменение того, на когда заказчик ждёт машину. Заявки называются поимённо —
   * «двигаю рейс» и «двигаю четыре чужих заказа» это разные решения.
   */
  const submit = (v: FormValues) => {
    // Заморозку проверяем и здесь: окно открывают из двух мест, и лист мог быть выписан, пока оно
    // висело открытым. Сервер откажет тем же правилом — но сказать об этом лучше до запроса.
    if (frozen) {
      message.error(ROUTE_FROZEN_MESSAGE);
      return;
    }
    const moving = !!route && v.routeDate.format(DATE) !== route.routeDate;
    const affected = route?.requests ?? [];
    if (!moving || affected.length === 0) {
      save.mutate(v);
      return;
    }
    modal.confirm({
      title: `Перенести маршрут на ${v.routeDate.format('DD.MM.YYYY')}?`,
      content: (
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          Вместе с рейсом переедет подача заявок:{' '}
          {affected.map((item) => item.displayNumber).join(', ')}. Время подачи у каждой останется
          прежним.
        </Typography.Paragraph>
      ),
      okText: 'Перенести',
      cancelText: 'Отмена',
      onOk: () => save.mutateAsync(v),
    });
  };

  return (
    <FormModal
      title={route ? `Маршрут ${route.displayNumber} · правка` : 'Маршрут'}
      open={!!route}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={save.isPending}
      okText="Сохранить"
      width={640}
    >
      <Form<FormValues> form={form} layout="vertical" onFinish={submit} disabled={frozen}>
        <FormGrid>
          {frozen && (
            <FormGrid.Full>
              <Typography.Text type="warning">{ROUTE_FROZEN_MESSAGE}</Typography.Text>
            </FormGrid.Full>
          )}

          <Form.Item
            name="routeDate"
            label="Дата рейса"
            rules={[{ required: true, message: 'Укажите дату' }]}
            extra={
              // Запертую дату объясняем той же причиной, по какой откажет сервер: без права — «нет
              // права», с правом, но глубже предела — «это к администратору» (Р37).
              moveLocked
                ? can('waybills.correct')
                  ? `Рейс старше ${WAYBILL_CORRECTION_DAYS} дней — его дату переносит администратор`
                  : 'Дату прошедшего рейса двигает тот, у кого есть право коррекции задним числом'
                : route && route.requests.length > 0
                  ? `Вместе с рейсом переедет подача ${route.requests.length} заявок`
                  : undefined
            }
          >
            <DatePicker
              format="DD.MM.YYYY"
              style={{ width: '100%' }}
              inputReadOnly={isMobile}
              disabled={moveLocked}
              // Правило одно с сервером (`backdateGuard`): портал не предлагает того, что ручка
              // отклонит, и не запирает того, что она примет.
              disabledDate={(d) => backdateFloor !== null && d.format(DATE) < backdateFloor}
            />
          </Form.Item>

          {/* Причина появляется вместе с прошедшим днём — там же, где выбрали дату. Поле общее с
            прочими дверями заднего числа, у которых цену перечислять нечего: номера бланков перенос
            не жжёт (действующий лист его и не пустит), последствие у него одно — переехавшая подача
            заявок, и о ней говорит подтверждение переноса. Объяснение уходит в аудит правки: своей
            строки в журнале коррекций у переноса нет. */}
          {backdated && (
            <FormGrid.Full>
              <BackdateReasonField
                effectiveDate={movedKey}
                consequence="перенос уйдёт в аудит с вашим именем и этой причиной"
                placeholder="Например: рейс состоялся во вторник, в портал внесли средой"
              />
            </FormGrid.Full>
          )}

          <Form.Item
            name="driverPersonId"
            label="Водитель"
            extra="Без водителя лист не выписать; поставить его можно и позже"
          >
            <AutoSelect
              autoSelectSole={false}
              options={driverOptions}
              showSearch
              allowClear
              optionFilterProp="label"
              loading={driversLoading}
              placeholder="Выберите водителя"
            />
          </Form.Item>

          {/* Задание перегона: у грузового рейса его собирает состав, и сервер такие поля не
            примет. */}
          {relocation && (
            <>
              <Form.Item
                name="moveFrom"
                label="Откуда"
                rules={[{ required: true, message: 'Укажите, откуда идёт техника' }]}
              >
                <Input placeholder="База, ул. Автомобильная, 3" />
              </Form.Item>
              <Form.Item
                name="moveTo"
                label="Куда"
                rules={[{ required: true, message: 'Укажите, куда идёт техника' }]}
              >
                <Input placeholder="Объект, адрес площадки" />
              </Form.Item>
              <FormGrid.Full>
                <Typography.Text type="secondary">
                  {routePurposeLabels[route!.purpose]}
                  {route?.sourceRequest ? ` · по заявке ${route.sourceRequest.displayNumber}` : ''}
                </Typography.Text>
              </FormGrid.Full>
            </>
          )}

          {/* Реквизиты выезда: от рейса к рейсу они те же и правятся раз в сезон — но правятся
            здесь, а не пересборкой рейса. У формы № 3 граф прицепа нет вовсе (ADR 0071), поэтому
            прицеп спрашивается только там, где он печатается. */}
          {route?.formCode !== 'leg3' && (
            <TrailerFields
              key={route?.id}
              withTrailer={withTrailer}
              checkboxLabel="Рейс с прицепом"
              checkboxFullWidth
              modelPlaceholder="СЗАП-8551"
              regNumberPlaceholder="АВ1234 77"
              secondPlaceholder="Если прицепов два"
              hitched={suggestion?.hitched}
              vehicleId={route?.vehicleId}
              vehicleTypeId={route?.vehicleTypeId}
              // Свои графы рейса закрепление не вытесняет: рейс уже описал прицеп, и переписать
              // его значило бы подменить запись, которую открыли править. Пустые графы при стоящей
              // галочке — подставит: рейс сказал «с прицепом», но не сказал, с каким (Р20).
              keepOwnGraphs
              // Барьер готовности формы (Р21): графы рейса, с которыми блок сверяет форму.
              record={route}
            />
          )}

          <Form.Item name="garageNumber" label="Гаражный номер">
            <Input placeholder="Из справочника техники, если пусто" />
          </Form.Item>
          {/* Список, а не строка: значение печатается в графе бланка 4-П и формы № 3, и три
            написания одного слова превращают журнал листов в несверяемый. Ни крестика, ни пункта
            «не выбрано»: обязательность просили на уровне UI, и очистить графу окном нельзя.
            Значение старого рейса, в набор не попавшее, остаётся в списке своим пунктом
            (`communicationKindOptions`) — правка дня рейса не должна уносить чужую графу. */}
          <Form.Item
            name="communicationKind"
            label="Вид сообщения"
            rules={[{ required: true, message: 'Выберите вид сообщения' }]}
          >
            <Select options={communicationKindOptions(communicationKind)} />
          </Form.Item>
          <Form.Item name="transportationKind" label="Вид перевозки">
            <Input placeholder="коммерческая" />
          </Form.Item>

          <FormGrid.Full>
            <Form.Item name="comment" label="Комментарий к рейсу">
              <Input.TextArea rows={2} maxLength={2000} />
            </Form.Item>
          </FormGrid.Full>
        </FormGrid>
      </Form>
    </FormModal>
  );
}

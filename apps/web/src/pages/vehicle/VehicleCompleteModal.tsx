import { useEffect, useEffectEvent, useState } from 'react';
import { App, Button, Form } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  actsForCounterparty,
  approvedMachineHours,
  calcVehicleRequestCost,
  type CompleteVehicleRequestInput,
  type CompletionPreviewDto,
  completionEndBounds,
  rateForWorkUnit,
  type VehicleRequestDto,
  type VehicleWorkUnit,
} from '@technic/contracts';
import { garageKeys } from '@entities/garage';
import { vehicleRequestKeys, waybillKeys } from '@entities/vehicle-request';
import { vehicleRouteKeys } from '@entities/vehicle-route';
import { vehicleRequestsApi } from '../../api/resources';
import { FormModal, useFormBlockers } from '@shared/ui';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';
import { CompletionConsequences, CompletionHandshakeFields } from './CompletionConsequences';
import { CompletionFields, type CompletionFormValues } from './CompletionFields';
import {
  bodyOf,
  type CompletionBody,
  dateKeyOf,
  defaultUnit,
  plannedAmount,
} from './completionCommand';
import { reassignStaleReason } from './ReassignPreview';

/**
 * Закрытие заявки фактом (ADR 0029) и фактической датой (ADR 0178).
 *
 * Заявку оформляли планом — «автокран на три дня», — а платят за то, что было: машина вышла на
 * день позже, работала полторы смены, простояла в ожидании фронта работ. Поэтому факт
 * предъявляется при закрытии: заявка не бывает выполненной без ответа на «сколько стоило».
 *
 * Единицу выбирают ту, в которой договорились о ставке (ADR 0027): часами или сменами. Сумма
 * подставляется расчётом «ставка × количество» и правится свободно — счёт арендодателя включает
 * и перегон, и простой, и сходиться она должна со счётом, а не с формулой. Ручная правка видна
 * подсказкой: расхождение с расчётом должно быть замечено, а не проскочить молча.
 *
 * ФАКТИЧЕСКАЯ ДАТА И ДВЕ ДВЕРИ. Технику брали до воскресенья, фронт закрылся в среду — закрывают
 * средой. Заказ техники на объект уходит поэтому в **свою** дверь (`POST /:id/completion`): она
 * сокращает срок по фактической дате, правит по неё лист недели, гасит решения истории за нею и
 * стирает часы дней, которых у заказа больше нет. Всё это надо показать до нажатия, отсюда второй
 * шаг окна — последствия и подтверждение. Статусная ручка это закрытие с того же выпуска отвергает
 * (Р1), так что второго пути нет ни у кого.
 *
 * Грузоперевозка закрывается прежним путём — статусной ручкой у вызывающего (`onSubmit`): срока
 * работ и недельной бумаги у неё нет, «фактическая дата окончания» ей ничего не значит, и новая
 * дверь её не принимает вовсе (Р3).
 *
 * АРЕНДОДАТЕЛЬ ДАТЫ НЕ ВИДИТ (Р16, решение заказчика по В6). Он закрывает заявку своим коридором,
 * срок остаётся плановым, бумага не трогается: последствий у такого закрытия нет **по построению**,
 * значит нет ни второго шага, ни предпросмотра, ни отпечатков. Признак здесь тот же, каким портал
 * узнаёт арендодателя везде (`actsForCounterparty`), — принадлежность машины признаком не служит:
 * арендованный заказ закрывают и диспетчер, и администратор, и им дата как раз нужна. Совпадение
 * контрагента с арендодателем машины портал не проверяет, и проверять ему нечем: чужую заявку
 * арендодатель не видит вовсе (`assertLessorScope`), а ветвь всё равно считает сервер по субъекту.
 */
interface Props {
  /** null — окно закрыто; заявка берётся из строки списка. */
  request: VehicleRequestDto | null;
  /** День среза по Москве: его считает портал общим правилом, часы браузера тут не годятся. */
  onDate: string;
  /** Ожидание статусной ручки у вызывающего — то есть только у грузоперевозки. */
  confirmLoading: boolean;
  onCancel: () => void;
  /** Грузоперевозка: факт уходит статусной ручкой вызывающего, как и уходил. */
  onSubmit: (v: { completion: CompleteVehicleRequestInput; comment: string }) => void;
  /** Заказ техники закрыт своей дверью: вызывающему остаётся закрыть окно. */
  onCompleted: () => void;
}

export function VehicleCompleteModal({
  request,
  onDate,
  confirmLoading,
  onCancel,
  onSubmit,
  onCompleted,
}: Props) {
  const [form] = Form.useForm<CompletionFormValues>();
  const blockers = useFormBlockers(form);
  const { message } = App.useApp();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [unit, setUnit] = useState<VehicleWorkUnit>('shifts');
  /** Сумму правили руками — расчёт её больше не переписывает. */
  const [costTouched, setCostTouched] = useState(false);
  /** Отработанное правили руками — смена фактической даты его больше не переписывает. */
  const [amountTouched, setAmountTouched] = useState(false);
  /**
   * Ключ операции — один на открытое окно, а не на нажатие (Р25): связь оборвалась, ответа нет,
   * человек жмёт ещё раз — и сервер по тому же ключу возвращает прежний результат вместо второго
   * закрытия с новыми сгоревшими номерами.
   */
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  /** Показанные последствия и тело, которому их посчитали: подтверждение отправляет именно его. */
  const [shown, setShown] = useState<{
    preview: CompletionPreviewDto;
    body: CompletionBody;
  } | null>(null);
  /** Почему окно вернулось к последствиям само; `null` — человек пришёл сюда обычным порядком. */
  const [staleReason, setStaleReason] = useState<string | null>(null);

  const assignment = request?.assignment ?? null;
  const rate = rateForWorkUnit(assignment, unit);

  /**
   * Кто закрывает: арендодатель ведёт свой коридор без даты, предпросмотра и отпечатков (Р16).
   * Заказ техники на объект — своя дверь, грузоперевозка — прежняя статусная ручка (Р3).
   */
  const lessor = actsForCounterparty(user, 'vehicle_lessor');
  const ownDoor = request?.requestType === 'special_equipment';
  /**
   * Границы и умолчание фактической даты считают контракты — сервер проверяет теми же (Р2). Своей
   * арифметики у портала здесь нет и быть не должно: разойдись правила, окно предлагало бы дату,
   * которую дверь отклонит.
   */
  const bounds =
    request?.requestType === 'special_equipment' && !lessor
      ? completionEndBounds(request, onDate)
      : null;

  // Принятые объектом машиночасы: ими открывается поле, если объект уже расписался. Таблица смен
  // нужна и полям — она же перечисляет дни без подписи, — поэтому спрашивается здесь и уходит вниз
  // одним ответом: два запроса за теми же строками разошлись бы между собой.
  const { data: shifts } = useQuery({
    queryKey: ['vehicle-requests', 'shifts', request?.id],
    queryFn: () => vehicleRequestsApi.shifts(request!.id),
    enabled: !!request && request.requestType === 'special_equipment',
  });
  const approvedHours = shifts ? approvedMachineHours(shifts.items) : 0;

  // Окно переиспользуется под разные заявки, поэтому поля сбрасываются при смене цели, а не при
  // размонтировании. Повторное закрытие (после отката администратором) открывается на прежнем
  // факте: обычно правят одну цифру, а не набирают всё заново.
  const targetId = request?.id ?? null;
  const resetForRequest = useEffectEvent((_id: string | null, _hours: number) => {
    if (!request) return;
    // Подтверждённые смены закрывают заявку часами: за них расписался объект, и второй счёт
    // (в сменах) спорил бы с первым. Прежнее закрытие всё равно главнее — его правят, а не
    // набирают заново.
    const start = !request.completion && approvedHours > 0 ? 'hours' : defaultUnit(request);
    const previous = request.completion;
    setUnit(start);
    setCostTouched(!!previous);
    setAmountTouched(!!previous);
    setShown(null);
    setStaleReason(null);
    setOperationId(crypto.randomUUID());
    // Умолчание даты — верхняя граница: сегодня среда, разрешали до воскресенья, подставлять надо
    // среду (Р2). Отдельного поля под умолчание контракты не отдают намеренно — два имени одного
    // значения разъехались бы на первой же правке правила.
    const endedOn = bounds?.max ?? null;
    const amount =
      previous?.workedAmount ??
      (start === 'hours' && approvedHours > 0
        ? approvedHours
        : plannedAmount(request, start, endedOn));
    form.setFieldsValue({
      endedOn: endedOn ? dayjs(endedOn) : undefined,
      workedAmount: amount,
      totalCost:
        previous?.totalCost ??
        calcVehicleRequestCost(rateForWorkUnit(request.assignment, start), amount ?? 0),
      comment: '',
      cancelAck: false,
      reason: '',
    });
  });
  // Зависимости — заявка и подтверждённые часы: таблица смен приходит вторым запросом, и до
  // её ответа подставлять было нечего. Перерисовка той же заявки поля не трогает — иначе
  // стёрла бы уже набранное.
  useEffect(() => resetForRequest(targetId, approvedHours), [targetId, approvedHours]);

  const endedOn = Form.useWatch('endedOn', form);

  /** Смена единицы меняет и ставку: пересчитываем, пока сумму не правили руками. */
  const changeUnit = (next: VehicleWorkUnit) => {
    setUnit(next);
    if (costTouched) return;
    const amount = form.getFieldValue('workedAmount') as number | null | undefined;
    const nextAmount =
      amount ?? (request ? plannedAmount(request, next, dateKeyOf(endedOn)) : null);
    form.setFieldsValue({
      workedAmount: nextAmount,
      totalCost: calcVehicleRequestCost(rateForWorkUnit(assignment, next), nextAmount ?? 0),
    });
  };

  const changeAmount = (value: number | null) => {
    setAmountTouched(true);
    if (costTouched) return;
    form.setFieldsValue({ totalCost: calcVehicleRequestCost(rate, value ?? 0) });
  };

  /**
   * Сдвинули фактическую дату — сдвинулось и отработанное: смен ровно столько, сколько дней заказ
   * работал. Набранное руками при этом не трогаем: человек мог поставить полторы смены за два дня,
   * и «пересчёт» стёр бы именно то, ради чего поле открыто.
   */
  const changeEndedOn = (value: Dayjs | null) => {
    if (amountTouched || unit !== 'shifts' || !request) return;
    const amount = plannedAmount(request, unit, dateKeyOf(value));
    form.setFieldsValue({
      workedAmount: amount,
      ...(costTouched ? {} : { totalCost: calcVehicleRequestCost(rate, amount ?? 0) }),
    });
  };

  const previewMut = useMutation({
    mutationFn: async (body: CompletionBody) => ({
      body,
      preview: await vehicleRequestsApi.completionPreview(request!.id, body),
    }),
    onSuccess: (data) => setShown(data),
    onError: (e) => message.error(errorMessage(e)),
  });

  const completeMut = useMutation({
    mutationFn: (v: CompletionFormValues) => {
      const dto = shown?.preview ?? null;
      const body = shown?.body ?? bodyOf(request!, v, unit, lessor ? null : dateKeyOf(v.endedOn));
      return vehicleRequestsApi.complete(request!.id, {
        ...body,
        // Присутствие каждого подтверждения задаёт **ответ сервера**, а не желание клиента: лишний
        // отпечаток отвергается так же строго, как недостающий, — он означает, что тело посчитано
        // по другому состоянию. У арендодательской ветви предпросмотра нет вовсе, и не уезжает ни
        // одного из них.
        ...(dto ? { previewFingerprint: dto.fingerprint } : {}),
        ...(dto?.cancelGroupsFingerprint
          ? { cancelGroupsFingerprint: dto.cancelGroupsFingerprint }
          : {}),
        ...(dto?.unlockFingerprint ? { unlockFingerprint: dto.unlockFingerprint } : {}),
        ...(dto?.clearedShiftsFingerprint
          ? { clearedShiftsFingerprint: dto.clearedShiftsFingerprint }
          : {}),
        ...(dto?.operationRequirement
          ? { operation: { operationId, reason: (v.reason ?? '').trim() } }
          : {}),
      });
    },
    onSuccess: (res) => {
      message.success(
        res.repeated ? 'Заявка уже была закрыта этой же командой' : 'Заявка выполнена',
      );
      void qc.invalidateQueries({ queryKey: vehicleRequestKeys.root });
      // Закрытие переписывает бумагу и снимает дни с рейсов: списки листов и маршрутов после него
      // показывают не то, что в базе. Занятость машины в гараже меняется вместе со сроком.
      void qc.invalidateQueries({ queryKey: waybillKeys.root });
      void qc.invalidateQueries({ queryKey: vehicleRouteKeys.root });
      void qc.invalidateQueries({ queryKey: garageKeys.root });
      onCompleted();
    },
    onError: (e) => {
      /*
       * Последствия изменились между просмотром и нажатием — сервер отвечает 409, и правильный
       * ответ портала не «повторите», а «посмотрите заново»: перечень мог стать другим, и
       * подтверждать прежний человек больше не вправе. Тост в этом случае был бы вторым голосом о
       * том же и увёл бы глаз от экрана, на который и надо смотреть.
       */
      const stale = reassignStaleReason(e);
      if (stale && shown) {
        setStaleReason(stale);
        previewMut.mutate(shown.body);
        return;
      }
      message.error(errorMessage(e));
    },
  });

  const submit = (v: CompletionFormValues) => {
    if (!request) return;
    // Аренда — счёт от контрагента (ADR 0027): закрытие без суммы означало бы «сколько заплатили,
    // выясним потом». Тем же правилом отвечает сервер.
    const blocked = blockers.raise({
      workedAmount:
        (v.workedAmount == null || v.workedAmount <= 0) && 'Укажите, сколько отработала техника',
      totalCost:
        assignment?.ownership === 'rental' &&
        v.totalCost == null &&
        'Укажите стоимость — по арендованной технике заявка закрывается со счётом',
    });
    if (blocked || v.workedAmount == null) return;

    // Грузоперевозка идёт прежним путём: у неё ни срока работ, ни бумаги, и своей двери нет.
    if (!ownDoor) {
      onSubmit({
        completion: {
          workedUnit: unit,
          workedAmount: v.workedAmount,
          totalCost: v.totalCost ?? null,
        },
        comment: (v.comment ?? '').trim(),
      });
      return;
    }
    // Второй шаг уже показан — подтверждаем именно то тело, которому сервер посчитал последствия.
    if (shown) {
      completeMut.mutate(v);
      return;
    }
    // Арендодателю показывать нечего: его ветвь ни срока, ни бумаги не трогает (Р16).
    if (lessor) {
      completeMut.mutate(v);
      return;
    }
    previewMut.mutate(bodyOf(request, v, unit, dateKeyOf(v.endedOn)));
  };

  const secondStep = !!shown;

  return (
    <FormModal
      title={
        request
          ? `${secondStep ? 'Последствия закрытия' : 'Выполнение заявки'} ${request.displayNumber}`
          : 'Выполнение заявки'
      }
      open={!!request}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
      confirmLoading={confirmLoading || previewMut.isPending || completeMut.isPending}
      // Кнопка называет то, что произойдёт: на первом шаге заказа техники следующим будет разговор
      // о последствиях, а не закрытие, и обещать «Выполнена» ему нельзя.
      okText={ownDoor && !lessor && !secondStep ? 'Показать последствия' : 'Выполнена'}
      // «Назад» уводит от отправки — потому и стоит по другую сторону от основного действия.
      footerExtra={secondStep ? <Button onClick={() => setShown(null)}>Назад</Button> : undefined}
      width={880}
    >
      {request && (
        // Основание (машина и ставка) и факт стоят рядом: сумму сверяют с тем, о чём
        // договаривались, а не листают к нему прокруткой. На телефоне колонка одна.
        <Form form={form} layout="vertical" onFinish={submit} {...blockers.formProps}>
          {shown && <CompletionConsequences preview={shown.preview} staleReason={staleReason} />}

          {shown && <CompletionHandshakeFields preview={shown.preview} />}

          {/* Форма на втором шаге не размонтируется, а прячется: «Назад» обязан вернуть окно
            заполненным, а набранное человеком повторный сбор стоил бы ему уже сделанной работы. */}
          <div style={{ display: secondStep ? 'none' : undefined }}>
            <CompletionFields
              request={request}
              form={form}
              bounds={bounds}
              unit={unit}
              shifts={shifts}
              costTouched={costTouched}
              onUnitChange={changeUnit}
              onAmountChange={changeAmount}
              onCostTouched={() => setCostTouched(true)}
              onEndedOnChange={changeEndedOn}
            />
          </div>
        </Form>
      )}
    </FormModal>
  );
}

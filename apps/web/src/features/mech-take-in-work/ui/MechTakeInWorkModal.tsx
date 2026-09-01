import { useEffect } from 'react';
import { Alert, App, DatePicker, Form, InputNumber, Select } from 'antd';
import type { Dayjs } from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  isAllowedMechFactDate,
  MECH_FUTURE_DATE_MESSAGE,
  MECH_RATE_UNITS,
  mechRateUnitLabels,
  moscowDateKeyOf,
  type MechRateUnit,
  type MechRequestDto,
} from '@technic/contracts';
import {
  mechFailureText,
  mechLessorOptionsQuery,
  MechRequestContext,
  mechRequestKeys,
  mechRequestsApi,
} from '@entities/mech-request';
import { FormModal, useFormBlockers } from '@shared/ui';

const DATE = 'YYYY-MM-DD';

interface Values {
  lessorId: string;
  rate: number;
  rateUnit: MechRateUnit;
  actualFrom?: Dayjs | null;
}

/**
 * «Взять в работу» — окно договорённости (Р6, Р7): у кого берём, почём и за что.
 *
 * Три поля неделимы: цена без арендодателя и арендодатель без цены не значат ничего, и база держит
 * это одним инвариантом. Поэтому окно одно, а не «назначить арендодателя» плюс «поставить ставку».
 *
 * Дата фактической выдачи **необязательна**, и это главное решение окна (Р2). Диспетчер
 * договаривается заранее, а везут технику через день-два: потребуй окно дату — он поставил бы
 * сегодняшнюю, и портал считал бы аренду с того дня, когда её ещё не было. Не поставили — заявка
 * получает тег «ждёт подачи», отменить её ещё можно, а выдачу отмечают позже своей ручкой.
 *
 * То же окно правит уже назначенную договорённость, пока техника не выдана (`mode='deal'`, Р19).
 * Второе окно с теми же тремя полями отличалось бы от этого только заголовком и разъезжалось бы с
 * ним при каждой правке; ручка при этом своя (`updateDeal`) — правка договорённости не переход, и
 * статус она не двигает.
 */
export function MechTakeInWorkModal({
  request,
  mode = 'start',
  onClose,
}: {
  /** `null` — окно закрыто. */
  request: MechRequestDto | null;
  /** `start` — перевод «Новой» в работу; `deal` — правка договорённости уже взятой заявки. */
  mode?: 'start' | 'deal';
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const blockers = useFormBlockers(form);
  const { data: lessors = [], isFetching: lessorsLoading } = useQuery({
    ...mechLessorOptionsQuery(),
    enabled: !!request,
  });

  useEffect(() => {
    if (!request) return;
    form.resetFields();
    /*
     * Правка договорённости начинается с того, что уже стоит: человек пришёл поменять ставку, а не
     * назвать арендодателя заново. У перевода в работу подставлять нечего — договорённости у
     * «Новой» не бывает по построению (`new_empty_check`).
     */
    if (mode === 'deal') {
      form.setFieldsValue({
        lessorId: request.lessorId ?? undefined,
        rate: request.rate ?? undefined,
        rateUnit: request.rateUnit ?? undefined,
      });
    }
  }, [request, mode, form]);

  const mutation = useMutation({
    mutationFn: (values: Values) => {
      const deal = {
        lessorId: values.lessorId,
        rate: values.rate,
        rateUnit: values.rateUnit,
      };
      const version = request!.version;
      return mode === 'deal'
        ? mechRequestsApi.updateDeal(request!.id, { ...deal, version })
        : mechRequestsApi.changeStatus(request!.id, {
            status: 'confirmed',
            comment: '',
            deal,
            // Дата уходит только тогда, когда её поставили: пустое поле означает «техники на
            // объекте ещё нет», а не «выдана неизвестно когда».
            ...(values.actualFrom ? { actualFrom: values.actualFrom.format(DATE) } : {}),
            version,
          });
    },
    onSuccess: () => {
      message.success(mode === 'deal' ? 'Договорённость изменена' : 'Заявка взята в работу');
      void qc.invalidateQueries({ queryKey: mechRequestKeys.root });
      onClose();
    },
    /*
     * Поля с сервера ложатся на форму, а тост говорит только то, что на поля не легло: 409 про
     * устаревшую версию поля не касается вовсе — он про всю карточку, и текст у него свой
     * («перечитайте»), отличный от предметного 422.
     *
     * Псевдонимы нужны потому, что у перехода договорённость лежит вложенным объектом: сервер
     * пришлёт `deal.rate`, а поле формы называется `rate` — без карты пометка потерялась бы молча.
     */
    onError: (e) => {
      const landed = blockers.fromApi(e, {
        'deal.lessorId': 'lessorId',
        'deal.rate': 'rate',
        'deal.rateUnit': 'rateUnit',
      });
      if (!landed) message.error(mechFailureText(e));
    },
  });

  const today = moscowDateKeyOf(new Date());

  return (
    <FormModal
      title={
        request
          ? mode === 'deal'
            ? `Договорённость по заявке ${request.displayNumber}`
            : `Взять в работу заявку ${request.displayNumber}`
          : 'Взять в работу'
      }
      open={!!request}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={mutation.isPending}
      okText={mode === 'deal' ? 'Сохранить' : 'Взять в работу'}
      width={520}
    >
      {request && (
        <>
          <MechRequestContext request={request} />
          <Form
            form={form}
            layout="vertical"
            onFinish={(v) => mutation.mutate(v)}
            {...blockers.formProps}
          >
            <Form.Item
              name="lessorId"
              label="Арендодатель"
              /* Перечень — оба типа контрагента сразу (Р6): компания, заведённая арендодателем ТС,
                 сдаёт механизацию под своим типом, и менять его ей нельзя. */
              rules={[{ required: true, message: 'Выберите арендодателя' }]}
            >
              <Select
                showSearch
                optionFilterProp="label"
                placeholder="У кого берём технику"
                options={lessors}
                loading={lessorsLoading}
              />
            </Form.Item>

            <Form.Item
              name="rate"
              label="Ставка, ₽"
              rules={[{ required: true, message: 'Укажите ставку' }]}
            >
              {/* Границы повторяют `mechRateSchema`: ноль — не аренда, а опечатка, и расчёт по
                  нулевой ставке ничего не считал бы. Точный отказ всё равно за сервером. */}
              <InputNumber
                style={{ width: '100%' }}
                min={0.01}
                max={9_999_999.99}
                precision={2}
                placeholder="1200"
              />
            </Form.Item>

            <Form.Item
              name="rateUnit"
              label="За что ставка"
              /* Умолчания нет намеренно: час и смена отличаются в разы, и подставленное портала
                 значение пришлось бы вычитать глазами в каждой заявке. */
              rules={[{ required: true, message: 'Выберите единицу ставки' }]}
            >
              <Select
                placeholder="час или смена"
                options={MECH_RATE_UNITS.map((value) => ({
                  value,
                  label: mechRateUnitLabels[value],
                }))}
              />
            </Form.Item>

            {mode === 'start' && (
              <>
                <Form.Item
                  name="actualFrom"
                  label="Техника уже на объекте — дата выдачи"
                  rules={[
                    {
                      validator: (_r, value: Dayjs | null | undefined) =>
                        !value || isAllowedMechFactDate(value.format(DATE))
                          ? Promise.resolve()
                          : Promise.reject(new Error(MECH_FUTURE_DATE_MESSAGE)),
                    },
                  ]}
                >
                  {/* Будущие дни заперты календарём, а не только правилом: выдача — запись о
                      случившемся, и предлагать завтрашний день значило бы предлагать ошибку. */}
                  <DatePicker
                    style={{ width: '100%' }}
                    format="DD.MM.YYYY"
                    placeholder="Оставьте пустым, если технику ещё не подали"
                    disabledDate={(d) => d.format(DATE) > today}
                  />
                </Form.Item>
                <Alert
                  type="info"
                  showIcon
                  title="Дата выдачи необязательна"
                  description="Без неё заявка получит тег «ждёт подачи»: её ещё можно отменить, а выдачу отметить позже. С датой аренда считается действующей с этого дня."
                />
              </>
            )}
          </Form>
        </>
      )}
    </FormModal>
  );
}

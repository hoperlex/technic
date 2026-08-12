import { useEffect, useState } from 'react';
import {
  App,
  Checkbox,
  DatePicker,
  Divider,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  TimePicker,
  Typography,
} from 'antd';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  DIGEST_REQUEST_SCOPES,
  MAILING_TYPES,
  MAILING_WINDOW_MAX_DAYS,
  MAILING_WINDOW_MAX_FROM,
  MAILING_WINDOW_PRESETS,
  digestRequestScopeLabels,
  mailingTypeLabels,
  type MailingScheduleDto,
} from '@technic/contracts';
import { FormModal } from '@shared/ui';
import { driversApi, mailingsApi } from '../../api/resources';
import { MailingAudienceFields } from './MailingAudienceFields';
import {
  ALL_WEEKDAYS,
  formToBody,
  saveErrorMessage,
  TIME_FORMAT,
  valuesOf,
  weekdayShort,
  windowExplain,
  withMissing,
  type ScheduleFormValues,
} from './mailingScheduleValues';

/**
 * Форма расписания рассылки: одна на оба типа, разделы «Аудитория» и «Содержание» — только у
 * сводки (план `docs/role-mailings-refactor-plan.md`, §3).
 *
 * Периодичности у расписания нет: оно описывается тремя независимыми настройками — дни недели,
 * время и окно данных. Недельная рассылка — это набор из одного дня и окно на семь; выражать то же
 * самое вторым способом значило бы держать в форме поле, вычисляемое из соседнего.
 */

/** Ключ справочника водителей этой формы: выборка своя — вся, одной страницей и по алфавиту. */
const DRIVERS_KEY = ['drivers', 'mailing-exclusions'];

/** Значение «своё число» в списке первого дня: настоящим днём окна отрицательное быть не может. */
const CUSTOM_FROM = -1;

/**
 * Первый день окна: список готовых вариантов и — по варианту «другое» — поле числа. Отдельного
 * поля «другое», стоящего рядом всегда, нет намеренно: у вопроса «с какого дня» должен остаться
 * один ответ, а два поля сразу порождают вопрос, какое из них главнее.
 */
export function WindowFromField({
  id,
  value,
  onChange,
}: {
  id?: string;
  value?: number;
  onChange?: (value: number) => void;
}) {
  const [manual, setManual] = useState(false);
  const preset = MAILING_WINDOW_PRESETS.some((p) => p.value === value);
  const custom = manual || !preset;
  return (
    <Space align="start">
      <Select
        id={id}
        style={{ width: 220 }}
        value={custom ? CUSTOM_FROM : value}
        options={[
          ...MAILING_WINDOW_PRESETS.map((p) => ({ value: p.value, label: p.label })),
          { value: CUSTOM_FROM, label: 'Другой день' },
        ]}
        onChange={(v: number) => {
          setManual(v === CUSTOM_FROM);
          if (v !== CUSTOM_FROM) onChange?.(v);
        }}
      />
      {custom ? (
        <InputNumber
          min={0}
          max={MAILING_WINDOW_MAX_FROM}
          value={value}
          onChange={(v) => onChange?.(v ?? 0)}
          addonAfter="дн."
          style={{ width: 120 }}
        />
      ) : null}
    </Space>
  );
}

interface Props {
  open: boolean;
  /** `null` — новое расписание. */
  editing: MailingScheduleDto | null;
  onClose: () => void;
  onSaved: () => void;
}

export function MailingScheduleForm({ open, editing, onClose, onSaved }: Props) {
  const { message } = App.useApp();
  const [form] = Form.useForm<ScheduleFormValues>();
  const watchType = Form.useWatch('type', form);
  const watchFrom = Form.useWatch('windowFromDays', form);
  const watchDays = Form.useWatch('windowDays', form);
  const watchExcludedPersons = Form.useWatch('excludedPersonIds', form);
  const isDigest = watchType === 'role_digest';

  // Значения ставятся на открытие, а не `initialValues`: окно остаётся в разметке закрытым, и без
  // этого правка второго расписания открылась бы с полями первого.
  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(valuesOf(editing));
  }, [open, editing, form]);

  // Справочник водителей спрашивается только при открытой форме задания водителям: в нём
  // персональные данные, и держать его в кэше ради чужого типа рассылки незачем. Тип сверяется
  // прямым равенством, а не «не сводка»: на первом рендере после открытия значений формы ещё нет,
  // и «не сводка» означало бы запрос персональных данных при правке чужого расписания.
  const driversQuery = useQuery({
    queryKey: DRIVERS_KEY,
    queryFn: () =>
      driversApi.list({ page: 1, pageSize: 500, sortBy: 'fullName', sortOrder: 'asc' }),
    enabled: open && watchType === 'driver_routes',
  });
  const driverOptions = withMissing(
    (driversQuery.data?.items ?? []).map((d) => ({ value: d.id, label: d.fullName })),
    watchExcludedPersons,
  );

  const saveMut = useMutation({
    mutationFn: (v: ScheduleFormValues) => {
      const body = formToBody(v);
      return editing
        ? mailingsApi.updateSchedule(editing.id, { ...body, version: editing.version })
        : mailingsApi.createSchedule(body);
    },
    onSuccess: () => {
      message.success('Сохранено');
      onSaved();
    },
    onError: (e) => message.error(saveErrorMessage(e)),
  });

  return (
    <FormModal
      title={editing ? 'Редактирование расписания' : 'Новое расписание'}
      open={open}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={saveMut.isPending}
      // Шире стандартных 480: набор дней недели и пара полей окна в узком окне переносятся по
      // одному в строку, и форма перестаёт читаться целиком.
      width={620}
    >
      <Form
        form={form}
        layout="vertical"
        className="form-dense"
        onFinish={(v) => saveMut.mutate(v)}
      >
        <Form.Item
          name="name"
          label="Название"
          rules={[{ required: true, message: 'Укажите название рассылки' }]}
        >
          <Input maxLength={200} placeholder="Например: задание водителям на завтра" />
        </Form.Item>

        <Form.Item
          name="type"
          label="Тип рассылки"
          rules={[{ required: true, message: 'Выберите тип рассылки' }]}
          // Тип держит и состав получателей, и историю запусков: «то же расписание, но теперь про
          // другое» читалось бы как подмена прошлых рассылок, поэтому сервер его не меняет.
          extra={editing ? 'Тип менять нельзя — заведите отдельное расписание' : undefined}
        >
          <Select
            disabled={!!editing}
            options={MAILING_TYPES.map((t) => ({ value: t, label: mailingTypeLabels[t] }))}
          />
        </Form.Item>

        <Divider titlePlacement="start" plain>
          Когда
        </Divider>

        {/* Дни выполнения есть у обоих типов: недельная рассылка — это один отмеченный день. */}
        <Form.Item
          name="runWeekdays"
          label="Дни выполнения"
          // Расписание, не выполняющееся никогда, выражается флагом «выключено», а не пустым
          // набором дней: иначе выключенная рассылка выглядела бы включённой.
          rules={[
            {
              validator: (_rule, value: number[] | undefined) =>
                value && value.length > 0
                  ? Promise.resolve()
                  : Promise.reject(new Error('Выберите хотя бы один день или выключите рассылку')),
            },
          ]}
        >
          <Checkbox.Group
            options={ALL_WEEKDAYS.map((d) => ({ value: d, label: weekdayShort(d) }))}
          />
        </Form.Item>

        {/* Шаг в пять минут: рассылку назначают на круглое время, а список из шестидесяти минут
            приходится прокручивать. Подтверждать выбор кнопкой не надо — поле одно. */}
        <Form.Item
          name="sendAt"
          label="Время отправки"
          rules={[{ required: true, message: 'Укажите время отправки' }]}
          extra="Местное время портала (Москва)"
        >
          <TimePicker
            format={TIME_FORMAT}
            minuteStep={5}
            needConfirm={false}
            style={{ width: 160 }}
          />
        </Form.Item>

        <Form.Item
          name="excludedRunDates"
          label="Даты без рассылки"
          extra="В эти дни рассылка не уходит: праздники и остановки. Расчёт следующего запуска их учитывает"
        >
          <DatePicker multiple format="DD.MM.YYYY" style={{ width: '100%' }} />
        </Form.Item>

        <Divider titlePlacement="start" plain>
          За какие дни
        </Divider>

        <Space align="start" size={16} wrap>
          <Form.Item
            name="windowFromDays"
            label="Первый день"
            rules={[{ required: true, message: 'Укажите первый день окна' }]}
          >
            <WindowFromField />
          </Form.Item>
          <Form.Item
            name="windowDays"
            label="На сколько дней"
            rules={[{ required: true, message: 'Укажите длину окна' }]}
            extra="1 — только первый день"
          >
            <InputNumber min={1} max={MAILING_WINDOW_MAX_DAYS} style={{ width: 160 }} />
          </Form.Item>
        </Space>
        <Typography.Paragraph type="secondary">
          {windowExplain(watchType, watchFrom, watchDays)}
        </Typography.Paragraph>

        {isDigest ? (
          <>
            <Divider titlePlacement="start" plain>
              Аудитория
            </Divider>
            <MailingAudienceFields active={open} />

            <Divider titlePlacement="start" plain>
              Содержание
            </Divider>
            <Form.Item
              name="requestScope"
              label="Охват заявок"
              extra="Ни одно значение не расширяет область видимости получателя: письмо не показывает больше, чем его экран"
            >
              <Select
                options={DIGEST_REQUEST_SCOPES.map((s) => ({
                  value: s,
                  label: digestRequestScopeLabels[s],
                }))}
              />
            </Form.Item>

            {/* Две таблицы, а не набор разделов: делятся они по бланку путевого листа, потому что
                по бланку расходится его привязка — 4-П и форма № 3 висят на рейсе, ЭСМ-2 на
                заявке и неделе работы. */}
            <Form.Item
              label="Что показывать"
              // Правило на всей паре: письмо без единой таблицы соберётся пустым и не отправится —
              // это рассылка, каждое утро работающая вхолостую.
              required
            >
              <Form.Item name="showTrips" valuePropName="checked" noStyle>
                <Checkbox>Перевозки (4-П, форма № 3)</Checkbox>
              </Form.Item>
              <br />
              <Form.Item
                name="showOnsite"
                valuePropName="checked"
                dependencies={['showTrips']}
                noStyle
                rules={[
                  ({ getFieldValue }) => ({
                    validator: (_rule, value: boolean) =>
                      value || getFieldValue('showTrips')
                        ? Promise.resolve()
                        : Promise.reject(
                            new Error('Выберите хотя бы одну таблицу: перевозки или технику'),
                          ),
                  }),
                ]}
              >
                {/* Без «(ЭСМ-2)»: таблица собирается из двух источников (ADR 0100) — недельных
                    листов обычной спецтехники и дней линейной, у которых документ дня это 4-П.
                    Прежняя подпись называла один из них и обещала не то. */}
                <Checkbox>Техника на объектах</Checkbox>
              </Form.Item>
            </Form.Item>
          </>
        ) : (
          <>
            <Form.Item
              name="excludedRouteDates"
              label="Даты рейсов, которые не печатать"
              extra="Рейсы этих дней в письмо не попадут, сама рассылка при этом уходит"
            >
              <DatePicker multiple format="DD.MM.YYYY" style={{ width: '100%' }} />
            </Form.Item>

            <Form.Item
              name="excludedPersonIds"
              label="Исключённые водители"
              extra="Этим людям рассылка не адресуется — например, они получают задание другим способом"
            >
              <Select
                mode="multiple"
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="Никто не исключён"
                loading={driversQuery.isLoading}
                options={driverOptions}
              />
            </Form.Item>
          </>
        )}

        <Form.Item
          name="isEnabled"
          label="Включена"
          valuePropName="checked"
          extra="Выключенная рассылка не срабатывает и следующего запуска не имеет"
        >
          <Switch />
        </Form.Item>
      </Form>
    </FormModal>
  );
}

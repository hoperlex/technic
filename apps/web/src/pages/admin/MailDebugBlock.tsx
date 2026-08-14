import { useState } from 'react';
import {
  App,
  Alert,
  Button,
  Card,
  DatePicker,
  Form,
  InputNumber,
  Select,
  Space,
  Typography,
} from 'antd';
import { useMutation, useQuery } from '@tanstack/react-query';
import type dayjs from 'dayjs';
import {
  DEFAULT_MAIL_ACCOUNT,
  EMAIL_VERIFICATION_ENABLED,
  MAILING_WINDOW_MAX_DAYS,
  mailAccountHints,
  mailAccountLabels,
  MAIL_TEST_KINDS,
  mailTestKindLabels,
  mailTestKindNeedsDate,
  mailTestKindNeedsDriver,
  mailTestKindNeedsSampleUser,
  type MailAccount,
  type MailTestKind,
  roleLabels,
} from '@technic/contracts';
import { mailingsApi } from '../../api/resources';
import { WindowFromField } from './MailingScheduleForm';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';

interface FormValues {
  kind: MailTestKind;
  /** Каким каналом отправить: у каждого свой сервер и свой отправитель. */
  account: MailAccount;
  toUserId: string;
  date?: dayjs.Dayjs;
  windowFromDays?: number;
  windowDays?: number;
  driverPersonId?: string;
  sampleUserId?: string;
}

const DATE = 'YYYY-MM-DD';

/**
 * Виды писем, которые предлагает отладка. Письмо подтверждения адреса из списка убрано, пока
 * подтверждение выключено (EMAIL_VERIFICATION_ENABLED): портал его не отправляет, и проверять
 * вёрстку письма, которого нет, незачем.
 */
const TEST_KINDS = MAIL_TEST_KINDS.filter(
  (k) => EMAIL_VERIFICATION_ENABLED || k !== 'verify_email',
);

/**
 * Отладочная отправка одного письма (ADR 0075).
 *
 * Зачем отправлять по-настоящему, если есть предпросмотр: предпросмотр рисует письмо в браузере, а
 * проверить надо ровно то, чего браузер не показывает, — доставку, тему в списке писем, вёрстку в
 * почтовом клиенте и вид на телефоне.
 *
 * Стоит последней подвкладкой намеренно: раздел открывают, чтобы посмотреть, что и когда уходит
 * само, а проверка вёрстки — занятие разовое.
 */
export function MailDebugBlock() {
  const { message } = App.useApp();
  const { can } = useAuth();
  const canManage = can('mailings.manage');
  const [form] = Form.useForm<FormValues>();
  const [kind, setKind] = useState<MailTestKind>(TEST_KINDS[0]!);

  const { data: recipients, isLoading } = useQuery({
    queryKey: ['mail-test-recipients'],
    queryFn: () => mailingsApi.testRecipients(),
  });

  // Каналы: список известен контрактами, а настроенность — только серверу, у которого лежит `env`.
  // Ненастроенный канал остаётся в списке, но выбрать его нельзя: письмо легло бы в очередь и ждало
  // настройки, а человек считал бы, что проверил отправку.
  const { data: accounts } = useQuery({
    queryKey: ['mail-accounts'],
    queryFn: () => mailingsApi.accounts(),
  });

  const needsDate = mailTestKindNeedsDate[kind];
  const needsDriver = mailTestKindNeedsDriver[kind];
  const needsSampleUser = mailTestKindNeedsSampleUser[kind];
  const account = Form.useWatch<MailAccount>('account', form) ?? DEFAULT_MAIL_ACCOUNT;
  const watchDate = Form.useWatch<dayjs.Dayjs | undefined>('date', form);
  const driversDate = watchDate ? watchDate.format(DATE) : undefined;

  // Список водителей свой на каждую дату: рейсы есть не у всех и не каждый день. Без даты
  // спрашивать нечего, поэтому запрос ждёт её.
  const driversQuery = useQuery({
    queryKey: ['mail-test-drivers', driversDate],
    queryFn: () => mailingsApi.driversWithRoutes(driversDate!),
    enabled: needsDriver && !!driversDate,
  });
  const drivers = driversQuery.data ?? [];
  const noDrivers = driversQuery.isSuccess && drivers.length === 0;

  // Список образцов от даты не зависит и меняется редко, поэтому спрашивается один раз на вид
  // письма, которому он вообще нужен.
  const sampleUsersQuery = useQuery({
    queryKey: ['mail-digest-sample-users'],
    queryFn: () => mailingsApi.digestSampleUsers(),
    enabled: needsSampleUser,
  });
  const sampleUsers = sampleUsersQuery.data ?? [];

  const sendMut = useMutation({
    mutationFn: (values: FormValues) =>
      mailingsApi.sendTest({
        kind: values.kind,
        account: values.account,
        toUserId: values.toUserId,
        ...(values.date ? { date: values.date.format(DATE) } : {}),
        // Окно уходит вместе с датой и только с ней: у писем про доступ периода нет вовсе, и
        // спрашивать про него нечего. Проверяют же им ровно то письмо, которое уйдёт по
        // расписанию, — те же два числа настраивает и оно.
        ...(needsDate
          ? { windowFromDays: values.windowFromDays ?? 0, windowDays: values.windowDays ?? 1 }
          : {}),
        ...(values.driverPersonId ? { driverPersonId: values.driverPersonId } : {}),
        ...(values.sampleUserId ? { sampleUserId: values.sampleUserId } : {}),
      }),
    onSuccess: (res) => message.success(res.message),
    onError: (e) => message.error(errorMessage(e)),
  });

  return (
    <div>
      <div style={{ padding: 16, maxWidth: 640 }}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          Отладочная отправка
        </Typography.Title>
        <Card>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="Письмо уходит по-настоящему"
            description={
              'Тема получает пометку «[ТЕСТ]», ссылки в письме недействительны, а в журнале и в ' +
              'статистике оно помечено как отладочное. Получателем может быть только действующий ' +
              'администратор: в письме настоящие рабочие данные.'
            }
          />
          <Form
            form={form}
            layout="vertical"
            requiredMark={false}
            // Окно по умолчанию — «сегодняшний день, на день»: оно отвечает на вопрос «как вообще
            // выглядит письмо», а конкретную настройку расписания повторяют здесь руками.
            initialValues={{
              kind: TEST_KINDS[0],
              account: DEFAULT_MAIL_ACCOUNT,
              windowFromDays: 0,
              windowDays: 1,
            }}
            onFinish={(v) => sendMut.mutate(v)}
            onValuesChange={(changed: Partial<FormValues>) => {
              // Водитель осмыслен только вместе с видом письма и датой: на другой день у выбранного
              // человека рейсов может не быть вовсе, а уехавший в отправку чужой образец читался бы
              // как ошибка сервера. Образец сводки сбрасывается вместе с ним: смена вида или даты —
              // это новая проверка, и подставлять в неё выбор от прошлой значит однажды отправить
              // письмо не тем, кем собирались смотреть.
              if ('kind' in changed || 'date' in changed) {
                form.setFieldValue('driverPersonId', undefined);
                form.setFieldValue('sampleUserId', undefined);
              }
            }}
          >
            <Form.Item name="kind" label="Тип письма" rules={[{ required: true }]}>
              <Select
                options={TEST_KINDS.map((k) => ({ value: k, label: mailTestKindLabels[k] }))}
                onChange={(v: MailTestKind) => setKind(v)}
              />
            </Form.Item>

            {/* Дата нужна не всякому письму: у писем про доступ её нет — они относятся к событию,
              а не к периоду. У задания водителю и дайджеста поле появится. */}
            {needsDate && (
              <Form.Item
                name="date"
                label="Дата, за которую собрать письмо"
                rules={[{ required: true }]}
              >
                <DatePicker format="DD.MM.YYYY" style={{ width: '100%' }} />
              </Form.Item>
            )}

            {/* Окно данных спрашивается теми же двумя полями, что и в расписании: письмо собирается
                от дня рассылки вперёд, и проверка «как оно выглядит» обязана уметь повторить ровно
                ту настройку, с которой оно уйдёт само. */}
            {needsDate && (
              <Space align="start" size={16} wrap>
                <Form.Item
                  name="windowFromDays"
                  label="Первый день"
                  rules={[{ required: true }]}
                  extra="Считается от даты выше — она играет роль дня рассылки"
                >
                  <WindowFromField />
                </Form.Item>
                <Form.Item name="windowDays" label="На сколько дней" rules={[{ required: true }]}>
                  <InputNumber min={1} max={MAILING_WINDOW_MAX_DAYS} style={{ width: 160 }} />
                </Form.Item>
              </Space>
            )}

            {/* Образец нужен только письмам «про человека», и выбирать его не из чего, пока не задана
              дата: список водителей собирается по рейсам этого дня. */}
            {needsDriver && driversDate && (
              <Form.Item
                name="driverPersonId"
                label="Водитель (образец)"
                extra={
                  noDrivers
                    ? 'На эту дату рейсов с водителями нет — письмо собрать не из чего'
                    : 'Можно не выбирать: тогда сервер возьмёт первого водителя с рейсами на эту дату'
                }
              >
                <Select
                  loading={driversQuery.isLoading}
                  disabled={noDrivers}
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  placeholder="Первый водитель с рейсами"
                  notFoundContent="На эту дату рейсов с водителями нет"
                  options={drivers.map((d) => ({
                    value: d.personId,
                    label: `${d.fullName} — ${d.email}`,
                  }))}
                />
              </Form.Item>
            )}

            {/* Сводка у каждого своя: одни и те же разделы под разными людьми возвращают разные
              строки, потому что собираются их областью видимости. Поэтому у неё спрашивают не «чьё
              письмо отправить», а «чьими глазами его собрать» — уходит оно всё равно получателю. */}
            {needsSampleUser && (
              <Form.Item
                name="sampleUserId"
                label="Чьими глазами смотреть"
                extra={
                  'Сводка собирается областью видимости выбранного человека, но письмо уходит ' +
                  'получателю ниже. Можно не выбирать: тогда сводка соберётся под получателем, а он ' +
                  'администратор и видит всё.'
                }
              >
                <Select
                  loading={sampleUsersQuery.isLoading}
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  placeholder="Получатель письма"
                  options={sampleUsers.map((u) => ({
                    value: u.id,
                    label: `${u.fullName} — ${roleLabels[u.role]} — ${u.email}`,
                  }))}
                />
              </Form.Item>
            )}

            {/* Канал стоит перед получателем: он решает, от кого и через какой сервер уйдёт письмо,
              и проверяют новым каналом именно это. */}
            <Form.Item
              name="account"
              label="Канал отправки"
              rules={[{ required: true }]}
              extra={mailAccountHints[account]}
            >
              <Select
                options={(accounts ?? []).map((a) => ({
                  value: a.account,
                  label: a.configured
                    ? `${mailAccountLabels[a.account]} — ${a.from}`
                    : `${mailAccountLabels[a.account]} — не настроен на сервере`,
                  disabled: !a.configured,
                }))}
              />
            </Form.Item>

            <Form.Item
              name="toUserId"
              label="Получатель"
              rules={[{ required: true, message: 'Выберите администратора' }]}
              extra="Список ограничен действующими администраторами"
            >
              <Select
                loading={isLoading}
                showSearch
                optionFilterProp="label"
                placeholder="Кому отправить"
                options={(recipients ?? []).map((r) => ({
                  value: r.id,
                  label: `${r.fullName} — ${r.email}`,
                }))}
              />
            </Form.Item>

            <Space>
              <Button
                type="primary"
                htmlType="submit"
                loading={sendMut.isPending}
                disabled={!canManage}
              >
                Отправить тест
              </Button>
              {!canManage && (
                <Typography.Text type="secondary">
                  Нужно право на управление рассылками
                </Typography.Text>
              )}
            </Space>
          </Form>
        </Card>
      </div>
    </div>
  );
}

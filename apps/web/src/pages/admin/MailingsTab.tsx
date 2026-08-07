import { useState } from 'react';
import { App, Alert, Button, Card, DatePicker, Form, Select, Space, Typography } from 'antd';
import { useMutation, useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import {
  EMAIL_VERIFICATION_ENABLED,
  MAIL_TEST_KINDS,
  mailTestKindLabels,
  mailTestKindNeedsDate,
  mailTestKindNeedsDriver,
  mailTestKindNeedsSampleUser,
  type MailTestKind,
  roleLabels,
} from '@technic/contracts';
import { mailingsApi } from '../../api/resources';
import { MailingSchedulesBlock } from './MailingSchedulesBlock';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';

interface FormValues {
  kind: MailTestKind;
  toUserId: string;
  date?: dayjs.Dayjs;
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
 * Рассылки: расписания с историей запусков (ADR 0075) и отладочная отправка одного письма.
 *
 * Отладка стоит ниже расписаний намеренно: вкладку открывают, чтобы посмотреть, что и когда
 * уходит само, а проверка вёрстки — занятие разовое и в этом порядке не мешает.
 *
 * Зачем отправлять по-настоящему, если есть предпросмотр: предпросмотр рисует письмо в браузере, а
 * проверить надо ровно то, чего браузер не показывает, — доставку, тему в списке писем, вёрстку в
 * почтовом клиенте и вид на телефоне.
 */
export function MailingsTab() {
  const { message } = App.useApp();
  const { can } = useAuth();
  const canManage = can('mailings.manage');
  const [form] = Form.useForm<FormValues>();
  const [kind, setKind] = useState<MailTestKind>(TEST_KINDS[0]!);

  const { data: recipients, isLoading } = useQuery({
    queryKey: ['mail-test-recipients'],
    queryFn: () => mailingsApi.testRecipients(),
  });

  const needsDate = mailTestKindNeedsDate[kind];
  const needsDriver = mailTestKindNeedsDriver[kind];
  const needsSampleUser = mailTestKindNeedsSampleUser[kind];
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
        toUserId: values.toUserId,
        ...(values.date ? { date: values.date.format(DATE) } : {}),
        ...(values.driverPersonId ? { driverPersonId: values.driverPersonId } : {}),
        ...(values.sampleUserId ? { sampleUserId: values.sampleUserId } : {}),
      }),
    onSuccess: (res) => message.success(res.message),
    onError: (e) => message.error(errorMessage(e)),
  });

  return (
    // Вкладка отдана содержимому целиком (`.full-height-tabs` прячет переполнение), поэтому
    // прокрутка здесь своя: расписания с историей запусков и отладочная отправка вместе выше
    // экрана, и без неё нижний блок просто обрезался бы низом окна.
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <MailingSchedulesBlock />
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
            initialValues={{ kind: TEST_KINDS[0] }}
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

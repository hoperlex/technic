import { useState } from 'react';
import {
  App,
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MODULE_MAIL_EVENTS,
  moduleMailEventHints,
  moduleMailEventLabels,
  REPLY_TO_MODES,
  replyToModeAllowsEmail,
  replyToModeHints,
  replyToModeLabels,
  replyToModeNeedsEmail,
  type ModuleMailEvent,
  type ModuleMailRecipientDto,
  type ReplyToMode,
} from '@technic/contracts';
import { isApiError } from '@shared/api';
import { moduleMailApi, moduleMailKeys } from '@entities/module-mail';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage, formatDateTime } from '../../utils/format';

/**
 * Служебные адреса: на какой ящик уходит письмо по событию модуля (план
 * `docs/office-equipment-mail-and-history-plan.md`, Р64, Р71).
 *
 * Отдельной подвкладкой рядом с расписаниями, а не строкой в них: расписание отвечает на вопрос
 * «кому из учётных записей и когда уходит сводка», а здесь адресат — ящик службы, за которым нет
 * ни учётки, ни области видимости. Отдел ИТ читает почту, а не портал.
 *
 * Пустой список — не поломка, а «функция выкачена, но не включена»: адрес заводит администратор,
 * и до этого события отвечают исходом «адресаты не настроены».
 */

interface FormValues {
  event: ModuleMailEvent;
  toEmail: string;
  isEnabled: boolean;
  replyToMode: ReplyToMode;
  replyToEmail: string;
  comment: string;
}

const EMPTY: FormValues = {
  event: MODULE_MAIL_EVENTS[0],
  toEmail: '',
  isEnabled: true,
  replyToMode: 'fixed',
  replyToEmail: '',
  comment: '',
};

export function ServiceMailRecipientsBlock() {
  const { message } = App.useApp();
  const { can } = useAuth();
  const canManage = can('mailings.manage');
  const qc = useQueryClient();
  const [form] = Form.useForm<FormValues>();
  const [editing, setEditing] = useState<ModuleMailRecipientDto | null>(null);
  const [open, setOpen] = useState(false);

  const { data: rows, isLoading } = useQuery({
    queryKey: moduleMailKeys.list(),
    queryFn: () => moduleMailApi.list(),
  });

  const replyToMode = Form.useWatch<ReplyToMode>('replyToMode', form) ?? 'fixed';
  const invalidate = () => qc.invalidateQueries({ queryKey: moduleMailKeys.root });

  const saveMut = useMutation({
    mutationFn: (values: FormValues) =>
      editing
        ? moduleMailApi.update(editing.id, {
            toEmail: values.toEmail,
            isEnabled: values.isEnabled,
            replyToMode: values.replyToMode,
            // Запасной адрес имеет смысл не у всякого режима, и отправлять его «про запас» нельзя:
            // у общего адреса портала своего адреса не бывает вовсе (это же держит CHECK).
            replyToEmail: replyToModeAllowsEmail(values.replyToMode) ? values.replyToEmail : '',
            comment: values.comment,
            version: editing.version,
          })
        : moduleMailApi.create({
            event: values.event,
            toEmail: values.toEmail,
            isEnabled: values.isEnabled,
            replyToMode: values.replyToMode,
            replyToEmail: replyToModeAllowsEmail(values.replyToMode) ? values.replyToEmail : '',
            comment: values.comment,
          }),
    onSuccess: async () => {
      message.success(editing ? 'Адресат изменён' : 'Адресат добавлен');
      setOpen(false);
      setEditing(null);
      await invalidate();
    },
    /**
     * Конфликт версий закрывает окно и обновляет список, а не оставляет форму с устаревшим
     * `version`: иначе повторное «Сохранить» упирается в тот же 409 — версия в открытой форме уже
     * не изменится, и выйти из этого можно только закрыв окно руками. Строку правят заново, увидев
     * чужую правку.
     */
    onError: async (e) => {
      message.error(errorMessage(e));
      if (isApiError(e) && e.status === 409) {
        setOpen(false);
        setEditing(null);
        await invalidate();
      }
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => moduleMailApi.remove(id),
    onSuccess: async () => {
      message.success('Адресат удалён');
      await invalidate();
    },
    // Удаление «не найдено» означает, что строку уже удалили в другом окне: список обновляется, и
    // строка-призрак исчезает вместо того, чтобы висеть до перезагрузки страницы.
    onError: async (e) => {
      message.error(errorMessage(e));
      if (isApiError(e) && e.status === 404) await invalidate();
    },
  });

  const openCreate = () => {
    setEditing(null);
    form.setFieldsValue(EMPTY);
    setOpen(true);
  };

  const openEdit = (row: ModuleMailRecipientDto) => {
    setEditing(row);
    form.setFieldsValue({
      event: row.event,
      toEmail: row.toEmail,
      isEnabled: row.isEnabled,
      replyToMode: row.replyToMode,
      replyToEmail: row.replyToEmail,
      comment: row.comment,
    });
    setOpen(true);
  };

  return (
    <div style={{ padding: 16, maxWidth: 960 }}>
      <Space style={{ marginBottom: 16 }} align="start">
        <Typography.Title level={4} style={{ margin: 0 }}>
          Служебные адреса
        </Typography.Title>
        {canManage && (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            Добавить адрес
          </Button>
        )}
      </Space>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="Письма службам, у которых нет учётной записи"
        description={
          'Сводки по расписанию уходят пользователям портала. Здесь настраивается другое: письмо ' +
          'по событию на рабочий ящик службы — например заявка на обслуживание, ждущая визы ИТ. ' +
          'Пока адрес не заведён, письма по событию не уходят, а сама заявка заводится как обычно.'
        }
      />

      <Table<ModuleMailRecipientDto>
        size="small"
        rowKey="id"
        loading={isLoading}
        dataSource={rows ?? []}
        pagination={false}
        locale={{ emptyText: 'Адресов нет — письма по событиям не уходят' }}
        columns={[
          {
            key: 'event',
            title: 'Событие',
            render: (_v, r) => (
              <div style={{ lineHeight: 1.4 }}>
                <div>{moduleMailEventLabels[r.event]}</div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {moduleMailEventHints[r.event]}
                </Typography.Text>
              </div>
            ),
          },
          {
            key: 'toEmail',
            title: 'Кому',
            width: 260,
            render: (_v, r) => (
              <div style={{ lineHeight: 1.4 }}>
                <div>{r.toEmail}</div>
                {!r.isEnabled && <Tag color="default">Выключен</Tag>}
                {r.comment && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {r.comment}
                  </Typography.Text>
                )}
              </div>
            ),
          },
          {
            key: 'replyTo',
            title: 'Ответ уйдёт',
            width: 220,
            render: (_v, r) => (
              <div style={{ lineHeight: 1.4 }}>
                <div>{replyToModeLabels[r.replyToMode]}</div>
                {r.replyToEmail && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {replyToModeNeedsEmail(r.replyToMode)
                      ? r.replyToEmail
                      : `запасной: ${r.replyToEmail}`}
                  </Typography.Text>
                )}
              </div>
            ),
          },
          {
            key: 'updated',
            title: 'Изменён',
            width: 180,
            render: (_v, r) => (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {formatDateTime(r.updatedAt)}
                {r.updatedByName ? ` · ${r.updatedByName}` : ''}
              </Typography.Text>
            ),
          },
          ...(canManage
            ? [
                {
                  key: 'actions',
                  title: '',
                  width: 90,
                  render: (_v: unknown, r: ModuleMailRecipientDto) => (
                    <Space size={4}>
                      <Button
                        type="text"
                        icon={<EditOutlined />}
                        onClick={() => openEdit(r)}
                        aria-label="Изменить"
                      />
                      <Popconfirm
                        title="Удалить адресата?"
                        description="Письма по этому событию на этот адрес больше не уйдут"
                        okText="Удалить"
                        cancelText="Отмена"
                        onConfirm={() => deleteMut.mutate(r.id)}
                      >
                        <Button type="text" danger icon={<DeleteOutlined />} aria-label="Удалить" />
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]
            : []),
        ]}
      />

      <Modal
        title={editing ? 'Служебный адрес' : 'Новый служебный адрес'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        okText="Сохранить"
        cancelText="Отмена"
        confirmLoading={saveMut.isPending}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          requiredMark={false}
          onFinish={(v) => saveMut.mutate(v)}
        >
          {/* Событие правкой не меняется: строка — это пара «событие + адрес», и смена события
              делает её другой строкой. Переносят адрес заведением новой и выключением старой —
              тогда в журнале остаётся, что и когда перестало рассылаться. */}
          <Form.Item
            name="event"
            label="Событие"
            rules={[{ required: true }]}
            extra={editing ? 'У заведённой строки событие не меняется' : undefined}
          >
            <Select
              disabled={!!editing}
              options={MODULE_MAIL_EVENTS.map((e) => ({
                value: e,
                label: moduleMailEventLabels[e],
              }))}
            />
          </Form.Item>

          <Form.Item
            name="toEmail"
            label="Адрес службы"
            rules={[{ required: true, message: 'Укажите адрес' }]}
          >
            <Input placeholder="repair@example.ru" autoComplete="off" />
          </Form.Item>

          <Form.Item name="replyToMode" label="Куда уйдёт ответ" rules={[{ required: true }]}>
            <Select
              options={REPLY_TO_MODES.map((m) => ({ value: m, label: replyToModeLabels[m] }))}
            />
          </Form.Item>

          {/* Адрес для ответов спрашивается там, где он что-то значит: у «автора» и «вызвавшего» он
              запасной — на случай, когда почты у человека нет; у общего адреса портала его не
              бывает вовсе. */}
          {replyToModeAllowsEmail(replyToMode) && (
            <Form.Item
              name="replyToEmail"
              label={
                replyToModeNeedsEmail(replyToMode) ? 'Адрес для ответов' : 'Запасной адрес ответа'
              }
              rules={[
                {
                  required: replyToModeNeedsEmail(replyToMode),
                  message: 'Укажите адрес для ответов',
                },
              ]}
              extra={replyToModeHints[replyToMode]}
            >
              <Input placeholder="operator@example.ru" autoComplete="off" />
            </Form.Item>
          )}

          <Form.Item
            name="comment"
            label="Комментарий"
            extra="Кому и зачем — чтобы через год было понятно"
          >
            <Input.TextArea rows={2} maxLength={500} />
          </Form.Item>

          <Form.Item name="isEnabled" label="Рассылка включена" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

import { useState } from 'react';
import { App, Alert, Button, DatePicker, Empty, Form, Input, InputNumber, Space, Table, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WasteTicketBlindCheckTaskDto } from '@technic/contracts';
import { wasteTicketBlindQueueQuery, wasteTicketKeys, wasteTicketsApi } from '@entities/waste-ticket';
import { FilePreviewModal } from '../../../components/FileLinks';
import { errorMessage } from '../../../utils/format';

/**
 * Очередь слепой перепроверки: экран второго человека (ADR 0114, Р31).
 *
 * Смысл работы — прочитать бумагу **не видя**, что прочитала машина. Поэтому здесь нет ни
 * распознанных значений, ни подтверждённых: их нет в ответе сервера вовсе. Спрячь мы их вёрсткой,
 * слепота держалась бы тем, открыл человек инструменты разработчика или нет, — а от этого зависит
 * вся метрика качества.
 *
 * Что человек видит: чья заявка, какой файл открыть, какая страница и какой по счёту талон на ней
 * (на кадре их законно бывает два). Что вписывает: номер, дату, объём — ровно те три поля, по
 * которым потом сравниваются чтения. Вид работ и адрес в перепроверку не входят: она меряет
 * качество чтения рукописи, а не разметку бланка, и полминуты чужого времени тратятся на то, за
 * что платят.
 *
 * Совпало — строка закрывается сама. Разошлось — уходит в разбор к третьему человеку: сама по себе
 * перепроверка показывает, что чтения разные, но не кто прав.
 */
interface Values {
  number: string;
  issuedOn: Dayjs | null;
  volumeM3: number | null;
}

export function BlindCheckQueue() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const [active, setActive] = useState<WasteTicketBlindCheckTaskDto | null>(null);
  const [preview, setPreview] = useState<WasteTicketBlindCheckTaskDto | null>(null);
  const { data, isLoading } = useQuery(wasteTicketBlindQueueQuery(true));

  const send = useMutation<{ status: string }, Error, Values>({
    mutationFn: (v) =>
      wasteTicketsApi.blindCheck(active!.requestId, active!.ticketId, {
        // Пустая строка — это ответ «номер не читается», а не отсутствие ответа: пропущенный ключ
        // был бы неотличим от «поля не было на бланке», и совпадение по нему засчиталось бы само.
        number: v.number?.trim() ?? '',
        issuedOn: v.issuedOn ? v.issuedOn.format('YYYY-MM-DD') : null,
        volumeM3: v.volumeM3 ?? null,
      }),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: wasteTicketKeys.blindQueue() });
      message.success(
        res.status === 'match'
          ? 'Прочитано так же, как машина — задание закрыто'
          : 'Чтения разошлись: талон ушёл на разбор',
      );
      setActive(null);
      form.resetFields();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  if (isLoading) return <Typography.Text type="secondary">Загружаем очередь…</Typography.Text>;
  const items = data?.items ?? [];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="Прочитайте талон сами, не заглядывая в карточку заявки"
        description="Так измеряется, насколько верно машина читает рукопись. Совпадёт — задание закроется само; разойдётся — талон посмотрит третий человек."
      />

      {items.length === 0 ? (
        <Empty description="Заданий нет" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <Table<WasteTicketBlindCheckTaskDto>
          size="small"
          rowKey="id"
          dataSource={items}
          pagination={false}
          columns={[
            {
              title: 'Заявка',
              key: 'request',
              width: 220,
              render: (_, row) => (
                <Space direction="vertical" size={0}>
                  <Typography.Text>М-{row.requestNum}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {row.objectName}
                  </Typography.Text>
                </Space>
              ),
            },
            {
              title: 'Что читать',
              key: 'what',
              render: (_, row) => (
                <Space direction="vertical" size={0}>
                  <Typography.Text style={{ fontSize: 12 }}>
                    {row.filename || 'файл без имени'}
                    {row.pageNo != null ? `, страница ${row.pageNo}` : ''}
                  </Typography.Text>
                  {row.ticketsOnPage > 1 && (
                    <Typography.Text type="warning" style={{ fontSize: 12 }}>
                      на кадре {row.ticketsOnPage} талона — читайте {row.seq}-й
                    </Typography.Text>
                  )}
                </Space>
              ),
            },
            {
              title: '',
              key: 'actions',
              width: 200,
              render: (_, row) => (
                <Space size={4}>
                  <Button size="small" disabled={!row.fileId} onClick={() => setPreview(row)}>
                    Открыть скан
                  </Button>
                  <Button
                    size="small"
                    type={active?.id === row.id ? 'primary' : 'default'}
                    onClick={() => {
                      setActive(row);
                      form.resetFields();
                    }}
                  >
                    Прочитать
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      )}

      {active && (
        <Form form={form} layout="inline" onFinish={(v) => send.mutate(v)}>
          <Typography.Text strong style={{ marginInlineEnd: 8 }}>
            М-{active.requestNum}:
          </Typography.Text>
          <Form.Item name="number" label="№ талона">
            <Input style={{ width: 160 }} maxLength={64} placeholder="как на бланке" allowClear />
          </Form.Item>
          <Form.Item name="issuedOn" label="Дата">
            <DatePicker format="DD.MM.YYYY" allowClear />
          </Form.Item>
          <Form.Item name="volumeM3" label="Объём, м³">
            <InputNumber style={{ width: 120 }} min={0} step={1} />
          </Form.Item>
          <Form.Item>
            <Space size={4}>
              <Button type="primary" htmlType="submit" loading={send.isPending}>
                Отправить чтение
              </Button>
              <Button onClick={() => setActive(null)}>Отложить</Button>
            </Space>
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12, width: '100%', marginTop: 4 }}>
            Не читается — оставьте поле пустым: «не разобрать» это тоже ответ.
          </Typography.Text>
        </Form>
      )}

      {preview?.fileId && (
        <FilePreviewModal
          file={{ id: preview.fileId, filename: preview.filename }}
          open
          onClose={() => setPreview(null)}
        />
      )}
    </Space>
  );
}

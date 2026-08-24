import { useState } from 'react';
import { App, Button, Checkbox, DatePicker, Form, Input, InputNumber, Modal, Space, Table, Tag, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  WasteTicketArbitratedReadingDto,
  WasteTicketBlindCheckDto,
  WasteTicketBlindCheckField,
  WasteTicketReadingDto,
} from '@technic/contracts';
import { wasteTicketKeys, wasteTicketsApi } from '@entities/waste-ticket';
import { errorMessage } from '../../../utils/format';
import { ticketDate } from './ticketDate';

/**
 * Слепые перепроверки талонов и арбитраж расхождений (ADR 0114, Р31).
 *
 * Перепроверка сама по себе не измеряет ошибки: она показывает, что два независимых чтения
 * разошлись, но не говорит, кто прав. Поэтому здесь два разных состояния и только одно из них
 * требует работы: `match` — чтения совпали, строка закрыта сама; `mismatch` — ждёт третьего
 * человека.
 *
 * Арбитр вписывает **верные значения по полям**, а не один вердикт: правота бывает разной — номер
 * за машиной, дата за человеком, объём мимо у обоих, — и единым словом такую строку не описать.
 * Разобрать нужно **каждое** разошедшееся поле: частично закрытая строка хуже неразобранной именно
 * тем, что выглядит законченной (это же держит `CHECK` в базе, здесь — чтобы отказ пришёл до
 * запроса).
 */
const FIELD_LABELS: Record<WasteTicketBlindCheckField, string> = {
  number: 'Номер',
  issuedOn: 'Дата',
  volumeM3: 'Объём',
};

/**
 * Значение поля любого из трёх чтений. У итога арбитража номер обнуляем («верного номера на бланке
 * нет»), у чтений — пустая строка: для чтения «не читается» это ответ, а не отсутствие ответа.
 */
function readingValue(
  reading: WasteTicketReadingDto | WasteTicketArbitratedReadingDto,
  field: WasteTicketBlindCheckField,
): string {
  if (field === 'number') return reading.number || '(пусто)';
  // Дата человеку — по-русски; `YYYY-MM-DD` остаётся форматом обмена, а не показа.
  if (field === 'issuedOn') return reading.issuedOn ? ticketDate(reading.issuedOn) : '(пусто)';
  return reading.volumeM3 == null ? '(пусто)' : `${reading.volumeM3} м³`;
}

/** Поля, по которым чтения разошлись, — ровно то, что обязан разобрать арбитр. */
function divergedFields(check: WasteTicketBlindCheckDto): WasteTicketBlindCheckField[] {
  const fields: WasteTicketBlindCheckField[] = [];
  if ((check.review.number || '') !== (check.baseline.number || '')) fields.push('number');
  if ((check.review.issuedOn ?? null) !== (check.baseline.issuedOn ?? null)) fields.push('issuedOn');
  if ((check.review.volumeM3 ?? null) !== (check.baseline.volumeM3 ?? null)) fields.push('volumeM3');
  return fields;
}

export function BlindCheckPanel({
  requestId,
  checks,
}: {
  requestId: string;
  checks: readonly WasteTicketBlindCheckDto[];
}) {
  const [arbitrating, setArbitrating] = useState<WasteTicketBlindCheckDto | null>(null);
  if (checks.length === 0) return null;

  return (
    <>
      <Table<WasteTicketBlindCheckDto>
        size="small"
        rowKey="id"
        dataSource={[...checks]}
        pagination={false}
        title={() => 'Слепая перепроверка'}
        columns={[
          {
            title: 'Состояние',
            key: 'status',
            width: 150,
            render: (_, row) =>
              row.status === 'pending' ? (
                <Tag color="processing">ждёт проверяющего</Tag>
              ) : row.status === 'match' ? (
                <Tag color="success">чтения совпали</Tag>
              ) : row.status === 'mismatch' ? (
                <Tag color="error">разошлись</Tag>
              ) : (
                <Tag color="default">разобрано</Tag>
              ),
          },
          {
            title: 'Машина / человек',
            key: 'readings',
            render: (_, row) => {
              if (row.status === 'pending') {
                return (
                  <Typography.Text type="secondary">
                    Задание не взято — чтения пока нет
                  </Typography.Text>
                );
              }
              const diverged = new Set(divergedFields(row));
              return (
                <Space direction="vertical" size={0}>
                  {(['number', 'issuedOn', 'volumeM3'] as const).map((field) => (
                    <Typography.Text
                      key={field}
                      type={diverged.has(field) ? 'danger' : 'secondary'}
                      style={{ fontSize: 12 }}
                    >
                      {FIELD_LABELS[field]}: {readingValue(row.baseline, field)} /{' '}
                      {readingValue(row.review, field)}
                      {row.final && row.resolvedFields.includes(field)
                        ? ` → ${readingValue(row.final, field)}`
                        : ''}
                    </Typography.Text>
                  ))}
                </Space>
              );
            },
          },
          {
            title: 'Кто',
            key: 'people',
            width: 200,
            render: (_, row) => (
              <Space direction="vertical" size={0}>
                {row.checkerName && (
                  <Typography.Text style={{ fontSize: 12 }}>
                    прочитал: {row.checkerName}
                  </Typography.Text>
                )}
                {row.arbiterName && (
                  <Typography.Text style={{ fontSize: 12 }}>
                    разобрал: {row.arbiterName}
                  </Typography.Text>
                )}
              </Space>
            ),
          },
          {
            title: '',
            key: 'actions',
            width: 110,
            render: (_, row) =>
              row.status === 'mismatch' ? (
                <Button size="small" type="link" onClick={() => setArbitrating(row)}>
                  Разобрать
                </Button>
              ) : null,
          },
        ]}
      />
      <ArbitrateModal
        requestId={requestId}
        check={arbitrating}
        onClose={() => setArbitrating(null)}
      />
    </>
  );
}

interface ArbitrateValues {
  fields: WasteTicketBlindCheckField[];
  number?: string;
  issuedOn?: Dayjs | null;
  volumeM3?: number | null;
}

function ArbitrateModal({
  requestId,
  check,
  onClose,
}: {
  requestId: string;
  check: WasteTicketBlindCheckDto | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<ArbitrateValues>();
  const diverged = check ? divergedFields(check) : [];

  const save = useMutation<void, Error, ArbitrateValues>({
    mutationFn: async (v) => {
      const fields = v.fields ?? [];
      await wasteTicketsApi.arbitrate(requestId, check!.id, {
        resolvedFields: fields,
        // Ключ поля и его имя в `resolvedFields` идут вместе, в обе стороны: значение без разбора
        // — тихая выдумка, разбор без ключа теряет различие между «верного значения нет вовсе» и
        // «поле не разобрано».
        ...(fields.includes('number') ? { number: v.number?.trim() || null } : {}),
        ...(fields.includes('issuedOn')
          ? { issuedOn: v.issuedOn ? v.issuedOn.format('YYYY-MM-DD') : null }
          : {}),
        ...(fields.includes('volumeM3') ? { volumeM3: v.volumeM3 ?? null } : {}),
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: wasteTicketKeys.list(requestId) });
      message.success('Расхождение разобрано');
      onClose();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  return (
    <Modal
      open={!!check}
      title="Кто прочитал верно"
      okText="Записать разбор"
      cancelText="Отмена"
      confirmLoading={save.isPending}
      onCancel={onClose}
      onOk={() => form.submit()}
      destroyOnHidden
    >
      {check && (
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            fields: diverged,
            number: check.baseline.number,
            issuedOn: check.baseline.issuedOn ? dayjs(check.baseline.issuedOn) : null,
            volumeM3: check.baseline.volumeM3,
          }}
          onFinish={(v) => {
            // Разобрать нужно каждое разошедшееся поле: строка, закрытая наполовину, выглядит
            // законченной и потому хуже неразобранной.
            const missing = diverged.filter((f) => !(v.fields ?? []).includes(f));
            if (missing.length > 0) {
              message.error(
                `Разберите все разошедшиеся поля: ${missing.map((f) => FIELD_LABELS[f]).join(', ')}`,
              );
              return;
            }
            save.mutate(v);
          }}
        >
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            Слева — что прочитала машина, справа — второй человек. Впишите верное значение; если
            его на бланке нет вовсе, оставьте поле пустым.
          </Typography.Paragraph>
          <Form.Item name="fields" label="Разобранные поля">
            <Checkbox.Group
              options={diverged.map((f) => ({
                value: f,
                label: `${FIELD_LABELS[f]}: ${readingValue(check.baseline, f)} / ${readingValue(check.review, f)}`,
              }))}
            />
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(a: ArbitrateValues, b: ArbitrateValues) => a.fields !== b.fields}
          >
            {({ getFieldValue }) => {
              const fields: WasteTicketBlindCheckField[] = getFieldValue('fields') ?? [];
              return (
                <>
                  {fields.includes('number') && (
                    <Form.Item name="number" label="Верный номер">
                      <Input maxLength={64} allowClear />
                    </Form.Item>
                  )}
                  {fields.includes('issuedOn') && (
                    <Form.Item name="issuedOn" label="Верная дата">
                      <DatePicker style={{ width: '100%' }} format="DD.MM.YYYY" allowClear />
                    </Form.Item>
                  )}
                  {fields.includes('volumeM3') && (
                    <Form.Item name="volumeM3" label="Верный объём, м³">
                      <InputNumber style={{ width: '100%' }} min={0} step={1} />
                    </Form.Item>
                  )}
                </>
              );
            }}
          </Form.Item>
        </Form>
      )}
    </Modal>
  );
}

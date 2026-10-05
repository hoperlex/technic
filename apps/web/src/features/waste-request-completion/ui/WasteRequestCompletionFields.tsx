import { Button, DatePicker, Form, Input, InputNumber, Space, Typography, Upload } from 'antd';
import type { UploadProps } from 'antd';
import { CameraOutlined, UploadOutlined } from '@ant-design/icons';
import type { FileDto, WasteRequestDto } from '@technic/contracts';
import { FileLinkList } from '@entities/file';
import { formatMoney, useIsMobile } from '@shared/lib';
import { FormGrid } from '@shared/ui';

interface Props {
  beforeUploadTicket: NonNullable<UploadProps['beforeUpload']>;
  byVolume: boolean;
  byWeight: boolean;
  calculated: number | null;
  changeVolume: (value: number | null) => void;
  costDiffers: boolean;
  noTicketYet: boolean;
  onCostChange: () => void;
  onRemoveTicket: (file: FileDto) => void;
  priceIsMinimum: boolean;
  pricePerM3: number | null;
  request: WasteRequestDto;
  tickets: FileDto[];
  totalCost: number | null | undefined;
  uploading: boolean;
  volumeDiff: number | null;
}

/** Present completion facts and ticket evidence without owning their mutation or draft lifetime. */
export function WasteRequestCompletionFields({
  beforeUploadTicket,
  byVolume,
  byWeight,
  calculated,
  changeVolume,
  costDiffers,
  noTicketYet,
  onCostChange,
  onRemoveTicket,
  priceIsMinimum,
  pricePerM3,
  request,
  tickets,
  totalCost,
  uploading,
  volumeDiff,
}: Props) {
  const isMobile = useIsMobile();
  return (
    <FormGrid>
      <FormGrid.Full>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          Заявка № {request.displayNumber}, {request.objectName}
          {request.volumeM3 != null ? ` · заявлено ${request.volumeM3} м³` : ''}
          {request.amount != null ? ` на ${formatMoney(request.amount)}` : ''}
        </Typography.Paragraph>
      </FormGrid.Full>

      {/* Scrap is reported as one weight (ADR 0067): no estimate, no cost, no comparison with the
          plan, because the request carries none. The single field takes the full row because there
          is nothing to put beside it. */}
      {byWeight && (
        <FormGrid.Full>
          <Form.Item
            name="weightTons"
            label="Сдано металлолома, т"
            rules={[
              { required: true, message: 'Укажите вес' },
              {
                // Three decimals is what the database stores: extra digits would be rejected by the
                // server only after submit.
                validator: (_rule, value: number | undefined) =>
                  value == null || Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-6
                    ? Promise.resolve()
                    : Promise.reject(new Error('Не более 3 знаков после запятой')),
              },
            ]}
            extra="По приёмо-сдаточному акту"
          >
            <InputNumber style={{ width: '100%' }} min={0} step={0.1} placeholder="Например, 3,2" />
          </Form.Item>
        </FormGrid.Full>
      )}

      {byVolume && (
        <>
          {/* Volume and cost sit in adjacent cells because they are checked against each other. */}
          <Form.Item
            name="volumeM3"
            label="Вывезено, м³"
            rules={[
              { required: true, message: 'Укажите объём' },
              {
                // Volume is weighed, so fractions are normal, but not unbounded: three decimals is
                // what the database stores, and extra digits would be rejected by the server only
                // after submit.
                validator: (_rule, value: number | undefined) =>
                  value == null || Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-6
                    ? Promise.resolve()
                    : Promise.reject(new Error('Не более 3 знаков после запятой')),
              },
            ]}
            extra={
              volumeDiff != null && volumeDiff !== 0
                ? `Заявлено ${request.volumeM3} м³ (${volumeDiff > 0 ? '+' : ''}${volumeDiff} м³)`
                : undefined
            }
          >
            <InputNumber
              style={{ width: '100%' }}
              min={0}
              step={1}
              placeholder="По талону"
              onChange={changeVolume}
            />
          </Form.Item>
          <Form.Item
            name="removedOn"
            label="Дата вывоза"
            extra="Дата с талона, а не дата закрытия в портале"
          >
            <DatePicker style={{ width: '100%' }} format="DD.MM.YYYY" allowClear />
          </Form.Item>
          <Form.Item
            name="totalCost"
            label="Стоимость, ₽"
            extra={
              pricePerM3 != null
                ? `${priceIsMinimum ? 'от ' : ''}${formatMoney(pricePerM3)}/м³ по прайсу`
                : 'Цены на этот тип мусора в прайсе нет — укажите сумму'
            }
          >
            <InputNumber
              style={{ width: '100%' }}
              min={0}
              step={1000}
              precision={2}
              onChange={onCostChange}
            />
          </Form.Item>
          <FormGrid.Full>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 16 }}>
              {costDiffers && (
                <Typography.Text type="warning">
                  Сумма отличается от расчёта ({formatMoney(calculated)}) — в заявке сохранится
                  введённая
                </Typography.Text>
              )}
              {/* The request was issued as a plan and payment follows the fact: a different amount
                  is not an error, but the user must see it before pressing "Done". */}
              {totalCost != null && request.amount != null && totalCost !== request.amount && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Заявка оформлена на {formatMoney(request.amount)} — закрытие сохранит{' '}
                  {formatMoney(totalCost)}
                </Typography.Text>
              )}
              {priceIsMinimum && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Оператор не назначен — расчёт по минимальной цене среди операторов
                </Typography.Text>
              )}
            </div>
          </FormGrid.Full>
        </>
      )}

      {/* Tickets are the request-wide pool (ADR 0024): paper for the whole completion, not split by
          vehicle. Tickets attached by a previous completion stay on the request and are listed
          here so the same scans are not uploaded twice. */}
      <FormGrid.Full>
        <Form.Item label="Талоны" style={{ marginBottom: 16 }}>
          {/* Placeholder field: tickets live in modal state, but the rejection must appear where
              other field errors do. noStyle hands the error to the outer "Талоны" item, so scroll
              and flash find it like any other field (ADR 0094). */}
          <Form.Item name="ticketIds" noStyle>
            <Input type="hidden" />
          </Form.Item>
          {request.tickets.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Уже приложены
              </Typography.Text>
              <FileLinkList files={request.tickets} maxNameWidth={300} />
            </div>
          )}
          <Space size={8} wrap>
            {/* Camera capture only on phones (ADR 0030): the ticket is signed on site and
                photographed there. capture is a browser hint, not a guarantee that the camera
                opens, so the ordinary upload stays beside it. The type restriction applies to this
                button only; the neighbouring upload never had one. */}
            {isMobile && (
              <Upload
                showUploadList={false}
                accept="image/*"
                capture="environment"
                beforeUpload={beforeUploadTicket}
              >
                <Button icon={<CameraOutlined />} loading={uploading} danger={noTicketYet}>
                  Снять камерой
                </Button>
              </Upload>
            )}
            <Upload multiple showUploadList={false} beforeUpload={beforeUploadTicket}>
              <Button
                icon={<UploadOutlined />}
                loading={uploading}
                danger={noTicketYet && !isMobile}
              >
                Прикрепить талон
              </Button>
            </Upload>
            {noTicketYet && (
              <Typography.Text type="secondary" style={{ lineHeight: '32px' }}>
                Талон обязателен: без него заявка не закрывается
              </Typography.Text>
            )}
          </Space>
          {tickets.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <FileLinkList files={tickets} maxNameWidth={300} onRemove={onRemoveTicket} />
            </div>
          )}
        </Form.Item>
        {/* The completion comment is a request history event, not a request field: it describes
            this particular completion (what was not fully hauled, who received it). */}
        <Form.Item name="comment" label="Комментарий" style={{ marginBottom: 0 }}>
          <Input.TextArea
            rows={2}
            maxLength={2000}
            showCount
            placeholder="Необязательно: что важно знать об этом выполнении"
          />
        </Form.Item>
      </FormGrid.Full>
    </FormGrid>
  );
}

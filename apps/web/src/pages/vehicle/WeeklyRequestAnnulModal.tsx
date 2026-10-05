import { useEffect, useState } from 'react';
import { Alert, Checkbox, Form, Input, Skeleton, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  type AnnulWeeklyRequestBody,
  weeklyItemKindLabels,
  type WeeklyVehicleRequestDto,
} from '@technic/contracts';
import { weeklyRequestKeys, weeklyRequestsApi } from '@entities/weekly-request';
import { FormModal } from '@shared/ui';
import { formatDateOnly } from '@shared/lib';

/**
 * Аннулирование применённой недели (ADR 0218).
 *
 * Применение той же транзакцией продлило заказы, породило новые и зафиксировало решения «уезжает».
 * Окно отвечает на один вопрос — **чего стоит развернуть это обратно**: какие листы ЭСМ-2 сгорят,
 * какие подрежутся, какие отработанные придётся назвать поимённо, какие запланированные решения
 * погаснут и какие дни уйдут из рейсов.
 *
 * Устроено как окно проведения (`WeeklyRequestConductModal`) и по той же причине: последствия
 * считает сервер тем же кодом, которым будет их исполнять, и возвращает отпечаток, который окно
 * присылает обратно. Своего расчёта у портала нет ни одного — разойдись они, окно обещало бы не то,
 * что произойдёт.
 *
 * Предпросмотр запрашивается при **открытии окна**, а не карточки: он строит план истории и бумаги
 * по каждой продлённой строке, и платить это за каждый показ карточки незачем.
 */

interface FormValues {
  reason: string;
  unlockWaybillIds: string[];
}

interface Props {
  /** Заявка, которую аннулируют; `null` — окно закрыто. */
  request: WeeklyVehicleRequestDto | null;
  onClose: () => void;
  onAnnul: (body: AnnulWeeklyRequestBody) => void;
  pending: boolean;
}

const STATE_TAGS = {
  reversible: { color: 'green', text: 'развернётся' },
  reverted: { color: 'default', text: 'уже развёрнута' },
  blocked: { color: 'red', text: 'нельзя развернуть' },
} as const;

export function WeeklyRequestAnnulModal({ request, onClose, onAnnul, pending }: Props) {
  const [form] = Form.useForm<FormValues>();

  /**
   * Ключ идемпотентности придумывается **до** отправки и держится, пока окно открыто на этой
   * заявке: повтор после обрыва связи обязан вернуть результат прежней операции, а не развернуть
   * неделю второй раз и не сжечь второй номер бланка.
   *
   * Ключ готовится всегда, а уходит только у ветви коррекции: нужна ли операция, решает сервер
   * (`requiresOperation`), и угадывать это телу запроса незачем.
   */
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    if (!request) return;
    setOperationId(crypto.randomUUID());
    form.setFieldsValue({ reason: '', unlockWaybillIds: [] });
  }, [request, form]);

  const previewQuery = useQuery({
    queryKey: weeklyRequestKeys.annul(request?.id),
    queryFn: () => weeklyRequestsApi.annulPreview(request!.id),
    enabled: !!request,
    // Перезапрашивается при каждом открытии: между двумя показами карточки диспетчер успевает
    // выписать лист или взять заказ в работу, и устаревший отпечаток дал бы 409 на нажатии.
    staleTime: 0,
  });
  const preview = previewQuery.data;

  const submit = (values: FormValues) => {
    if (!preview) return;
    onAnnul({
      reason: values.reason,
      version: request!.version,
      fingerprint: preview.fingerprint,
      ...(preview.cancelGroupsFingerprint
        ? { cancelGroupsFingerprint: preview.cancelGroupsFingerprint }
        : {}),
      ...(preview.requiresOperation
        ? { correction: { operationId, unlockWaybillIds: values.unlockWaybillIds } }
        : {}),
    });
  };

  return (
    <FormModal
      open={!!request}
      title={`Аннулировать неделю ${request?.displayNumber ?? ''}`}
      okText="Аннулировать"
      okButtonProps={{ danger: true, disabled: !preview?.allowed }}
      confirmLoading={pending}
      onCancel={onClose}
      form={form}
      onSubmit={submit}
      width={720}
    >
      {previewQuery.isPending && <Skeleton active paragraph={{ rows: 6 }} />}

      {preview && !preview.allowed && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          title="Аннулировать нельзя"
          description={preview.blockedReason}
        />
      )}

      {preview && (
        <>
          {/* Ветвь — первой строкой: «задним числом» меняет и право, и цену, и человек обязан
              увидеть это раньше перечня строк. */}
          <Alert
            type={preview.backdated ? 'warning' : 'info'}
            showIcon
            style={{ marginBottom: 16 }}
            title={
              preview.backdated ? 'Операция идёт задним числом' : 'Снимаемые дни ещё не наступили'
            }
            description={
              <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                {preview.effectiveDate && (
                  <li>
                    Первый снимаемый день — {formatDateOnly(preview.effectiveDate)}
                    {preview.backdated ? ', он уже прошёл' : ', он ещё впереди'}.
                  </li>
                )}
                {preview.requiresOperation && (
                  <li>
                    Причина и ключ операции останутся в журнале коррекций вместе с вашим именем:
                    через месяцы по ним объяснят, почему неделю развернули.
                  </li>
                )}
                {preview.paper.cancel + preview.paper.reissue > 0 && (
                  <li>
                    Листы ЭСМ-2 будут аннулированы: {preview.paper.cancel} без замены,{' '}
                    {preview.paper.reissue} с перевыпиской. Списанный номер не возвращается.
                  </li>
                )}
                {preview.paper.trim > 0 && (
                  <li>
                    Листов с подрезкой периода: {preview.paper.trim}
                    {preview.paper.trimmedTo
                      ? ` — по ${formatDateOnly(preview.paper.trimmedTo)}`
                      : ''}
                    . Номер у них не горит.
                  </li>
                )}
                {preview.shifts.length > 0 && (
                  <li>
                    Снимутся незаполненные смены за {preview.shifts.length} дн.:{' '}
                    {preview.shifts.map(formatDateOnly).join(', ')}.
                  </li>
                )}
                {preview.linearDays.detachable.length > 0 && (
                  <li>
                    Дни уйдут из рейсов:{' '}
                    {preview.linearDays.detachable.map(formatDateOnly).join(', ')}.
                  </li>
                )}
                {preview.pendingWeeks.length > 0 && (
                  <li>
                    По тем же заказам собираются недели {preview.pendingWeeks.join(', ')} — их
                    строки после разворота придётся пересобрать: срок заказа изменится.
                  </li>
                )}
              </ul>
            }
          />

          {/* Строки состава — перечнем с ходом и причиной: отказ и окно называют препятствие
              одними словами, потому что текст один и приходит с сервера. */}
          <Typography.Paragraph strong style={{ marginBottom: 8 }}>
            Что будет со строками
          </Typography.Paragraph>
          <ul style={{ margin: '0 0 16px', paddingInlineStart: 20 }}>
            {preview.items.map((item) => (
              <li key={item.itemId} style={{ marginBottom: 4 }}>
                <Tag color={STATE_TAGS[item.state].color}>{STATE_TAGS[item.state].text}</Tag>
                {item.displayNumber ? `${item.displayNumber} · ` : ''}
                {weeklyItemKindLabels[item.kind]}
                {item.reverse === 'shorten_to' && item.shortenTo
                  ? ` — срок вернётся к ${formatDateOnly(item.shortenTo)}`
                  : item.reverse === 'cancel'
                    ? ' — заказ будет отменён'
                    : item.reverse === 'release_leave'
                      ? ' — решение об отъезде перестанет действовать'
                      : ''}
                {item.reason ? ` — ${item.reason}` : ''}
              </li>
            ))}
          </ul>

          {preview.blockers.length > 0 && (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
              title="Факты работы на снимаемых днях"
              description={
                <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                  {preview.blockers.map((blocker, index) => (
                    <li key={`${blocker.code}-${blocker.itemId}-${index}`}>
                      {blocker.message}
                      {blocker.dates.length > 0
                        ? `: ${blocker.dates.map(formatDateOnly).join(', ')}`
                        : ''}
                    </li>
                  ))}
                </ul>
              }
            />
          )}

          {preview.cancelGroups.length > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              title="Погаснут запланированные решения"
              description={
                <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                  {preview.cancelGroups.map((group, index) => (
                    <li key={`${group.effectiveDate}-${index}`}>
                      {group.title} ({group.dimensions.join(', ')}) — с{' '}
                      {formatDateOnly(group.effectiveDate)}. Их придётся завести заново, если
                      решение остаётся в силе.
                    </li>
                  ))}
                </ul>
              }
            />
          )}

          {/* Листы отработанных недель — поимённо, а не общей галочкой: в одной неделе законно
              живут листы двух машин, и «переписать все прошлые» сожгло бы не тот номер. */}
          {preview.unlockableCount > 0 && (
            <Form.Item
              name="unlockWaybillIds"
              label="Листы ЭСМ-2 к перевыписке"
              extra={
                preview.unlockable
                  ? 'Отмеченные номера будут аннулированы, взамен выпишутся новые — следующими по серии. Неотмеченный лист запирает свои дни, и неделя не аннулируется'
                  : 'Номера бланков показываются тому, кто ведёт журнал листов. Отметить их может диспетчер'
              }
            >
              {preview.unlockable ? (
                <Checkbox.Group
                  style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
                  options={preview.unlockable.map((sheet) => ({
                    value: sheet.waybillId,
                    label: `${sheet.displayNumber} · № ${sheet.number} · ${formatDateOnly(sheet.periodFrom)} – ${formatDateOnly(sheet.periodTo)}`,
                  }))}
                />
              ) : (
                <Typography.Text type="secondary">
                  Отработанных листов на снимаемых днях: {preview.unlockableCount}
                </Typography.Text>
              )}
            </Form.Item>
          )}

          {/* Причина обязательна всегда, а не только у ветви коррекции: она объясняет сам
              документ — почему эту неделю развернули, — и остаётся в его шапке. */}
          <Form.Item
            name="reason"
            label="Причина аннулирования"
            rules={[{ required: true, message: 'Укажите причину' }]}
            extra={
              preview.requiresOperation
                ? 'Останется в шапке заявки и в журнале коррекций, а также в листах, переоформленных этой операцией'
                : 'Останется в шапке заявки и в её истории'
            }
          >
            <Input.TextArea rows={2} maxLength={2000} showCount />
          </Form.Item>
        </>
      )}
    </FormModal>
  );
}

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
import { WEEKLY_REVERSAL_TEXTS, type WeeklyReversalIntent } from '../model/reversalTexts';

/**
 * Reversal of an applied week — annulment (ADR 0218) or return for re-approval (ADR 0219).
 *
 * The approval extended orders, created new ones and fixed "leaving" decisions in the same
 * transaction. The window answers one question — **what it costs to roll that back**: which ESM-2
 * sheets burn, which are trimmed, which worked ones must be named, which planned decisions are
 * cancelled and which days leave routes. Both commands run the same plan, so the window is one; the
 * intent changes only what the person is told the week becomes.
 *
 * Built like the conduct window (`WeeklyRequestConductModal`) for the same reason: the server
 * computes the consequences with the code that will execute them and returns a fingerprint the
 * window sends back. The portal has no computation of its own — otherwise the window would promise
 * something other than what happens.
 *
 * The preview is requested when the **window opens**, not with the card: it builds a history and
 * paper plan per extended row, and paying that on every card view is waste.
 */

interface FormValues {
  reason: string;
  unlockWaybillIds: string[];
}

interface Props {
  intent: WeeklyReversalIntent;
  /** The request being reversed; `null` — the window is closed. */
  request: WeeklyVehicleRequestDto | null;
  onClose: () => void;
  onSubmit: (body: AnnulWeeklyRequestBody) => void;
  pending: boolean;
}

const STATE_TAGS = {
  reversible: { color: 'green', text: 'развернётся' },
  reverted: { color: 'default', text: 'уже развёрнута' },
  blocked: { color: 'red', text: 'нельзя развернуть' },
} as const;

export function WeeklyRequestReversalModal({ intent, request, onClose, onSubmit, pending }: Props) {
  const [form] = Form.useForm<FormValues>();
  const texts = WEEKLY_REVERSAL_TEXTS[intent];

  /**
   * The idempotency key is invented **before** sending and kept while the window is open on this
   * request: a repeat after a dropped connection must return the earlier result, not reverse the
   * week a second time and burn a second form number.
   *
   * The key is always prepared but sent only in the correction branch: whether an operation is
   * needed is decided by the server (`requiresOperation`), and the request body need not guess.
   */
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    if (!request) return;
    setOperationId(crypto.randomUUID());
    form.setFieldsValue({ reason: '', unlockWaybillIds: [] });
  }, [request, form]);

  const previewQuery = useQuery({
    queryKey:
      intent === 'annul'
        ? weeklyRequestKeys.annul(request?.id)
        : weeklyRequestKeys.returnPreview(request?.id),
    queryFn: () =>
      intent === 'annul'
        ? weeklyRequestsApi.annulPreview(request!.id)
        : weeklyRequestsApi.returnPreview(request!.id),
    enabled: !!request,
    // Refetched on every opening: between two views of the card the dispatcher manages to issue a
    // sheet or take an order into work, and a stale fingerprint would give 409 on the click.
    staleTime: 0,
  });
  const preview = previewQuery.data;

  const submit = (values: FormValues) => {
    if (!preview) return;
    onSubmit({
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
      title={request ? `${request.displayNumber} · ${texts.title}` : texts.emptyTitle}
      okText={texts.okText}
      okDanger
      okDisabled={!preview?.allowed}
      confirmLoading={pending}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      width={720}
    >
      <Form<FormValues> form={form} layout="vertical" onFinish={submit}>
        {previewQuery.isPending && <Skeleton active paragraph={{ rows: 6 }} />}

        {preview && !preview.allowed && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
            title={texts.refusedTitle}
            description={preview.blockedReason}
          />
        )}

        {preview && (
          <>
            {/* The branch comes first: «backdated» changes both the right and the price, and the
                person must see it before the list of rows. A week whose consequences were already
                rolled back by hand removes no days at all — saying «the days have not come yet»
                there would describe days that do not exist (ADR 0218 решение 4). */}
            <Alert
              type={preview.backdated ? 'warning' : 'info'}
              showIcon
              style={{ marginBottom: 16 }}
              title={
                preview.backdated
                  ? 'Операция идёт задним числом'
                  : preview.items.every((item) => item.state !== 'reversible')
                    ? texts.nothingLeft
                    : preview.effectiveDate
                      ? 'Снимаемые дни ещё не наступили'
                      : 'Сроки заказов не двигаются'
              }
              description={
                <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                  {texts.outcome && <li>{texts.outcome}</li>}
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

            {/* Composition rows as a list with their move and reason: the refusal and the window
              name an obstacle in the same words, because the text is one and comes from the server. */}
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

            {/* Sheets of worked weeks are named one by one, not by a common checkbox: two vehicles'
              sheets legally live in one week, and "rewrite all past ones" would burn the wrong number. */}
            {preview.unlockableCount > 0 && (
              <Form.Item
                name="unlockWaybillIds"
                label="Листы ЭСМ-2 к перевыписке"
                extra={
                  preview.unlockable
                    ? `Отмеченные номера будут аннулированы, взамен выпишутся новые — следующими по серии. ${texts.unnamedSheet}`
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

            {/* The reason is always required, not only in the correction branch: it explains the
              document itself — why this week was rolled back. */}
            <Form.Item
              name="reason"
              label={texts.reasonLabel}
              rules={[{ required: true, message: 'Укажите причину' }]}
              extra={
                preview.requiresOperation
                  ? 'Останется в шапке заявки и в журнале коррекций, а также в листах, переоформленных этой операцией'
                  : texts.reasonStays
              }
            >
              <Input.TextArea rows={2} maxLength={2000} showCount />
            </Form.Item>
          </>
        )}
      </Form>
    </FormModal>
  );
}

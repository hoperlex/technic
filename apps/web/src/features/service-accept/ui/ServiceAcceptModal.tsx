import { useEffect, useState } from 'react';
import { Alert, App, Input, Space, Typography } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { serviceFileKindLabels, type ServiceRequestDto } from '@technic/contracts';
import {
  missingClosingDocuments,
  serviceRequestKeys,
  serviceRequestsApi,
} from '@entities/service-request';
import { officeEquipmentKeys } from '@entities/office-equipment';
import { FormModal } from '@shared/ui';
import { errorMessage } from '@shared/lib';

export type AcceptMode = 'accept' | 'rework';

function money(value: number | null): string {
  if (value == null) return '—';
  return `${value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

/**
 * Приёмка и возврат на доработку (§9.3) — два ответа на один и тот же предъявленный факт, и
 * потому одно окно с двумя режимами: решают по одним и тем же цифрам, отличается лишь цена
 * решения. У возврата она высокая — стираются отметки выполнения, итог и посчитанные гарантии, —
 * поэтому там обязательна причина и красная кнопка.
 *
 * Нехватка акта приёмке не мешает (Р16): «акт пришлю завтра» — рабочее состояние, и держать из-за
 * него работу непринятой значило бы копить неразобранные заявки. Портал о нехватке предупреждает,
 * а заявка остаётся в очереди «Ожидаются документы», пока бумагу не подошьют.
 */
export function ServiceAcceptModal({
  request,
  mode,
  onClose,
}: {
  /** `null` — окно закрыто. */
  request: ServiceRequestDto | null;
  mode: AcceptMode;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const rework = mode === 'rework';

  useEffect(() => {
    if (request) setText('');
  }, [request, mode]);

  const mutation = useMutation({
    mutationFn: () =>
      rework
        ? serviceRequestsApi.rework(request!.id, {
            reason: text.trim(),
            version: request!.version,
          })
        : serviceRequestsApi.accept(request!.id, {
            comment: text.trim(),
            version: request!.version,
          }),
    onSuccess: () => {
      message.success(rework ? 'Заявка возвращена в работу' : 'Работы приняты');
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      onClose();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const submit = () => {
    if (rework && !text.trim()) {
      message.warning('Укажите, что доделать');
      return;
    }
    mutation.mutate();
  };

  const missing = request ? missingClosingDocuments(request) : [];

  return (
    <FormModal
      title={
        rework
          ? `Вернуть на доработку ${request?.displayNumber ?? ''}`
          : `Принять работу ${request?.displayNumber ?? ''}`
      }
      open={!!request}
      onCancel={onClose}
      onSubmit={submit}
      confirmLoading={mutation.isPending}
      okText={rework ? 'Вернуть на доработку' : 'Принять'}
      okDanger={rework}
      width={520}
    >
      {request && (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type={rework ? 'warning' : 'info'}
            showIcon
            message={
              rework
                ? 'Факт закрытия будет стёрт'
                : `Предъявлено ${money(request.completion?.totalAmount ?? null)}`
            }
            description={
              rework
                ? 'Отметки выполнения, итог и посчитанные гарантии снимутся: исполнитель закроет работы заново. Смета и документы останутся на месте.'
                : `Исполнитель: ${request.service?.name ?? '—'}. После приёмки заявка закрыта: документы подшить к ней можно и потом.`
            }
          />

          {!rework && missing.length > 0 && (
            <Alert
              type="warning"
              showIcon
              message={`Не подшиты документы: ${missing.map((kind) => serviceFileKindLabels[kind].toLowerCase()).join(', ')}`}
              description="Принять можно и так — заявка останется в очереди «Ожидаются документы»."
            />
          )}

          <div>
            <Typography.Text strong>{rework ? 'Что доделать' : 'Комментарий'}</Typography.Text>
            <Input.TextArea
              rows={3}
              maxLength={1000}
              value={text}
              autoFocus
              style={{ marginTop: 4 }}
              placeholder={
                rework
                  ? 'Причина возврата: она уйдёт в историю и будет видна исполнителю'
                  : 'Необязательно'
              }
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        </Space>
      )}
    </FormModal>
  );
}

import { useState } from 'react';
import { Button, Typography } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { hasServiceClosingDocument, type ServiceRequestDto } from '@technic/contracts';
import { filesApi } from '@entities/file';
import { ServiceDocumentUpload, serviceRequestKeys } from '@entities/service-request';
import { officeEquipmentKeys } from '@entities/office-equipment';
import { ViewModal } from '@shared/ui';
import type { EstimateEditorIntent } from '../model/useEstimateEditor';

export function estimateEditorModalTitle(
  request: ServiceRequestDto | null,
  intent: EstimateEditorIntent,
): string {
  const prefix =
    intent === 'breakdown'
      ? 'Раскладка объёма работ заявки'
      : intent === 'work_done'
        ? 'Работы выполнены'
        : intent === 'document'
          ? 'Документы выполненных работ'
          : 'Объём работ заявки';
  return request ? `${prefix} ${request.displayNumber}` : prefix;
}

export function DirectDocumentIntro({ workDone }: { workDone: boolean }) {
  return (
    <Typography.Text>
      {workDone
        ? 'Приложите счёт или скриншот: документ будет принят как результат работ и согласован автоматически.'
        : 'Приложите счёт или скриншот вместо заполнения перечня услуг.'}
    </Typography.Text>
  );
}

export function WorkDoneNotice() {
  return (
    <Typography.Text type="secondary">
      Отдельное согласование не требуется: отметка «Работы выполнены» применит автосогласование.
      После отправки откроется загрузка акта.
    </Typography.Text>
  );
}

/**
 * The submit response becomes the source for the second step. Query invalidation alone cannot
 * update the DTO captured when the modal was opened, so every attach response replaces it here.
 */
export function WorkCompletedActStep({
  request,
  onClose,
}: {
  request: ServiceRequestDto;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [current, setCurrent] = useState(request);
  const actAttached = hasServiceClosingDocument(current, current.estimateFormat ?? null);
  const automaticallyApproved =
    current.approval?.revision === current.estimateRevision && current.approval.source === 'auto';

  return (
    <ViewModal
      title={`Работы выполнены ${current.displayNumber}`}
      open
      onClose={onClose}
      width={640}
      destroyOnHidden
      footer={[
        <Button key="done" type="primary" onClick={onClose}>
          Готово
        </Button>,
      ]}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Typography.Text>
          {automaticallyApproved
            ? 'Документ принят, согласование выполнено автоматически.'
            : 'Документ принят и передан на согласование.'}
        </Typography.Text>
        <Typography.Text type="secondary">
          Теперь можно сразу подшить закрывающий акт. Статус заявки изменится отдельным действием
          «Закрыть работы» после загрузки акта.
        </Typography.Text>
        <ServiceDocumentUpload
          requestId={current.id}
          kinds={['act']}
          upload={filesApi.upload}
          onUploaded={(updated) => {
            setCurrent(updated);
            void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
            void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
          }}
        />
        {actAttached && (
          <Typography.Text type="success">
            Акт подшит — действие «Закрыть работы» доступно в заявке.
          </Typography.Text>
        )}
      </div>
    </ViewModal>
  );
}

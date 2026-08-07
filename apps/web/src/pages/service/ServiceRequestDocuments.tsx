import { useState } from 'react';
import { Alert, App, Button, Select, Space, Typography, Upload } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  isServiceRequestClosed,
  SERVICE_FILE_KINDS,
  type ServiceFileKind,
  serviceFileKindLabels,
  type ServiceRequestDto,
  type ServiceRequestStatus,
} from '@technic/contracts';
import {
  missingClosingDocuments,
  serviceRequestKeys,
  serviceRequestsApi,
} from '@entities/service-request';
import { filesApi } from '../../api/resources';
import { FileLinkList } from '../../components/FileLinks';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';

/**
 * Какие виды документов заявка принимает в этом статусе (§8.3). Портал не решает — решает
 * сервер; здесь этот же перечень, чтобы человек не выбирал вид, на котором получит отказ.
 *
 * Правило одной строкой: до терминального статуса файлы живут обычной жизнью; после него заявка
 * принимает бумаги и ничего не отдаёт (Р16, Р29) — акт и счёт присылают и через неделю.
 */
function attachableKinds(status: ServiceRequestStatus): ServiceFileKind[] {
  const closed = isServiceRequestClosed(status);
  const afterWork = status === 'in_work' || status === 'done' || closed;
  return SERVICE_FILE_KINDS.filter((kind) => {
    switch (kind) {
      case 'attachment':
        return !closed;
      case 'estimate':
        return status === 'diagnostics' || status === 'estimate_review';
      case 'act':
      case 'invoice':
        return afterWork;
      case 'warranty_card':
        return status === 'done' || closed;
    }
  });
}

/**
 * Документы заявки по видам (§9.4). Общей кучей их держать нельзя: вопрос к этой вкладке — не
 * «что приложено», а «есть ли акт», и в списке из восьми файлов ответ на него теряется.
 *
 * Чего не хватает — сказано прямо: «закрыто, но акта нет» — рабочее состояние, из-за которого и
 * заведена очередь «Ожидаются документы».
 */
export function ServiceRequestDocuments({ request }: { request: ServiceRequestDto }) {
  const { message } = App.useApp();
  const { can } = useAuth();
  const qc = useQueryClient();
  const kinds = attachableKinds(request.status);
  const [kind, setKind] = useState<ServiceFileKind>(kinds[0] ?? 'attachment');
  const [uploading, setUploading] = useState(false);

  // Снятие документа после приёмки — только у распорядителя файлов: заявка закрыта, и подшитая
  // бумага из неё не исчезает по решению стороны (Р29).
  const canAttach = can('serviceRequests.files') && kinds.length > 0 && !request.deletedAt;
  const canDetach =
    !request.deletedAt &&
    (can('files.manageAny') ||
      (can('serviceRequests.files') && !isServiceRequestClosed(request.status)));

  const refresh = () => void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });

  const attach = useMutation({
    mutationFn: async (file: File) => {
      const uploaded = await filesApi.upload(file);
      return serviceRequestsApi.attachFiles(request.id, [uploaded.id], kind);
    },
    onSuccess: () => {
      message.success('Документ подшит');
      refresh();
    },
    onError: (e) => message.error(errorMessage(e)),
    onSettled: () => setUploading(false),
  });

  const detach = useMutation({
    mutationFn: (fileId: string) => serviceRequestsApi.detachFile(request.id, fileId),
    onSuccess: () => {
      message.success('Документ снят');
      refresh();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const missing = missingClosingDocuments(request);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {missing.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`Не хватает: ${missing.map((k) => serviceFileKindLabels[k].toLowerCase()).join(', ')}`}
          description="Заявка стоит в очереди «Ожидаются документы», пока их не подошьют."
        />
      )}

      {SERVICE_FILE_KINDS.map((fileKind) => {
        const files = request.files.filter((file) => file.kind === fileKind);
        if (files.length === 0) return null;
        return (
          <div key={fileKind}>
            <Typography.Text strong>{serviceFileKindLabels[fileKind]}</Typography.Text>
            <FileLinkList
              files={files}
              maxNameWidth={420}
              onRemove={canDetach ? (file) => detach.mutate(file.id) : undefined}
            />
          </div>
        );
      })}

      {request.files.length === 0 && (
        <Typography.Text type="secondary">К заявке ничего не подшито</Typography.Text>
      )}

      {canAttach && (
        <Space wrap>
          {/* Вид выбирается до загрузки: он же определяет, кто и когда сможет документ снять. */}
          <Select
            style={{ width: 220 }}
            value={kind}
            options={kinds.map((value) => ({ value, label: serviceFileKindLabels[value] }))}
            onChange={setKind}
          />
          <Upload
            multiple
            showUploadList={false}
            beforeUpload={(file) => {
              setUploading(true);
              attach.mutate(file);
              return false;
            }}
          >
            <Button icon={<UploadOutlined />} loading={uploading}>
              Подшить документ
            </Button>
          </Upload>
        </Space>
      )}
    </Space>
  );
}

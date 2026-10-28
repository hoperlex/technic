import { useState } from 'react';
import { App, Button, Popconfirm, Table, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  canAddVehicleRequestDocument,
  canRemoveVehicleRequestDocument,
  type VehicleRequestDocumentDto,
  type VehicleRequestDto,
  vehicleRequestDocumentDate,
  vehicleRequestDocumentTypeLabel,
} from '@technic/contracts';
import { useAuth } from '@entities/session';
import { FileLinkList } from '@entities/file';
import { vehicleRequestKeys, vehicleRequestsApi } from '@entities/vehicle-request';
import { errorMessage, formatDate, formatDateOnly } from '@shared/lib';
import { AddDocumentModal } from './AddDocumentModal';

/**
 * Documents of a vehicle request in its card (plan `docs/vehicle-rental-completion-documents-plan.md`,
 * D5–D8, P10): one table of the requester's attachments and the typed, dated paper — invoices, УПД,
 * acts of the order and its delivery alike.
 *
 * The table is not drawn while there is nothing in it, but the header with «Добавить файл» is,
 * whenever the viewer may add: otherwise the first document could not be added at all (P10). Who
 * may add and remove is the contracts' predicates over the server's permission list (ADR 0223); the
 * lessor's scope is the server's and needs no copy here — a lessor sees only its own requests.
 *
 * `readOnly` — the card opened over a route (ADR 0120 item 7): the table is shown, nothing changes.
 */
export function VehicleRequestDocuments({
  request,
  readOnly = false,
}: {
  request: VehicleRequestDto;
  readOnly?: boolean;
}) {
  const { user, can } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const key = vehicleRequestKeys.documents(request.id);

  const { data } = useQuery({
    queryKey: key,
    queryFn: () => vehicleRequestsApi.documents(request.id),
  });
  const rows = data?.items ?? [];

  const remove = useMutation({
    mutationFn: (doc: VehicleRequestDocumentDto) =>
      vehicleRequestsApi.removeDocument(request.id, doc.file.id),
    onSuccess: (res) => {
      qc.setQueryData(key, res);
      void qc.invalidateQueries({ queryKey: vehicleRequestKeys.events(request.id) });
      message.success('Документ снят');
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const mayAdd = !readOnly && canAddVehicleRequestDocument(user, request, can);
  const mayRemove = (doc: VehicleRequestDocumentDto) =>
    !readOnly && !!user && canRemoveVehicleRequestDocument(user, request, doc, can);
  const usedTypes = [...new Set(rows.flatMap((doc) => (doc.docType ? [doc.docType] : [])))];

  if (rows.length === 0 && !mayAdd) return null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Typography.Text strong>Документы</Typography.Text>
        {mayAdd && (
          <Button size="small" icon={<PlusOutlined />} onClick={() => setAdding(true)}>
            Добавить файл
          </Button>
        )}
      </div>
      {rows.length > 0 && (
        <Table<VehicleRequestDocumentDto>
          style={{ marginTop: 12 }}
          size="small"
          pagination={false}
          rowKey={(doc) => doc.file.id}
          dataSource={rows}
          columns={[
            {
              key: 'file',
              title: 'Файл',
              render: (_value, doc) => <FileLinkList files={[doc.file]} maxNameWidth={320} />,
            },
            {
              key: 'type',
              title: 'Тип',
              width: 200,
              render: (_value, doc) =>
                doc.docType ?? (
                  <Typography.Text type="secondary">
                    {vehicleRequestDocumentTypeLabel(doc)}
                  </Typography.Text>
                ),
            },
            {
              key: 'date',
              title: 'Дата',
              width: 120,
              // A document carries its typed date; an attachment is dated by its upload.
              render: (_value, doc) =>
                doc.docDate
                  ? formatDateOnly(doc.docDate)
                  : formatDate(vehicleRequestDocumentDate(doc)),
            },
            {
              key: 'actions',
              width: 56,
              render: (_value, doc) =>
                mayRemove(doc) && (
                  <Popconfirm
                    title="Снять документ с заявки?"
                    okText="Снять"
                    cancelText="Отмена"
                    onConfirm={() => remove.mutate(doc)}
                  >
                    <Button
                      type="text"
                      danger
                      size="small"
                      icon={<DeleteOutlined />}
                      aria-label={`Снять ${doc.file.filename}`}
                      loading={remove.isPending && remove.variables?.file.id === doc.file.id}
                    />
                  </Popconfirm>
                ),
            },
          ]}
        />
      )}
      <AddDocumentModal
        requestId={request.id}
        open={adding}
        usedTypes={usedTypes}
        onClose={() => setAdding(false)}
      />
    </div>
  );
}

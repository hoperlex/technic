import { useState } from 'react';
import { App, Button, Select, Space, Upload } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { useMutation } from '@tanstack/react-query';
import {
  type ServiceFileKind,
  serviceFileKindLabels,
  type ServiceRequestDto,
} from '@technic/contracts';
import { errorMessage } from '@shared/lib';
import { serviceRequestsApi } from '../api/serviceRequestsApi';

/**
 * Подшивка документа к заявке: выбор вида и загрузка (§8.3).
 *
 * Вынесено из вкладки документов, потому что подшивают бумагу в двух местах сразу: на самой вкладке
 * и прямо в окне приёмки, где без закрывающего документа кнопка неактивна (Р120). Копия этого куска
 * означала бы две загрузки с разными правилами — с разным набором видов, разным сообщением об
 * успехе и, главное, с разной судьбой ответа.
 *
 * Ответ ручки — **свежая заявка целиком**, и он уходит наверх через `onUploaded`: окно приёмки живёт
 * своим DTO, потому что проп ему поднят состоянием открытия и `invalidateQueries` его не обновит
 * (Р120). Что именно гасить в кэше, тоже решает вызывающий: слой сущностей не знает ни справочника
 * техники, ни того, какие списки сейчас открыты.
 *
 * Загрузка файла в хранилище приходит параметром: транспорт живёт в `api/resources.ts`, а слою
 * сущностей он закрыт разметкой границ — вход туда есть у features и pages, и они его и передают.
 */
export function ServiceDocumentUpload({
  requestId,
  kinds,
  upload,
  onUploaded,
}: {
  requestId: string;
  /** Виды, которые заявка примет в этом статусе: их считает вызывающий — правило одно с сервером. */
  kinds: readonly ServiceFileKind[];
  upload: (file: File) => Promise<{ id: string }>;
  /** Свежая заявка из ответа ручки: у неё уже есть только что подшитый документ. */
  onUploaded?: (request: ServiceRequestDto) => void;
}) {
  const { message } = App.useApp();
  const [chosen, setChosen] = useState<ServiceFileKind | null>(null);
  const [uploading, setUploading] = useState(false);
  // Выбор сверяется с текущим набором: статус заявки меняется под открытым окном, и вид, которого
  // в наборе больше нет, ушёл бы на сервер за отказом.
  const kind = chosen && kinds.includes(chosen) ? chosen : (kinds[0] ?? 'attachment');

  const attach = useMutation({
    mutationFn: async (file: File) => {
      const uploaded = await upload(file);
      return serviceRequestsApi.attachFiles(requestId, [uploaded.id], kind);
    },
    onSuccess: (request) => {
      message.success('Документ подшит');
      onUploaded?.(request);
    },
    onError: (e) => message.error(errorMessage(e)),
    onSettled: () => setUploading(false),
  });

  if (kinds.length === 0) return null;

  return (
    <Space wrap>
      {/* Вид выбирается до загрузки: он же определяет, кто и когда сможет документ снять. */}
      <Select
        style={{ width: 220 }}
        value={kind}
        options={kinds.map((value) => ({ value, label: serviceFileKindLabels[value] }))}
        onChange={setChosen}
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
  );
}

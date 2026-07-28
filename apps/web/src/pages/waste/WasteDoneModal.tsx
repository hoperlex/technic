import { App, Button, Form, Input, List, Space, Typography, Upload } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import {
  type FileDto,
  type WasteRequestDto,
  requestTypeShort,
  requiresWasteVehicles,
} from '@technic/contracts';
import { filesApi } from '../../api/resources';
import { FileLinkList, FilesButton } from '../../components/FileLinks';
import { FormModal } from '../../components/FormModal';
import {
  VolumeSummary,
  type VehicleDraft,
  type VehicleTypeOption,
  WasteVehiclesEditor,
  emptyVehicleDraft,
  sumDraftVolume,
  validateVehicleDrafts,
} from '../../components/WasteVehiclesEditor';
import { errorMessage } from '../../utils/format';

const FILE_MAX_SIZE = 52_428_800; // 50 МБ
const FILE_MAX_COUNT = 20;

/**
 * Закрытие заявки на вывоз: факт предъявляется вместе со сменой статуса, а не после неё.
 * Талон обязателен в любом случае (ADR 0020) — различается только то, к чему он крепится:
 *  - вывоз самосвалами — машины с талонами: рейсов несколько, у каждого свой талон (ADR 0011),
 *    и без единой машины заявка не закрывается;
 *  - контейнерные операции — талоны самой заявки: ходка одна, машине взяться неоткуда, и
 *    заводить её ради файла значило бы придумывать сущность под вложение (ADR 0013).
 * Комментарий доступен в обоих случаях и уходит в историю заявки.
 */
interface Props {
  /** null — окно закрыто; заявка берётся из строки списка. */
  request: WasteRequestDto | null;
  typeOptions: VehicleTypeOption[];
  confirmLoading: boolean;
  onCancel: () => void;
  onSubmit: (v: {
    comment: string;
    vehicles: VehicleDraft[];
    ticketFileIds: string[];
    /** Талоны к машинам прошлого закрытия — по одной записи на машину (ADR 0020). */
    vehicleTickets: { vehicleId: string; fileIds: string[] }[];
  }) => void;
}

export function WasteDoneModal({
  request,
  typeOptions,
  confirmLoading,
  onCancel,
  onSubmit,
}: Props) {
  const { message } = App.useApp();
  const [drafts, setDrafts] = useState<VehicleDraft[]>([]);
  const [tickets, setTickets] = useState<FileDto[]>([]);
  /** Догруженные талоны уже заведённых машин: ключ — id машины (ADR 0020). */
  const [vehicleTickets, setVehicleTickets] = useState<Record<string, FileDto[]>>({});
  const [comment, setComment] = useState('');
  const [uploading, setUploading] = useState(false);
  /** id машины, к которой сейчас грузится талон: спиннер нужен на её кнопке, а не на всех. */
  const [uploadingVehicleId, setUploadingVehicleId] = useState<string | null>(null);

  const byVehicles = request ? requiresWasteVehicles(request.requestType) : false;
  const activeVehicles = request?.vehicles.filter((v) => !v.isDeleted) ?? [];

  // Окно переиспользуется под разные заявки, поэтому черновики сбрасываются при смене цели, а не
  // при размонтировании. Уже заведённых машин может хватать (повторное закрытие после отката) —
  // тогда пустая первая строка была бы навязчивой.
  const targetId = request?.id ?? null;
  useEffect(() => {
    if (!request) return;
    setDrafts(
      requiresWasteVehicles(request.requestType) && !request.vehicles.some((v) => !v.isDeleted)
        ? [emptyVehicleDraft(request.containerTypeId ?? undefined)]
        : [],
    );
    setTickets([]);
    setVehicleTickets({});
    setComment('');
    // Зависимость — идентификатор заявки, а не сама заявка: перерисовка той же заявки (invalidate
    // списка после соседнего действия) приходит новым объектом и стёрла бы уже набранное.
  }, [targetId]);

  /**
   * Файлы, не дошедшие до заявки, удаляем сразу: иначе они повиснут в S3 ничьими. Считаются все
   * три места, куда их грузит окно, — талоны заявки, талоны черновиков машин и догруженные
   * талоны уже заведённых машин.
   */
  const discardUploads = () => {
    const orphans = [
      ...tickets,
      ...drafts.flatMap((d) => d.files),
      ...Object.values(vehicleTickets).flat(),
    ];
    orphans.forEach((f) => void filesApi.remove(f.id).catch(() => {}));
    setTickets([]);
    setVehicleTickets({});
  };

  const uploadTicket = async (file: File) => {
    setUploading(true);
    try {
      const uploaded = await filesApi.upload(file);
      setTickets((prev) => [...prev, uploaded]);
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  const removeTicket = (f: FileDto) => {
    void filesApi.remove(f.id).catch(() => {});
    setTickets((prev) => prev.filter((t) => t.id !== f.id));
  };

  /** Талон к машине, заведённой прошлым закрытием: она уже в заявке, файл догружается к ней. */
  const uploadVehicleTicket = async (vehicleId: string, file: File) => {
    setUploadingVehicleId(vehicleId);
    try {
      const uploaded = await filesApi.upload(file);
      setVehicleTickets((prev) => ({
        ...prev,
        [vehicleId]: [...(prev[vehicleId] ?? []), uploaded],
      }));
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setUploadingVehicleId(null);
    }
  };

  const removeVehicleTicket = (vehicleId: string, f: FileDto) => {
    void filesApi.remove(f.id).catch(() => {});
    setVehicleTickets((prev) => ({
      ...prev,
      [vehicleId]: (prev[vehicleId] ?? []).filter((t) => t.id !== f.id),
    }));
  };

  /** Талон у машины есть, если он приложен раньше или догружен здесь. */
  const vehicleHasTicket = (v: (typeof activeVehicles)[number]) =>
    v.files.length > 0 || (vehicleTickets[v.id]?.length ?? 0) > 0;

  const cancel = () => {
    discardUploads();
    onCancel();
  };

  const submit = () => {
    if (!request) return;
    if (byVehicles) {
      const error = validateVehicleDrafts(drafts, activeVehicles.length);
      if (error) {
        message.warning(error);
        return;
      }
      if (activeVehicles.length + drafts.length === 0) {
        message.warning('Добавьте хотя бы одну машину');
        return;
      }
      // Машины прошлого закрытия могли остаться без талона: тогда его прикладывают здесь же,
      // иначе сервер закрытие не проведёт (ADR 0020).
      const missing = activeVehicles.filter((v) => !vehicleHasTicket(v));
      if (missing.length > 0) {
        message.warning(`Приложите талон к уже заведённым машинам: ${missing.length} без талона`);
        return;
      }
    } else if (request.tickets.length + tickets.length === 0) {
      message.warning('Приложите талон — без него заявка не закрывается');
      return;
    }
    onSubmit({
      comment: comment.trim(),
      vehicles: byVehicles ? drafts : [],
      ticketFileIds: byVehicles ? [] : tickets.map((f) => f.id),
      vehicleTickets: byVehicles
        ? Object.entries(vehicleTickets)
            .filter(([, files]) => files.length > 0)
            .map(([vehicleId, files]) => ({ vehicleId, fileIds: files.map((f) => f.id) }))
        : [],
    });
  };

  return (
    <FormModal
      title="Прикрепление талона(ов)"
      open={!!request}
      onCancel={cancel}
      onSubmit={submit}
      confirmLoading={confirmLoading}
      okText="Выполнена"
      width={720}
    >
      {request && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Typography.Text type="secondary">
            Заявка № {request.num}-{requestTypeShort[request.requestType]}, {request.objectName}
            {request.volumeM3 != null ? ` · заявлено ${request.volumeM3} м³` : ''}
          </Typography.Text>

          {byVehicles ? (
            <>
              {activeVehicles.length > 0 && (
                <List
                  size="small"
                  header={<Typography.Text strong>Уже заведённые машины</Typography.Text>}
                  dataSource={activeVehicles}
                  renderItem={(v) => (
                    <List.Item>
                      <span>
                        {v.containerTypeName} — {v.volumeM3} м³
                      </span>
                      {/* Машина прошлого закрытия может быть без талона — тогда талон грузится
                          прямо здесь: заводить рейс заново ради вложения незачем (ADR 0020). */}
                      {v.files.length > 0 ? (
                        <FilesButton
                          files={v.files}
                          title={`Талоны — ${v.containerTypeName}`}
                          label={`талонов: ${v.files.length}`}
                          emptyText="без талона"
                        />
                      ) : (
                        <Space size={8} align="start">
                          <FileLinkList
                            files={vehicleTickets[v.id] ?? []}
                            maxNameWidth={200}
                            onRemove={(f) => removeVehicleTicket(v.id, f)}
                          />
                          <Upload
                            multiple
                            showUploadList={false}
                            beforeUpload={(file) => {
                              if ((vehicleTickets[v.id]?.length ?? 0) >= FILE_MAX_COUNT) {
                                message.warning(`Не более ${FILE_MAX_COUNT} талонов`);
                                return Upload.LIST_IGNORE;
                              }
                              if (file.size > FILE_MAX_SIZE) {
                                message.warning('Файл больше 50 МБ');
                                return Upload.LIST_IGNORE;
                              }
                              void uploadVehicleTicket(v.id, file);
                              return false;
                            }}
                          >
                            <Button
                              size="small"
                              icon={<UploadOutlined />}
                              loading={uploadingVehicleId === v.id}
                              danger={!vehicleHasTicket(v)}
                            >
                              Прикрепить талон
                            </Button>
                          </Upload>
                        </Space>
                      )}
                    </List.Item>
                  )}
                />
              )}
              <WasteVehiclesEditor
                value={drafts}
                onChange={setDrafts}
                typeOptions={typeOptions}
                defaultContainerTypeId={request.containerTypeId ?? undefined}
                existingCount={activeVehicles.length}
              />
              <VolumeSummary
                planned={request.volumeM3}
                actual={
                  sumDraftVolume(drafts, typeOptions) +
                  activeVehicles.reduce((acc, v) => acc + v.volumeM3, 0)
                }
              />
            </>
          ) : (
            <div>
              {/* Талоны, приложенные при прошлом закрытии, остаются на заявке: показываем их,
                  чтобы при повторном закрытии не прикладывать те же бумаги второй раз. */}
              {request.tickets.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <Typography.Text strong>Уже приложенные талоны</Typography.Text>
                  <FileLinkList files={request.tickets} maxNameWidth={300} />
                </div>
              )}
              <Space size={8} wrap>
                <Upload
                  multiple
                  showUploadList={false}
                  beforeUpload={(file) => {
                    if (tickets.length >= FILE_MAX_COUNT) {
                      message.warning(`Не более ${FILE_MAX_COUNT} талонов`);
                      return Upload.LIST_IGNORE;
                    }
                    if (file.size > FILE_MAX_SIZE) {
                      message.warning('Файл больше 50 МБ');
                      return Upload.LIST_IGNORE;
                    }
                    void uploadTicket(file);
                    return false;
                  }}
                >
                  <Button
                    icon={<UploadOutlined />}
                    loading={uploading}
                    danger={request.tickets.length + tickets.length === 0}
                  >
                    Прикрепить талон
                  </Button>
                </Upload>
                {request.tickets.length + tickets.length === 0 && (
                  <Typography.Text type="secondary" style={{ lineHeight: '32px' }}>
                    Талон обязателен: без него заявка не закрывается
                  </Typography.Text>
                )}
              </Space>
              {tickets.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <FileLinkList files={tickets} maxNameWidth={300} onRemove={removeTicket} />
                </div>
              )}
            </div>
          )}

          {/* Комментарий к выполнению — событие истории заявки, а не поле самой заявки: он
              описывает конкретное закрытие (что вывезли не полностью, кто принимал). */}
          <Form layout="vertical" component="div">
            <Form.Item label="Комментарий" style={{ marginBottom: 0 }}>
              <Input.TextArea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={2}
                maxLength={2000}
                showCount
                placeholder="Необязательно: что важно знать об этом выполнении"
              />
            </Form.Item>
          </Form>
        </div>
      )}
    </FormModal>
  );
}

import { useEffect, useState } from 'react';
import { App, Button, DatePicker, Form, Input, Select, Space, Typography, Upload } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  isWarrantyActive,
  type ServiceRequestDto,
  type WarrantyClaimSource,
  warrantyClaimSourceLabels,
} from '@technic/contracts';
import { officeEquipmentOptionsQuery, WarrantyTag } from '@entities/office-equipment';
import { departmentOptionsQuery } from '@entities/department';
import { serviceRequestKeys, serviceRequestsApi } from '@entities/service-request';
import { AutoSelect, FormModal } from '@shared/ui';
import { filesApi } from '../../api/resources';
import { FileLinkList } from '../../components/FileLinks';
import { ResponsibleFields } from '../../components/ResponsibleFields';
import { useAuth } from '../../auth/AuthContext';
import { useDepartmentScope } from '../../hooks/useDepartmentScope';
import { errorMessage } from '../../utils/format';
import { applyApiFieldErrors } from '../../utils/formErrors';

const DATE = 'YYYY-MM-DD';

interface Values {
  officeEquipmentId: string;
  description: string;
  dueDate?: Dayjs;
  customerDepartmentId?: string;
  responsibleName: string;
  responsiblePhone: string;
  comment?: string;
  warrantySource?: WarrantyClaimSource;
}

interface UploadedFile {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

/**
 * Форма заявки на обслуживание (§9.3): что сломалось, у какой единицы, к какому сроку и с кем
 * связываться.
 *
 * Единица выбирается первой, и под полем сразу видно состояние её гарантии: пока это неизвестно,
 * заказчик не может ответить на главный вопрос — платный это ремонт или гарантийный. Обращение
 * по гарантии — не флажок «гарантийная», а источник: по чьей именно гарантии обращаются (Р26).
 *
 * Правится только «Новая» (`isServiceRequestEditable`): дальше за заявкой стоят договорённости с
 * исполнителем, и менять её предмет задним числом нельзя. Технику при правке не меняют вовсе —
 * это другая заявка; вложения после заведения живут вкладкой «Документы» карточки.
 */
export function ServiceRequestForm({
  open,
  request,
  onClose,
}: {
  open: boolean;
  /** `null` — заведение новой заявки. */
  request: ServiceRequestDto | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [form] = Form.useForm<Values>();
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const equipmentId = Form.useWatch('officeEquipmentId', form);
  const warrantySource = Form.useWatch('warrantySource', form);
  const scope = useDepartmentScope();

  const { data: equipmentOptions = [], isFetching: equipmentLoading } = useQuery({
    ...officeEquipmentOptionsQuery(),
    enabled: open && can('officeEquipment.read'),
  });
  const { data: departmentOptions = [] } = useQuery(departmentOptionsQuery());

  const selected = equipmentOptions.find((option) => option.value === equipmentId);
  const warrantyActive = isWarrantyActive(selected?.warrantyUntil);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    setFiles([]);
    if (request) {
      form.setFieldsValue({
        officeEquipmentId: request.equipment.id,
        description: request.description,
        dueDate: request.dueDate ? dayjs(request.dueDate) : undefined,
        customerDepartmentId: request.customerDepartment?.id,
        responsibleName: request.responsibleName,
        responsiblePhone: request.responsiblePhone,
        comment: request.comment,
        warrantySource: request.warrantyClaim?.source,
      });
      return;
    }
    // Единственный отдел учётки подставляется сам: выбор из одного варианта — лишний шаг.
    form.setFieldsValue({ customerDepartmentId: scope.soleDepartmentId ?? undefined } as Values);
  }, [open, request, form, scope.soleDepartmentId]);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const dto = await filesApi.upload(file);
      setFiles((prev) => [
        ...prev,
        { id: dto.id, filename: dto.filename, contentType: dto.contentType, size: dto.size },
      ]);
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  const removeFile = (id: string) => {
    setFiles((prev) => prev.filter((file) => file.id !== id));
    // Файл ещё ничей: заявки, к которой он привязан, нет — сносим его сразу, чтобы не копить мусор.
    void filesApi.remove(id).catch(() => undefined);
  };

  const mutation = useMutation({
    mutationFn: (values: Values) => {
      const warrantyClaim = values.warrantySource
        ? { source: values.warrantySource, itemId: null }
        : undefined;
      const common = {
        description: values.description.trim(),
        dueDate: values.dueDate ? values.dueDate.format(DATE) : null,
        customerDepartmentId: values.customerDepartmentId ?? null,
        responsibleName: values.responsibleName?.trim() ?? '',
        responsiblePhone: values.responsiblePhone?.trim() ?? '',
        comment: values.comment?.trim() ?? '',
        warrantyClaim,
      };
      return request
        ? serviceRequestsApi.update(request.id, { ...common, version: request.version })
        : serviceRequestsApi.create({
            ...common,
            officeEquipmentId: values.officeEquipmentId,
            fileIds: files.map((file) => file.id),
          });
    },
    onSuccess: () => {
      message.success(request ? 'Заявка сохранена' : 'Заявка заведена');
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
      onClose();
    },
    onError: (e) => {
      // 409 «по этой технике уже есть открытая заявка» (Р21) — обычный ответ, а не сбой.
      if (!applyApiFieldErrors(form, e)) message.error(errorMessage(e));
    },
  });

  return (
    <FormModal
      title={request ? `Заявка ${request.displayNumber}` : 'Новая заявка на обслуживание'}
      open={open}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={mutation.isPending}
      width={620}
    >
      <Form form={form} layout="vertical" onFinish={(v) => mutation.mutate(v)}>
        <Form.Item
          name="officeEquipmentId"
          label="Техника"
          rules={[{ required: true, message: 'Выберите единицу оргтехники' }]}
        >
          <AutoSelect
            showSearch
            optionFilterProp="label"
            loading={equipmentLoading}
            options={equipmentOptions}
            disabled={!!request}
            placeholder="Модель, инвентарный или серийный номер"
            notFoundContent={
              can('officeEquipment.read')
                ? 'Ничего не нашлось — техники нет в справочнике'
                : 'Справочник недоступен'
            }
          />
        </Form.Item>

        {/* Состояние гарантии — под самим полем: от него зависит следующий вопрос формы. */}
        {equipmentId && (
          <Space size={8} wrap style={{ marginBottom: 16 }}>
            <Typography.Text type="secondary">Гарантия на технику:</Typography.Text>
            <WarrantyTag until={selected?.warrantyUntil} />
          </Space>
        )}

        {warrantyActive && (
          <Form.Item
            name="warrantySource"
            label="Обращение по гарантии"
            extra={
              warrantySource
                ? 'Источник уйдёт в заявку: по нему сервис и разбирает, чинить бесплатно или за деньги'
                : 'Не выбрано — заявка обычная, платная'
            }
          >
            <Select
              allowClear
              placeholder="Обычная заявка"
              options={[
                { value: 'equipment', label: warrantyClaimSourceLabels.equipment },
                {
                  value: 'item',
                  label: `${warrantyClaimSourceLabels.item} — выбирается в реестре гарантий`,
                  // Гарантия на прошлый ремонт требует ссылки на позицию закрытой заявки; её
                  // отдаёт реестр гарантий, и заводят такое обращение оттуда (§9.5).
                  disabled: true,
                },
              ]}
            />
          </Form.Item>
        )}

        <Form.Item
          name="description"
          label="Неисправность"
          rules={[
            { required: true, message: 'Опишите неисправность' },
            { min: 5, message: 'Опишите неисправность подробнее' },
          ]}
        >
          <Input.TextArea rows={3} maxLength={4000} showCount placeholder="Что случилось" />
        </Form.Item>

        <Space size={12} wrap align="start" style={{ width: '100%' }}>
          <Form.Item name="dueDate" label="Желаемый срок">
            <DatePicker
              format="DD.MM.YYYY"
              style={{ width: 200 }}
              // Срок в прошлом смысла не имеет: заявку заводят на будущее.
              disabledDate={(d) => d.isBefore(dayjs().startOf('day'))}
            />
          </Form.Item>
          <Form.Item
            name="customerDepartmentId"
            label="Отдел-заказчик"
            // Отдел обязателен только тому, у кого их несколько: у остальных заявка объектная
            // либо отдел единственный и подставлен сам (ADR 0085 §8).
            rules={[
              {
                required: scope.isDepartmentRole && !scope.soleDepartmentId,
                message: 'Выберите отдел, от имени которого заявка',
              },
            ]}
          >
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ width: 260 }}
              placeholder="Заявка от площадки"
              options={scope.limitDepartmentOptions(departmentOptions)}
            />
          </Form.Item>
        </Space>

        <ResponsibleFields
          nameField="responsibleName"
          phoneField="responsiblePhone"
          nameLabel="Ответственный"
          phoneLabel="Телефон"
        />

        <Form.Item name="comment" label="Комментарий">
          <Input.TextArea rows={2} maxLength={2000} placeholder="Необязательно" />
        </Form.Item>

        {!request && (
          <div>
            {/* Фото неисправности — самое частое вложение: по нему сервис понимает, что везти. */}
            <Upload
              multiple
              showUploadList={false}
              beforeUpload={(file) => {
                void upload(file);
                return false;
              }}
            >
              <Button icon={<UploadOutlined />} loading={uploading}>
                Прикрепить фото и документы
              </Button>
            </Upload>
            <div style={{ marginTop: 8 }}>
              <FileLinkList
                files={files}
                emptyText="Файлов нет"
                onRemove={(file) => removeFile(file.id)}
              />
            </div>
          </div>
        )}
      </Form>
    </FormModal>
  );
}

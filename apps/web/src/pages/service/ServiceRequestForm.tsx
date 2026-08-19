import { useEffect, useState } from 'react';
import { App, Checkbox, Form, Input } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  isWarrantyActive,
  type ModuleMailOutcome,
  type ServiceRequestDto,
  type WarrantyClaimSource,
} from '@technic/contracts';
import { officeEquipmentKeys, officeEquipmentOptionsQuery } from '@entities/office-equipment';
import { objectOptionsQuery } from '@entities/object';
import { serviceRequestKeys, serviceRequestsApi } from '@entities/service-request';
import { EquipmentNotFoundLink } from '@features/quick-create-equipment';
import { ServiceRequestCustomerField, useServiceRequestCustomer } from '@features/request-customer';
import { AutoSelect, FormModal, useFormBlockers } from '@shared/ui';
import { ServiceRequestAttachments, type UploadedFile } from './ServiceRequestAttachments';
import { ServiceRequestWarrantyClaim } from './ServiceRequestWarrantyClaim';
import { ServiceRequestSubject } from './ServiceRequestSubject';
import { reportServiceMail } from './serviceMailNotice';
import { filesApi } from '../../api/resources';
import { ResponsibleFields } from '../../components/ResponsibleFields';
import { useAuth } from '../../auth/AuthContext';
import { useObjectScope } from '../../hooks/useObjectScope';
import { errorMessage } from '../../utils/format';

interface Values {
  officeEquipmentId: string;
  description: string;
  /** Заказчик ключом `CostTargetKey` (Р2): площадка выбранной единицы либо отдел. */
  customer?: string;
  responsibleName: string;
  responsiblePhone: string;
  comment?: string;
  warrantySource?: WarrantyClaimSource;
  isUrgent?: boolean;
  urgencyReason?: string;
}

/**
 * Обращение по гарантии, начатое из реестра (§9.5): техника и источник уже названы строкой
 * реестра, и в форме они не правятся — `itemId` позиции прошлого ремонта взять больше неоткуда,
 * а «поправленный» источник означал бы ссылку не на ту работу.
 */
export interface WarrantyClaimPreset {
  equipmentId: string;
  source: WarrantyClaimSource;
  /** Позиция сметы прошлой заявки; у гарантии поставщика её нет (Р26). */
  itemId: string | null;
  /** На что гарантия — подпись для подсказки: человек должен видеть, на что ссылается. */
  subject: string;
}

/**
 * Форма заявки на обслуживание (§9.3): что сломалось, у какой единицы и с кем связываться.
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
  claim,
  onClose,
}: {
  open: boolean;
  /** `null` — заведение новой заявки. */
  request: ServiceRequestDto | null;
  /** Заявка заводится по гарантии из реестра: техника и источник заданы заранее. */
  claim?: WarrantyClaimPreset | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const { can, user } = useAuth();
  const [form] = Form.useForm<Values>();
  const blockers = useFormBlockers(form);
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  // Что набрали в поле техники: строка уходит контекстом в обращение к поддержке, когда единицы
  // в справочнике не оказалось. Держится и после того, как список закрылся, — искали именно это.
  const [equipmentSearch, setEquipmentSearch] = useState('');
  const equipmentId = Form.useWatch('officeEquipmentId', form);
  const warrantySource = Form.useWatch('warrantySource', form);
  const isUrgent = Form.useWatch('isUrgent', form);
  const objectScope = useObjectScope();

  const { data: equipmentOptions = [], isFetching: equipmentLoading } = useQuery({
    ...officeEquipmentOptionsQuery(),
    enabled: open && can('officeEquipment.read'),
  });

  /**
   * Ссылка «Не нашли технику?» — только там, где технику вообще выбирают: при правке и в обращении
   * по гарантии единица задана и не правится, и разбирать в этих режимах нечего.
   */
  const equipmentMissing = !request && !claim && !equipmentId;
  /*
   * Площадка учётки — контекст обращения в поддержку. Спрашивается только у объектной роли с
   * единственным объектом: с несколькими портал не знает, на какой из них стоит ненайденная
   * техника, и называть первый попавшийся значило бы отправить поддержку не туда. Список объектов
   * тот же, что у фильтров списка заявок, — второго запроса это не стоит.
   */
  const { data: objectOptions = [] } = useQuery({
    ...objectOptionsQuery({ activeOnly: false }),
    enabled: open && equipmentMissing && !!objectScope.soleObjectId,
  });
  const ownObjectName = objectOptions.find(
    (option) => option.value === objectScope.soleObjectId,
  )?.label;

  const selected = equipmentOptions.find((option) => option.value === equipmentId);
  const warrantyActive = isWarrantyActive(selected?.warrantyUntil);

  /**
   * Заказчик заявки (Р11, Р11а, Р11б, Р12): площадка выбранной сейчас единицы либо отдел, от чьего
   * имени просят. Состав групп, границу площадки роли отдела, сохранённого заказчика правки и
   * запертость до выбора техники считает подбор — форме остаётся сказать, какую единицу выбрали
   * (опция справочника подходит под его тип целиком) и какую заявку правят: при правке единицу не
   * выбирают вовсе, и оба её снимка берутся из самой заявки.
   */
  const customer = useServiceRequestCustomer({ request, equipment: selected });
  // Оба ключа — скалярами: зависеть от подбора целиком значило бы сбрасывать форму на каждой
  // перерисовке.
  const { savedKey, soleDepartmentKey } = customer;

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    setFiles([]);
    setEquipmentSearch('');
    if (request) {
      form.setFieldsValue({
        officeEquipmentId: request.equipment.id,
        description: request.description,
        // Заказчик правки — ключом от подбора (К7): он собран по снимкам самой заявки, а не по
        // действующему справочнику, и держится в списке, даже выпав из состава поля.
        customer: savedKey ?? undefined,
        responsibleName: request.responsibleName,
        responsiblePhone: request.responsiblePhone,
        comment: request.comment,
        warrantySource: request.warrantyClaim?.source,
        isUrgent: request.isUrgent,
        urgencyReason: request.urgencyReason,
      });
      return;
    }
    form.setFieldsValue({
      // Единственный отдел учётки подставляется сам — как и до подбора (ADR 0085 §8). Иначе поле
      // заполнилось бы площадкой выбранной единицы, и заявка сотрудника отдела о своём же принтере
      // молча стала бы заявкой от площадки.
      customer: soleDepartmentKey ?? undefined,
      // Заявитель — тот, кто заводит заявку: ФИО и телефон подставляются из его же учётки и
      // правятся. Поля обязательны (Р49), и заставлять человека набирать собственный номер, зная
      // его, значило бы разводить прочерки вместо контактов.
      responsibleName: user?.fullName ?? '',
      responsiblePhone: user?.phone ?? '',
      // Обращение из реестра приходит с готовым источником: заполнять его руками человек и не
      // смог бы — позиция прошлого ремонта опознаётся идентификатором, которого он не видит.
      ...(claim ? { officeEquipmentId: claim.equipmentId, warrantySource: claim.source } : {}),
    } as Values);
  }, [open, request, claim, form, savedKey, soleDepartmentKey, user?.fullName, user?.phone]);

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

  const removeFile = (file: UploadedFile) => {
    const id = file.id;
    setFiles((prev) => prev.filter((f) => f.id !== id));
    // Файл ещё ничей: заявки, к которой он привязан, нет — сносим его сразу, чтобы не копить мусор.
    void filesApi.remove(id).catch(() => undefined);
  };

  const mutation = useMutation({
    mutationFn: async (
      values: Values,
    ): Promise<{ request: ServiceRequestDto; mail: ModuleMailOutcome | null }> => {
      // Позиция прошлого ремонта уходит только вместе с источником `item` и только той, что
      // назвал реестр: сервер сверяет её с техникой заявки и отвечает 422, если она чужая (Р26).
      const warrantyClaim = values.warrantySource
        ? {
            source: values.warrantySource,
            itemId: values.warrantySource === 'item' ? (claim?.itemId ?? null) : null,
          }
        : undefined;
      const isUrgent = !!values.isUrgent;
      const common = {
        description: values.description.trim(),
        // Заказчик уходит всегда и осознанно (Р12а): отдел — идентификатором, площадка — явным
        // `null`. Пропуск сервер прочёл бы подсказкой и подставил отдел за человека.
        customerDepartmentId: customer.customerPairOf(values.customer).departmentId,
        responsibleName: values.responsibleName?.trim() ?? '',
        responsiblePhone: values.responsiblePhone?.trim() ?? '',
        comment: values.comment?.trim() ?? '',
        warrantyClaim,
        // Пара уходит целиком: снятая галочка обязана унести и причину — порознь их не принимает
        // ни схема, ни CHECK в базе.
        isUrgent,
        urgencyReason: isUrgent ? (values.urgencyReason?.trim() ?? '') : '',
      };
      if (request) {
        const saved = await serviceRequestsApi.update(request.id, {
          ...common,
          version: request.version,
        });
        // Правка письма службе не шлёт: заявка никуда не переходила, а «исправили формулировку» —
        // не событие. Исход у неё поэтому всегда «письмо не требовалось».
        return { request: saved, mail: null };
      }
      return serviceRequestsApi.create({
        ...common,
        officeEquipmentId: values.officeEquipmentId,
        fileIds: files.map((file) => file.id),
      });
    },
    onSuccess: (res) => {
      message.success(request ? 'Заявка сохранена' : 'Заявка заведена');
      // Заявка заведена, но письмо службе не ушло — про это надо сказать сразу: служба читает
      // почту, а не портал, и молча оставить её неоповещённой значит потерять день.
      reportServiceMail(message, res.mail);
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      onClose();
    },
    onError: (e) => {
      // 409 «по этой технике уже есть открытая заявка» (Р21) — обычный ответ, а не сбой.
      if (!blockers.fromApi(e)) message.error(errorMessage(e));
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
      <Form
        form={form}
        layout="vertical"
        onFinish={(v) => mutation.mutate(v)}
        {...blockers.formProps}
      >
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
            // Технику не меняют ни при правке (это другая заявка), ни в обращении по гарантии:
            // источник гарантии относится к конкретной единице, и подмена сделала бы ссылку ложной.
            disabled={!!request || !!claim}
            placeholder="Модель, инвентарный или серийный номер"
            onSearch={setEquipmentSearch}
            notFoundContent={
              can('officeEquipment.read')
                ? 'Ничего не нашлось — техники нет в справочнике'
                : 'Справочник недоступен'
            }
          />
        </Form.Item>

        {/* Ответ на «ничего не нашлось» — под самим полем: тупик разбирается, не выходя из заявки.
            Ответа два, и различает их право вести справочник, а не роль (Р40). */}
        {equipmentMissing && (
          <EquipmentNotFoundLink
            canCreate={can('officeEquipment.write')}
            search={equipmentSearch}
            objectName={ownObjectName}
            // Заведённая единица становится значением поля — тем же, каким её выбрали бы из
            // списка: заявка продолжается с того же места, где встала.
            onCreated={(equipment) => form.setFieldValue('officeEquipmentId', equipment.id)}
          />
        )}

        {/* Реквизиты предмета (Р48, Р57): что именно уйдёт в заявку снимком. Отдельным
            компонентом — источников у них два: справочник при заведении и сама заявка при правке. */}
        <ServiceRequestSubject request={request} selected={selected} />

        <ServiceRequestWarrantyClaim
          active={warrantyActive}
          claim={claim}
          source={warrantySource}
        />

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

        {/* «Желаемый срок» из заявки убран целиком (Р115): срок, который ничего не запирает,
            через месяц стоит просроченным у половины заявок. Давность читается возрастом в
            статусе — он и сортируется, и точнее отвечает на вопрос «кто тянет». */}
        <Form.Item
          name="customer"
          label="Заказчик"
          // Пустого состояния у поля нет (Р12а): «от площадки» — такой же выбор, как отдел, а не
          // незаполненное поле, и уходит он явным `null`.
          rules={[{ required: true, message: 'Выберите заказчика заявки' }]}
        >
          {/* Площадку поле пересобирает само на смене единицы (Р11а, К10): значение — про то,
              где аппарат стоит **сейчас**, и правило это живёт у поля, а не у формы. */}
          <ServiceRequestCustomerField customer={customer} open={open} />
        </Form.Item>

        {/* Заявитель, а не «ответственный»: это тот, к кому мастер придёт и кому позвонят, если
            аппарата не окажется на месте. Оба поля обязательны и на сервере тоже (Р49). */}
        <ResponsibleFields
          nameField="responsibleName"
          phoneField="responsiblePhone"
          nameLabel="Заявитель"
          phoneLabel="Контактный телефон"
        />

        {/* Срочность — пара «галочка + причина» (Р56). Причина появляется вместе с галочкой и
            обязательна: без неё через месяц срочными окажутся все заявки, и очередь, в которую
            смотрит оператор, перестанет что-либо означать. */}
        <Form.Item
          name="isUrgent"
          valuePropName="checked"
          style={{ marginBottom: isUrgent ? 8 : 24 }}
        >
          <Checkbox>Срочная заявка</Checkbox>
        </Form.Item>
        {isUrgent && (
          <Form.Item
            name="urgencyReason"
            label="Почему срочно"
            rules={[{ required: true, message: 'Объясните, почему заявка срочная' }]}
          >
            <Input
              maxLength={500}
              placeholder="Например: единственный принтер на площадке, встала выдача пропусков"
            />
          </Form.Item>
        )}

        <Form.Item name="comment" label="Комментарий">
          <Input.TextArea rows={2} maxLength={2000} placeholder="Необязательно" />
        </Form.Item>

        {/* Вложения — только при заведении: после него они живут вкладкой «Документы» карточки,
            где у каждого файла есть вид (акт, счёт, талон). */}
        {!request && (
          <ServiceRequestAttachments
            files={files}
            uploading={uploading}
            onUpload={upload}
            onRemove={removeFile}
          />
        )}
      </Form>
    </FormModal>
  );
}

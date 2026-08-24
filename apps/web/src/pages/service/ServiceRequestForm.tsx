import { useEffect } from 'react';
import { App, Checkbox, Form, Input, Segmented } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  isWarrantyActive,
  serviceRequestKindLabels,
  SERVICE_REQUEST_KINDS,
  type ServiceRequestDto,
  type ServiceRequestKind,
  type WarrantyClaimSource,
} from '@technic/contracts';
import { officeEquipmentKeys, officeEquipmentOptionsQuery } from '@entities/office-equipment';
import { serviceRequestKeys } from '@entities/service-request';
import { ServiceRequestCustomerField, useServiceRequestCustomer } from '@features/request-customer';
import { FormModal, useFormBlockers } from '@shared/ui';
import {
  ServiceRequestAttachments,
  useServiceRequestAttachments,
} from './ServiceRequestAttachments';
import {
  consumableLinesFrom,
  ServiceRequestConsumablesField,
} from './ServiceRequestConsumables';
import { submitServiceRequest, type ServiceFormValues } from './serviceRequestSubmit';
import { ServiceRequestEquipmentField } from './ServiceRequestEquipmentField';
import { ServiceRequestWarrantyClaim } from './ServiceRequestWarrantyClaim';
import { useRequesterPlace } from './ServiceRequestRequesterPlace';
import { reportServiceMail } from './serviceMailNotice';
import { ResponsibleFields } from '../../components/ResponsibleFields';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';

/** Поля формы объявлены рядом с отправкой (`serviceRequestSubmit`): они — её вход. */
type Values = ServiceFormValues;

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
  const attachments = useServiceRequestAttachments();
  const { reset: resetAttachments } = attachments;
  const equipmentId = Form.useWatch('officeEquipmentId', form);
  const chosenKind = Form.useWatch('kind', form);
  const warrantySource = Form.useWatch('warrantySource', form);
  const isUrgent = Form.useWatch('isUrgent', form);

  const { data: equipmentOptions = [], isFetching: equipmentLoading } = useQuery({
    ...officeEquipmentOptionsQuery(),
    enabled: open && can('officeEquipment.read'),
  });

  /**
   * Модель выбранного аппарата — по ней подбираются позиции номенклатуры (Н10). Тем же запросом и
   * тем же ключом, что и список техники: второй проекцией уже загруженного ответа, а не вторым
   * обращением к серверу. В подписи опции модели нет, а идентификатор нужен именно её — «Тонер
   * Ricoh 201» привязан к модели, а не к инвентарному номеру.
   */
  const { data: modelOf } = useQuery({
    ...officeEquipmentOptionsQuery(),
    enabled: open && can('officeEquipment.read'),
    select: (r) => new Map(r.items.map((item) => [item.id, item.model?.id])),
  });

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

  // Подразделение заявителя (Н11): поле и тело запроса — из одной оси. Спрашивается только там,
  // где у учётки не одна привязка; при правке не спрашивается вовсе — оно снято снимком.
  const place = useRequesterPlace({ user: request ? null : user, open });
  // Оба ключа — скалярами: зависеть от подбора целиком значило бы сбрасывать форму на каждой
  // перерисовке.
  const { savedKey, soleDepartmentKey } = customer;

  /**
   * Вид заявки (Н1). У правки он берётся из самой заявки и не спрашивается: заявка на картридж,
   * ставшая ремонтной, — это другая заявка, и схема правки вида не принимает вовсе. Обращение по
   * гарантии — всегда ремонт: гарантии на картридж со своего склада не бывает.
   */
  const kind: ServiceRequestKind = request ? request.kind : claim ? 'repair' : (chosenKind ?? 'repair');
  const consumable = kind === 'consumable';
  /**
   * По заявке уже отмечена выдача — состав строк замер (сервер отвечает 409). Это не «нет прав», а
   * «список пожеланий стал основанием записи на складе», и сказать это надо словами.
   */
  const issued = !!request?.consumables.some((line) => line.issuedQuantity !== null);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    resetAttachments();
    if (request) {
      form.setFieldsValue({
        officeEquipmentId: request.equipment.id,
        // Строки правятся тем же составом, каким их читают: правка открывается тем, что просили.
        consumables: consumableLinesFrom(request.consumables),
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
      // Вид по умолчанию — ремонт: он же стоит умолчанием колонки в базе, и «поля нет» читается
      // сервером так же.
      kind: 'repair',
      consumables: [],
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
    });
  }, [
    open,
    request,
    claim,
    form,
    resetAttachments,
    savedKey,
    soleDepartmentKey,
    user?.fullName,
    user?.phone,
  ]);

  const mutation = useMutation({
    mutationFn: (values: Values) =>
      submitServiceRequest(values, {
        request,
        claim,
        customerDepartmentId: customer.customerPairOf(values.customer).departmentId,
        requesterPlace: place.body(values.requesterPlaceId),
        fileIds: attachments.ids,
      }),
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
        {/* Вид заявки (Н1) — первым: от него зависит, о чём форма спрашивает дальше. При правке
            и в обращении по гарантии выбора нет — вид у заявки уже есть и меняться не может. */}
        {!request && !claim && (
          <Form.Item name="kind" label="Что нужно сделать">
            <Segmented
              options={SERVICE_REQUEST_KINDS.map((value) => ({
                value,
                label: serviceRequestKindLabels[value],
              }))}
            />
          </Form.Item>
        )}

        <ServiceRequestEquipmentField
          request={request}
          claim={!!claim}
          selected={selected}
          options={equipmentOptions}
          loading={equipmentLoading}
          open={open}
        />

        {/* Строки номенклатуры — сразу под аппаратом (Н10): позиции подбираются по его модели, и
            между вопросом «какой аппарат» и ответом «что к нему подходит» ничему стоять не надо. */}
        {consumable && (
          <ServiceRequestConsumablesField
            modelId={equipmentId ? modelOf?.get(equipmentId) : undefined}
            disabled={issued}
            disabledReason={
              issued
                ? 'По заявке уже отмечена выдача — состав больше не меняют, правьте выданное количество'
                : undefined
            }
            enabled={open}
          />
        )}

        {/* Гарантия — вопрос ремонта: картридж со своего склада ни по чьей гарантии не выдают. */}
        {!consumable && (
          <ServiceRequestWarrantyClaim
            active={warrantyActive}
            claim={claim}
            source={warrantySource}
          />
        )}

        <Form.Item
          name="description"
          label={consumable ? 'Зачем нужно' : 'Неисправность'}
          rules={[
            {
              required: true,
              message: consumable ? 'Скажите, зачем нужны расходники' : 'Опишите неисправность',
            },
            { min: 5, message: 'Напишите подробнее' },
          ]}
        >
          <Input.TextArea
            rows={3}
            maxLength={4000}
            showCount
            placeholder={
              consumable ? 'Например: закончился чёрный тонер, печатать нечем' : 'Что случилось'
            }
          />
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

        {/* Откуда сам заявитель (Н11) — рядом с его контактом, а не рядом с заказчиком: это два
            разных вопроса, и путать их значит записывать заявку на чужой отдел. */}
        {place.field}

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
            files={attachments.files}
            uploading={attachments.uploading}
            onUpload={attachments.upload}
            onRemove={attachments.remove}
          />
        )}
      </Form>
    </FormModal>
  );
}

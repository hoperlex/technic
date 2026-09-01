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
import { submitServiceRequest, type ServiceFormValues } from './serviceRequestSubmit';
import { ServiceRequestEquipmentField } from './ServiceRequestEquipmentField';
import { ServiceRequestWarrantyClaim } from './ServiceRequestWarrantyClaim';
import { useRequesterPlace } from './ServiceRequestRequesterPlace';
import { reportServiceMail } from './serviceMailNotice';
import { reportServiceRequestFailure } from './serviceRequestFailure';
import { ResponsibleFields } from '../../components/ResponsibleFields';
import { useAuth } from '../../auth/AuthContext';

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
  /** Позиция объёма работ прошлой заявки; у гарантии поставщика её нет (Р26). */
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
 * Правится только «Новая», за которой ещё никто не стоит (`isServiceRequestEditable`, Р14): после
 * назначения за заявкой стоят договорённости с исполнителем, и менять её предмет задним числом
 * нельзя. Технику при правке не меняют вовсе — это другая заявка; вложения после заведения живут
 * вкладкой «Документы» карточки.
 *
 * Номенклатуры форма не спрашивает ни у заведения, ни у правки (Р15): заявитель её не знает, и его
 * дело — сказать словами, чего не хватает. Состав заполняет исполнитель, окном вкладки
 * «Номенклатура»; подписи полей — по таблице Р17, вопросами, а не именами реквизитов.
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

  const selected = equipmentOptions.find((option) => option.value === equipmentId);
  const warrantyActive = isWarrantyActive(selected?.warrantyUntil);

  /**
   * Аппарат в форме не назван (Р5, Р7). У заведения это пустое поле, у правки — заявка, у которой
   * предмета нет вовсе (Р8): технику при правке не меняют, и оба случая отвечают на один вопрос —
   * показывать ли то, что бывает только у аппарата.
   */
  const noEquipment = request ? !request.equipment : !equipmentId;
  /**
   * Право заводить заявку без аппарата (Р5). Спрашивается как обычное право: своей двери у него
   * нет — оно лишь снимает требование аппарата с общего заведения, а отказ по нему даёт маршрут.
   */
  const canSkipEquipment = can('serviceRequests.createWithoutEquipment');
  /** Заявка заводится без аппарата: поле пусто, и оставить его пустым разрешено. */
  const withoutEquipment = !request && noEquipment && canSkipEquipment;

  /**
   * Заказчик заявки (Р11, Р11а, Р11б, Р12): площадка выбранной сейчас единицы либо отдел, от чьего
   * имени просят. Состав групп, границу площадки роли отдела, сохранённого заказчика правки и
   * запертость до выбора техники считает подбор — форме остаётся сказать, какую единицу выбрали
   * (опция справочника подходит под его тип целиком) и какую заявку правят: при правке единицу не
   * выбирают вовсе, и оба её снимка берутся из самой заявки.
   *
   * У заявки БЕЗ аппарата состав задаёт ось роли (Р6), и подбор считает её сам — форме остаётся
   * сказать, что аппарата не будет: поле техники пусто, а право оставить его пустым есть.
   */
  const customer = useServiceRequestCustomer({ request, equipment: selected, withoutEquipment });

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
  const kind: ServiceRequestKind = request
    ? request.kind
    : claim
      ? 'repair'
      : (chosenKind ?? 'repair');
  const consumable = kind === 'consumable';

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    resetAttachments();
    if (request) {
      form.setFieldsValue({
        // У заявки без аппарата поле пустое — и остаётся таким: технику при правке не меняют
        // вовсе (её выбор выключен), а подставить сюда нечего (Р8).
        officeEquipmentId: request.equipment?.id,
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
      // Пара «не тот объект» (Р16) заводится выключенной: умолчание заявки — объект из карточки
      // техники, и заявленным расхождение становится только нажатием.
      objectOverridden: false,
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
    mutationFn: (values: Values) => {
      // Обе половины пары, а не одна: у заявки без аппарата заказчиком бывает и площадка, и её
      // идентификатор уходит тем же `objectId`, которым у заявки с аппаратом называют «не тот
      // объект» (Р6). Какой из двух смыслов сегодня — знает отправка, и разбирается это там.
      const pair = customer.customerPairOf(values.customer);
      return submitServiceRequest(values, {
        request,
        claim,
        customerDepartmentId: pair.departmentId,
        customerObjectId: pair.objectId,
        requesterPlace: place.body(values.requesterPlaceId),
        fileIds: attachments.ids,
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
    // Отказ разбирает отдельный модуль: кодов три, и у каждого своё место на экране.
    onError: (e, values) =>
      reportServiceRequestFailure(e, {
        withoutEquipment: !request && !values.officeEquipmentId,
        blockers,
        message,
      }),
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
          <Form.Item name="kind" label="Чем помочь">
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
          optional={canSkipEquipment}
          selected={selected}
          options={equipmentOptions}
          loading={equipmentLoading}
          open={open}
        />

        {/* Строк номенклатуры здесь больше нет (Р15): заявитель не выбирает позиции справочника —
            он говорит словами, чего не хватает, а состав заполняет исполнитель, которому везти. */}

        {/* Гарантия — вопрос ремонта: картридж со своего склада ни по чьей гарантии не выдают.

            И вопрос КОНКРЕТНОГО аппарата (Р7): обращаются либо по гарантии поставщика на него,
            либо по работе, выполненной на нём же. Без аппарата блока нет вовсе — не «пока не
            сделали», а «не бывает»: схема заведения такую пару отбивает, а форма не должна
            показывать то, чего нельзя ни поставить, ни отправить. */}
        {!consumable && !noEquipment && (
          <ServiceRequestWarrantyClaim
            active={warrantyActive}
            claim={claim}
            source={warrantySource}
          />
        )}

        {/* Главное и единственное поле про суть заявки: строк номенклатуры под ним больше нет
            (Р15), заявитель отвечает словами.

            Подпись общая на оба вида (Р2, просьба 7): заказчик просит единообразия, поэтому
            кинд-зависимые «Что случилось / Что нужно», введённые Р17 ADR 0145 и до прода не
            доехавшие, отменены — и здесь, и в карточке, и в столбце списка, и в словаре истории.
            Сообщение обязательности тоже перестало ветвиться: у одного поля один ответ на вопрос
            «почему не отправляется».

            Плейсхолдер ниже ветвится по-прежнему, и это не недоделка: он подсказывает, а не
            называет, а пример «закончился чёрный тонер» на заявке про мятую бумагу — просто мимо. */}
        <Form.Item
          name="description"
          label="Описание"
          rules={[
            { required: true, message: 'Опишите, о чём заявка' },
            { min: 5, message: 'Напишите подробнее' },
          ]}
        >
          <Input.TextArea
            rows={3}
            maxLength={4000}
            showCount
            placeholder={
              consumable
                ? 'Например: закончился чёрный тонер, печатать нечем'
                : 'Например: мнёт бумагу на каждой второй странице'
            }
          />
        </Form.Item>

        {/* «Желаемый срок» из заявки убран целиком (Р115): срок, который ничего не запирает,
            через месяц стоит просроченным у половины заявок. Давность читается возрастом в
            статусе — он и сортируется, и точнее отвечает на вопрос «кто тянет». */}
        <Form.Item
          name="customer"
          label="Для кого заявка"
          // Пустого состояния у поля нет (Р12а): «от площадки» — такой же выбор, как отдел, а не
          // незаполненное поле, и уходит он явным `null`. У заявки без аппарата обязательность
          // держит уже не только форма: заказчик там — единственное, чем заявка попадает в чью-то
          // область, и ни одного не назвав, её не примет ни схема, ни `CHECK` предмета (Р7).
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
          nameLabel="Кто обращается"
          phoneLabel="Телефон для связи"
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

        <Form.Item name="comment" label="Что ещё важно знать">
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

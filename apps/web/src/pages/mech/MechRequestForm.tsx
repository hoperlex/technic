import { useEffect, useState } from 'react';
import { Alert, App, AutoComplete, DatePicker, Form, Input } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { mechEditScope, type MechRequestDto } from '@technic/contracts';
import {
  mechFailureText,
  mechKindOptionsQuery,
  mechRequestKeys,
  mechRequestsApi,
} from '@entities/mech-request';
import { FormModal, useFormBlockers } from '@shared/ui';
import { MechRequestAttachments, useMechAttachments } from './MechRequestAttachments';
import { useMechRequesterFields } from './MechRequesterFields';
import { ResponsibleFields } from '../../components/ResponsibleFields';

const DATE = 'YYYY-MM-DD';

interface Values {
  customer: string;
  placeObjectId?: string;
  kindName: string;
  plannedFrom: Dayjs;
  plannedTo: Dayjs;
  responsibleName: string;
  responsiblePhone: string;
  comment?: string;
}

/**
 * Форма заявки на аренду механизации: что нужно, куда, на какой срок и к кому везти.
 *
 * Что из полей правится сейчас, решает **барьер состояния** (`mechEditScope`, Р19), а не статус «на
 * глаз»: у «Новой» правится всё, у взятой в работу — только контакт, комментарий и вложения, у
 * закрытой — комментарий и вложения. Срок, вид, площадка и заявитель после «Новой» неизменяемы для
 * всех, включая администратора: за ними стоит договорённость с арендодателем, и двигать её обязано
 * продление со своей причиной и своим событием истории, а не штатная форма.
 *
 * Барьер роли (Б2) тем же не заменяется: площадка и отдел правят заявку только в «Новой», и решает
 * это меню действий — форму им попросту не открыть. Здесь остаётся ответ на «что вообще можно
 * менять у записи в таком состоянии», одинаковый для всех ролей.
 */
export function MechRequestForm({
  open,
  request,
  onClose,
}: {
  open: boolean;
  /** `null` — заведение новой заявки. */
  request: MechRequestDto | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const blockers = useFormBlockers(form);
  const attachments = useMechAttachments(request, open);
  const customerKey = Form.useWatch('customer', form);

  /**
   * Подсказка ранее вводившихся видов (Р5). Ввод уходит на сервер: перечень строится по области
   * смотрящего и по частоте внутри неё, и отбор двадцати первых на клиенте отвечал бы на другой
   * вопрос — «что чаще всего», а не «что похоже на набранное».
   */
  const [kindInput, setKindInput] = useState('');
  const { data: kindOptions = [] } = useQuery({
    ...mechKindOptionsQuery(kindInput),
    enabled: open,
  });

  /*
   * Барьер состояния: `all` — «Новая», `contact` — взятая в работу, `comment` — закрытая. У
   * заведения барьера нет вовсе: заявки ещё не существует, и запрещать в ней нечего.
   */
  const scope = request ? mechEditScope(request) : 'all';
  const lockedSubject = scope !== 'all';
  const lockedContact = scope === 'comment';

  const requester = useMechRequesterFields({
    request,
    customerKey,
    disabled: lockedSubject,
  });
  const { savedKey, soleKey } = requester;

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (request) {
      form.setFieldsValue({
        // Заявитель — ключом от подбора (К7): он собран по снимкам самой заявки, а не по
        // действующему справочнику, и держится в списке, даже выпав из состава поля.
        customer: savedKey ?? undefined,
        // Площадка ставится всегда, а показывается только у заявки отдела: у заявки площадки поле
        // не рисуется вовсе, и лишнее значение в форме до тела запроса не доедет.
        placeObjectId: request.objectId,
        kindName: request.kindName,
        plannedFrom: dayjs(request.plannedFrom),
        plannedTo: dayjs(request.plannedTo),
        responsibleName: request.responsibleName,
        responsiblePhone: request.responsiblePhone,
        comment: request.comment,
      });
      setKindInput(request.kindName);
      return;
    }
    // Единственный доступный заявитель подставляется сам: заперто поле его не подставит, а
    // заперто оно как раз тогда, когда вариант один.
    form.setFieldsValue({ customer: soleKey ?? undefined });
    setKindInput('');
  }, [open, request, form, savedKey, soleKey]);

  const mutation = useMutation({
    mutationFn: (values: Values) => {
      const pair = requester.bodyOf(values.customer, values.placeObjectId);
      const contact = {
        responsibleName: values.responsibleName.trim(),
        responsiblePhone: values.responsiblePhone.trim(),
      };
      const comment = values.comment?.trim() ?? '';
      if (request) {
        /*
         * Тело правки собирается по барьеру, а не «всё, что в форме»: у взятой в работу заявки
         * поля срока и предмета заперты, и прислать их значило бы отказ сервера на значения,
         * которые человек и не трогал.
         */
        return mechRequestsApi.update(request.id, {
          ...(scope === 'all' && pair
            ? {
                objectId: pair.objectId,
                departmentId: pair.departmentId ?? null,
                kindName: values.kindName.trim(),
                plannedFrom: values.plannedFrom.format(DATE),
                plannedTo: values.plannedTo.format(DATE),
              }
            : {}),
          ...(lockedContact ? {} : contact),
          comment,
          ...attachments.patch,
          version: request.version,
        });
      }
      return mechRequestsApi.create({
        objectId: pair!.objectId,
        ...(pair!.departmentId ? { departmentId: pair!.departmentId } : {}),
        kindName: values.kindName.trim(),
        plannedFrom: values.plannedFrom.format(DATE),
        plannedTo: values.plannedTo.format(DATE),
        ...contact,
        comment,
        fileIds: attachments.ids,
      });
    },
    onSuccess: () => {
      message.success(request ? 'Заявка сохранена' : 'Заявка заведена');
      void qc.invalidateQueries({ queryKey: mechRequestKeys.root });
      onClose();
    },
    onError: (e) => {
      if (!blockers.fromApi(e)) message.error(mechFailureText(e));
    },
  });

  const submit = (values: Values) => {
    // Заявитель вне состава поля наружу не уходит вовсе: иначе портал отправил бы заказчика,
    // которого сам же не предлагал, и заявка ушла бы без площадки.
    if (!requester.bodyOf(values.customer, values.placeObjectId)) {
      blockers.raise({
        customer: 'Выберите заявителя',
        placeObjectId: requester.isDepartment ? 'Выберите площадку' : undefined,
      });
      return;
    }
    mutation.mutate(values);
  };

  return (
    <FormModal
      title={request ? `Заявка ${request.displayNumber}` : 'Новая заявка на аренду'}
      open={open}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={mutation.isPending}
      width={620}
    >
      <Form form={form} layout="vertical" onFinish={submit} {...blockers.formProps}>
        {lockedSubject && (
          // Почему половина полей заперта — сказано до попытки, а не отказом после нажатия.
          <Alert
            type="info"
            showIcon
            title="Предмет заявки уже нельзя менять"
            description={
              lockedContact
                ? 'Заявка закрыта: правятся комментарий и вложения — акт приходит позже, и подшить его надо.'
                : 'За сроком, видом и площадкой стоит договорённость с арендодателем. Срок двигает продление, договорённость — действие «Изменить договорённость».'
            }
            style={{ marginBottom: 16 }}
          />
        )}

        {requester.fields}

        <Form.Item
          name="kindName"
          label="Вид техники"
          extra="Свободная строка: портал подсказывает то, что уже арендовали."
          rules={[
            { required: true, message: 'Укажите вид техники' },
            { whitespace: true, message: 'Укажите вид техники' },
            { max: 255, message: 'Слишком длинное наименование' },
          ]}
        >
          <AutoComplete
            options={kindOptions}
            onSearch={setKindInput}
            disabled={lockedSubject}
            placeholder="Например: виброплита реверсивная 90 кг"
          />
        </Form.Item>

        <Form.Item
          name="plannedFrom"
          label="Подача"
          rules={[{ required: true, message: 'Укажите дату подачи' }]}
        >
          <DatePicker
            style={{ width: 220 }}
            format="DD.MM.YYYY"
            allowClear={false}
            disabled={lockedSubject}
          />
        </Form.Item>

        <Form.Item
          name="plannedTo"
          label="Плановый возврат"
          dependencies={['plannedFrom']}
          rules={[
            { required: true, message: 'Укажите дату возврата' },
            /*
             * Порядок дат проверяется и здесь, и схемой контрактов, и сервером. Здесь — потому
             * что это единственное место, где человек видит обе даты сразу: отказ сервера пришёл
             * бы после нажатия и без указания, какую из них править.
             */
            ({ getFieldValue }) => ({
              validator: (_r, value: Dayjs | null | undefined) => {
                const from = getFieldValue('plannedFrom') as Dayjs | undefined;
                return !value || !from || !value.isBefore(from, 'day')
                  ? Promise.resolve()
                  : Promise.reject(new Error('Дата возврата не может быть раньше даты подачи'));
              },
            }),
          ]}
        >
          <DatePicker
            style={{ width: 220 }}
            format="DD.MM.YYYY"
            allowClear={false}
            disabled={lockedSubject}
          />
        </Form.Item>

        {/* Ответственный — тот, к кому арендодатель везёт технику: адрес отвечает «куда», а этот
            контакт — «к кому и кому звонить, если на месте никого». Правится, пока заявка не
            закрыта: у закрытой принимать технику уже некому, и правка переписывала бы историю. */}
        <ResponsibleFields
          nameField="responsibleName"
          phoneField="responsiblePhone"
          nameLabel="Кто принимает технику"
          phoneLabel="Телефон для связи"
          disabled={lockedContact}
          kept={
            request ? { name: request.responsibleName, phone: request.responsiblePhone } : undefined
          }
        />

        <Form.Item name="comment" label="Комментарий">
          <Input.TextArea rows={2} maxLength={2000} placeholder="Необязательно" />
        </Form.Item>

        {/* Вложения правятся в любом состоянии, кроме архива (Р14, Р19): счёт и акт приходят
            позже самой аренды, и подшить их надо к той же заявке. */}
        <MechRequestAttachments attachments={attachments} disabled={scope === 'none'} />
      </Form>
    </FormModal>
  );
}

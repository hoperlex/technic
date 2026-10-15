import { useEffect, useRef } from 'react';
import { Alert, App, DatePicker, Form, Input } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { mechEditScope, type MechRequestDto } from '@technic/contracts';
import { mechModelOptionsQuery } from '@entities/mech-model';
import { mechFailureText, mechRequestKeys, mechRequestsApi } from '@entities/mech-request';
import { useAuth } from '@entities/session';
import {
  AutoSelect,
  FormModal,
  LocalFormDraftNotice,
  RequestCreateAttemptNotice,
  useFormBlockers,
} from '@shared/ui';
import {
  FormDraftAutosave,
  LocalCreateAttemptError,
  objectDraftPayload,
  restoreFormDateFields,
  storeFormDateFields,
  useDeferredOptions,
  useLocalFormDraft,
  withSavedOption,
} from '@shared/lib';
import { MechRequestAttachments, useMechAttachments } from './MechRequestAttachments';
import { useMechRequesterFields } from './MechRequesterFields';
import { PhoneInput } from '@entities/user-account';
import { ResponsibleFields } from '@entities/request';

const DATE = 'YYYY-MM-DD';

interface Values {
  customer: string;
  placeObjectId?: string;
  mechModelId: string;
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
 * закрытой — комментарий и вложения. Срок, модель, площадка и заявитель после «Новой» неизменяемы
 * для всех, включая администратора: за ними стоит договорённость с арендодателем, и двигать её
 * обязано продление со своей причиной и своим событием истории, а не штатная форма.
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
  const { user } = useAuth();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const restored = useRef(false);
  const draft = useLocalFormDraft({
    userId: user?.id ?? null,
    form: 'mech-request',
    read: () => storeFormDateFields(form.getFieldsValue(true), ['plannedFrom', 'plannedTo']),
    parse: objectDraftPayload,
  });
  const blockers = useFormBlockers(form);
  const attachments = useMechAttachments(request, open);
  const customerKey = Form.useWatch('customer', form);

  /**
   * Models fit in one locally searched response (ADR 0156). An edited request keeps its saved
   * model label even after deactivation; otherwise an unchanged edit would display a raw ID.
   */
  const {
    options: modelOptions,
    loading: modelsLoading,
    current: modelsCurrent,
  } = useDeferredOptions(mechModelOptionsQuery(), open, (options) => options, 'pick');
  const models = withSavedOption(modelOptions ?? [], {
    id: request?.mechModelId,
    name: request?.mechModelName,
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
    open,
  });
  const { savedKey, soleKey } = requester;

  useEffect(() => {
    if (!open) return;
    if (restored.current && !request) return;
    form.resetFields();
    if (request) {
      form.setFieldsValue({
        // Заявитель — ключом от подбора (К7): он собран по снимкам самой заявки, а не по
        // действующему справочнику, и держится в списке, даже выпав из состава поля.
        customer: savedKey ?? undefined,
        // Площадка ставится всегда, а показывается только у заявки отдела: у заявки площадки поле
        // не рисуется вовсе, и лишнее значение в форме до тела запроса не доедет.
        placeObjectId: request.objectId,
        // Ссылки может не быть у заявки, заведённой до справочника: поле останется пустым, и
        // сохранение потребует назвать модель — иначе строгий выбор обходился бы правкой.
        mechModelId: request.mechModelId ?? undefined,
        plannedFrom: dayjs(request.plannedFrom),
        plannedTo: dayjs(request.plannedTo),
        responsibleName: request.responsibleName,
        responsiblePhone: request.responsiblePhone,
        comment: request.comment,
      });
      return;
    }
  }, [open, request, form, savedKey]);

  useEffect(() => {
    if (!open) restored.current = false;
  }, [open]);
  const { begin } = draft;
  useEffect(() => {
    if (open && !request) begin('create');
  }, [open, request, begin]);

  useEffect(() => {
    // PICK may finish after the new form opens. Filling its only customer must not reset contact,
    // dates or model that the person entered while the directory was loading.
    if (
      open &&
      !request &&
      soleKey &&
      !form.isFieldTouched('customer') &&
      !form.getFieldValue('customer')
    ) {
      form.setFieldValue('customer', soleKey);
    }
  }, [open, request, soleKey, form]);

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
                mechModelId: values.mechModelId,
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
      const payload = {
        objectId: pair!.objectId,
        ...(pair!.departmentId ? { departmentId: pair!.departmentId } : {}),
        mechModelId: values.mechModelId,
        plannedFrom: values.plannedFrom.format(DATE),
        plannedTo: values.plannedTo.format(DATE),
        ...contact,
        comment,
        fileIds: attachments.ids,
      };
      const attempt = draft.prepareCreate(payload);
      return mechRequestsApi.create(attempt.body, attempt.key);
    },
    onSuccess: () => {
      if (!request) draft.clear();
      message.success(request ? 'Заявка сохранена' : 'Заявка заведена');
      void qc.invalidateQueries({ queryKey: mechRequestKeys.root });
      onClose();
    },
    onError: (e) => {
      if (!request && !(e instanceof LocalCreateAttemptError) && draft.active?.createAttempt)
        message.warning('Исход создания нужно проверить перед исправлением заявки.');
      if (!blockers.fromApi(e)) message.error(mechFailureText(e));
    },
  });

  const reconcile = useMutation({
    mutationFn: async () => {
      const attempt = draft.active?.createAttempt;
      if (!attempt) throw new LocalCreateAttemptError('Нет попытки создания для проверки');
      if (attempt.protocol !== 'receipt-v1')
        throw new LocalCreateAttemptError('Проверьте исход старой отправки в списке заявок вручную');
      const result = await mechRequestsApi.reconcileCreate(
        attempt.body as Parameters<typeof mechRequestsApi.create>[0],
        attempt.key,
      );
      return { key: attempt.key, result };
    },
    onSuccess: ({ key, result }) => {
      if (result.state === 'created') {
        draft.clear();
        void qc.invalidateQueries({ queryKey: mechRequestKeys.root });
        message.success('Заявка создана');
        onClose();
        return;
      }
      if (draft.releaseCreateAttempt(key, result.nextOperationId))
        message.info('Создание не произошло. Исправьте форму и отправьте её заново.');
      else message.error('Не удалось сохранить результат проверки на этом устройстве');
    },
    onError: (e) => message.error(mechFailureText(e)),
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

  const close = () => {
    if (!request && draft.active) draft.persist();
    restored.current = false;
    onClose();
  };

  return (
    <FormModal
      title={request ? `Заявка ${request.displayNumber}` : 'Новая заявка на аренду'}
      open={open}
      onCancel={close}
      onSubmit={() => form.submit()}
      confirmLoading={mutation.isPending}
      okDisabled={!request && draft.pending.length > 0}
      width={620}
    >
      {!request && (
        <>
          <FormDraftAutosave active={open && !!draft.active} form={form} onSave={draft.persist} />
          <LocalFormDraftNotice
            active={!!draft.active}
            pending={draft.pending}
            status={draft.status}
            attemptKey={draft.active?.createAttempt?.key}
            fileNotice
            createMayHaveSucceeded
            onRestore={(candidate) => {
              restored.current = true;
              form.setFieldsValue(
                restoreFormDateFields<Values>(draft.restore(candidate), [
                  'plannedFrom',
                  'plannedTo',
                ]),
              );
            }}
            onDiscard={draft.discardPending}
          />
          <RequestCreateAttemptNotice
            pending={!!draft.active?.createAttempt}
            legacy={!!draft.active?.createAttempt && draft.active.createAttempt.protocol !== 'receipt-v1'}
            checking={reconcile.isPending || mutation.isPending}
            onCheck={() => reconcile.mutate()}
            onLegacyReset={() => {
              if (draft.resetLegacyCreateAttempt())
                message.info('Старая попытка сброшена. Перед отправкой проверьте данные заявки.');
              else message.error('Не удалось сохранить сброс попытки на этом устройстве');
            }}
          />
        </>
      )}
      {(request || draft.pending.length === 0) && (
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => {
            if (!request) draft.persist();
            submit(values);
          }}
          {...blockers.formProps}
        >
          {lockedSubject && (
            // Почему половина полей заперта — сказано до попытки, а не отказом после нажатия.
            <Alert
              type="info"
              showIcon
              title="Предмет заявки уже нельзя менять"
              description={
                lockedContact
                  ? 'Заявка закрыта: правятся комментарий и вложения — акт приходит позже, и подшить его надо.'
                  : 'За сроком, моделью и площадкой стоит договорённость с арендодателем. Срок двигает продление, договорённость — действие «Изменить договорённость».'
              }
              style={{ marginBottom: 16 }}
            />
          )}

          {requester.fields}

          {/* Модель — строго из справочника (ADR 0156): свободной строки у поля больше нет. Нужной
            позиции в списке не нашлось — её заводит держатель справочников на своей вкладке, и
            ярлыка «завести прямо отсюда» первым выпуском намеренно нет. */}
          <Form.Item
            name="mechModelId"
            label="Модель"
            rules={[{ required: true, message: 'Выберите модель' }]}
          >
            <AutoSelect
              showSearch
              optionFilterProp="label"
              options={models}
              loading={modelsLoading}
              autoSelectSole={modelsCurrent}
              disabled={lockedSubject}
              placeholder="Например: виброплита Wacker DPU 3070Н"
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
              request
                ? { name: request.responsibleName, phone: request.responsiblePhone }
                : undefined
            }
            phoneInput={PhoneInput}
          />

          <Form.Item name="comment" label="Комментарий">
            <Input.TextArea rows={2} maxLength={2000} placeholder="Необязательно" />
          </Form.Item>

          {/* Вложения правятся в любом состоянии, кроме архива (Р14, Р19): счёт и акт приходят
            позже самой аренды, и подшить их надо к той же заявке. */}
          <MechRequestAttachments attachments={attachments} disabled={scope === 'none'} />
        </Form>
      )}
    </FormModal>
  );
}

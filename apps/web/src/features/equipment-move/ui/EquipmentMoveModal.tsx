import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Checkbox, DatePicker, Form, Input, Select } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  OFFICE_EQUIPMENT_MOVE_CONFLICT_CODE,
  OFFICE_EQUIPMENT_STATES,
  officeEquipmentStateLabels,
  officeEquipmentStateNeedsNote,
  officeEquipmentTitle,
  type MoveOfficeEquipmentSide,
  type OfficeEquipmentDto,
  type OfficeEquipmentMoveConflictDetails,
  type OfficeEquipmentMovePlaceDto,
  type OfficeEquipmentState,
  type ServiceRequestDto,
} from '@technic/contracts';
import {
  officeEquipmentApi,
  officeEquipmentConsumableKeys,
  officeEquipmentKeys,
  officeEquipmentModelKeys,
} from '@entities/office-equipment';
import { objectOptionsQuery } from '@entities/object';
import { departmentOptionsQuery } from '@entities/department';
import { serviceRequestKeys, serviceRequestObjectLabel } from '@entities/service-request';
import { isApiError } from '@shared/api';
import { errorMessage } from '@shared/lib';
import { FormModal } from '@shared/ui';

const DATE = 'YYYY-MM-DD';

interface Values {
  objectId: string;
  departmentId?: string | null;
  location: string;
  state: OfficeEquipmentState;
  stateNote: string;
  movedOn: Dayjs;
  reason: string;
  comment?: string;
  /** «Подтверждаю заявленное место» (Р8) — решение человека, а не следствие ссылки на заявку. */
  confirmsDeclaredPlace: boolean;
}

/** Что заявка сказала о месте: этим и объясняется баннер, подстановка и галочка (Р7). */
interface Declared {
  objectId: string;
  objectLabel: string;
  /** Дата заявления — день заведения заявки: снимок объекта после создания не правится (Р6). */
  at: string;
  number: string;
}

/**
 * Заявленное место, ещё не разобранное (Р7). Спрашивается ВЫЧИСЛЯЕМЫЙ `objectMismatch`, а не факт
 * заявления (`objectOverridden`): первый гаснет сам — переносом единицы или подтверждающим
 * перемещением (Р8), — и баннер вместе с ним. Второй не гаснет ничем, и окно предлагало бы
 * подтвердить место по заявлению, разобранному полгода назад.
 *
 * Статус заявки условием не является: `objectMismatch` в DTO означает факт расхождения независимо
 * от него (Р8, находка Н12), а кнопка перемещения живёт у заявки до самого архива (Р6).
 */
function declaredPlace(request: ServiceRequestDto | null | undefined): Declared | null {
  if (!request?.objectMismatch || !request.object) return null;
  const label = serviceRequestObjectLabel(request);
  if (!label) return null;
  return {
    objectId: request.object.id,
    objectLabel: label,
    at: dayjs(request.createdAt).format('DD.MM.YYYY'),
    number: request.displayNumber,
  };
}

/**
 * «Техника уже переехала» (Р3): текущее место из тела `409`, а не из общего текста ошибки.
 *
 * Разбирается здесь, потому что здесь известно, чего ждали: транспорт про ручки не знает и отдаёт
 * `details` как есть. Чужой отказ (403, 422, пятисотка) сюда не попадает — он уходит тостом.
 */
function moveConflict(e: unknown): OfficeEquipmentMovePlaceDto | null {
  if (!isApiError(e) || e.code !== OFFICE_EQUIPMENT_MOVE_CONFLICT_CODE) return null;
  const details = e.details as OfficeEquipmentMoveConflictDetails | undefined;
  return details?.current ?? null;
}

/** Место словами — тем же порядком, каким его называет отказ сервера: пустые части опускаются. */
function placeWords(place: OfficeEquipmentMovePlaceDto): string {
  return [
    place.objectName,
    place.location,
    officeEquipmentStateLabels[place.state],
    place.stateNote,
  ]
    .filter((part) => part !== '')
    .join(' · ');
}

/**
 * Перемещение единицы (план модернизации, Р59–Р61).
 *
 * Своё окно, а не поле карточки: у переезда есть дата (технику увозят в пятницу, а в портал
 * заносят в понедельник), причина и обе стороны — из этого и складывается журнал, по которому
 * потом отвечают на вопрос «где этот аппарат стоял в мае».
 *
 * Целевой объект — любой активный (Р60). Отдающий ничего не получает на чужой площадке: он теряет
 * технику из своего списка, и предупреждение об этом стоит прямо в окне — иначе «куда делся
 * принтер» выясняется через неделю.
 *
 * ОКНО, ОТКРЫТОЕ ИЗ ЗАЯВКИ, ЗНАЕТ О ЗАЯВЛЕННОМ МЕСТЕ (план
 * `docs/office-equipment-move-from-request-plan.md`, Р7, находка Н4). Заявитель сказал «аппарат
 * стоит на другой площадке» — и разбирают это заявление здесь, а не сверкой двух экранов на память:
 * баннер называет заявленный объект, целевым предлагается он же, причина предлагается ссылкой на
 * заявку, а галочка отвечает на вопрос «этим действием заявленное место подтверждено» (Р8).
 *
 * Ни одно поле не заполняется молча: подстановка ПРЕДЛАГАЕТ, решение принимает ответственный, и в
 * журнал уходит то, что он видел. Поэтому галочка приходит снятой — перемещение по заявке бывает и
 * служебным («увезли в сервис»), и оно на вопрос «где аппарат на самом деле» не отвечает.
 */
export function EquipmentMoveModal({
  equipment,
  /** Заявка, из-за которой единицу везут: связывает запись с ремонтом. */
  serviceRequestId,
  request,
  onClose,
}: {
  /** `null` — окно закрыто. */
  equipment: OfficeEquipmentDto | null;
  serviceRequestId?: string | null;
  /**
   * Сама заявка — тем, кто открыл окно из неё: заявленный объект, дата заявления и номер. Ссылка
   * на заявку при этом остаётся отдельным свойством: она известна из самого входа, а карточка
   * заявки может и не доехать — и терять из-за этого связь записи с ремонтом было бы нечем.
   */
  request?: ServiceRequestDto | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const state = Form.useWatch('state', form);
  const objectId = Form.useWatch('objectId', form);
  /**
   * Текущее место из отказа `409` (Р3). Оно же становится «откуда» повторной отправки: сервер
   * прочитал его под блокировкой строки, то есть это самый свежий ответ на вопрос, откуда едем.
   */
  const [conflict, setConflict] = useState<OfficeEquipmentMovePlaceDto | null>(null);

  const declared = useMemo(() => declaredPlace(request), [request]);

  const { data: objectOptions = [] } = useQuery({
    ...objectOptionsQuery({ activeOnly: true }),
    enabled: !!equipment,
  });
  const { data: departmentOptions = [] } = useQuery({
    ...departmentOptionsQuery(),
    enabled: !!equipment,
  });

  useEffect(() => {
    if (!equipment) return;
    // Карточка перечитана — прежний отказ к ней уже не относится, и «откуда» снова снимается с
    // показанного.
    setConflict(null);
    form.setFieldsValue({
      // Целевым предлагается ЗАЯВЛЕННЫЙ объект, если заявление есть и не разобрано: разбирать его
      // и есть то, ради чего окно открыли. Человек волен выбрать третий — аппарат нередко
      // находится там, где не ждал никто (находка Н6).
      objectId: declared?.objectId ?? equipment.object.id,
      departmentId: equipment.department?.id ?? null,
      location: equipment.location,
      state: equipment.state,
      stateNote: equipment.stateNote,
      movedOn: dayjs(),
      reason: declared ? `Подтверждение места по заявке ${declared.number}` : '',
      comment: '',
      confirmsDeclaredPlace: false,
    });
  }, [equipment, declared, form]);

  const mutation = useMutation({
    mutationFn: (values: Values) => {
      /*
       * «Откуда» снимается с ПОКАЗАННОЙ карточки, а не с полей формы (Р3): поля — это «куда», и
       * человек их правит. Собери мы `from` из них, сверка сравнивала бы сервер с намерением, а
       * не с тем, что человек видел, — и подменить исходную сторону можно было бы правкой поля.
       */
      const from: MoveOfficeEquipmentSide = conflict
        ? {
            objectId: conflict.objectId,
            departmentId: conflict.departmentId,
            location: conflict.location,
            state: conflict.state,
            stateNote: conflict.stateNote,
          }
        : {
            objectId: equipment!.object.id,
            departmentId: equipment!.department?.id ?? null,
            location: equipment!.location,
            state: equipment!.state,
            stateNote: equipment!.stateNote,
          };
      return officeEquipmentApi.move(equipment!.id, {
        from,
        objectId: values.objectId,
        departmentId: values.departmentId ?? null,
        location: values.location?.trim() ?? '',
        state: values.state,
        stateNote: values.stateNote?.trim() ?? '',
        movedOn: values.movedOn.format(DATE),
        reason: values.reason.trim(),
        comment: values.comment?.trim() ?? '',
        serviceRequestId: serviceRequestId ?? null,
        // Подтверждение места (Р8) — только там, где есть что подтверждать: без заявленного
        // расхождения галочки нет вовсе, и схема такого тела не принимает.
        confirmsDeclaredPlace: !!declared && !!values.confirmsDeclaredPlace,
      });
    },
    onSuccess: () => {
      message.success('Перемещение записано');
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      // Переезд меняет и область, и состояние карточки, а счётчик «В парке» считается по ним
      // обоим (матрица Р14). Считают его два окна — моделей и расходников, — и устаревают оба.
      void qc.invalidateQueries({ queryKey: officeEquipmentModelKeys.root });
      void qc.invalidateQueries({ queryKey: officeEquipmentConsumableKeys.root });
      // Заявки показывают реквизиты снимком, но карточка единицы в них тянется отдельно — и
      // состояние техники там же. Признак расхождения (`objectMismatch`) считает сервер, и
      // подтверждённое место гасит его тем же ответом.
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
      onClose();
    },
    onError: (e) => {
      const current = moveConflict(e);
      // Отказ «уже переехала» остаётся В ОКНЕ, а не улетает тостом: он не про опечатку в поле, а
      // про изменившийся мир, и читать его человеку придётся вместе с тем, что он собирался
      // записать.
      if (current) setConflict(current);
      else message.error(errorMessage(e));
    },
  });

  const leavesScope = !!equipment && objectId !== undefined && objectId !== equipment.object.id;

  return (
    <FormModal
      title={equipment ? `Переместить ${officeEquipmentTitle(equipment)}` : 'Перемещение'}
      open={!!equipment}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={mutation.isPending}
      okText="Записать перемещение"
      width={560}
    >
      <Form form={form} layout="vertical" onFinish={(v) => mutation.mutate(v)}>
        {declared && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            title={`Заявитель сообщил: аппарат стоит на «${declared.objectLabel}»`}
            description={`Заявлено ${declared.at} в заявке ${declared.number}. Объект и причина ниже подставлены по заявлению — исправьте их, если аппарат нашёлся не там.`}
          />
        )}

        {conflict && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
            title="Техника уже переехала"
            description={
              <>
                {`Сейчас она здесь: ${placeWords(conflict)}. Повторная запись уйдёт уже от этого места — проверьте, куда её везти.`}
                <div>
                  <Button type="link" size="small" style={{ paddingInline: 0 }} onClick={onClose}>
                    Открыть окно заново
                  </Button>
                </div>
              </>
            }
          />
        )}

        {leavesScope && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            title="Техника уйдёт с вашей площадки"
            description="После записи она пропадёт из вашего справочника и появится у принимающей стороны. Вернуть её сможет тот, к кому она приехала."
          />
        )}

        <Form.Item
          name="objectId"
          label="Объект"
          rules={[{ required: true, message: 'Выберите объект' }]}
        >
          <Select showSearch optionFilterProp="label" options={objectOptions} />
        </Form.Item>

        <Form.Item name="location" label="Место внутри объекта">
          <Input maxLength={255} placeholder="кабинет 214, прорабская" />
        </Form.Item>

        <Form.Item name="departmentId" label="Отдел-владелец">
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="Не закреплена"
            options={departmentOptions}
          />
        </Form.Item>

        <Form.Item name="state" label="Где находится">
          <Select
            options={OFFICE_EQUIPMENT_STATES.map((value) => ({
              value,
              label: officeEquipmentStateLabels[value],
            }))}
          />
        </Form.Item>

        {/* «На складе» и «у сотрудника» без уточнения — потерянная техника: искать её негде. */}
        {state && officeEquipmentStateNeedsNote(state) && (
          <Form.Item
            name="stateNote"
            label="Где именно"
            rules={[{ required: true, message: 'Уточните, где именно находится техника' }]}
          >
            <Input maxLength={255} placeholder="Склад АХО, стеллаж 3 · Иванов И. И." />
          </Form.Item>
        )}

        <Form.Item
          name="movedOn"
          label="Дата перемещения"
          rules={[{ required: true, message: 'Укажите дату' }]}
        >
          {/* Дата переезда, а не записи: технику увозят в пятницу, а заносят в понедельник. */}
          <DatePicker
            format="DD.MM.YYYY"
            style={{ width: 200 }}
            disabledDate={(d) => d.isAfter(dayjs().endOf('day'))}
          />
        </Form.Item>

        <Form.Item
          name="reason"
          label="Причина"
          rules={[{ required: true, message: 'Укажите причину перемещения' }]}
        >
          <Input maxLength={1000} placeholder="Перевод бухгалтерии, увезли в сервис, вернули" />
        </Form.Item>

        {/*
         * Галочка есть только там, где есть что подтверждать (Р7), и приходит снятой (Р8): ею
         * гасится очередь расхождений ИТ-службы — в обоих исходах, и когда аппарат нашёлся там,
         * где заявили, и когда в третьем месте (находка Н6).
         */}
        {declared && (
          <Form.Item
            name="confirmsDeclaredPlace"
            valuePropName="checked"
            extra="Расхождение уйдёт из очереди ИТ-службы: место разобрано этим перемещением. Служебный переезд («увезли в сервис») галочки не требует."
          >
            <Checkbox>Подтверждаю заявленное место</Checkbox>
          </Form.Item>
        )}

        <Form.Item name="comment" label="Комментарий">
          <Input.TextArea rows={2} maxLength={1000} placeholder="Необязательно" />
        </Form.Item>
      </Form>
    </FormModal>
  );
}

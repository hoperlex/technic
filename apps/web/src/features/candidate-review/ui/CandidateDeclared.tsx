import { useEffect, useState } from 'react';
import { Button, Form, Input, Space, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type {
  OfficeEquipmentCandidateDto,
  UpdateOfficeEquipmentCandidateInput,
} from '@technic/contracts';
import { objectOptionsQuery } from '@entities/object';
import {
  officeEquipmentCandidatesApi,
  subjectCheckTitle,
} from '@entities/office-equipment-candidate';
import { officeEquipmentTypeOptionsQuery } from '@entities/office-equipment';
import { AutoSelect, useFormBlockers, ViewFields } from '@shared/ui';
import { useCandidateDecision } from '../model/decisions';

/** Шесть реквизитов в форме правки: те же поля, что заполнял заявитель (Р7, Р12). */
type Values = Omit<UpdateOfficeEquipmentCandidateInput, 'expectedVersion'>;

/**
 * «Что сообщил заявитель» — и правка сообщённого до решения (план
 * `docs/office-equipment-candidate-plan.md`, Р7, Р12, §9).
 *
 * ПРАВИТ ТОЛЬКО ПРОВЕРЯЮЩИЙ И ТОЛЬКО ПОКА `pending`. Автору правка закрыта после отправки: кандидат
 * — свидетельство о том, что человек видел в кабинете, и переписанное задним числом свидетельство
 * ничего не доказывает; уточнения идут репликой в обсуждении заявки (ADR 0141). Отклонять же
 * заявку из-за одной опечатки («O» вместо «0») значило бы заставить человека заводить её заново —
 * ровно того, ради чего кандидаты и вводились.
 *
 * ПОЛЯ УХОДЯТ ПОЛНЫМ НАБОРОМ, а не разницей: их шесть, форма показывает все шесть сразу, и «стереть
 * комментарий» с «не трогать комментарий» частичным телом не различить.
 *
 * ЧИТАЕМЫЙ ВИД — ПО УМОЛЧАНИЮ, форма открывается нажатием. Проверяющий разбирает очередь чтением,
 * а правит одну строку из десяти: форма вместо текста заставляла бы его каждый раз решать, менял
 * он что-нибудь или нет, — и одно случайное касание уходило бы новой версией с новым аудитом.
 */
export function CandidateDeclared({ candidate }: { candidate: OfficeEquipmentCandidateDto }) {
  const [editing, setEditing] = useState(false);
  const [form] = Form.useForm<Values>();
  const blockers = useFormBlockers(form);
  const editable = candidate.status === 'pending';

  const { data: typeOptions = [], isFetching: typesLoading } = useQuery({
    ...officeEquipmentTypeOptionsQuery(),
    enabled: editing,
  });
  const { data: objectOptions = [] } = useQuery({ ...objectOptionsQuery(), enabled: editing });

  useEffect(() => {
    if (!editing) return;
    // Форма открывается заявленным, а не пустой: правят опечатку в одном поле, а не заполняют
    // сообщение заново.
    form.setFieldsValue({
      equipmentTypeId: candidate.equipmentType.id,
      declaredModel: candidate.declaredModel,
      serialNumber: candidate.serialNumber,
      inventoryNumber: candidate.inventoryNumber,
      objectId: candidate.object.id,
      location: candidate.location,
      comment: candidate.comment,
    });
  }, [editing, candidate, form]);

  const save = useCandidateDecision(
    candidate.id,
    (values: Values) =>
      officeEquipmentCandidatesApi.update(candidate.id, {
        ...values,
        expectedVersion: candidate.contentVersion,
      }),
    { success: 'Сообщение поправлено', onDone: () => setEditing(false), blockers },
  );

  if (editing) {
    return (
      <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)} {...blockers.formProps}>
        <Form.Item name="equipmentTypeId" label="Тип" rules={[{ required: true }]}>
          <AutoSelect
            options={typeOptions}
            loading={typesLoading}
            showSearch
            optionFilterProp="label"
          />
        </Form.Item>
        <Form.Item name="declaredModel" label="Модель с шильдика" rules={[{ required: true }]}>
          <Input maxLength={255} />
        </Form.Item>
        <Form.Item name="serialNumber" label="Серийный номер">
          <Input maxLength={100} />
        </Form.Item>
        <Form.Item name="inventoryNumber" label="Инвентарный номер">
          <Input maxLength={100} />
        </Form.Item>
        <Form.Item name="objectId" label="Где стоит" rules={[{ required: true }]}>
          <AutoSelect options={objectOptions} showSearch optionFilterProp="label" />
        </Form.Item>
        <Form.Item name="location" label="Место" rules={[{ required: true }]}>
          <Input maxLength={255} />
        </Form.Item>
        <Form.Item name="comment" label="Комментарий заявителя">
          <Input.TextArea rows={2} maxLength={2000} />
        </Form.Item>
        <Space size={8}>
          <Button type="primary" htmlType="submit" loading={save.isPending}>
            Сохранить правку
          </Button>
          <Button onClick={() => setEditing(false)}>Отмена</Button>
        </Space>
      </Form>
    );
  }

  return (
    <>
      <ViewFields
        items={[
          { key: 'subject', label: 'Аппарат', full: true, children: subjectCheckTitle(candidate) },
          { key: 'type', label: 'Тип', children: candidate.equipmentType.name },
          {
            key: 'place',
            label: 'Где стоит',
            children: `${candidate.object.code} — ${candidate.object.name} · ${candidate.location}`,
          },
          /* Автор виден только проверяющему (Р9), и отсутствие поля означает «этот срез его не
             содержит», а не «автор неизвестен»: остальным контакт заявителя уже виден в заявке. */
          ...(candidate.author
            ? [
                {
                  key: 'author',
                  label: 'Сообщил',
                  children: [candidate.author.name, candidate.author.departmentName]
                    .filter(Boolean)
                    .join(' · '),
                },
              ]
            : []),
          ...(candidate.comment
            ? [{ key: 'comment', label: 'Комментарий', full: true, children: candidate.comment }]
            : []),
        ]}
      />
      {/* Правка объявлена ровно там, где сообщённое читают, и только у ожидающего: у решённого
          кандидата правки не предусмотрено вовсе («передумал» оформляется новой заявкой, Р15). */}
      {editable && (
        <Typography.Link onClick={() => setEditing(true)}>Поправить сообщённое</Typography.Link>
      )}
    </>
  );
}

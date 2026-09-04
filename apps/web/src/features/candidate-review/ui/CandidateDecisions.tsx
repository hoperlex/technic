import { useState } from 'react';
import { Button, Form, Input, Space } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { OfficeEquipmentCandidateDto } from '@technic/contracts';
import {
  officeEquipmentCandidatesApi,
  subjectCheckTitle,
} from '@entities/office-equipment-candidate';
import { officeEquipmentOptionsQuery } from '@entities/office-equipment';
import { AutoSelect, FormModal, useFormBlockers } from '@shared/ui';
import { useCandidateDecision } from '../model/decisions';

/**
 * Два решения из трёх, у которых своё окно (план `docs/office-equipment-candidate-plan.md`, Р15).
 *
 * ТРЕТЬЕ — «Завести карточку» — окна не имеет и живёт формой самой проверки: там заполняют полную
 * форму карточки парка, и второе окно поверх неё означало бы «нажмите ещё раз, чтобы отправить то,
 * что уже заполнили».
 *
 * ОБЪЕДИНЕНИЕ — НЕ «ВЫ ПРИСЛАЛИ ДУБЛЬ». Человек честно не нашёл карточку: она числилась за чужой
 * площадкой или была снята с эксплуатации, — и подписи не должны читаться упрёком. Целевая единица
 * выбирается из ДЕЙСТВУЮЩИХ карточек своей области: снятую с эксплуатации сервер отобьёт (Ф2), а
 * предложенная в списке, она обещала бы ход, которого нет, — её сначала возвращают в работу.
 *
 * ОТКАЗ ТРЕБУЕТ ПРИЧИНЫ, И ПРИЧИНУ ЧИТАЕТ ЗАЯВИТЕЛЬ (Р15, В5). Об этом сказано прямо под полем:
 * причина уходит в карточку заявки и в письмо дословно, и проверяющий обязан знать это, пока
 * подбирает слова, а не после того, как их прочитал автор.
 */
export function CandidateDecisions({
  candidate,
  onDone,
}: {
  candidate: OfficeEquipmentCandidateDto;
  /** Решение принято — окно проверки закрывается: разбирают следующую строку очереди. */
  onDone: () => void;
}) {
  const [mergeOpen, setMergeOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [mergeForm] = Form.useForm<{ officeEquipmentId: string }>();
  const [rejectForm] = Form.useForm<{ reason: string }>();
  const rejectBlockers = useFormBlockers(rejectForm);

  /*
   * Выдача справочника — срезом по набранному (Ф1): отбор ушёл на сервер, и он ищет и по обоим
   * номерам, и по месту, и по модели. Спрашивается только при открытом окне: объединение —
   * решение редкое, и запрос на каждое открытие проверки был бы платой ни за что.
   */
  const { data: options = [], isFetching: loading } = useQuery({
    ...officeEquipmentOptionsQuery(search),
    enabled: mergeOpen,
  });

  const merge = useCandidateDecision(
    candidate.id,
    (officeEquipmentId: string) =>
      officeEquipmentCandidatesApi.merge(candidate.id, {
        officeEquipmentId,
        expectedVersion: candidate.contentVersion,
      }),
    { success: 'Сообщение объединено с карточкой', onDone },
  );
  const reject = useCandidateDecision(
    candidate.id,
    (reason: string) =>
      officeEquipmentCandidatesApi.reject(candidate.id, {
        reason,
        expectedVersion: candidate.contentVersion,
      }),
    { success: 'Сообщение отклонено', onDone, blockers: rejectBlockers },
  );

  return (
    <Space size={8}>
      <Button onClick={() => setMergeOpen(true)}>Это уже заведённый аппарат</Button>
      <Button danger onClick={() => setRejectOpen(true)}>
        Отклонить
      </Button>

      <FormModal
        title="Аппарат уже есть в справочнике"
        open={mergeOpen}
        onCancel={() => setMergeOpen(false)}
        onSubmit={() => mergeForm.submit()}
        confirmLoading={merge.isPending}
        okText="Объединить"
      >
        <Form
          form={mergeForm}
          layout="vertical"
          onFinish={(v) => merge.mutate(v.officeEquipmentId)}
        >
          <Form.Item
            name="officeEquipmentId"
            label="Какая карточка"
            rules={[{ required: true, message: 'Выберите карточку' }]}
            extra={`Заявка получит эту единицу вместо сообщения «${subjectCheckTitle(candidate)}»`}
          >
            <AutoSelect
              showSearch
              /* Своего фильтра у поля нет вовсе: сервер ищет по номерам и месту, а клиентский
                 фильтр видит одну подпись — и молча резал бы найденное. */
              filterOption={false}
              options={options}
              loading={loading}
              onSearch={setSearch}
              placeholder="Модель, инвентарный или серийный номер"
            />
          </Form.Item>
        </Form>
      </FormModal>

      <FormModal
        title="Отклонить сообщение"
        open={rejectOpen}
        onCancel={() => setRejectOpen(false)}
        onSubmit={() => rejectForm.submit()}
        confirmLoading={reject.isPending}
        okText="Отклонить"
        okDanger
      >
        <Form
          form={rejectForm}
          layout="vertical"
          onFinish={(v) => reject.mutate(v.reason.trim())}
          {...rejectBlockers.formProps}
        >
          <Form.Item
            name="reason"
            label="Почему аппарат не заводим"
            rules={[{ required: true, message: 'Укажите причину отказа' }]}
            extra="Эту строку прочитает заявитель — она уйдёт в его заявку и в письмо дословно"
          >
            <Input.TextArea rows={3} maxLength={1000} />
          </Form.Item>
        </Form>
      </FormModal>
    </Space>
  );
}

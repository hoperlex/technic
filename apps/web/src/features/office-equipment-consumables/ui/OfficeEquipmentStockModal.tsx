import { useEffect, useRef, useState } from 'react';
import { Alert, App, Form, Input, InputNumber, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OfficeEquipmentConsumableDto } from '@technic/contracts';
import { isApiError } from '@shared/api';
import { FormModal, useFormBlockers } from '@shared/ui';
import { errorMessage } from '@shared/lib';
import {
  officeEquipmentConsumableKeys,
  officeEquipmentConsumablesApi,
  officeEquipmentKeys,
  officeEquipmentPurchaseKeys,
} from '@entities/office-equipment';

/**
 * Правка остатка расходника — своим окном (план `docs/office-equipment-consumables-plan.md`, Р7).
 *
 * Почему не поле карточки. Остаток — событие, а не свойство: у каждого изменения есть причина и
 * автор, и они ложатся в журнал. Контракт правки карточки количество не принимает вовсе
 * (`z.never()`), поэтому «поле рядом с наименованием» соврало бы человеку — он увидел бы
 * «сохранено» там, где остаток остался прежним.
 *
 * Почему окно показывает текущее число. Оно уходит на сервер как `expectedQuantity` — то
 * значение, которое человек видел, — и в этом весь смысл: два кладовщика, открывшие карточку с
 * числом 12, запишут «12 → 10» и «12 → 8», и при верном итоге журнал станет враньём. Расхождение
 * сервер отбивает 409.
 *
 * 409 здесь — не сбой, а нормальный исход одновременной работы двоих, и показан он поэтому
 * словами прямо в окне, а не общим тостом ошибки: окно остаётся открытым, карточка перечитывается,
 * и человек видит новое число рядом со своим — ему решать, повторять ли правку.
 */

interface Props {
  /** Расходник, которому правят остаток; `null` — окно закрыто. */
  consumable: OfficeEquipmentConsumableDto | null;
  onClose: () => void;
}

interface Values {
  quantity: number;
  reason: string;
}

export function OfficeEquipmentStockModal({ consumable, onClose }: Props) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const blockers = useFormBlockers(form);
  /** Текст отказа 409; `null` — расхождения не было. */
  const [conflict, setConflict] = useState<string | null>(null);

  /**
   * Карточка по идентификатору — тем же ключом, что читает и сама карточка расходника: запрос
   * один на обоих. Нужна она здесь ради 409: после отказа окно гасит корень, карточка
   * перечитывается, и «Сейчас на складе» становится тем числом, с которым уйдёт следующая
   * попытка. Строка списка на это не годится — её из выдачи мог унести отбор «нет в наличии».
   */
  const { data: detail } = useQuery({
    queryKey: officeEquipmentConsumableKeys.detail(consumable?.id ?? ''),
    queryFn: () => officeEquipmentConsumablesApi.get(consumable!.id),
    enabled: !!consumable,
  });
  const current = detail?.quantity ?? consumable?.quantity ?? 0;

  /**
   * Остаток в момент открытия. Через ref, а не прямой зависимостью эффекта: после 409 карточка
   * перечитывается, число меняется — и эффект, зависящий от него, затёр бы набранное человеком
   * новое значение ровно в ту секунду, когда его просят перепроверить.
   */
  const currentRef = useRef(current);
  currentRef.current = current;

  const openedId = consumable?.id;
  useEffect(() => {
    if (!openedId) return;
    // Окно открывают и на соседней строке: набранное в прошлый раз к ней отношения не имеет.
    form.resetFields();
    // Поле начинается с текущего числа: правка чаще всего мелкая («12 → 11»), и перенабирать
    // остаток целиком незачем.
    form.setFieldsValue({ quantity: currentRef.current, reason: '' });
    setConflict(null);
  }, [openedId, form]);

  const saveMut = useMutation({
    mutationFn: (values: Values) =>
      officeEquipmentConsumablesApi.setStock(consumable!.id, {
        quantity: values.quantity,
        // То самое число, которое человек видел на экране, — а не то, что лежит в базе сейчас.
        expectedQuantity: current,
        reason: values.reason.trim(),
      }),
    onSuccess: (result) => {
      // Событие могло и не записаться: новое значение совпало с текущим — повторное нажатие
      // кнопки журнал пухнуть не должно (Р7, шаг 3). Сказать об этом честно дешевле, чем
      // объявлять «изменено» там, где ничего не изменилось.
      message.success(result.entry ? 'Остаток изменён' : 'Остаток и был таким — событие не писали');
      void qc.invalidateQueries({ queryKey: officeEquipmentConsumableKeys.root });
      // Матрица Р14: остаток стоит в карточке единицы оргтехники — «чем заправлять и сколько
      // этого на складе» (Р15).
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      /*
       * И закупки: дефицит считается по остатку (Р15 плана расходников и закупки), а форма
       * закупки, собранная до этой правки, предложила бы количества по вчерашней полке — и её
       * снимок разошёлся бы с сервером при сохранении (Р17).
       */
      void qc.invalidateQueries({ queryKey: officeEquipmentPurchaseKeys.root });
      onClose();
    },
    onError: (e) => {
      if (isApiError(e) && e.status === 409) {
        // Сообщение сервера называет новое число («сейчас 8») — оно и есть половина ответа.
        setConflict(errorMessage(e));
        // Вторая половина: карточка перечитывается, и «Сейчас на складе» в этом же окне
        // становится тем числом, с которым уйдёт следующая попытка.
        void qc.invalidateQueries({ queryKey: officeEquipmentConsumableKeys.root });
        return;
      }
      if (!blockers.fromApi(e)) message.error(errorMessage(e));
    },
  });

  return (
    <FormModal
      title={`Остаток: ${consumable?.name ?? ''}`}
      open={!!consumable}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={saveMut.isPending}
      width={460}
    >
      <Typography.Paragraph>
        Сейчас на складе: <Typography.Text strong>{current}</Typography.Text>
      </Typography.Paragraph>
      {conflict && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title="Пока окно было открыто, остаток изменил другой человек"
          /*
           * Две строки, а не одна склейка: первая — слова сервера, называющие новое число, вторая
           * — что с этим делать. Склеенные точкой, они разошлись бы с любым переписыванием текста
           * маршрута — от лишней точки в конце до отсутствия её вовсе.
           */
          description={
            <>
              <div>{conflict}</div>
              <div>
                Портал перечитал карточку: сверьтесь с новым числом и сохраните ещё раз — иначе ваша
                правка затёрла бы чужую.
              </div>
            </>
          }
        />
      )}
      <Form
        form={form}
        layout="vertical"
        onFinish={(v) => saveMut.mutate(v)}
        {...blockers.formProps}
      >
        <Form.Item
          name="quantity"
          label="Стало"
          rules={[{ required: true, message: 'Укажите новый остаток' }]}
        >
          <InputNumber min={0} max={1_000_000} precision={0} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          name="reason"
          label="Причина"
          /*
           * Минимум — из контракта: «-» вместо причины схема не примет, и узнать об этом человек
           * должен до отправки, а не по ответу 400. Края обрезаются так же, как в схеме.
           */
          rules={[
            { required: true, whitespace: true, message: 'Укажите причину изменения остатка' },
            {
              min: 3,
              transform: (v: string | undefined) => (v ?? '').trim(),
              message: 'Причина — не короче трёх символов',
            },
          ]}
          // Причину держит и CHECK базы: «12 → 4» без объяснения читать через месяц нечем (Р7).
          extra="Куда ушло или откуда пришло: «выдано на АЛ13», «поступление по счёту 1245»"
        >
          <Input.TextArea rows={2} maxLength={1000} />
        </Form.Item>
      </Form>
    </FormModal>
  );
}

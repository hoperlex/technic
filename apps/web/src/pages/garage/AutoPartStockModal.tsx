import { useEffect, useRef, useState } from 'react';
import { Alert, App, Form, Input, InputNumber, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AUTO_PART_MAX_QUANTITY, type AutoPartDto } from '@technic/contracts';
import { isApiError } from '@shared/api';
import { FormModal, useFormBlockers } from '@shared/ui';
import { errorMessage } from '@shared/lib';
import { autoPartApi, autoPartKeys } from '@entities/auto-part';

/**
 * Правка остатка автозапчасти — своим окном (план `docs/auto-parts-plan.md`, Р3; концепт с. 4).
 *
 * Почему не поле карточки. Остаток — событие, а не свойство: у каждого изменения есть причина и
 * автор, и они ложатся в неизменяемый журнал. Контракт правки позиции количество не принимает
 * вовсе (`quantity: z.never()`), поэтому «поле рядом с наименованием» соврало бы человеку — он
 * увидел бы «сохранено» там, где остаток остался прежним.
 *
 * Почему окно показывает текущее число. Оно уходит на сервер как `expectedQuantity` — то
 * значение, которое человек видел, — и в этом весь смысл: два механика, открывшие карточку с
 * числом 12, запишут «12 → 10» и «12 → 8», и при верном итоге журнал станет враньём. Расхождение
 * сервер отбивает 409.
 *
 * 409 здесь — не сбой, а нормальный исход одновременной работы двоих, и показан он поэтому
 * словами прямо в окне, а не общим тостом ошибки: окно остаётся открытым, карточка
 * перечитывается, и человек видит новое число рядом со своим — ему решать, повторять ли правку.
 *
 * Этой же ручкой покрывается всё, что не является обслуживанием (Р4): приход, пересчёт, брак,
 * продажа. Расход на машину сюда не ходит — он идёт строкой акта обслуживания, и остаток меняет
 * сохранение всего акта.
 */

interface Props {
  /** Позиция, которой правят остаток; `null` — окно закрыто. */
  part: AutoPartDto | null;
  onClose: () => void;
}

interface Values {
  quantity: number;
  reason: string;
}

/**
 * Что именно ляжет в журнал — словами и до нажатия (концепт с. 4, шаг 1). Человек вводит итог
 * («стало 20»), а думает разницей («пришло восемь»), и портал обязан сойтись с ним посередине:
 * складское движение необратимо — журнал неизменяем, — и увидеть его нужно ДО кнопки, а не в
 * ленте после.
 */
function deltaHint(next: number | null | undefined, current: number, unit: string): string {
  if (next == null || Number.isNaN(next)) return 'Укажите новый остаток';
  const delta = next - current;
  if (delta === 0) {
    // Повторное нажатие тем же числом сервер пропускает без записи (Р3): журнал не должен пухнуть
    // от событий «12 → 12», и обещать человеку запись здесь нечестно.
    return 'Число то же — события в журнале не будет';
  }
  return delta > 0
    ? `+${delta} ${unit} будет добавлено в журнал`
    : `−${-delta} ${unit} будет списано — запись ляжет в журнал`;
}

export function AutoPartStockModal({ part, onClose }: Props) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const blockers = useFormBlockers(form);
  /** Текст отказа 409; `null` — расхождения не было. */
  const [conflict, setConflict] = useState<string | null>(null);

  /**
   * Карточка по идентификатору — тем же ключом, что читает и сама карточка позиции: запрос один на
   * обоих. Нужна она здесь ради 409: после отказа окно гасит корень, карточка перечитывается, и
   * «Сейчас на складе» становится тем числом, с которым уйдёт следующая попытка. Строка списка на
   * это не годится — её из выдачи мог унести отбор «нет в наличии».
   */
  const { data: detail } = useQuery({
    queryKey: autoPartKeys.detail(part?.id ?? ''),
    queryFn: () => autoPartApi.get(part!.id),
    enabled: !!part,
  });
  const current = detail?.quantity ?? part?.quantity ?? 0;
  const unit = detail?.unit ?? part?.unit ?? 'шт';

  /**
   * Остаток в момент открытия. Через ref, а не прямой зависимостью эффекта: после 409 карточка
   * перечитывается, число меняется — и эффект, зависящий от него, затёр бы набранное человеком
   * новое значение ровно в ту секунду, когда его просят перепроверить.
   */
  const currentRef = useRef(current);
  currentRef.current = current;

  const openedId = part?.id;
  useEffect(() => {
    if (!openedId) return;
    // Окно открывают и на соседней строке: набранное в прошлый раз к ней отношения не имеет.
    form.resetFields();
    // Поле начинается с текущего числа: правка чаще всего мелкая («12 → 11»), и перенабирать
    // остаток целиком незачем.
    form.setFieldsValue({ quantity: currentRef.current, reason: '' });
    setConflict(null);
  }, [openedId, form]);

  const next = Form.useWatch('quantity', form);

  const saveMut = useMutation({
    mutationFn: (values: Values) =>
      autoPartApi.setStock(part!.id, {
        quantity: values.quantity,
        // То самое число, которое человек видел на экране, — а не то, что лежит в базе сейчас.
        expectedQuantity: current,
        reason: values.reason.trim(),
      }),
    onSuccess: (result) => {
      // Событие могло и не записаться: новое значение совпало с текущим (Р3, шаг 3). Сказать об
      // этом честно дешевле, чем объявлять «изменено» там, где ничего не изменилось.
      message.success(result.entry ? 'Остаток изменён' : 'Остаток и был таким — событие не писали');
      // Матрица Р16, вторая строка: ручная правка меняет и список, и карточку, и ленту журнала —
      // все трое живут под корнем склада, и гасятся одним ключом.
      void qc.invalidateQueries({ queryKey: autoPartKeys.root });
      onClose();
    },
    onError: (e) => {
      if (isApiError(e) && e.status === 409) {
        // Сообщение сервера называет новое число («сейчас 8») — оно и есть половина ответа.
        setConflict(errorMessage(e));
        // Вторая половина: карточка перечитывается, и «Сейчас на складе» в этом же окне
        // становится тем числом, с которым уйдёт следующая попытка.
        void qc.invalidateQueries({ queryKey: autoPartKeys.root });
        return;
      }
      if (!blockers.fromApi(e)) message.error(errorMessage(e));
    },
  });

  return (
    <FormModal
      title="Изменить остаток"
      open={!!part}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={saveMut.isPending}
      width={460}
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 4 }}>
        {part?.name}
        {part?.code ? ` · ${part.code}` : ''}
      </Typography.Paragraph>
      <Typography.Paragraph>
        Сейчас на складе:{' '}
        <Typography.Text strong>
          {current} {unit}
        </Typography.Text>
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
          label="Новый остаток"
          rules={[{ required: true, message: 'Укажите новый остаток' }]}
          // Разница словами — прямо под полем: вводят итог, а думают приходом, и портал обязан
          // сойтись с человеком посередине (концепт с. 4).
          extra={deltaHint(next, current, unit)}
        >
          <InputNumber
            min={0}
            max={AUTO_PART_MAX_QUANTITY}
            precision={0}
            addonAfter={unit}
            style={{ width: '100%' }}
          />
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
          // Причину держит и CHECK базы: «12 → 4» без объяснения через месяц читать нечем (Р3).
          extra="Коротко и проверяемо: «приход по накладной 406», «пересчёт: повреждены 2 шт»"
        >
          <Input.TextArea rows={2} maxLength={1000} />
        </Form.Item>
      </Form>
    </FormModal>
  );
}

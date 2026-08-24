import { useEffect } from 'react';
import { App, Form, Input, InputNumber, Switch, Typography } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AUTO_PART_MAX_QUANTITY, type AutoPartDto } from '@technic/contracts';
import { AutoSelect, FormModal, useFormBlockers } from '@shared/ui';
import { errorMessage, withSavedOption } from '@shared/lib';
import { autoPartApi, autoPartKeys } from '@entities/auto-part';
import {
  applicabilityBody,
  applicabilityValue,
  type ApplicabilityOption,
} from './autoPartApplicability';
import { applicabilityLabel } from './autoPartColumns';

/**
 * Карточка автозапчасти на правку: наименование, код, единица, применимость, комментарий и
 * активность (план `docs/auto-parts-plan.md`, Р8, Р9, Р11, Р12, §6).
 *
 * **Остатка среди полей правки нет намеренно** (Р3): он меняется своим окном, событием с причиной
 * и автором. Контракт правки количество не принимает вовсе (`quantity: z.never()`), и поле на
 * форме обещало бы человеку сохранение, которого не будет.
 *
 * **Заведение — единственное исключение, и оно из плана, а не из удобства** (Р17): справочник
 * наполняют руками, сперва тем, что уже лежит на складе, поэтому начальный остаток вводится тут
 * же, а первое событие журнала («0 → N») пишет маршрут сам, своей постоянной причиной. Поле
 * показывается только держателю `autoParts.stock`: ненулевое значение здесь — движение склада, и
 * второе право спрашивает именно за него (Р19).
 *
 * Окно открывается только с правом ведения (`autoParts.manage`): читателю карточку показывает
 * `AutoPartCardModal` — с реквизитами, остатком и журналом, но без формы.
 */

interface Props {
  open: boolean;
  onCancel: () => void;
  /** Правка заведённой позиции; `null` — заведение новой. */
  record?: AutoPartDto | null;
  /** Право двигать склад: от него зависит только начальный остаток при заведении (Р17, Р19). */
  canStock: boolean;
  /** Перечень применимости — общий с отбором вкладки: он один и собирается одним модулем (Р8). */
  options: ApplicabilityOption[];
  optionsLoading?: boolean;
}

interface Values {
  code: string;
  name: string;
  unit: string;
  comment: string;
  isActive: boolean;
  /** Полный набор разметки, а не пара «привязать/отвязать»: применимость правится целиком (Р8). */
  applicability: string[];
  /** Только при заведении: начальный остаток (Р17). У правки этого поля нет вовсе. */
  quantity?: number;
}

export function AutoPartFormModal({
  open,
  onCancel,
  record,
  canStock,
  options,
  optionsLoading,
}: Props) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const blockers = useFormBlockers(form);

  /**
   * Уже размеченные модели и типы остаются в списке, даже если из действующего справочника выпали:
   * погашенная модель — «новых машин такого рода не заводим», а не «деталь ей больше не подходит».
   * Без этой добавки правка комментария снимала бы разметку молча.
   */
  const withSaved = (record?.applicability ?? []).reduce<ApplicabilityOption[]>(
    (acc, row) => withSavedOption(acc, { id: applicabilityValue(row), name: applicabilityLabel(row) }),
    options,
  );

  useEffect(() => {
    if (!open) return;
    // Окно открывают и повторно — на соседней строке: набранное в прошлый раз к ней отношения не
    // имеет. «Активна» стоит сразу: заводят то, что покупают.
    form.resetFields();
    form.setFieldsValue({
      code: record?.code ?? '',
      name: record?.name ?? '',
      // Умолчание единицы стоит заполненным, а не подсказкой: пустой единицы не бывает (CHECK
      // базы), а «шт» покрывает большинство позиций склада (Р9).
      unit: record?.unit ?? 'шт',
      comment: record?.comment ?? '',
      isActive: record?.isActive ?? true,
      applicability: (record?.applicability ?? []).map(applicabilityValue),
      quantity: 0,
    });
  }, [open, record, form]);

  const saveMut = useMutation({
    mutationFn: (values: Values) => {
      const body = {
        // Пустая строка означает «кода нет» и уходит на сервер как `null` (Р12): схема приводит
        // её к тому же, но отправлять «кода нет» двумя способами незачем.
        code: values.code?.trim() ? values.code.trim() : null,
        name: values.name,
        unit: values.unit,
        isActive: values.isActive,
        comment: values.comment ?? '',
        applicability: applicabilityBody(values.applicability),
      };
      return record
        ? // Количества в теле правки нет и быть не может: контракт его не принимает (Р3).
          autoPartApi.update(record.id, body)
        : autoPartApi.create({ ...body, quantity: canStock ? (values.quantity ?? 0) : 0 });
    },
    onSuccess: () => {
      message.success('Сохранено');
      // Матрица Р16, первая строка: заведение, правка и гашение меняют и список, и карточку —
      // оба живут под корнем склада.
      void qc.invalidateQueries({ queryKey: autoPartKeys.root });
      onCancel();
    },
    /*
     * Отказы, названные полем, ложатся на поле (ADR 0094): занятый код маршрут шлёт как
     * `{ code: … }`, повтор пары «наименование + код» — как `{ name: … }`, и обе двери отказа
     * (проверка до вставки и разбор `23505` из гонки) отвечают одинаково. Тост остаётся тому, у
     * чего поля нет.
     */
    onError: (e) => {
      if (!blockers.fromApi(e)) message.error(errorMessage(e));
    },
  });

  return (
    <FormModal
      title={record ? 'Правка автозапчасти' : 'Новая автозапчасть'}
      open={open}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
      confirmLoading={saveMut.isPending}
      width={520}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={(v) => saveMut.mutate(v)}
        {...blockers.formProps}
      >
        <Form.Item
          name="name"
          label="Наименование"
          /*
           * Минимум повторён с контракта, а не оставлен серверу: правило, о котором узнают после
           * нажатия «Сохранить», человек узнаёт на ход позже, чем мог бы. `transform` обрезает
           * края ровно так же, как это делает схема, — иначе пробел с буквой прошли бы проверку
           * формы и упёрлись в 400.
           */
          rules={[
            { required: true, whitespace: true, message: 'Укажите наименование' },
            {
              min: 2,
              transform: (v: string | undefined) => (v ?? '').trim(),
              message: 'Наименование — не короче двух символов',
            },
          ]}
          extra="Как его спрашивают на складе: «Фильтр масляный», «Ремень генератора»"
        >
          <Input maxLength={255} />
        </Form.Item>
        <Form.Item
          name="code"
          label="Код (артикул)"
          /*
           * Необязателен (Р12): требовать код значило бы запретить механику завести «Ремень
           * генератора» до того, как бухгалтерия пришлёт номенклатуру. Идентичность держит пара
           * «наименование + код»: два одинаковых по названию ремня — законные разные позиции,
           * если у них разные артикулы.
           *
           * Написание правит база (`auto_part_code_key`: пробелы, включая неразрывный из Word,
           * убираются, регистр поднимается) — своей нормализации на портале нет намеренно, иначе
           * в справочнике завёлся бы второй «тот же» код.
           */
          extra="Необязателен. Два одинаковых наименования различает именно он"
        >
          <Input maxLength={50} placeholder="Например: LF3349" />
        </Form.Item>
        <Form.Item
          name="unit"
          label="Единица измерения"
          rules={[{ required: true, whitespace: true, message: 'Укажите единицу измерения' }]}
          // Свободная строка, а не перечень: на складе гаража лежат штуки, литры, комплекты и
          // метры, и перечень пришлось бы править выпуском ради каждой новой единицы (Р9).
          extra="шт, л, компл, м — как считают на складе"
        >
          <Input maxLength={20} />
        </Form.Item>
        <Form.Item
          name="applicability"
          label="Применимость"
          // Пустой набор законен (Р8): деталь завели, а к чему она подходит — вопрос к механику, и
          // ждать ответа, не заводя позицию, значит потерять её совсем.
          extra="К каким моделям и типам техники подходит; можно оставить пустой и уточнить потом"
        >
          <AutoSelect
            mode="multiple"
            options={withSaved}
            loading={optionsLoading}
            showSearch
            optionFilterProp="label"
            placeholder="Модель или тип техники"
            // Единственный тип справочника поле не подставляет: пустая разметка здесь — законный
            // ответ, а не незаполненное поле.
            autoSelectSole={false}
          />
        </Form.Item>
        <Form.Item name="comment" label="Комментарий">
          <Input.TextArea rows={2} maxLength={2000} />
        </Form.Item>
        <Form.Item
          name="isActive"
          label="Активна"
          valuePropName="checked"
          // Гашение вместо удаления (Р11): погашенную позицию не предлагают в акте, но остаток и
          // журнал у неё остаются, и уменьшить её в старом акте по-прежнему можно (Р24).
          extra="Погашенную позицию не предлагают в акте обслуживания; остаток и журнал у неё остаются"
        >
          <Switch />
        </Form.Item>
        {!record && canStock && (
          <Form.Item
            name="quantity"
            label="Начальный остаток"
            /*
             * Инвентаризация и есть заведение (Р17): справочник наполняют по ходу работы, сперва
             * тем, что лежит на складе. Причину первого события составляет маршрут — спрашивать
             * «почему у вас на складе 12 штук» не за что: это не движение, а перенос уже
             * известного остатка в портал.
             */
            extra="Сколько лежит на складе сейчас. Портал запишет это первым событием журнала — «0 → N»; дальше остаток правится своей кнопкой"
          >
            <InputNumber min={0} max={AUTO_PART_MAX_QUANTITY} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        )}
      </Form>
      {!record && !canStock && (
        // Без права на склад начальный остаток ввести нечем — и сказать об этом надо до
        // сохранения, а не оставлять человека гадать, почему у заведённой позиции ноль (Р19).
        <Typography.Text type="secondary">
          Остаток заводит тот, у кого есть право двигать склад: позиция сохранится с нулём, а число
          проставит механик кнопкой «Изменить остаток».
        </Typography.Text>
      )}
    </FormModal>
  );
}

import { useState } from 'react';
import { Button, Checkbox, Col, Form, InputNumber, Row, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { queryOptions, useQuery } from '@tanstack/react-query';
import type { ServiceRequestConsumableDto } from '@technic/contracts';
import {
  officeEquipmentConsumableKeys,
  officeEquipmentConsumablesApi,
} from '@entities/office-equipment';
import { consumableLabel } from '@entities/service-request';
import { AutoSelect } from '@shared/ui';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';

/** Строка формы: позиция справочника и сколько её просят. Пустая строка — только что добавленная. */
export interface ConsumableLineValue {
  consumableId?: string;
  requestedQuantity?: number;
}

/**
 * Позиции, подходящие аппарату. Отбор по **модели**, а не по карточке единицы: картридж подходит
 * модели целиком — «Тонер Ricoh 201» годится и 68 нынешним Ricoh Aficio MP 201SPF, и 69-му,
 * который приедет завтра (Р1 плана расходников). Ради этого справочник моделей и заводился.
 *
 * Погашенные позиции не предлагаются: гашение означает «больше не выдаём» (Р11 плана расходников).
 * Перечень небольшой и приходит целиком — поиск идёт на клиенте, как у прочих справочных полей.
 */
const consumableOptionsQuery = (modelId: string | undefined) => {
  const params = {
    page: 1,
    pageSize: DICTIONARY_PAGE_SIZE,
    modelId,
    isActive: 'true',
    // Алфавит явно: умолчание списочной схемы — «последняя заведённая сверху», то есть случайный
    // порядок в выпадающем списке.
    sortBy: 'name',
    sortOrder: 'asc',
  } as const;
  return queryOptions({
    queryKey: officeEquipmentConsumableKeys.list(params),
    queryFn: () => officeEquipmentConsumablesApi.list(params),
    select: (r) =>
      r.items.map((item) => ({
        value: item.id,
        // Цвет — свойство позиции (Р9), а не поле формы: у цветной серии по позиции на цвет, со
        // своим кодом и своим остатком, и в списке выбора они так и выглядят. Остаток стоит
        // рядом — заказывая четыре тонера, человек должен видеть, что на складе их два.
        label: `${consumableLabel(item)} · на складе ${item.quantity}`,
      })),
  });
};

/**
 * Строки номенклатуры в форме заявки на расходники (Н9, Н10).
 *
 * Аппарат выбирается первым, и по его модели портал предлагает подходящие позиции — та самая
 * подстановка, ради которой заводился справочник моделей: сотрудник выбирает МФУ, а картридж
 * подставляется сам, если он у модели один (`AutoSelect`).
 *
 * Строк несколько (В11): четыре тонера цветного аппарата — одна заявка, один выезд, одно
 * списание. Отдельного поля «цвет» в форме нет вовсе (Р9): цвета — это разные позиции справочника
 * с разными кодами и остатками, и «отметьте цвета» при одной позиции «на комплект» сделало бы
 * остаток неправильным в тот же день.
 *
 * Уже выбранные позиции из соседних строк убираются: две строки одной позиции — это не два
 * расходника, а ошибка ввода, и сервер отвечает на неё словами. Дешевле не дать её сделать.
 */
export function ServiceRequestConsumablesField({
  modelId,
  disabled,
  disabledReason,
  enabled,
}: {
  /** Модель выбранного аппарата; `undefined` — модели у карточки нет (наследие выпуска A). */
  modelId: string | undefined;
  /** Состав правке не подлежит: по заявке уже отмечена выдача, и она — основание записи склада. */
  disabled?: boolean;
  disabledReason?: string;
  /** Блок показан: заявка на расходники и окно открыто. */
  enabled: boolean;
}) {
  const form = Form.useFormInstance();
  const lines: ConsumableLineValue[] = Form.useWatch('consumables', form) ?? [];
  // Признак «показать всё» — состояние поля, а не значение формы: он про то, из чего выбирают, а
  // не про то, что просят, и в теле запроса ему делать нечего.
  const [showAll, setShowAll] = useState(false);

  const { data: options = [], isFetching } = useQuery({
    ...consumableOptionsQuery(showAll ? undefined : modelId),
    enabled,
  });

  const chosen = lines.map((line) => line?.consumableId).filter(Boolean);
  const optionsFor = (index: number) =>
    options.filter(
      (option) =>
        option.value === lines[index]?.consumableId || !chosen.includes(option.value),
    );

  const hint = !modelId
    ? 'У аппарата не указана модель — показан весь перечень расходников.'
    : options.length === 0 && !isFetching && !showAll
      ? 'К этой модели расходники не привязаны — включите весь перечень или скажите ИТ-службе, чего не хватает.'
      : null;

  return (
    <Form.Item
      label="Что нужно"
      required
      // Отказ сервера по строкам («Добавьте хотя бы одну позицию») ложится сюда же: путь ошибки у
      // схемы заведения — `consumables`, и форма ищет поле по верхнему сегменту.
      tooltip="Позиции подобраны по модели аппарата"
      style={{ marginBottom: 8 }}
    >
      <Form.List name="consumables">
        {(fields, { add, remove }) => (
          <>
            {fields.length === 0 && (
              <Typography.Text type="secondary">
                Добавьте хотя бы одну позицию: заявка на расходники без них не заводится.
              </Typography.Text>
            )}
            {fields.map((field, index) => (
              <Row key={field.key} gutter={8} align="top" style={{ marginTop: 4 }}>
                <Col xs={24} sm={16}>
                  <Form.Item
                    name={[field.name, 'consumableId']}
                    rules={[{ required: true, message: 'Выберите позицию' }]}
                    style={{ marginBottom: 8 }}
                  >
                    <AutoSelect
                      showSearch
                      optionFilterProp="label"
                      loading={isFetching}
                      options={optionsFor(index)}
                      disabled={disabled}
                      placeholder="Наименование или код номенклатуры"
                      aria-label="Позиция номенклатуры"
                    />
                  </Form.Item>
                </Col>
                <Col xs={16} sm={6}>
                  <Form.Item
                    name={[field.name, 'requestedQuantity']}
                    rules={[{ required: true, message: 'Сколько нужно' }]}
                    style={{ marginBottom: 8 }}
                  >
                    <InputNumber
                      style={{ width: '100%' }}
                      min={1}
                      max={1000}
                      precision={0}
                      addonBefore="шт"
                      disabled={disabled}
                      aria-label="Сколько нужно"
                    />
                  </Form.Item>
                </Col>
                <Col xs={8} sm={2} style={{ textAlign: 'right' }}>
                  <Button
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    disabled={disabled}
                    aria-label="Убрать позицию"
                    onClick={() => remove(field.name)}
                  />
                </Col>
              </Row>
            ))}
            <Button
              type="link"
              size="small"
              icon={<PlusOutlined />}
              style={{ paddingInlineStart: 0 }}
              disabled={disabled}
              onClick={() => add({})}
            >
              Добавить позицию
            </Button>
          </>
        )}
      </Form.List>

      {hint && (
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {hint}
          </Typography.Text>
        </div>
      )}
      {disabledReason && (
        <div>
          <Typography.Text type="warning" style={{ fontSize: 12 }}>
            {disabledReason}
          </Typography.Text>
        </div>
      )}
      {/* Полный перечень — на случай, когда совместимость ещё не размечена: заявку заводят
          сегодня, а разметку ИТ-служба довозит потом (Р6 плана расходников). */}
      {!!modelId && !disabled && (
        <Checkbox checked={showAll} onChange={(e) => setShowAll(e.target.checked)}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Показать все позиции, не только подходящие модели
          </Typography.Text>
        </Checkbox>
      )}
    </Form.Item>
  );
}

/** Строки заявки в том виде, в каком их принимает и заведение, и `PUT /:id/consumables`. */
export function consumableLinesPayload(
  lines: readonly ConsumableLineValue[] | undefined,
): { consumableId: string; requestedQuantity: number }[] {
  return (lines ?? [])
    .filter((line) => !!line?.consumableId && !!line.requestedQuantity)
    .map((line) => ({
      consumableId: line.consumableId!,
      requestedQuantity: line.requestedQuantity!,
    }));
}

/** Строки заявки как значения формы: правка открывается тем, что уже просили. */
export function consumableLinesFrom(
  lines: readonly ServiceRequestConsumableDto[],
): ConsumableLineValue[] {
  return lines.map((line) => ({
    consumableId: line.consumableId,
    requestedQuantity: line.requestedQuantity,
  }));
}

/** Состав тронули: `PUT` уходит только тогда, иначе правка телефона поднимала бы версию дважды. */
export function consumableLinesChanged(
  next: readonly ConsumableLineValue[] | undefined,
  saved: readonly ServiceRequestConsumableDto[],
): boolean {
  const a = consumableLinesPayload(next);
  if (a.length !== saved.length) return true;
  return a.some((line, index) => {
    const was = saved[index]!;
    return (
      line.consumableId !== was.consumableId || line.requestedQuantity !== was.requestedQuantity
    );
  });
}

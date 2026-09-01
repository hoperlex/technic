import { useEffect, useState } from 'react';
import { App, Button, Checkbox, Col, Form, InputNumber, Row, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ServiceRequestConsumableDto, ServiceRequestDto } from '@technic/contracts';
import {
  officeEquipmentConsumableKeys,
  officeEquipmentConsumablesApi,
  officeEquipmentKeys,
  officeEquipmentOptionsQuery,
} from '@entities/office-equipment';
import { consumableLabel, serviceRequestKeys, serviceRequestsApi } from '@entities/service-request';
import { AutoSelect, FormModal } from '@shared/ui';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';

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
 * Строки номенклатуры заявки на расходники (Н9, Н10) — **окна исполнителя**, а не формы заведения.
 *
 * Из формы заведения блок ушёл целиком (Р15): заявитель номенклатуры не знает, и его дело —
 * сказать словами, чего не хватает. Состав заполняет тот, кто повезёт: он же и отвечает на вопрос
 * «что по заявке пойдёт», ровно как исполнитель ремонта отвечает на него объёмом работ.
 *
 * Позиции подбираются по модели аппарата — та самая подстановка, ради которой заводился справочник
 * моделей: у модели один картридж — он и подставится (`AutoSelect`).
 *
 * Строк несколько (В11): четыре тонера цветного аппарата — одна заявка, один выезд, одно
 * списание. Отдельного поля «цвет» здесь нет вовсе (Р9): цвета — это разные позиции справочника
 * с разными кодами и остатками, и «отметьте цвета» при одной позиции «на комплект» сделало бы
 * остаток неправильным в тот же день.
 *
 * Уже выбранные позиции из соседних строк убираются: две строки одной позиции — это не два
 * расходника, а ошибка ввода, и сервер отвечает на неё словами. Дешевле не дать её сделать.
 */
export function ServiceRequestConsumablesField({
  modelId,
  enabled,
}: {
  /** Модель аппарата заявки; `undefined` — модели у карточки нет (наследие выпуска A). */
  modelId: string | undefined;
  /** Блок показан: окно открыто. */
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
      (option) => option.value === lines[index]?.consumableId || !chosen.includes(option.value),
    );

  /*
   * Подсказка отвечает на «почему в списке это»: у аппарата нет модели либо к модели ничего не
   * привязано. Общее «ничего не нашлось» не отвечает ни на одно из двух — человек ищет ошибку у
   * себя, а её нет.
   */
  const hint = !modelId
    ? 'У аппарата не указана модель — показан весь перечень расходников.'
    : options.length === 0 && !isFetching && !showAll
      ? 'К этой модели расходники не привязаны — включите весь перечень или скажите ИТ-службе, чего не хватает.'
      : null;

  return (
    <Form.Item
      label="Что пойдёт по заявке"
      tooltip="Позиции подобраны по модели аппарата"
      style={{ marginBottom: 8 }}
    >
      {/*
        «Хотя бы одна позиция» — правило РЕДАКТОРА, и оно то же, что на сервере
        (`putServiceConsumablesSchema` держит `.min(1)`). Делится оно с заведением по границе Р15:
        при заведении позиций может не быть вовсе — их заполняет исполнитель, и форма заведения
        этого блока больше не показывает; в редакторе пустой список запрещён — сохранённый, он
        оставил бы заявку на расходники без предмета, а портал, разрешивший его, разошёлся бы с
        сервером ровно там, где модуль от расхождений и защищается.
      */}
      <Form.List
        name="consumables"
        rules={[
          {
            validator: (_rule, lines: ConsumableLineValue[] | undefined) =>
              lines && lines.length > 0
                ? Promise.resolve()
                : Promise.reject(new Error('Добавьте хотя бы одну позицию')),
          },
        ]}
      >
        {(fields, { add, remove }, { errors }) => (
          <>
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
                      aria-label="Сколько нужно"
                    />
                  </Form.Item>
                </Col>
                <Col xs={8} sm={2} style={{ textAlign: 'right' }}>
                  <Button
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
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
              onClick={() => add({})}
            >
              Добавить позицию
            </Button>
            {/* Отказ по списку целиком стоит у самого списка: помечать нечего — поля, которое не
                заполнили, ещё не существует. */}
            <Form.ErrorList errors={errors} />
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
      {/* Полный перечень — на случай, когда совместимость ещё не размечена: заявку заводят
          сегодня, а разметку ИТ-служба довозит потом (Р6 плана расходников). */}
      {!!modelId && (
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

/**
 * Окно состава номенклатуры (Р15) — то же по устройству, каким у ремонта правят объём работ:
 * кнопка на вкладке предмета заявки и окно, в котором собирают строки.
 *
 * Симметрия здесь не украшение. У обоих видов заявки исполнитель отвечает на один вопрос — «что по
 * ней пойдёт», — и два разных окна для одного вопроса разошлись бы на первой же правке: у ремонта
 * подпись стала бы одной, у расходников другой, а человек, ведущий и то и другое, каждый раз
 * вспоминал бы, где он сейчас.
 *
 * Кто вправе, окно не решает: оно открывается готовым пунктом действий (`serviceRequestActions`),
 * а тот спрашивает сторону исполнителя и отсутствие отметки о выдаче — ровно теми же условиями, что
 * и сервер. Спроси окно само, и это была бы вторая карта прав.
 */
export function ServiceRequestConsumablesModal({
  request,
  onClose,
}: {
  /** `null` — окно закрыто. */
  request: ServiceRequestDto | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [form] = Form.useForm<{ consumables: ConsumableLineValue[] }>();

  /**
   * Модель аппарата заявки — по ней подбираются позиции (Н10). Тем же запросом и тем же ключом, что
   * и список техники в форме: второй проекцией уже загруженного ответа, а не вторым обращением к
   * серверу. Справочник открыт не всякому — сервисной компании он закрыт целиком (Р7), — и тогда
   * модель просто неизвестна, а поле показывает весь перечень расходников.
   */
  const { data: modelOf } = useQuery({
    ...officeEquipmentOptionsQuery(),
    enabled: !!request && can('officeEquipment.read'),
    select: (r) => new Map(r.items.map((item) => [item.id, item.model?.id])),
  });

  useEffect(() => {
    // Правка открывается тем, что уже записано: состав правят, а не набирают заново.
    if (request) form.setFieldsValue({ consumables: consumableLinesFrom(request.consumables) });
  }, [request, form]);

  const mutation = useMutation({
    mutationFn: (values: { consumables: ConsumableLineValue[] }) =>
      serviceRequestsApi.putConsumables(request!.id, {
        items: consumableLinesPayload(values.consumables),
        version: request!.version,
      }),
    onSuccess: () => {
      message.success('Состав номенклатуры сохранён');
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      onClose();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  return (
    <FormModal
      title={request ? `Номенклатура заявки ${request.displayNumber}` : 'Номенклатура'}
      open={!!request}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={mutation.isPending}
      width={620}
    >
      <Form form={form} layout="vertical" onFinish={(v) => mutation.mutate(v)}>
        <ServiceRequestConsumablesField
          // Без аппарата нет и модели — как и там, где справочник закрыт: поле показывает весь
          // перечень расходников, а не пустой (Р8). Заявка «на склад» тем и живёт, что аппарат ей
          // не нужен.
          modelId={request?.equipment ? modelOf?.get(request.equipment.id) : undefined}
          enabled={!!request}
        />
        {/* Заказчик состав ВИДИТ и не правит (Р15) — это ответ на его «что мне привезут». Строка
            стоит здесь, у того, кто состав пишет: он должен знать, что список читают. */}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Состав виден заказчику: по нему он и поймёт, что ему привезут.
        </Typography.Text>
      </Form>
    </FormModal>
  );
}

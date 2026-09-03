import { Form, Input, Select, Switch } from 'antd';
import type { FormInstance } from 'antd';
import {
  COUNTERPARTY_TYPES,
  type CounterpartyType,
  type CreateCounterpartyInput,
  type UpdateCounterpartyInput,
  counterpartyTypeLabels,
  EMAIL_FORMAT_MESSAGE,
  INN_CHECKSUM_MESSAGE,
  INN_MESSAGE,
  isValidInn,
  normalizeEmail,
  optionalEmailSchema,
} from '@technic/contracts';
import { AutoSelect } from '@shared/ui';

/**
 * Поля карточки контрагента — отдельным файлом от вкладки справочника.
 *
 * Разделение не косметическое: вкладка отвечает за список (отборы, колонки, действия, архив), а это
 * — одна форма, и растут они по разным поводам. Форма выехала сюда, когда вкладка перевалила бюджет
 * качества (`quality.mjs`, 524 строки) на поле «Email для заявок» (ADR 0153): бюджет ловит именно
 * такой рост — по строчке за правку, пока файл не станет нечитаемым.
 */
export interface CounterpartyFormValues {
  type: CounterpartyType;
  name: string;
  inn: string;
  synonyms?: string[];
  /** Обслуживаемые объекты — только у типа «Оператор» (ADR 0010). */
  objectIds?: string[];
  /** Общий ящик организации: по нему портал пишет сервисной компании (ADR 0153). */
  email?: string;
  comment?: string;
  isActive: boolean;
}

/** Типы контрагента списком — один на форму и на отбор вкладки: два списка разошлись бы. */
export const typeOptions = COUNTERPARTY_TYPES.map((t) => ({
  value: t,
  label: counterpartyTypeLabels[t],
}));

/**
 * Что уходит на сервер из значений формы. Живёт рядом с полями, а не во вкладке, ровно потому, что
 * зависит от них: поле `email` показано только сервисной компании, и правило «что видно, то и
 * отправляем» должно меняться вместе с условием показа, а не через файл.
 *
 * **Адрес уходит только у сервисной компании — и у заведения, и у правки.** Правило одно, потому
 * что и причина одна: поле показано только ей, а скрытое поле не проверяется (см. правило ниже).
 * Отправить непроверенное значение значило бы поменять тихий отказ формы на серверный — 400 на
 * поле, которого человек не видит.
 *
 * Различаются только СПОСОБЫ сказать «адреса тут нет», и различие содержательное:
 *
 * · правка поля не шлёт вовсе — отсутствие в теле `PATCH` означает «не трогать», и ящик организации
 *   переживает смену типа ровно так, как обещано в ADR 0153; очищают его там же, где заводят;
 * · заведение шлёт пустую строку — `POST` требует полного тела, а беречь нечего: карточки ещё нет.
 *
 * Прежде заведение слало то, что лежит в значениях формы, с объяснением «непроверенному значению
 * взяться неоткуда — форма пустая». Объяснение было неверным: адрес вводят при типе «Сервисная
 * компания», затем меняют тип на любой другой — поле прячется, проверка перестаёт спрашиваться, а
 * значение в форме остаётся. Заведение отправляло его и получало отказ API.
 */
export function counterpartyCreatePayload(values: CounterpartyFormValues): CreateCounterpartyInput {
  return { ...counterpartyFields(values), email: serviceEmailOf(values) };
}

export function counterpartyUpdatePayload(values: CounterpartyFormValues): UpdateCounterpartyInput {
  const fields = counterpartyFields(values);
  return values.type === 'service' ? { ...fields, email: serviceEmailOf(values) } : fields;
}

/** Адрес, если он вообще принадлежит этому типу; у прочих — пусто, что бы ни осталось в форме. */
function serviceEmailOf(values: CounterpartyFormValues): string {
  return values.type === 'service' ? (values.email ?? '') : '';
}

function counterpartyFields(values: CounterpartyFormValues) {
  return {
    type: values.type,
    name: values.name,
    inn: values.inn,
    synonyms: values.synonyms ?? [],
    // У прочих типов поля в форме нет; пустой список сервер примет, непустой — отклонит.
    objectIds: values.type === 'operator' ? (values.objectIds ?? []) : [],
    comment: values.comment ?? '',
    isActive: values.isActive,
  };
}

export function CounterpartyFormFields({
  form,
  objectOptions,
  onFinish,
}: {
  form: FormInstance<CounterpartyFormValues>;
  /** Объекты для оператора: список ведёт вкладка — он же нужен ей самой для отборов. */
  objectOptions: { value: string; label: string }[];
  onFinish: (values: CounterpartyFormValues) => void;
}) {
  // Поля следуют за выбранным типом: объекты обслуживает только оператор, ящик — сервисная компания.
  const watchType = Form.useWatch('type', form);

  return (
    <Form form={form} layout="vertical" onFinish={onFinish}>
      <Form.Item name="type" label="Тип" rules={[{ required: true, message: 'Выберите тип' }]}>
        <AutoSelect options={typeOptions} />
      </Form.Item>
      <Form.Item
        name="name"
        label="Наименование"
        tooltip="Как называем контрагента мы; варианты из документов вносятся в синонимы"
        rules={[{ required: true, message: 'Укажите наименование' }]}
      >
        <Input maxLength={255} />
      </Form.Item>
      <Form.Item
        name="inn"
        label="ИНН"
        rules={[
          { required: true, message: INN_MESSAGE },
          {
            validator: (_rule, v: string | undefined) => {
              if (!v) return Promise.resolve();
              if (!/^(\d{10}|\d{12})$/.test(v.trim())) {
                return Promise.reject(new Error(INN_MESSAGE));
              }
              // Контрольная сумма ловит опечатку в одной цифре — формат её не видит.
              return isValidInn(v.trim())
                ? Promise.resolve()
                : Promise.reject(new Error(INN_CHECKSUM_MESSAGE));
            },
          },
        ]}
      >
        <Input maxLength={12} placeholder="10 или 12 цифр" />
      </Form.Item>
      <Form.Item
        name="synonyms"
        label="Синонимы наименования"
        tooltip="Как контрагента пишут в накладных и выгрузках. Enter — добавить вариант"
        extra="Один и тот же синоним не может принадлежать двум контрагентам"
      >
        <Select
          mode="tags"
          tokenSeparators={[';']}
          open={false}
          suffixIcon={null}
          placeholder="ООО «Ромашка», Ромашка ООО…"
        />
      </Form.Item>
      {watchType === 'operator' && (
        <Form.Item
          name="objectIds"
          label="Обслуживаемые объекты"
          tooltip="Объекты, с которых оператор вывозит мусор; из них подставляется исполнитель заявки"
          extra="Пусто — оператор доступен только на объектах, где операторы не заданы"
        >
          <Select
            mode="multiple"
            options={objectOptions}
            showSearch
            optionFilterProp="label"
            placeholder="Не ограничивать"
          />
        </Form.Item>
      )}
      <Form.Item
        name="email"
        label="Email для заявок"
        hidden={watchType !== 'service'}
        normalize={normalizeEmail}
        validateTrigger="onBlur"
        /**
         * Правило спрашивается только у показанного поля. `hidden` у `Form.Item` — это стиль, а не
         * снятие с учёта: скрытое поле по-прежнему проверяется на отправке, и кривой адрес, пришедший
         * из старых данных, запер бы сохранение карточки другого типа сообщением, которого не видно
         * — человек нажимал бы «Сохранить» впустую. Само значение при этом остаётся: адрес
         * организации переживает смену типа, и в этом весь смысл `hidden` вместо условного вывода.
         *
         * Тип спрашивается у САМОЙ ФОРМЫ (`getFieldValue`), а не у `watchType` рядом. Разница не
         * стилистическая: `useWatch` отдаёт значение через перерисовку и на первых кадрах возвращает
         * `undefined`, так что проверка, повешенная на него, пропускала бы кривой адрес ровно тогда,
         * когда карточку отправили быстро. `getFieldValue` читает хранилище формы и врать не может.
         */
        rules={[
          ({ getFieldValue }) => ({
            validator: (_: unknown, value: unknown) =>
              getFieldValue('type') !== 'service' ||
              optionalEmailSchema.safeParse(typeof value === 'string' ? value : '').success
                ? Promise.resolve()
                : Promise.reject(new Error(EMAIL_FORMAT_MESSAGE)),
          }),
        ]}
        tooltip="Общий ящик компании: сюда портал пишет о назначенных ей заявках на обслуживание оргтехники"
        extra="Пусто — письма получат только учётки этой компании в портале, а если их нет, то никто"
      >
        <Input type="email" maxLength={255} placeholder="service@example.ru" autoComplete="off" />
      </Form.Item>
      <Form.Item name="comment" label="Комментарий">
        <Input.TextArea rows={2} maxLength={2000} showCount />
      </Form.Item>
      <Form.Item
        name="isActive"
        label="Активен"
        valuePropName="checked"
        // У неактивного арендодателя не может быть активных предложений аренды (ADR 0018 §15):
        // деактивация гасит их разом, обратное включение — по одной позиции вручную.
        extra={
          watchType === 'vehicle_lessor'
            ? 'Деактивация выключит всю технику этого арендодателя, активация — вернёт ровно её (позиции, выключенные вручную, останутся выключенными)'
            : undefined
        }
      >
        <Switch />
      </Form.Item>
    </Form>
  );
}

import { useEffect, useState } from 'react';
import { Alert, Button, Form, Input, InputNumber, Select, Switch, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  COMPONENT_CODES,
  DEVICE_PROFILE_CODES,
  DEVICE_RULE_SAMPLE_LIMIT,
  METRIC_CODES,
  PARSE_RULE_IDENTITY_KINDS,
  PARSE_RULE_MATCH_KINDS,
  PARSE_RULE_SCOPES,
  PARSE_RULE_TARGETS,
  PARSE_VALUE_FORMS,
  componentLabels,
  deviceIdentityLabels,
  deviceMessageStatusLabels,
  metricLabels,
  parseRuleMatchKindLabels,
  parseRuleScopeLabels,
  parseRuleTargetLabels,
  parseValueFormLabels,
  type DeviceParseRuleDto,
  type DeviceParseRuleInput,
} from '@technic/contracts';
import type { DeviceParseRulePreviewDto } from '@technic/contracts';
import { deviceMailKeys, deviceRuleApi } from '@entities/device-mail';
import { FormModal } from '@shared/ui';
import { formatDateTime } from '../../../utils/format';
import { useDeviceRulePreview, useDeviceRuleSave } from '../model/actions';

/**
 * Форма правила разбора (план `docs/office-equipment-mail-identity-ui-plan.md`, §6.2).
 *
 * ПРОВЕРКА НА ЖИВОМ ПИСЬМЕ СТОИТ В САМОЙ ФОРМЕ, а не отдельным экраном: правило метрики кладёт
 * число в ряд наработки, и ошибку в нём заметить некому — счётчик МФУ никто не помнит наизусть.
 * Проверка ничего не пишет, поэтому нажимать её можно не думая; именно этого от неё и ждут.
 *
 * ЕДИНИЦЫ В ФОРМЕ НЕТ НИ ОДНИМ ПОЛЕМ. Она свойство метрики и объявлена в контракте: спроси её у
 * человека — и появится второй носитель правила, расходящийся с реестром на первой правке.
 *
 * ПИСЬМО ДЛЯ ПРОВЕРКИ ВЫБИРАЮТ ИЗ СПИСКА, а не набирают идентификатором. Проверить правило можно
 * только на письме с сохранённым сырьём, и снаружи такое письмо ничем не отличимо: набранный
 * вручную UUID письма без тела отвечал бы отказом, который читается как ошибка правила. Список же
 * не предлагает того, чего сервер не примет.
 */

const options = <T extends string>(values: readonly T[], labels: Record<T, string>) =>
  values.map((value) => ({ value, label: labels[value] }));

interface Values {
  target: 'identity' | 'metric';
  keyKind?: (typeof PARSE_RULE_IDENTITY_KINDS)[number];
  metricCode?: (typeof METRIC_CODES)[number];
  component?: (typeof COMPONENT_CODES)[number];
  valueForm?: (typeof PARSE_VALUE_FORMS)[number];
  matchKind: (typeof PARSE_RULE_MATCH_KINDS)[number];
  expression: string;
  scope: (typeof PARSE_RULE_SCOPES)[number];
  whenProfile: (typeof DEVICE_PROFILE_CODES)[number] | null;
  whenFrom: string;
  whenSubject: string;
  whenModel: string;
  sortOrder: number;
  isEnabled: boolean;
  /**
   * Письмо для проверки. В само правило не входит — это черновик проверки, а не его поле, — но
   * полем ФОРМЫ оно стало осознанно: так подпись «Письмо для проверки» связана с самим списком
   * (иначе поле без `label` недоступно ни человеку с читалкой, ни поиску по подписи), и выбор
   * сбрасывается тем же `setFieldsValue`, которым открытие чистит остальное.
   *
   * В тело запроса оно при этом попасть не может: `toInput` перечисляет поля правила поимённо, а
   * схема правила `.strict()` — лишнее поле отвергается сервером, а не проглатывается молча.
   */
  previewMessageId?: string;
}

function toInput(values: Values): DeviceParseRuleInput {
  const common = {
    matchKind: values.matchKind,
    expression: values.expression.trim(),
    scope: values.scope,
    whenProfile: values.whenProfile ?? null,
    whenFrom: values.whenFrom ?? '',
    whenSubject: values.whenSubject ?? '',
    whenModel: values.whenModel ?? '',
    sortOrder: values.sortOrder,
    isEnabled: values.isEnabled,
  };
  return values.target === 'identity'
    ? { target: 'identity', keyKind: values.keyKind!, ...common }
    : {
        target: 'metric',
        metricCode: values.metricCode!,
        component: values.component ?? '',
        valueForm: values.valueForm ?? 'number',
        ...common,
      };
}

export function DeviceRuleFormModal({
  open,
  rule,
  onClose,
}: {
  open: boolean;
  /** `null` — заводим новое правило. */
  rule: DeviceParseRuleDto | null;
  onClose: () => void;
}) {
  const [form] = Form.useForm<Values>();
  const target = Form.useWatch('target', form);
  const previewId = Form.useWatch('previewMessageId', form);
  /*
   * Ответ проверки держится СВОИМ состоянием, а не полем мутации, и причина не в стиле. Объект
   * мутации меняется на каждом её шаге, и стоило ему попасть в зависимости эффекта — сброс рождал
   * новый объект, тот новый сброс, и экран уходил в бесконечный круг. Со своим состоянием сеттер
   * стабилен, а эффекту незачем знать о мутации вовсе.
   */
  const [result, setResult] = useState<DeviceParseRulePreviewDto | null>(null);
  const save = useDeviceRuleSave(rule?.id ?? null, onClose);
  const preview = useDeviceRulePreview();
  /*
   * Образцы спрашиваются ТОЛЬКО У ОТКРЫТОГО ОКНА. Форма живёт в разметке доски всё время, по два
   * экземпляра сразу (заведение и правка), и запрос без этого условия ходил бы за письмами при
   * каждом открытии раздела — ради списка, которого никто не видит.
   */
  const samplesQuery = useQuery({
    queryKey: deviceMailKeys.ruleSamples(),
    queryFn: () => deviceRuleApi.samples(),
    enabled: open,
  });
  const samples = samplesQuery.data?.items ?? [];
  /*
   * ТРИ СОСТОЯНИЯ СПИСКА РАЗВЕДЕНЫ, И ЭТО НЕ ПЕДАНТИЗМ. «Ещё не ответили», «ответили пустым» и
   * «запрос упал» приводят к одинаково пустому списку, но означают разное: первое проходит само,
   * второе — свойство приёмника, третье чинится повторным запросом. Слитые в одно, они показывали
   * бы человеку «писем нет» ровно тогда, когда письма есть, а до них не дошёл запрос, — и
   * единственным способом попробовать снова осталось бы закрыть и открыть окно.
   *
   * Отказ считается только при ПУСТОМ списке: при неудачном перезапросе react-query поднимает
   * `isError`, но прежние письма оставляет при себе, — выбирать из них по-прежнему законно
   * (образец — `widgets/utility-menu/ui/ManualsModal.tsx`).
   */
  const samplesFailed = samplesQuery.isError && samples.length === 0;
  const noSamples = samplesQuery.isSuccess && samples.length === 0;

  useEffect(() => {
    if (!open) return;
    setResult(null);
    form.setFieldsValue({
      target: rule?.target ?? 'identity',
      keyKind: rule?.keyKind ?? 'serial',
      metricCode: rule?.metricCode ?? undefined,
      component: rule?.component ?? '',
      valueForm: rule?.valueForm ?? 'number',
      matchKind: rule?.matchKind ?? 'label',
      expression: rule?.expression ?? '',
      scope: rule?.scope ?? 'any',
      whenProfile: rule?.whenProfile ?? null,
      whenFrom: rule?.whenFrom ?? '',
      whenSubject: rule?.whenSubject ?? '',
      whenModel: rule?.whenModel ?? '',
      sortOrder: rule?.sortOrder ?? 100,
      isEnabled: rule?.isEnabled ?? true,
      // Письмо проверки чистится вместе с правилом: выбранное для прошлого правила к новому
      // отношения не имеет, а «Проверить» с чужим письмом отвечала бы по нему же.
      previewMessageId: undefined,
    });
    // Сброс проверки — часть открытия: ответ по прошлому правилу рядом с новым читался бы как его.
    //
    // ОБЪЕКТА МУТАЦИИ В ЗАВИСИМОСТЯХ БЫТЬ НЕ ДОЛЖНО: он меняется на каждом шаге запроса, и эффект
    // пересбрасывал бы форму бесконечно — экран уходил в круг, а прогон тестов в таймаут без
    // единого падения. Сбрасывается своё состояние, и сеттеры у него стабильны.
  }, [open, rule, form]);

  return (
    <FormModal
      open={open}
      title={rule ? 'Правило разбора' : 'Новое правило разбора'}
      okText="Сохранить"
      width={640}
      confirmLoading={save.isPending}
      onCancel={onClose}
      onSubmit={() => form.submit()}
    >
      <Form<Values>
        form={form}
        /*
         * ИМЯ ФОРМЫ РАЗНОЕ У ДВУХ ЭКЗЕМПЛЯРОВ, и это не украшение. Доска держит форму дважды —
         * заведение и правку, — а закрытое окно antd из разметки не убирает. Без имени поля обеих
         * форм получают одинаковые `id` (`whenModel`, `previewMessageId`), и подпись, читалка и
         * `getElementById` указывают на поле ЗАКРЫТОГО окна: щелчок по подписи уводит курсор туда,
         * где его никто не увидит. Имя формы разводит `id` по экземплярам.
         */
        name={rule ? `device-rule-${rule.id}` : 'device-rule-new'}
        layout="vertical"
        onFinish={(v) => save.mutate(toInput(v))}
        /*
         * ЛЮБАЯ ПРАВКА ГАСИТ ОТВЕТ ПРОВЕРКИ — по той же причине, по которой его гасит открытие
         * окна: ответ, полученный по другому письму или по другому выражению, стоя под формой,
         * читается как ответ по нынешнему. Письмо теперь меняют одним щелчком, и «Нашлось: …» от
         * прошлого письма успевало бы подтвердить правило, которого никто не проверял.
         */
        onValuesChange={() => setResult(null)}
      >
        <Form.Item name="target" label="Что достаём" rules={[{ required: true }]}>
          <Select options={options(PARSE_RULE_TARGETS, parseRuleTargetLabels)} />
        </Form.Item>

        {target === 'identity' ? (
          <Form.Item name="keyKind" label="Ключ опознания" rules={[{ required: true }]}>
            <Select options={options(PARSE_RULE_IDENTITY_KINDS, deviceIdentityLabels)} />
          </Form.Item>
        ) : (
          <>
            <Form.Item name="metricCode" label="Показание" rules={[{ required: true }]}>
              <Select options={options(METRIC_CODES, metricLabels)} />
            </Form.Item>
            <Form.Item name="component" label="Разрез">
              <Select
                options={COMPONENT_CODES.map((value) => ({
                  value,
                  label: componentLabels[value] || 'без разреза',
                }))}
              />
            </Form.Item>
            <Form.Item name="valueForm" label="Как читать число" rules={[{ required: true }]}>
              <Select options={options(PARSE_VALUE_FORMS, parseValueFormLabels)} />
            </Form.Item>
          </>
        )}

        <Form.Item name="matchKind" label="Как ищем" rules={[{ required: true }]}>
          <Select options={options(PARSE_RULE_MATCH_KINDS, parseRuleMatchKindLabels)} />
        </Form.Item>
        <Form.Item
          name="expression"
          label="Метка или выражение"
          rules={[{ required: true, message: 'Без выражения правило ничего не найдёт' }]}
        >
          <Input placeholder="Например: machine id" />
        </Form.Item>
        <Form.Item name="scope" label="Где искать" rules={[{ required: true }]}>
          <Select options={options(PARSE_RULE_SCOPES, parseRuleScopeLabels)} />
        </Form.Item>
        <Form.Item name="whenProfile" label="Только для профиля">
          <Select
            allowClear
            placeholder="Для любого"
            options={DEVICE_PROFILE_CODES.map((value) => ({ value, label: value }))}
          />
        </Form.Item>
        <Form.Item name="whenFrom" label="Только если отправитель содержит">
          <Input placeholder="Часть адреса" />
        </Form.Item>
        <Form.Item name="whenSubject" label="Только если тема содержит">
          <Input placeholder="Часть темы" />
        </Form.Item>
        {/* Строкой, а не выбором из справочника моделей: сравнивается подстрока, и прошивка пишет
            модель иначе, чем справочник («RICOH MP C2011» против «Ricoh Aficio MP C2011SP»).
            Список моделей предлагал бы здесь ровно те написания, которых в письмах не бывает. */}
        <Form.Item name="whenModel" label="Только для модели">
          <Input placeholder="Часть названия модели" />
        </Form.Item>
        <Form.Item name="sortOrder" label="Порядок">
          <InputNumber min={0} max={1000} />
        </Form.Item>
        <Form.Item name="isEnabled" label="Применяется" valuePropName="checked">
          <Switch />
        </Form.Item>

        <Typography.Text strong>Проверить на письме</Typography.Text>
        {/* КНОПКА ПОД СПИСКОМ, А НЕ СБОКУ. Сбоку она требовала бы выравнивания, а выравнивать не с
            чем: у поля сверху подпись, снизу — строка объяснения, которая появляется и исчезает, и
            кнопка ездила бы вместе с ней. На узком экране окно разворачивается во весь экран, и
            пара «список с минимальной шириной + кнопка» ломала бы строку наружу. */}
        <Form.Item
          name="previewMessageId"
          label="Письмо для проверки"
          style={{ marginTop: 8, marginBottom: 8 }}
          /*
           * Объяснение стоит РЯДОМ СО СПИСКОМ, а не тостом по нажатию: пустой список без слов
           * выглядит поломкой портала. Три состояния — три разных текста, и «Повторить» есть
           * ровно там, где повтор что-то меняет.
           */
          extra={
            samplesFailed ? (
              <>
                {SAMPLES_FAILED_TEXT}{' '}
                <Button
                  type="link"
                  size="small"
                  style={{ padding: 0 }}
                  loading={samplesQuery.isFetching}
                  onClick={() => void samplesQuery.refetch()}
                >
                  Повторить
                </Button>
              </>
            ) : noSamples ? (
              SAMPLES_EMPTY_TEXT
            ) : (
              SAMPLES_LIMIT_HINT
            )
          }
        >
          <Select
            showSearch
            optionFilterProp="label"
            loading={samplesQuery.isFetching}
            disabled={samplesFailed || noSamples}
            placeholder="Выберите письмо"
            // Во всю ширину окна: подпись письма длинная, а окно на телефоне разворачивается во
            // весь экран — жёсткая минимальная ширина рвала бы там строку.
            style={{ width: '100%' }}
            options={samples.map((sample) => ({
              value: sample.id,
              /*
               * Дата тем же видом, что в очереди: письмо ищут, сверяясь с ней глазами, и второй
               * формат времени заставил бы пересчитывать часовой пояс в уме.
               *
               * СОСТОЯНИЕ ПИСЬМА — ЧАСТЬ ПОДПИСИ. В списке лежат и неопознанные, и уже разобранные
               * письма: проверять правило законно на любом, но человек выбирает НЕ ЛЮБОЕ — он ищет
               * то, на котором разбор споткнулся, а отличить его иначе не по чему.
               */
              label: `${formatDateTime(sample.receivedAt)} · ${sample.subject || 'без темы'} · ${
                sample.fromAddress || 'отправитель не указан'
              } · ${deviceMessageStatusLabels[sample.status]}`,
            }))}
          />
        </Form.Item>
        <Button
          loading={preview.isPending}
          disabled={!previewId}
          onClick={() =>
            preview.mutate(
              { messageId: previewId!, rule: toInput(form.getFieldsValue()) },
              { onSuccess: setResult },
            )
          }
        >
          Проверить
        </Button>
        {result && (
          <Alert
            style={{ marginTop: 8 }}
            type={result.applies && result.found ? 'success' : 'warning'}
            showIcon
            /*
             * `applies` ЧИТАЕТСЯ ПЕРВЫМ, И ПОРЯДОК ЗДЕСЬ — ВЕСЬ СМЫСЛ. Не подошедшее условие
             * (профиль, отправитель, тема, модель) означает, что выражение не запускалось вовсе, а
             * «Ничего не нашлось» утверждает обратное: будто искали и не нашли. Прочитав это,
             * человек правит выражение — единственное, что в этом правиле работало.
             */
            title={
              !result.applies
                ? 'Правило к этому письму не применяется'
                : result.found
                  ? `Нашлось: ${result.value}${result.unitLabel ? ` ${result.unitLabel}` : ''}`
                  : 'Ничего не нашлось'
            }
            description={result.note}
          />
        )}
      </Form>
    </FormModal>
  );
}

/**
 * «Проверять не на чем» — состояние приёмника, а не поломка формы. Сырьё письма хранится
 * ограниченный срок и бывает не у всякого письма, поэтому список образцов законно пуст до первого
 * принятого письма — и говорит об этом словами, как пустой список правил на доске.
 */
export const SAMPLES_EMPTY_TEXT = 'Писем с сохранённым сырьём нет — проверять правило не на чем';

/**
 * Отказ списка — не то же, что пустой список, и говорит он о другом: письма, скорее всего, есть, а
 * до них не дошёл запрос. Поэтому рядом стоит «Повторить»: закрывать и открывать окно ради второй
 * попытки человек не обязан.
 */
export const SAMPLES_FAILED_TEXT = 'Список писем сейчас недоступен';

/**
 * Потолок списка назван вслух: письма старше последних `DEVICE_RULE_SAMPLE_LIMIT` для проверки
 * недоступны, а поиск в списке ищет только по загруженному. Без этой строки человек, не нашедший
 * нужное письмо, решил бы, что портал его потерял, — и пошёл бы искать причину не там.
 */
export const SAMPLES_LIMIT_HINT =
  `Показаны последние ${DEVICE_RULE_SAMPLE_LIMIT} писем с сохранённым сырьём`;

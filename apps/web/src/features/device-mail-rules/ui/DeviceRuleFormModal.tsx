import { useEffect, useState } from 'react';
import { Alert, Button, Form, Input, InputNumber, Select, Space, Switch, Typography } from 'antd';
import {
  COMPONENT_CODES,
  DEVICE_PROFILE_CODES,
  METRIC_CODES,
  PARSE_RULE_IDENTITY_KINDS,
  PARSE_RULE_MATCH_KINDS,
  PARSE_RULE_SCOPES,
  PARSE_RULE_TARGETS,
  PARSE_VALUE_FORMS,
  componentLabels,
  deviceIdentityLabels,
  metricLabels,
  parseRuleMatchKindLabels,
  parseRuleScopeLabels,
  parseRuleTargetLabels,
  parseValueFormLabels,
  type DeviceParseRuleDto,
  type DeviceParseRuleInput,
} from '@technic/contracts';
import { FormModal } from '@shared/ui';
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
  sortOrder: number;
  isEnabled: boolean;
  /** Письмо для проверки. В само правило не входит: это черновик проверки, а не его поле. */
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
  const target: 'identity' | 'metric' = 'identity';
  const [previewId, setPreviewId] = useState('');
  const save = useDeviceRuleSave(rule?.id ?? null, onClose);
  const preview = useDeviceRulePreview();

  useEffect(() => {
    if (!open) return;
    preview.reset();
    setPreviewId('');
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
      sortOrder: rule?.sortOrder ?? 100,
      isEnabled: rule?.isEnabled ?? true,
    });
    // Сброс проверки — часть открытия: ответ по прошлому правилу рядом с новым читался бы как его.
  }, [open, rule, form, preview]);

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
      <Form<Values> form={form} layout="vertical" onFinish={(v) => save.mutate(toInput(v))}>
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
        <Form.Item name="sortOrder" label="Порядок">
          <InputNumber min={0} max={1000} />
        </Form.Item>
        <Form.Item name="isEnabled" label="Применяется" valuePropName="checked">
          <Switch />
        </Form.Item>

        <Typography.Text strong>Проверить на письме</Typography.Text>
        <Space.Compact style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <Input
            value={previewId}
            onChange={(e) => setPreviewId(e.target.value)}
            placeholder="Идентификатор письма из очереди"
          />
          <Button
            loading={preview.isPending}
            disabled={previewId.trim() === ''}
            onClick={() =>
              preview.mutate({
                messageId: previewId.trim(),
                rule: toInput(form.getFieldsValue()),
              })
            }
          >
            Проверить
          </Button>
        </Space.Compact>
        {preview.data && (
          <Alert
            style={{ marginTop: 8 }}
            type={preview.data.found ? 'success' : 'warning'}
            showIcon
            title={
              preview.data.found
                ? `Нашлось: ${preview.data.value}${preview.data.unitLabel ? ` ${preview.data.unitLabel}` : ''}`
                : 'Ничего не нашлось'
            }
            description={preview.data.note}
          />
        )}
      </Form>
    </FormModal>
  );
}

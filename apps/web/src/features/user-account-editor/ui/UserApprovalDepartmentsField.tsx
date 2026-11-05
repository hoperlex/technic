import { Button, Form, Select, Space } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { APPROVAL_DEPARTMENTS_REQUIRED_MESSAGE } from '@technic/contracts';

/**
 * Visa departments of the account (ADR 0245): where a visa that an axis-less role received from a
 * grant acts — the departments' own orders and those of their sites, as for the department head.
 *
 * Shown only while a checked grant gives such a visa (owner decision 05.11.2026): the visa itself
 * stays optional, a checkbox among the grants, and once it is checked at least one department is
 * required — without one the grant would give nothing. One row per department with a «+» button,
 * as the owner asked: a manager usually signs for one department, sometimes for several.
 *
 * Rows rather than a multiple select: each row is one decision ("signs for ОАТ СМ"), and an empty
 * row is filtered out on save instead of blocking it.
 */

interface Props {
  options: { value: string; label: string }[];
  loading: boolean;
}

export function UserApprovalDepartmentsField({ options, loading }: Props) {
  return (
    <Form.List
      name="approvalDepartmentIds"
      rules={[
        {
          validator: (_rule, value: (string | undefined)[] | undefined) =>
            (value ?? []).some(Boolean)
              ? Promise.resolve()
              : Promise.reject(new Error(APPROVAL_DEPARTMENTS_REQUIRED_MESSAGE)),
        },
      ]}
    >
      {(fields, { add, remove }, { errors }) => (
        <Form.Item
          label="Отделы визы"
          required
          tooltip="Виза действует на заявки этих отделов и закреплённых за ними площадок — как у руководителя отдела. Видимость заявок у учётки не меняется"
        >
          <Space orientation="vertical" size={8} style={{ width: '100%' }}>
            {fields.map((field) => (
              <Space.Compact key={field.key} style={{ width: '100%' }}>
                <Form.Item name={field.name} noStyle>
                  <Select
                    options={options}
                    loading={loading}
                    showSearch
                    optionFilterProp="label"
                    placeholder="Выберите отдел"
                    style={{ width: '100%' }}
                    aria-label="Отдел визы"
                  />
                </Form.Item>
                {fields.length > 1 ? (
                  <Button
                    icon={<DeleteOutlined />}
                    aria-label="Убрать отдел визы"
                    onClick={() => remove(field.name)}
                  />
                ) : null}
              </Space.Compact>
            ))}
            <Button type="dashed" icon={<PlusOutlined />} onClick={() => add()}>
              Добавить отдел визы
            </Button>
            <Form.ErrorList errors={errors} />
          </Space>
        </Form.Item>
      )}
    </Form.List>
  );
}

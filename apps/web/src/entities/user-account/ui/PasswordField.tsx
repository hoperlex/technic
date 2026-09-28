import { Form, Input, Progress, Typography } from 'antd';
import {
  PASSWORD_MIN,
  passwordIdentityIssue,
  passwordStrength,
  passwordWeakness,
} from '@technic/contracts';

interface Props {
  name: string;
  label?: string;
  /**
   * Поля формы, содержимое которых не должно встречаться в пароле (email, фамилия, имя).
   * Их же проверяет сервер — здесь проверка нужна, чтобы не отправлять заведомо отклонённое.
   */
  identityFields?: string[];
  showStrength?: boolean;
  size?: 'large' | 'middle';
}

const STRENGTH_LABELS = ['Слабый', 'Приемлемый', 'Хороший', 'Надёжный'] as const;
const STRENGTH_COLORS = ['#ff4d4f', '#faad14', '#52c41a', '#237804'] as const;

/**
 * Поле пароля с теми же правилами, что и на сервере (ADR 0034): одной длины мало —
 * «1234567890» и «Иванов1234» её проходят, а подбираются мгновенно.
 */
export function PasswordField({
  name,
  label = 'Пароль',
  identityFields = [],
  showStrength = true,
  size = 'middle',
}: Props) {
  const form = Form.useFormInstance();
  const value = Form.useWatch<string | undefined>(name, form);
  const strength = passwordStrength(value ?? '');

  return (
    <Form.Item
      name={name}
      label={label}
      required
      rules={[
        { required: true, message: `Не менее ${PASSWORD_MIN} символов` },
        { min: PASSWORD_MIN, message: `Не менее ${PASSWORD_MIN} символов` },
        () => ({
          validator: (_, v: unknown) => {
            if (typeof v !== 'string' || v.length < PASSWORD_MIN) return Promise.resolve();
            const identity = identityFields
              .map((field) => form.getFieldValue(field))
              .filter((part): part is string => typeof part === 'string' && part.length > 0);
            const issue = passwordWeakness(v) ?? passwordIdentityIssue(v, identity);
            return issue ? Promise.reject(new Error(issue)) : Promise.resolve();
          },
        }),
      ]}
      extra={
        showStrength && value ? (
          <span>
            <Progress
              percent={((strength + 1) / 4) * 100}
              showInfo={false}
              size="small"
              strokeColor={STRENGTH_COLORS[strength]}
            />
            <Typography.Text type="secondary">{STRENGTH_LABELS[strength]}</Typography.Text>
          </span>
        ) : undefined
      }
    >
      <Input.Password size={size} autoComplete="new-password" />
    </Form.Item>
  );
}

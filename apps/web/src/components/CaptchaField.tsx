import { useEffect, useRef, useState } from 'react';
import { Button, Input, Space, Spin, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { CAPTCHA_ANSWER_LENGTH, type CaptchaChallenge } from '@technic/contracts';
import { authApi } from '../api/auth';

export interface CaptchaValue {
  token: string;
  answer: string;
}

interface Props {
  /** Заполняется antd Form через `Form.Item` — компонент работает как обычный контрол. */
  value?: CaptchaValue;
  onChange?: (value: CaptchaValue) => void;
  /** Приходит от `Form.Item`; вешается на поле ввода, иначе подпись формы ни с чем не связана. */
  id?: string;
  /**
   * Счётчик, по изменению которого картинка перевыпускается. Нужен форме: челлендж
   * одноразовый, и после неудачной отправки прежняя картинка уже недействительна.
   */
  resetToken?: number;
}

/**
 * Поле капчи: картинка приходит с сервера data-URL'ом, разгадка остаётся там же (ADR 0034).
 * Ответ вводится цифрами — на телефоне открывается цифровая клавиатура, а не буквенная.
 */
export function CaptchaField({ value, onChange, id, resetToken = 0 }: Props) {
  const [challenge, setChallenge] = useState<CaptchaChallenge | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [reloads, setReloads] = useState(0);

  // onChange от antd пересоздаётся на каждый рендер; в зависимостях эффекта он бы зациклил запрос.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    authApi
      .captcha()
      .then((next) => {
        if (cancelled) return;
        setChallenge(next);
        // Токен уходит в форму сразу, ответ обнуляется: прежний относился к прошлой картинке.
        onChangeRef.current?.({ token: next.token, answer: '' });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [resetToken, reloads]);

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space size={8} align="center">
        <div
          style={{
            width: 240,
            maxWidth: '100%',
            height: 80,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px solid var(--ant-color-border)',
            borderRadius: 8,
            overflow: 'hidden',
          }}
        >
          {loading ? (
            <Spin size="small" />
          ) : challenge ? (
            <img
              src={challenge.image}
              alt="Проверочный код на картинке"
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
          ) : (
            <Typography.Text type="secondary">Не загрузилась</Typography.Text>
          )}
        </div>
        <Button
          icon={<ReloadOutlined />}
          onClick={() => setReloads((n) => n + 1)}
          loading={loading}
          title="Другая картинка"
          aria-label="Показать другую картинку"
        />
      </Space>
      <Input
        id={id}
        size="large"
        inputMode="numeric"
        autoComplete="off"
        maxLength={CAPTCHA_ANSWER_LENGTH}
        placeholder={`${CAPTCHA_ANSWER_LENGTH} цифр с картинки`}
        value={value?.answer ?? ''}
        onChange={(e) =>
          onChangeRef.current?.({
            token: challenge?.token ?? value?.token ?? '',
            // На картинке только цифры — остальное отбрасываем, чтобы не тратить попытку.
            answer: e.target.value.replace(/\D/gu, ''),
          })
        }
      />
      {failed ? (
        <Typography.Text type="danger">
          Картинка не загрузилась — нажмите «обновить».
        </Typography.Text>
      ) : null}
    </Space>
  );
}

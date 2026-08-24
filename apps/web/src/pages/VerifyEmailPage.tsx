import { useState } from 'react';
import { App, Button, Card, Form, Input, Result, Typography } from 'antd';
import { useSearchParams } from 'react-router';
import { normalizeEmail } from '@technic/contracts';
import { authApi } from '../api/auth';
import { CaptchaField } from '../components/CaptchaField';
import { useCaptcha } from '../components/useCaptcha';
import { errorFields, errorMessage } from '../utils/format';
import {
  captchaBlocksSubmit,
  CaptchaSubmitNote,
  goToLogin,
  useLeaveCaptchaPageIfAuthenticated,
} from './captchaPage';

interface ResendValues {
  email: string;
  /**
   * Одноразовый токен виджета SmartCaptcha. Необязателен: при выключенной капче поля на форме нет
   * вовсе, и запрос уходит с пустым токеном (план §5).
   */
  captchaToken?: string;
}

/**
 * Подтверждение адреса по ссылке из письма (ADR 0072).
 *
 * Подтверждение отправляется по нажатию кнопки, а не при открытии страницы: почтовые клиенты и
 * антивирусы предварительно открывают ссылки у себя, и автоматическое подтверждение срабатывало бы
 * раньше, чем письмо увидел человек, — то есть подтверждало бы адрес без его участия.
 *
 * Устаревшая ссылка не тупик: с той же страницы запрашивается новое письмо.
 */
export function VerifyEmailPage() {
  const { message } = App.useApp();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [form] = Form.useForm<ResendValues>();
  const [loading, setLoading] = useState(false);
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const [resent, setResent] = useState<string | null>(null);
  // Токен капчи одноразовый и живёт минуты: после обработанной попытки он потрачен, и виджет надо
  // сбросить — счётчик меняется, `CaptchaField` по нему перерисовывает чекбокс.
  const [captchaNonce, setCaptchaNonce] = useState(0);
  const captcha = useCaptcha();
  // Вошедшая вкладка форму с капчей не рендерит и уходит в портал полной навигацией (§12).
  const leavingAuthenticated = useLeaveCaptchaPageIfAuthenticated();

  const confirm = async () => {
    setLoading(true);
    try {
      await authApi.verifyEmail({ token });
      setState('done');
    } catch (e) {
      message.error(errorMessage(e));
      setState('failed');
    } finally {
      setLoading(false);
    }
  };

  const resend = async (values: ResendValues) => {
    setLoading(true);
    try {
      const res = await authApi.resendVerification({
        email: values.email,
        captchaToken: values.captchaToken ?? '',
      });
      setResent(res.message);
    } catch (e) {
      /*
       * Отказ проверки сервер возвращает на поле `captchaToken`. Условие про `enabled` — не
       * перестраховка: если поля на форме нет (вкладка успела прочитать «капча выключена», а на
       * сервере уже завели ключи), ошибка у невидимого поля не показалась бы нигде.
       */
      /*
       * Причина отказа показывается сообщением, а не подписью у поля. Подпись здесь не живёт:
       * следом растёт `captchaNonce`, поле капчи сбрасывает виджет и отдаёт форме пустой токен, а
       * antd на этом `onChange` перевалидирует поле и заменяет серверный текст своим «Подтвердите,
       * что вы не робот». Человек в итоге видел бы правило формы вместо причины («Проверка не
       * пройдена», «Слишком много попыток») — то есть не узнал бы её никогда. Сообщение живёт
       * независимо от поля и переживает сброс виджета.
       */
      const fields = errorFields(e);
      message.error(fields?.captchaToken ?? errorMessage(e));
      setCaptchaNonce((n) => n + 1);
      form.setFieldValue('captchaToken', '');
    } finally {
      setLoading(false);
    }
  };

  // Ранний выход строго после всех хуков: порядок вызовов React менять нельзя. Ничего не рисуем —
  // документ через мгновение заменит полная навигация в портал.
  if (leavingAuthenticated) return null;

  const resendForm = (
    <Form form={form} layout="vertical" onFinish={resend} requiredMark={false}>
      <Form.Item
        name="email"
        label="Email из заявки"
        normalize={normalizeEmail}
        rules={[{ required: true, type: 'email', message: 'Введите корректный email' }]}
      >
        <Input autoComplete="username" size="large" />
      </Form.Item>
      {/* Капча — только когда сервер сказал, что она включена. При `disabled` прячем весь
          `Form.Item`: само поле в этом состоянии возвращает `null`, и осталась бы висеть подпись
          «Проверка» над пустым местом. Правило `required` ставится ровно при `enabled`: при
          `loading`/`error` требовать токен не за что, отправку в этих состояниях запрещает
          кнопка (план §5). */}
      {captcha.status === 'disabled' ? null : (
        <Form.Item
          name="captchaToken"
          label="Проверка"
          required={captcha.status === 'enabled'}
          rules={
            captcha.status === 'enabled'
              ? [{ required: true, message: 'Подтвердите, что вы не робот' }]
              : []
          }
        >
          <CaptchaField resetToken={captchaNonce} />
        </Form.Item>
      )}
      {/* Пока портал не знает, требуется ли токен (`loading`), и когда не смог узнать (`error`),
          отправка заблокирована: угадывать здесь нельзя (§5). Кнопку «Подтвердить адрес» это не
          трогает — подтверждение идёт по токену из письма и капчи не требует. */}
      <Button
        type="primary"
        htmlType="submit"
        size="large"
        block
        loading={loading}
        disabled={captchaBlocksSubmit(captcha)}
      >
        Прислать письмо заново
      </Button>
      <CaptchaSubmitNote captcha={captcha} />
    </Form>
  );

  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <Card style={{ width: '100%', maxWidth: 420 }}>
        {state === 'done' ? (
          <Result
            status="success"
            title="Адрес подтверждён"
            subTitle="Заявка ушла администратору. Войти можно будет, когда он выдаст доступ."
            extra={
              /* Полная навигация вместо `navigate('/login')`: документ со сторонним `captcha.js`
                 обязан умереть до того, как человек введёт логин и пароль (§12). */
              <Button type="primary" onClick={goToLogin}>
                Ко входу
              </Button>
            }
          />
        ) : resent ? (
          <Result status="success" title="Письмо отправлено" subTitle={resent} />
        ) : (
          <>
            <Typography.Title level={3} style={{ textAlign: 'center' }}>
              Подтверждение адреса
            </Typography.Title>
            {token && state === 'idle' ? (
              <>
                <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
                  Нажмите кнопку, чтобы подтвердить, что этот ящик ваш.
                </Typography.Paragraph>
                <Button type="primary" size="large" block loading={loading} onClick={confirm}>
                  Подтвердить адрес
                </Button>
              </>
            ) : (
              <>
                <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
                  {token
                    ? 'Ссылка недействительна или устарела. Запросите новое письмо.'
                    : 'В адресе не хватает кода подтверждения — откройте ссылку из письма целиком или запросите новое письмо.'}
                </Typography.Paragraph>
                {resendForm}
              </>
            )}
            {/* Обычная ссылка, а не `Link`: переход ко входу должен быть полной навигацией, чтобы
                документ со сторонним `captcha.js` умер до ввода учётных данных (§12). */}
            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <a href="/login">Вернуться ко входу</a>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

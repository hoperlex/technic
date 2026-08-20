import { useState } from 'react';
import { App, Button, Card, Form, Input, Result, Typography } from 'antd';
import { authApi } from '../api/auth';
import { CaptchaField } from '../components/CaptchaField';
import { useCaptcha } from '../components/useCaptcha';
import { errorFields, errorMessage } from '../utils/format';
import {
  captchaBlocksSubmit,
  CaptchaSubmitNote,
  useLeaveCaptchaPageIfAuthenticated,
} from './captchaPage';

interface FormValues {
  email: string;
  /**
   * Одноразовый токен виджета SmartCaptcha. Необязателен: при выключенной капче поля на форме нет
   * вовсе, и запрос уходит с пустым токеном (план §5).
   */
  captchaToken?: string;
}

/**
 * «Забыли пароль?» — запрос ссылки (ADR 0072).
 *
 * Результат один и тот же независимо от того, есть ли такая учётная запись: страница, по которой
 * можно проверить, зарегистрирован ли человек в портале, — это утечка сама по себе, а форма входа
 * такой проверки не даёт. Пароль письмом не приходит: ссылка ведёт на страницу, где человек задаёт
 * новый сам.
 */
export function ForgotPasswordPage() {
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  // Токен капчи одноразовый и живёт минуты: после обработанной попытки он потрачен, и виджет надо
  // сбросить — счётчик меняется, `CaptchaField` по нему перерисовывает чекбокс.
  const [captchaNonce, setCaptchaNonce] = useState(0);
  const captcha = useCaptcha();
  // Вошедшая вкладка форму с капчей не рендерит и уходит в портал полной навигацией (§12).
  const leavingAuthenticated = useLeaveCaptchaPageIfAuthenticated();

  const onFinish = async (values: FormValues) => {
    setLoading(true);
    try {
      const res = await authApi.requestPasswordReset({
        email: values.email,
        captchaToken: values.captchaToken ?? '',
      });
      setSent(res.message);
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
        {sent ? (
          <Result
            status="success"
            title="Письмо отправлено"
            subTitle={sent}
            /* Обычная ссылка, а не `Link`: переход ко входу должен быть полной навигацией, чтобы
               документ со сторонним `captcha.js` умер до ввода учётных данных (§12). */
            extra={<a href="/login">Вернуться ко входу</a>}
          />
        ) : (
          <>
            <Typography.Title level={3} style={{ textAlign: 'center' }}>
              Восстановление доступа
            </Typography.Title>
            <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
              Пришлём ссылку на почту — новый пароль вы зададите сами.
            </Typography.Paragraph>
            <Form form={form} layout="vertical" onFinish={onFinish} requiredMark={false}>
              <Form.Item
                name="email"
                label="Email"
                rules={[{ required: true, type: 'email', message: 'Введите корректный email' }]}
              >
                <Input autoComplete="username" size="large" />
              </Form.Item>
              {/* Капча — только когда сервер сказал, что она включена. При `disabled` прячем весь
                  `Form.Item`: само поле в этом состоянии возвращает `null`, и осталась бы висеть
                  подпись «Проверка» над пустым местом. Правило `required` ставится ровно при
                  `enabled`: при `loading`/`error` требовать токен не за что, отправку в этих
                  состояниях запрещает кнопка (план §5). */}
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
              {/* Пока портал не знает, требуется ли токен (`loading`), и когда не смог узнать
                  (`error`), отправка заблокирована: угадывать здесь нельзя (§5). Объяснение при
                  `error` рисует само поле капчи — там же, где кнопка «Повторить». */}
              <Button
                type="primary"
                htmlType="submit"
                size="large"
                block
                loading={loading}
                disabled={captchaBlocksSubmit(captcha)}
              >
                Прислать ссылку
              </Button>
              <CaptchaSubmitNote captcha={captcha} />
            </Form>
            {/* И здесь полная навигация, по той же причине (§12). */}
            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <a href="/login">Вернуться ко входу</a>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

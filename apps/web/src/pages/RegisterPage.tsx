import { useState } from 'react';
import { Alert, App, Button, Card, Form, Input, Result, Typography } from 'antd';
import {
  emailSchema,
  expectsCorporateEmail,
  INTERNAL_EMAIL_DOMAINS,
  isInternalEmail,
  normalizeEmail,
  REGISTRATION_ROLE_REQUESTS,
  registrationRequestDetail,
  registrationRoleRequestLabels,
  type RegistrationRoleRequest,
} from '@technic/contracts';
import { authApi } from '../api/auth';
import { AutoSelect } from '@shared/ui';
import { CaptchaField } from '../components/CaptchaField';
import { useCaptcha } from '../components/useCaptcha';
import { PasswordField } from '../components/PasswordField';
import { PersonNameFields } from '../components/PersonNameFields';
import { PhoneField } from '../components/PhoneField';
import { errorFields, errorMessage } from '../utils/format';
import {
  captchaBlocksSubmit,
  CaptchaSubmitNote,
  goToLogin,
  useLeaveCaptchaPageIfAuthenticated,
} from './captchaPage';

interface RegisterFormValues {
  lastName: string;
  firstName: string;
  middleName?: string;
  email: string;
  /** Телефон: форма без него заявку не отправит (ADR 0066) — по нему её и рассматривают. */
  phone?: string;
  password: string;
  requestedRole?: RegistrationRoleRequest;
  /** Подразделение, где человек работает: объект или отдел — вопрос разный, переменная одна. */
  requestedObject?: string;
  requestedCompany?: string;
  requestedComment?: string;
  /**
   * Одноразовый токен виджета SmartCaptcha. Необязателен: при выключенной капче поля на форме нет
   * вовсе, и заявка уходит с пустым токеном (план §5).
   */
  captchaToken?: string;
  /** Приманка для ботов: поле скрыто от человека и должно уехать пустым. */
  website?: string;
}

const roleRequestOptions = REGISTRATION_ROLE_REQUESTS.map((value) => ({
  value,
  label: registrationRoleRequestLabels[value],
}));

export function RegisterPage() {
  const { message } = App.useApp();
  const [form] = Form.useForm<RegisterFormValues>();
  const [loading, setLoading] = useState(false);
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);
  // Токен капчи одноразовый и живёт минуты: после обработанной попытки отправки он потрачен, и
  // виджет надо сбросить — счётчик меняется, `CaptchaField` по нему перерисовывает чекбокс.
  const [captchaNonce, setCaptchaNonce] = useState(0);
  const captcha = useCaptcha();
  // Вошедшая вкладка форму с капчей не рендерит и уходит в портал полной навигацией (§12).
  const leavingAuthenticated = useLeaveCaptchaPageIfAuthenticated();
  const watchRoleRequest = Form.useWatch('requestedRole', form);
  const watchEmail = Form.useWatch('email', form) ?? '';
  // Объект, отдел или компанию спрашиваем там, где без них заявку не рассмотреть; комментарий, в
  // отличие от них, открыт всем и почти всем необязателен — см. поле ниже.
  const detail = watchRoleRequest ? registrationRequestDetail[watchRoleRequest] : 'none';
  /**
   * Адрес не в домене компании (ADR 0090). Предупреждение, а не запрет: заявку с любого адреса
   * портал принимает — решает по ней всё равно администратор.
   *
   * Смотрим на дописанный адрес: на «ива» в поле предупреждать не о чем. Пока пожелание по роли не
   * выбрано, предупреждение показывается — оно должно попасться на глаза там, где адрес и правят;
   * оператору, работающему от лица сторонней компании, его снимет выбор роли.
   */
  const externalEmail =
    emailSchema.safeParse(watchEmail).success &&
    !isInternalEmail(watchEmail) &&
    (!watchRoleRequest || expectsCorporateEmail(watchRoleRequest));

  const onFinish = async (values: RegisterFormValues) => {
    setLoading(true);
    try {
      await authApi.register({
        email: values.email,
        lastName: values.lastName,
        firstName: values.firstName,
        middleName: values.middleName ?? '',
        phone: values.phone ?? '',
        password: values.password,
        requestedRole: values.requestedRole!,
        requestedObject: values.requestedObject ?? '',
        requestedCompany: values.requestedCompany ?? '',
        requestedComment: values.requestedComment ?? '',
        captchaToken: values.captchaToken ?? '',
        website: values.website,
      });
      setSubmittedEmail(values.email);
    } catch (e) {
      setCaptchaNonce((n) => n + 1);
      /*
       * Ошибку по конкретному полю показываем у поля; общую — сообщением. Отказ проверки сервер
       * возвращает на поле `captchaToken`. Условие про `enabled` — не перестраховка: если поля на
       * форме нет (вкладка успела прочитать «капча выключена», а на сервере уже завели ключи),
       * ошибка у невидимого поля не показалась бы нигде, и отказ выглядел бы молчанием формы.
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
    } finally {
      setLoading(false);
    }
  };

  // Ранний выход строго после всех хуков: порядок вызовов React менять нельзя. Ничего не рисуем —
  // документ через мгновение заменит полная навигация в портал.
  if (leavingAuthenticated) return null;

  if (submittedEmail) {
    return (
      <div style={pageStyle}>
        <Card style={{ width: '100%', maxWidth: 520 }}>
          {/* Отдельный экран, а не всплывающее сообщение: человеку нужно понять, что дальше
              ничего не произойдёт само и войти прямо сейчас он не сможет.
              Подтверждение адреса выключено (EMAIL_VERIFICATION_ENABLED) — про письмо и ссылку
              здесь не говорится: их не будет. */}
          <Result
            status="success"
            title="Заявка на доступ принята"
            subTitle={
              <>
                Заявка с адреса <b>{submittedEmail}</b> ушла администратору. Подтверждать ничего не
                нужно: он рассмотрит её и свяжется с вами по указанному телефону. Войти можно будет,
                когда доступ выдадут.
              </>
            }
            extra={
              /* Полная навигация вместо `navigate('/login')`: документ со сторонним `captcha.js`
                 обязан умереть до того, как человек введёт логин и пароль (§12). */
              <Button type="primary" onClick={goToLogin}>
                Перейти ко входу
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      {/* Карточка держит прежнюю ширину, пока экран её вмещает, и сжимается на телефоне. */}
      <Card style={{ width: '100%', maxWidth: 480 }}>
        <Typography.Title level={3} style={{ textAlign: 'center' }}>
          Регистрация
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
          После регистрации аккаунт будет неактивен до активации администратором.
        </Typography.Paragraph>
        <Form form={form} layout="vertical" onFinish={onFinish} requiredMark={false}>
          <PersonNameFields size="large" autoFocus />
          {/* Пробелы снимаются на вводе, а не при отправке: иначе форма ругалась бы «введите
              корректный email» на адрес, который человек видит верным (`normalizeEmail`). */}
          <Form.Item
            name="email"
            label="Email"
            normalize={normalizeEmail}
            rules={[{ required: true, type: 'email', message: 'Введите корректный email' }]}
          >
            <Input autoComplete="username" size="large" />
          </Form.Item>
          {/* Заявку с чужого адреса форма отправляет как любую другую: правило рекомендательное, и
              отказ формы превратил бы его в запрет — а рабочая почта есть не у всех, кому доступ
              нужен по делу. */}
          {externalEmail ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 24 }}
              title="Указан адрес внешней почтовой службы"
              description={`Заявка с такого адреса рассматривается дольше и может быть отклонена. Если у вас есть рабочая почта в домене ${INTERNAL_EMAIL_DOMAINS.join(', ')} — укажите её.`}
            />
          ) : null}
          {/* Телефон обязателен (ADR 0066): заявку на регистрацию рассматривают звонком — без
              номера администратору некуда обратиться. Требование стоит на форме; схема
              `registerSchema` пустой номер по-прежнему принимает — иначе учётки, заведённые до
              этого правила, стали бы непроходимыми для правки. */}
          <PhoneField size="large" required />
          <PasswordField
            name="password"
            identityFields={['email', 'lastName', 'firstName']}
            size="large"
          />
          {/* Вопрос про человека, а не про таблицу прав портала: список называет должности, и
              своей должностью заявитель себя знает, а «наиболее подходящей ролью» — нет. Роль из
              выбора не назначается — её выбирает администратор при активации (ADR 0034); выбор
              лишь избавляет его от звонка «а вы кто?». */}
          <Form.Item
            name="requestedRole"
            label="Кем вы работаете"
            rules={[{ required: true, message: 'Выберите, кем вы работаете' }]}
            extra="Доступ по этому выбору не выдаётся: роль назначит администратор при активации"
          >
            <AutoSelect options={roleRequestOptions} size="large" />
          </Form.Item>
          {detail === 'object' ? (
            <Form.Item
              name="requestedObject"
              label="Объект"
              rules={[
                { required: true, message: 'Укажите объект' },
                { whitespace: true, message: 'Укажите объект' },
              ]}
              extra="Название или адрес стройки, где вы работаете"
            >
              <Input size="large" maxLength={200} />
            </Form.Item>
          ) : null}
          {/* Отдел пишется в ту же переменную, что и объект: колонка в базе одна — «где вы
              работаете», — и различаются два пожелания только заданным вопросом. Поэтому и
              набранное переживает смену пожелания с объектного на отдельское: стирать его было бы
              то же самое, что стирать поле, которое сам же и заполнил
              (`normalizeRegistrationRequest`). */}
          {detail === 'department' ? (
            <Form.Item
              name="requestedObject"
              label="Отдел"
              rules={[
                { required: true, message: 'Укажите отдел' },
                { whitespace: true, message: 'Укажите отдел' },
              ]}
              extra="Название отдела, в котором вы работаете"
            >
              <Input size="large" maxLength={200} />
            </Form.Item>
          ) : null}
          {detail === 'company' ? (
            <Form.Item
              name="requestedCompany"
              label="Компания"
              rules={[
                { required: true, message: 'Укажите название компании' },
                { whitespace: true, message: 'Укажите название компании' },
              ]}
              extra="Организация, от лица которой вы работаете"
            >
              <Input size="large" maxLength={200} />
            </Form.Item>
          ) : null}
          {/* Комментарий спрашивается у всех и всегда, а не у одного «Другого»: узкой должности —
              системному администратору, сотруднику ИТ-службы, механику — отдельного пожелания в
              перечне нет намеренно, и объясниться она может только здесь. Таблица «кому показывать
              комментарий» была бы правилом, которое придётся вспоминать при каждом новом пожелании.

              Обязателен он ровно там, где `detail === 'comment'`, то есть у «Другого»: этому
              пожеланию не соответствует ни одна роль (`activationDefaultsFor('other').role` —
              `null`), и без объяснения своими словами заявка не содержит ничего, кроме ФИО и
              адреса, а решалась бы звонком — тем самым, ради отмены которого пожелание и заводили.
              Условие берётся из того же `detail`, которым обязательность держит контракт
              (`registrationRequestIssue`): второе его изложение разошлось бы с серверным молча. */}
          <Form.Item
            name="requestedComment"
            label="Комментарий"
            rules={
              detail === 'comment'
                ? [
                    { required: true, message: 'Напишите, кем вы работаете' },
                    { whitespace: true, message: 'Напишите, кем вы работаете' },
                  ]
                : []
            }
            // Подсказка разная не для красоты: у «Другого» комментарий — единственное, по чему
            // заявку вообще можно рассмотреть, а у остальных он объясняет, зачем его писать тому,
            // кто своё пожелание в списке уже нашёл.
            extra={
              detail === 'comment'
                ? 'Кем вы работаете и зачем нужен доступ — по этому администратор подберёт роль'
                : 'Необязательно. Если вашей должности в списке нет — системный администратор, сотрудник ИТ-службы, механик, — напишите её здесь'
            }
          >
            <Input size="large" maxLength={200} />
          </Form.Item>
          {/* Капча — только когда сервер сказал, что она включена. При `disabled` прячем весь
              `Form.Item`: само поле в этом состоянии возвращает `null`, и осталась бы висеть
              подпись «Проверка» над пустым местом. Правило `required` ставится ровно при
              `enabled` — при `loading`/`error` требовать токен не за что, отправку в этих
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
          {/* Honeypot: человек этого поля не видит и не заполнит, простой бот заполнит всё. */}
          <Form.Item name="website" hidden aria-hidden="true">
            <Input tabIndex={-1} autoComplete="off" />
          </Form.Item>
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
            Зарегистрироваться
          </Button>
          <CaptchaSubmitNote captcha={captcha} />
        </Form>
        {/* Обычная ссылка, а не `Link`: переход ко входу должен быть полной навигацией, чтобы
            документ со сторонним `captcha.js` умер до ввода учётных данных (§12). */}
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          Уже есть аккаунт? <a href="/login">Войти</a>
        </div>
      </Card>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: '100dvh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
};

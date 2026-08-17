import { z } from 'zod';
import { optionalPhoneSchema } from './common';
import { emailSchema } from './email';
import type { CounterpartyType } from './counterparties';
import type { RoleAddon } from './role-addons';
import type { Role } from './enums';
import type { Permission } from './permissions';
import { passwordIdentityIssue, passwordSchema } from './password';
import { personNameFields, type PersonNameParts } from './person-name';
import {
  normalizeRegistrationRequest,
  registrationRequestFields,
  registrationRequestIssue,
} from './registration-request';

/** Ответ выдачи капчи: картинка приходит data-URL'ом, разгадка остаётся на сервере. */
export interface CaptchaChallenge {
  /** Подписанный челлендж; возвращается назад в `register`. */
  token: string;
  /** `data:image/png;base64,…` — CSP портала разрешает `img-src data:`. */
  image: string;
  /** Секунды до истечения челленджа. */
  expiresIn: number;
}

export const CAPTCHA_ANSWER_LENGTH = 5;

export const registerSchema = z
  .object({
    email: z.string().email().max(255),
    ...personNameFields,
    /**
     * Телефон — по желанию (ADR 0043): почтовых уведомлений у портала нет, и звонок — единственный
     * способ уточнить заявку, но требовать номер, чтобы завести учётку, не за что.
     */
    phone: optionalPhoneSchema.optional().default(''),
    password: passwordSchema,
    // Кем человек себя назвал и что уточнил (ADR 0034). Роль отсюда не берётся — её назначает
    // администратор; это подсказка ему, а не право.
    ...registrationRequestFields,
    captchaToken: z.string().min(1).max(1000),
    captchaAnswer: z
      .string()
      .trim()
      .length(CAPTCHA_ANSWER_LENGTH, `Введите ${CAPTCHA_ANSWER_LENGTH} цифр с картинки`),
    /**
     * Приманка для ботов: поле скрыто от человека и всегда должно приходить пустым. Названо
     * правдоподобно — автозаполнялки ботов ищут именно такие имена.
     */
    website: z.string().max(0).optional(),
  })
  .superRefine((v, ctx) => {
    const passwordIssue = passwordIdentityIssue(v.password, [v.email, v.lastName, v.firstName]);
    if (passwordIssue) {
      ctx.addIssue({ code: 'custom', message: passwordIssue, path: ['password'] });
    }
    const requestIssue = registrationRequestIssue(v);
    if (requestIssue) {
      ctx.addIssue({ code: 'custom', message: requestIssue.message, path: [requestIssue.field] });
    }
  })
  // Уточнение, которого выбранное пожелание не требует, до базы не доходит.
  .transform(normalizeRegistrationRequest);
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: passwordSchema,
  })
  .superRefine((v, ctx) => {
    if (v.newPassword === v.currentPassword) {
      ctx.addIssue({
        code: 'custom',
        message: 'Новый пароль совпадает с текущим',
        path: ['newPassword'],
      });
    }
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

// ── Подтверждение адреса и восстановление пароля (ADR 0072) ──

/**
 * ВРЕМЕННО ВЫКЛЮЧЕНО (07.08.2026): подтверждение адреса при регистрации (ADR 0072).
 *
 * Почта портала сейчас не отправляет писем (`MAIL_ENABLED=false`), а регистрация без письма
 * отказывала целиком: подтвердить адрес нечем, и заявка не заводилась вовсе. Пока флаг снят,
 * заявка принимается без письма и адрес считается подтверждённым по факту подачи — иначе такую
 * заявку не смог бы активировать администратор, а через неделю её закрыл бы срок хранения
 * неподтверждённых.
 *
 * Флаг общий для сервера и портала: он же убирает страницу подтверждения, экраны и подписи про
 * письмо и колонку «Адрес» в списке учёток. Вернуть проверку — поставить `true`, больше править
 * нечего; выпущенные до отключения ссылки продолжают работать и сейчас.
 */
export const EMAIL_VERIFICATION_ENABLED = false;

/** Токен из ссылки в письме: opaque-строка base64url, портал её не разбирает. */
const emailTokenSchema = z.string().trim().min(16).max(500);

export const verifyEmailSchema = z.object({ token: emailTokenSchema }).strict();
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

/**
 * Повторная отправка письма и запрос сброса пароля устроены одинаково: адрес плюс капча. Капча
 * здесь не от ботов вообще, а от рассылки писем чужим людям — каждый такой запрос отправляет
 * письмо на адрес, который называет не владелец ящика.
 */
const emailWithCaptchaFields = {
  email: emailSchema,
  captchaToken: z.string().min(1).max(1000),
  captchaAnswer: z
    .string()
    .trim()
    .length(CAPTCHA_ANSWER_LENGTH, `Введите ${CAPTCHA_ANSWER_LENGTH} цифр с картинки`),
};

export const resendVerificationSchema = z.object(emailWithCaptchaFields).strict();
export type ResendVerificationInput = z.infer<typeof resendVerificationSchema>;

export const passwordResetRequestSchema = z.object(emailWithCaptchaFields).strict();
export type PasswordResetRequestInput = z.infer<typeof passwordResetRequestSchema>;

/**
 * Новый пароль по ссылке. Текущий пароль не спрашивается — его и не знают, ради этого сценарий и
 * заведён; владение ящиком подтверждает токен. Политика пароля та же, что при регистрации и смене:
 * иначе через восстановление можно было бы поставить пароль, который портал иначе не принимает.
 */
export const passwordResetConfirmSchema = z
  .object({
    token: emailTokenSchema,
    newPassword: passwordSchema,
  })
  .strict();
export type PasswordResetConfirmInput = z.infer<typeof passwordResetConfirmSchema>;

/**
 * Ответ публичных почтовых ручек. Один и тот же для существующего адреса и для незнакомого:
 * различие в ответе превратило бы форму в справочник «кто зарегистрирован в портале».
 */
export const NEUTRAL_MAIL_RESPONSE =
  'Если адрес зарегистрирован в портале, письмо с инструкцией уже отправлено. Проверьте почту, в том числе папку «Спам».';

/** Текущий пользователь (ответ /auth/me и /auth/login). */
export interface AuthUser extends PersonNameParts {
  id: string;
  email: string;
  /** Считается базой из частей ФИО; отдельно не редактируется. */
  fullName: string;
  /**
   * Телефон учётки (ADR 0043), десять цифр или пусто. Порталу он нужен ровно для одного: подставить
   * контакт заявителя в форму заявки на обслуживание, где ФИО и телефон обязательны (план
   * модернизации оргтехники, Р49). Требовать от человека каждый раз набирать собственный номер,
   * зная его, — это и есть та обязательность, из-за которой поля заполняют прочерком.
   */
  phone: string;
  role: Role | null;
  isActive: boolean;
  mustChangePassword: boolean;
  /**
   * Объекты учётки (ADR 0039): область видимости объектной роли. Портал по ним сужает фильтр
   * объекта и подставляет объект в форму заявки; наименования берутся из справочника, который
   * список всё равно грузит.
   */
  constructionObjectIds: string[];
  /** Отделы учётки (ADR 0040): вторая ось области — заполнена вместо объектов, а не вместе. */
  departmentIds: string[];
  /**
   * Площадки отделов учётки (ADR 0062) — производная область: в её пределах роль отдела работает
   * с вывозом мусора наравне со штабом. Отдельным полем, а не вместе с `constructionObjectIds`:
   * прямая привязка правится из карточки учётки, эта — из справочника отделов, и слитые в одно
   * поле они дали бы один ответ на два разных вопроса.
   */
  departmentObjectIds: string[];
  /**
   * Тип контрагента учётки (ADR 0038): у роли внешнего исполнителя он определяет модуль, в
   * котором она работает, поэтому портал спрашивает права по паре «роль + тип», а не по роли.
   */
  counterpartyType: CounterpartyType | null;
  /**
   * Надстройки роли (ADR 0086) — третий источник прав. Портал считает права тем же `can`, что и
   * сервер, и без этого поля он о надстройке не узнал бы вовсе: раздел и кнопки остались бы
   * скрытыми у человека, которому сервер их разрешает.
   */
  addons: RoleAddon[];
  /**
   * **Эффективные права учётки, посчитанные сервером** (ADR 0106, решение 5; план реструктуризации
   * §10.1) — то, что вернёт `permissionsFor` для полного субъекта: роль + тип контрагента +
   * надстройки + назначенные наборы.
   *
   * Зачем поле. До назначаемых полномочий портал выводил права из роли сам: матрица лежит в общем
   * пакете, роль приходит в ответе, и ответы серверного и клиентского `can` совпадали по
   * построению. Со свободной сборкой наборов этого больше нет — состав набора живёт в базе
   * (`grant_permissions`) и заводится в проде, матрица его не знает и знать не должна. Вывести
   * права из роли клиент теперь **не может**, и единственный правильный способ их узнать —
   * спросить сервер. Поэтому список приходит здесь, а не считается на портале.
   *
   * Приходит во **всех четырёх** ответах, устанавливающих или обновляющих сессию: `login`,
   * `refresh`, `/auth/me` и смена пароля (§10.1, таблица «где список прав обязан приходить»).
   * Одного `/auth/me` мало: до него интерфейс уже рисует меню по ответу входа, а `refresh` после
   * `authVersion + 1` обязан обновить пользователя целиком — иначе сервер считает по-новому, а меню
   * остаётся прежним до перезагрузки страницы.
   *
   * Права интерфейса, а не доказательство доступа: решение по запросу сервер по-прежнему принимает
   * сам, на своём субъекте. Список управляет только тем, что человек видит.
   *
   * Порядок — словарный (`PERMISSIONS`), см. сборщик ответа в `routes/auth.ts`.
   */
  permissions: Permission[];
}

export interface LoginResult {
  accessToken: string;
  /** секунды до истечения access-токена */
  expiresIn: number;
  user: AuthUser;
}

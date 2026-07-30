import { z } from 'zod';
import type { Role } from './enums';
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

/** Текущий пользователь (ответ /auth/me и /auth/login). */
export interface AuthUser extends PersonNameParts {
  id: string;
  email: string;
  /** Считается базой из частей ФИО; отдельно не редактируется. */
  fullName: string;
  role: Role | null;
  isActive: boolean;
  mustChangePassword: boolean;
  constructionObjectId: string | null;
}

export interface LoginResult {
  accessToken: string;
  /** секунды до истечения access-токена */
  expiresIn: number;
  user: AuthUser;
}

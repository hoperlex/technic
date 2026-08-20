import type {
  AuthUser,
  CaptchaConfig,
  ChangePasswordInput,
  LoginInput,
  LoginResult,
  PasswordResetConfirmInput,
  PasswordResetRequestInput,
  RegisterInput,
  ResendVerificationInput,
  VerifyEmailInput,
} from '@technic/contracts';
import { apiFetch, clear as clearSession, renewToken, startSession } from '@shared/api';

export const authApi = {
  /**
   * Рантайм-настройка виджета капчи, а не челлендж: сам челлендж теперь целиком у Яндекса, порталу
   * от сервера нужен только клиентский ключ. Ключ приходит запросом, а не вшит в бандл, поэтому его
   * смена не требует пересборки веба, а «включена ли капча» остаётся одним решением сервера — общим
   * и для формы, и для проверки. Без обновления токена: ручку зовёт тот, кто ещё не вошёл.
   */
  captcha(): Promise<CaptchaConfig> {
    return apiFetch('/auth/captcha', { noRefresh: true });
  },

  async login(input: LoginInput): Promise<LoginResult> {
    const result = await apiFetch<LoginResult>('/auth/login', {
      method: 'POST',
      body: input,
      noRefresh: true,
    });
    // Вход — новая сессия: её номер обесценивает обновление токена, начатое предыдущей.
    startSession(result.accessToken);
    return result;
  },

  register(input: RegisterInput): Promise<{ ok: boolean; message: string }> {
    return apiFetch('/auth/register', { method: 'POST', body: input, noRefresh: true });
  },

  /** Подтверждение адреса по ссылке из письма (ADR 0072). */
  verifyEmail(input: VerifyEmailInput): Promise<{ ok: boolean; message: string }> {
    return apiFetch('/auth/verify-email', { method: 'POST', body: input, noRefresh: true });
  },

  resendVerification(input: ResendVerificationInput): Promise<{ ok: boolean; message: string }> {
    return apiFetch('/auth/verify-email/resend', { method: 'POST', body: input, noRefresh: true });
  },

  requestPasswordReset(
    input: PasswordResetRequestInput,
  ): Promise<{ ok: boolean; message: string }> {
    return apiFetch('/auth/password-reset/request', {
      method: 'POST',
      body: input,
      noRefresh: true,
    });
  },

  confirmPasswordReset(
    input: PasswordResetConfirmInput,
  ): Promise<{ ok: boolean; message: string }> {
    return apiFetch('/auth/password-reset/confirm', {
      method: 'POST',
      body: input,
      noRefresh: true,
    });
  },

  me(): Promise<AuthUser> {
    return apiFetch('/auth/me');
  },

  async logout(): Promise<void> {
    await apiFetch('/auth/logout', { method: 'POST', noRefresh: true });
    clearSession();
  },

  async changePassword(input: ChangePasswordInput): Promise<LoginResult> {
    const result = await apiFetch<LoginResult>('/auth/change-password', {
      method: 'POST',
      body: input,
    });
    // Пароль сменил тот же человек: сессия та же, меняется только токен.
    renewToken(result.accessToken);
    return result;
  },
};

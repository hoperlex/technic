import type {
  AuthUser,
  CaptchaChallenge,
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
  /** Новая картинка капчи; челлендж одноразовый, поэтому запрашивается перед каждой отправкой. */
  captcha(): Promise<CaptchaChallenge> {
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

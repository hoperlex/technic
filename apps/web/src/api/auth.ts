import type {
  AuthUser,
  ChangePasswordInput,
  LoginInput,
  LoginResult,
  RegisterInput,
} from '@technic/contracts';
import { apiFetch, setAccessToken } from './client';

export const authApi = {
  async login(input: LoginInput): Promise<LoginResult> {
    const result = await apiFetch<LoginResult>('/auth/login', {
      method: 'POST',
      body: input,
      noRefresh: true,
    });
    setAccessToken(result.accessToken);
    return result;
  },

  register(input: RegisterInput): Promise<{ ok: boolean; message: string }> {
    return apiFetch('/auth/register', { method: 'POST', body: input, noRefresh: true });
  },

  me(): Promise<AuthUser> {
    return apiFetch('/auth/me');
  },

  async logout(): Promise<void> {
    await apiFetch('/auth/logout', { method: 'POST', noRefresh: true });
    setAccessToken(null);
  },

  async changePassword(input: ChangePasswordInput): Promise<LoginResult> {
    const result = await apiFetch<LoginResult>('/auth/change-password', {
      method: 'POST',
      body: input,
    });
    setAccessToken(result.accessToken);
    return result;
  },
};

import { z } from 'zod';
import type { Role } from './enums';

export const registerSchema = z.object({
  email: z.string().email().max(255),
  fullName: z.string().trim().min(2).max(255),
  password: z.string().min(10).max(200),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(10).max(200),
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/** Текущий пользователь (ответ /auth/me и /auth/login). */
export interface AuthUser {
  id: string;
  email: string;
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

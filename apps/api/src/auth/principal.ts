import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { users } from '../db/schema';
import type { Role } from '@technic/contracts';

export interface Principal {
  id: string;
  email: string;
  fullName: string;
  role: Role | null;
  isActive: boolean;
  mustChangePassword: boolean;
  constructionObjectId: string | null;
  authVersion: number;
}

/**
 * Загружает актуального пользователя из БД (не доверяем роли из старого JWT).
 * Возвращает null, если пользователь удалён или деактивирован.
 */
export async function loadPrincipal(userId: string): Promise<Principal | null> {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u || u.deletedAt || !u.isActive) return null;
  return {
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    role: u.role,
    isActive: u.isActive,
    mustChangePassword: u.mustChangePassword,
    constructionObjectId: u.constructionObjectId,
    authVersion: u.authVersion,
  };
}

import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { counterparties, users } from '../db/schema';
import type { AccessSubject, CounterpartyType, Role } from '@technic/contracts';

/** Принципал — субъект доступа (ADR 0038): права спрашиваются у пары «роль + тип контрагента». */
export interface Principal extends AccessSubject {
  id: string;
  email: string;
  lastName: string;
  firstName: string;
  middleName: string;
  /** Считается базой из частей ФИО (ADR 0034). */
  fullName: string;
  role: Role | null;
  isActive: boolean;
  mustChangePassword: boolean;
  constructionObjectId: string | null;
  /** Контрагент учётки (ADR 0010): у внешнего исполнителя задаёт, чьи заявки ему видны. */
  counterpartyId: string | null;
  /**
   * Тип контрагента (ADR 0038): у внешнего исполнителя определяет модуль, в котором он работает,
   * — вывоз мусора у оператора, заказ ТС у арендодателя. Читается из справочника на каждом
   * запросе вместе с ролью: смена типа контрагента меняет права учётки, и кэшировать её в токене
   * нельзя по той же причине, по которой там не хранится роль.
   */
  counterpartyType: CounterpartyType | null;
  authVersion: number;
}

/**
 * Загружает актуального пользователя из БД (не доверяем роли из старого JWT).
 * Возвращает null, если пользователь удалён или деактивирован.
 */
export async function loadPrincipal(userId: string): Promise<Principal | null> {
  const [row] = await db
    .select({ u: users, counterpartyType: counterparties.type })
    .from(users)
    .leftJoin(counterparties, eq(users.counterpartyId, counterparties.id))
    .where(eq(users.id, userId));
  if (!row) return null;
  const u = row.u;
  if (u.deletedAt || !u.isActive) return null;
  return {
    id: u.id,
    email: u.email,
    lastName: u.lastName,
    firstName: u.firstName,
    middleName: u.middleName,
    fullName: u.fullName,
    role: u.role,
    isActive: u.isActive,
    mustChangePassword: u.mustChangePassword,
    constructionObjectId: u.constructionObjectId,
    counterpartyId: u.counterpartyId,
    counterpartyType: row.counterpartyType,
    authVersion: u.authVersion,
  };
}

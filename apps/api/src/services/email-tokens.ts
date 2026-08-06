import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { userEmailTokens } from '../db/schema';
import { randomToken, sha256hex } from '../lib/crypto';

/**
 * Одноразовые ссылки из писем: подтверждение адреса и сброс пароля (ADR 0072).
 *
 * Три правила, ради которых модуль отдельный:
 *
 *  1. В базе живёт только хеш. Значение из ссылки существует ровно в двух местах — в письме и в
 *     адресной строке того, кто его открыл; в логи, аудит и `dedupe_key` письма оно не попадает.
 *  2. Выпуск нового токена гасит прежние живые того же назначения. Иначе «пришлите ссылку ещё раз»
 *     оставляло бы веер действующих ссылок, и достаточно перехватить любую.
 *  3. Погашение — условие обновления, а не проверка в коде: два одновременных перехода по одной
 *     ссылке иначе оба сочли бы токен живым и оба сработали бы.
 */

export type EmailTokenPurpose = (typeof userEmailTokens.purpose.enumValues)[number];

/** Транзакция drizzle: токен выпускается вместе с письмом и бизнес-операцией. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface IssuedToken {
  /** Значение для ссылки в письме. Больше нигде не сохраняется. */
  token: string;
  expiresAt: Date;
}

export async function issueEmailToken(
  input: {
    userId: string;
    purpose: EmailTokenPurpose;
    ttlSeconds: number;
    requestedIp?: string;
  },
  opts: { tx?: Tx } = {},
): Promise<IssuedToken> {
  const runner = opts.tx ?? db;
  const token = randomToken();
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);

  // Прежние живые ссылки того же назначения перестают работать. Помечаются использованными, а не
  // удаляются: по строкам видно, сколько раз человек просил письмо, — это разбор злоупотреблений.
  await runner
    .update(userEmailTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(userEmailTokens.userId, input.userId),
        eq(userEmailTokens.purpose, input.purpose),
        isNull(userEmailTokens.usedAt),
      ),
    );

  await runner.insert(userEmailTokens).values({
    userId: input.userId,
    purpose: input.purpose,
    tokenHash: sha256hex(token),
    expiresAt,
    requestedIp: input.requestedIp ?? '',
  });

  return { token, expiresAt };
}

/**
 * Проверяет ссылку и гасит её. Возвращает учётку, которой токен принадлежал, или `null` —
 * одинаково для несуществующего, просроченного и уже использованного: рассказывать по ответу,
 * какая из ссылок «почти подошла», незачем.
 */
export async function consumeEmailToken(
  token: string,
  purpose: EmailTokenPurpose,
  opts: { tx?: Tx } = {},
): Promise<{ userId: string } | null> {
  const runner = opts.tx ?? db;
  const [row] = await runner
    .update(userEmailTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(userEmailTokens.tokenHash, sha256hex(token)),
        eq(userEmailTokens.purpose, purpose),
        isNull(userEmailTokens.usedAt),
        sql`${userEmailTokens.expiresAt} > now()`,
      ),
    )
    .returning({ userId: userEmailTokens.userId });
  return row ?? null;
}

/** Гасит все живые ссылки назначения: после смены пароля старые письма сброса не должны работать. */
export async function revokeEmailTokens(
  userId: string,
  purpose: EmailTokenPurpose,
  opts: { tx?: Tx } = {},
): Promise<void> {
  await (opts.tx ?? db)
    .update(userEmailTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(userEmailTokens.userId, userId),
        eq(userEmailTokens.purpose, purpose),
        isNull(userEmailTokens.usedAt),
      ),
    );
}

/**
 * Когда этой учётке в последний раз выпускали ссылку такого назначения. По ней троттлится
 * повторная отправка: кнопка «прислать ещё раз» не должна превращаться в рассыльщик по чужому
 * ящику. `null` — не выпускали ни разу.
 */
export async function lastIssuedAt(
  userId: string,
  purpose: EmailTokenPurpose,
): Promise<Date | null> {
  const [row] = await db
    .select({ createdAt: userEmailTokens.createdAt })
    .from(userEmailTokens)
    .where(and(eq(userEmailTokens.userId, userId), eq(userEmailTokens.purpose, purpose)))
    .orderBy(sql`${userEmailTokens.createdAt} DESC`)
    .limit(1);
  return row?.createdAt ?? null;
}

import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../db/client';
import { refreshSessions, users } from '../db/schema';
import { err } from '../lib/errors';
import { randomToken, sha256hex } from '../lib/crypto';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Refresh-сессии: выдача, ротация и отзыв.
 *
 * **Единый порядок блокировок — `users`, потом `refresh_sessions`** (план «Площадки отдела
 * набором», Р12). Смена области доступа поднимает `auth_version` в строке учётки и в той же
 * транзакции гасит её сессии (`revokeAllForUsersTx`), то есть блокирует сначала `users`, потом
 * `refresh_sessions`. Пути выдачи токенов обязаны идти тем же порядком, и вот почему:
 *
 * - **зачем вообще трогать `users`.** Без блокировки учётки ротация и вход не сериализованы со
 *   сменой области: они работают по снимку, в котором учётка ещё старая, и вставляют новую живую
 *   сессию рядом с `UPDATE ... SET revoked_at`, который этой строки уже не видел. Отзыв
 *   отрапортовал бы «все сессии погашены», а человек продолжал бы обновлять токен по сессии,
 *   выданной уже после смены области;
 * - **чем плох обратный порядок.** Взять `FOR SHARE` на учётке «одной строкой», не трогая
 *   остального, нельзя: блокировка легла бы **после** `FOR UPDATE` на строке сессии, то есть в
 *   порядке «сессия → учётка», встречном к порядку смены области. Две транзакции, идущие навстречу,
 *   дожидаются друг друга, PostgreSQL распознаёт взаимную блокировку и снимает её откатом одной из
 *   них — это случайные 500 на входе и обновлении токена вместо честного ожидания. Порядок обязан
 *   быть один на весь модуль, поэтому владелец токена ищется **без** блокировки, учётка берётся
 *   `FOR SHARE` и только затем сессия перечитывается `FOR UPDATE`.
 *
 * `FOR SHARE`, а не `FOR UPDATE`: выдача токенов строку учётки не меняет, ей нужно лишь не дать
 * смене области пройти «сквозь» себя. Разделяемая блокировка пропускает параллельные входы и
 * ротации разных сессий одной учётки и ждёт только того, кто действительно правит учётку.
 */

export interface IssuedRefresh {
  token: string;
  sessionId: string;
  familyId: string;
  expiresAt: Date;
}

/**
 * Первый шаг обоих путей: разделяемая блокировка строки учётки.
 *
 * Строку не читают ради данных — её читают ради блокировки, поэтому в выборке только `id`.
 * Отсутствие строки здесь не отдельная ошибка: учётка либо есть, либо вставка в
 * `refresh_sessions` всё равно упадёт по внешнему ключу — заводить второй ответ на одно и то же
 * состояние незачем.
 */
async function lockUserShared(tx: Tx, userId: string): Promise<void> {
  await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('share');
}

/**
 * Выдача новой сессии — вход и смена пароля.
 *
 * **Зачем здесь транзакция и блокировка учётки, если пишется одна строка.** Вставка сама по себе
 * атомарна, но она конкурирует не с другой вставкой, а со сменой области доступа: та считает
 * список сессий учётки и гасит его. Вход, не бравший строку учётки, вставляет свою сессию мимо
 * этого снимка — и остаётся жить с прежней областью на клиенте. С `FOR SHARE` вход, начавшийся
 * раньше, успевает закоммититься до смены области (и будет ею погашен), а начавшийся позже — ждёт
 * её коммита и создаёт сессию уже после изменения, то есть операция становится линейной. Это
 * не «лишний запрос»: он держит обещание «все refresh-сессии погашены» (Р12 п. 5).
 */
export async function createRefreshSession(
  userId: string,
  ctx: { familyId?: string; ip?: string; userAgent?: string } = {},
): Promise<IssuedRefresh> {
  const token = randomToken(32);
  const tokenHash = sha256hex(token);
  const familyId = ctx.familyId ?? randomUUID();
  const expiresAt = new Date(Date.now() + config.auth.refreshTtl * 1000);
  const sessionId = await db.transaction(async (tx) => {
    await lockUserShared(tx, userId);
    const [row] = await tx
      .insert(refreshSessions)
      .values({ userId, tokenHash, familyId, expiresAt, ip: ctx.ip, userAgent: ctx.userAgent })
      .returning({ id: refreshSessions.id });
    return row!.id;
  });
  return { token, sessionId, familyId, expiresAt };
}

export interface RotationResult {
  token: string;
  sessionId: string;
  userId: string;
  expiresAt: Date;
}

/**
 * Чем закончилась транзакция ротации. Отдельный тип нужен ровно ради одной ветки — reuse: её
 * результат обязан **закоммититься**, а наружу всё равно уходит 401.
 */
type RotationOutcome = { kind: 'rotated'; result: RotationResult } | { kind: 'reused' };

/**
 * Ротация refresh-токена с детекцией повторного использования:
 * если предъявлен уже отозванный токен — отзываем всю семью сессий (§13).
 *
 * Порядок блокировок — `users` → `refresh_sessions` (Р12), см. комментарий в начале файла.
 */
export async function rotateRefreshSession(
  rawToken: string,
  ctx: { ip?: string; userAgent?: string } = {},
): Promise<RotationResult> {
  const tokenHash = sha256hex(rawToken);
  const outcome = await db.transaction<RotationOutcome>(async (tx) => {
    // Шаг 1 и 2 одним запросом: владелец токена ищется без блокировки сессии, а `of users`
    // оставляет разделяемую блокировку только на строке учётки. Именно поэтому здесь join, а не
    // чтение сессии с последующим чтением учётки: строку сессии на этом шаге брать нельзя — она
    // блокируется третьим шагом, после учётки.
    const [owner] = await tx
      .select({ sessionId: refreshSessions.id, userId: users.id })
      .from(refreshSessions)
      .innerJoin(users, eq(users.id, refreshSessions.userId))
      .where(eq(refreshSessions.tokenHash, tokenHash))
      .for('share', { of: users });

    if (!owner) throw err.unauthorized('Недействительный refresh-токен');

    // Шаг 3: перечитать сессию **свежим** запросом под `FOR UPDATE`. Строку из join'а брать нельзя:
    // пока мы ждали блокировку учётки, смена области (или reuse-защита соседнего запроса) могла
    // проставить `revoked_at`, и старый снимок сказал бы, что сессия жива. Ждали мы ровно ради
    // этого — читать после ожидания то, что прочитали до него, значит не брать блокировку вовсе.
    const [session] = await tx
      .select()
      .from(refreshSessions)
      .where(eq(refreshSessions.id, owner.sessionId))
      .for('update');

    if (!session) throw err.unauthorized('Недействительный refresh-токен');

    if (session.revokedAt) {
      // reuse detected — компрометация: отзываем всю семью
      await tx
        .update(refreshSessions)
        .set({ revokedAt: new Date() })
        .where(
          and(eq(refreshSessions.familyId, session.familyId), isNull(refreshSessions.revokedAt)),
        );
      // 401 бросается **снаружи** транзакции. Раньше он стоял здесь, и исключение откатывало
      // отзыв, который сам же и сделал: обещание «предъявили украденный токен — погасили всю
      // семью» не выполнялось ни разу, а по ответу это неотличимо — 401 приходил в обоих случаях.
      // Поэтому ветка возвращает исход, транзакция коммитится, и отказ рождается уже над ней.
      return { kind: 'reused' };
    }

    if (session.expiresAt.getTime() < Date.now()) {
      // Здесь и в отказах выше `throw` внутри транзакции безвреден: они ничего не пишут, и
      // откатывать им нечего — откат лишь снимает разделяемую блокировку учётки.
      throw err.unauthorized('refresh-токен истёк');
    }

    const newToken = randomToken(32);
    const newHash = sha256hex(newToken);
    const expiresAt = new Date(Date.now() + config.auth.refreshTtl * 1000);
    const [next] = await tx
      .insert(refreshSessions)
      .values({
        userId: session.userId,
        tokenHash: newHash,
        familyId: session.familyId,
        expiresAt,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      })
      .returning({ id: refreshSessions.id });
    await tx
      .update(refreshSessions)
      .set({ revokedAt: new Date(), replacedBy: next!.id })
      .where(eq(refreshSessions.id, session.id));

    return {
      kind: 'rotated',
      result: { token: newToken, sessionId: next!.id, userId: session.userId, expiresAt },
    };
  });

  // Наружу сигнатура прежняя: 401 по-прежнему приходит из `rotateRefreshSession`, и вызывающая
  // сторона (`POST /auth/refresh`) о двух исходах не знает — она чистит cookie на любом отказе.
  if (outcome.kind === 'reused') {
    throw err.unauthorized('Повторное использование refresh-токена — сессии отозваны');
  }
  return outcome.result;
}

export async function revokeRefreshByToken(rawToken: string): Promise<void> {
  const tokenHash = sha256hex(rawToken);
  await db
    .update(refreshSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshSessions.tokenHash, tokenHash), isNull(refreshSessions.revokedAt)));
}

/**
 * Отзыв всех сессий учётки **мимо** транзакции — прежний путь: правка учётки, выдача полномочий,
 * смена пароля. Строку учётки он не блокирует, поэтому со входом не сериализован; переводить
 * этих вызывающих на транзакционный отзыв — отдельная работа (Р6 ограничен путём отделов).
 */
export async function revokeAllForUser(userId: string): Promise<void> {
  await db
    .update(refreshSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshSessions.userId, userId), isNull(refreshSessions.revokedAt)));
}

/**
 * Отзыв всех сессий сразу нескольким учёткам **внутри переданной транзакции** (Р6).
 *
 * **Почему в транзакции, а не после коммита.** Отзыв после коммита негарантирован: правка области
 * уже записана, а `UPDATE` по сессиям упал — и живые сессии остались, причём повторный прогон
 * (импорт справочника) изменений больше не увидит и гасить не станет. Обратная сторона верна и
 * желательна: откат транзакции откатывает и отзыв — если правка не состоялась, гасить нечего.
 *
 * **Порядок вызова.** Строки учёток к этому моменту уже должны быть заблокированы правкой
 * (`auth_version + 1`) — сначала `users`, потом `refresh_sessions`, см. комментарий в начале файла.
 * Ротация и вход идут тем же порядком, поэтому встречных блокировок между ними нет.
 *
 * Пустой список — не запрос: `inArray` по пустому набору осмысленного условия не даёт, а гасить
 * нечего.
 */
export async function revokeAllForUsersTx(tx: Tx, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  await tx
    .update(refreshSessions)
    .set({ revokedAt: new Date() })
    .where(and(inArray(refreshSessions.userId, userIds), isNull(refreshSessions.revokedAt)));
}

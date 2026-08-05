import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq, isNull } from 'drizzle-orm';
import {
  type AuthUser,
  type CaptchaChallenge,
  changePasswordSchema,
  type CounterpartyType,
  loginSchema,
  registerSchema,
  type Role,
} from '@technic/contracts';
import { config } from '../config';
import { db } from '../db/client';
import { counterparties, users } from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from '../lib/cookies';
import { hashPassword, verifyPassword } from '../auth/password';
import { issueCaptcha, verifyCaptcha } from '../auth/captcha';
import { signAccessToken } from '../auth/tokens';
import {
  createRefreshSession,
  revokeAllForUser,
  revokeRefreshByToken,
  rotateRefreshSession,
} from '../auth/sessions';
import { loadPrincipal } from '../auth/principal';
import { requirePrincipal } from '../auth/plugin';
import {
  constructionObjectIdsExpr,
  departmentIdsExpr,
  departmentObjectIdsExpr,
} from '../services/user-scopes';
import { assertEmailFree, asEmailConflict } from '../services/user-email';

interface AuthUserSource {
  id: string;
  email: string;
  lastName: string;
  firstName: string;
  middleName: string;
  fullName: string;
  role: Role | null;
  isActive: boolean;
  mustChangePassword: boolean;
  /** Объекты учётки (ADR 0039): по ним портал сужает фильтр объекта и подставляет его в форму. */
  constructionObjectIds: string[];
  /** Отделы учётки (ADR 0040): вторая ось области — вместо объектов, а не вместе с ними. */
  departmentIds: string[];
  /** Площадки отделов (ADR 0062): производная область роли отдела в модуле «Вывоз мусора». */
  departmentObjectIds: string[];
  /** Тип контрагента учётки (ADR 0038): вместе с ролью задаёт права — портал считает их сам. */
  counterpartyType: CounterpartyType | null;
}

function makeAuthUser(u: AuthUserSource): AuthUser {
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
    constructionObjectIds: u.constructionObjectIds,
    departmentIds: u.departmentIds,
    departmentObjectIds: u.departmentObjectIds,
    counterpartyType: u.counterpartyType,
  };
}

/**
 * Учётка вместе с типом её контрагента: права портал считает по паре «роль + тип» (ADR 0038),
 * поэтому вход и смена пароля отдают тип так же, как его отдаёт `loadPrincipal`.
 */
function userWithCounterpartyType() {
  return db
    .select({
      u: users,
      counterpartyType: counterparties.type,
      constructionObjectIds: constructionObjectIdsExpr,
      departmentIds: departmentIdsExpr,
      departmentObjectIds: departmentObjectIdsExpr,
    })
    .from(users)
    .leftJoin(counterparties, eq(users.counterpartyId, counterparties.id));
}

/** Защита cookie-эндпоинтов от CSRF: проверка Origin (при single-origin + SameSite=Strict). */
function assertCookieOrigin(req: FastifyRequest): void {
  if (!config.isProd) return;
  const origin = req.headers.origin;
  if (!origin || origin !== config.publicOrigin) {
    throw err.forbidden('Недопустимый источник запроса');
  }
}

const authRateLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

/**
 * Регистрация ограничена жёстче входа: она создаёт запись и работу администратору, а живой
 * человек заводит учётку один раз. Пять попыток за десять минут с адреса делают перебор кода
 * капчи (1 к 32 768 за попытку) бессмысленным.
 */
const registerRateLimit = { rateLimit: { max: 5, timeWindow: '10 minutes' } };

/** Выдача картинок щедрее: «обновить» нажимают несколько раз подряд, и это нормально. */
const captchaRateLimit = { rateLimit: { max: 20, timeWindow: '1 minute' } };

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const ctx = (req: FastifyRequest) => ({
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });

  r.get('/captcha', { config: captchaRateLimit }, async (): Promise<CaptchaChallenge> => {
    const { token, image, expiresIn } = issueCaptcha();
    return { token, image, expiresIn };
  });

  r.post(
    '/register',
    { schema: { body: registerSchema }, config: registerRateLimit },
    async (req, reply) => {
      const {
        email,
        lastName,
        firstName,
        middleName,
        phone,
        password,
        requestedRole,
        requestedObject,
        requestedCompany,
        captchaToken,
        captchaAnswer,
      } = req.body;
      // Капча проверяется до всего остального — иначе `/register` работал бы справочником
      // «есть ли такой адрес в портале»: 409 на занятый email отличим от успеха.
      verifyCaptcha(captchaToken, captchaAnswer);
      // Хеш считается до транзакции: argon2 занимает сотни миллисекунд, и держать на нём открытую
      // транзакцию незачем.
      const passwordHash = await hashPassword(password);
      let created;
      try {
        created = await db.transaction(async (tx) => {
          // Архивная учётка адрес не занимает (ADR 0063): отказ по заявке иначе закрывал бы
          // человеку повторную регистрацию навсегда.
          await assertEmailFree(tx, email);
          const [row] = await tx
            .insert(users)
            .values({
              email,
              lastName,
              firstName,
              middleName,
              // Телефон — по желанию (ADR 0043): пусто, если человек его не оставил.
              phone,
              passwordHash,
              isActive: false,
              // Роль не назначается: пожелание — подсказка администратору, а не право (ADR 0034).
              requestedRole,
              requestedObject,
              requestedCompany,
            })
            .returning({ id: users.id });
          return row!;
        });
      } catch (e) {
        throw asEmailConflict(e);
      }
      await writeAudit({
        actorUserId: created!.id,
        action: 'user.register',
        entityType: 'user',
        entityId: created!.id,
        metadata: { requestedRole },
      });
      reply.code(201);
      return {
        ok: true,
        message: 'Регистрация принята. Вход будет доступен после активации администратором.',
      };
    },
  );

  r.post('/login', { schema: { body: loginSchema }, config: authRateLimit }, async (req, reply) => {
    const { email, password } = req.body;
    // Ищется действующая учётка: с частичным индексом (ADR 0063) одинаковых адресов в таблице
    // бывает несколько — живой и сколько угодно архивных, — и без фильтра вход мог бы выхватить
    // архивную строку и отказать живому человеку.
    const [row] = await userWithCounterpartyType().where(
      and(eq(users.email, email), isNull(users.deletedAt)),
    );
    const u = row
      ? {
          ...row.u,
          counterpartyType: row.counterpartyType,
          constructionObjectIds: row.constructionObjectIds,
          departmentIds: row.departmentIds,
          departmentObjectIds: row.departmentObjectIds,
        }
      : undefined;
    if (!u) throw err.invalidCredentials();
    const ok = await verifyPassword(u.passwordHash, password);
    if (!ok) throw err.invalidCredentials();
    if (!u.isActive) {
      throw err.inactive('Аккаунт не активирован — обратитесь к администратору');
    }

    const accessToken = await signAccessToken({ sub: u.id, role: u.role, av: u.authVersion });
    const refresh = await createRefreshSession(u.id, ctx(req));
    setRefreshCookie(reply, refresh.token, refresh.expiresAt);
    await writeAudit({
      actorUserId: u.id,
      action: 'auth.login',
      entityType: 'user',
      entityId: u.id,
    });
    return { accessToken, expiresIn: config.auth.accessTtl, user: makeAuthUser(u) };
  });

  r.post('/refresh', { config: authRateLimit }, async (req, reply) => {
    assertCookieOrigin(req);
    const raw = readRefreshCookie(req);
    if (!raw) throw err.unauthorized('Отсутствует refresh-токен');
    let rotated;
    try {
      rotated = await rotateRefreshSession(raw, ctx(req));
    } catch (e) {
      clearRefreshCookie(reply);
      throw e;
    }
    const principal = await loadPrincipal(rotated.userId);
    if (!principal) {
      clearRefreshCookie(reply);
      throw err.unauthorized('Сессия недействительна');
    }
    setRefreshCookie(reply, rotated.token, rotated.expiresAt);
    const accessToken = await signAccessToken({
      sub: principal.id,
      role: principal.role,
      av: principal.authVersion,
    });
    return { accessToken, expiresIn: config.auth.accessTtl, user: makeAuthUser(principal) };
  });

  r.post('/logout', async (req, reply) => {
    assertCookieOrigin(req);
    const raw = readRefreshCookie(req);
    if (raw) await revokeRefreshByToken(raw);
    clearRefreshCookie(reply);
    return { ok: true };
  });

  r.get('/me', { preHandler: [app.authenticate] }, async (req) => {
    return makeAuthUser(requirePrincipal(req));
  });

  r.post(
    '/change-password',
    {
      preHandler: [app.authenticate],
      schema: { body: changePasswordSchema },
      config: authRateLimit,
    },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      const { currentPassword, newPassword } = req.body;
      const [row] = await userWithCounterpartyType().where(eq(users.id, principal.id));
      if (!row) throw err.unauthorized();
      const u = {
        ...row.u,
        counterpartyType: row.counterpartyType,
        constructionObjectIds: row.constructionObjectIds,
        departmentIds: row.departmentIds,
        departmentObjectIds: row.departmentObjectIds,
      };
      const ok = await verifyPassword(u.passwordHash, currentPassword);
      if (!ok)
        throw err.badRequest('Текущий пароль неверен', { currentPassword: 'Неверный пароль' });

      const passwordHash = await hashPassword(newPassword);
      const newAuthVersion = u.authVersion + 1;
      await db
        .update(users)
        .set({
          passwordHash,
          mustChangePassword: false,
          authVersion: newAuthVersion,
          updatedAt: new Date(),
        })
        .where(eq(users.id, u.id));
      await revokeAllForUser(u.id);

      // выдаём свежие токены, чтобы пользователь остался в системе
      const accessToken = await signAccessToken({ sub: u.id, role: u.role, av: newAuthVersion });
      const refresh = await createRefreshSession(u.id, ctx(req));
      setRefreshCookie(reply, refresh.token, refresh.expiresAt);
      await writeAudit({
        actorUserId: u.id,
        action: 'auth.password_change',
        entityType: 'user',
        entityId: u.id,
      });
      return {
        accessToken,
        expiresIn: config.auth.accessTtl,
        user: makeAuthUser({ ...u, mustChangePassword: false }),
      };
    },
  );
}

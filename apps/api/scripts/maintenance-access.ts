import { readFileSync } from 'node:fs';
import pg from 'pg';

/**
 * Доступ административного пути к базе — один на все команды maintenance
 * (план `docs/assignment-periods-plan.md`, решения З3, О1, П7).
 *
 * ЧТО ЗДЕСЬ ЗА ПРАВИЛО. Административные команды (смена режима модуля, теневое сравнение,
 * revalidation, обратный скрипт) ходят в базу **своими** кредами и никогда — прикладными. Порядок
 * один и обратного хода не имеет: `DATABASE_MAINTENANCE_URL`, затем `DATABASE_MIGRATION_URL`.
 * `DATABASE_URL` не подставляется никогда — ни как «запасной», ни как «в dev же всё равно одна
 * роль»: именно так подстановка и переживает переезд в прод, где роли уже разделены.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫМ МОДУЛЕМ. Правило это — граница доступа, а не удобство: вторая его копия
 * разошлась бы с первой молча и ровно в ту сторону, в какую копию правили. Модуль ничего не
 * исполняет и ничего не печатает — его загрузка не должна ни к чему приводить.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Прав, ролей и проверок перехода: физической границей контур становится тогда,
 * когда шаг CI заведёт `technic_maintenance` и раздаст права. Здесь — только «чем открыли» и
 * «видно ли это в выводе».
 */

/** Имя прикладной роли: ею административная дверь не открывается ни при каких кредах (П7). */
export const APP_ROLE = 'technic_app';
/** Роль административного пути. Пока её нет в кластере, guard-триггер управляющей строки дремлет. */
export const MAINTENANCE_ROLE = 'technic_maintenance';

export interface MaintenanceAccess {
  /** Имя переменной, из которой взят URL, — оно попадает в вывод: чем открыта дверь, видно всегда. */
  source: 'DATABASE_MAINTENANCE_URL' | 'DATABASE_MIGRATION_URL';
  url: string;
  /** URL совпал с прикладным байт в байт: разделения доступа на этой площадке нет. */
  sharedWithApp: boolean;
}

/** Кто мы в кластере и заряжена ли граница средствами БД. */
export interface MaintenanceIdentity {
  currentUser: string;
  maintenanceRoleExists: boolean;
}

/** Выбор доступа; нет ни одной своей переменной — отказ, а не молчаливый откат на прикладную. */
export function resolveMaintenanceAccess(): MaintenanceAccess {
  const appUrl = process.env.DATABASE_URL?.trim();
  const maintenance = process.env.DATABASE_MAINTENANCE_URL?.trim();
  const migration = process.env.DATABASE_MIGRATION_URL?.trim();

  const picked = maintenance
    ? ({ source: 'DATABASE_MAINTENANCE_URL', url: maintenance } as const)
    : migration
      ? ({ source: 'DATABASE_MIGRATION_URL', url: migration } as const)
      : undefined;

  if (!picked) {
    throw new Error(
      'Административный путь не ходит прикладными кредами: задайте DATABASE_MAINTENANCE_URL ' +
        '(роль ' +
        MAINTENANCE_ROLE +
        ') или, пока контур не разделён, DATABASE_MIGRATION_URL. ' +
        'DATABASE_URL здесь не используется намеренно — см. П7 плана assignment-periods.',
    );
  }
  return { ...picked, sharedWithApp: appUrl !== undefined && appUrl === picked.url };
}

/**
 * Клиент административного пути. Отдельно от `buildMigrationClient` ровно по одной причине: тот
 * падает обратно на `DATABASE_URL`, а здесь такой откат запрещён. TLS настраивается так же —
 * `sslmode` из URL вычищается (его понимает libpq, а не node-postgres), режим задаётся объектом
 * `ssl` с корневым сертификатом из `PGSSLROOTCERT`.
 */
export function buildMaintenancePool(access: MaintenanceAccess, max = 1): pg.Pool {
  const caPath = process.env.PGSSLROOTCERT;
  const ca = caPath ? readFileSync(caPath, 'utf8') : undefined;
  const url = new URL(access.url);
  url.searchParams.delete('sslmode');
  return new pg.Pool({
    connectionString: url.toString(),
    max,
    ssl: ca ? { ca, rejectUnauthorized: true } : false,
  });
}

export async function readMaintenanceIdentity(pool: pg.Pool): Promise<MaintenanceIdentity> {
  const res = await pool.query<{ current_user: string; has_role: boolean }>(
    'select current_user, (select true from pg_roles where rolname = $1) is not null as has_role',
    [MAINTENANCE_ROLE],
  );
  const row = res.rows[0];
  if (!row) throw new Error('База не ответила на select current_user');
  return { currentUser: row.current_user, maintenanceRoleExists: row.has_role };
}

/** Строка «чем открыто» для вывода команд: переменная, роль и состояние границы в БД. */
export function maintenanceAccessLine(
  access: MaintenanceAccess,
  identity: MaintenanceIdentity,
): string {
  const border = identity.maintenanceRoleExists
    ? `граница БД заряжена (роль ${MAINTENANCE_ROLE} есть)`
    : `граница БД дремлет: роли ${MAINTENANCE_ROLE} в кластере нет, guard-триггер пропускает запись`;
  const shared = access.sharedWithApp ? '; URL СОВПАДАЕТ С ПРИКЛАДНЫМ' : '';
  return `${access.source}, роль ${identity.currentUser}${shared} — ${border}`;
}

import { eq } from 'drizzle-orm';
import { PASSWORD_MIN, splitFullName } from '@technic/contracts';
import { closeDb, db } from './db/client';
import { users } from './db/schema';
import { hashPassword } from './auth/password';

// Одноразовое создание первого администратора (§секция «Standalone auth»).
// Использование: ADMIN_EMAIL=.. ADMIN_PASSWORD=.. [ADMIN_NAME=..] pnpm seed:admin
//
// ADMIN_NAME принимает ФИО одной строкой и остался прежним намеренно: скрипт вызывают из
// runbook'а и docker-compose, и менять там переменную ради трёх полей — ломать чужие сценарии.
// Разбор — общий из контрактов, тот же, что применила к накопленным данным миграция 0055.

async function main(): Promise<void> {
  const email = process.env.ADMIN_EMAIL ?? process.argv[2];
  const password = process.env.ADMIN_PASSWORD ?? process.argv[3];
  const name = splitFullName(process.env.ADMIN_NAME ?? process.argv[4] ?? 'Администратор Портала');

  if (!email || !password) {
    console.error(
      'Использование: ADMIN_EMAIL=.. ADMIN_PASSWORD=.. [ADMIN_NAME=..] pnpm seed:admin',
    );
    process.exit(1);
  }
  // Та же нижняя граница, что и в контрактах: иначе заведённый здесь пароль нельзя было бы
  // подтвердить в форме смены пароля.
  if (password.length < PASSWORD_MIN) {
    console.error(`Пароль должен быть не короче ${PASSWORD_MIN} символов.`);
    process.exit(1);
  }
  if (!name.lastName) {
    console.error('ADMIN_NAME должен содержать хотя бы фамилию.');
    process.exit(1);
  }

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) {
    console.log(`Пользователь ${email} уже существует — пропуск.`);
    return;
  }

  const passwordHash = await hashPassword(password);
  await db.insert(users).values({
    email,
    ...name,
    passwordHash,
    role: 'admin',
    isActive: true,
  });
  console.log(`Администратор ${email} создан.`);
}

main()
  .then(() => closeDb())
  .catch(async (e) => {
    console.error(e);
    await closeDb().catch(() => {});
    process.exit(1);
  });

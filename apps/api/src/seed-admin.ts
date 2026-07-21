import { eq } from 'drizzle-orm';
import { closeDb, db } from './db/client';
import { users } from './db/schema';
import { hashPassword } from './auth/password';

// Одноразовое создание первого администратора (§секция «Standalone auth»).
// Использование: ADMIN_EMAIL=.. ADMIN_PASSWORD=.. [ADMIN_NAME=..] pnpm seed:admin

async function main(): Promise<void> {
  const email = process.env.ADMIN_EMAIL ?? process.argv[2];
  const password = process.env.ADMIN_PASSWORD ?? process.argv[3];
  const fullName = process.env.ADMIN_NAME ?? process.argv[4] ?? 'Администратор';

  if (!email || !password) {
    console.error('Использование: ADMIN_EMAIL=.. ADMIN_PASSWORD=.. [ADMIN_NAME=..] pnpm seed:admin');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Пароль должен быть не короче 8 символов.');
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
    fullName,
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

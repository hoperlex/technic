# Портал строительной компании — Этап 1

Корпоративный портал: заявки на вывоз мусора, справочники, администрирование. Построен по корпоративному стандарту v3.1 (single-VPS). Полный план: `~/.claude/plans/magical-petting-ripple.md`.

## Стек

- **Backend**: Node.js 24 · TypeScript · Fastify 5 · Drizzle ORM · pg · jose · @node-rs/argon2 · zod · pino
- **Frontend**: React 19 · Ant Design 6 · Vite 8 · TanStack Query · react-router 7
- **БД**: Yandex Managed PostgreSQL (TLS verify-full)
- **Файлы**: cloud.ru Evolution Object Storage (S3, presigned URL)

## Структура

```text
apps/web            React SPA (Vite + antd 6)
apps/api            Fastify REST API + миграции + seed
apps/worker         Фоновые задачи (PostgreSQL jobs, S3 cleanup)
packages/contracts  Общие zod-схемы и типы API
deploy              Dockerfile'ы, docker-compose, nginx
docs                runbook, схема БД, setup Yandex/cloud.ru
```

## Быстрый старт (dev)

Требуется Node ≥ 22.12 и pnpm 9. Локальная БД PostgreSQL и S3-совместимое хранилище (MinIO) — см. `deploy/docker-compose.dev.yml`.

```bash
pnpm install
cp .env.example .env            # заполнить значения
pnpm db:migrate                 # применить SQL-миграции
pnpm seed:admin                 # создать первого администратора
pnpm dev                        # api + worker + web параллельно
```

## Роли

- **Администратор** — всё + Пользователи, аудит, восстановление.
- **Менеджер** — заявки + Справочники (Объекты, Типы контейнеров).
- **Диспетчер** — заявки всех объектов + смена статусов.
- **Штаб** — заявки только своего объекта; создание/правка/удаление в статусе «Новая».

Регистрация — самостоятельная; аккаунт неактивен до активации администратором.

## Безопасность

- Секреты — в host env-файле вне docker-образа и вне git (`.env`, `.env.*` в `.gitignore`).
- Собственная авторизация: access-JWT (Ed25519) + opaque refresh с ротацией и reuse detection.
- Файлы — presigned URL напрямую в cloud.ru; backend генерирует object key.

Подробности деплоя и эксплуатации — в `docs/`.

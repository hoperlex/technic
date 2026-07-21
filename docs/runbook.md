# Runbook (эксплуатация, этап 1)

## Деплой (§19)

Образы собираются в CI и публикуются в Yandex Container Registry (не собираются на VPS).

```bash
# 1. deployment lock (например, файл-флаг или CI-lock)
# 2. preflight: проверить доступность БД, наличие /etc/technic-portal/prod.env и certs
# 3. миграции (отдельный шаг, one-off):
docker compose -p technic-portal --profile tools run --rm migrate
# 4. обновить API:
docker compose -p technic-portal up -d api
# 5. health check:
curl -fsS http://127.0.0.1:8080/api/v1/health/ready
# 6. обновить worker и web:
docker compose -p technic-portal up -d worker web
# 7. smoke-тесты (логин, список заявок)
# 8. deployment report (тег образа, коммит, миграции, время)
```

Первый администратор (однократно):

```bash
docker compose -p technic-portal --profile tools run --rm \
  -e ADMIN_EMAIL=admin@company.ru -e ADMIN_PASSWORD='<strong>' migrate \
  pnpm --filter @technic/api seed:admin
```

## Startup checks (§25)

API при старте падает с понятной ошибкой, если: нет обязательных env/секретов, есть placeholder (`CHANGE_ME`) в проде, некорректен `DATABASE_URL`/TLS, нет S3-креденшелов или ключей JWT, недоступна БД.

## Backup / restore

- **PostgreSQL**: включить автобэкапы + PITR в Yandex Managed. Регулярно проверять восстановление в тестовую БД (`pg_restore`/PITR).
- **Секреты**: `/etc/technic-portal/prod.env` и `certs/` — в защищённом секрет-хранилище (Yandex Lockbox), с процедурой восстановления.
- **S3**: файлы в cloud.ru; при необходимости — версионирование/репликация бакета.

## Мониторинг и алерты (§20–22)

- Логи — pino JSON с redaction; отправка в Yandex Cloud Logging.
- Health: `/api/v1/health/live`, `/api/v1/health/ready`, метрики — `/api/v1/metrics`.
- Обязательные алерты: недоступность VPS/nginx/api, ошибки подключения к PostgreSQL, БД у лимита соединений, рост 5xx, `jobs` в статусе `dead`, ошибки S3, истечение TLS, падение деплоя, аномалии логина (rate-limit), изменения ролей (audit).

## Частые операции

```bash
# Логи сервисов
docker compose -p technic-portal logs -f api
docker compose -p technic-portal logs -f worker

# Перезапуск только API (portal-scoped, не трогает другие проекты)
docker compose -p technic-portal restart api

# Просмотр застрявших задач
psql "$DATABASE_URL" -c "select id,type,status,attempts,last_error from jobs where status in ('failed','dead') order by updated_at desc limit 50;"

# Ручной повтор dead-задачи
psql "$DATABASE_URL" -c "update jobs set status='pending', attempts=0, next_run_at=now() where id='<id>';"
```

> Запрещены глобальные destructive-команды (`docker system prune -a`, `down --volumes`) — на VPS есть другие проекты.

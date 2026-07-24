# Runbook (эксплуатация)

Прод: VPS `89.232.188.170`, каталог `/opt/portals/technic`, compose-проект **`technic`**,
публичный URL **https://auto.su10.ru**. Edge: контейнер `infra-nginx` + vhost
`/opt/infra/nginx/conf.d/technic.conf`. Секреты: `/etc/technic-portal/prod.env`
(вне git). На VPS есть другие проекты — не трогать их compose/vhost и не запускать
глобальные destructive-команды.

## Деплой (`deploy-auto`)

Штатный деплой — одной командой `deploy-auto` (из любого каталога VPS; симлинк в
`/usr/local/bin`, скрипт — `deploy/deploy-auto.sh`). Делает: `git pull` ветки **main**
(с проверкой `HEAD == origin/main`) → сборку `technic-*:<sha>` → бэкап БД перед миграциями →
авто-накат новых миграций → `up -d` → health-гейт `:latest`. Portal-scoped: соседние
порталы/`infra-nginx` не трогает, `docker rmi` — только по whitelist `technic-*`, без
`docker system prune -a`/`down --volumes`.

```bash
deploy-auto                 # обычный деплой (main): pull → build → миграции → up → health
deploy-auto --skip-migrate  # деплой кода без наката миграций (даже если есть pending)
deploy-auto --previous      # быстрый откат кода на предыдущий SHA (без пересборки); схему НЕ трогает
deploy-auto --restore-db    # восстановление БД из последнего дампа (destructive, TTY-подтверждение)
deploy-auto --status        # read-only: релизы, образы, статус миграций, бэкапы, диск
deploy-auto --no-prune      # без чистки образов/кэша (ротация бэкапов — всегда)
```

**Git-流:** деплоится только ветка **main**; перед деплоем код должен быть в `origin/main`
(скрипт откажет при ветке ≠ main или `HEAD ≠ origin/main` → `git checkout main` + push).

**Бэкапы (keep-2):** перед накатом миграций — `pg_dump -Fc` в
`/var/lib/technic/deploy/db-backups` (2 последних `<utc>-<sha>.dump` + `.meta`, плюс 1
аварийный `prerestore-*`); снимок `prod.env`+CA+vhost в `config-backups` (2 последних).
Ротация идёт всегда, даже при `--no-prune`. Бэкапы содержат ПДн/секреты — каталоги 700/600.

**Откат:** `--previous` возвращает прошлый код без пересборки, но схему НЕ откатывает;
согласованный откат — `deploy-auto --previous --restore-db`. Важно: `pg_restore --clean`
не гарантирует полный откат схемы (объекты новее дампа могут остаться) — authoritative
schema-откат — **Yandex Managed PG PITR** (метку времени печатает `--restore-db`). Отсюда
правило: **миграции backwards-compatible** — после применённых миграций/`up -d` скрипт
авто-отката кода НЕ делает.

### One-time setup (однократно на VPS)

```bash
sudo ln -sfn /opt/portals/technic/deploy/deploy-auto.sh /usr/local/bin/deploy-auto
# каталоги /var/lib/technic/... скрипт создаёт сам (sudo install при первом запуске)
```

`prod.env` должен быть **root:docker 0640**: владелец `corpsu` (в группе docker) обязан его
читать — это нужно и compose `env_file`, и снимку конфига. Значение из `.env.example`
(root:root 0600) устарело — канонично **0640 root:docker**.

### Ручной путь (fallback, если `deploy-auto` недоступен)

```bash
cd /opt/portals/technic
docker compose -f deploy/docker-compose.yml -p technic --profile tools run --rm migrate
docker compose -f deploy/docker-compose.yml -p technic up -d --force-recreate technic-api
docker compose -f deploy/docker-compose.yml -p technic up -d technic-worker technic-web
docker exec technic-api node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
curl -fsSI https://auto.su10.ru/
```

Edge-vhost (только при смене домена/TLS):

```bash
sudo cp deploy/nginx/technic.conf /opt/infra/nginx/conf.d/technic.conf
docker exec infra-nginx nginx -t && docker exec infra-nginx nginx -s reload
```

Первый администратор (однократно):

```bash
docker compose -f deploy/docker-compose.yml -p technic --profile tools run --rm \
  -e ADMIN_EMAIL=admin@company.ru -e ADMIN_PASSWORD='<strong>' seed
```

## Startup checks

API при старте падает с понятной ошибкой, если: нет обязательных env/секретов, есть
placeholder (`CHANGE_ME`) в проде, некорректен `DATABASE_URL`/TLS, нет S3-креденшелов
или ключей JWT, недоступна БД.

При старте `technic-api` и `technic-worker` пишут строку `S3 конфигурация`
(`endpoint/region/bucket/forcePathStyle`, без секретов) — по ней видно, если runtime
взял не тот bucket/endpoint.

## Загрузка файлов (S3 / CORS)

Файлы грузятся **напрямую в cloud.ru** по presigned PUT: браузер (origin `https://auto.su10.ru`)
делает PUT на `*.s3.cloud.ru`. **nginx и Fastify в этом запросе не участвуют** — preflight (OPTIONS)
обрабатывает cloud.ru. Поэтому CORS настраивается **на бакете** (`docs/setup-infra.md §3`), а не в
nginx/Fastify. Архитектуру на проксирование файлов через API не менять — файлы до 50 МБ идут прямо в S3.

Симптом `No 'Access-Control-Allow-Origin' header` при загрузке — обычно одно из:

1. presigned URL содержит `x-amz-checksum-crc32` / `x-amz-sdk-checksum-algorithm` (авто-checksum AWS SDK) —
   **исправлено в коде** (`apps/api/src/lib/s3-client.ts`); убедиться, что задеплоена свежая версия;
2. на бакете нет/некорректна CORS-политика — настроить (`aws s3api put-bucket-cors`, см. setup-infra §3);
3. runtime использует не тот bucket/endpoint (напр. `auto`) — проверить env (ниже).

### Проверка runtime-окружения (без секретов)

```bash
docker exec technic-api sh -lc \
  'env | grep -E "^(PUBLIC_ORIGIN|S3_ENDPOINT|S3_REGION|S3_BUCKET|S3_FORCE_PATH_STYLE)="'
```

Если `S3_BUCKET` не ожидаемый (напр. `auto` вместо `technic-portal-files`) — поправить
`/etc/technic-portal/prod.env`. **Изменение `prod.env` требует пересоздания контейнеров**
(restart/reload не перечитывает `env_file`):

```bash
docker compose -f deploy/docker-compose.yml -p technic up -d --force-recreate technic-api technic-worker
```

### Проверка preflight (CORS) напрямую к бакету

`$UPLOAD_URL` — presigned PUT из ответа `POST /api/v1/files/upload-session`:

```bash
curl -i -X OPTIONS "$UPLOAD_URL" \
  -H 'Origin: https://auto.su10.ru' \
  -H 'Access-Control-Request-Method: PUT' \
  -H 'Access-Control-Request-Headers: content-type'
```

Ожидаемый ответ (`200`/`204`) содержит:

- `Access-Control-Allow-Origin: https://auto.su10.ru`
- `Access-Control-Allow-Methods: PUT` (или список с PUT)
- `Access-Control-Allow-Headers: content-type` (или `*` на этапе диагностики)
- `Access-Control-Max-Age: 3000`

Нет этих заголовков → проблема на бакете (CORS), а не в приложении.

## Backup / restore

- **PostgreSQL**: автобэкапы + PITR в Yandex Managed; периодически проверять restore.
- **Секреты**: `/etc/technic-portal/prod.env` и `certs/` — в защищённом хранилище.
- **S3**: файлы в cloud.ru; при необходимости — версионирование/репликация бакета.

## Мониторинг и алерты

- Логи — pino JSON с redaction.
- Health API: `/health/live`, `/health/ready` (на контейнере `technic-api:3000`).
- Обязательные алерты: недоступность VPS/`infra-nginx`/api, ошибки PostgreSQL,
  лимит соединений, рост 5xx, `jobs` в `dead`, ошибки S3, истечение TLS,
  аномалии логина, изменения ролей (audit).

## Частые операции

```bash
cd /opt/portals/technic

docker compose -f deploy/docker-compose.yml -p technic logs -f technic-api
docker compose -f deploy/docker-compose.yml -p technic logs -f technic-worker

# Перезапуск API без смены env (portal-scoped)
docker compose -f deploy/docker-compose.yml -p technic restart technic-api

# После правки /etc/technic-portal/prod.env:
docker compose -f deploy/docker-compose.yml -p technic up -d --force-recreate technic-api technic-worker
```

```bash
psql "$DATABASE_URL" -c "select id,type,status,attempts,last_error from jobs where status in ('failed','dead') order by updated_at desc limit 50;"
psql "$DATABASE_URL" -c "update jobs set status='pending', attempts=0, next_run_at=now() where id='<id>';"
```

> Запрещены `docker system prune -a`, `down --volumes` и правки чужих файлов в
> `/opt/infra/nginx/conf.d/` (кроме `technic.conf`).

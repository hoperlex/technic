# Настройка инфраструктуры (этап 1)

## 1. Секреты и ключи

Секреты хранятся в host env-файле вне git и docker-образа: `/etc/technic-portal/prod.env` (`root:docker`, `0640`). Шаблон — `.env.example` в корне репозитория.

### Ed25519-ключи для access-JWT

```bash
openssl genpkey -algorithm ed25519 -out jwt_private.pem
openssl pkey -in jwt_private.pem -pubout -out jwt_public.pem
```

`JWT_PRIVATE_KEY_PEM` (только у api) и `JWT_PUBLIC_KEY_PEM` — inline PEM (с `\n`) или путь к файлу. Секреты `COOKIE_SECRET`, `CSRF_SECRET` — случайные ≥32 байт (`openssl rand -base64 32`).

## 2. Yandex Managed PostgreSQL (§7, §8)

1. Создать кластер и БД `technic_portal`.
2. Пользователи:
   - `technic_runtime` — обычные права (DML), **без DDL**;
   - `technic_migration` — с DDL (DDL применяется только migrate-шагом).
3. Включить расширения ДО миграций (SQL-миграции их не создают):
   ```sql
   CREATE EXTENSION IF NOT EXISTS pgcrypto;
   CREATE EXTENSION IF NOT EXISTS citext;
   CREATE EXTENSION IF NOT EXISTS pg_trgm;
   ```
4. TLS: скачать Yandex CA и смонтировать read-only в `/etc/technic-portal/certs/yandex-root.crt`; в `DATABASE_URL` — `sslmode=verify-full`, в env — `PGSSLROOTCERT`.
5. Порт `6432`, доступ только из сети backend-VPS.

### Connection budget (§7)

`runtime_instance_count = 1`. Пулы: api `DB_POOL_MAX=10`, worker `WORKER_DB_POOL_MAX=4`.

```
conn_limit(technic_runtime)  >= api.pool.max + worker.pool.max + reserve = 10 + 4 + 4 = 18
conn_limit(technic_migration) — небольшой (миграции one-off), напр. 4
```

Пересчитывать при добавлении инстансов/воркеров и с учётом соседних проектов на кластере.

## 3. cloud.ru Evolution Object Storage (§15)

- Endpoint `https://s3.cloud.ru`, region `ru-central-1`, **virtual-hosted-style** (`S3_FORCE_PATH_STYLE=false`).
- Имя бакета — DNS-совместимое (нижний регистр, без точек), напр. `technic-portal-files`.
- Приватный бакет, SSE, отдельный IAM AK/SK минимальных прав (`S3_ACCESS_KEY_ID` в формате `<tenant_id>:<key_id>`).
- **CORS на бакете** (браузер грузит файлы напрямую по presigned PUT):
  ```json
  {
    "CORSRules": [
      {
        "AllowedOrigins": ["https://auto.su10.ru"],
        "AllowedMethods": ["PUT", "GET", "HEAD"],
        "AllowedHeaders": ["content-type"],
        "ExposeHeaders": ["ETag"],
        "MaxAgeSeconds": 3000
      }
    ]
  }
  ```
- CSP на edge-nginx должен разрешать `connect-src https://s3.cloud.ru https://*.s3.cloud.ru` (см. `deploy/nginx/technic.conf`).

## 4. Edge-nginx (`infra-nginx`)

На VPS edge — общий Docker-контейнер **`infra-nginx`** (сеть `edge`, порты 80/443).
Отдельный host-nginx для technic не поднимаем. Vhost кладётся только в
`/opt/infra/nginx/conf.d/technic.conf` (шаблон — `deploy/nginx/technic.conf`;
краткий пример — `deploy/nginx/portal.conf.example`).

- TLS termination в `infra-nginx`; certs — `/opt/infra/nginx/certbot/conf` (`infra-certbot`, webroot).
- `proxy_pass` на `technic-web:80` через Docker DNS (`resolver 127.0.0.11`), не на `127.0.0.1`.
- Контейнеры technic host-ports не публикуют; соседние vhost в `conf.d/` не трогать.
- Публичный origin: `https://auto.su10.ru` (`PUBLIC_ORIGIN` в `/etc/technic-portal/prod.env`).

## 5. Локальная разработка

```bash
docker compose -f deploy/docker-compose.dev.yml -p technic-dev up -d   # postgres + minio
cp .env.example .env
# для dev: DATABASE_URL=postgres://technic:technic@localhost:5432/technic_portal (без sslmode),
# S3_ENDPOINT=http://localhost:9000, S3_FORCE_PATH_STYLE=true (MinIO требует path-style),
# создать бакет в MinIO и настроить CORS на origin http://localhost:5173
pnpm install
pnpm db:migrate
ADMIN_EMAIL=admin@example.ru ADMIN_PASSWORD=changeme123 pnpm seed:admin
pnpm dev
```

> Примечание по версиям: пины пакетов соответствуют утверждённому базису mid-2026
> (React 19.2.7, antd 6.5.1, Vite 8.1.5, TS 6.0.3, Fastify 5.10.0, Drizzle 0.45.2 и т.д.).
> Установка выполняется в окружении с соответствующим состоянием npm-реестра.

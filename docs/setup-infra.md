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

- Endpoint `https://s3.cloud.ru`, region `ru-central-1`, **path-style** (`S3_FORCE_PATH_STYLE=true`).
  ⚠️ **Virtual-hosted-style на cloud.ru не работает.** Любой запрос к `https://<bucket>.s3.cloud.ru/...`
  возвращает `403 AccessDenied` — и подписанный PUT/GET, и анонимный CORS-preflight (OPTIONS), причём
  без `Access-Control-*` заголовков, поэтому браузер показывает это как ошибку CORS при верных правилах
  бакета. Тот же ключ и та же подпись на `https://s3.cloud.ru/<bucket>/...` дают `200`.
  Симптом в DevTools: URL загрузки вида `https://<bucket>.s3.cloud.ru/...` → в env `S3_FORCE_PATH_STYLE=false`.
- Имя бакета — DNS-совместимое (нижний регистр, без точек).
  При старте API/worker пишут `S3 конфигурация` в лог — см. runbook.
- Приватный бакет, SSE, отдельный IAM AK/SK минимальных прав (`S3_ACCESS_KEY_ID` в формате `<tenant_id>:<key_id>`).
  **Бакет остаётся приватным** — CORS не делает объекты публичными и **не заменяет IAM и подпись URL** (presigned).

### CORS — на самом бакете cloud.ru (не в nginx и не в Fastify)

Браузер грузит файлы **напрямую** по presigned PUT в `s3.cloud.ru`, поэтому preflight (OPTIONS)
обрабатывает **cloud.ru**, а не наш nginx/Fastify. Добавлять CORS в nginx/Fastify бессмысленно —
их в этом запросе нет. CORS настраивается **на бакете**:

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://auto.su10.ru"],
      "AllowedMethods": ["PUT", "GET", "HEAD"],
      "AllowedHeaders": ["content-type"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3600
    }
  ]
}
```

- `AllowedHeaders: ["content-type"]` достаточно: авто-checksum отключён, поэтому браузер шлёт только
  `Content-Type`. Presigned URL **не должен содержать** `x-amz-checksum-crc32` /
  `x-amz-sdk-checksum-algorithm` — это чинится в коде
  (`requestChecksumCalculation/responseChecksumValidation: 'WHEN_REQUIRED'`,
  см. `apps/api/src/lib/s3-client.ts`), иначе браузер шлёт лишние `x-amz-*` заголовки и preflight падает.
- Верные правила CORS **не спасают при virtual-hosted-style**: cloud.ru отвечает `403` на preflight ещё
  до применения правил. Если preflight падает, сначала проверь `S3_FORCE_PATH_STYLE=true` (см. выше).

Команды (aws-cli; креды бакета — через переменные окружения, не в командной строке):

```bash
export AWS_ACCESS_KEY_ID='<tenant_id>:<key_id>'
export AWS_SECRET_ACCESS_KEY='<secret>'
export AWS_DEFAULT_REGION='ru-central-1'
export S3_BUCKET='<bucket>'

# Текущая CORS-политика бакета
aws s3api get-bucket-cors --endpoint-url https://s3.cloud.ru --bucket "$S3_BUCKET"

# Установить/обновить CORS-политику (cors.json — JSON выше)
aws s3api put-bucket-cors --endpoint-url https://s3.cloud.ru --bucket "$S3_BUCKET" \
  --cors-configuration file://cors.json
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

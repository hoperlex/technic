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

- CSP на edge-nginx должен разрешать `connect-src https://s3.cloud.ru https://*.s3.cloud.ru`
  и `https://suggestions.dadata.ru` (подсказки адресов, ADR 0006) — см. `deploy/nginx/technic.conf`.
  Домена нет в `connect-src` → браузер режет запрос, подсказки не работают, заявку на
  грузоперевозку создать нельзя.
- Там же `frame-src` должен разрешать `blob:` — бланк путевого листа показывается фреймом из
  памяти вкладки (ADR 0041). Схемы нет в `frame-src` → фрейм режется, окно печати пустое, хотя
  выгрузка того же бланка файлом работает: скачивание CSP не проверяет.

## 4. Edge-nginx (`infra-nginx`)

На VPS edge — общий Docker-контейнер **`infra-nginx`** (сеть `edge`, порты 80/443).
Отдельный host-nginx для technic не поднимаем. Vhost кладётся только в
`/opt/infra/nginx/conf.d/technic.conf` (шаблон — `deploy/nginx/technic.conf`;
краткий пример — `deploy/nginx/portal.conf.example`).

- TLS termination в `infra-nginx`; certs — `/opt/infra/nginx/certbot/conf` (`infra-certbot`, webroot).
- `proxy_pass` на `technic-web:80` через Docker DNS (`resolver 127.0.0.11`), не на `127.0.0.1`.
- Контейнеры technic host-ports не публикуют; соседние vhost в `conf.d/` не трогать.
- Публичный origin: `https://auto.su10.ru` (`PUBLIC_ORIGIN` в `/etc/technic-portal/prod.env`).

## 5. Почта

Портал говорит с провайдером по SMTP, а не по его HTTP API: смена провайдера должна быть правкой
`env`, а не правкой кода. Этим и пользуемся — сейчас отправка идёт через корпоративный ящик Яндекса,
переход на транзакционный сервис возможен без единой правки кода.

### 5.0 Текущий вариант: корпоративный ящик Яндекс 360

Отправитель — **`kamaev.l.a@su10.ru`**, домен `su10.ru` обслуживается Яндекс 360
(`MX mx.yandex.net`). DNS для него уже настроен: SPF корня ведёт на `_spf.yandex.net`, DKIM-подпись
Яндекса стоит в `mail._domainkey.su10.ru`. Не хватает только DMARC — его добавляют отдельной
записью (см. 5.1).

```dotenv
MAIL_ENABLED=true
MAIL_TRANSPORT=smtp
SMTP_HOST=smtp.yandex.ru
SMTP_PORT=465
SMTP_SECURE=true                 # 465 — implicit TLS; для 587 было бы false
SMTP_USER=kamaev.l.a@su10.ru
SMTP_PASSWORD=                   # пароль приложения из Яндекс ID, не пароль от учётной записи
MAIL_FROM="Портал Техник <kamaev.l.a@su10.ru>"
MAIL_REPLY_TO=kamaev.l.a@su10.ru
MAIL_MAX_PER_MINUTE=20
```

Что важно знать про этот вариант:

- **`MAIL_FROM` обязан содержать адрес самого ящика.** Яндекс отвергает письма с чужим `From`
  ответом 550. Worker предупреждает об этом в логе при старте, но проверить стоит заранее.
- **Пароль приложения, а не обычный.** Яндекс ID → Безопасность → Пароли приложений → «Почта».
  Обычный пароль SMTP не примет, тем более при двухфакторной аутентификации.
- **Лимит — до 3000 писем в сутки с ящика**, получателей у одного письма не больше 300. Портал шлёт
  каждому своё письмо, так что упереться можно только числом писем: рассылка заданий на сотню
  водителей плюс сводки — это сотни писем в день, и запас есть, но он не бесконечный.
  `MAIL_MAX_PER_MINUTE=20` держит темп заведомо ниже порога, за которым Яндекс начинает считать
  отправку подозрительной.
- **Письма уходят от живого человека.** В подписи стоит портал, но адрес отправителя личный: ответы
  водителей придут ему, а в папке «Отправленные» этих писем не будет — SMTP туда не кладёт.
- **Это временное решение.** Массовая рассылка с корпоративного ящика — повод для Яндекса
  ограничить его; при росте объёма надо возвращаться к транзакционному сервису (5.2).

### 5.2 Отложенный вариант: транзакционный smtp.bz

Домен отправителя тогда — **`auto.su10.ru`**, тот же, на котором живёт портал.

#### DNS для smtp.bz

Панель провайдера называет записи относительно своего домена, а панель хостинга обычно редактирует
зону корневого `su10.ru`. Путать их нельзя — DKIM, подписанный для одного домена, для другого не
проверится:

| Имя у провайдера    | Имя в зоне `su10.ru`     | Тип   | Значение                                          |
| ------------------- | ------------------------ | ----- | ------------------------------------------------- |
| `smtpbz._domainkey` | `smtpbz._domainkey.auto` | TXT   | `v=DKIM1; k=rsa; p=…` — ключ выдаёт панель        |
| `@`                 | `auto`                   | TXT   | `v=spf1 a mx include:spf.smtp.bz ~all`            |
| `_dmarc`            | `_dmarc.auto`            | TXT   | `v=DMARC1; p=none; rua=mailto:postmaster@su10.ru` |
| `stats`             | `stats.auto`             | CNAME | `smtp.bz.`                                        |

- **SPF пишется на поддомен, а не в корень.** SPF не наследуется: запись на `su10.ru` ничего не
  говорит об отправке с `auto.su10.ru`, и трогать корневую запись (там почта компании) не нужно.
- **Одна SPF-запись на имя.** Если у `auto` уже есть TXT со `v=spf1`, новую не добавляют, а
  дописывают `include:spf.smtp.bz` в существующую: две записи дают `permerror`, и отбиваться
  начинает вся почта имени.
- **DMARC начинается с `p=none`.** Через пару недель отчётов `rua` политику ужесточают до
  `p=quarantine`; жёсткая политика на непроверенной настройке отправит в спам свои же письма.
- Записи расходятся до 24 часов, повторная проверка в панели — через 30–90 минут. Пока панель не
  показала их найденными, `MAIL_ENABLED` держится в `false`.

#### Где именно править: masterhost

Зона `su10.ru` живёт на `ns.masterhost.ru` / `ns1` / `ns2`, поддомен `auto` — обычная A-запись
внутри неё (отдельной зоны у поддомена нет). Значит все четыре записи добавляются в редакторе DNS
домена `su10.ru`: панель masterhost → Домены → `su10.ru` → редактор DNS-зоны.

Masterhost ждёт **короткое имя относительно зоны** — без `.su10.ru` на конце:

| Поле «Имя» в панели      | Тип   | Значение                                          |
| ------------------------ | ----- | ------------------------------------------------- |
| `smtpbz._domainkey.auto` | TXT   | `v=DKIM1; k=rsa; p=…` (ключ из панели smtp.bz)    |
| `auto`                   | TXT   | `v=spf1 a mx include:spf.smtp.bz ~all`            |
| `_dmarc.auto`            | TXT   | `v=DMARC1; p=none; rua=mailto:postmaster@su10.ru` |
| `stats.auto`             | CNAME | `smtp.bz.` — точка на конце обязательна           |

Три ошибки, на которых это ломается чаще всего:

- **`@` вместо `auto` в поле имени SPF.** У корня `su10.ru` уже есть SPF почты Яндекса
  (`v=spf1 redirect=_spf.yandex.net`). Вторая SPF-запись на том же имени даёт `permerror`, и
  отбиваться начинает вся почта компании, а не только рассылка портала.
- **Домен, дописанный руками.** `smtpbz._domainkey.auto.su10.ru` в поле короткого имени превратится
  в `…auto.su10.ru.su10.ru`. Либо короткое имя, либо полное с точкой на конце.
- **Домен, добавленный в smtp.bz, не тот.** В панели провайдера должен стоять `auto.su10.ru`. Если
  там `su10.ru`, проверка ищет записи в корне — а SPF в корень класть нельзя из-за Яндекса; тогда
  корневую запись пришлось бы объединять: `v=spf1 include:_spf.yandex.net include:spf.smtp.bz ~all`
  вместо `redirect`.

Разбивать значения на части в кавычках не нужно: самое длинное (DKIM) — 234 символа, а предел одной
строки TXT — 255.

Проверка записей с сервера:

```bash
dig +short TXT smtpbz._domainkey.auto.su10.ru
dig +short TXT auto.su10.ru        # ровно одна строка со v=spf1
dig +short TXT _dmarc.auto.su10.ru
```

#### Настройки в панели провайдера

- **трекинг открытий и подмену ссылок выключить.** При включённой подмене все ссылки письма
  переписываются на домен трекера — и одноразовый токен из письма сброса пароля проходит через
  чужой редиректор и оседает в его логах. Заданиям водителям трекинг тоже не нужен: ссылок в них
  нет вовсе;
- узнать лимит тарифа по частоте отправки и записать его с запасом в `MAIL_MAX_PER_MINUTE`:
  рассылка заданий уходит на сотню с лишним адресов разом.

#### Переменные окружения smtp.bz

Заполняются в `/etc/technic-portal/prod.env` (полный список с пояснениями — в `.env.example`):

```dotenv
MAIL_ENABLED=true
MAIL_TRANSPORT=smtp
SMTP_HOST=connect.smtp.bz     # хост, порт и логин — из личного кабинета провайдера
SMTP_PORT=587                 # 587 — STARTTLS; 465 — implicit TLS, тогда SMTP_SECURE=true
SMTP_SECURE=false
SMTP_USER=
SMTP_PASSWORD=                # SMTP-ключ провайдера; секрет, в git не коммитится
MAIL_FROM="Портал Техник <no-reply@auto.su10.ru>"
MAIL_MAX_PER_MINUTE=60
MAIL_SCHEDULER_TIMEZONE=Europe/Moscow
```

`MAIL_ENABLED=true` вместе с `MAIL_TRANSPORT=smtp` требует заполненных `SMTP_HOST`, `SMTP_USER`,
`SMTP_PASSWORD` и `MAIL_FROM` — иначе API и worker не поднимутся с понятной ошибкой. Так и
задумано: половина настройки хуже выключенной почты, потому что портал принял бы регистрацию,
которую невозможно подтвердить.

Локально почта работает без провайдера: `MAIL_ENABLED=true` и `MAIL_TRANSPORT=log` — письма
составляются и остаются в журнале `mail_messages`, наружу ничего не уходит.

### 5.3 Приёмка

Письмо, отправленное на рабочий ящик, должно прийти во «Входящие», а не в спам, и в его исходных
заголовках стоять `dkim=pass`, `spf=pass`, `dmarc=pass`. Диагностика очереди — в `docs/runbook.md`.

## 6. Локальная разработка

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

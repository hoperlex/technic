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
авто-накат новых миграций → `up -d` → health-гейт `:latest` → наполнение справочника водителей,
если рядом с секретами лежит кадровая выгрузка (см. ниже). Portal-scoped: соседние
порталы/`infra-nginx` не трогает, `docker rmi` — только по whitelist `technic-*`, без
`docker system prune -a`/`down --volumes`.

```bash
deploy-auto                 # обычный деплой (main): pull → build → миграции → up → health
deploy-auto --skip-migrate  # деплой кода без наката миграций (даже если есть pending)
deploy-auto --skip-seed-drivers  # не наполнять справочник водителей, даже если выгрузка лежит
deploy-auto --previous      # быстрый откат кода на предыдущий SHA (без пересборки); схему НЕ трогает
deploy-auto --restore-db    # восстановление БД из последнего дампа (destructive, TTY-подтверждение)
deploy-auto --status        # read-only: релизы, образы, статус миграций, бэкапы, диск
deploy-auto --no-prune      # без чистки образов/кэша (ротация бэкапов — всегда)
```

**Git-流:** деплоится только ветка **main**; перед деплоем код должен быть в `origin/main`
(скрипт откажет при ветке ≠ main или `HEAD ≠ origin/main` → `git checkout main` + push).

**Обновление самого скрипта:** `deploy-auto` стоит симлинком в рабочее дерево и пуллит сам
себя, поэтому после pull он перезапускается новой версией и продолжает деплой ею — правки в
`deploy/deploy-auto.sh` вступают в силу тем же деплоем. Без перезапуска запущенный bash дочитывал
бы старый файл через открытый дескриптор (git обновляет файл заменой inode), и деплой, привёзший
новый шаг, шёл бы по предыдущей версии — молча, без единой ошибки в выводе.

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

### Разовый шаг: перенос истории в маршруты (ADR 0050)

Маршруты («Заказ ТС» → вкладка «Маршруты») выкатываются двумя релизами, и между ними нужен ручной
прогон. Порядок обязателен: миграция `0074` начинается предохранителем и **прервёт деплой**, если
история не перенесена (схема при этом не пострадает — падение происходит до первого изменения).

```bash
# 1. Релиз с миграцией 0072 уже выкачен (таблицы рейсов, waybills.route_id nullable).
docker compose -p technic exec api pnpm backfill:routes --check   # отчёт, база не меняется
# 2. Разобрать блокирующие пункты отчёта:
#    · заявки сразу в нескольких действующих листах — аннулировать лишний бланк в журнале;
#    · заявка и на действующем листе без рейса, и уже в рейсе — аннулировать лист либо вынуть её.
docker compose -p technic exec api pnpm backfill:routes           # перенос: рейс на пару «машина + дата»
docker compose -p technic exec api pnpm backfill:routes --check   # «Листов без рейса: 0»
docker compose -p technic exec api pnpm backfill:routes --clear-orphan-drivers
#    ↑ обнуляет водителей в назначениях, где рейса не бывает (аренда, спецтехника): без этого
#      предохранитель миграции 0074 тоже не пропустит.
# 3. Только теперь деплой релиза с миграцией 0074 (NOT NULL, «один лист на рейс», снятие
#    старого UNIQUE, удаление driver_person_id у назначений).
```

Если релиз с `0074` уже в `main`, а перенос не сделан — деплойте `deploy-auto --skip-migrate`,
прогоните шаги выше и повторите обычный `deploy-auto`. Скрипт переноса идемпотентен: повторный
запуск ничего не дублирует.

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

Edge-vhost. `deploy-auto` сам сверяет `/opt/infra/nginx/conf.d/technic.conf` с
`deploy/nginx/technic.conf` и раскатывает расхождение (бэкап → `nginx -t` → graceful
reload); результат — в логе деплоя и в поле `vhost_sync` отчёта, состояние на сейчас
показывает `deploy-auto --status`. Вручную нужно только если синхронизация вернула
`manual`/`blocked`/`rejected` (нет sudo, нет контейнера, конфиг не проходит `nginx -t`):

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
делает PUT на `https://s3.cloud.ru/<bucket>/<key>`. **nginx и Fastify в этом запросе не участвуют** —
preflight (OPTIONS) обрабатывает cloud.ru. Поэтому CORS настраивается **на бакете**
(`docs/setup-infra.md §3`), а не в nginx/Fastify. Архитектуру на проксирование файлов через API
не менять — файлы до 50 МБ идут прямо в S3.

Симптом `No 'Access-Control-Allow-Origin' header` при загрузке — обычно одно из:

1. **`S3_FORCE_PATH_STYLE=false`** → URL вида `https://<bucket>.s3.cloud.ru/...`. cloud.ru отдаёт на такой
   host `403 AccessDenied` вообще на всё, включая preflight, и **без** `Access-Control-*` заголовков —
   браузер показывает это как ошибку CORS, хотя политика бакета корректна. Поставить `true` (см. env ниже);
2. presigned URL содержит `x-amz-checksum-crc32` / `x-amz-sdk-checksum-algorithm` (авто-checksum AWS SDK) —
   **исправлено в коде** (`apps/api/src/lib/s3-client.ts`); убедиться, что задеплоена свежая версия;
3. на бакете нет/некорректна CORS-политика — настроить (`aws s3api put-bucket-cors`, см. setup-infra §3);
4. runtime использует не тот bucket/endpoint — проверить env (ниже).

Отличить (1) от (3) можно за один запрос: preflight на path-style URL отвечает `200` + CORS-заголовками,
на virtual-hosted — `403` без них (см. «Проверка preflight» ниже).

### Проверка runtime-окружения (без секретов)

```bash
docker exec technic-api sh -lc \
  'env | grep -E "^(PUBLIC_ORIGIN|S3_ENDPOINT|S3_REGION|S3_BUCKET|S3_FORCE_PATH_STYLE)="'
```

`S3_FORCE_PATH_STYLE` должен быть `true`. Если значения не совпадают с ожидаемыми — поправить
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
- `Access-Control-Allow-Headers: content-type`
- `Access-Control-Max-Age: 3600`

`403 AccessDenied` без `Access-Control-*` и с host `<bucket>.s3.cloud.ru` → virtual-hosted-style,
чинится `S3_FORCE_PATH_STYLE=true`. Ответ без CORS-заголовков на **path-style** URL → проблема
в CORS-политике бакета, а не в приложении.

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

## Наполнение справочника водителей

Кадровая выгрузка приезжает JSON-файлом и в git не попадает: ФИО, дата рождения и СНИЛС живых
людей в репозитории не хранятся (ADR 0037 п. 12–13).

**Обычный путь — портал, доступ к серверу не нужен** (ADR 0047). Справочники → Водители →
**Загрузить выгрузку**: портал разбирает файл и показывает, кого заведёт (база при этом не
меняется), заведение — вторым шагом. Право то же, что у заведения водителя руками
(`drivers.write`). Ошибка в файле объясняется дословно — «Петров Пётр: СНИЛС … не проходит
проверку контрольной суммы», — и чинится в самом файле. Формат файла, разбор отчёта и частые
отказы — в [инструкции](guide-staff-import.md).

Ниже — путь через сервер: им наполняют стенд, где портала ещё нет или админ ещё не заведён.
Файл кладут рядом с `prod.env`, и дальше его забирает деплой.

Порядок такой: **положили выгрузку → `deploy-auto`**. После health деплой видит файл, заводит
людей и затирает его через `shred`. Персональные данные лежат на диске VPS ровно один деплой;
следующие запуски файла уже не находят и шаг пропускают. Проверить, ждёт ли выгрузка своего
деплоя, — `deploy-auto --status`, раздел «водители».

```bash
# 1. Файл на VPS — теми же правами, что и секреты
sudo install -m 0640 -o root -g docker drivers.json /etc/technic-portal/drivers.json

# 2. (по желанию) Разбор и отчёт без записи: СНИЛС с контрольной суммой, даты, категории
cd /opt/portals/technic
docker compose -f deploy/docker-compose.yml -p technic --profile tools \
  run --rm seed-drivers pnpm --filter @technic/api seed:drivers --dry-run

# 3. Деплой заведёт водителей и затрёт файл
deploy-auto
```

Провал наполнения деплой не роняет и не откатывает: код к этому моменту выкачен и здоров, а
выгрузка остаётся на месте — чините причину (чаще всего это неизвестные категории или СНИЛС,
не проходящий контрольную сумму) и запускайте `deploy-auto` снова. Статус шага пишется в отчёт
деплоя полем `seed_drivers` (`done` / `done-not-shredded` / `failed` / `skipped` / `no-file`) —
без ФИО и без числа заведённых.

Заливка вручную, когда деплой запускать не нужно (повторный запуск ничего не дублирует — ключ
человека СНИЛС; файл после этого затирают сами):

```bash
cd /opt/portals/technic
docker compose -f deploy/docker-compose.yml -p technic --profile tools run --rm seed-drivers
sudo shred -u /etc/technic-portal/drivers.json
```

Отключить шаг на один деплой — `deploy-auto --skip-seed-drivers` (файл при этом останется на
диске вместе с персональными данными).

Оба пути — портал и скрипт — заводят человека одним и тем же кодом: физлицо, специализацию
«Водитель», трудовое отношение и удостоверение с категориями. Серия, номер и сроки удостоверения
в кадровой выгрузке отсутствуют — они остаются
пустыми, документ помечен `unverified`. Такой водитель в отбор под машину попадает (пустой срок
отбор читает как бессрочный), но графа «номер удостоверения» в путевом листе печатается пустой.
Реквизиты вносит администратор в карточке водителя: **Добавить удостоверение** с настоящими
данными, затем **Аннулировать** временное — иначе человек покажется в списке выбора дважды.

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

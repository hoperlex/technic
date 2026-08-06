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

### Реквизиты организации в шапке путевого листа

Основную организацию заводит миграция `0075` (АО «Служба механизации», по шапке бланков 4-П и
№ 3) — без неё выдача листа отвечает «Не заведена организация-владелец транспорта». Экрана у
справочника юрлиц пока нет (бэклог ADR 0037), поэтому реквизиты правятся SQL — через тот же
`db-tools`, которым ходит в базу `deploy-auto` (URL раскрывается внутри контейнера, секрета в
`argv` нет):

```bash
docker compose -f deploy/docker-compose.yml -p technic run --rm db-tools sh -c \
  'psql "${DATABASE_MIGRATION_URL:-$DATABASE_URL}"'
```

```sql
select name, address, phone, okpo, ogrn, inn from organizations where is_primary;
update organizations set inn = '<10 или 12 цифр>', updated_at = now() where is_primary;
```

Правка меняет шапку **будущих** листов: выданные печатаются из своего снимка `waybills.data` и
задним числом не переписываются (ADR 0037 п. 10).

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
  аномалии логина, изменения ролей (audit), письма в `mail_messages.failed`.

## Почта: очередь и разбор жалоб «письмо не пришло»

Письмо составляет API и кладёт в `mail_messages` вместе с задачей `send_email` — одной транзакцией.
Отправляет `technic-worker`: он же ограничивает частоту (`MAIL_MAX_PER_MINUTE`) и проставляет
результат. Тело письма хранится готовым, поэтому повтор отправляет ровно то, что было составлено.

Состояния письма: `pending` — ждёт очереди, `sent` — принято SMTP-сервером (в `sent_at` время, в
`provider_id` идентификатор у провайдера), `failed` — не уйдёт уже никогда.

```bash
# Что не отправлено прямо сейчас и почему
psql "$DATABASE_URL" -c "select kind, status, to_email, subject, last_error, created_at
  from mail_messages where status <> 'sent' order by created_at desc limit 20;"

# Письма конкретному человеку — первый вопрос при «мне ничего не приходило»
psql "$DATABASE_URL" -c "select kind, status, sent_at, provider_id, last_error
  from mail_messages where to_email = 'ivanov@example.ru' order by created_at desc limit 20;"

# Очередь отправки: задачи, которые ещё не выполнены
psql "$DATABASE_URL" -c "select status, count(*) from jobs where type = 'send_email' group by 1;"
```

Что означают состояния и что делать:

- **`pending` дольше нескольких минут, задача `pending` с далёким `next_run_at`** — упёрлись в
  потолок отправки: рассылка растянута во времени намеренно. Проверить `MAIL_MAX_PER_MINUTE` против
  тарифа провайдера.
- **`pending`, а задач `send_email` нет вовсе** — почта выключена (`MAIL_ENABLED=false`) либо worker
  не поднялся. Письма дождутся включения: задача откладывается, а не тратит попытки.
- **`failed` с текстом ответа SMTP 5xx** — окончательный отказ: адрес не существует, домен не
  принимает почту, отправитель отвергнут. Повторять бессмысленно, надо чинить адрес: у водителя — в
  карточке справочника, у пользователя — в его учётке.
- **`failed` после исчерпания попыток** — временные отказы не кончились: смотреть `last_error` и
  доступность провайдера.
- **письмо `sent`, но человек его не видит** — искать в спаме и проверять DNS домена отправителя
  (`docs/setup-infra.md`, п. 5.1): просроченный или отсутствующий DKIM/SPF выглядит именно так.

Секретов в журнале нет: тела auth-писем содержат ссылку с одноразовым токеном, поэтому доступ к
содержимому писем даётся отдельно от обычного администрирования, а в логи тело не пишется.

**Проверить доставку руками.** Администрирование → **Рассылки** → «Отладочная отправка»: тип
письма и получатель из числа действующих администраторов (право `mailings.manage`). Письмо уходит
по-настоящему — с пометкой `[ТЕСТ]` в теме и недействительными ссылками, — но помечено `is_test` и
в статистику запусков не попадает. Каждая отправка пишется в аудит как `mailing.test_sent`. Этим и
проверяется боевая настройка после правки DNS или смены SMTP-провайдера:

```bash
# Отладочные письма за сутки: что отправляли и чем кончилось
psql "$DATABASE_URL" -c "select kind, to_email, status, last_error, created_at from mail_messages
  where is_test and created_at > now() - interval '1 day' order by created_at desc;"
```

## Рассылки по расписанию

Расписания заводит администратор: **Администрирование → Рассылки** (право `mailings.manage`).
Часы держит `technic-worker`: раз в минуту (`MAILING_TICK_INTERVAL_MS`) он спрашивает у API, чьё
время наступило, и просит выполнить запуск — сборка письма живёт в API, где есть права и область
видимости получателя (ADR 0075).

Для этого worker'у нужны две переменные в `/etc/technic-portal/prod.env`: `INTERNAL_API_TOKEN`
(общий секрет, одинаковый у API и worker) и `INTERNAL_API_URL` (по умолчанию
`http://technic-api:3000`). Без токена планировщик молчит, а `/internal/mail/*` отвечает `401`.
Наружу этот префикс не проксируется — во фронтовом nginx стоит явный `return 404`.

Что важно знать при разборе:

- **Двойной рассылки не бывает** даже при двух worker'ах: запуск уникален парой
  «расписание + назначенное время», второй экземпляр получает отказ и не делает ничего.
- **Повтор запуска безопасен**: ключ письма включает идентификатор запуска, поэтому повторное
  выполнение не создаёт новых писем. Упавшую рассылку можно просто выполнить заново.
- **Границы данных зафиксированы** в самом запуске (`period_start`/`period_end`) — повтор возьмёт те
  же дни, а не пересчитает окно от момента повтора.
- **Статистика запуска** показывает не только отправленное: `withoutEmail` — водители с рейсами, но
  без адреса (пробел справочника), `excluded` — исключённые администратором, `empty` — те, у кого
  после вычета исключённых дат рейсов не осталось.

```bash
# Что и когда сработает дальше
psql "$DATABASE_URL" -c "select name, type, is_enabled, send_at, next_run_at
  from mailing_schedules order by next_run_at nulls last;"

# История запусков с итогами
psql "$DATABASE_URL" -c "select planned_at, status, is_manual, stats, error
  from mailing_runs order by created_at desc limit 20;"

# Письма конкретного запуска
psql "$DATABASE_URL" -c "select to_email, status, sent_at, last_error
  from mail_messages where mailing_run_id = '<uuid>' order by created_at;"
```

Если рассылка не ушла: сперва `mailing_runs` (создан ли запуск и в каком он статусе), затем
`mail_messages` того же запуска (составлены ли письма), затем очередь `jobs` типа `send_email`.
Пустой `next_run_at` у включённого расписания означает, что срабатывать больше нечему — например все
дни выполнения попали в исключения.

### Ролевые сводки

Сводка (`role_digest`) собирается каждому получателю своя: разделы одни и те же, а строки в них —
только те, что человек видит в портале под собой (ADR 0078). Роль в расписании отвечает лишь на
вопрос «кому отправлять».

- **Получатель обязан иметь подтверждённый адрес** — иначе он в рассылку не попадает вовсе.
- **Пустая сводка не отправляется** и считается в статистике запуска как `empty`: если эта цифра
  равна числу получателей, значит рассылка настроена на роль, которой нечего показать.
- **Разделы путевых листов и рейсов** уходят только тем, у кого нет привязки к площадкам и отделам:
  у этих модулей в портале нет объектной области видимости, сузить их нечем.
- Период — предыдущий полный день (у ежедневной) или предыдущая полная неделя понедельник–воскресенье
  (у недельной), а не «последние сутки».

```bash
# Кому ушла сводка последнего запуска и сколько разделов в ней было
psql "$DATABASE_URL" -c "select to_email, status, subject from mail_messages
  where kind = 'role_digest' and mailing_run_id = '<uuid>' order by created_at;"
```

## Подтверждение адреса при регистрации

Заявка на регистрацию заводится неподтверждённой, и письмо со ссылкой уходит в той же транзакции
(ADR 0072). Пока адрес не подтверждён, активация отклоняется — администратор видит это в колонке
«Адрес» списка пользователей.

- Ссылка подтверждения живёт `MAIL_VERIFY_TTL_SECONDS` (сутки), ссылка сброса пароля —
  `MAIL_RESET_TTL_SECONDS` (час). Оба значения в `/etc/technic-portal/prod.env`.
- Повторное письмо человек запрашивает сам на `/verify-email`: не чаще одного на учётку за пять
  минут и пяти запросов с адреса за десять.
- Заявка, не подтверждённая за `MAIL_REGISTRATION_EXPIRY_DAYS` (по умолчанию 7 дней), уходит в
  архив — адрес освобождается, и человек регистрируется заново. Ноль и меньше выключают закрытие.
- Ручного обхода подтверждения нет. Если письмо до человека не доходит, учётку заводит
  администратор — такая считается подтверждённой по факту создания.
- При `MAIL_ENABLED=false` саморегистрация отвечает `503`: заявку, которую невозможно подтвердить,
  портал не заводит.

```bash
# Заявки, ждущие подтверждения адреса
psql "$DATABASE_URL" -c "select email, created_at from users
  where deleted_at is null and role is null and email_verified_at is null order by created_at;"

# Ушло ли письмо конкретному человеку и что ответил SMTP
psql "$DATABASE_URL" -c "select kind, status, sent_at, last_error from mail_messages
  where to_email = 'ivanov@example.ru' order by created_at desc limit 5;"
```

## Срок хранения отклонённых заявок на регистрацию

`technic-worker` раз в час (`WORKER_CLEANUP_INTERVAL_MS`) сносит из архива учётки, которым отказали
в регистрации: те, что лежат в архиве дольше срока, без роли и неактивны (ADR 0063). Учётки
работавших сотрудников уборка не трогает — их держат внешние ключи, и срока хранения у них нет.

- `USER_REJECTED_REGISTRATION_TTL_DAYS` в `/etc/technic-portal/prod.env` — срок в днях, по
  умолчанию **7**. Ноль и меньше выключают уборку.
- Пока отказ в архиве, его можно вернуть в очередь: карточка учётки → **Восстановить** (право
  `archive.restore`). После уборки восстанавливать нечего.
- След остаётся в журнале: `user.purge_expired` с адресом и сроком, без актора — удалил срок, а не
  человек. Ручное удаление администратором пишется как `user.purge`.

```bash
# Сколько заявок ждёт уборки прямо сейчас
psql "$DATABASE_URL" -c "select count(*) from users where deleted_at < now() - interval '7 days' and role is null and is_active = false;"
```

## Наполнение справочника водителей

Кадровая выгрузка приезжает JSON-файлом и в git не попадает: ФИО, дата рождения и СНИЛС живых
людей в репозитории не хранятся (ADR 0037 п. 12–13).

**Наполняют только из портала, доступ к серверу не нужен** (ADR 0047). Справочники → Водители →
**Загрузить выгрузку**: портал разбирает файл и показывает, кого заведёт (база при этом не
меняется), заведение — вторым шагом. Право то же, что у заведения водителя руками
(`drivers.write`). Ошибка в файле объясняется дословно — «Петров Пётр: СНИЛС … не проходит
проверку контрольной суммы», — и чинится в самом файле. Формат файла, разбор отчёта и частые
отказы — в [инструкции](guide-staff-import.md).

Пути через сервер нет: файл на VPS не кладут, деплой справочник не наполняет и `seed:drivers`
больше не существует. Повторная загрузка того же файла ничего не дублирует — ключ человека
СНИЛС, заведённые пропускаются.

Загрузка заводит физлицо, специализацию «Водитель», трудовое отношение и удостоверение с
категориями. Серия, номер и сроки удостоверения в кадровой выгрузке отсутствуют — они остаются
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

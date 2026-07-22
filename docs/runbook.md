# Runbook (эксплуатация)

Прод: VPS `89.232.188.170`, каталог `/opt/portals/technic`, compose-проект **`technic`**,
публичный URL **https://auto.su10.ru**. Edge: контейнер `infra-nginx` + vhost
`/opt/infra/nginx/conf.d/technic.conf`. Секреты: `/etc/technic-portal/prod.env`
(вне git). На VPS есть другие проекты — не трогать их compose/vhost и не запускать
глобальные destructive-команды.

## Деплой

Сейчас образы собираются на VPS (`technic-api|web|worker:latest`). При появлении
реестра достаточно задать `TAG` и `image:` из registry — команды те же.

```bash
cd /opt/portals/technic

# 1. preflight: /etc/technic-portal/prod.env, certs, DNS auto.su10.ru
# 2. (при обновлении кода) синхронизировать дерево / собрать образы
# 3. миграции (one-off):
docker compose -f deploy/docker-compose.yml -p technic --profile tools run --rm migrate

# 4. обновить сервисы (после правки prod.env — --force-recreate, иначе env не подхватится):
docker compose -f deploy/docker-compose.yml -p technic up -d --force-recreate technic-api
docker compose -f deploy/docker-compose.yml -p technic up -d technic-worker technic-web

# 5. health (внутри api; снаружи /health не проксируется web-nginx):
docker exec technic-api node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
curl -fsSI https://auto.su10.ru/

# 6. smoke: логин, список заявок
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

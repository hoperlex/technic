#!/usr/bin/env bash
#
# deploy-auto — деплой/обновление портала technic (auto.su10.ru), build-on-VPS.
# Portal-scoped: НЕ трогает соседние порталы (zakupki/estimat/billhub/keycloak)
# и общие ресурсы. Исключение — СВОЙ vhost /opt/infra/nginx/conf.d/technic.conf:
# он синхронизируется с deploy/nginx/technic.conf и сопровождается graceful reload
# infra-nginx (соседние vhost при этом не изменяются).
#
# Ставится симлинком и работает из ЛЮБОГО каталога:
#   sudo ln -sfn /opt/portals/technic/deploy/deploy-auto.sh /usr/local/bin/deploy-auto
#
#   deploy-auto                     git pull(main) + сборка + авто-накат миграций + health
#   deploy-auto --skip-migrate      деплой кода без наката миграций (даже если есть pending)
#   deploy-auto --skip-seed-drivers не наполнять справочник водителей, даже если выгрузка лежит
#   deploy-auto --previous          откат кода на предыдущий SHA (без пересборки); схему НЕ трогает
#   deploy-auto --restore-db[=файл] восстановление БД из дампа (destructive, требует TTY)
#   deploy-auto --previous --restore-db[=файл]  согласованный откат кода и БД
#   deploy-auto --status            read-only сводка
#   deploy-auto --no-prune          без чистки образов/BuildKit-кэша (ротация бэкапов — всегда)
#
# Запускать от владельца портала (corpsu) или от root: от root скрипт сам
# перезапустится от владельца, иначе образы и state стали бы root-owned.
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Пути. Всё якорится на реальном расположении скрипта (readlink -f), а не на cwd —
# именно это, а не сам симлинк, позволяет запускать команду из любого каталога.
# ---------------------------------------------------------------------------
SCRIPT="$(readlink -f "$0")"
PORTAL_DIR="$(cd "$(dirname "$SCRIPT")/.." && pwd)"
# Путь скрипта внутри репозитория — им проверяется, обновил ли pull сам deploy-auto (см. ниже).
# Если скрипт стоит копией вне дерева портала, префикс не снимется и SCRIPT_REL останется
# абсолютным: такая установка самообновления не получает, и проверку ниже надо пропустить.
SCRIPT_REL="${SCRIPT#"$PORTAL_DIR"/}"
COMPOSE_FILE="$PORTAL_DIR/deploy/docker-compose.yml"
COMPOSE=(docker compose -f "$COMPOSE_FILE" -p technic)

STATE_DIR="${AUTO_STATE_DIR:-/var/lib/technic/deploy}"
LOCK_FILE="$STATE_DIR/deploy.lock"
RELEASE_STATE="$STATE_DIR/release.state"
REPORT_DIR="$STATE_DIR/reports"
BACKUP_DIR="$STATE_DIR/db-backups"      # дампы: ПДн + хэши паролей — 700/600
CONFIG_DIR="$STATE_DIR/config-backups"  # снимки конфига: секреты — 700/600

DB_TOOLS_IMAGE="postgres:17"            # мажор = серверу Yandex Managed PG (17.x)
PROD_ENV="/etc/technic-portal/prod.env"
CA_FILE="/etc/technic-portal/certs/yandex-root.crt"
# Кадровая выгрузка водителей: персональные данные, файла в норме НЕТ. Лежит рядом с секретами
# и теми же правами; появляется на диске только под один запуск (ADR 0037 п. 12–13).
# Экспорт — compose подставляет его в монтирование сервиса seed-drivers.
DRIVERS_FILE_HOST="${DRIVERS_FILE_HOST:-/etc/technic-portal/drivers.json}"
export DRIVERS_FILE_HOST
LIVE_VHOST="/opt/infra/nginx/conf.d/technic.conf"
REPO_VHOST="deploy/nginx/technic.conf"
EDGE_NGINX="infra-nginx"                # общий edge-контейнер: nginx -t / reload
HEALTH_EXTERNAL="https://auto.su10.ru/"

SERVICES=(technic-api technic-web technic-worker)   # порядок сборки
IMAGES=(technic-api technic-web technic-worker)     # репозитории образов (whitelist prune)

KEEP_RELEASES=3     # SHA-тегов на образ: запас для --previous (запущенные защищены сверх лимита)
KEEP_DUMPS=2        # предмиграционных дампов (требование: два последних)
KEEP_CONFIGS=2      # снимков конфига
CACHE_AGE_NORMAL=336h
CACHE_AGE_TIGHT=72h
DISK_MIN_GB=8
DISK_TIGHT_PCT=85

log()  { echo "==> $*"; }
warn() { echo "!!  $*" >&2; }
fail() { echo "ОШИБКА: $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
deploy-auto — деплой/обновление портала technic (auto.su10.ru). Portal-scoped:
не трогает соседние порталы, infra-nginx и общие ресурсы. Работает из любого каталога.

  deploy-auto                       git pull(main) + сборка + авто-накат миграций + health
  deploy-auto --skip-migrate        деплой кода без наката миграций (даже при pending)
  deploy-auto --skip-seed-drivers   не наполнять справочник водителей из кадровой выгрузки
  deploy-auto --previous            откат кода на предыдущий SHA (без пересборки); схему НЕ трогает
  deploy-auto --restore-db[=файл]   восстановление БД из дампа (destructive, требует TTY;
                                    без аргумента — самый свежий дамп)
  deploy-auto --previous --restore-db[=файл]   согласованный откат кода и БД
  deploy-auto --status              read-only сводка: релизы, образы, миграции, бэкапы, диск
  deploy-auto --no-prune            не чистить образы и BuildKit-кэш (ротация бэкапов — всегда)
  deploy-auto --help                эта справка

Переменные окружения:
  AUTO_STATE_DIR      каталог состояния (по умолчанию /var/lib/technic/deploy)
  AUTO_DEPLOY_USER    владелец портала (по умолчанию — владелец каталога репозитория)
  AUTO_PRUNE_CACHE=0  то же, что --no-prune, для BuildKit-кэша
  DRIVERS_FILE_HOST   кадровая выгрузка (по умолчанию /etc/technic-portal/drivers.json)

Водители: если выгрузка лежит на месте, деплой после health заводит людей и ЗАТИРАЕТ файл
(shred) — персональные данные не остаются на диске VPS. Нет файла — шаг пропускается строкой
в выводе.

Обновление самого deploy-auto: если pull привёз новую версию скрипта, деплой перезапускается
ею же и идёт дальше — правки вступают в силу тем же деплоем, а не следующим.

Vhost: /opt/infra/nginx/conf.d/technic.conf синхронизируется с deploy/nginx/technic.conf
при каждом деплое (бэкап → nginx -t → graceful reload infra-nginx). Соседние vhost не
трогаются; при неудаче деплой не падает, но пишет warn и vhost_sync в отчёт.

Ретеншн: 3 SHA-тега на образ, 2 предмиграционных дампа (+1 аварийный), 2 снимка конфига,
2 бэкапа vhost, BuildKit-кэш старше 14 суток (при диске ≥85% — старше 72 ч).

Git: деплоится ТОЛЬКО ветка main; требуется HEAD == origin/main (запуш перед деплоем).
EOF
  exit 0
}

# ---------------------------------------------------------------------------
# Разбор аргументов.
# ---------------------------------------------------------------------------
DO_PREVIOUS=0 DO_RESTORE_DB=0 DO_STATUS=0 NO_PRUNE=0 SKIP_MIGRATE=0 SKIP_SEED_DRIVERS=0
RESTORE_DB_ARG=""

for arg in "$@"; do
  case "$arg" in
    --previous)      DO_PREVIOUS=1 ;;
    --restore-db)    DO_RESTORE_DB=1 ;;
    --restore-db=*)  DO_RESTORE_DB=1; RESTORE_DB_ARG="${arg#*=}" ;;
    --status)        DO_STATUS=1 ;;
    --no-prune)      NO_PRUNE=1 ;;
    --skip-migrate)  SKIP_MIGRATE=1 ;;
    --skip-seed-drivers) SKIP_SEED_DRIVERS=1 ;;
    -h|--help)       usage ;;
    *) echo "Неизвестный аргумент: $arg (см. --help)" >&2; exit 2 ;;
  esac
done

ROLLBACK_MODE=$(( DO_PREVIOUS || DO_RESTORE_DB ))

# Взаимоисключения — до любых мутаций и до самоповышения.
if [ "$DO_STATUS" -eq 1 ] && { [ "$ROLLBACK_MODE" -eq 1 ] || [ "$SKIP_MIGRATE" -eq 1 ] \
     || [ "$SKIP_SEED_DRIVERS" -eq 1 ]; }; then
  echo "--status — режим только для чтения, несовместим с изменяющими флагами" >&2; exit 2
fi
if [ "$SKIP_MIGRATE" -eq 1 ] && [ "$ROLLBACK_MODE" -eq 1 ]; then
  echo "--skip-migrate имеет смысл только при обычном деплое" >&2; exit 2
fi
# Откат кода справочник не наполняет — отключать там нечего.
if [ "$SKIP_SEED_DRIVERS" -eq 1 ] && [ "$ROLLBACK_MODE" -eq 1 ]; then
  echo "--skip-seed-drivers имеет смысл только при обычном деплое" >&2; exit 2
fi

# Ярлык операции для отчёта.
ACTION="deploy"
if [ "$ROLLBACK_MODE" -eq 1 ]; then
  parts=()
  [ "$DO_PREVIOUS" -eq 1 ]   && parts+=(rollback_previous)
  [ "$DO_RESTORE_DB" -eq 1 ] && parts+=(restore_db)
  ACTION="$(IFS='+'; echo "${parts[*]}")"
fi

# ---------------------------------------------------------------------------
# Самоповышение root -> владелец портала и bootstrap state-каталогов.
# /var/lib/technic принадлежит root; создаём каталоги пока root, либо через
# passwordless sudo от владельца (подтверждено: corpsu в google-sudoers).
# ---------------------------------------------------------------------------
[ -d "$PORTAL_DIR/.git" ] || fail "$PORTAL_DIR не похож на git-репозиторий портала"
DEPLOY_USER="${AUTO_DEPLOY_USER:-$(stat -c %U "$PORTAL_DIR")}"

if [ "$(id -u)" -eq 0 ]; then
  install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 755 "$(dirname "$STATE_DIR")"
  install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 750 "$STATE_DIR" "$REPORT_DIR"
  install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 700 "$BACKUP_DIR" "$CONFIG_DIR"
fi

if [ "$(id -un)" != "$DEPLOY_USER" ]; then
  if [ "$(id -u)" -eq 0 ]; then
    log "перезапуск от владельца портала ($DEPLOY_USER)"
    exec sudo -u "$DEPLOY_USER" -H "$SCRIPT" "$@"
  fi
  fail "запускать нужно от $DEPLOY_USER или от root. Выполните:
  sudo -u $DEPLOY_USER $SCRIPT $*"
fi

# Здесь: работаем от DEPLOY_USER. Досоздаём state-каталоги (первый запуск не от root).
if [ ! -d "$STATE_DIR" ]; then
  sudo install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 755 "$(dirname "$STATE_DIR")" \
    || fail "не удалось создать $(dirname "$STATE_DIR") (нужен sudo)"
  sudo install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 750 "$STATE_DIR"
fi
install -d -m 750 "$REPORT_DIR"
install -d -m 700 "$BACKUP_DIR" "$CONFIG_DIR"

# Интерполяция compose для db-tools: UID/GID владельца (файлы дампов — не root-owned)
# и путь к каталогу бэкапов. Экспорт ДО первого вызова compose.
AUTO_DEPLOY_UID="$(id -u)"; AUTO_DEPLOY_GID="$(id -g)"; AUTO_BACKUP_DIR="$BACKUP_DIR"
export AUTO_DEPLOY_UID AUTO_DEPLOY_GID AUTO_BACKUP_DIR
# git не должен ждать ввода: иначе pull/fetch повиснет, удерживая flock.
export GIT_TERMINAL_PROMPT=0

git_c() { git -C "$PORTAL_DIR" "$@"; }

# ---------------------------------------------------------------------------
# release.state — что реально запущено (current) и куда откатываться (previous).
# ---------------------------------------------------------------------------
CURRENT_BEFORE="" PREVIOUS_BEFORE=""
if [ -f "$RELEASE_STATE" ]; then
  CURRENT_BEFORE="$(grep -E '^current=' "$RELEASE_STATE" | cut -d= -f2- || true)"
  PREVIOUS_BEFORE="$(grep -E '^previous=' "$RELEASE_STATE" | cut -d= -f2- || true)"
fi

write_release_state() {
  local prev="$1" cur="$2" tmp
  tmp="$(mktemp "$RELEASE_STATE.XXXXXX")"
  { printf 'previous=%s\n' "$prev"; printf 'current=%s\n' "$cur"; } >"$tmp"
  chmod 600 "$tmp"; mv -f "$tmp" "$RELEASE_STATE"
}

# ---------------------------------------------------------------------------
# Vhost infra-nginx. Файл в git (REPO_VHOST) — источник истины для LIVE_VHOST;
# раньше он никуда не раскатывался, и правки (CSP connect-src для DaData) молча
# оставались в репозитории при внешне успешном деплое. Теперь деплой сверяет их
# и синхронизирует. Трогается ТОЛЬКО свой technic.conf; соседние vhost в conf.d/
# не читаются и не меняются, reload — graceful, после nginx -t.
# ---------------------------------------------------------------------------
# 0 — файлы идентичны, 1 — расходятся (или live отсутствует), 2 — сравнить не удалось.
vhost_state() {
  local repo="$PORTAL_DIR/$REPO_VHOST"
  [ -f "$repo" ] || return 2
  if [ -r "$LIVE_VHOST" ]; then
    cmp -s "$repo" "$LIVE_VHOST" && return 0 || return 1
  fi
  # Живой vhost — root:root 0644, но каталог может быть закрыт: пробуем через sudo,
  # строго неинтерактивно (деплой не должен виснуть на промпте пароля).
  if sudo -n test -e "$LIVE_VHOST" 2>/dev/null; then
    sudo -n cmp -s "$repo" "$LIVE_VHOST" 2>/dev/null && return 0 || return 1
  fi
  # Каталог conf.d/ виден, а файла нет — это расхождение (первая раскатка), не «неизвестно».
  if sudo -n test -d "$(dirname "$LIVE_VHOST")" 2>/dev/null; then return 1; fi
  return 2
}

# Печатает расхождение (20 строк). Vhost секретов не содержит — только домены,
# пути к сертификатам и заголовки, поэтому diff безопасен для лога деплоя.
vhost_diff() {
  local repo="$PORTAL_DIR/$REPO_VHOST"
  { sudo -n cat "$LIVE_VHOST" 2>/dev/null || cat "$LIVE_VHOST" 2>/dev/null || true; } \
    | diff -u --label "живой $LIVE_VHOST" --label "репозиторий $REPO_VHOST" - "$repo" \
    | head -20 | sed 's/^/    /' || true
}

# Раскатывает repo-vhost в LIVE_VHOST. Деплой не валит: код уже выкачен и здоров,
# а расхождение конфига — повод для громкого warn и пометки в отчёте, не для отказа.
sync_vhost() {
  local repo="$PORTAL_DIR/$REPO_VHOST" bak="" st=0
  # Через `|| st=$?`, а не голым вызовом: под set -e ненулевой код убил бы деплой.
  vhost_state || st=$?
  case "$st" in
    0) VHOST_SYNC="uptodate"; log "vhost infra-nginx актуален"; return 0 ;;
    2) VHOST_SYNC="unknown"
       warn "не удалось сравнить $LIVE_VHOST с $REPO_VHOST — проверьте вручную:"
       warn "  sudo cp $REPO_VHOST $LIVE_VHOST && docker exec $EDGE_NGINX nginx -t && docker exec $EDGE_NGINX nginx -s reload"
       return 0 ;;
  esac

  log "vhost расходится с $REPO_VHOST — синхронизирую"
  vhost_diff

  if ! docker inspect "$EDGE_NGINX" >/dev/null 2>&1; then
    VHOST_SYNC="manual"
    warn "контейнер $EDGE_NGINX не найден — vhost НЕ обновлён (без nginx -t не раскатываю)"
    return 0
  fi
  # Базовая проверка: чужой сломанный конфиг в conf.d/ не должен выглядеть как наша
  # поломка, а reload в таком состоянии положил бы соседние порталы.
  if ! docker exec "$EDGE_NGINX" nginx -t >/dev/null 2>&1; then
    VHOST_SYNC="blocked"
    warn "конфиг $EDGE_NGINX невалиден ЕЩЁ ДО правки — vhost не трогаю. Диагностика:"
    warn "  docker exec $EDGE_NGINX nginx -t"
    return 0
  fi

  # Бэкап живого файла обязателен: без него откат после неудачного nginx -t невозможен.
  if sudo -n test -e "$LIVE_VHOST" 2>/dev/null || [ -e "$LIVE_VHOST" ]; then
    bak="$CONFIG_DIR/vhost-$(date -u +%Y%m%dT%H%M%SZ).conf"
    if ! { sudo -n cat "$LIVE_VHOST" 2>/dev/null || cat "$LIVE_VHOST" 2>/dev/null; } >"$bak"; then
      rm -f "$bak"
      VHOST_SYNC="manual"
      warn "не удалось снять бэкап $LIVE_VHOST — vhost НЕ обновлён (откат был бы невозможен)"
      return 0
    fi
    chmod 600 "$bak"
    # Ротация keep-2, как у снимков конфига (`|| true` — см. rotate в snapshot_config).
    # shellcheck disable=SC2012
    ls -1t "$CONFIG_DIR"/vhost-*.conf 2>/dev/null | tail -n +$((KEEP_CONFIGS + 1)) | xargs -r rm -f || true
  fi

  if ! sudo -n install -m 644 -o root -g root "$repo" "$LIVE_VHOST" 2>/dev/null; then
    VHOST_SYNC="manual"
    warn "нет прав записи в $LIVE_VHOST (нужен passwordless sudo) — vhost НЕ обновлён. Вручную:"
    warn "  sudo cp $PORTAL_DIR/$REPO_VHOST $LIVE_VHOST"
    warn "  docker exec $EDGE_NGINX nginx -t && docker exec $EDGE_NGINX nginx -s reload"
    return 0
  fi

  if ! docker exec "$EDGE_NGINX" nginx -t >/dev/null 2>&1; then
    VHOST_SYNC="rejected"
    warn "новый vhost не прошёл nginx -t — возвращаю прежний, reload НЕ выполняю"
    if [ -n "$bak" ]; then
      sudo -n install -m 644 -o root -g root "$bak" "$LIVE_VHOST" 2>/dev/null \
        || warn "ОТКАТ НЕ УДАЛСЯ: восстановите $LIVE_VHOST из $bak вручную!"
    else
      sudo -n rm -f "$LIVE_VHOST" 2>/dev/null \
        || warn "ОТКАТ НЕ УДАЛСЯ: удалите $LIVE_VHOST вручную!"
    fi
    warn "  причина: docker exec $EDGE_NGINX nginx -t"
    return 0
  fi

  if ! docker exec "$EDGE_NGINX" nginx -s reload >/dev/null 2>&1; then
    VHOST_SYNC="reload-failed"
    warn "vhost записан, но reload $EDGE_NGINX провалился — конфиг применится только"
    warn "после перезагрузки nginx: docker exec $EDGE_NGINX nginx -s reload"
    return 0
  fi

  VHOST_SYNC="synced"
  log "vhost обновлён, $EDGE_NGINX перезагружен (graceful)${bak:+; бэкап: config-backups/$(basename "$bak")}"
}

# ---------------------------------------------------------------------------
# --status: только чтение — ни lock, ни снимков, ни мутаций.
# ---------------------------------------------------------------------------
if [ "$DO_STATUS" -eq 1 ]; then
  echo "portal   : $PORTAL_DIR"
  echo "current  : ${CURRENT_BEFORE:-<нет>}"
  echo "previous : ${PREVIOUS_BEFORE:-<нет>}"
  echo "ветка    : $(git_c rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  echo "HEAD     : $(git_c rev-parse --short HEAD 2>/dev/null || echo '?')"
  vhost_st=0; vhost_state || vhost_st=$?
  case "$vhost_st" in
    0) echo "vhost    : совпадает с $REPO_VHOST" ;;
    1) echo "vhost    : РАСХОДИТСЯ с $REPO_VHOST (деплой синхронизирует и перезагрузит $EDGE_NGINX)" ;;
    *) echo "vhost    : сравнить не удалось (нет доступа к $LIVE_VHOST)" ;;
  esac
  if [ -n "$(git_c status --porcelain 2>/dev/null || true)" ]; then
    echo "           (рабочее дерево ГРЯЗНОЕ — деплой откажется собирать)"
  fi
  echo
  echo "контейнеры:"; "${COMPOSE[@]}" ps --format '  {{.Name}}  {{.Image}}  {{.Status}}' 2>/dev/null || true
  echo
  echo "образы (SHA-теги):"
  for repo in "${IMAGES[@]}"; do
    docker image ls "$repo" --format "  {{.Repository}}:{{.Tag}}  {{.Size}}  {{.CreatedSince}}" 2>/dev/null | head -6
  done
  echo
  echo "бэкапы:"
  echo "  дампы   : $(find "$BACKUP_DIR" -maxdepth 1 -name '*.dump' 2>/dev/null | wc -l) шт, $(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)"
  echo "  конфиги : $(find "$CONFIG_DIR" -maxdepth 1 -name '*.tar.gz' 2>/dev/null | wc -l) шт, $(du -sh "$CONFIG_DIR" 2>/dev/null | cut -f1)"
  echo
  echo "миграции:"
  "${COMPOSE[@]}" run --rm -T migrate pnpm --silent --filter @technic/api db:migrate:status 2>/dev/null | tail -1 || echo "  (не удалось определить)"
  echo
  echo "водители:"
  if [ -f "$DRIVERS_FILE_HOST" ]; then
    echo "  кадровая выгрузка ждёт ($DRIVERS_FILE_HOST) — ближайший деплой заведёт её и затрёт файл"
  else
    echo "  выгрузки нет — шаг наполнения справочника пропускается"
  fi
  echo
  echo "диск:"; df -h / | tail -1 | sed 's/^/  /'
  exit 0
fi

# ---------------------------------------------------------------------------
# Lock. Снимается вместе с FD — отдельная уборка не нужна.
# ---------------------------------------------------------------------------
exec 9>"$LOCK_FILE"
flock -n 9 || fail "деплой уже выполняется (lock $LOCK_FILE)"

# ---------------------------------------------------------------------------
# Отчёт и восстановление.
# ---------------------------------------------------------------------------
RESULT="ok" REASON="" HEALTH="" COMMIT_SHA="" TARGET_TAG="" DUMP_FILE=""
PRE_RESTORE_DUMP="" CACHE_FREED="" BUILT_TAG="" VHOST_SYNC="not-checked"
# Снимок конфига переживает самоперезапуск (ниже): он делается до pull, и второй проход не должен
# снимать его повторно — двумя копиями одного деплоя ротация keep-2 выбросила бы снимок предыдущего.
CFG_SNAPSHOT="${AUTO_CFG_SNAPSHOT:-}"
SERVICES_STOPPED=0 RESTORE_DB_TOUCHED=0 ROLLBACK_UP_STARTED=0 MIGRATION_ATTEMPTED=0
SEED_DRIVERS="no-file"   # no-file | skipped | done | done-not-shredded | failed

json_escape() {
  local s=${1//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}; s=${s//$'\t'/\\t}; printf '%s' "$s"
}

write_report() {
  local ts report
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  report="$REPORT_DIR/${ts}-${TARGET_TAG:-${COMMIT_SHA:-unknown}}.json"
  # В отчёт НЕ пишем ни одного значения из env/секретов — только SHA, имена, статусы.
  {
    printf '{\n'
    printf '  "portal": "technic",\n'
    printf '  "action": "%s",\n'        "$(json_escape "$ACTION")"
    printf '  "actor": "%s",\n'         "$(json_escape "${SUDO_USER:-${USER:-unknown}}")"
    printf '  "commit": "%s",\n'        "$(json_escape "$COMMIT_SHA")"
    printf '  "from_tag": "%s",\n'      "$(json_escape "$CURRENT_BEFORE")"
    printf '  "to_tag": "%s",\n'        "$(json_escape "${TARGET_TAG:-$COMMIT_SHA}")"
    printf '  "previous_tag": "%s",\n'  "$(json_escape "$PREVIOUS_BEFORE")"
    printf '  "skip_migrate": %s,\n'    "$SKIP_MIGRATE"
    # Только статус шага: ни ФИО, ни количество заведённых людей в отчёт не попадают.
    printf '  "seed_drivers": "%s",\n'  "$(json_escape "$SEED_DRIVERS")"
    printf '  "config_snapshot": "%s",\n' "$(json_escape "$CFG_SNAPSHOT")"
    printf '  "vhost_sync": "%s",\n'     "$(json_escape "$VHOST_SYNC")"
    printf '  "dump_file": "%s",\n'     "$(json_escape "$DUMP_FILE")"
    printf '  "pre_restore_dump": "%s",\n' "$(json_escape "$PRE_RESTORE_DUMP")"
    printf '  "cache_freed": "%s",\n'   "$(json_escape "$CACHE_FREED")"
    printf '  "health": "%s",\n'        "$(json_escape "$HEALTH")"
    printf '  "result": "%s",\n'        "$RESULT"
    printf '  "reason": "%s"\n'         "$(json_escape "$REASON")"
    printf '}\n'
  } >"$report"
  chmod 640 "$report"
  log "отчёт: $report"
}

# Восстановление знает, на каком шаге упало. ВАЖНО: после применённых миграций и после
# up -d авто-отката кода НЕ делаем — иначе «старый код + новая схема». Оператор рядом.
recover() {
  local code=$?
  [ "$code" -eq 0 ] && return 0
  RESULT="fail"
  [ -z "$REASON" ] && REASON="прервано (код $code)"
  echo "ОШИБКА ($ACTION): $REASON" >&2

  if [ "$RESTORE_DB_TOUCHED" -eq 1 ]; then
    warn "pg_restore прерван. Restore шёл одной транзакцией — БД, скорее всего, осталась"
    warn "в состоянии до restore, но это НУЖНО ПРОВЕРИТЬ вручную."
    warn "Сервисы ОСТАВЛЕНЫ ОСТАНОВЛЕННЫМИ. Варианты: повторить --restore-db,"
    warn "аварийный дамп ($PRE_RESTORE_DUMP), либо PITR Yandex Managed PG."
  elif [ "$ROLLBACK_UP_STARTED" -eq 1 ]; then
    warn "частичное переключение — возвращаю сервисы на ${CURRENT_BEFORE:-latest}"
    TAG="${CURRENT_BEFORE:-latest}" "${COMPOSE[@]}" up -d --no-build "${SERVICES[@]}" || true
  elif [ "$MIGRATION_ATTEMPTED" -eq 1 ]; then
    warn "миграции могли примениться частично. Сервисы работают на СТАРОМ коде (up -d не выполнялся)."
    warn "дамп до наката: $DUMP_FILE"
    warn "согласованный откат: deploy-auto --previous --restore-db=$DUMP_FILE (или PITR)"
  elif [ "$SERVICES_STOPPED" -eq 1 ]; then
    warn "поднимаю остановленные сервисы на ${CURRENT_BEFORE:-latest}"
    TAG="${CURRENT_BEFORE:-latest}" "${COMPOSE[@]}" up -d --no-build "${SERVICES[@]}" || true
  elif [ -n "$BUILT_TAG" ]; then
    # Сборка прошла, но релиз не состоялся: не копим полусобранные SHA-образы.
    for repo in "${IMAGES[@]}"; do
      docker rmi "$repo:$BUILT_TAG" >/dev/null 2>&1 || true
    done
  fi
  write_report
}
trap recover EXIT
trap 'exit 130' INT TERM

# ---------------------------------------------------------------------------
# Общие помощники.
# ---------------------------------------------------------------------------
disk_free_gb() { df -BG --output=avail / | tail -1 | tr -dc '0-9'; }
disk_used_pct() { df --output=pcent / | tail -1 | tr -dc '0-9'; }

ensure_db_tools_image() {
  docker image inspect "$DB_TOOLS_IMAGE" >/dev/null 2>&1 && return 0
  log "docker pull $DB_TOOLS_IMAGE"
  docker pull "$DB_TOOLS_IMAGE" || { REASON="не удалось получить $DB_TOOLS_IMAGE"; fail "$REASON"; }
}

# Диагностический health изнутри контейнера: минует infra-nginx/TLS. Retry 5×.
health_check() {
  HEALTH="fail"
  for _ in 1 2 3 4 5; do
    if "${COMPOSE[@]}" exec -T technic-api node -e \
      "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
      >/dev/null 2>&1; then
      HEALTH="ok"; log "health: ok"; return 0
    fi
    sleep 3
  done
  return 1
}

# Оценка места под дамп по РЕАЛЬНОМУ размеру БД (а не только df / > 8G).
check_dump_space() {
  local dbsize avail
  # shellcheck disable=SC2016  # $DATABASE_MIGRATION_URL раскрывается ВНУТРИ контейнера, не на хосте
  dbsize="$("${COMPOSE[@]}" run --rm -T db-tools sh -c \
    'psql -tAc "SELECT pg_database_size(current_database())" "${DATABASE_MIGRATION_URL:-$DATABASE_URL}"' \
    2>/dev/null | tr -dc '0-9' || true)"
  if [ -z "$dbsize" ]; then
    warn "не удалось оценить размер БД — пропускаю проверку места под дамп"
    return 0
  fi
  avail="$(df -B1 --output=avail "$STATE_DIR" 2>/dev/null | tail -1 | tr -dc '0-9' || true)"
  if [ -n "$avail" ] && [ "$avail" -lt "$dbsize" ]; then
    REASON="под дамп нужно ~$((dbsize/1024/1024)) МБ, свободно $((avail/1024/1024)) МБ на $STATE_DIR"
    fail "$REASON"
  fi
  log "  место под дамп: БД ~$((dbsize/1024/1024)) МБ, свободно $((avail/1024/1024)) МБ (запас есть)"
}

snapshot_config() {
  local ts; ts="$(date -u +%Y%m%dT%H%M%SZ)"
  CFG_SNAPSHOT="config-${ts}-$(git_c rev-parse --short HEAD 2>/dev/null || echo nogit).tar.gz"
  local out="$CONFIG_DIR/$CFG_SNAPSHOT"
  # Абсолютные host-пути тарим относительно / ; репо-vhost — относительно PORTAL_DIR.
  local abs=()
  if [ -r "$PROD_ENV" ];  then abs+=("${PROD_ENV#/}"); else warn "prod.env нечитаем — не попадёт в снимок"; fi
  if [ -r "$CA_FILE" ];   then abs+=("${CA_FILE#/}"); fi
  if [ -r "$LIVE_VHOST" ];then abs+=("${LIVE_VHOST#/}"); else warn "живой vhost нечитаем — не попадёт в снимок"; fi
  ( umask 077; tar -czf "$out" \
      -C / ${abs[@]+"${abs[@]}"} \
      -C "$PORTAL_DIR" "$REPO_VHOST" )
  chmod 600 "$out"
  log "снимок конфига: config-backups/$CFG_SNAPSHOT"
  # Ротация keep-2. `|| true` обязателен: без совпадений ls→2, pipefail+set -e убьют скрипт.
  # shellcheck disable=SC2012
  ls -1t "$CONFIG_DIR"/config-*.tar.gz 2>/dev/null | tail -n +$((KEEP_CONFIGS + 1)) | xargs -r rm -f || true
}

rotate_dumps() {
  # shellcheck disable=SC2012
  ls -1t "$BACKUP_DIR"/[0-9]*.dump 2>/dev/null | tail -n +$((KEEP_DUMPS + 1)) | while read -r old; do
    rm -f "$old" "${old%.dump}.meta"
  done || true
  # shellcheck disable=SC2012
  ls -1t "$BACKUP_DIR"/prerestore-*.dump 2>/dev/null | tail -n +2 | xargs -r rm -f || true
}

prune_images() {
  [ "$NO_PRUNE" -eq 1 ] && { log "чистка образов пропущена (--no-prune)"; return 0; }
  local protect=("${CURRENT_BEFORE:-}" "${PREVIOUS_BEFORE:-}" "${COMMIT_SHA:-}" latest)
  # Реально запущенное защищаем даже при рассинхроне release.state.
  local c img
  for c in "${IMAGES[@]}"; do
    img="$(docker inspect -f '{{.Config.Image}}' "$c" 2>/dev/null || true)"
    [ -n "$img" ] && protect+=("${img##*:}")
  done
  local repo tag kept p skip
  for repo in "${IMAGES[@]}"; do
    kept=0
    while read -r tag; do
      { [ -z "$tag" ] || [ "$tag" = "<none>" ]; } && continue
      skip=0
      for p in "${protect[@]}"; do [ -n "$p" ] && [ "$tag" = "$p" ] && { skip=1; break; }; done
      [ "$skip" -eq 1 ] && continue
      kept=$((kept + 1)); [ "$kept" -le "$KEEP_RELEASES" ] && continue
      log "  удаляю $repo:$tag"
      docker rmi "$repo:$tag" >/dev/null 2>&1 || warn "  $repo:$tag занят — оставлен"
    done < <(docker image ls "$repo" --format '{{.Tag}}')
  done
}

# ЕДИНСТВЕННОЕ место, где выходим за границы портала: BuildKit-кэш общий с соседями.
# Чистка СТАРОГО кэша безопасна — лишь замедлит ближайшую чужую сборку.
prune_cache() {
  [ "$NO_PRUNE" -eq 1 ] && return 0
  [ "${AUTO_PRUNE_CACHE:-1}" = "0" ] && return 0
  local age="$CACHE_AGE_NORMAL"
  if [ "$(disk_used_pct)" -ge "$DISK_TIGHT_PCT" ]; then
    age="$CACHE_AGE_TIGHT"
    warn "диск занят на $(disk_used_pct)% — ужесточаю чистку кэша до until=$age"
  fi
  log "чистка BuildKit-кэша старше $age (кэш ОБЩИЙ для всех порталов хоста)"
  CACHE_FREED="$(docker builder prune -f --filter "until=$age" 2>/dev/null | tail -1 || true)"
  [ -n "$CACHE_FREED" ] && log "  $CACHE_FREED"
}

confirm_tty() {
  local answer
  [ -r /dev/tty ] || fail "$1 требует интерактивного терминала (запустите из ssh-сессии с TTY)"
  printf '  Введите yes для продолжения: ' >&2
  read -r answer </dev/tty || answer=""
  [ "$answer" = "yes" ] || { REASON="операция отменена оператором"; fail "$REASON"; }
}

# Разворачивает $DATABASE_MIGRATION_URL внутри контейнера — секрета в host-argv нет.
db_tools_dump() {
  # shellcheck disable=SC2016  # $DATABASE_MIGRATION_URL раскрывается ВНУТРИ контейнера, не на хосте
  "${COMPOSE[@]}" run --rm -T db-tools sh -c \
    'pg_dump --dbname="${DATABASE_MIGRATION_URL:-$DATABASE_URL}" -Fc -f "/backups/'"$1"'"'
}

# ===========================================================================
# Режимы отката: --previous и/или --restore-db.
# ===========================================================================
if [ "$ROLLBACK_MODE" -eq 1 ]; then
  if [ "$DO_PREVIOUS" -eq 1 ]; then
    [ -n "$PREVIOUS_BEFORE" ] || { REASON="в $RELEASE_STATE нет previous= — откатываться не на что"; fail "$REASON"; }
    TARGET_TAG="$PREVIOUS_BEFORE"
    for repo in "${IMAGES[@]}"; do
      docker image inspect "$repo:$TARGET_TAG" >/dev/null 2>&1 || {
        REASON="образ $repo:$TARGET_TAG не найден локально (вычищен ретеншном?) — быстрый откат невозможен"
        fail "$REASON"; }
    done
  else
    TARGET_TAG="${CURRENT_BEFORE:-latest}"
  fi

  snapshot_config
  log "ВНИМАНИЕ: откат образов НЕ отменяет миграции БД; откат схемы — только --restore-db или PITR"

  if [ "$DO_RESTORE_DB" -eq 1 ]; then
    if [ -n "$RESTORE_DB_ARG" ]; then
      printf '%s' "$RESTORE_DB_ARG" | grep -qE '^[A-Za-z0-9][A-Za-z0-9._-]*\.dump$' \
        || { REASON="--restore-db принимает только имя файла *.dump из $BACKUP_DIR"; fail "$REASON"; }
      case "$RESTORE_DB_ARG" in *..*) REASON="недопустимое имя дампа"; fail "$REASON" ;; esac
      DUMP_FILE="$RESTORE_DB_ARG"
    else
      # shellcheck disable=SC2012
      LATEST="$(ls -1t "$BACKUP_DIR"/[0-9]*.dump 2>/dev/null | head -1 || true)"
      [ -n "$LATEST" ] || { REASON="в $BACKUP_DIR нет дампов (создаются при деплое с миграциями)"; fail "$REASON"; }
      DUMP_FILE="$(basename "$LATEST")"
    fi
    DUMP_PATH="$BACKUP_DIR/$DUMP_FILE"
    [ -f "$DUMP_PATH" ] || { REASON="дамп не найден: $DUMP_PATH"; fail "$REASON"; }

    META="${DUMP_PATH%.dump}.meta"
    META_CREATED="" META_TARGET=""
    if [ -f "$META" ]; then
      META_CREATED="$(grep -E '^created_at=' "$META" | cut -d= -f2- || true)"
      META_TARGET="$(grep -E '^target_commit=' "$META" | cut -d= -f2- || true)"
    else
      warn "у дампа нет .meta — метки времени/коммита неизвестны"
    fi

    ensure_db_tools_image
    echo
    echo "  ВОССТАНОВЛЕНИЕ БД ИЗ ДАМПА (destructive)"
    echo "  Файл:         $DUMP_FILE"
    echo "  Снят (UTC):   ${META_CREATED:-неизвестно}"
    echo "  Перед миграцией на код: ${META_TARGET:-?}"
    echo "  ВСЕ ДАННЫЕ, записанные в БД ПОСЛЕ снятия дампа, будут ПОТЕРЯНЫ."
    echo "  Внимание: pg_restore --clean дропает лишь объекты ИЗ архива; объекты, созданные"
    echo "  более новой миграцией, могут остаться. Гарантированный откат схемы — Yandex PITR"
    echo "  на метку ${META_CREATED:-<до деплоя>} (UTC)."
    echo "  Загруженные в S3 файлы дамп НЕ покрывает — ссылки в БД и объекты могут разойтись."
    confirm_tty "--restore-db"

    log "стоп сервисов на время восстановления (полное окно обслуживания; снаружи 502)"
    "${COMPOSE[@]}" stop "${SERVICES[@]}" || true
    SERVICES_STOPPED=1

    PRE_RESTORE_DUMP="prerestore-$(date -u +%Y%m%dT%H%M%SZ).dump"
    log "аварийный дамп текущего состояния: db-backups/$PRE_RESTORE_DUMP"
    db_tools_dump "$PRE_RESTORE_DUMP" \
      || { REASON="pre-restore дамп провалился — восстановление НЕ начиналось, БД не тронута"; fail "$REASON"; }
    chmod 600 "$BACKUP_DIR/$PRE_RESTORE_DUMP" || true

    log "pg_restore из $DUMP_FILE (single-transaction, clean)"
    RESTORE_DB_TOUCHED=1
    "${COMPOSE[@]}" run --rm -T db-tools sh -c \
      "pg_restore --dbname=\"\${DATABASE_MIGRATION_URL:-\$DATABASE_URL}\" --single-transaction --exit-on-error --clean --if-exists --no-owner '/backups/$DUMP_FILE'" \
      || { REASON="pg_restore провалился"; fail "$REASON"; }
    RESTORE_DB_TOUCHED=0
    log "restore ok (журнал _migrations восстановлен вместе со схемой)"
    rotate_dumps
  fi

  ROLLBACK_UP_STARTED=1
  log "up -d --no-build (тег $TARGET_TAG): ${SERVICES[*]}"
  TAG="$TARGET_TAG" "${COMPOSE[@]}" up -d --no-build "${SERVICES[@]}"
  ROLLBACK_UP_STARTED=0; SERVICES_STOPPED=0

  if [ "$DO_PREVIOUS" -eq 1 ]; then
    write_release_state "$CURRENT_BEFORE" "$TARGET_TAG"
    log "release.state: current=$TARGET_TAG previous=$CURRENT_BEFORE"
  fi

  if health_check; then
    for repo in "${IMAGES[@]}"; do docker tag "$repo:$TARGET_TAG" "$repo:latest" 2>/dev/null || true; done
  else
    warn "health не подтверждён — :latest не переставлен"
  fi

  RESULT="ok"; write_report; trap - EXIT
  log "Готово ($ACTION): technic @ $TARGET_TAG"
  exit 0
fi

# ===========================================================================
# Обычный деплой.
# ===========================================================================
log "preflight ($PORTAL_DIR)"
[ -f "$PROD_ENV" ]      || { REASON="нет $PROD_ENV"; fail "$REASON"; }
[ -r "$PROD_ENV" ]      || { REASON="$PROD_ENV нечитаем владельцем ($DEPLOY_USER) — нужен режим root:docker 0640"; fail "$REASON"; }
[ -f "$CA_FILE" ]       || { REASON="нет $CA_FILE"; fail "$REASON"; }
[ -f "$COMPOSE_FILE" ]  || { REASON="нет $COMPOSE_FILE"; fail "$REASON"; }
docker info >/dev/null 2>&1 || { REASON="docker недоступен"; fail "$REASON"; }
docker network inspect edge >/dev/null 2>&1 || { REASON="нет docker-сети 'edge'"; fail "$REASON"; }

BRANCH="$(git_c rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || { REASON="деплой только с ветки main (сейчас '$BRANCH'). Выполните: git -C $PORTAL_DIR checkout main"; fail "$REASON"; }
git_c rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1 \
  || { REASON="у main нет upstream — git pull невозможен"; fail "$REASON"; }
[ -z "$(git_c status --porcelain)" ] \
  || { REASON="рабочее дерево не чистое — образ должен собираться из точного коммита"; fail "$REASON"; }

# Осиротевшие one-off контейнеры от прерванных `compose run`.
docker ps -aq --filter "name=^technic-.*-run-" 2>/dev/null | xargs -r docker rm -f >/dev/null 2>&1 || true

if [ "$(disk_free_gb)" -lt "$DISK_MIN_GB" ]; then
  warn "свободно $(disk_free_gb) ГБ (< $DISK_MIN_GB) — пробую освободить до сборки"
  snapshot_config; CFG_SNAPSHOT=""   # снимок до любых мутаций, но prune его не касается
  prune_images; prune_cache
  [ "$(disk_free_gb)" -ge "$DISK_MIN_GB" ] \
    || { REASON="на диске $(disk_free_gb) ГБ — меньше $DISK_MIN_GB даже после чистки; заполнение убьёт ВСЕ порталы хоста"; fail "$REASON"; }
fi

# Снимок конфига — до pull: repo-vhost трекается git'ом, pull его перепишет.
[ -n "$CFG_SNAPSHOT" ] || snapshot_config

# SHA до pull. При самоперезапуске (ниже) он приходит из первого прохода: там HEAD ещё не сдвинут,
# а во втором проходе pull уже no-op — иначе bootstrap-пометка запущенных образов решила бы, что
# pull ничего не менял, и --previous после такого деплоя не появился бы.
PREPULL_SHA="${AUTO_PREPULL_SHA:-$(git_c rev-parse --short HEAD)}"

log "git fetch + pull --ff-only (main ← origin/main)"
git_c fetch --prune origin || { REASON="git fetch провалился"; fail "$REASON"; }
git_c pull --ff-only || { REASON="git pull --ff-only провалился"; fail "$REASON"; }
[ -z "$(git_c status --porcelain)" ] || { REASON="дерево стало грязным после pull"; fail "$REASON"; }

# Деплой должен быть воспроизводим с remote: HEAD обязан совпадать с origin/main
# (иначе собрали бы незапушенный/ahead-коммит).
LOCAL_SHA="$(git_c rev-parse HEAD)"
REMOTE_SHA="$(git_c rev-parse origin/main)"
[ "$LOCAL_SHA" = "$REMOTE_SHA" ] \
  || { REASON="HEAD ($LOCAL_SHA) != origin/main ($REMOTE_SHA) — запушьте main перед деплоем"; fail "$REASON"; }

# ---------------------------------------------------------------------------
# Самоперезапуск, если pull обновил САМ deploy-auto.
#
# Скрипт стоит симлинком в рабочее дерево и пуллит сам себя. git обновляет файл заменой inode,
# а запущенный bash дочитывает СТАРЫЙ через уже открытый дескриптор — деплой, который привёз
# новую версию, целиком идёт по предыдущей, без единой ошибки в выводе. Так молча не выполнился
# первый деплой шага наполнения справочника водителей: файл на диске новый, отработал старый.
#
# Точка выбрана здесь: мутаций релиза ещё нет (сборки не было, схему не трогали), а HEAD уже
# на целевом коммите — второй проход повторяет только идемпотентное. EXIT-trap на exec не
# срабатывает (bash заменяет процесс), ложного recover не будет; flock переживает exec —
# fd 9 наследуется, второй проход переоткрывает его и берёт лок заново.
#
# AUTO_REEXECED отключает проверку во втором проходе, а не только петлю: сравнивать он будет
# всё с тем же PREPULL_SHA (он проброшен), то есть diff останется непустым — без этого условия
# каждый такой деплой ругался бы на «повторное обновление». Перезапуск нужен ровно один.
# ---------------------------------------------------------------------------
if [ -z "${AUTO_REEXECED:-}" ] && [ "$SCRIPT_REL" != "$SCRIPT" ] \
   && [ -n "$(git_c diff --name-only "$PREPULL_SHA" HEAD -- "$SCRIPT_REL")" ]; then
  log "pull обновил сам deploy-auto ($SCRIPT_REL) — деплой продолжает новая версия"
  exec env AUTO_REEXECED=1 AUTO_PREPULL_SHA="$PREPULL_SHA" AUTO_CFG_SNAPSHOT="$CFG_SNAPSHOT" \
    "$SCRIPT" "$@"
fi

COMMIT_SHA="$(git_c rev-parse --short HEAD)"
# Экспорт ДО любого compose-вызова: иначе ${TAG:-latest} подставит СТАРЫЙ образ.
export TAG="$COMMIT_SHA"
# Вшивается в web-бандл и version.json — клиент детектит новую версию и предлагает перезагрузку.
export BUILD_ID="$COMMIT_SHA"
# VITE_DADATA_SUGGEST_TOKEN — build-time: значение берём из prod.env в shell-окружение ДО
# compose build (build.args читают env, не env_file). Пусто → веб соберётся без подсказок адресов.
export VITE_DADATA_SUGGEST_TOKEN="$(sed -n 's/^VITE_DADATA_SUGGEST_TOKEN=//p' "$PROD_ENV" | tail -n1)"
TARGET_TAG="$COMMIT_SHA"
log "commit: $COMMIT_SHA (теги образов technic-*:$COMMIT_SHA)"

# Первый запуск на живом проде: release.state пуст, но контейнеры работают. Метим
# фактически запущенные образы пред-pull SHA, чтобы --previous стал доступен уже
# после ЭТОГО деплоя. Только если pull реально сдвинул HEAD.
if [ -z "$CURRENT_BEFORE" ] && [ "$PREPULL_SHA" != "$COMMIT_SHA" ]; then
  tagged=0
  for repo in "${IMAGES[@]}"; do
    img="$(docker inspect -f '{{.Image}}' "$repo" 2>/dev/null || true)"
    if [ -n "$img" ] && docker tag "$img" "$repo:$PREPULL_SHA" >/dev/null 2>&1; then
      tagged=1
    fi
  done
  if [ "$tagged" -eq 1 ]; then
    CURRENT_BEFORE="$PREPULL_SHA"
    log "bootstrap: запущенные образы помечены как $PREPULL_SHA (предположительно)"
  fi
fi

log "build: ${SERVICES[*]} (technic-*:$COMMIT_SHA)"
"${COMPOSE[@]}" build "${SERVICES[@]}" || { REASON="сборка провалилась"; fail "$REASON"; }
BUILT_TAG="$COMMIT_SHA"

# Проверка миграций по КОДУ ВОЗВРАТА: 0 применено, 3 pending, иначе — отказ (fail-closed).
log "проверка статуса миграций"
set +e
"${COMPOSE[@]}" run --rm -T migrate pnpm --silent --filter @technic/api db:migrate:check
mig_rc=$?
set -e
case "$mig_rc" in
  0) PENDING=0; log "  миграции применены" ;;
  3) PENDING=1; log "  есть неприменённые миграции" ;;
  *) REASON="не удалось определить статус миграций (код $mig_rc) — БД недоступна или журнал разошёлся с файлами"
     fail "$REASON" ;;
esac

if [ "$PENDING" -eq 1 ] && [ "$SKIP_MIGRATE" -eq 1 ]; then
  warn "есть неприменённые миграции, но передан --skip-migrate:"
  warn "деплою НОВЫЙ код на СТАРУЮ схему — возможны ошибки во время работы. Дамп не снимаю."
elif [ "$PENDING" -eq 1 ]; then
  ensure_db_tools_image
  check_dump_space

  DUMP_TS="$(date -u +%Y%m%dT%H%M%SZ)"
  DUMP_FILE="${DUMP_TS}-${COMMIT_SHA}.dump"
  log "дамп БД перед накатом: db-backups/$DUMP_FILE"
  db_tools_dump "$DUMP_FILE" || { REASON="дамп БД провалился — миграции не запускались"; fail "$REASON"; }
  chmod 600 "$BACKUP_DIR/$DUMP_FILE"
  {
    printf 'created_at=%s\n'     "$DUMP_TS"
    printf 'target_commit=%s\n'  "$COMMIT_SHA"
    printf 'current_before=%s\n' "$CURRENT_BEFORE"
  } >"$BACKUP_DIR/${DUMP_FILE%.dump}.meta"
  chmod 600 "$BACKUP_DIR/${DUMP_FILE%.dump}.meta"
  rotate_dumps

  log "накат новых миграций"
  MIGRATION_ATTEMPTED=1
  "${COMPOSE[@]}" run --rm -T migrate || { REASON="миграция провалилась"; fail "$REASON"; }
  MIGRATION_ATTEMPTED=0
fi

log "up -d: ${SERVICES[*]}"
"${COMPOSE[@]}" up -d "${SERVICES[@]}" || { REASON="запуск сервисов провалился"; fail "$REASON"; }

# release.state — ФАКТ (что реально запущено), пишется после up -d и до health.
# Авто-отката кода нет (см. recover), поэтому рассинхрона current↔running не будет.
write_release_state "$CURRENT_BEFORE" "$COMMIT_SHA"

# health гейтит «благословение» :latest, но НЕ откатывает автоматически.
if health_check; then
  for repo in "${IMAGES[@]}"; do docker tag "$repo:$COMMIT_SHA" "$repo:latest"; done
  BUILT_TAG=""
else
  RESULT="degraded"
  warn "health НЕ подтверждён за 5 попыток. Сервисы запущены на $COMMIT_SHA,"
  warn ":latest оставлен на прошлом здоровом релизе (авто-отката нет)."
  warn "Логи:   ${COMPOSE[*]} logs --tail=50 technic-api"
  warn "Откат:  deploy-auto --previous"
  write_report; trap - EXIT
  exit 1
fi

# Vhost — после up -d (новые контейнеры уже подняты, proxy_pass есть куда резолвить)
# и до внешнего health, чтобы тот проверял уже актуальный конфиг edge.
sync_vhost

# Внешний health — отдельно: проверяет infra-nginx/TLS/DNS, а не наш код.
if curl -fsSI -m 10 "$HEALTH_EXTERNAL" >/dev/null 2>&1; then
  log "внешний health: ok ($HEALTH_EXTERNAL)"
else
  warn "внешний health недоступен ($HEALTH_EXTERNAL) — проверьте infra-nginx/TLS/DNS."
  warn "Приложение при этом здорово изнутри; на выкатку это не влияет."
fi

# ---------------------------------------------------------------------------
# Наполнение справочника водителей кадровой выгрузкой (ADR 0037 п. 12–13).
#
# Файла в норме нет, и шаг только отмечается строкой. Положили выгрузку рядом с prod.env — деплой
# заводит людей и затирает файл: персональные данные лежат на диске VPS ровно один деплой,
# а не постоянно. Дальше шаг снова сам себя пропускает, ручной запуск из runbook'а не нужен.
#
# После health, а не рядом с миграциями: это наполнение данными, а не условие
# работоспособности релиза. Поэтому провал здесь ничего не откатывает и деплой не роняет —
# код уже выкачен и здоров, а выгрузка остаётся на месте до следующей попытки (повторный
# запуск ничего не дублирует: ключ человека — СНИЛС). Образ берётся свежий: TAG=$COMMIT_SHA
# экспортирован выше, схема к этому моменту уже накачена.
#
# Разбор идёт целиком до первой записи в базу (seed-drivers.ts), поэтому отдельный
# --dry-run перед заливкой не нужен: кривой файл не оставит справочник наполовину заведённым.
# ---------------------------------------------------------------------------
if [ -f "$DRIVERS_FILE_HOST" ] && [ "$SKIP_SEED_DRIVERS" -eq 1 ]; then
  SEED_DRIVERS="skipped"
  warn "кадровая выгрузка лежит ($DRIVERS_FILE_HOST), но передан --skip-seed-drivers:"
  warn "справочник водителей не наполнялся, файл с персональными данными остался на диске."
elif [ -f "$DRIVERS_FILE_HOST" ]; then
  log "кадровая выгрузка найдена — наполнение справочника водителей"
  if "${COMPOSE[@]}" run --rm -T seed-drivers; then
    # Затираем только после успеха: иначе выгрузку пришлось бы везти на VPS заново.
    if sudo -n shred -u "$DRIVERS_FILE_HOST" 2>/dev/null; then
      SEED_DRIVERS="done"
      log "  справочник наполнен, выгрузка затёрта ($DRIVERS_FILE_HOST)"
    else
      SEED_DRIVERS="done-not-shredded"
      warn "справочник наполнен, но затереть выгрузку не удалось (нужен sudo). Уберите вручную:"
      warn "  sudo shred -u $DRIVERS_FILE_HOST"
      warn "Иначе следующий деплой прогонит её повторно (заведённых он пропустит)."
    fi
  else
    SEED_DRIVERS="failed"
    warn "наполнение справочника водителей провалилось. Деплой это НЕ откатывает:"
    warn "код выкачен и здоров, выгрузка оставлена на месте ($DRIVERS_FILE_HOST)."
    warn "Разбор без записи: ${COMPOSE[*]} run --rm seed-drivers \\"
    warn "  pnpm --filter @technic/api seed:drivers --dry-run"
  fi
else
  # Штатное состояние, но строкой: молчащий шаг неотличим от неработающего, и пропуск
  # из-за опечатки в пути или неснятого права на файл искали бы по пустому справочнику.
  log "кадровой выгрузки нет ($DRIVERS_FILE_HOST) — справочник водителей не наполняется"
fi

prune_images
prune_cache

write_report; trap - EXIT
log "Готово: technic @ $COMMIT_SHA"

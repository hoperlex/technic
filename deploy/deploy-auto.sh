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
#   deploy-auto --previous          откат кода на предыдущий SHA (без пересборки); схему НЕ трогает
#   deploy-auto --restore-db[=файл] восстановление БД из дампа (destructive, требует TTY)
#   deploy-auto --previous --restore-db[=файл]  согласованный откат кода и БД
#   deploy-auto --status            read-only сводка
#   deploy-auto --no-prune          без чистки образов/BuildKit-кэша (ротация бэкапов — всегда)
#   deploy-auto --cutover           необратимый выкат: остановка записи → миграция → верификатор →
#                                   граница совместимости → подъём (docs/schema-cutover-protocol.md)
#   deploy-auto --cutover-revert    откат незавершённого cutover (только пока граница не записана)
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
# Состояние необратимого выката и граница совместимости — рядом с release.state, а не в рабочем
# дереве: git pull не должен ни стирать их, ни конфликтовать с ними (протокол §3, §4).
CUTOVER_STATE="$STATE_DIR/cutover.state"
SCHEMA_FLOOR_STATE="$STATE_DIR/schema-floor.state"
# Отметка о заведении границы. Нужна ровно затем, чтобы отличить «файла ещё не было» от «файл
# потеряли»: сам файл в обоих случаях отсутствует, а ответы противоположные (§4).
FLOOR_STAMP="$STATE_DIR/schema-floor.bootstrap"
TEARDOWN_DIR="$PORTAL_DIR/apps/api/teardown"
REPORT_DIR="$STATE_DIR/reports"
BACKUP_DIR="$STATE_DIR/db-backups"      # дампы: ПДн + хэши паролей — 700/600
CONFIG_DIR="$STATE_DIR/config-backups"  # снимки конфига: секреты — 700/600

DB_TOOLS_IMAGE="postgres:17"            # мажор = серверу Yandex Managed PG (17.x)
PROD_ENV="/etc/technic-portal/prod.env"
CA_FILE="/etc/technic-portal/certs/yandex-root.crt"
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
  deploy-auto --previous            откат кода на предыдущий SHA (без пересборки); схему НЕ трогает
  deploy-auto --restore-db[=файл]   восстановление БД из дампа (destructive, требует TTY;
                                    без аргумента — самый свежий дамп)
  deploy-auto --previous --restore-db[=файл]   согласованный откат кода и БД
  deploy-auto --status              read-only сводка: релизы, образы, миграции, бэкапы, диск
  deploy-auto --no-prune            не чистить образы и BuildKit-кэш (ротация бэкапов — всегда)
  deploy-auto --cutover             необратимый выкат по протоколу (docs/schema-cutover-protocol.md):
                                    сверка бандла → стоп записи → дамп → миграция → верификатор →
                                    граница совместимости → up -d → health. Возобновляем: повтор
                                    после любого обрыва продолжает с того же места
  deploy-auto --cutover-revert      откат незавершённого cutover: teardown релиза и возврат
                                    сервисов на прежний тег. Разрешён только на фазе migrated и
                                    только пока граница не записана
  deploy-auto --help                эта справка

Переменные окружения:
  AUTO_STATE_DIR      каталог состояния (по умолчанию /var/lib/technic/deploy)
  AUTO_DEPLOY_USER    владелец портала (по умолчанию — владелец каталога репозитория)
  AUTO_PRUNE_CACHE=0  то же, что --no-prune, для BuildKit-кэша
  AUTO_CUTOVER_VERIFY команда-верификатор для --cutover вместо объявленной релизом (репетиция)

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
DO_PREVIOUS=0 DO_RESTORE_DB=0 DO_STATUS=0 NO_PRUNE=0 SKIP_MIGRATE=0
DO_CUTOVER=0 DO_CUTOVER_REVERT=0
RESTORE_DB_ARG=""

for arg in "$@"; do
  case "$arg" in
    --previous)       DO_PREVIOUS=1 ;;
    --restore-db)     DO_RESTORE_DB=1 ;;
    --restore-db=*)   DO_RESTORE_DB=1; RESTORE_DB_ARG="${arg#*=}" ;;
    --status)         DO_STATUS=1 ;;
    --no-prune)       NO_PRUNE=1 ;;
    --skip-migrate)   SKIP_MIGRATE=1 ;;
    --cutover)        DO_CUTOVER=1 ;;
    --cutover-revert) DO_CUTOVER_REVERT=1 ;;
    -h|--help)        usage ;;
    *) echo "Неизвестный аргумент: $arg (см. --help)" >&2; exit 2 ;;
  esac
done

ROLLBACK_MODE=$(( DO_PREVIOUS || DO_RESTORE_DB ))

# Взаимоисключения — до любых мутаций и до самоповышения.
if [ "$DO_STATUS" -eq 1 ] \
   && { [ "$ROLLBACK_MODE" -eq 1 ] || [ "$SKIP_MIGRATE" -eq 1 ] \
        || [ "$DO_CUTOVER" -eq 1 ] || [ "$DO_CUTOVER_REVERT" -eq 1 ]; }; then
  echo "--status — режим только для чтения, несовместим с изменяющими флагами" >&2; exit 2
fi
if [ "$SKIP_MIGRATE" -eq 1 ] && [ "$ROLLBACK_MODE" -eq 1 ]; then
  echo "--skip-migrate имеет смысл только при обычном деплое" >&2; exit 2
fi
# Необратимый выкат — не «деплой с флажком»: у него свой порядок шагов и своё состояние. Смешать
# его с откатом или с --skip-migrate значит выполнить половину протокола, а половина протокола
# хуже его отсутствия — она оставляет состояние, которого не ждёт ни один из режимов.
if [ "$DO_CUTOVER" -eq 1 ] && [ "$DO_CUTOVER_REVERT" -eq 1 ]; then
  echo "--cutover и --cutover-revert — противоположные операции, вместе не запускаются" >&2; exit 2
fi
if [ "$DO_CUTOVER" -eq 1 ] && { [ "$ROLLBACK_MODE" -eq 1 ] || [ "$SKIP_MIGRATE" -eq 1 ]; }; then
  echo "--cutover несовместим с --previous/--restore-db/--skip-migrate (см. --help)" >&2; exit 2
fi
if [ "$DO_CUTOVER_REVERT" -eq 1 ] && { [ "$ROLLBACK_MODE" -eq 1 ] || [ "$SKIP_MIGRATE" -eq 1 ]; }; then
  echo "--cutover-revert несовместим с --previous/--restore-db/--skip-migrate (см. --help)" >&2; exit 2
fi

# Ярлык операции для отчёта.
ACTION="deploy"
if [ "$ROLLBACK_MODE" -eq 1 ]; then
  parts=()
  [ "$DO_PREVIOUS" -eq 1 ]   && parts+=(rollback_previous)
  [ "$DO_RESTORE_DB" -eq 1 ] && parts+=(restore_db)
  ACTION="$(IFS='+'; echo "${parts[*]}")"
fi
[ "$DO_CUTOVER" -eq 1 ]        && ACTION="cutover"
[ "$DO_CUTOVER_REVERT" -eq 1 ] && ACTION="cutover_revert"

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
# Состояние необратимого выката: cutover.state (фаза релиза) и schema-floor.state
# (граница совместимости). Нормативное описание — docs/schema-cutover-protocol.md;
# здесь только механика чтения и записи, без SQL и параметров конкретного релиза.
#
# Оба файла читаются, чтобы ответить на один вопрос — «можно ли сейчас откатываться», —
# и отвечать на него по половине записи нельзя. Отсюда атомарная запись ниже.
# ---------------------------------------------------------------------------

# fsync файла (или каталога — так фиксируется само переименование). `sync ПУТЬ` умеет coreutils
# ≥ 8.24; на старом аргумент не поддержан — тогда общий sync: дороже, но не молча мимо диска.
fsync_path() { sync "$1" 2>/dev/null || sync; }

# Атомарная запись state-файла: содержимое приходит со stdin, ложится во временный файл В ТОМ ЖЕ
# каталоге (mv обязан быть переименованием, а не копированием через границу ФС), сбрасывается на
# диск и только потом занимает место целевого. Обрыв питания в этом месте — штатный сценарий
# протокола, а не редкость: по этим файлам решается судьба отката.
write_state_atomic() {
  local target="$1" tmp
  tmp="$(mktemp "$target.XXXXXX")" \
    || { REASON="не удалось создать временный файл рядом с $target"; fail "$REASON"; }
  cat >"$tmp"
  chmod 600 "$tmp"
  fsync_path "$tmp"
  mv -f "$tmp" "$target"
  fsync_path "$(dirname "$target")"
}

CUTOVER_PHASE="" CUTOVER_CANDIDATE="" CUTOVER_MIGRATION="" CUTOVER_DUMP="" CUTOVER_STARTED=""

# Читает активное состояние выката. Коды: 0 — прочитано, 1 — активного состояния нет (штатная
# жизнь площадки: файл существует только между началом cutover и его архивированием), 2 — файл
# есть, но в нём нет фазы или SHA кандидата.
cutover_state_read() {
  CUTOVER_PHASE="" CUTOVER_CANDIDATE="" CUTOVER_MIGRATION="" CUTOVER_DUMP="" CUTOVER_STARTED=""
  [ -f "$CUTOVER_STATE" ] || return 1
  CUTOVER_PHASE="$(grep -E '^phase=' "$CUTOVER_STATE" | cut -d= -f2- || true)"
  CUTOVER_CANDIDATE="$(grep -E '^candidate=' "$CUTOVER_STATE" | cut -d= -f2- || true)"
  CUTOVER_MIGRATION="$(grep -E '^migration=' "$CUTOVER_STATE" | cut -d= -f2- || true)"
  CUTOVER_DUMP="$(grep -E '^dump=' "$CUTOVER_STATE" | cut -d= -f2- || true)"
  CUTOVER_STARTED="$(grep -E '^started_at=' "$CUTOVER_STATE" | cut -d= -f2- || true)"
  { [ -n "$CUTOVER_PHASE" ] && [ -n "$CUTOVER_CANDIDATE" ]; } || return 2
  return 0
}

# Фаза активного выката для гейтов: заполняет CUTOVER_* (пусто — активного выката нет) и падает на
# нечитаемом файле. Молчаливое «считаем, что выката нет» здесь недопустимо: это ровно тот ответ,
# который снимает все блокировки.
cutover_phase_or_fail() {
  local st=0
  cutover_state_read || st=$?
  case "$st" in
    0|1) ;;
    *) REASON="$CUTOVER_STATE не читается: нет фазы или SHA кандидата — разбирает человек"
       fail "$REASON" ;;
  esac
}

# Пишет фазу. Файл переписывается целиком — это документ состояния, а не журнал дописывания.
cutover_state_write() {
  CUTOVER_PHASE="$1"
  write_state_atomic "$CUTOVER_STATE" <<EOF
phase=$CUTOVER_PHASE
candidate=$CUTOVER_CANDIDATE
migration=$CUTOVER_MIGRATION
dump=$CUTOVER_DUMP
started_at=$CUTOVER_STARTED
updated_at=$(date -u +%Y%m%dT%H%M%SZ)
EOF
  log "cutover.state: фаза $CUTOVER_PHASE (кандидат $CUTOVER_CANDIDATE, миграция ${CUTOVER_MIGRATION:-?})"
}

# Архивирование (§3, шаг 11): активного состояния больше нет, а след релиза остаётся — без этого
# следующий cutover встретил бы чужой SHA. Исход сперва записывается в сам файл и только потом файл
# меняет имя: переименование атомарно, а обрыв между этими шагами оставляет активное состояние с
# записанным исходом — его разбирает возобновление, а не тишина.
cutover_state_archive() {
  local outcome="$1" archive="$STATE_DIR/cutover-$CUTOVER_CANDIDATE.state"
  [ "$CUTOVER_PHASE" = "$outcome" ] || cutover_state_write "$outcome"
  mv -f "$CUTOVER_STATE" "$archive"
  fsync_path "$STATE_DIR"
  log "cutover.state заархивирован → $(basename "$archive") ($outcome)"
}

# Документ границы: печатает объекты границ по одному в строке (пустой список — законное
# состояние). Коды: 0 — прочитан, 1 — файла нет, 2 — не читается или это не документ границы.
#
# Различать 1 и 2 обязательно: «границ ещё не было» и «границу потеряли» — разные ответы, и второй
# обязан ронять разрушительные режимы (§4). JSON разбирается grep'ом, а не jq: зависимости у
# скрипта нет ни одной сверх coreutils/docker/git, и заводить её ради гейта отката — значит
# сделать гейт необязательным ровно там, где её забыли поставить.
floor_entries() {
  local body stripped objs names
  [ -f "$SCHEMA_FLOOR_STATE" ] || return 1
  body="$(cat "$SCHEMA_FLOOR_STATE" 2>/dev/null)" || return 2
  printf '%s\n' "$body" | grep -q '"schemaVersion"[[:space:]]*:[[:space:]]*1' || return 2
  printf '%s\n' "$body" | grep -q '"floors"[[:space:]]*:[[:space:]]*\[' || return 2
  # Документ обязан быть дописан до конца: обрыв записи не должен читаться как «границ нет».
  stripped="$(printf '%s' "$body" | tr -d '[:space:]')"
  case "$stripped" in *']}') ;; *) return 2 ;; esac
  # Пишем по границе в строке, поэтому число строк с границей обязано сойтись с числом самих
  # границ: слипшиеся строки означают, что файл писал не этот скрипт, и читать его нечем.
  objs="$(printf '%s\n' "$body" | { grep -c '"migration"' || true; })"
  names="$(printf '%s\n' "$body" \
    | { grep -o '"migration"[[:space:]]*:[[:space:]]*"[^"]*"' || true; } | { grep -c . || true; })"
  [ "$objs" = "$names" ] || return 2
  printf '%s\n' "$body" | { grep '"migration"' || true; }
}

FLOOR_ENTRIES="" FLOOR_NAMES=""

# Гейт §4: разрушительный режим не идёт без читаемой границы, fail-closed. Пустой список границ
# при этом ничего не запрещает — он законен и означает «границ ещё не ставили».
floor_require() {
  local st=0
  FLOOR_ENTRIES="$(floor_entries)" || st=$?
  case "$st" in
    0) ;;
    1) REASON="нет $SCHEMA_FLOOR_STATE — граница совместимости неизвестна. Файл заводится однократно и дальше только дополняется, поэтому его отсутствие означает потерю, а не «границ не было». Восстановите его из снимка конфига ($CONFIG_DIR); переинициализировать нельзя"
       fail "$REASON" ;;
    *) REASON="$SCHEMA_FLOOR_STATE не читается как документ границы (повреждён или обрезан). Восстановите из снимка конфига ($CONFIG_DIR); деплой его не переписывает"
       fail "$REASON" ;;
  esac
  FLOOR_NAMES="$(printf '%s\n' "$FLOOR_ENTRIES" \
    | sed -n 's/.*"migration"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
}

# Однократная инициализация (§4). Право завести файл есть ровно у одного места — обычного деплоя —
# и ровно один раз: после этого отсутствие файла означает потерю. Отличить одно от другого скрипту
# нечем, поэтому рядом кладётся отметка о заведении, и «отметка есть, а файла нет» — авария, а не
# повод переинициализировать. Следами прежней жизни считаются и состояния cutover: границы пишет
# только он, и раз он на площадке был — файл заводили.
floor_bootstrap() {
  local st=0
  floor_entries >/dev/null || st=$?
  case "$st" in
    0) return 0 ;;
    2) REASON="$SCHEMA_FLOOR_STATE повреждён — деплой его не переписывает: восстановите из снимка конфига ($CONFIG_DIR)"
       fail "$REASON" ;;
  esac
  if [ -e "$FLOOR_STAMP" ] || ls "$STATE_DIR"/cutover*.state >/dev/null 2>&1; then
    REASON="$SCHEMA_FLOOR_STATE отсутствует, но площадка его уже заводила (см. $FLOOR_STAMP и состояния cutover в $STATE_DIR) — это ПОТЕРЯ границы, а не первый запуск. Восстановите файл из снимка конфига ($CONFIG_DIR)"
    fail "$REASON"
  fi
  printf '{\n  "schemaVersion": 1,\n  "floors": []\n}\n' | write_state_atomic "$SCHEMA_FLOOR_STATE"
  printf 'initialized_at=%s\nby_commit=%s\n' \
    "$(date -u +%Y%m%dT%H%M%SZ)" "$(git_c rev-parse --short HEAD 2>/dev/null || echo unknown)" \
    | write_state_atomic "$FLOOR_STAMP"
  log "заведена граница совместимости: $SCHEMA_FLOOR_STATE (floors: [])"
}

# Запись границы (§3, шаг 7) — точка невозврата. Документ заменяется целиком: дописывание строки
# оставило бы шанс прочитать половину записи как валидное состояние.
floor_append() {
  local migration="$1" sha="$2" at line body=""
  floor_require
  if printf '%s\n' "$FLOOR_NAMES" | grep -qxF "$migration"; then
    log "граница по $migration уже записана — повтор ничего не меняет"
    return 0
  fi
  at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  while read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"   # без ведущих пробелов
    line="${line%,}"                          # и без разделителя прежнего документа
    [ -n "$line" ] || continue
    body="$body    $line,"$'\n'
  done <<<"$FLOOR_ENTRIES"
  body="$body    { \"migration\": \"$migration\", \"sha\": \"$sha\", \"at\": \"$at\" }"$'\n'
  {
    printf '{\n  "schemaVersion": 1,\n  "floors": [\n'
    printf '%s' "$body"
    printf '  ]\n}\n'
  } | write_state_atomic "$SCHEMA_FLOOR_STATE"
  log "ГРАНИЦА ЗАПИСАНА: $migration (sha $sha) — откат ниже неё запрещён навсегда"
}

# Строки сводки --status: только чтение, ни одного отказа. Повреждённое состояние здесь именно
# показывается, а не роняет команду: --status зовут как раз затем, чтобы понять, что происходит.
cutover_status_line() {
  local st=0
  cutover_state_read || st=$?
  case "$st" in
    0) printf 'фаза %s, кандидат %s, миграция %s' \
         "$CUTOVER_PHASE" "$CUTOVER_CANDIDATE" "${CUTOVER_MIGRATION:-?}" ;;
    1) printf 'нет активного выката' ;;
    *) printf 'ПОВРЕЖДЁН %s' "$CUTOVER_STATE" ;;
  esac
}

floor_status_line() {
  local st=0 entries names
  entries="$(floor_entries)" || st=$?
  case "$st" in
    0) names="$(printf '%s\n' "$entries" \
         | sed -n 's/.*"migration"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | tr '\n' ' ')"
       if [ -n "${names// /}" ]; then printf 'границы: %s' "$names"
       else printf 'границ нет (floors: [])'; fi ;;
    1) printf 'НЕТ ФАЙЛА %s — разрушительные режимы заблокированы' "$SCHEMA_FLOOR_STATE" ;;
    *) printf 'ПОВРЕЖДЁН %s — разрушительные режимы заблокированы' "$SCHEMA_FLOOR_STATE" ;;
  esac
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
  echo "cutover  : $(cutover_status_line)"
  echo "схема    : $(floor_status_line)"
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
# Идёт необратимый выкат (или его откат): восстановление в recover обязано молчать и НЕ поднимать
# сервисы — старый код на новой схеме и есть то, ради чего протокол останавливает запись.
CUTOVER_ACTIVE=0 FLOOR_ADDED=""

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
    printf '  "config_snapshot": "%s",\n' "$(json_escape "$CFG_SNAPSHOT")"
    printf '  "vhost_sync": "%s",\n'     "$(json_escape "$VHOST_SYNC")"
    printf '  "dump_file": "%s",\n'     "$(json_escape "$DUMP_FILE")"
    printf '  "pre_restore_dump": "%s",\n' "$(json_escape "$PRE_RESTORE_DUMP")"
    printf '  "cache_freed": "%s",\n'   "$(json_escape "$CACHE_FREED")"
    printf '  "cutover_phase": "%s",\n' "$(json_escape "$CUTOVER_PHASE")"
    printf '  "floor_added": "%s",\n'   "$(json_escape "$FLOOR_ADDED")"
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

  if [ "$CUTOVER_ACTIVE" -eq 1 ]; then
    # Единственное восстановление, которое здесь допустимо, — никакого. Поднять сервисы значит
    # свести старый код с новой схемой (или наоборот), а именно от этого протокол и защищает.
    warn "необратимый выкат прерван на фазе ${CUTOVER_PHASE:-<нет>} — сервисы ОСТАВЛЕНЫ как есть."
    warn "состояние: $CUTOVER_STATE (граница: $SCHEMA_FLOOR_STATE)"
    warn "продолжить с того же места: deploy-auto --cutover"
    warn "откат (пока фаза migrated и граница НЕ записана): deploy-auto --cutover-revert"
  elif [ "$RESTORE_DB_TOUCHED" -eq 1 ]; then
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
  # State-файлы едут вместе с конфигом (протокол §4): потерять «вечную» границу совместимости при
  # переносе площадки — значит потерять её навсегда, а вместе с ней и запрет отката за неё. Отметка
  # о заведении границы лежит рядом по той же причине: без неё восстановленная площадка сочла бы
  # отсутствие границы первым запуском и завела бы пустую.
  local states=()
  local st
  for st in "$RELEASE_STATE" "$SCHEMA_FLOOR_STATE" "$FLOOR_STAMP"; do
    [ -r "$st" ] && states+=("$(basename "$st")")
  done
  ( umask 077; tar -czf "$out" \
      -C / ${abs[@]+"${abs[@]}"} \
      -C "$STATE_DIR" ${states[@]+"${states[@]}"} \
      -C "$PORTAL_DIR" "$REPO_VHOST" )
  chmod 600 "$out"
  log "снимок конфига: config-backups/$CFG_SNAPSHOT"
  # Ротация keep-2. `|| true` обязателен: без совпадений ls→2, pipefail+set -e убьют скрипт.
  # shellcheck disable=SC2012
  ls -1t "$CONFIG_DIR"/config-*.tar.gz 2>/dev/null | tail -n +$((KEEP_CONFIGS + 1)) | xargs -r rm -f || true
}

# Ротация дампов. Закреплённые (`<дамп>.pin`) выпадают из счёта ДО применения keep-2, а не после:
# закрепление ставит cutover на предмиграционный дамп, и «два последних» иначе вытеснили бы
# единственный дамп, к которому откат ещё разрешён, — обычным деплоем, через пару релизов, молча.
# Вместе с дампом снимаются его спутники: .meta и снимок state-файлов, сделанный после границы.
rotate_dumps() {
  local kept=0 old
  while read -r old; do
    [ -n "$old" ] || continue
    if [ -e "${old%.dump}.pin" ]; then continue; fi
    kept=$((kept + 1))
    [ "$kept" -le "$KEEP_DUMPS" ] && continue
    rm -f "$old" "${old%.dump}.meta" \
      "${old%.dump}.release.state" "${old%.dump}.schema-floor.state"
  done < <(ls -1t "$BACKUP_DIR"/[0-9]*.dump 2>/dev/null || true)
  # shellcheck disable=SC2012
  ls -1t "$BACKUP_DIR"/prerestore-*.dump 2>/dev/null | tail -n +2 | while read -r old; do
    rm -f "$old" "${old%.dump}.meta"
  done || true
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

# ---------------------------------------------------------------------------
# Составы миграций: чем отвечают на вопросы «что умеет этот код» и «что накатано сейчас».
# Списки — имена файлов по строке; сравниваются множествами (comm), а не строками.
# ---------------------------------------------------------------------------
list_clean() { printf '%s\n' "$1" | sed '/^[[:space:]]*$/d' | sort -u; }
list_minus() { comm -23 <(list_clean "$1") <(list_clean "$2"); }
list_count() { list_clean "$1" | { grep -c . || true; }; }
list_brief() { list_clean "$1" | head -5 | tr '\n' ' '; }

# Миграции, которые несёт образ $1 (файлы в нём). Спрашивается у образа, а не у журнала базы
# (§4.1): журнал отвечает «что накатано сейчас», а нам нужно «умеет ли этот код жить с такой
# схемой». Код 1 — ответа нет (образа нет, запуск упал): гейты трактуют это как отказ.
image_migration_files() {
  local raw
  raw="$(TAG="$1" "${COMPOSE[@]}" run --rm -T migrate \
    pnpm --silent --filter @technic/api db:migrate:files 2>&1 || true)"
  printf '%s\n' "$raw" | grep -q '^files ok$' || return 1
  printf '%s\n' "$raw" | { grep -E '^file ' || true; } | cut -d' ' -f2-
}

JOURNAL_APPLIED="" JOURNAL_PENDING="" JOURNAL_MISSING=""

# Журнал базы глазами образа $1. Fail-closed: недочитанный вывод — отказ, а не «списки пусты».
# Маркер `journal ok` для того и печатается: пустой ответ упавшей команды иначе прочитался бы как
# «неприменённых миграций нет», то есть как разрешение.
read_journal() {
  local raw
  raw="$(TAG="$1" "${COMPOSE[@]}" run --rm -T migrate \
    pnpm --silent --filter @technic/api db:migrate:journal 2>&1 || true)"
  if ! printf '%s\n' "$raw" | grep -q '^journal ok$'; then
    REASON="не удалось прочитать журнал миграций образом $1 (нет образа или недоступна БД)"
    fail "$REASON"
  fi
  JOURNAL_APPLIED="$(printf '%s\n' "$raw" | { grep -E '^applied ' || true; } | cut -d' ' -f2-)"
  JOURNAL_PENDING="$(printf '%s\n' "$raw" | { grep -E '^pending ' || true; } | cut -d' ' -f2-)"
  JOURNAL_MISSING="$(printf '%s\n' "$raw" | { grep -E '^missing ' || true; } | cut -d' ' -f2-)"
}

# .meta дампа: $1 — имя дампа, $2 — метка времени, $3 — коммит, ради которого дамп снят.
# Состав миграций здесь не справка, а предмет гейта §5 — по нему сверяется, той ли схеме
# принадлежит дамп. Берётся из JOURNAL_APPLIED, прочитанного непосредственно перед дампом.
# created_at остаётся человеку («когда»), решать по нему нельзя: точность метки — секунда, а
# предмиграционный дамп снимается ровно перед миграцией и уложится в ту же секунду.
write_dump_meta() {
  local dump="$1" ts="$2" target="$3" meta="$BACKUP_DIR/${1%.dump}.meta" names
  names="$(list_clean "$JOURNAL_APPLIED")"
  {
    printf 'created_at=%s\n'        "$ts"
    printf 'target_commit=%s\n'     "$target"
    printf 'current_before=%s\n'    "$CURRENT_BEFORE"
    printf 'migrations_count=%s\n'  "$(list_count "$JOURNAL_APPLIED")"
    printf 'migrations_sha256=%s\n' "$(printf '%s\n' "$names" | sha256sum | cut -d' ' -f1)"
    printf '%s\n' "$names" | sed '/^$/d; s/^/migration=/'
  } >"$meta"
  chmod 600 "$meta"
}

# Закрепление дампа от ротации (§3, шаг 3). Пока файл `.pin` рядом, keep-2 дамп не тронет.
pin_dump() {
  local pin="$BACKUP_DIR/${1%.dump}.pin"
  {
    printf 'reason=cutover\n'
    printf 'candidate=%s\n' "$CUTOVER_CANDIDATE"
    printf 'migration=%s\n' "$CUTOVER_MIGRATION"
    printf 'pinned_at=%s\n' "$(date -u +%Y%m%dT%H%M%SZ)"
  } >"$pin"
  chmod 600 "$pin"
  log "  дамп закреплён от ротации: $(basename "$pin")"
}

# Снимок state-файлов рядом с закреплённым дампом (§4). Обычный snapshot_config снимается ДО pull,
# то есть до миграции: после первого же cutover последний снимок содержал бы floors: [] — ровно то
# состояние, от которого граница защищает. Поэтому снимок повторяется после КАЖДОЙ записи границы,
# под тем же `.pin`, и переживает ротацию вместе с дампом.
pin_state_snapshot() {
  local base="$BACKUP_DIR/${1%.dump}"
  # Снимок кладётся ПОД закрепление дампа — без имени дампа его нечем защитить от ротации, и
  # молчаливая копия под именем-обрубком создала бы видимость сделанного.
  [ -n "$1" ] || {
    REASON="снимок состояния некуда положить: в $CUTOVER_STATE нет имени закреплённого дампа"
    fail "$REASON"; }
  cp -f "$SCHEMA_FLOOR_STATE" "$base.schema-floor.state" \
    || { REASON="не удалось положить снимок границы рядом с дампом $1"; fail "$REASON"; }
  chmod 600 "$base.schema-floor.state"
  if [ -f "$RELEASE_STATE" ]; then
    cp -f "$RELEASE_STATE" "$base.release.state"
    chmod 600 "$base.release.state"
  fi
  fsync_path "$BACKUP_DIR"
  log "  снимок состояния рядом с дампом: $(basename "$base").{schema-floor,release}.state"
}

# «Контейнеры подняты» — это тег их образов, а не факт запуска: наполовину поднятый набор иначе
# сошёл бы за поднятый, и возобновление пропустило бы шаг подъёма (§3.1).
containers_at_tag() {
  local tag="$1" c img running
  for c in "${SERVICES[@]}"; do
    img="$(docker inspect -f '{{.Config.Image}}' "$c" 2>/dev/null || true)"
    running="$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || true)"
    { [ "$img" = "$c:$tag" ] && [ "$running" = "true" ]; } || return 1
  done
  return 0
}

# ---------------------------------------------------------------------------
# Гейты разрушительных режимов (§3.2, §4.1, §5).
# ---------------------------------------------------------------------------

# Пока выкат не прошёл точку невозврата, откатывать нечего и незачем: откат схемы делает его
# собственный режим (--cutover-revert), а --previous/--restore-db прошли бы мимо состояния.
cutover_guard_destructive() {
  cutover_phase_or_fail
  case "$CUTOVER_PHASE" in
    migrating|migrated)
      REASON="идёт необратимый выкат $CUTOVER_CANDIDATE (фаза $CUTOVER_PHASE): продолжите его — deploy-auto --cutover, либо откатите — deploy-auto --cutover-revert"
      fail "$REASON" ;;
  esac
}

# §4.1: целевой образ обязан содержать ВСЕ миграции границы. Проверяется по самому образу —
# запись в журнале без файла на диске это `missing`, «код старше базы», и сервер с ней не встанет.
floor_gate_previous() {
  local tag="$1" files lack
  [ -n "$FLOOR_NAMES" ] || { log "  граница: floors пуст — откат кода ничем не ограничен"; return 0; }
  files="$(image_migration_files "$tag")" \
    || { REASON="не удалось прочитать состав миграций образа $tag — гейт границы fail-closed"; fail "$REASON"; }
  lack="$(list_minus "$FLOOR_NAMES" "$files")"
  [ -z "$lack" ] || {
    REASON="образ $tag не знает миграций границы: $(list_brief "$lack")— откат ниже границы совместимости запрещён навсегда (протокол §4)"
    fail "$REASON"; }
  log "  граница: образ $tag содержит все миграции floors ($(list_count "$FLOOR_NAMES") шт)"
}

# §5: дамп сверяется СОСТАВОМ миграций, а не временем. Время не годится — метка дампа имеет
# точность в секунду, и предмиграционный дамп пройдёт проверку «не раньше границы» на той же
# секунде, ради которой она заведена.
restore_gate() {
  local dump="$1" tag="$2" meta="$BACKUP_DIR/${1%.dump}.meta" dump_set image_set lack extra newer
  [ -f "$meta" ] || {
    REASON="у дампа $dump нет .meta — состав миграций неизвестен. Прежнее «метки неизвестны» было предупреждением; для гейта такого допуска нет: разрешённый путь отката схемы — PITR"
    fail "$REASON"; }
  dump_set="$(grep -E '^migration=' "$meta" | cut -d= -f2- || true)"
  [ -n "$dump_set" ] || {
    REASON="в $meta нет состава миграций: дамп снят версией deploy-auto до протокола выката. Сверить его с образом нечем — откат схемы только через PITR"
    fail "$REASON"; }

  # 1. Все границы обязаны быть в дампе, иначе восстановление вернёт схему за границу.
  lack="$(list_minus "$FLOOR_NAMES" "$dump_set")"
  [ -z "$lack" ] || {
    REASON="дамп $dump снят ДО границы совместимости: в нём нет $(list_brief "$lack")— восстановление вернуло бы схему за границу (протокол §4)"
    fail "$REASON"; }

  # 2. Набор дампа В ТОЧНОСТИ равен набору целевого образа. Не «образ содержит всё из дампа»:
  #    лишние миграции образа после восстановления станут pending, db:migrate:check вернёт 3, и
  #    сервис не поднимется. Накатывать недостающее прямо здесь нельзя — откат превратился бы в
  #    миграцию; «восстановить старый дамп и доехать миграциями» остаётся отдельной процедурой.
  image_set="$(image_migration_files "$tag")" \
    || { REASON="не удалось прочитать состав миграций образа $tag — гейт restore fail-closed"; fail "$REASON"; }
  lack="$(list_minus "$image_set" "$dump_set")"
  extra="$(list_minus "$dump_set" "$image_set")"
  [ -z "$lack" ] || {
    REASON="образ $tag ждёт схему с миграциями, которых в дампе нет: $(list_brief "$lack")— после restore они станут pending и сервис не стартует"
    fail "$REASON"; }
  [ -z "$extra" ] || {
    REASON="в дампе есть миграции, которых нет в образе $tag: $(list_brief "$extra")— после restore журнал сослался бы на отсутствующие файлы (missing)"
    fail "$REASON"; }

  # 3. Текущая схема не содержит миграций новее дампа: pg_restore --clean дропает только объекты
  #    ИЗ архива, и восстановление оставило бы гибрид.
  read_journal "$tag"
  newer="$(list_minus "$JOURNAL_APPLIED" "$dump_set")"
  [ -z "$newer" ] || {
    REASON="текущая схема новее дампа (лишние миграции: $(list_brief "$newer")) — pg_restore --clean их не снимет и оставит гибрид. Выходы: PITR либо явный teardown лишнего"
    fail "$REASON"; }

  log "  состав дампа сверен: $(list_count "$dump_set") миграций, совпадает с образом $tag"
}

# ---------------------------------------------------------------------------
# Необратимый выкат: --cutover (§3) и --cutover-revert (§3.3).
# ---------------------------------------------------------------------------

CUTOVER_VERIFY=""

# Верификатор релиза (§3, шаг 6). Своих проверок у механики нет — их приносит релиз: команда
# объявляется файлом рядом с teardown и выполняется ВНУТРИ образа кандидата. AUTO_CUTOVER_VERIFY
# перебивает файл — этим пользуется репетиция на копии базы (§9).
#
# Необъявленный верификатор — отказ: шаг 6 fail-closed, и «проверять нечего» релиз обязан написать
# явно (файл со строкой `true`), а не оставить пустым местом, которое молча пропустит границу.
cutover_verifier() {
  local file="$TEARDOWN_DIR/$CUTOVER_MIGRATION.verify"
  if [ -n "${AUTO_CUTOVER_VERIFY:-}" ]; then
    CUTOVER_VERIFY="$AUTO_CUTOVER_VERIFY"
    return 0
  fi
  [ -f "$file" ] || {
    REASON="релиз не объявил верификатор: нет $file (и пуст AUTO_CUTOVER_VERIFY). Шаг 6 протокола fail-closed — без проверки данных граница не пишется"
    fail "$REASON"; }
  CUTOVER_VERIFY="$(grep -vE '^[[:space:]]*(#|$)' "$file" | head -1 || true)"
  [ -n "$CUTOVER_VERIFY" ] || { REASON="$file пуст — верификатор не объявлен"; fail "$REASON"; }
}

# Есть ли миграция $1 в списке $2 (список — имена по строке).
list_has() { printf '%s\n' "$2" | grep -qxF "$1"; }

# State-машина выката. Возобновляема: после любого обрыва повтор сверяет журнал миграций, границу
# и фазу — и пропускает сделанное. Из функции не возвращается: заканчивает деплой сама.
cutover_run() {
  local st=0 step=1 in_journal=0 in_floor=0 pending_count dump_ts repo
  CUTOVER_ACTIVE=1

  # Граница обязана быть читаемой до всего остального: шаг 7 будет писать именно в неё, и узнать
  # об этом, остановив сервисы и накатив миграцию, — худший момент из возможных.
  floor_require

  cutover_state_read || st=$?
  case "$st" in
    0|1) ;;
    *) REASON="$CUTOVER_STATE не читается: нет фазы или SHA кандидата — разбирает человек"
       fail "$REASON" ;;
  esac
  if [ -n "$CUTOVER_PHASE" ]; then
    # SHA кандидата при возобновлении обязан совпасть с текущим: незавершённый выкат продолжают
    # тем же коммитом, иначе «продолжение» накатило бы чужой релиз в чужое окно.
    [ "$CUTOVER_CANDIDATE" = "$COMMIT_SHA" ] || {
      REASON="в $CUTOVER_STATE кандидат $CUTOVER_CANDIDATE, а собран $COMMIT_SHA — незавершённый выкат продолжают ТЕМ ЖЕ коммитом"
      fail "$REASON"; }
  fi

  read_journal "$COMMIT_SHA"
  if [ -n "$CUTOVER_MIGRATION" ]; then
    list_has "$CUTOVER_MIGRATION" "$JOURNAL_APPLIED" && in_journal=1
    list_has "$CUTOVER_MIGRATION" "$FLOOR_NAMES" && in_floor=1
  fi

  case "${CUTOVER_PHASE:-none}" in
    none)
      # Активного состояния нет. Если этот SHA уже проходил cutover — релиз завершён, и
      # следующий выкат идёт обычным деплоем.
      [ -f "$STATE_DIR/cutover-$COMMIT_SHA.state" ] && {
        REASON="выкат $COMMIT_SHA уже завершён (см. $STATE_DIR/cutover-$COMMIT_SHA.state) — следующий релиз выкатывается обычным deploy-auto"
        fail "$REASON"; }
      step=1 ;;
    migrating)
      if [ "$in_journal" -eq 1 ]; then
        log "миграция уже в журнале, а фаза осталась migrating — обрыв между накатом и записью, чиню фазу"
        cutover_state_write migrated
        step=6
      else
        log "обрыв до наката (фаза migrating) — продолжаю с дампа"
        step=3
      fi ;;
    migrated)
      if [ "$in_journal" -eq 0 ]; then
        [ "$in_floor" -eq 0 ] || {
          REASON="граница по $CUTOVER_MIGRATION записана, а миграции в журнале нет — состояние невозможное по построению, разбирает человек"
          fail "$REASON"; }
        log "миграции в журнале нет — это след успешного --cutover-revert; состояние очищается, выкат начинается заново"
        rm -f "$CUTOVER_STATE"
        CUTOVER_PHASE="" CUTOVER_MIGRATION="" CUTOVER_DUMP=""
        step=1
      elif [ "$in_floor" -eq 1 ]; then
        log "граница записана, а фаза осталась migrated — обрыв сразу после точки невозврата, чиню фазу"
        cutover_state_write irreversible
        step=9
      else
        log "возобновление с верификатора (фаза migrated)"
        step=6
      fi ;;
    irreversible)
      log "возобновление после точки невозврата: доподнимаю сервисы и повторяю health"
      step=9 ;;
    'done')
      log "обрыв на архивировании (фаза done) — архивирую состояние"
      step=11 ;;
    superseded)
      REASON="выкат $CUTOVER_CANDIDATE перекрыт обычным деплоем (superseded) — продолжать нечего; состояние архивируется ближайшим деплоем"
      fail "$REASON" ;;
    *)
      REASON="$CUTOVER_STATE: неизвестная фаза '$CUTOVER_PHASE'"
      fail "$REASON" ;;
  esac

  # --- Шаг 1: сверка бандла. До всякого действия и, главное, до остановки сервисов. ---
  if [ "$step" -le 1 ]; then
    [ "$(list_count "$JOURNAL_MISSING")" -eq 0 ] || {
      REASON="журнал ссылается на отсутствующие в образе файлы: $(list_brief "$JOURNAL_MISSING")— база новее кода, cutover не начинается"
      fail "$REASON"; }
    pending_count="$(list_count "$JOURNAL_PENDING")"
    case "$pending_count" in
      0) REASON="неприменённых миграций нет — выкатывать нечего. Если миграцию накатили мимо cutover, разбирать это скрипту нечем"
         fail "$REASON" ;;
      1) CUTOVER_MIGRATION="$(list_clean "$JOURNAL_PENDING")" ;;
      *) REASON="неприменённых миграций $pending_count ($(list_brief "$JOURNAL_PENDING")): бандл необратимого выката — ровно одна миграция (протокол §6). Сначала выкатите остальные обычным деплоем"
         fail "$REASON" ;;
    esac
    CUTOVER_CANDIDATE="$COMMIT_SHA"
    CUTOVER_STARTED="$(date -u +%Y%m%dT%H%M%SZ)"
    log "бандл: $CUTOVER_MIGRATION (кандидат $COMMIT_SHA)"
    # Верификатор и teardown спрашиваются ЗДЕСЬ, пока сервисы работают: узнать, что релиз их не
    # привёз, посреди окна обслуживания — значит остаться и без проверки, и без отката.
    cutover_verifier
    [ -f "$TEARDOWN_DIR/$CUTOVER_MIGRATION" ] || {
      REASON="релиз не привёз teardown: нет $TEARDOWN_DIR/$CUTOVER_MIGRATION. Без него --cutover-revert невозможен, а он — единственный откат до записи границы (протокол §7)"
      fail "$REASON"; }
    log "  верификатор: $CUTOVER_VERIFY"
    log "  teardown:    apps/api/teardown/$CUTOVER_MIGRATION"
    step=2
  fi

  # --- Шаг 2: остановка записи. technic-web остаётся: снаружи честные 502, а не белый экран. ---
  if [ "$step" -le 2 ]; then
    log "стоп technic-api и technic-worker — запись прекращена (окно обслуживания)"
    "${COMPOSE[@]}" stop technic-api technic-worker || true
    SERVICES_STOPPED=1
  fi

  # --- Шаг 3: дамп + .meta с составом миграций + закрепление от ротации. ---
  if [ "$step" -le 3 ]; then
    ensure_db_tools_image
    check_dump_space
    dump_ts="$(date -u +%Y%m%dT%H%M%SZ)"
    DUMP_FILE="${dump_ts}-${COMMIT_SHA}.dump"
    log "предмиграционный дамп: db-backups/$DUMP_FILE"
    db_tools_dump "$DUMP_FILE" || { REASON="дамп БД провалился — миграция не запускалась"; fail "$REASON"; }
    chmod 600 "$BACKUP_DIR/$DUMP_FILE"
    write_dump_meta "$DUMP_FILE" "$dump_ts" "$COMMIT_SHA"
    # Прежний дамп той же попытки перестаёт быть предмиграционным состоянием: между попытками
    # база могла измениться. Закрепление с него снимается, и он возвращается в обычный keep-2.
    if [ -n "$CUTOVER_DUMP" ] && [ "$CUTOVER_DUMP" != "$DUMP_FILE" ]; then
      rm -f "$BACKUP_DIR/${CUTOVER_DUMP%.dump}.pin"
      log "  закрепление снято с прежнего дампа попытки: $CUTOVER_DUMP"
    fi
    CUTOVER_DUMP="$DUMP_FILE"
    pin_dump "$DUMP_FILE"
    rotate_dumps
    step=4
  fi

  # --- Шаг 4: фаза migrating — ДО наката. Обрыв между применением и записью иначе оставил бы
  # миграцию, о которой состояние не знает, и возобновлять было бы не от чего. ---
  if [ "$step" -le 4 ]; then
    cutover_state_write migrating
  fi

  # --- Шаг 5: накат бандла. ---
  if [ "$step" -le 5 ]; then
    log "накат миграции $CUTOVER_MIGRATION (образ $COMMIT_SHA)"
    MIGRATION_ATTEMPTED=1
    "${COMPOSE[@]}" run --rm -T migrate || { REASON="миграция провалилась"; fail "$REASON"; }
    MIGRATION_ATTEMPTED=0
    cutover_state_write migrated
  fi

  # --- Шаг 6: верификатор, fail-closed. Ненулевой код — сервисы остаются лежать, фаза migrated,
  # откат ещё возможен. ---
  if [ "$step" -le 6 ]; then
    [ -n "$CUTOVER_VERIFY" ] || cutover_verifier
    log "верификатор релиза: $CUTOVER_VERIFY"
    "${COMPOSE[@]}" run --rm -T migrate sh -c "$CUTOVER_VERIFY" || {
      REASON="верификатор релиза не прошёл — граница НЕ записана, сервисы оставлены лежащими. Откат: deploy-auto --cutover-revert"
      fail "$REASON"; }
    log "верификатор: чисто"
  fi

  # --- Шаг 7: запись границы — ТОЧКА НЕВОЗВРАТА. Порядок 7→8 обязателен: обратный оставлял бы
  # щель, где фаза уже запрещает откат, а постоянной границы ещё нет. ---
  if [ "$step" -le 7 ]; then
    floor_append "$CUTOVER_MIGRATION" "$COMMIT_SHA"
    FLOOR_ADDED="$CUTOVER_MIGRATION"
    pin_state_snapshot "$CUTOVER_DUMP"
    # --- Шаг 8: фаза irreversible. ---
    cutover_state_write irreversible
  fi

  # --- Шаг 9: подъём и health-гейт. ---
  if [ "$step" -le 9 ]; then
    if containers_at_tag "$COMMIT_SHA"; then
      log "контейнеры уже подняты на $COMMIT_SHA"
    else
      log "up -d: ${SERVICES[*]} (тег $COMMIT_SHA)"
      "${COMPOSE[@]}" up -d "${SERVICES[@]}" || { REASON="запуск сервисов провалился"; fail "$REASON"; }
    fi
    SERVICES_STOPPED=0
    [ "$CURRENT_BEFORE" = "$COMMIT_SHA" ] || write_release_state "$CURRENT_BEFORE" "$COMMIT_SHA"

    if ! health_check; then
      # Выкат не заперт: схема уже новая, и повтор --cutover прогонит health заново, а обычный
      # деплой с новым SHA — законный forward-fix (§3.2).
      RESULT="degraded"
      CUTOVER_ACTIVE=0
      warn "health НЕ подтверждён за 5 попыток. Схема уже новая, состояние — irreversible:"
      warn "  повторить health:  deploy-auto --cutover"
      warn "  вылечить кодом:    deploy-auto (обычный деплой нового SHA; состояние закроется как superseded)"
      warn "  Логи: ${COMPOSE[*]} logs --tail=50 technic-api"
      write_report; trap - EXIT
      exit 1
    fi
    for repo in "${IMAGES[@]}"; do docker tag "$repo:$COMMIT_SHA" "$repo:latest"; done
    BUILT_TAG=""
    # --- Шаг 10: фаза done. ---
    cutover_state_write 'done'
  fi

  # --- Шаг 11: архивирование. ---
  cutover_state_archive 'done'
  CUTOVER_ACTIVE=0

  sync_vhost
  if curl -fsSI -m 10 "$HEALTH_EXTERNAL" >/dev/null 2>&1; then
    log "внешний health: ok ($HEALTH_EXTERNAL)"
  else
    warn "внешний health недоступен ($HEALTH_EXTERNAL) — проверьте infra-nginx/TLS/DNS."
  fi
  prune_images
  prune_cache

  RESULT="ok"; write_report; trap - EXIT
  log "Готово (необратимый выкат): technic @ $COMMIT_SHA, граница $CUTOVER_MIGRATION"
  exit 0
}

# ===========================================================================
# --cutover-revert: откат незавершённого выката (§3.3).
# Разрешён тогда и только тогда, когда фаза ровно `migrated`, а миграции бандла нет во floor.
# Второе условие и закрывает обрыв между шагами 7 и 8: граница уже стоит, фаза ещё нет — откат
# запрещён, чинится вперёд. Ни pull, ни сборки здесь нет: образ кандидата уже собран cutover'ом,
# а teardown читается из него же.
# ===========================================================================
if [ "$DO_CUTOVER_REVERT" -eq 1 ]; then
  CUTOVER_ACTIVE=1
  floor_require

  st=0
  cutover_state_read || st=$?
  case "$st" in
    0) ;;
    1) REASON="активного выката нет ($CUTOVER_STATE отсутствует) — откатывать нечего"; fail "$REASON" ;;
    *) REASON="$CUTOVER_STATE не читается: нет фазы или SHA кандидата — разбирает человек"; fail "$REASON" ;;
  esac
  [ "$CUTOVER_PHASE" = "migrated" ] || {
    REASON="фаза $CUTOVER_PHASE: откат разрешён только на фазе migrated (протокол §3.3). После записи границы дороги назад нет — чините вперёд: deploy-auto --cutover либо обычный deploy-auto"
    fail "$REASON"; }
  if list_has "$CUTOVER_MIGRATION" "$FLOOR_NAMES"; then
    REASON="граница по $CUTOVER_MIGRATION уже записана — точка невозврата пройдена, откат запрещён навсегда; чините вперёд: deploy-auto --cutover"
    fail "$REASON"
  fi
  [ -n "$CUTOVER_MIGRATION" ] || { REASON="в $CUTOVER_STATE нет имени миграции — откатывать нечего"; fail "$REASON"; }

  TARGET_TAG="${CURRENT_BEFORE:-latest}"
  ACTION="cutover_revert"
  # Teardown приезжает вместе с миграцией — в предыдущем образе его ещё нет, поэтому запускает его
  # образ кандидата.
  docker image inspect "technic-api:$CUTOVER_CANDIDATE" >/dev/null 2>&1 || {
    REASON="нет образа technic-api:$CUTOVER_CANDIDATE — teardown запускается образом кандидата, откат невозможен"
    fail "$REASON"; }

  # Сервисы обязаны лежать: запись во время отката схемы означала бы потерю данных без следа.
  for c in technic-api technic-worker; do
    if [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || true)" = "true" ]; then
      REASON="$c запущен, а откат идёт при остановленной записи. Остановите: ${COMPOSE[*]} stop technic-api technic-worker"
      fail "$REASON"
    fi
  done

  read_journal "$CUTOVER_CANDIDATE"
  [ "$(list_count "$JOURNAL_MISSING")" -eq 0 ] || {
    REASON="журнал ссылается на отсутствующие в образе кандидата файлы: $(list_brief "$JOURNAL_MISSING")— это не тот образ или не тот журнал"
    fail "$REASON"; }

  if list_has "$CUTOVER_MIGRATION" "$JOURNAL_APPLIED"; then
    # Применён ровно бандл: посторонняя неприменённая миграция означает, что рядом с нашей приехала
    # чужая, и снятие одной оставило бы вторую в журнале без файла.
    [ "$(list_count "$JOURNAL_PENDING")" -eq 0 ] || {
      REASON="рядом с бандлом есть неприменённые миграции: $(list_brief "$JOURNAL_PENDING")— состав не совпадает с бандлом, откат не начинается"
      fail "$REASON"; }
    [ -f "$BACKUP_DIR/$CUTOVER_DUMP" ] || {
      REASON="закреплённый дамп $CUTOVER_DUMP не найден в $BACKUP_DIR — откат без него делать нечем (teardown упадёт, а вернуться будет некуда)"
      fail "$REASON"; }

    log "teardown $CUTOVER_MIGRATION образом кандидата $CUTOVER_CANDIDATE (одной транзакцией со снятием записи журнала)"
    TAG="$CUTOVER_CANDIDATE" "${COMPOSE[@]}" run --rm -T migrate \
      pnpm --silent --filter @technic/api db:cutover-down "$CUTOVER_MIGRATION" \
      || { REASON="teardown провалился — транзакция откачена, база осталась с миграцией. Сервисы оставлены лежащими"; fail "$REASON"; }
  else
    log "миграции $CUTOVER_MIGRATION в журнале нет — teardown уже выполнен, повтор его пропускает"
  fi

  log "up -d --no-build (тег $TARGET_TAG): ${SERVICES[*]}"
  TAG="$TARGET_TAG" "${COMPOSE[@]}" up -d --no-build "${SERVICES[@]}" \
    || { REASON="запуск сервисов на $TARGET_TAG провалился"; fail "$REASON"; }
  health_check || warn "health не подтверждён — сервисы подняты на $TARGET_TAG, смотрите логи"

  # Успешный откат СНИМАЕТ состояние: активного выката больше нет, и следующий --cutover начинается
  # с чистого листа. Закрепление дампа тоже снимается — предмиграционным состоянием стало текущее.
  rm -f "$CUTOVER_STATE" "$BACKUP_DIR/${CUTOVER_DUMP%.dump}.pin"
  fsync_path "$STATE_DIR"
  CUTOVER_PHASE="" CUTOVER_ACTIVE=0
  rotate_dumps

  RESULT="ok"; write_report; trap - EXIT
  log "Готово (откат выката): миграция $CUTOVER_MIGRATION снята, technic @ $TARGET_TAG"
  exit 0
fi

# ===========================================================================
# Режимы отката: --previous и/или --restore-db.
# ===========================================================================
if [ "$ROLLBACK_MODE" -eq 1 ]; then
  # Гейты протокола — до всего остального: пока идёт cutover, откат идёт его собственным режимом
  # (§3.2), а без читаемой границы совместимости разрушительные режимы не работают вовсе (§4).
  cutover_guard_destructive
  floor_require

  if [ "$DO_PREVIOUS" -eq 1 ]; then
    [ -n "$PREVIOUS_BEFORE" ] || { REASON="в $RELEASE_STATE нет previous= — откатываться не на что"; fail "$REASON"; }
    TARGET_TAG="$PREVIOUS_BEFORE"
    for repo in "${IMAGES[@]}"; do
      docker image inspect "$repo:$TARGET_TAG" >/dev/null 2>&1 || {
        REASON="образ $repo:$TARGET_TAG не найден локально (вычищен ретеншном?) — быстрый откат невозможен"
        fail "$REASON"; }
    done
    floor_gate_previous "$TARGET_TAG"
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

    # Гейт §5 — ДО подтверждения и до любого разрушительного действия: дамп сверяется составом
    # миграций (с границей, с целевым образом и с текущей схемой), а не временем снятия.
    restore_gate "$DUMP_FILE" "$TARGET_TAG"

    META="${DUMP_PATH%.dump}.meta"
    META_CREATED="" META_TARGET=""
    META_CREATED="$(grep -E '^created_at=' "$META" | cut -d= -f2- || true)"
    META_TARGET="$(grep -E '^target_commit=' "$META" | cut -d= -f2- || true)"

    ensure_db_tools_image
    echo
    echo "  ВОССТАНОВЛЕНИЕ БД ИЗ ДАМПА (destructive)"
    echo "  Файл:         $DUMP_FILE"
    echo "  Снят (UTC):   ${META_CREATED:-неизвестно}"
    echo "  Перед миграцией на код: ${META_TARGET:-?}"
    echo "  Состав схемы: сверен с образом $TARGET_TAG (протокол §5)"
    echo "  ВСЕ ДАННЫЕ, записанные в БД ПОСЛЕ снятия дампа, будут ПОТЕРЯНЫ."
    echo "  Внимание: pg_restore --clean дропает лишь объекты ИЗ архива; объекты, созданные"
    echo "  более новой миграцией, могут остаться. Гарантированный откат схемы — Yandex PITR"
    echo "  на метку ${META_CREATED:-<до деплоя>} (UTC)."
    echo "  Загруженные в S3 файлы дамп НЕ покрывает — ссылки в БД и объекты могут разойтись."
    confirm_tty "--restore-db"

    log "стоп сервисов на время восстановления (полное окно обслуживания; снаружи 502)"
    "${COMPOSE[@]}" stop "${SERVICES[@]}" || true
    SERVICES_STOPPED=1

    PRE_RESTORE_TS="$(date -u +%Y%m%dT%H%M%SZ)"
    PRE_RESTORE_DUMP="prerestore-$PRE_RESTORE_TS.dump"
    log "аварийный дамп текущего состояния: db-backups/$PRE_RESTORE_DUMP"
    db_tools_dump "$PRE_RESTORE_DUMP" \
      || { REASON="pre-restore дамп провалился — восстановление НЕ начиналось, БД не тронута"; fail "$REASON"; }
    chmod 600 "$BACKUP_DIR/$PRE_RESTORE_DUMP" || true
    # .meta и у аварийного дампа: без состава миграций гейт §5 не пропустит его обратно, и дамп,
    # снятый специально «на случай чего», оказался бы невосстановимым ровно в этот случай.
    # JOURNAL_APPLIED прочитан гейтом выше — запись остановлена, состав с тех пор не изменился.
    write_dump_meta "$PRE_RESTORE_DUMP" "$PRE_RESTORE_TS" "$TARGET_TAG"

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

# §3.2: пока выкат не прошёл точку невозврата, обычный деплой заблокирован — он накатывает
# миграции ДО остановки сервисов и тем самым обошёл бы окно обслуживания, ради которого всё
# затевалось. После irreversible блокировка снимается намеренно: схема уже новая, и следующий
# релиз ничего не обходит — это единственный путь вылечить кодом неподтверждённый health.
if [ "$DO_CUTOVER" -eq 0 ]; then
  cutover_phase_or_fail
  case "$CUTOVER_PHASE" in
    migrating|migrated)
      REASON="идёт необратимый выкат $CUTOVER_CANDIDATE (фаза $CUTOVER_PHASE): продолжите его — deploy-auto --cutover, либо откатите — deploy-auto --cutover-revert"
      fail "$REASON" ;;
  esac
fi

# Граница совместимости заводится однократно и только здесь (протокол §4): пустой список — это
# «границ ещё не ставили», а отсутствие файла с этого момента означает потерю.
floor_bootstrap

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
# первый деплой добавленного тогда шага: файл на диске новый, отработал старый.
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

# Необратимый выкат идёт своим порядком шагов (протокол §3) и заканчивает деплой сам. Сборка ему
# нужна ровно та же: сверка бандла спрашивает состав миграций у образа кандидата, а верификатор и
# teardown приезжают вместе с миграцией.
if [ "$DO_CUTOVER" -eq 1 ]; then
  cutover_run
fi

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
  # Состав применённых миграций читается ДО дампа: он уходит в .meta и становится предметом гейта
  # восстановления (§5). Без него дамп нечем сверить с образом, и откатываться по нему нельзя.
  read_journal "$COMMIT_SHA"

  # Необратимое узнаётся по teardown в образе: его несёт только то, что снимается протоколом (§7).
  # Обычный путь такие миграции не накатывает. Здесь нет ни верификатора, ни записи границы
  # совместимости, а дамп снимается рядовой страховкой, а не предметом гейта восстановления, — и
  # площадка, накатив необратимое мимо cutover, теряет единственный откат молча, узнавая об этом
  # в тот момент, когда откат понадобился. Отказ громкий и до дампа: чинится это составом релиза.
  IRREVERSIBLE=""
  while IFS= read -r m; do
    [ -n "$m" ] && [ -f "$TEARDOWN_DIR/$m" ] && IRREVERSIBLE="$IRREVERSIBLE $m"
  done <<EOF
$(list_clean "$JOURNAL_PENDING")
EOF
  [ -z "$IRREVERSIBLE" ] || {
    REASON="среди неприменённых есть необратимые (релиз привёз teardown):$IRREVERSIBLE — их накатывает только deploy-auto --cutover (протокол §7), обычный деплой не применяет ничего"
    fail "$REASON"; }

  DUMP_TS="$(date -u +%Y%m%dT%H%M%SZ)"
  DUMP_FILE="${DUMP_TS}-${COMMIT_SHA}.dump"
  log "дамп БД перед накатом: db-backups/$DUMP_FILE"
  db_tools_dump "$DUMP_FILE" || { REASON="дамп БД провалился — миграции не запускались"; fail "$REASON"; }
  chmod 600 "$BACKUP_DIR/$DUMP_FILE"
  write_dump_meta "$DUMP_FILE" "$DUMP_TS" "$COMMIT_SHA"
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

# Forward-fix состоялся: активное состояние выката закрывается как перекрытое (§3.2). Без этого
# следующий cutover встретил бы чужой SHA, а «активного состояния больше нет» неоткуда взяться.
cutover_phase_or_fail
case "$CUTOVER_PHASE" in
  irreversible|'done') cutover_state_archive superseded ;;
esac

prune_images
prune_cache

write_report; trap - EXIT
log "Готово: technic @ $COMMIT_SHA"

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
#   deploy-auto --allow-vhost-drift деплой при нераскатанном vhost (аварийный обход гейта)
#   deploy-auto --cutover           необратимый выкат: остановка записи → миграция → верификатор →
#                                   граница совместимости → подъём (docs/schema-cutover-protocol.md)
#   deploy-auto --cutover-revert    откат незавершённого cutover (только пока граница не записана)
#   deploy-auto --client-floor      показать пол версии клиента и контракт раздаваемой сборки
#   deploy-auto --client-floor=N    поднять/опустить пол (MIN_CLIENT_CONTRACT) и перезапустить api
#   deploy-auto --maintenance       показать состояние режима техработ (три канала порознь)
#   deploy-auto --maintenance=on|off  закрыть/открыть портал: объявление, гейт api, эпоха токенов
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
# Отметка последнего ЗДОРОВОГО релиза. release.state на этот вопрос не отвечает: он пишется
# после `up -d` и ДО health, то есть знает «что запущено», а не «что оказалось здоровым»
# (план чеков на автозапчасти, Р28).
LAST_HEALTHY_SHA="$STATE_DIR/last_healthy.sha"
# Переход к заморозке склада: начат (`freeze.transition`) и завершён (`freeze.done`). Отметок
# две, потому что мигратор применяет каждый файл своей транзакцией — частичный накат штатен, и
# без промежуточной отметки законный выкат стал бы неповторяемым (Р28).
FREEZE_TRANSITION="$STATE_DIR/freeze.transition"
FREEZE_DONE="$STATE_DIR/freeze.done"
# Оба файла едут В ДЕРЕВЕ, а не в prod.env: маркер снимает тот же коммит, который привозит
# миграции, поэтому забыть снять его невозможно по построению (Р27). Список требований
# привозит выкат 3 — код проверки стоит здесь с выпуска 2 и до тех пор молчит (Р28).
NO_MIGRATIONS_MARKER="$PORTAL_DIR/deploy/no-new-migrations.marker"
FREEZE_REQ="$PORTAL_DIR/deploy/requires-frozen-release.list"

DB_TOOLS_IMAGE="postgres:17"            # мажор = серверу Yandex Managed PG (17.x)
PROD_ENV="/etc/technic-portal/prod.env"
# Флаг-файл режима технических работ. Каталог заводит сам deploy-auto при bootstrap (см.
# maint_dir_bootstrap ниже) и монтирует в technic-web как /etc/nginx/maintenance:ro. Сам файл —
# единственный канал режима, который переживает ОСТАНОВКУ api (план Р6).
MAINT_DIR="/etc/technic-portal/maintenance"
MAINT_FILE="$MAINT_DIR/maintenance.json"
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
  deploy-auto --allow-vhost-drift   продолжить деплой, даже если vhost не удалось раскатать
                                    (по умолчанию это отказ: живой конфиг edge не тот, что в git)
  deploy-auto --cutover             необратимый выкат по протоколу (docs/schema-cutover-protocol.md):
                                    сверка бандла → стоп записи → дамп → миграция → верификатор →
                                    граница совместимости → up -d → health. Возобновляем: повтор
                                    после любого обрыва продолжает с того же места
  deploy-auto --cutover-revert      откат незавершённого cutover: teardown релиза и возврат
                                    сервисов на прежний тег. Разрешён только на фазе migrated,
                                    только пока граница не записана и только если окно было
                                    узким — широкое откатывается --restore-db (протокол §6)
  deploy-auto --client-floor        показать пол версии клиента (MIN_CLIENT_CONTRACT в prod.env)
                                    и контракт раздаваемой сборки; ничего не меняет.
  deploy-auto --client-floor=N      поднять/опустить пол и перезапустить technic-api. Отказывает,
                                    если N выше контракта раздаваемой сборки: так портал закрылся
                                    бы целиком. После перезапуска проверяет, что старый контракт
                                    отбивается 426, а обновление сессии — нет (ADR 0146, реш. 7).
                                    Отметку спрашивают только выкаты без отката — те, что несут
                                    миграцию или идут окном --cutover; пропуск попадает в отчёт
  deploy-auto --maintenance         показать режим технических работ: prod.env, фактическое
                                    окружение technic-api и флаг-файл — ТРЕМЯ строками, порознь.
                                    Расхождение любых двух — аварийное состояние, а не «включено»
  deploy-auto --maintenance=on      закрыть портал: объявление в /maintenance.json, гейт 503 в api
                                    и подъём AUTH_EPOCH_SINCE (все выданные access-токены мертвы;
                                    refresh-сессии живы — люди вернутся в работу без пароля).
                                    Отказывает, если пол клиента ниже контракта раздаваемой сборки:
                                    заглушку рисует только новая сборка. Дополнительно:
                                      --reason='<что делаем>'   публичный текст объявления
                                      --until='<когда>'         ожидаемое окончание (ISO 8601)
                                      --allow-old-clients       снять отказ по полу, понимая, что
                                                                часть вкладок останется без него
  deploy-auto --maintenance=off     открыть портал. AUTH_EPOCH_SINCE НЕ снимается: снять её значило
                                    бы оживить токены, выданные до окна
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
DO_PREVIOUS=0 DO_RESTORE_DB=0 DO_STATUS=0 NO_PRUNE=0 SKIP_MIGRATE=0 ALLOW_VHOST_DRIFT=0
DO_CUTOVER=0 DO_CUTOVER_REVERT=0 DO_CLIENT_FLOOR=0
RESTORE_DB_ARG="" CLIENT_FLOOR_ARG=""
DO_MAINTENANCE=0 ALLOW_OLD_CLIENTS=0
MAINTENANCE_ARG="" MAINTENANCE_REASON_ARG="" MAINTENANCE_UNTIL_ARG=""

for arg in "$@"; do
  case "$arg" in
    --previous)       DO_PREVIOUS=1 ;;
    --restore-db)     DO_RESTORE_DB=1 ;;
    --restore-db=*)   DO_RESTORE_DB=1; RESTORE_DB_ARG="${arg#*=}" ;;
    --status)         DO_STATUS=1 ;;
    --no-prune)       NO_PRUNE=1 ;;
    --allow-vhost-drift) ALLOW_VHOST_DRIFT=1 ;;
    --skip-migrate)   SKIP_MIGRATE=1 ;;
    --cutover)        DO_CUTOVER=1 ;;
    --cutover-revert) DO_CUTOVER_REVERT=1 ;;
    --client-floor)   DO_CLIENT_FLOOR=1 ;;
    --client-floor=*) DO_CLIENT_FLOOR=1; CLIENT_FLOOR_ARG="${arg#*=}" ;;
    --maintenance)    DO_MAINTENANCE=1 ;;
    --maintenance=*)  DO_MAINTENANCE=1; MAINTENANCE_ARG="${arg#*=}" ;;
    --reason=*)       MAINTENANCE_REASON_ARG="${arg#*=}" ;;
    --until=*)        MAINTENANCE_UNTIL_ARG="${arg#*=}" ;;
    --allow-old-clients) ALLOW_OLD_CLIENTS=1 ;;
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
# Пол версии клиента — своя операция, а не «деплой с флажком»: она не трогает ни код, ни схему, ни
# образы, и смешивать её с выкатом нельзя. Смешанный запуск означал бы, что человек ждёт от одной
# команды двух разных вещей, а порядок между ними как раз и есть весь смысл двух фаз (ADR 0146,
# решение 7): пол поднимают ПОСЛЕ того, как новая статика раздаётся.
if [ "$DO_CLIENT_FLOOR" -eq 1 ] \
   && { [ "$ROLLBACK_MODE" -eq 1 ] || [ "$DO_STATUS" -eq 1 ] || [ "$SKIP_MIGRATE" -eq 1 ] \
        || [ "$DO_CUTOVER" -eq 1 ] || [ "$DO_CUTOVER_REVERT" -eq 1 ]; }; then
  echo "--client-floor не сочетается с выкатом и откатом: это отдельная операция над prod.env" >&2
  exit 2
fi
if [ "$DO_CLIENT_FLOOR" -eq 1 ] && [ -n "$CLIENT_FLOOR_ARG" ] \
   && ! printf '%s' "$CLIENT_FLOOR_ARG" | grep -qE '^[1-9][0-9]*$'; then
  echo "--client-floor=N: N — целое от 1. Ноль и пустое значение запрещены: запрос без заголовка" >&2
  echo "читается как контракт 1, и пол ниже единицы не отличался бы от выключенного гейта." >&2
  exit 2
fi
# Режим технических работ — отдельная операция над prod.env и флаг-файлом, а не «деплой с флажком».
# Смешать его с выкатом нельзя по той же причине, что и пол клиента, и по одной своей: между
# закрытием портала и работой со схемой стоит РЕШЕНИЕ человека («данные проверены, можно»), и
# команда, делающая оба шага сразу, это решение отменяет.
if [ "$DO_MAINTENANCE" -eq 1 ] \
   && { [ "$ROLLBACK_MODE" -eq 1 ] || [ "$DO_STATUS" -eq 1 ] || [ "$SKIP_MIGRATE" -eq 1 ] \
        || [ "$DO_CUTOVER" -eq 1 ] || [ "$DO_CUTOVER_REVERT" -eq 1 ] || [ "$DO_CLIENT_FLOOR" -eq 1 ]; }; then
  echo "--maintenance не сочетается с выкатом, откатом, --cutover и --client-floor: это отдельная" >&2
  echo "операция над prod.env и флаг-файлом. Порядок работ в окне — docs/runbook.md." >&2
  exit 2
fi
if [ "$DO_MAINTENANCE" -eq 1 ] && [ -n "$MAINTENANCE_ARG" ] \
   && [ "$MAINTENANCE_ARG" != "on" ] && [ "$MAINTENANCE_ARG" != "off" ]; then
  echo "--maintenance=on|off — других значений нет; без значения команда показывает состояние." >&2
  exit 2
fi
# Три флага-спутника осмысленны только у включения. Молчаливое их игнорирование было бы хуже
# отказа: человек, набравший `--maintenance=off --until=...`, ждёт от команды не того, что она
# сделает, и узнает об этом уже в окне.
if { [ -n "$MAINTENANCE_REASON_ARG" ] || [ -n "$MAINTENANCE_UNTIL_ARG" ] \
     || [ "$ALLOW_OLD_CLIENTS" -eq 1 ]; } && [ "$MAINTENANCE_ARG" != "on" ]; then
  echo "--reason, --until и --allow-old-clients имеют смысл только с --maintenance=on" >&2
  exit 2
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

# Каталог объявления режима техработ. Заводится ЗДЕСЬ, а не «по месту оператором» и не демоном
# docker: без каталога `up -d technic-web` создаст его сам как root:root 0755, и владелец портала
# уже не запишет флаг-файл иначе как через sudo, а чинить это придётся руками на живой площадке.
#
# root:docker 0751 — режим считан с живого nginx, а не выбран по аналогии с соседями:
#   · 0751, а не 0750: воркеры nginx в контейнере работают под uid 101, он не root и в группе
#     docker не состоит. Без бита `x` для остальных каталог непроходим, и хуже отказа то, КАК он
#     отказывает: проверка `if (-f ...)` в spa.conf на EACCES молча возвращает ложь — режим
#     включён, а объявления нет;
#   · сам файл кладётся 0644 (см. maint_file_write): при 0640 канал статуса ответил бы 403, а 403
#     заглушку у клиента не снимет. Секрета в файле нет — портал сам публикует его как
#     /maintenance.json.
# Каталог общий с конфигурацией портала (/etc/technic-portal), поэтому владельцем остаётся root:
# пишет в него команда через sudo, читает — контейнер веба.
MAINT_DIR_BOOTSTRAPPED=0
maint_dir_bootstrap() {
  # Отметка — не микрооптимизация: на площадке, где портал принадлежит root, обе ветки bootstrap
  # идут подряд в одном процессе, и неустранимый отказ (нет группы docker, нет sudo) печатался бы
  # дважды за каждый запуск любой команды.
  [ "$MAINT_DIR_BOOTSTRAPPED" -eq 1 ] && return 0
  MAINT_DIR_BOOTSTRAPPED=1

  # СУЩЕСТВУЮЩИЙ каталог проверяется и чинится, а не пропускается. Пропуск был дырой: каталог,
  # заведённый когда-то с 0750 (или созданный демоном docker как root:root 0755 при отсутствующем
  # маунте), остаётся с нерабочими правами навсегда — nginx под uid 101 не входит в него, канал
  # статуса отвечает 403, а проверка `-f` в spa.conf молча возвращает ложь. Симптом при этом
  # худший из возможных: режим включён, а объявления нет.
  if [ -d "$MAINT_DIR" ]; then
    maint_dir_mode="$(stat -c '%a' "$MAINT_DIR" 2>/dev/null || true)"
    maint_dir_owner="$(stat -c '%U:%G' "$MAINT_DIR" 2>/dev/null || true)"
    [ "$maint_dir_mode" = "751" ] && [ "$maint_dir_owner" = "root:docker" ] && return 0
    warn "$MAINT_DIR имеет ${maint_dir_owner:-?} ${maint_dir_mode:-?}, а нужен root:docker 0751 —
  при иных правах nginx не читает объявление, и режим включается без него. Исправляю."
    if [ "$(id -u)" -eq 0 ]; then
      if ! { chown root:docker "$MAINT_DIR" && chmod 0751 "$MAINT_DIR"; }; then
        warn "не удалось исправить права $MAINT_DIR — объявление может не дойти до вкладок"
      fi
    else
      sudo -n sh -c 'chown root:docker "$1" && chmod 0751 "$1"' _ "$MAINT_DIR" 2>/dev/null \
        || warn "не удалось исправить права $MAINT_DIR (нужен sudo) — объявление может не дойти до вкладок"
    fi
    return 0
  fi

  if [ "$(id -u)" -eq 0 ]; then
    install -d -o root -g docker -m 0751 "$MAINT_DIR" \
      || warn "не удалось завести $MAINT_DIR — режим технических работ включить будет нечем"
    return 0
  fi
  sudo -n install -d -o root -g docker -m 0751 "$MAINT_DIR" 2>/dev/null \
    || warn "не удалось завести $MAINT_DIR (нужен sudo) — режим технических работ включить будет нечем"
}

if [ "$(id -u)" -eq 0 ]; then
  install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 755 "$(dirname "$STATE_DIR")"
  install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 750 "$STATE_DIR" "$REPORT_DIR"
  install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 700 "$BACKUP_DIR" "$CONFIG_DIR"
  maint_dir_bootstrap
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
maint_dir_bootstrap

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
# Обычные миграции, уехавшие в одном окне с необратимой (§6). Пусто — окно узкое, откат teardown'ом
# возможен; непусто — единственный откат окна это дамп, и `--cutover-revert` обязан отказать.
CUTOVER_EXTRAS=""
# Ставится гейтом, когда разрушительный режим пропущен как откат широкого окна: по нему в конце
# снимается состояние выката, иначе площадка осталась бы с записью о выкате, которого больше нет.
CUTOVER_WIDE_ROLLBACK=0

# Читает активное состояние выката. Коды: 0 — прочитано, 1 — активного состояния нет (штатная
# жизнь площадки: файл существует только между началом cutover и его архивированием), 2 — файл
# есть, но в нём нет фазы или SHA кандидата.
cutover_state_read() {
  CUTOVER_PHASE="" CUTOVER_CANDIDATE="" CUTOVER_MIGRATION="" CUTOVER_DUMP="" CUTOVER_STARTED=""
  CUTOVER_EXTRAS=""
  [ -f "$CUTOVER_STATE" ] || return 1
  CUTOVER_PHASE="$(grep -E '^phase=' "$CUTOVER_STATE" | cut -d= -f2- || true)"
  CUTOVER_CANDIDATE="$(grep -E '^candidate=' "$CUTOVER_STATE" | cut -d= -f2- || true)"
  CUTOVER_MIGRATION="$(grep -E '^migration=' "$CUTOVER_STATE" | cut -d= -f2- || true)"
  CUTOVER_DUMP="$(grep -E '^dump=' "$CUTOVER_STATE" | cut -d= -f2- || true)"
  CUTOVER_STARTED="$(grep -E '^started_at=' "$CUTOVER_STATE" | cut -d= -f2- || true)"
  CUTOVER_EXTRAS="$(grep -E '^extras=' "$CUTOVER_STATE" | cut -d= -f2- || true)"
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
extras=$CUTOVER_EXTRAS
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
         "$CUTOVER_PHASE" "$CUTOVER_CANDIDATE" "${CUTOVER_MIGRATION:-?}"
       # Широкое окно меняет способ отката, и узнать об этом надо из статуса, а не из отказа
       # `--cutover-revert` в ту минуту, когда откатывать уже понадобилось.
       [ -z "$CUTOVER_EXTRAS" ] || printf '; ОКНО ШИРОКОЕ (+%s) — откат только --previous --restore-db дампом %s' \
         "$CUTOVER_EXTRAS" "${CUTOVER_DUMP:-?}" ;;
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
# ---------------------------------------------------------------------------
# Пол версии клиента (ADR 0146, решение 7): `MIN_CLIENT_CONTRACT` в prod.env.
#
# ЗАЧЕМ ЭТО В deploy-auto, А НЕ РУЧНЫМ `sed`. У операции есть предусловие, которое человек глазами
# не проверит: пол нельзя поднимать выше контракта той сборки, которая РАЗДАЁТСЯ. Подняли выше —
# и `426` получают все, включая только что открытую вкладку: портал становится недоступен целиком,
# а лечится это только обратной правкой того же файла. Ручной `sed` такого предусловия не знает.
#
# Второе, чего у `sed` нет: проверка исхода. После перезапуска надо убедиться не только в том, что
# старый контракт отбивается, но и в том, что обновление сессии НЕ отбивается, — иначе гейт
# выкидывает из портала живых людей (`/auth/refresh` выведен из-под него насовсем).
# ---------------------------------------------------------------------------

# Текущий пол из prod.env. Пусто — строки нет вовсе; сервер в этом случае берёт своё умолчание (1).
client_floor_current() {
  [ -r "$PROD_ENV" ] || return 1
  sed -n 's/^MIN_CLIENT_CONTRACT=//p' "$PROD_ENV" | tail -n1 | tr -dc '0-9'
}

# Контракт РАЗДАВАЕМОЙ сборки — из исходника той ревизии, что записана запущенной (`current`).
# Именно из ревизии, а не из HEAD рабочего дерева: раздаётся собранный образ, а дерево к этому
# моменту могло уехать вперёд на несколько коммитов, и число в нём описывало бы будущее.
client_contract_deployed() {
  [ -n "${CURRENT_BEFORE:-}" ] || return 1
  git_c show "$CURRENT_BEFORE:apps/web/src/shared/api/clientContract.ts" 2>/dev/null \
    | sed -n 's/^export const CLIENT_CONTRACT = \([0-9]\{1,\}\);.*/\1/p' | head -1
}

# Есть ли в запущенной ревизии сам модуль контракта. Отличает «сборка СТАРЕЕ гейта» от «прочитать не
# вышло»: состояния разные, а без этой проверки оба выглядели бы как «контракт неизвестен». Первое —
# обычное дело на площадке, которая ещё не выкатила выпуск с гейтом, и человеку надо сказать не
# «не удалось прочитать», а «сначала выкатите».
client_contract_module_exists() {
  [ -n "${CURRENT_BEFORE:-}" ] || return 1
  git_c cat-file -e "$CURRENT_BEFORE:apps/web/src/shared/api/clientContract.ts" 2>/dev/null
}

# Строка для --status: пол, контракт сборки и вывод о том, согласованы ли они.
client_floor_line() {
  local floor served
  floor="$(client_floor_current || true)"; served="$(client_contract_deployed || true)"
  printf 'пол %s, раздаётся контракт %s%s' \
    "${floor:-<не задан, умолчание 1>}" "${served:-<неизвестен>}" \
    "$( [ -n "$floor" ] && [ -n "$served" ] && [ "$floor" -gt "$served" ] \
        && printf ' — ПОЛ ВЫШЕ РАЗДАВАЕМОГО, портал закрыт для всех' || true )"
}

# Обращение к api изнутри контейнера (минуя infra-nginx, как health_check): печатает код ответа.
client_floor_probe() {
  local contract="$1" path="$2" method="$3"
  "${COMPOSE[@]}" exec -T technic-api node -e \
    "const c=process.argv[1]; \
     fetch('http://127.0.0.1:3000'+process.argv[2], \
       { method: process.argv[3], headers: c ? { 'X-Client-Contract': c } : {} }) \
       .then(r => { console.log(r.status); process.exit(0); }) \
       .catch(() => { console.log('err'); process.exit(0); });" \
    "$contract" "$path" "$method" 2>/dev/null | tr -dc '0-9a-z' | tail -c 8
}

if [ "$DO_CLIENT_FLOOR" -eq 1 ]; then
  FLOOR_NOW="$(client_floor_current || true)"
  SERVED="$(client_contract_deployed || true)"

  if [ -z "$CLIENT_FLOOR_ARG" ]; then
    # Чтение. Печатаем обе стороны и прямо говорим, что можно сделать, — иначе человек пойдёт
    # смотреть prod.env и исходник бандла руками, а это ровно те два места, где легко ошибиться.
    echo "prod.env : $PROD_ENV"
    echo "пол      : ${FLOOR_NOW:-<не задан> (сервер берёт умолчание 1)}"
    if [ -n "$SERVED" ]; then
      echo "сборка   : контракт $SERVED (ревизия ${CURRENT_BEFORE:-<нет>})"
    elif client_contract_module_exists; then
      echo "сборка   : ревизия ${CURRENT_BEFORE:-<нет>} — модуль контракта есть, но число не прочиталось"
    else
      echo "сборка   : ревизия ${CURRENT_BEFORE:-<нет>} СТАРЕЕ гейта — контракта она не объявляет"
      echo "           (заголовок не шлёт; пол выше 1 запер бы её целиком)"
    fi
    if [ -n "$SERVED" ] && { [ -z "$FLOOR_NOW" ] || [ "$FLOOR_NOW" -lt "$SERVED" ]; }; then
      echo "можно    : deploy-auto --client-floor=$SERVED  — отсечёт вкладки старее раздаваемой"
    elif [ -n "$SERVED" ] && [ "$FLOOR_NOW" -eq "$SERVED" ]; then
      echo "состояние: пол совпадает с раздаваемым контрактом — поднимать нечего"
    fi
    exit 0
  fi

  # Запись. Три отказа до всякой мутации.
  if [ -z "$SERVED" ]; then
    if client_contract_module_exists; then
      fail "в ревизии ${CURRENT_BEFORE:-<нет>} модуль контракта есть, но число из него не прочиталось.
  Похоже на правку формата константы CLIENT_CONTRACT — почините её или поднимайте пол вручную,
  понимая риск: без числа предусловие «пол не выше раздаваемого» не проверяется."
    fi
    fail "раздаётся ревизия ${CURRENT_BEFORE:-<нет>} — она СТАРЕЕ гейта версии клиента и контракта не
  объявляет вовсе: заголовок X-Client-Contract её вкладки не шлют. Пол выше 1 запер бы такую сборку
  целиком, поэтому поднимать его сейчас нельзя.
  Сначала выкатите релиз с гейтом (в нём появляется apps/web/src/shared/api/clientContract.ts),
  убедитесь, что раздаётся именно он, и повторите."
  fi
  if [ "$CLIENT_FLOOR_ARG" -gt "$SERVED" ]; then
    fail "пол $CLIENT_FLOOR_ARG выше контракта раздаваемой сборки ($SERVED).
  Так портал закрывается ДЛЯ ВСЕХ: 426 получит и только что открытая вкладка.
  Сначала выкатите сборку с нужным контрактом, потом поднимайте пол."
  fi
  [ -f "$PROD_ENV" ] || fail "нет $PROD_ENV"

  if [ -n "$FLOOR_NOW" ] && [ "$CLIENT_FLOOR_ARG" -lt "$FLOOR_NOW" ]; then
    warn "пол ОПУСКАЕТСЯ с $FLOOR_NOW до $CLIENT_FLOOR_ARG — старые вкладки снова получат доступ."
    warn "Это законный обратный ход, но данные новых выпусков они читать не умеют."
  fi

  log "пол версии клиента: ${FLOOR_NOW:-<не задан>} → $CLIENT_FLOOR_ARG (раздаётся контракт $SERVED)"

  # Правка атомарная и с сохранением владельца и режима: prod.env лежит root:docker 0640, и
  # потерять эти биты значит либо открыть секреты, либо оставить портал без конфигурации.
  sudo sh -c '
    set -eu
    f="$1"; n="$2"
    t="$(mktemp "${f}.XXXXXX")"
    if grep -qE "^MIN_CLIENT_CONTRACT=" "$f"; then
      sed "s/^MIN_CLIENT_CONTRACT=.*/MIN_CLIENT_CONTRACT=$n/" "$f" > "$t"
    else
      cat "$f" > "$t"; printf "MIN_CLIENT_CONTRACT=%s\n" "$n" >> "$t"
    fi
    chown --reference="$f" "$t"; chmod --reference="$f" "$t"
    mv -f "$t" "$f"
  ' _ "$PROD_ENV" "$CLIENT_FLOOR_ARG" || fail "не удалось записать $PROD_ENV (нужен sudo)"

  # `--force-recreate`: env_file читается при СОЗДАНИИ контейнера, и обычный `up -d` мог бы счесть
  # конфигурацию неизменной. Перерыв — секунды, и он честнее, чем перезапуск, не подхвативший файл.
  log "перезапуск technic-api с новым полом"
  "${COMPOSE[@]}" up -d --force-recreate --no-deps technic-api \
    || fail "не удалось перезапустить technic-api — пол в $PROD_ENV уже $CLIENT_FLOOR_ARG"
  health_check || fail "health не подтверждён после перезапуска. Откат: deploy-auto --client-floor=${FLOOR_NOW:-1}"

  # Проверка исхода, а не только факта записи. Оба ответа важны, и второй важнее первого.
  OLD_CONTRACT=$(( CLIENT_FLOOR_ARG - 1 ))
  CODE_OLD="$(client_floor_probe "$OLD_CONTRACT" /api/v1/service-requests GET)"
  CODE_NEW="$(client_floor_probe "$CLIENT_FLOOR_ARG" /api/v1/service-requests GET)"
  CODE_REFRESH="$(client_floor_probe "" /api/v1/auth/refresh POST)"
  echo
  echo "контракт $OLD_CONTRACT на доменной ручке : $CODE_OLD  (ожидается 426)"
  echo "контракт $CLIENT_FLOOR_ARG на доменной ручке : $CODE_NEW  (426 быть НЕ должно)"
  echo "обновление сессии без заголовка  : $CODE_REFRESH  (426 быть НЕ должно)"
  [ "$CODE_OLD" = "426" ] || warn "старый контракт не отбивается — гейт не действует, проверьте prod.env и логи api"
  [ "$CODE_NEW" != "426" ] || warn "раздаваемый контракт тоже отбивается — портал закрыт для всех, немедленно опустите пол"
  [ "$CODE_REFRESH" != "426" ] || warn "обновление сессии отбивается — гейт выкидывает людей из портала, опустите пол"
  log "готово: пол $CLIENT_FLOOR_ARG"
  # ИЗВЕСТНЫЙ ДЕФЕКТ (план режима техработ §5.1): этот блок заканчивается ДО взятия flock, то есть
  # правит prod.env и пересоздаёт technic-api без блокировки — параллельный деплой может делать то
  # же самое с теми же контейнерами. Для правки одного числа это терпели; чинится отдельным
  # выпуском, потому что перенос блока за lock меняет поведение соседней команды, а не этой.
  # Режим технических работ ниже стоит уже ПОСЛЕ lock — там цена ошибки другая.
  exit 0
fi

# ---------------------------------------------------------------------------
# Режим технических работ (docs/maintenance-mode-plan.md). Здесь — только ЧТЕНИЕ состояния:
# переключение стоит ниже, после lock.
#
# У режима ДВА канала, и они не дублируют друг друга (план Р6):
#   · переменные в prod.env — их читает гейт внутри technic-api и отбивает запросы 503;
#   · флаг-файл, который technic-web раздаёт как /maintenance.json, — единственный источник,
#     переживающий ОСТАНОВКУ api, то есть работающий в главном сценарии окна (--cutover api гасит).
# Отсюда в выводе ТРИ состояния, а не одно on/off: prod.env, фактическое окружение контейнера и
# файл. Расхождение любых двух — аварийное состояние, а не «включено».
# ---------------------------------------------------------------------------

# Значение переменной из prod.env; пусто — строки нет вовсе (сервер возьмёт своё умолчание).
# Обрамляющие кавычки снимаются: свободный текст пишется в одинарных (maint_env_quote), и читать
# его надо ровно так, как прочтёт compose, — иначе одно и то же состояние выглядело бы разным.
maint_env_get() {
  local raw
  [ -r "$PROD_ENV" ] || return 1
  raw="$(sed -n "s/^$1=//p" "$PROD_ENV" | tail -n1)"
  case "$raw" in
    "'"*"'") raw="${raw#\'}"; raw="${raw%\'}" ;;
    '"'*'"') raw="${raw#\"}"; raw="${raw%\"}" ;;
  esac
  printf '%s' "$raw"
}

# Приведение к on/off. Пишем мы только `on` и `off`, а читаем терпимее: prod.env правит и человек,
# и «True» вместо «on» — не повод показать закрытый портал открытым.
maint_norm() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    on|1|true|yes) printf 'on' ;;
    *)             printf 'off' ;;
  esac
}

# Фактическое окружение technic-api. Спрашивается у КОНТЕЙНЕРА (Config.Env фиксируется при его
# создании), а не у процесса: ответ есть и у остановленного контейнера, и это единственный способ
# отличить «prod.env правлен, а контейнер не пересоздан» от «режим включён». Наружу уходит только
# запрошенный ключ — весь env контейнера в переменную не оседает.
maint_container_get() {
  docker inspect technic-api --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
    | sed -n "s/^$1=//p" | tail -n1 || true
}

maint_container_exists() { docker inspect technic-api >/dev/null 2>&1; }

# Флаг-файл лежит под root, поэтому читаем и через sudo: «нет доступа», прочитанное как «файла
# нет», — это снятая заглушка на бумаге, то есть ровно та ошибка, которой режим и опасен.
maint_file_present() {
  if [ -e "$MAINT_FILE" ]; then return 0; fi
  if sudo -n test -e "$MAINT_FILE" 2>/dev/null; then return 0; fi
  return 1
}

maint_file_body() {
  if cat "$MAINT_FILE" 2>/dev/null; then return 0; fi
  if sudo -n cat "$MAINT_FILE" 2>/dev/null; then return 0; fi
  return 1
}

# Строковое поле флаг-файла. JSON разбирается sed'ом, а не jq, по той же причине, что и границы
# совместимости выше: зависимости у скрипта нет ни одной сверх coreutils/docker/git, и заводить её
# ради двух полей значит сделать команду неработающей там, где jq забыли поставить.
# Читаются только `until` и `startedAt` — в них кавычек нет по построению. Причину отсюда не
# читаем: экранированная кавычка внутри значения оборвала бы выборку на полуслове, а второй
# источник причины и так есть (prod.env), и он без экранирования.
maint_file_field() {
  local body
  body="$(maint_file_body)" || return 1
  printf '%s\n' "$body" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1
}

maint_file_active() {
  local body
  body="$(maint_file_body)" || return 1
  printf '%s\n' "$body" | grep -q '"active"[[:space:]]*:[[:space:]]*true'
}

# Читает все три канала разом в MAINT_ST_*. MAINT_ST_AGREE=1 — каналы сходятся; 0 — расходятся, и
# это ответ команды, а не деталь вывода: половина включённого режима опаснее выключенного, потому
# что выглядит как включённый.
MAINT_ST_ENV="" MAINT_ST_CONT="" MAINT_ST_FILE="" MAINT_ST_EPOCH=""
MAINT_ST_UNTIL="" MAINT_ST_STARTED="" MAINT_ST_AGREE=1
maint_state_read() {
  MAINT_ST_ENV="$(maint_norm "$(maint_env_get MAINTENANCE_MODE || true)")"
  MAINT_ST_EPOCH="$(maint_env_get AUTH_EPOCH_SINCE | tr -dc '0-9' || true)"
  if maint_container_exists; then
    MAINT_ST_CONT="$(maint_norm "$(maint_container_get MAINTENANCE_MODE)")"
  else
    # Контейнера нет вовсе — это не третий вариант режима: портал закрыт независимо от переменных,
    # и сравнивать здесь нечего. Показываем прямо, в расхождение не засчитываем.
    MAINT_ST_CONT="нет"
  fi
  MAINT_ST_UNTIL="" MAINT_ST_STARTED=""
  if maint_file_present && maint_file_active; then
    MAINT_ST_FILE="on"
    MAINT_ST_UNTIL="$(maint_file_field until || true)"
    MAINT_ST_STARTED="$(maint_file_field startedAt || true)"
  else
    MAINT_ST_FILE="off"
  fi
  MAINT_ST_AGREE=1
  [ "$MAINT_ST_ENV" = "$MAINT_ST_FILE" ] || MAINT_ST_AGREE=0
  if [ "$MAINT_ST_CONT" != "нет" ] && [ "$MAINT_ST_CONT" != "$MAINT_ST_ENV" ]; then
    MAINT_ST_AGREE=0
  fi
}

# Три канала порознь + вывод. Возвращает всегда 0: это отчёт о состоянии, а не проверка, и падать
# на расхождении здесь нельзя — вывод зовут именно затем, чтобы расхождение увидеть.
maint_print_state() {
  local cont_txt file_txt
  maint_state_read
  case "$MAINT_ST_CONT" in
    'нет') cont_txt="<контейнера нет>              (technic-api не создан — портал закрыт в любом случае)" ;;
    *)     cont_txt="MAINTENANCE_MODE=$MAINT_ST_CONT           (фактическое окружение technic-api)" ;;
  esac
  if ! maint_file_present; then
    file_txt="нет"
  elif ! maint_file_body >/dev/null 2>&1; then
    # Файл есть, а прочитать его нечем. Это не «режима нет»: молчаливое приравнивание одного к
    # другому и есть тот fail-open, из-за которого заглушка снималась бы на бумаге.
    file_txt="есть, но НЕ ЧИТАЕТСЯ (нет доступа) — состояние объявления неизвестно"
  elif [ "$MAINT_ST_FILE" = "on" ]; then
    file_txt="есть${MAINT_ST_UNTIL:+, until=$MAINT_ST_UNTIL}${MAINT_ST_STARTED:+, с $MAINT_ST_STARTED}"
  else
    file_txt="есть, но active=false"
  fi
  echo "prod.env  : MAINTENANCE_MODE=$MAINT_ST_ENV   AUTH_EPOCH_SINCE=${MAINT_ST_EPOCH:-<нет>}"
  echo "контейнер : $cont_txt"
  echo "файл      : $file_txt   ($MAINT_FILE → /maintenance.json)"
  if [ "$MAINT_ST_AGREE" -eq 1 ]; then
    if [ "$MAINT_ST_CONT" = "нет" ]; then
      # Согласованность каналов тут ничего не говорит о доступности: портал закрыт остановкой, а не
      # режимом, и назвать это «режим снят» значило бы соврать ровно в аварии.
      echo "состояние : каналы согласованы (режим $MAINT_ST_ENV), но technic-api не создан —"
      echo "            портал закрыт остановкой контейнера, а не режимом"
    elif [ "$MAINT_ST_ENV" = "on" ]; then
      echo "состояние : режим ВКЛЮЧЁН целиком — портал закрыт, объявление раздаётся"
    else
      echo "состояние : режим снят целиком — портал открыт"
    fi
    return 0
  fi
  echo "состояние : РАСХОЖДЕНИЕ КАНАЛОВ — это авария, а не «включено»:"
  if [ "$MAINT_ST_CONT" != "нет" ] && [ "$MAINT_ST_CONT" != "$MAINT_ST_ENV" ]; then
    echo "            prod.env=$MAINT_ST_ENV, а контейнер=$MAINT_ST_CONT — technic-api не пересоздавали,"
    echo "            гейт живёт по СТАРОМУ окружению (портал открыт при закрытом на бумаге — или наоборот)"
  fi
  if [ "$MAINT_ST_ENV" != "$MAINT_ST_FILE" ]; then
    echo "            prod.env=$MAINT_ST_ENV, а файл=$MAINT_ST_FILE — заглушка и гейт разошлись:"
    echo "            вкладка покажет одно, а api ответит другое"
  fi
  echo "            довести состояние: deploy-auto --maintenance=on (закрыть) либо --maintenance=off (открыть)"
  return 0
}

# Строка для --status: те же три канала, но одной строкой. Свести их к общему on/off нельзя —
# спряталось бы ровно то состояние, ради которого строка и заводилась (план §5.3).
maint_status_line() {
  local file_txt="нет"
  maint_state_read
  if [ "$MAINT_ST_FILE" = "on" ]; then
    file_txt="есть${MAINT_ST_UNTIL:+ (until=$MAINT_ST_UNTIL)}"
  elif maint_file_present; then
    file_txt="есть, но не активен либо не читается"
  fi
  printf 'prod.env=%s контейнер=%s файл=%s' "$MAINT_ST_ENV" "$MAINT_ST_CONT" "$file_txt"
  if [ "$MAINT_ST_AGREE" -ne 1 ]; then
    printf ' — РАСХОЖДЕНИЕ КАНАЛОВ (какое именно — deploy-auto --maintenance)'
  fi
}

if [ "$DO_STATUS" -eq 1 ]; then
  echo "portal   : $PORTAL_DIR"
  echo "current  : ${CURRENT_BEFORE:-<нет>}"
  echo "previous : ${PREVIOUS_BEFORE:-<нет>}"
  echo "cutover  : $(cutover_status_line)"
  echo "схема    : $(floor_status_line)"
  echo "клиент   : $(client_floor_line)"
  echo "режим    : $(maint_status_line)"
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
# Режим технических работ: ПЕРЕКЛЮЧЕНИЕ (план §5). Место — после flock, и это не формальность:
# операция закрывает и открывает портал, а параллельный деплой пересоздаёт те же контейнеры;
# полуприменённое окно — худшее из состояний, потому что выглядит применённым.
#
# Отчёта эта операция не пишет намеренно (план Р1): отчёты deploy-auto описывают выкаты, журнала
# окон у режима нет вовсе, и половинчатая запись создала бы видимость аудита, которого нет.
# ---------------------------------------------------------------------------

# Причина — ПУБЛИЧНЫЙ текст, который едет в prod.env (план §4.1). Управляющие символы вычищаются
# целиком, а не экранируются: CR/LF разорвал бы файл окружения на две строки и уронил бы
# конфигурацию ВСЕГО сервиса, а не только объявление. Длина — 200 символов, обрезка молчаливая.
maint_clean_text() {
  local s
  s="$(printf '%s' "${1:-}" | LC_ALL=C tr -d '\000-\037\177' || true)"
  if [ "${#s}" -gt 200 ]; then
    s="${s:0:200}"
    # Обрезка могла разрубить многобайтовый символ пополам, и в prod.env с JSON поехал бы битый
    # UTF-8. iconv, если он в системе есть, ловит ровно это; байт-другой с хвоста ничего не меняет.
    if command -v iconv >/dev/null 2>&1; then
      while [ -n "$s" ] && ! printf '%s' "$s" | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1; do
        s="${s%?}"
      done
    fi
  fi
  printf '%s' "$s"
}

# Значение свободного текста для prod.env. Одинарные кавычки — не украшение: env_file compose
# разбирает правилами dotenv, и в ДВОЙНЫХ кавычках раскрывает и escape-последовательности, и
# ${...}; в одинарных значение берётся буквально. Саму одинарную кавычку из текста поэтому
# заменяем на типографскую: внутри одинарных кавычек dotenv экранирования не знает, и вставить её
# нечем — а закрыть кавычку посреди значения значит отдать хвост причины парсеру как имя ключа.
# ПУСТОЕ значение пишется БЕЗ кавычек: `MAINTENANCE_UNTIL=` — обычный способ снять переменную, и
# читается он одинаково любым разбором env-файла. Литеральные две кавычки, попади они в значение,
# конфиг api разобрал бы как дату и отказался бы стартовать — на СНЯТИИ режима, то есть ровно там,
# где цена ошибки максимальна.
maint_env_quote() {
  [ -n "${1:-}" ] || { printf ''; return 0; }
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/’/g")"
}

# Ожидаемое окончание работ. Нормализуется в ISO 8601 UTC: строка едет и в объявление, и в
# основание Retry-After у гейта, а мусор в ней клиент прочитать не сможет. Код 1 — не разобрано.
maint_until_iso() {
  case "${1:-}" in -*) return 1 ;; esac
  date -u -d "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null
}

# Правка prod.env парами «ключ значение»: атомарно и с сохранением владельца и режима. Файл лежит
# root:docker 0640, и потерять эти биты значит либо открыть секреты, либо оставить портал без
# конфигурации. Значение пишется КАК ЕСТЬ — экранирование делает вызывающая сторона.
maint_env_write() {
  sudo sh -c '
    set -eu
    f="$1"; shift
    t="$(mktemp "${f}.XXXXXX")"
    cat "$f" >"$t"
    while [ "$#" -ge 2 ]; do
      k="$1"; v="$2"; shift 2
      u="$(mktemp "${f}.XXXXXX")"
      seen=0
      # Строка правится НА МЕСТЕ, а не сносится с дописыванием в конец: prod.env читают глазами, и
      # переезд ключа в хвост при каждом окне превратил бы конфигурацию в журнал правок. Повторные
      # строки того же ключа отбрасываются: compose взял бы последнюю, а человек читает первую.
      while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
          "$k"=*) if [ "$seen" -eq 0 ]; then printf "%s=%s\n" "$k" "$v"; seen=1; fi ;;
          *) printf "%s\n" "$line" ;;
        esac
      done <"$t" >"$u"
      [ "$seen" -eq 1 ] || printf "%s=%s\n" "$k" "$v" >>"$u"
      mv -f "$u" "$t"
    done
    chown --reference="$f" "$t"
    chmod --reference="$f" "$t"
    sync "$t" 2>/dev/null || sync
    mv -f "$t" "$f"
  ' _ "$PROD_ENV" "$@" || fail "не удалось записать $PROD_ENV (нужен sudo)"
}

# Флаг-файл пишется атомарно (временный рядом + mv): веб читает его на каждый опрос вкладки, и
# полуфайл прочитался бы как «режима нет» — fail-open ровно там, где нужен fail-closed.
maint_file_write() {
  sudo sh -c '
    set -eu
    f="$1"; body="$2"; d="$(dirname "$f")"
    t="$(mktemp "$d/.maintenance.XXXXXX")"
    printf "%s\n" "$body" >"$t"
    chown --reference="$d" "$t" 2>/dev/null || true
    # 0644, а не 0640 как у prod.env, и это не небрежность: файл читает nginx ВНУТРИ technic-web
    # непривилегированным пользователем, и 0640 обернулся бы для него 403 — то есть снятой
    # заглушкой. Секрета в файле нет: это публичное объявление, которое и так отдаётся всем.
    chmod 0644 "$t"
    sync "$t" 2>/dev/null || sync
    mv -f "$t" "$f"
    sync "$d" 2>/dev/null || sync
  ' _ "$MAINT_FILE" "$1" || fail "не удалось записать $MAINT_FILE (нужен sudo)"
}

maint_file_remove() {
  sudo sh -c '
    set -eu
    f="$1"; d="$(dirname "$f")"
    rm -f "$f"
    sync "$d" 2>/dev/null || sync
  ' _ "$MAINT_FILE" || fail "не удалось снять $MAINT_FILE (нужен sudo) — объявление осталось висеть
  на открытом портале. Снимите вручную: sudo rm -f $MAINT_FILE"
}

# Барьер секунды (план §4.2). НЕ перестраховка: страж отвергает токен с `iat <= AUTH_EPOCH_SINCE`,
# а `iat` меряется ЦЕЛЫМИ секундами. Поднимись новый api в ту же секунду, в которую записана эпоха,
# первый же выданный им токен оказался бы недействительным — и вкладка ушла бы в бесконечный круг
# «401 → refresh → 401». Ждём, пока часы уйдут ЗА секунду эпохи, и только потом пересоздаём.
maint_wait_past_epoch() {
  local epoch="$1" now
  now="$(date +%s)"
  # Эпоха из будущего (часы площадки разошлись, значение уже лежало в prod.env) — ждать её нельзя:
  # ожидание было бы не барьером в секунду, а зависанием команды на годы. Смысла в нём тоже нет —
  # конфиг такое значение отвергает при старте (план §4.1). Говорим прямо и идём дальше: причина
  # здесь в часах, и найти её надо по этому сообщению, а не по повисшей команде.
  if [ "$(( epoch - now ))" -gt 5 ]; then
    warn "AUTH_EPOCH_SINCE=$epoch опережает часы сервера на $(( epoch - now )) с — барьер секунды пропущен."
    warn "Небольшой рассинхрон конфиг api терпит, заметный — отвергает и не поднимается вовсе."
    warn "Разбираться надо со временем площадки, а не с переменной: уменьшать эпоху нельзя."
    return 0
  fi
  while [ "$(date +%s)" -le "$epoch" ]; do
    sleep 0.2 2>/dev/null || sleep 1
  done
}

# Тег, на котором СЕЙЧАС работает api. Пересоздание обязано вернуть тот же образ: режим меняет
# окружение, а не код. Без явного тега `up -d` взял бы `:latest`, а он после недоведённого деплоя
# указывает на ПРОШЛЫЙ здоровый релиз — закрытие портала молча откатило бы код.
maint_api_tag() {
  local img
  img="$(docker inspect -f '{{.Config.Image}}' technic-api 2>/dev/null || true)"
  case "$img" in
    technic-api:*) printf '%s' "${img##*:}" ;;
    *)             printf 'latest' ;;
  esac
}

# Проба возвращает код ответа либо `err`. Пустой ответ бывает и когда контейнер лёг, и ронять на
# нём команду нельзя: её вывод нужен как раз в эту минуту.
maint_probe_code() {
  local out
  out="$("$@" 2>/dev/null || true)"
  printf '%s' "${out:-err}"
}

# Отдаётся ли объявление вебом. Спрашиваем technic-web, а не диск: маунт каталога и локация в
# spa.conf — части, которые команда не ставит, и «файл записан» ещё не значит «объявление видно».
# Ходим изнутри api: наружу technic-web смотрит только через infra-nginx.
maint_web_probe() {
  "${COMPOSE[@]}" exec -T technic-api node -e \
    "fetch('http://technic-web/maintenance.json') \
       .then(r => { console.log(r.status); process.exit(0); }) \
       .catch(() => { console.log('err'); process.exit(0); });" \
    2>/dev/null | tr -dc '0-9a-z' | tail -c 8
}

if [ "$DO_MAINTENANCE" -eq 1 ]; then
  # Отчёта у операции нет (см. выше) — снимаем trap, чтобы отказ не оставлял в реестре выкатов
  # запись о выкате, которого не было.
  trap - EXIT

  [ -f "$PROD_ENV" ] || fail "нет $PROD_ENV"
  [ -r "$PROD_ENV" ] || fail "$PROD_ENV нечитаем владельцем ($DEPLOY_USER) — нужен режим root:docker 0640"

  if [ -z "$MAINTENANCE_ARG" ]; then
    maint_print_state
    exit 0
  fi

  # --- Гейт cutover (план §5.1). На активных фазах api остановлен ПРОТОКОЛОМ и намеренно, а
  # пересоздание контейнера посадило бы код на схему, которой протокол его ещё не показывал.
  cutover_phase_or_fail
  case "$CUTOVER_PHASE" in
    migrating|migrated|irreversible)
      fail "идёт необратимый выкат $CUTOVER_CANDIDATE (фаза $CUTOVER_PHASE): technic-api остановлен
  протоколом намеренно, и пересоздание контейнера посадило бы код на схему, которой протокол его
  ещё не показывал. Сначала доведите выкат (deploy-auto --cutover) либо откатите его
  (deploy-auto --cutover-revert), и только потом трогайте режим.
  Портал в этих фазах и так закрыт — остановкой сервисов." ;;
  esac

  # --- Барьер пола клиента (план §3). Заглушку рисует только НОВАЯ сборка: она одна понимает 503
  # maintenance_mode и опрашивает /maintenance.json. Пол ниже контракта раздаваемой сборки значит,
  # что в окне живут вкладки, которые объявления не покажут вовсе, — и для их людей окно пройдёт
  # как «портал сломался». Порядок выката держится машиной, а не памятью оператора.
  if [ "$MAINTENANCE_ARG" = "on" ]; then
    MAINT_FLOOR="$(client_floor_current || true)"
    MAINT_SERVED="$(client_contract_deployed || true)"
    MAINT_BARRIER=""
    if [ -z "$MAINT_SERVED" ]; then
      MAINT_BARRIER="контракт раздаваемой сборки не прочитан (ревизия ${CURRENT_BEFORE:-<нет>}) — проверить пол нечем"
    elif [ -z "$MAINT_FLOOR" ] || [ "$MAINT_FLOOR" -lt "$MAINT_SERVED" ]; then
      MAINT_BARRIER="пол клиента ${MAINT_FLOOR:-<не задан, умолчание 1>} НИЖЕ контракта раздаваемой сборки ($MAINT_SERVED)"
    fi
    if [ -n "$MAINT_BARRIER" ]; then
      if [ "$ALLOW_OLD_CLIENTS" -eq 1 ]; then
        warn "=== $MAINT_BARRIER"
        warn "=== ПЕРЕДАН --allow-old-clients: ЧАСТЬ ВКЛАДОК ОСТАНЕТСЯ БЕЗ ОБЪЯВЛЕНИЯ. Они не умеют"
        warn "=== ни читать 503 maintenance_mode, ни опрашивать /maintenance.json, и в окне их люди"
        warn "=== увидят сетевые ошибки — ровно то, ради чего режим и заводился."
        warn "=== Правильный путь: deploy-auto --client-floor=${MAINT_SERVED:-N}, и только потом --maintenance=on."
      else
        fail "$MAINT_BARRIER.
  Заглушку рисует только новая сборка: она одна понимает 503 maintenance_mode и опрашивает
  /maintenance.json. С таким полом половина вкладок увидит в окне сетевые ошибки вместо объявления.
  Поднимите пол:  deploy-auto --client-floor=${MAINT_SERVED:-<контракт раздаваемой сборки>}
  Либо, понимая цену, повторите с --allow-old-clients."
      fi
    fi
  fi

  # --- Каталог объявления. Его заводит сам deploy-auto при старте (maint_dir_bootstrap), поэтому
  # его отсутствие здесь — не «ещё не завели», а отказ: не отработал sudo либо каталог снесли, и
  # без него нет ни файла, ни маунта в technic-web, которым этот файл отдавать.
  if ! { [ -d "$MAINT_DIR" ] || sudo -n test -d "$MAINT_DIR" 2>/dev/null; }; then
    if [ "$MAINTENANCE_ARG" = "on" ]; then
      fail "нет каталога $MAINT_DIR — раздать объявление нечем.
  Его заводит сам deploy-auto при запуске (root:docker 0751), значит sudo не сработал или каталог
  снесли; /maintenance.json — единственный канал режима, который переживает остановку api, и без
  него окно закроет портал молча. Заведите каталог и повторите:
    sudo install -d -o root -g docker -m 0751 $MAINT_DIR
  Проверьте заодно, что он примонтирован в technic-web как /etc/nginx/maintenance:ro."
    fi
    warn "каталога $MAINT_DIR нет — снимать нечего; продолжаю снятие режима по prod.env"
  fi

  # Контракт для проб. Гейт версии клиента стоит ПЕРЕД гейтом режима, и запрос без заголовка он
  # отобьёт своим 426 — проба мерила бы не то, что проверяет.
  MAINT_PROBE_CONTRACT="$(client_contract_deployed || true)"
  [ -n "$MAINT_PROBE_CONTRACT" ] || MAINT_PROBE_CONTRACT="$(client_floor_current || true)"

  MAINT_UNTIL_ARG_ISO=""
  if [ -n "$MAINTENANCE_UNTIL_ARG" ]; then
    MAINT_UNTIL_ARG_ISO="$(maint_until_iso "$MAINTENANCE_UNTIL_ARG")" \
      || fail "--until='$MAINTENANCE_UNTIL_ARG' не разбирается как дата. Ожидается ISO 8601, например
  --until='2026-09-04T03:00:00Z' или --until='2026-09-04 06:00' (местное время сервера)."
    if [ "$(date -u -d "$MAINT_UNTIL_ARG_ISO" +%s 2>/dev/null || echo 0)" -le "$(date +%s)" ]; then
      warn "--until указывает в прошлое ($MAINT_UNTIL_ARG_ISO): вкладка покажет просроченный срок,"
      warn "а Retry-After гейт возьмёт умолчанием. Обычно это перепутанный часовой пояс."
    fi
  fi

  if [ "$MAINTENANCE_ARG" = "on" ]; then
    MAINT_ENV_MODE_NOW="$(maint_norm "$(maint_env_get MAINTENANCE_MODE || true)")"
    MAINT_EPOCH_PREV="$(maint_env_get AUTH_EPOCH_SINCE | tr -dc '0-9' || true)"

    # Эпоха поднимается ОДИН раз на окно: повторный `on` после обрыва доводит состояние, а не
    # обнуляет токены заново. Убывать ей нельзя никогда — уменьши её, и токены, выданные до окна,
    # снова стали бы валидными: обнуление отменилось бы задним числом (план §4.1).
    if [ "$MAINT_ENV_MODE_NOW" = "on" ] && [ -n "$MAINT_EPOCH_PREV" ] && [ "$MAINT_EPOCH_PREV" -gt 0 ]; then
      MAINT_EPOCH="$MAINT_EPOCH_PREV"
      log "окно уже открыто в prod.env — эпоха доступа остаётся $MAINT_EPOCH (повтор её не двигает)"
    else
      MAINT_EPOCH="$(date +%s)"
      if [ -n "$MAINT_EPOCH_PREV" ] && [ "$MAINT_EPOCH_PREV" -ge "$MAINT_EPOCH" ]; then
        warn "часы сервера дают $MAINT_EPOCH, а в prod.env уже $MAINT_EPOCH_PREV — эпоха НЕ убывает,"
        warn "оставляю прежнюю. Проверьте время на площадке: расходящиеся часы ломают авторизацию."
        MAINT_EPOCH="$MAINT_EPOCH_PREV"
      fi
    fi

    # Причина и окно. При ПОВТОРНОМ `on` (доведении того же окна) не переданные заново значения
    # берутся из prod.env — иначе обрыв стирал бы объявление. Для НОВОГО окна пустое значит пустое:
    # прошлое «до 03:00» в свежем объявлении хуже, чем его отсутствие.
    if [ -n "$MAINTENANCE_REASON_ARG" ]; then
      MAINT_REASON_TXT="$(maint_clean_text "$MAINTENANCE_REASON_ARG")"
    elif [ "$MAINT_ENV_MODE_NOW" = "on" ]; then
      MAINT_REASON_TXT="$(maint_clean_text "$(maint_env_get MAINTENANCE_REASON || true)")"
    else
      MAINT_REASON_TXT=""
    fi
    if [ -n "$MAINT_UNTIL_ARG_ISO" ]; then
      MAINT_UNTIL_TXT="$MAINT_UNTIL_ARG_ISO"
    elif [ "$MAINT_ENV_MODE_NOW" = "on" ]; then
      MAINT_UNTIL_TXT="$(maint_clean_text "$(maint_env_get MAINTENANCE_UNTIL || true)")"
    elif maint_file_active; then
      # prod.env потерян, а объявление живо: срок берём из уцелевшего канала. Иначе доведение
      # состояния стирало бы окончание работ ровно в том повторе, который его обязан сохранить.
      MAINT_UNTIL_TXT="$(maint_clean_text "$(maint_file_field until || true)")"
    else
      MAINT_UNTIL_TXT=""
    fi
    [ -n "$MAINT_REASON_TXT" ] || warn "причина не задана (--reason='...') — вкладка покажет объявление без объяснения"

    # --- Шаг 1: ФАЙЛ ПЕРВЫМ (план §5.2). Обрыв на любом следующем шаге оставляет портал закрытым,
    # а это безопасная сторона. Обратный порядок оставил бы открытый портал при закрытом api.
    MAINT_STARTED=""
    if maint_file_active; then MAINT_STARTED="$(maint_file_field startedAt || true)"; fi
    if [ -n "$MAINT_STARTED" ]; then
      log "окно уже объявлено с $MAINT_STARTED — переписываю объявление, начало не двигаю"
    else
      MAINT_STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    fi
    log "объявление → $MAINT_FILE (начато $MAINT_STARTED${MAINT_UNTIL_TXT:+, до $MAINT_UNTIL_TXT})"
    maint_file_write "$(printf '{"active": true, "reason": "%s", "until": "%s", "startedAt": "%s"}' \
      "$(json_escape "$MAINT_REASON_TXT")" "$(json_escape "$MAINT_UNTIL_TXT")" "$(json_escape "$MAINT_STARTED")")"

    # --- Шаг 2: prod.env. Эпоха едет тем же движением, что и режим (план Р5): два шага означали бы
    # окно, в котором портал закрыт, а старые токены живы, — и забыть второй можно ровно в том
    # выкате, ради которого всё затевалось.
    log "prod.env → MAINTENANCE_MODE=on, AUTH_EPOCH_SINCE=$MAINT_EPOCH"
    maint_env_write \
      MAINTENANCE_MODE on \
      AUTH_EPOCH_SINCE "$MAINT_EPOCH" \
      MAINTENANCE_REASON "$(maint_env_quote "$MAINT_REASON_TXT")" \
      MAINTENANCE_UNTIL "$(maint_env_quote "$MAINT_UNTIL_TXT")"

    # --- Шаг 3: барьер секунды. См. maint_wait_past_epoch — одна строка снимает целый класс отказов.
    maint_wait_past_epoch "$MAINT_EPOCH"

    # --- Шаг 4: пересоздание. `--force-recreate`: env_file читается при СОЗДАНИИ контейнера, и
    # обычный `up -d` мог бы счесть конфигурацию неизменной.
    log "пересоздание technic-api (образ прежний: режим меняет окружение, а не код)"
    TAG="$(maint_api_tag)" "${COMPOSE[@]}" up -d --force-recreate --no-deps technic-api \
      || fail "не удалось пересоздать technic-api. Объявление записано, prod.env закрыт — портал
  закрыт, и это безопасная сторона. Повторите: deploy-auto --maintenance=on"
    health_check || fail "health не подтверждён после пересоздания technic-api. Объявление висит,
  портал закрыт — безопасная сторона. Логи: ${COMPOSE[*]} logs --tail=50 technic-api"

    # --- Шаг 5: пробы. Проверяется исход, а не факт записи; вторая строка важнее первой.
    MAINT_C_DOMAIN="$(maint_probe_code client_floor_probe "$MAINT_PROBE_CONTRACT" /api/v1/service-requests GET)"
    MAINT_C_REFRESH="$(maint_probe_code client_floor_probe "$MAINT_PROBE_CONTRACT" /api/v1/auth/refresh POST)"
    MAINT_C_WEB="$(maint_probe_code maint_web_probe)"
    echo
    echo "доменная ручка           : $MAINT_C_DOMAIN  (ожидается 503)"
    echo "обновление сессии        : $MAINT_C_REFRESH  (503 быть НЕ должно)"
    echo "/maintenance.json у веба : $MAINT_C_WEB  (ожидается 200)"
    # Пробы ФАТАЛЬНЫ, как и при снятии. Предупреждения здесь мало: команда закрывает портал перед
    # окном миграции, и «режим ВКЛЮЧЁН» с кодом 0 при неотбивающем гейте — это ложный успех, по
    # которому оператор пойдёт останавливать базу. Состояние при отказе остаётся ЗАКРЫТЫМ
    # (объявление на месте, prod.env закрыт) — чинить и повторять, а не откатывать: повтор `on`
    # доводит состояние.
    case "$MAINT_C_DOMAIN" in
      503) ;;
      *) fail "доменная ручка отвечает '$MAINT_C_DOMAIN', ожидалось 503 — гейт режима НЕ действует,
  портал открыт при закрытом на бумаге. Объявление и prod.env оставлены закрытыми.
  Проверьте MAINTENANCE_MODE в $PROD_ENV и ${COMPOSE[*]} logs --tail=50 technic-api,
  затем повторите deploy-auto --maintenance=on" ;;
    esac
    case "$MAINT_C_REFRESH" in
      503|err|'')
        fail "обновление сессии отвечает '$MAINT_C_REFRESH' — режим выкинет людей на форму входа
  вместо тихого продления (план Р4: /auth/refresh выведен из-под гейта насовсем). Состояние
  оставлено закрытым. Проверьте перечень освобождённых путей в apps/api/src/lib/maintenance.ts" ;;
    esac
    case "$MAINT_C_WEB" in
      200) ;;
      *) fail "веб отдаёт /maintenance.json как '$MAINT_C_WEB', ожидалось 200 — вкладка не увидит
  объявления, когда api остановят, а это главный сценарий окна. Частая причина — права каталога
  $MAINT_DIR (нужно root:docker 0751) или отсутствующий маунт в technic-web.
  Состояние оставлено закрытым; после починки повторите deploy-auto --maintenance=on" ;;
    esac
    echo
    maint_print_state
    log "готово: режим технических работ ВКЛЮЧЁН"
    log "technic-worker режим НЕ гасит намеренно (план Р7): рассылки, ушедшие в окне, позовут людей"
    log "в закрытый портал. Если это не устраивает — docker compose -p technic stop technic-worker"
  else
    # --- Снятие идёт ОБРАТНЫМ порядком (план §5.2): сперва prod.env и контейнер, файл — последним.
    # Пока api не подтверждён, заглушка обязана висеть: сняв её первой, мы показали бы работающий
    # портал в ту минуту, когда он ещё не отвечает.
    MAINT_EPOCH_PREV="$(maint_env_get AUTH_EPOCH_SINCE | tr -dc '0-9' || true)"
    log "prod.env → MAINTENANCE_MODE=off (AUTH_EPOCH_SINCE=${MAINT_EPOCH_PREV:-<нет>} ОСТАЁТСЯ: снять её"
    log "значило бы оживить токены, выданные до окна, — обнуление отменилось бы задним числом)"
    maint_env_write \
      MAINTENANCE_MODE off \
      MAINTENANCE_REASON "$(maint_env_quote "")" \
      MAINTENANCE_UNTIL "$(maint_env_quote "")"

    log "пересоздание technic-api (образ прежний)"
    TAG="$(maint_api_tag)" "${COMPOSE[@]}" up -d --force-recreate --no-deps technic-api \
      || fail "не удалось пересоздать technic-api — в prod.env режим уже снят, а гейт живёт по
  старому окружению. Объявление НЕ снято намеренно. Повторите: deploy-auto --maintenance=off"
    health_check || fail "health не подтверждён — объявление ОСТАВЛЕНО висеть намеренно: пока api не
  отвечает, заглушка честнее открытого портала. Логи: ${COMPOSE[*]} logs --tail=50 technic-api,
  затем повторите deploy-auto --maintenance=off"

    MAINT_C_DOMAIN="$(maint_probe_code client_floor_probe "$MAINT_PROBE_CONTRACT" /api/v1/service-requests GET)"
    MAINT_C_REFRESH="$(maint_probe_code client_floor_probe "$MAINT_PROBE_CONTRACT" /api/v1/auth/refresh POST)"
    echo
    echo "доменная ручка           : $MAINT_C_DOMAIN  (503 быть НЕ должно)"
    echo "обновление сессии        : $MAINT_C_REFRESH  (503 быть НЕ должно)"
    # Снятие объявления — последнее действие и единственное, что вкладка увидит как «работы
    # кончились». Отдавать его на неподтверждённом гейте нельзя: заглушка уйдёт, а запросы будут
    # отбиваться. Отсюда fail-closed и здесь — с прямой дверью наружу, если пробу не выполнить.
    case "$MAINT_C_DOMAIN" in
      503|err|'')
        fail "доменная ручка отвечает '$MAINT_C_DOMAIN' — гейт режима не снялся или проверить это не
  удалось. Объявление НЕ снимаю: на закрытом портале заглушка честна, а снятая — лжёт.
  Смотрите ${COMPOSE[*]} logs --tail=50 technic-api и повторите deploy-auto --maintenance=off.
  Если api заведомо здоров, а проба не выполняется, снимите объявление вручную:
  sudo rm -f $MAINT_FILE" ;;
    esac
    case "$MAINT_C_REFRESH" in
      503|err|'')
        # Объявление ещё НЕ снято — снимается оно ниже, — поэтому отказ здесь оставляет состояние
        # закрытым, как и при включении.
        fail "обновление сессии отвечает '$MAINT_C_REFRESH' — гейт снялся не полностью, и люди уйдут
  на форму входа. Объявление НЕ снимаю. Логи: ${COMPOSE[*]} logs --tail=50 technic-api,
  затем повторите deploy-auto --maintenance=off" ;;
    esac

    if maint_file_present; then
      log "снимаю объявление: $MAINT_FILE"
      maint_file_remove
    else
      log "объявления нет — снимать нечего (доведение состояния после обрыва)"
    fi
    MAINT_C_WEB="$(maint_probe_code maint_web_probe)"
    echo "/maintenance.json у веба : $MAINT_C_WEB  (ожидается 404)"
    case "$MAINT_C_WEB" in
      404) ;;
      # Файл уже снят, портал уже открыт — отказ ничего не портит, но и молчать нельзя: вкладки
      # останутся с заглушкой на работающем портале, а оператор уйдёт с кодом 0.
      *) fail "веб отдаёт /maintenance.json как '$MAINT_C_WEB', ожидалось 404 — объявление снято с
  диска, но веб его всё ещё раздаёт: вкладки останутся с заглушкой на работающем портале.
  Проверьте маунт каталога $MAINT_DIR в technic-web и локацию = /maintenance.json в spa.conf" ;;
    esac
    echo
    maint_print_state
    log "готово: режим технических работ СНЯТ"
    log "вкладки снимут заглушку сами по опросу файла, почистят кэш и продолжат работу без входа;"
    log "остановленный на время окна technic-worker поднимается вручную: docker compose -p technic start technic-worker"
  fi
  exit 0
fi

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

# ---------------------------------------------------------------------------
# Последний ЗДОРОВЫЙ релиз и переход к заморозке склада (план чеков, Р27/Р28).
#
# Признак здоровья в скрипте один: `:latest` тегается только при зелёном health. Отсюда правило,
# сформулированное признаком, а не перечнем мест: ГДЕ `:latest` ПЕРЕСТАВЛЯЕТСЯ, ТАМ ПИШЕТСЯ И
# ОТМЕТКА — и новое место retag обязано принести её с собой. Пропуск любого делает отметку враньём:
# после отката она указывала бы на релиз, которого на площадке уже нет, а после cutover отстала бы
# на выкат.
#
# Состояние перехода выводится из ЖУРНАЛА (что применено) и РЕВИЗИИ последнего здорового релиза
# (что развёрнуто и здорово); файлы-отметки отвечают лишь на то, что иначе не выводится ниоткуда, —
# «переход уже доведён до конца». Поэтому отметка всякий раз сверяется с журналом: файл живёт на
# хосте, а миграции — в базе, и PITR откатывает только вторую половину.
# ---------------------------------------------------------------------------
write_last_healthy() { printf '%s\n' "$1" | write_state_atomic "$LAST_HEALTHY_SHA"; }

# SHA последнего здорового релиза. Нет файла — ответа нет: «не знаю, был ли здоров выпуск 2» и
# «был» не одно и то же, и проверки ниже трактуют молчание как отказ.
healthy_sha() { [ -r "$LAST_HEALTHY_SHA" ] && head -n1 "$LAST_HEALTHY_SHA"; }

# Ревизия $1 несёт маркер безмиграционного выпуска — то есть это и есть «Заморозка».
frozen_ok() { [ -n "$1" ] && git_c cat-file -e "$1:deploy/no-new-migrations.marker" 2>/dev/null; }

# «Здоровый релиз уже ЗА переходом»: маркера в нём нет — выкат 3 удалил его тем же коммитом,
# которым привёз миграции, — зато есть сами файлы набора. Другого признака для жизни ПОСЛЕ
# выката 3 не существует.
past_ok() {
  local sha="$1" m
  [ -n "$sha" ] && [ -s "$FREEZE_REQ" ] || return 1
  while IFS= read -r m; do
    [ -n "$m" ] || continue
    git_c cat-file -e "$sha:apps/api/drizzle/$m" 2>/dev/null || return 1
  done < "$FREEZE_REQ"
}

freeze_req_names() { list_clean "$(cat "$FREEZE_REQ" 2>/dev/null || true)"; }

# Файл требований, который есть, но ничего не называет, — сломанный артефакт релиза: по такому
# списку «набор применён целиком» ответилось бы на пустом месте, и защита снялась бы молча. Из двух
# ошибок тихая хуже, поэтому отказ (тем же доводом, что и путь от $PORTAL_DIR в Р27).
freeze_req_require() {
  [ -s "$FREEZE_REQ" ] && [ -n "$(freeze_req_names)" ] && return 0
  REASON="$FREEZE_REQ есть, но не называет ни одной миграции — по такому списку проверка перехода (Р28) ответила бы «применено всё» на пустом месте. Впишите имена миграций набора или уберите файл"
  fail "$REASON"
}

# Незавершённость перехода: нет отметки о завершении ЛИБО набор применён не целиком. Отметке без
# сверки с журналом верить нельзя — она переживает PITR и после него врёт.
freeze_transition_incomplete() {
  local left
  [ -r "$FREEZE_DONE" ] || return 0
  read_journal "$COMMIT_SHA"
  left="$(list_clean "$(list_minus "$(freeze_req_names)" "$JOURNAL_APPLIED")")"
  [ -n "$left" ]
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
      # Широкое окно (§6) — единственное исключение, и оно не поблажка, а необходимость: teardown
      # там неприменим, `--cutover-revert` отказывает, и запрет разрушительных режимов оставил бы
      # окно совсем без выхода. Дверь ровно одна: восстановление закреплённого дампа этого же окна.
      # Откат одного лишь кода запрещён и здесь — он посадил бы старый образ на новую схему.
      if [ -n "$CUTOVER_EXTRAS" ]; then
        [ "$DO_RESTORE_DB" -eq 1 ] || {
          REASON="идёт необратимый выкат $CUTOVER_CANDIDATE (фаза $CUTOVER_PHASE), окно широкое (+$CUTOVER_EXTRAS): откатить его можно только вместе с базой — deploy-auto --previous --restore-db. Откат одного кода посадил бы старый образ на новую схему"
          fail "$REASON"; }
        CUTOVER_WIDE_ROLLBACK=1
        warn "откат широкого окна $CUTOVER_CANDIDATE: база возвращается дампом, teardown не применяется."
        warn "закреплённый дамп окна: ${CUTOVER_DUMP:-<не записан>}"
        return 0
      fi
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
    [ "$pending_count" -gt 0 ] || {
      REASON="неприменённых миграций нет — выкатывать нечего. Если миграцию накатили мимо cutover, разбирать это скрипту нечем"
      fail "$REASON"; }
    # Бандл определяется не числом миграций, а числом НЕОБРАТИМЫХ среди них (§6): необратимость
    # видна по teardown в образе. Обычные соседи едут в том же окне — иначе площадка, где
    # необратимая уехала в ветку не одна, не выкатывается вовсе: обычный путь отказывается из-за
    # неё, cutover отказывался из-за них.
    CUTOVER_MIGRATION="" CUTOVER_EXTRAS=""
    while IFS= read -r m; do
      [ -n "$m" ] || continue
      if [ -f "$TEARDOWN_DIR/$m" ]; then
        [ -z "$CUTOVER_MIGRATION" ] || {
          REASON="в одном окне две необратимые миграции ($CUTOVER_MIGRATION и $m): teardown снимет одну, вторая останется в базе без пути назад (протокол §6). Разведите их по разным выкатам"
          fail "$REASON"; }
        CUTOVER_MIGRATION="$m"
      else
        CUTOVER_EXTRAS="${CUTOVER_EXTRAS:+$CUTOVER_EXTRAS }$m"
      fi
    done <<EOF
$(list_clean "$JOURNAL_PENDING")
EOF
    [ -n "$CUTOVER_MIGRATION" ] || {
      REASON="среди неприменённых ($(list_brief "$JOURNAL_PENDING")) необратимых нет — этому релизу cutover не нужен, выкатывайте обычным deploy-auto"
      fail "$REASON"; }
    CUTOVER_CANDIDATE="$COMMIT_SHA"
    CUTOVER_STARTED="$(date -u +%Y%m%dT%H%M%SZ)"
    log "бандл: $CUTOVER_MIGRATION (кандидат $COMMIT_SHA)"
    if [ -n "$CUTOVER_EXTRAS" ]; then
      warn "в том же окне едут обычные миграции: $CUTOVER_EXTRAS"
      warn "откат этого окна — ТОЛЬКО deploy-auto --previous --restore-db: teardown снимет"
      warn "$CUTOVER_MIGRATION, а перечисленные останутся в журнале без файлов, и старый образ не стартует."
      warn "--cutover-revert для такого окна откажет намеренно (протокол §6)."
    fi
    # Верификатор, teardown и отметка о прогоне спрашиваются ЗДЕСЬ, пока сервисы работают: узнать,
    # что релиз их не привёз, посреди окна обслуживания — значит остаться и без проверки, и без
    # отката. Отметка идёт первой: она дешевле всех — чтение файла и два сравнения.
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
    # Где `:latest` переставляется, там пишется и отметка (Р28): без этого места она отстала бы на
    # выкат и объявила бы здоровым релиз, поверх которого cutover уже прошёл.
    write_last_healthy "$COMMIT_SHA"
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

  # Широкое окно (§6): рядом с необратимой уехали обычные, и teardown их не снимает. Снять одну
  # значит оставить остальные в журнале при живых файлах — но уже на СТАРОМ образе, где этих
  # файлов нет, и он не стартует (`missing`). Единственный откат такого окна — дамп, снятый в его
  # начале и закреплённый от ротации. Отказ здесь дороже отказа: он до остановки чего-либо.
  [ -z "$CUTOVER_EXTRAS" ] || {
    REASON="окно было широким — вместе с $CUTOVER_MIGRATION уехали обычные миграции ($CUTOVER_EXTRAS). Teardown снимет только необратимую, остальные останутся в журнале без файлов старого образа. Откат этого окна — deploy-auto --previous --restore-db закреплённым дампом ${CUTOVER_DUMP:-<не записан>} (протокол §5)"
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
    # Где `:latest` переставляется, там пишется и отметка (Р28): пропусти откат — и она указывала
    # бы на релиз, которого на площадке уже нет. $TARGET_TAG здесь `latest` только при пустом
    # release.state (откатываться всё равно некуда): такую ревизию git не разрешит, и проверки
    # перехода честно ответят «не знаю» отказом, а не тихим «да».
    write_last_healthy "$TARGET_TAG"
  else
    warn "health не подтверждён — :latest не переставлен"
  fi

  # Откат широкого окна завершён — активного выката больше нет. Состояние снимается тем же
  # порядком, что и в --cutover-revert: иначе следующий --cutover встретил бы чужую фазу, а
  # разрушительные режимы остались бы запертыми выкатом, которого уже нет.
  if [ "$CUTOVER_WIDE_ROLLBACK" -eq 1 ]; then
    rm -f "$CUTOVER_STATE" "$BACKUP_DIR/${CUTOVER_DUMP%.dump}.pin"
    fsync_path "$STATE_DIR"
    CUTOVER_PHASE="" CUTOVER_ACTIVE=0
    rotate_dumps
    log "состояние выката $CUTOVER_CANDIDATE снято: окно откачено дампом, закрепление снято"
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

# Preflight капчи — первый гейт релиза: он дешевле всех остальных и не трогает ни базу, ни
# контейнеры. Проверка идёт из ОБРАЗА КАНДИДАТА (TAG уже равен $COMMIT_SHA), потому что `:latest`
# до конца выката указывает на прошлый релиз.
#
# Гейт работает, только когда капча настроена в prod.env. Пропуск при незаданном ключе — не
# послабление: в production API без ключей вовсе не стартует (config.ts, план §8), и такой релиз
# всё равно не переживёт health-check ниже, зато площадка, которая ещё не завела капчу, может
# выкатывать код. Молчаливым пропуск не бывает — о нём говорит warn.
if grep -qE '^SMARTCAPTCHA_SERVER_KEY=.+' "$PROD_ENV" 2>/dev/null; then
  log "preflight капчи (образ кандидата $COMMIT_SHA)"
  "${COMPOSE[@]}" --profile tools run --rm -T captcha-check || {
    REASON="preflight капчи не прошёл: SmartCaptcha не отвергла заведомо мусорный токен либо проверка не удалась. Так отвечает ограниченный режим (платёжный аккаунт не ACTIVE/TRIAL_ACTIVE) — релиз уехал бы с капчей, которая ничего не проверяет. Ничего не изменено"
    fail "$REASON"; }
else
  warn "SMARTCAPTCHA_SERVER_KEY не задан в $PROD_ENV — preflight капчи пропущен."
  warn "В production API без ключей не стартует: релиз с кодом капчи не пройдёт health."
fi

# Vhost — ДО миграций и до up -d, а не после переключения, как было раньше. Причина в порядке
# ущерба: релиз, чей код зависит от заголовков edge (CSP, X-Forwarded-For), при нераскатанном
# vhost выглядит здоровым — контейнеры поднялись, health отвечает, — а формы не работают. Гейтом
# на прежнем месте (после `docker tag :latest`) останавливать было уже нечего.
# Здесь же не сделано ничего: дамп не снят, миграции не накатаны, контейнеры прежние.
# Раскатка до up -d безопасна: в vhost стоит `resolver` и `proxy_pass` через переменную, поэтому
# nginx -t не требует живого апстрима, а обратный случай — новый конфиг на старом коде — безобиден,
# новая политика лишь разрешает лишние домены.
sync_vhost
case "$VHOST_SYNC" in
  uptodate|synced) ;;
  *)
    if [ "$ALLOW_VHOST_DRIFT" -eq 1 ]; then
      warn "vhost не раскатан ($VHOST_SYNC), но передан --allow-vhost-drift — продолжаю"
    else
      REASON="vhost не раскатан ($VHOST_SYNC): живой $LIVE_VHOST не совпадает с $REPO_VHOST, и релиз поехал бы на чужих заголовках edge. Ничего не изменено — почините доступ/конфиг и повторите, либо deploy-auto --allow-vhost-drift, если расхождение осознанное"
      fail "$REASON"
    fi ;;
esac

# Необратимый выкат идёт своим порядком шагов (протокол §3) и заканчивает деплой сам. Сборка ему
# нужна ровно та же: сверка бандла спрашивает состав миграций у образа кандидата, а верификатор и
# teardown приезжают вместе с миграцией.
if [ "$DO_CUTOVER" -eq 1 ]; then
  # Безмиграционному выпуску необратимый режим не положен вовсе (Р27), и проверка стоит здесь, а не
  # рядом с двумя своими: `cutover_run` идёт РАНЬШЕ проверки статуса миграций и заканчивает деплой
  # сам, поэтому туда запрет не дотягивается. Ни PENDING, ни журнал тут не спрашиваются намеренно:
  # до `cutover_run` они ещё не считаны, а условие в них и не нуждается.
  if [ -f "$NO_MIGRATIONS_MARKER" ]; then
    REASON="выпуск помечен безмиграционным (Р26): --cutover ему не положен вовсе — необратимых миграций у него нет по определению. Уберите миграцию из выпуска либо снимите маркер вместе с ней (выкат 3)"
    fail "$REASON"
  fi
  # Незавершённый переход к заморозке (Р28): cutover ведёт накат своим порядком шагов и прошёл бы
  # мимо предусловия перехода и мимо его завершения перед retag. Условие отказа — не наличие файла,
  # а именно незавершённость, поэтому после законного выката 3 запрет снимается сам.
  if [ -r "$FREEZE_REQ" ]; then
    freeze_req_require
    if freeze_transition_incomplete; then
      REASON="переход к заморозке не завершён (Р28): --cutover прошёл бы мимо предусловия и мимо отметки о завершении. Сначала проведите выкат 3 обычным деплоем (deploy-auto), затем катите необратимую миграцию отдельным --cutover"
      fail "$REASON"
    fi
  fi
  # Обратная проверка режима технических работ (план §5.1) — ПРЕДУПРЕЖДЕНИЕ, а не отказ: окно
  # бывает аварийным, и вторая дверь, которую придётся обходить, хуже, чем портал, закрывшийся без
  # объявления (а это ровно сегодняшнее поведение). Стоит здесь, перед самой остановкой сервисов:
  # раньше её смыло бы выводом сборки.
  if [ "$(maint_norm "$(maint_env_get MAINTENANCE_MODE || true)")" != "on" ]; then
    warn "режим технических работ ВЫКЛЮЧЕН, а --cutover сейчас остановит technic-api и worker:"
    warn "открытые вкладки увидят сетевые ошибки вместо объявления, а старые access-токены"
    warn "переживут окно. Закрыть портал заранее (отдельной командой, до выката):"
    warn "  deploy-auto --maintenance=on --reason='<что делаем>' --until='<когда>'"
    warn "Выкат продолжается — это предупреждение, а не отказ."
  fi
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

# ---------------------------------------------------------------------------
# Выпуск, помеченный безмиграционным (план чеков, Р26/Р27). Проверки две, и каждая ловит своё:
#   PENDING — любую миграцию, которая накатится этим выкатом, включая чужую, приехавшую в main
#             между выпусками;
#   diff по каталогу — уже накатанную руками: PENDING равен нулю, а журнал всё равно новее образа
#             прежнего выпуска, и `--previous` снова сломан.
# Обе идут ПОСЛЕ pull и ДО дампа с накатом: отказ на этом месте не меняет на площадке ничего.
# Путь к маркеру — от $PORTAL_DIR, git — только через git_c: скрипт стоит симлинком и запускается
# откуда угодно, а относительный путь маркера просто не увидел бы и молча снял защиту.
# ---------------------------------------------------------------------------
if [ -f "$NO_MIGRATIONS_MARKER" ]; then
  log "выпуск помечен безмиграционным: $NO_MIGRATIONS_MARKER"
  [ "$PENDING" -eq 0 ] || {
    REASON="выпуск помечен безмиграционным (Р26): среди неприменённых миграций есть новые — уберите их из этого выпуска или снимите маркер вместе с ними (выкат 3)"
    fail "$REASON"; }
  if [ -n "$CURRENT_BEFORE" ]; then
    git_c diff --quiet "$CURRENT_BEFORE".."$LOCAL_SHA" -- apps/api/drizzle/ || {
      REASON="выпуск помечен безмиграционным (Р26): каталог миграций изменился с развёрнутой ревизии $CURRENT_BEFORE — откат --previous после такого выката не поднимет прежний образ; перенесите миграцию в выкат 3 или снимите маркер вместе с ней"
      fail "$REASON"; }
  else
    # Развёрнутая ревизия неизвестна (release.state пуст — первый деплой на этой площадке):
    # сравнивать не с чем, да и откатываться некуда. Молчать при этом всё равно нельзя.
    warn "в $RELEASE_STATE нет current= — каталог миграций сравнить не с чем;"
    warn "проверка маркера ограничена неприменёнными миграциями."
  fi
fi

# ---------------------------------------------------------------------------
# Предусловие перехода к заморозке склада (план чеков, Р28). Список требований привозит выкат 3, а
# этот код — выпуск 2: к приезду списка проверка уже развёрнута и однажды отработала вхолостую.
#
# Решение принимается ПО НАБОРУ ЦЕЛИКОМ, а не по каждой миграции поодиночке: частичный накат
# означает один прерванный переход, а не два разных ответа. Журнал читается ДО наката и ВНЕ ветки
# PENDING=1 — повтор после «миграции применены, health упал» приходит с PENDING=0 и набора не
# увидел бы вовсе. Цена — лишний запуск migrate-контейнера, и платится она только там, где список
# требований лежит в дереве.
# ---------------------------------------------------------------------------
if [ -r "$FREEZE_REQ" ]; then
  freeze_req_require
  log "переход к заморозке: сверяю набор из $FREEZE_REQ с журналом"
  read_journal "$COMMIT_SHA"                     # ЧТЕНИЕ 1: до наката, независимо от PENDING
  FREEZE_NAMES="$(freeze_req_names)"
  FREEZE_LEFT="$(list_clean "$(list_minus "$FREEZE_NAMES" "$JOURNAL_APPLIED")")"
  FREEZE_HS="$(healthy_sha || true)"

  if [ -z "$FREEZE_LEFT" ]; then
    # Набор применён целиком. Есть отметка о завершении — правило молчит.
    if [ ! -r "$FREEZE_DONE" ]; then
      # Отметку либо потеряли, либо здоровый релиз — уже сам выкат 3 (маркер он удалил сам, и
      # узнать это можно только по файлам набора в его дереве). Оба состояния законны.
      { frozen_ok "$FREEZE_HS" || past_ok "$FREEZE_HS"; } || {
        REASON="миграции набора применены мимо заморозки (Р28): последний здоровый релиз не знает ни выпуска 2, ни этих миграций. Выкатите выпуск 2 «Заморозка», дождитесь зелёного health и повторите"
        fail "$REASON"; }
      printf 'sha=%s\nrecovered=1\n' "$COMMIT_SHA" | write_state_atomic "$FREEZE_DONE"
      rm -f "$FREEZE_TRANSITION"; fsync_path "$STATE_DIR"
      log "  отметка о завершённом переходе восстановлена (журнал и $LAST_HEALTHY_SHA согласны)"
    fi
  elif [ "$(list_count "$FREEZE_LEFT")" != "$(list_count "$FREEZE_NAMES")" ]; then
    # Применено частично — возобновление прерванного выката, и здоровье заморозки спрашивается
    # заново. Иначе остаётся дыра: упали до наката → площадку откатили на прежний выпуск → кто-то
    # накатил часть набора руками → повтор увидел бы «применено + отметка есть» и продолжил.
    # Отметка проверяется и на содержимое: записанная в ней ревизия обязана нести маркер, иначе это
    # мусор от постороннего выката, а не доказательство.
    rm -f "$FREEZE_DONE"
    if [ -r "$FREEZE_TRANSITION" ] \
       && frozen_ok "$(sed -n 's/^last_healthy=//p' "$FREEZE_TRANSITION" | head -n1)" \
       && frozen_ok "$FREEZE_HS"; then
      log "  переход к заморозке возобновляется: осталось $(list_count "$FREEZE_LEFT") из $(list_count "$FREEZE_NAMES")"
    else
      REASON="набор миграций применён частично, но переход не подтверждён здоровой заморозкой (Р28): осталось $(list_brief "$FREEZE_LEFT")— выкатите выпуск 2 «Заморозка», дождитесь зелёного health и повторите этот выкат"
      fail "$REASON"
    fi
  else
    # Не применено ничего: старым отметкам не верим — `freeze.done`, если он тут лежит, врёт (базу
    # откатили под него). Спрашивается текущее состояние площадки, и оно одно: здоровая заморозка.
    rm -f "$FREEZE_DONE"
    frozen_ok "$FREEZE_HS" || {
      REASON="набор миграций требует развёрнутой заморозки (Р28): последний здоровый релиз её не содержит — выкатите выпуск 2 «Заморозка», дождитесь зелёного health и повторите"
      fail "$REASON"; }
    printf 'sha=%s\nlast_healthy=%s\n' "$COMMIT_SHA" "$FREEZE_HS" | write_state_atomic "$FREEZE_TRANSITION"
    log "  переход к заморозке начат: набор $(list_count "$FREEZE_NAMES") миграций, здоровая заморозка $FREEZE_HS"
  fi
fi

if [ "$PENDING" -eq 1 ] && [ "$SKIP_MIGRATE" -eq 1 ]; then
  warn "есть неприменённые миграции, но передан --skip-migrate:"
  warn "деплою НОВЫЙ код на СТАРУЮ схему — возможны ошибки во время работы. Дамп не снимаю."
  # Схема не тронута, значит `--previous` вернёт релиз целиком — ворота качества не спрашиваются.
elif [ "$PENDING" -eq 1 ]; then
  # Выкат несёт миграцию: `--previous` вернёт код, но не схему, и настоящий откат тут — только
  # дамп. Отметка о зелёном прогоне спрашивается ДО дампа и до наката — отказ на этом месте не
  # меняет на площадке ничего.
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

  # Разовые работы по данным — то, что миграцией не делается (ADR 0149).
  #
  # Переоформление листов ЭСМ-2, выписанных «на два месяца» до ADR 0142. SQL-миграцией его не
  # провести: номер бланка строгой отчётности и снимок его граф рождаются кодом выписки, а второй
  # механизм расхода номеров рядом с первым разошёлся бы с ним молча. Поэтому выкат зовёт тот же
  # прогон, что позвал бы человек, — сразу после наката и до подъёма сервисов: между новой бумагой
  # и первым, кто её увидит, ничего не стоит.
  #
  # ШАГ ИДЕМПОТЕНТЕН И САМОГАСЯЩИЙСЯ: без заявок с двухмесячным листом прогон печатает «— 0» и
  # выходит нулём. Держать его в выкате поэтому не вредно; убрать можно тогда, когда прод
  # отчитается нулём, — вместе с самим прогоном.
  #
  # ПРОГОН НЕ ВАЛИТ ВЫКАТ. Код 2 означает «часть заявок пропущена и ждёт человека», код 1 — что
  # прогон не запустился вовсе; и то и другое разбирается после деплоя, а миграции к этому моменту
  # накатаны и сервисы обязаны подняться. Молчать при этом нельзя — отсюда громкий warn.
  log "переоформление листов ЭСМ-2 переходной недели (ADR 0149)"
  if ! "${COMPOSE[@]}" run --rm -T migrate \
       pnpm --silent --filter @technic/api esm2:month-split -- --apply; then
    warn "переоформление листов ЭСМ-2 прошло не полностью — разберите вывод выше."
    warn "Повторить:  ${COMPOSE[*]} run --rm -T migrate pnpm --filter @technic/api esm2:month-split"
  fi
fi

log "up -d: ${SERVICES[*]}"
"${COMPOSE[@]}" up -d "${SERVICES[@]}" || { REASON="запуск сервисов провалился"; fail "$REASON"; }

# release.state — ФАКТ (что реально запущено), пишется после up -d и до health.
# Авто-отката кода нет (см. recover), поэтому рассинхрона current↔running не будет.
write_release_state "$CURRENT_BEFORE" "$COMMIT_SHA"

# health гейтит «благословение» :latest, но НЕ откатывает автоматически.
if health_check; then
  # Релиз состоялся: сервисы подняты и здоровы на этом образе, «полусобранным» он больше не
  # считается. Метка снимается ДО завершения перехода — иначе отказ второго чтения журнала увёл бы
  # recover в `docker rmi` образа, на котором прямо сейчас работают сервисы.
  BUILT_TAG=""

  # Завершение перехода к заморозке (Р28). Порядок обязателен и обратен привычному:
  #   health зелёный → ЧТЕНИЕ 2 → набор применён целиком? → freeze.done → :latest → last_healthy.
  # Переставь retag первым — и last_healthy указал бы на выкат 3, где маркера заморозки нет; упади
  # после этого второе чтение журнала (недоступна база, не поднялся migrate-контейнер) — и повтор
  # выката упёрся бы в собственную проверку. Пока `freeze.done` не записан, `:latest` и
  # last_healthy остаются на заморозке, то есть ровно на том состоянии, из которого повтор возможен.
  # Данные ЧТЕНИЯ 1 к этому моменту устарели ровно на тот накат, ради которого всё и делалось.
  if [ -r "$FREEZE_REQ" ]; then
    read_journal "$COMMIT_SHA"                   # ЧТЕНИЕ 2: после health, до завершения перехода
    FREEZE_LEFT="$(list_clean "$(list_minus "$(freeze_req_names)" "$JOURNAL_APPLIED")")"
    if [ -z "$FREEZE_LEFT" ]; then
      printf 'sha=%s\nfrom_healthy=%s\n' "$COMMIT_SHA" "$(healthy_sha || true)" \
        | write_state_atomic "$FREEZE_DONE"
      rm -f "$FREEZE_TRANSITION"; fsync_path "$STATE_DIR"
      log "переход к заморозке завершён: набор применён целиком (freeze.done)"
    else
      # Штатно сюда приводит только --skip-migrate: код выпуска 3 поехал, а набор не накатан.
      # Отметка не ставится — состояние остаётся «переход начат», и повтор его доводит.
      warn "набор миграций заморозки применён не целиком (осталось $(list_brief "$FREEZE_LEFT")) —"
      warn "переход НЕ отмечен завершённым; повторите деплой без --skip-migrate."
    fi
  fi

  for repo in "${IMAGES[@]}"; do docker tag "$repo:$COMMIT_SHA" "$repo:latest"; done
  # Где `:latest` переставляется, там пишется и отметка (Р28) — и только после freeze.done.
  write_last_healthy "$COMMIT_SHA"
else
  RESULT="degraded"
  warn "health НЕ подтверждён за 5 попыток. Сервисы запущены на $COMMIT_SHA,"
  warn ":latest оставлен на прошлом здоровом релизе (авто-отката нет)."
  warn "Логи:   ${COMPOSE[*]} logs --tail=50 technic-api"
  warn "Откат:  deploy-auto --previous"
  write_report; trap - EXIT
  exit 1
fi

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

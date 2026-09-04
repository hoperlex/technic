import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { serviceExecutorCandidatesQuery } from '../src/entities/service-request/api/queries';
import { serviceRequestsApi } from '../src/entities/service-request/api/serviceRequestsApi';
import { mockHttp, takeUnmatchedHttp, type RecordedCall } from './http';

/**
 * Караул мёртвого кода: серверная ручка модуля заявок на обслуживание ↔ вход с экрана
 * (план `docs/office-equipment-request-actions-menu-plan.md`, §7.4, критерий К8).
 *
 * ЗАЧЕМ. Уборка меню снимает пункты, и легко получить живую серверную дверь, которую больше никто
 * не открывает: она остаётся доступной по прямому запросу и делает настоящую работу — шлёт письмо
 * настоящей службе, двигает статус, — а с экрана недостижима. Такую находку уже сделал инвентарь
 * (Н9 плана): у `PATCH /:id/service-comment` клиентского метода нет вовсе. Соседний караул
 * (`service-request-entries.test.tsx`) сторожит состав МЕНЮ и про серверные двери не знает ничего,
 * а `report:service-access` знает про двери и ничего не знает про экран. Между ними и есть щель,
 * в которую проваливается мёртвая ручка; этот реестр её закрывает.
 *
 * ПОЧЕМУ В `apps/web`, А НЕ РЯДОМ С МАНИФЕСТОМ. Реестр сшивает два конца, и дорогой здесь ровно
 * один — портальный: «портал зовёт эту ручку» доказывается не поиском строки, а ПРОГОНОМ клиента
 * с подменённой сетью (`mockHttp`), и повторить это из `apps/api` нечем — там нет ни алиасов
 * слоёв, ни jsdom. Серверный конец, наоборот, дёшев: перечень ручек модуля — литеральные ключи
 * манифеста, и читаются они текстом файла, без импорта чужого пакета (зависимости `apps/web` на
 * `apps/api` от этого не возникает — ни сборочной, ни типовой).
 *
 * ЧТО ЗДЕСЬ СЧИТАЕТСЯ ФАКТОМ, А ЧТО ОЖИДАНИЕМ. Ожидание — таблица `DOORS` ниже: её пишут и
 * ревьюют руками. Факты берутся из кода с обеих сторон: перечень ручек — из манифеста сервера,
 * адрес каждого входа — из журнала подменённой сети, наличие входа на экране — из исходников
 * портала. Ни один из трёх фактов в тесте не переписан руками, иначе перечень сошёлся бы сам с
 * собой и промолчал ровно про ту ручку, о которой забыли.
 *
 * ЧЕГО ЭТОТ КАРАУЛ НЕ ПРОВЕРЯЕТ: что вход УДОБЕН и что он показан тому, кому надо, — это права,
 * условия показа и приёмка (§7.1–§7.3, §7.5 плана). Здесь вопрос один: осталась ли у двери хоть
 * одна ручка снаружи.
 */

/* ─── факт первый: какие двери есть у модуля ─────────────────────────────────────────────────── */

/**
 * Перечень ручек модуля — из манифеста области и стороны сервера.
 *
 * Манифест выбран источником не потому, что он ближе, а потому, что его полноту доказывает свой
 * тест: `apps/api/test/service-access-manifest.test.ts` сверяет ключи манифеста с маршрутами
 * СОБРАННОГО приложения. То есть «ручка есть в манифесте» и «ручка есть у приложения» — уже одно
 * и то же утверждение, и повторять здесь разбор регистраций (то, чем занят
 * `scripts/service-access-inventory.ts`) значило бы завести второй разбор, способный разойтись с
 * первым.
 */
const MANIFEST_FILE = join(import.meta.dirname, '../../api/src/lib/service-access-manifest.ts');

/**
 * Ключ строки манифеста: `'МЕТОД /путь':`. Двоеточие в шаблоне обязательно — без него выражение
 * ловило бы и упоминания маршрутов в комментариях самого манифеста, а их там десятки.
 */
const MANIFEST_KEY =
  /'((?:GET|POST|PUT|PATCH|DELETE) \/(?:api\/v1|internal)\/service-requests[^']*)':/g;

/** Меньше этого числа ручек означает, что разбор манифеста сломался, а не что модуль похудел. */
const SANE_ROUTE_COUNT = 30;

function moduleRoutes(): string[] {
  const source = readFileSync(MANIFEST_FILE, 'utf8');
  const keys = [...source.matchAll(MANIFEST_KEY)].map((match) => match[1]!);
  if (keys.length < SANE_ROUTE_COUNT) {
    throw new Error(
      `Из ${MANIFEST_FILE} вычитано всего ${keys.length} ручек: манифест переехал или сменил ` +
        'форму ключа. Почините разбор — молчащий караул хуже отсутствующего',
    );
  }
  return keys;
}

const ROUTES = moduleRoutes();

/* ─── факт второй: что портал зовёт с экрана ─────────────────────────────────────────────────── */

const SRC = join(import.meta.dirname, '../src');

/**
 * Комментарии снимаются перед поиском, и это не мелочь: `ServiceChatFeed.tsx` УПОМИНАЕТ мёртвую
 * `PATCH /:id/service-comment` — объясняет, чем она заменена, — и поиск по сырому тексту счёл бы
 * упоминание вызовом. Заодно перестаёт считаться входом закомментированный вызов: он ровно
 * настолько же недостижим с экрана, как удалённый.
 *
 * Разбор грубый (регулярным выражением, а не компилятором): двоеточие и кавычка перед `//`
 * отсекают `https://` внутри строк, а больше от него ничего и не требуется — вопрос у скана один
 * и тот же, «встречается ли имя в живом коде».
 */
function withoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/gm, '$1');
}

interface Source {
  /** Путь относительно `apps/web/src` — им называют место в сообщении о падении. */
  file: string;
  code: string;
}

function readSources(dir: string): Source[] {
  const out: Source[] = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, item.name);
    if (item.isDirectory()) {
      out.push(...readSources(full));
      continue;
    }
    if (!/\.tsx?$/.test(item.name)) continue;
    out.push({ file: relative(SRC, full), code: withoutComments(readFileSync(full, 'utf8')) });
  }
  return out;
}

const SOURCES = readSources(SRC);

/**
 * Обвязка самого слайса: объявление клиента и общий вход слайса.
 *
 * Из поиска ВХОДА они исключены, потому что ничего не открывают: `index.ts` только пересылает имя
 * дальше, а `api/` — то место, где дверь объявляется. Считай мы их входом, мёртвая ручка с живым
 * клиентским методом выглядела бы вызываемой: метод объявлен, метод экспортирован — а нажать его
 * негде. Из поиска УПОМИНАНИЙ (ниже) они, наоборот, не исключены: там вопрос обратный.
 */
const SLICE_PLUMBING = [
  join('entities', 'service-request', 'api'),
  join('entities', 'service-request', 'index.ts'),
];

const isPlumbing = (file: string): boolean =>
  SLICE_PLUMBING.some((part) => file === part || file.startsWith(`${part}/`));

/** Экраны, зовущие это звено портала по имени. Пусто — с экрана его не зовёт никто. */
function callersOf(name: string): string[] {
  return SOURCES.filter((src) => !isPlumbing(src.file) && src.code.includes(name)).map(
    (src) => src.file,
  );
}

/** Любое упоминание литерала в живом коде портала — включая обвязку слайса и прямые `apiFetch`. */
function mentionsOf(literal: string): string[] {
  return SOURCES.filter((src) => src.code.includes(literal)).map((src) => src.file);
}

/**
 * Хвост пути за последним параметром: `POST /api/v1/service-requests/:id/notify` → `/notify`. Им и
 * ищется прямой вызов закрытой двери — по нему запрос узнаётся, как бы ни собирался путь: через
 * объект API, через `apiFetch` шаблонной строкой или через будущую фабрику.
 *
 * У пути без параметров (служебный контур) берётся путь целиком: хвостом там была бы `auto-close`,
 * а такое слово встречается и само по себе.
 */
function absenceLiteral(key: string): string {
  const path = key.slice(key.indexOf(' ') + 1);
  const param = path.lastIndexOf(':');
  if (param < 0) return path;
  const tail = path.indexOf('/', param);
  return tail < 0 ? path : path.slice(tail);
}

/* ─── реестр ─────────────────────────────────────────────────────────────────────────────────── */

/**
 * Законные причины не иметь пункта в меню действий — закрытым перечнем, а не свободной строкой:
 * причина, придуманная на месте, и есть способ усыпить караул. Каждая проверяется машиной там, где
 * это возможно: «служебная» — префиксом пути, «чтение» — методом, «архив» — файлом, из которого
 * зовут (см. проверки ниже).
 */
type Exemption = 'read' | 'archive' | 'internal' | 'dead-adapter' | 'release-b';

const EXEMPTIONS: Record<Exemption, string> = {
  read: 'чтение и списки: их запрашивает сам экран при открытии, командой человека они не являются',
  archive:
    'распоряжение записью с вкладки «Архив» (ADR 0060, ADR 0070), а не ход заявки по циклу: в меню ' +
    'действий такого пункта нет и быть не должно',
  internal:
    'служебный контур планировщика по общему секрету: за ручкой нет ни человека, ни экрана — её ' +
    'зовёт `apps/worker`',
  'dead-adapter':
    'адаптер совместимости: «Примечание исполнителя» заменено обсуждением (ADR 0141), портальный ' +
    'слайс снят, а ручка живёт своим порядком снятия — не этим планом (Н9)',
  'release-b':
    'вход снят выпуском A, ручка ждёт выпуска B (В1 плана): сервер полон, пока пол клиента не ' +
    'поднят, иначе старый браузер получит 404 на кнопку, которой в новом бандле уже нет',
};

/** Звено портала, которым дверь открывается: имя для поиска по коду и сам вызов для прогона. */
interface PortalCall {
  name: string;
  run: () => Promise<unknown>;
}

/**
 * Строка реестра. Размеченный union, а не пара необязательных полей: причина обязана быть у
 * всякого «входа нет» ПО ТИПУ, а не по договорённости, — ровно тем же приёмом, что у `scope: 'none'`
 * в манифесте сервера. Написать «входа нет» молча компилятор не даст.
 */
type Door =
  | {
      /** Чем портал открывает дверь: метод клиента либо описанный запрос слайса. */
      readonly call: PortalCall;
      /** Где это на экране: вкладка, окно, кнопка, — словами, для человека. */
      readonly entry: string;
      /** Почему у двери нет пункта в меню действий, если его и не должно быть. */
      readonly exempt?: Exemption;
    }
  | {
      readonly call: null;
      readonly exempt: Exemption;
      /** Почему входа нет ИМЕННО У ЭТОЙ ручки — сверх общей причины исключения. */
      readonly why: string;
    };

/**
 * Тела запросов реестру безразличны: он проверяет АДРЕС двери, а не полезную нагрузку — что
 * отправляется внутрь, доказывают контрактные и сценарные тесты. Поэтому клиент зовётся через
 * ослабленный вид, а не через свои типы: иначе на каждую из тридцати трёх ручек пришлось бы
 * сочинить правдоподобное тело, и реестр читался бы как набор фикстур, а не как таблица.
 */
const LOOSE = serviceRequestsApi as unknown as Record<
  string,
  (...args: unknown[]) => Promise<unknown>
>;

/** Приметные значения: по ним путь запроса возвращается к шаблону манифеста (`:id`, `:fileId`). */
const REQUEST_ID = 'REQUEST-ID';
const FILE_ID = 'FILE-ID';

/**
 * Вызов метода клиента. Имя типизировано ключом объекта API: переименованный метод роняет сборку
 * реестра, а не оставляет в нём слово, которого больше нет.
 *
 * Аргументы одни и те же у всех: лишние JS отбрасывает, а на путь влияют только эти два.
 */
const via = (name: keyof typeof serviceRequestsApi): PortalCall => ({
  name: `serviceRequestsApi.${String(name)}`,
  run: () => LOOSE[String(name)]!(REQUEST_ID, FILE_ID, 'act'),
});

/** Запрос слайса, живущий мимо объекта API: у кандидатов в исполнители свой `queryOptions`. */
const candidates: PortalCall = {
  name: 'serviceExecutorCandidatesQuery',
  run: () => (serviceExecutorCandidatesQuery(REQUEST_ID).queryFn as () => Promise<unknown>)(),
};

/**
 * Реестр «ручка ↔ вход». Порядок строк — порядок манифеста сервера: так две таблицы читаются
 * рядом, и пропущенная строка видна глазом раньше, чем прогоном.
 */
const DOORS: Record<string, Door> = {
  // ── Списки, счётчики, карточка ──
  'GET /api/v1/service-requests': {
    call: via('list'),
    entry: 'сам список раздела: вкладки «Заявки» и «Архив»',
    exempt: 'read',
  },
  'GET /api/v1/service-requests/warranties': {
    call: via('warranties'),
    entry: 'вкладка «Гарантии» раздела',
    exempt: 'read',
  },
  'GET /api/v1/service-requests/waiting-count': {
    call: via('waitingCount'),
    entry: 'бейдж «ждут меня» у пункта раздела в меню портала (`AppLayout`)',
    exempt: 'read',
  },
  'GET /api/v1/service-requests/unread-count': {
    call: via('chatUnreadCount'),
    entry: 'синий бейдж непрочитанного у пункта раздела (`AppLayout`)',
    exempt: 'read',
  },
  'POST /api/v1/service-requests/messages/read-all': {
    call: via('markAllChatRead'),
    entry: 'кнопка «Отметить все прочитанными» над списком заявок',
  },
  'GET /api/v1/service-requests/executor-candidates': {
    call: candidates,
    entry: 'поле выбора сотрудников в окне «Исполнители»',
    exempt: 'read',
  },
  'GET /api/v1/service-requests/:id': {
    call: via('get'),
    entry: 'карточка заявки — открытие строки списка и архива',
    exempt: 'read',
  },
  'GET /api/v1/service-requests/:id/history': {
    call: via('history'),
    entry: 'вкладка «История» карточки',
    exempt: 'read',
  },

  // ── Обсуждение (ADR 0141) ──
  'GET /api/v1/service-requests/:id/messages': {
    call: via('chatPage'),
    entry: 'лента окна «Обсуждение» — открытие и подгрузка вверх',
    exempt: 'read',
  },
  'POST /api/v1/service-requests/:id/messages': {
    call: via('sendChatMessage'),
    entry: 'кнопка отправки в окне «Обсуждение»',
  },
  // Отметка о прочтении — не команда человека и не чтение: её шлёт лента после успешного показа.
  // Своей строки исключения такому не заведено намеренно — вход у неё есть, и он в том же окне.
  'POST /api/v1/service-requests/:id/messages/read': {
    call: via('markChatRead'),
    entry: 'окно «Обсуждение»: курсор прочтения после показа ленты',
  },

  // ── Заведение, правка, удаление ──
  'POST /api/v1/service-requests': {
    call: via('create'),
    entry: 'кнопка «Завести заявку» → форма заявки',
  },
  'PATCH /api/v1/service-requests/:id': {
    call: via('update'),
    entry: 'пункт «Редактировать» и главная кнопка подвала карточки → форма заявки',
  },
  'PATCH /api/v1/service-requests/:id/urgency': {
    call: via('setUrgency'),
    entry: 'пункт «Отметить срочной» / «Снять срочность» → окно срочности',
  },
  'DELETE /api/v1/service-requests/:id': {
    call: via('remove'),
    entry: 'пункт «Удалить» в меню списка и карточки',
  },

  // ── Распределение ──
  'PUT /api/v1/service-requests/:id/executors': {
    call: via('putExecutors'),
    entry:
      'кнопка у поля «Исполнители» и пункт «Назначить / Изменить исполнителей» → окно назначения',
  },

  // ── Ходы исполнителя ──
  'PATCH /api/v1/service-requests/:id/decline': {
    call: via('decline'),
    entry: 'пункт «Отказаться от заявки» → запрос причины',
  },
  'PATCH /api/v1/service-requests/:id/start': {
    call: via('start'),
    entry: 'кнопка «Принять в работу» в подвале карточки, быстрая кнопка списка и пункт меню',
  },
  'PUT /api/v1/service-requests/:id/estimate': {
    call: via('saveEstimate'),
    entry: 'окно «Объём работ»: сохранение состава',
  },
  'PATCH /api/v1/service-requests/:id/estimate/submit': {
    call: via('submitEstimate'),
    entry: 'окно «Объём работ»: кнопка предъявления',
  },
  'PATCH /api/v1/service-requests/:id/estimate/approval': {
    call: via('decideEstimate'),
    entry: 'кнопки «Согласовать» и «Не согласовано» под таблицей объёма работ',
  },
  'PATCH /api/v1/service-requests/:id/estimate/reopen': {
    call: via('reopenEstimate'),
    entry: 'кнопка «Вернуть в правку» под таблицей объёма работ',
  },
  'PUT /api/v1/service-requests/:id/consumables': {
    call: via('putConsumables'),
    entry: 'кнопка под таблицей на вкладке «Номенклатура»',
  },
  'PATCH /api/v1/service-requests/:id/consumables/issued': {
    call: via('setConsumablesIssued'),
    entry: 'пункт «Отметить выдачу» → окно выдачи',
  },
  'PATCH /api/v1/service-requests/:id/complete': {
    call: via('complete'),
    entry: 'пункт «Закрыть работы» → окно закрытия',
  },
  /*
   * ИЗВЕСТНАЯ МЁРТВАЯ ДВЕРЬ (Н9 плана). Клиентского метода к ней нет вовсе — не «был и снят», а не
   * заводился с тех пор, как «Примечание исполнителя» заменено обсуждением. Строка стоит здесь
   * именно затем, чтобы находка не открывалась заново каждым, кто читает инвентарь: снимается
   * ручка своим порядком и своим ADR, а этот план её не трогает.
   *
   * Караул при этом не спит: появись у ручки вызов с экрана — реестр упадёт, потому что мёртвая
   * дверь, которую вдруг начали открывать, это уже не мёртвая дверь, а необъявленная команда.
   */
  'PATCH /api/v1/service-requests/:id/service-comment': {
    call: null,
    exempt: 'dead-adapter',
    why: 'портального слайса «Примечание исполнителя» нет с ADR 0141: ни метода клиента, ни экрана',
  },

  // ── Ходы «Ведения» ──
  'PATCH /api/v1/service-requests/:id/accept': {
    call: via('accept'),
    entry: 'пункт «Принять работу» → окно приёмки',
  },
  'PATCH /api/v1/service-requests/:id/rework': {
    call: via('rework'),
    entry: 'кнопка «Вернуть на доработку» в окне приёмки',
  },
  'PATCH /api/v1/service-requests/:id/status': {
    call: via('changeStatus'),
    entry: 'пункт «Отменить заявку» и административные откаты → запрос причины',
  },
  'PATCH /api/v1/service-requests/:id/hold': {
    call: via('hold'),
    entry: 'пункт «Отложить» → окно заморозки',
  },
  'PATCH /api/v1/service-requests/:id/resume': {
    call: via('resume'),
    entry: 'пункт «Возобновить» → то же окно',
  },
  /*
   * РАДИ ЧЕГО ВСЁ И ЗАТЕВАЛОСЬ (Н4, Р2, В1). Выпуск A снял вертикаль повтора письма с портала:
   * пункт, мутацию, ключ идемпотентности и метод клиента. Ручка на сервере жива до выпуска B, и
   * это осознанное окно совместимости, а не забытый хвост.
   *
   * Строка обязана исчезнуть вместе с ручкой: перечень ручек берётся из манифеста, и как только
   * выпуск B снимет там маршрут, реестр потребует убрать и эту строку — иначе караул сторожил бы
   * несуществующее.
   */
  'POST /api/v1/service-requests/:id/notify': {
    call: null,
    exempt: 'release-b',
    why: 'кнопка «Отправить письмо службе ещё раз» и метод клиента сняты выпуском A (Э2)',
  },

  // ── Документы ──
  'POST /api/v1/service-requests/:id/files': {
    call: via('attachFiles'),
    entry: 'загрузка документа на вкладке «Документы» карточки',
  },
  'DELETE /api/v1/service-requests/:id/files/:fileId': {
    call: via('detachFile'),
    entry: 'кнопка снятия у строки документа на вкладке «Документы»',
  },

  // ── Архив ──
  'POST /api/v1/service-requests/:id/restore': {
    call: via('restore'),
    entry: 'кнопка «Вернуть» в строке вкладки «Архив»',
    exempt: 'archive',
  },
  'DELETE /api/v1/service-requests/:id/purge': {
    call: via('purge'),
    entry: 'кнопка «Удалить насовсем» в строке вкладки «Архив»',
    exempt: 'archive',
  },

  // ── Служебный контур ──
  'POST /internal/service-requests/auto-close': {
    call: null,
    exempt: 'internal',
    why: 'автозакрытие «Решена» → «Закрыта» заводит планировщик по общему секрету, а не человек',
  },
};

const REGISTRY_KEYS = Object.keys(DOORS);

const keysWhere = (pick: (door: Door) => boolean): string[] =>
  REGISTRY_KEYS.filter((key) => pick(DOORS[key]!));

const sorted = (keys: Iterable<string>): string[] => [...keys].sort();

/* ─── факт третий: куда уходит объявленный вход ──────────────────────────────────────────────── */

/**
 * Адрес запроса возвращается к шаблону манифеста: приметные значения — обратно в параметры, префикс
 * `/api/v1` — обратно на место (`mockHttp` его срезает).
 */
function routeKeyOf(call: RecordedCall): string {
  const path = call.path
    .split('/')
    .map((segment) => (segment === REQUEST_ID ? ':id' : segment === FILE_ID ? ':fileId' : segment))
    .join('/');
  return `${call.method} /api/v1${path}`;
}

/** Что ушло в сеть при вызове каждого объявленного звена: имя звена → адреса запросов. */
const SENT = new Map<string, string[]>();

beforeAll(async () => {
  /*
   * Роутер пустой намеренно: ответ реестру не нужен — нужен адрес. Каждый вызов поэтому падает
   * («нет мока»), и падение это гасится здесь же: `takeUnmatchedHttp` снимает список
   * незамоканного, иначе общая сверка `test/setup.ts` объявила бы его пропущенным маршрутом
   * экрана.
   */
  const http = mockHttp({});
  for (const key of REGISTRY_KEYS) {
    const door = DOORS[key]!;
    if (!door.call) continue;
    const before = http.calls.length;
    await door.call.run().catch(() => undefined);
    SENT.set(door.call.name, http.calls.slice(before).map(routeKeyOf));
  }
  takeUnmatchedHttp();
});

describe('перечень ручек модуля и реестр входов сходятся (К8)', () => {
  it('у каждой ручки сервера есть строка реестра', () => {
    for (const route of ROUTES) {
      expect(
        REGISTRY_KEYS.includes(route),
        `ручка «${route}» появилась мимо реестра входов: объявите, чем она открывается с экрана ` +
          '(метод клиента и место — вкладка, окно, кнопка), либо назовите причину, по которой ' +
          'входа у неё нет и не должно быть (§7.4 плана меню действий)',
      ).toBe(true);
    }
  });

  it('в реестре нет строк, которых на сервере уже нет', () => {
    for (const key of REGISTRY_KEYS) {
      expect(
        ROUTES.includes(key),
        `реестр держит «${key}», а манифест сервера такой ручки больше не знает: снимите строку ` +
          'вместе с ручкой — караул, сторожащий несуществующее, только мешает читать падения',
      ).toBe(true);
    }
  });

  it('все методы клиента названы в реестре', () => {
    /*
     * Обратная сторона того же правила и вторая половина «мёртвого кода»: метод клиента, не
     * названный ни одной строкой, — либо забытая дверь, либо вызов в 404. Проверяется по самому
     * объекту API, а не по его тексту: фабрики (`createListApi`, `createWriteApi`) дают ключи,
     * которых в файле нет ни одной строкой.
     */
    const declared = new Set(
      REGISTRY_KEYS.map((key) => DOORS[key]!.call?.name).filter(Boolean) as string[],
    );
    for (const method of Object.keys(serviceRequestsApi)) {
      expect(
        declared.has(`serviceRequestsApi.${method}`),
        `у клиента появился метод «${method}», не названный ни одной строкой реестра: либо он ` +
          'открывает ручку модуля — и тогда строка обязана его назвать, — либо не зовёт никто, и ' +
          'тогда это мёртвый код на портальной стороне',
      ).toBe(true);
    }
  });
});

describe('объявленный вход и правда открывает свою дверь', () => {
  it('каждое звено портала уходит ровно в ту ручку, под которой записано', () => {
    for (const key of keysWhere((door) => door.call !== null)) {
      const call = DOORS[key]!.call!;
      expect(
        SENT.get(call.name),
        `«${call.name}» записан входом в «${key}», а уходит не туда: реестр разошёлся с клиентом`,
      ).toEqual([key]);
    }
  });

  it('вход существует на экране, а не только объявлен словами', () => {
    /*
     * Прозу столбца «где это на экране» машина не проверит, но проверит главное: что звено вообще
     * кто-то зовёт из портала. Метод, живущий в клиенте и не вызванный ни одним экраном, — ровно
     * та мёртвая дверь, ради которой караул и заведён, только с портальной стороны: снаружи ручка
     * доступна, изнутри недостижима.
     */
    for (const key of keysWhere((door) => door.call !== null)) {
      const { call, entry } = DOORS[key]! as { call: PortalCall; entry: string };
      expect(
        callersOf(call.name),
        `реестр обещает вход «${entry}» (${call.name}), но в исходниках портала его не зовёт ни ` +
          'один экран: либо вход сняли и не убрали строку, либо ручку пора снимать вместе с ' +
          'методом клиента',
      ).not.toHaveLength(0);
    }
  });
});

describe('двери без входа объявлены и остаются закрытыми', () => {
  it('у каждой названа причина из закрытого перечня', () => {
    for (const key of keysWhere((door) => door.call === null)) {
      const door = DOORS[key]! as { exempt: Exemption; why: string };
      expect(EXEMPTIONS[door.exempt], `у «${key}» причина не из перечня`).toBeTruthy();
      expect(
        door.why,
        `у «${key}» не сказано, почему входа нет именно у неё: общей причины «${door.exempt}» ` +
          'мало — реестр читают через полгода',
      ).toBeTruthy();
    }
  });

  it('портал их не зовёт: ни методом клиента, ни прямым запросом', () => {
    /*
     * Двух проверок здесь мало по одной: журнал сети видит только то, что объявлено реестром, а
     * прямой `apiFetch` мимо объекта API в портале встречается (так живут кандидаты в исполнители)
     * — поэтому хвост пути ищется ещё и текстом по всем исходникам. Комментарии из них сняты:
     * упоминание мёртвой ручки в пояснении к чату — это не вызов.
     */
    for (const key of keysWhere((door) => door.call === null)) {
      const literal = absenceLiteral(key);
      expect(
        mentionsOf(literal),
        `дверь «${key}» объявлена реестром закрытой, а портал ходит в «${literal}»: если вход ` +
          'вернули — опишите его строкой реестра, если нет — уберите вызов',
      ).toEqual([]);
    }
  });

  it('мёртвые двери — ровно те две, что известны плану', () => {
    /*
     * Перечень записан вторым разом намеренно (первый — в самих строках). Без него пометка
     * «мёртвая» становится способом усыпить караул: новая ручка без входа объявляется адаптером —
     * и молчит. Здесь она молчать не сможет: либо у команды есть вход, либо снятие ручки идёт
     * своим планом, и тогда правятся два места сразу, а ревьюер видит вопрос.
     */
    expect(
      sorted(keysWhere((door) => door.call === null && door.exempt === 'dead-adapter')),
    ).toEqual(['PATCH /api/v1/service-requests/:id/service-comment']);
    expect(sorted(keysWhere((door) => door.call === null && door.exempt === 'release-b'))).toEqual([
      'POST /api/v1/service-requests/:id/notify',
    ]);
  });

  it('повтор письма службе снят с портала целиком (К1, выпуск A)', () => {
    // Точечно, а не общим поиском слова `notify`: в портале остаются законные браузерные и
    // почтовые уведомления, и общий поиск был бы красным всегда (§7.4).
    expect(Object.keys(serviceRequestsApi)).not.toContain('notify');
    expect(mentionsOf('/notify')).toEqual([]);
  });
});

describe('исключения из правила «команда обязана иметь вход» проверяемы', () => {
  it('«чтение» стоит только у читающих ручек', () => {
    for (const key of keysWhere((door) => door.exempt === 'read')) {
      expect(
        key.startsWith('GET '),
        `«${key}» помечена чтением, а меняет состояние: у изменяющей ручки вход обязателен, и ` +
          'пометка «чтение» здесь снимает вопрос вместо ответа',
      ).toBe(true);
    }
  });

  it('«служебная» стоит только у внутреннего контура', () => {
    for (const key of keysWhere((door) => door.exempt === 'internal')) {
      expect(
        key.includes(' /internal/'),
        `«${key}» помечена служебной, но живёт на прикладном префиксе: её открывает человек, а ` +
          'значит, у неё обязан быть вход',
      ).toBe(true);
    }
  });

  it('«архив» и правда открывается с вкладки «Архив»', () => {
    for (const key of keysWhere((door) => door.exempt === 'archive')) {
      const call = DOORS[key]!.call!;
      expect(
        callersOf(call.name).filter((file) => file.includes('Archive')),
        `«${key}» объявлена входом с вкладки «Архив», но зовут её из других мест: ` +
          `${callersOf(call.name).join(', ')}. Либо вход переехал — и строка врёт, — либо пометка ` +
          'не та',
      ).not.toHaveLength(0);
    }
  });
});

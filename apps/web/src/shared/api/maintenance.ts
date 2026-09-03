/**
 * Режим технических работ: закрыт ли портал прямо сейчас.
 *
 * Это НЕ обслуживание техники (`entities/vehicle-maintenance`, акты ТО): здесь про окно
 * cutover-миграции, когда портал закрывают целиком — план `docs/maintenance-mode-plan.md`. Слово
 * «maintenance» в портале уже занято ТО, поэтому имена тут длиннее обычного
 * (`isMaintenanceModeActive`, а не `isMaintenanceActive`): спутать эти два состояния значит принять
 * закрытый портал за плановый ремонт экскаватора.
 *
 * **Почему состояние живёт вне дерева React.** Ставит его транспорт, отвечая на чужой запрос —
 * 503 приходит фоновому обновлению списка, — а показывает заглушка над всем приложением. Ровно то
 * же устройство у требования обновиться (`clientContract.ts`) и у конца сессии (`session.ts`), и
 * причина общая: отказ приходит посреди работы, любому запросу, и знать о нём должен экран, а не
 * тот, кто этот запрос отправлял.
 *
 * **Почему состояние обратимое, в отличие от `requireClientUpgrade`.** Требование обновиться
 * необратимо: совместимым ответ сервера уже не станет. Окно техработ, наоборот, кончается, и
 * вкладка обязана продолжить работу сама — без перезагрузки и без входа заново (Р4 плана):
 * `POST /auth/refresh` из-под серверного гейта выведен насовсем и переживает окно целиком.
 *
 * Ставят флаг два канала, и они не дублируют друг друга (Р6): 503 от гейта — немедленный сигнал
 * вкладке; `/maintenance.json` — единственный источник, переживающий остановку `technic-api`, и
 * только он же режим СНИМАЕТ. Опрашивает файл граница режима (`app/MaintenanceBoundary.tsx`),
 * транспорт про файл не знает.
 */

/** Код отказа гейта. Разбирается ПАРОЙ со статусом — по образцу `isClientUpgradeResponse`. */
export const MAINTENANCE_MODE_CODE = 'maintenance_mode';

/** 503 Service Unavailable — статус, которым сервер отбивает запрос в закрытый портал. */
export const MAINTENANCE_MODE_STATUS = 503;

/** Отказ замкнутого транспорта: тем же текстом, каким объявляет о себе заглушка. */
export const MAINTENANCE_MODE_MESSAGE = 'Портал закрыт на технические работы';

/** Что оператор сказал о работах. Обе величины необязательны — окно бывает и без объяснений. */
export interface MaintenanceModeNotice {
  /** Что делают в окне; `null` — не назвали. */
  reason: string | null;
  /** Когда работы ожидаются законченными, ISO 8601; `null` — срок не назвали. */
  until: string | null;
}

export interface MaintenanceModeState extends MaintenanceModeNotice {
  active: boolean;
}

/**
 * Длина причины ограничена и здесь. Сервер её обрезает при записи и при чтении `prod.env` (§4.1
 * плана), но тот же текст приезжает вторым каналом — файлом статуса, который сервер не читает
 * вовсе. От него портал не защищён ничем, а строка на несколько килобайт разложила бы заглушку.
 */
const REASON_LIMIT = 200;

const CLOSED_NOTHING: MaintenanceModeState = { active: false, reason: null, until: null };

/**
 * Снимок состояния. Ссылка меняется ТОЛЬКО вместе со значением: `useSyncExternalStore` сравнивает
 * снимки по ссылке, и новый объект на каждое чтение увёл бы React в бесконечную перерисовку.
 * Отсюда же и молчание при повторе: файл опрашивается раз в 25 секунд и всё окно отвечает одно и
 * то же — уведомлять подписчиков об этом нечем.
 */
let state: MaintenanceModeState = CLOSED_NOTHING;
let handlers: (() => void)[] = [];

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, REASON_LIMIT);
  return trimmed === '' ? null : trimmed;
}

/**
 * Причина и срок из чужого тела. Один разбор на оба канала намеренно: у 503 они лежат в `details`,
 * у файла статуса — прямо в корне, но поля те же, и вторая копия правила разошлась бы с первой при
 * первой же правке контракта.
 */
export function readMaintenanceModeNotice(source: unknown): MaintenanceModeNotice {
  if (typeof source !== 'object' || source === null) return { reason: null, until: null };
  const raw = source as { reason?: unknown; until?: unknown };
  return { reason: text(raw.reason), until: text(raw.until) };
}

/** Тот ли это отказ гейта: 503 **и** его код. */
export function isMaintenanceModeResponse(status: number, code: string | undefined): boolean {
  return status === MAINTENANCE_MODE_STATUS && code === MAINTENANCE_MODE_CODE;
}

/** Закрыт ли портал прямо сейчас. */
export function isMaintenanceModeActive(): boolean {
  return state.active;
}

/** Снимок для `useSyncExternalStore`: состояние вместе с тем, что о нём сказал оператор. */
export function maintenanceModeState(): MaintenanceModeState {
  return state;
}

/** Подписка на перемену состояния; возвращает функцию отписки. */
export function onMaintenanceModeChange(handler: () => void): () => void {
  handlers = [...handlers, handler];
  return () => {
    handlers = handlers.filter((h) => h !== handler);
  };
}

function publish(next: MaintenanceModeState): void {
  if (next.active === state.active && next.reason === state.reason && next.until === state.until) {
    return;
  }
  state = next;
  for (const handler of handlers) handler();
}

/**
 * Портал закрыт. Зовут оба канала: транспорт — увидев 503, граница — прочитав файл статуса.
 * Последнее сказанное побеждает: причину и срок в оба канала пишет одна команда оператора, и
 * разойтись им неоткуда, а сложенные «по максимуму» они пережили бы правку окна на ходу.
 */
export function enterMaintenanceMode(notice: MaintenanceModeNotice): void {
  publish({ active: true, reason: notice.reason, until: notice.until });
}

/**
 * Работы кончились. Зовёт только опрос файла, и только на ПОДТВЕРЖДЁННЫЙ ответ (404 либо
 * `active !== true`): «не смог спросить» — не то же самое, что «работы кончились», разбор ответа
 * живёт в границе режима.
 */
export function leaveMaintenanceMode(): void {
  publish(CLOSED_NOTHING);
}

/**
 * Ходит ли этот запрос сквозь закрытый портал.
 *
 * Исключение ровно одно, и оно не про удобство. `POST /auth/logout` идёт через `apiFetch`
 * (`api/auth.ts`), и замкни его транспорт — человек, нажавший «Выйти», остался бы с живой
 * серверной refresh-сессией: вкладка забыла бы токен, а сервер продолжал бы менять refresh-cookie
 * на новые access-токены. На сервере эта ручка из-под гейта выведена насовсем (Р4 плана), то есть
 * замыкание отбивало бы запрос, который сервер как раз готов исполнить.
 *
 * `POST /auth/refresh` в списке не нужен: у него собственный `fetch` мимо транспорта
 * (`session.ts`), и замыкание его не касается вовсе — а коснись оно, вкладка прочитала бы отказ
 * как конец сессии и выбросила бы человека на форму входа, то есть сделала бы ровно то, чего
 * режим избегает.
 */
export function isMaintenanceModeExempt(method: string, path: string): boolean {
  return method.toUpperCase() === 'POST' && path === '/auth/logout';
}

/** Тестам: вернуть модуль в состояние «портал открыт, оператор ничего не объявлял». */
export function __resetMaintenanceModeForTests(): void {
  state = CLOSED_NOTHING;
  handlers = [];
}

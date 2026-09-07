import {
  canRunServiceBulkOperation,
  serviceRequestBulkOperationLabels,
  serviceRequestStatusLabels,
  type AuthUser,
  type ServiceRequestBulkBody,
  type ServiceRequestBulkOperation,
  type ServiceRequestDto,
} from '@technic/contracts';
import type { ServiceMenuItem } from './serviceStatusChoices';

/**
 * Команды полосы выбора — **проекция набора действий заявки**, а не второй перебор правил
 * (план `docs/office-equipment-bulk-actions-plan.md`, Р6 и Р16).
 *
 * Тем же приёмом, что список переходов у тега статуса (`serviceStatusChoices.ts`): доступность
 * считают предикаты контрактов один раз — при сборке набора действий, — а здесь набор только
 * переводится в команды. Своя карта «роль → что можно массово» разошлась бы с одиночным меню на
 * первом же изменении цикла, и разошлась бы МОЛЧА: полоса предлагала бы то, на что сервер
 * отвечает 403, либо прятала бы разрешённое.
 *
 * Второй рубеж — точное право операции (`canRunServiceBulkOperation`): у пакета оно строже
 * одиночной ручки ровно в одном месте (Р5, массовый `start` открыт только назначенным), и
 * спрашивается оно тем же предикатом контрактов, что и сервером.
 */

/** Ключ пункта набора действий → пакетная операция. Пары ищутся здесь и больше нигде. */
const OPERATION_BY_KEY: Record<string, ServiceRequestBulkOperation> = {
  cancel: 'cancel',
  hold: 'hold',
  resume: 'resume',
  assign: 'assign',
  start: 'start',
  accept: 'accept',
  // «Удалить» — слово портала: заявка уходит в архив, и пакетная операция называется архивной.
  delete: 'archive',
};

/**
 * Операции, которые полоса доводит до конца сама.
 *
 * Массового назначения здесь нет, и это не забывчивость: тело `assign` несёт СОСТАВ исполнителей
 * (`userIds` и компанию), а перечень кандидатов сервер считает по одной заявке
 * (`GET /service-requests/:id/executor-candidates`, Р7 плана аудита исполнителей). «Кто сможет
 * работать по всем пятидесяти» сегодня спросить нечем, а подставить кандидатов одной строки за
 * всю пачку значило бы назначить людей на заявки, по которым сервер их не пустит. Команда
 * появится вместе с ручкой кандидатов по набору строк.
 */
export type ServiceBulkUiOperation = Exclude<ServiceRequestBulkOperation, 'assign'>;

/** Строка пачки: пара «идентификатор + версия» (Р4) — то, что человек видел, когда выбирал. */
export interface ServiceBulkRowRef {
  id: string;
  version: number;
}

/** Строка, к которой команда неприменима, и почему — поимённо (Р11). */
export interface ServiceBulkSkipped {
  request: ServiceRequestDto;
  reason: string;
}

export interface ServiceBulkCommand {
  operation: ServiceBulkUiOperation;
  label: string;
  danger: boolean;
  /** Строки, к которым команда применима: их и считает счётчик «7 из 9». */
  rows: ServiceRequestDto[];
  /** Остальные выбранные: подтверждение перечисляет их с причинами. */
  skipped: ServiceBulkSkipped[];
}

/** Пакетные пункты одной строки: операция → сам пункт (он же несёт запрет и его причину). */
function bulkItemsOf(
  request: ServiceRequestDto,
  actionsFor: (request: ServiceRequestDto) => ServiceMenuItem[],
): Map<ServiceBulkUiOperation, ServiceMenuItem> {
  const items = new Map<ServiceBulkUiOperation, ServiceMenuItem>();
  for (const item of actionsFor(request)) {
    // Срочность — один пункт меню и ДВЕ пакетные операции: включение требует объяснения, снятие
    // не требует вовсе (§4). Куда ведёт пункт, знает сама заявка, а не таблица ключей.
    const operation =
      item.key === 'urgency'
        ? request.isUrgent
          ? 'urgency_off'
          : 'urgency_on'
        : OPERATION_BY_KEY[item.key];
    if (!operation || operation === 'assign') continue;
    items.set(operation, item);
  }
  return items;
}

/**
 * Почему команда обошла строку. Причина запрета берётся у самого пункта, если он её называет
 * (замок непроверенного предмета у приёмки), — второй формулировки того же запрета не заводим.
 */
function refusalOf(
  operation: ServiceBulkUiOperation,
  item: ServiceMenuItem | undefined,
  request: ServiceRequestDto,
): string {
  if (item?.disabledReason) return item.disabledReason;
  if (operation === 'urgency_on' && request.isUrgent) return 'Срочность уже стоит';
  if (operation === 'urgency_off' && !request.isUrgent) return 'Заявка не срочная';
  /*
   * Точную причину портал не знает и выдумывать её не станет: отказал один из предикатов набора
   * действий — сторона, область, состав исполнителей или статус. Статус называется в скобках как
   * обстоятельство, а не как причина: «недоступно, потому что „Решена“» бывало бы неправдой.
   */
  return `Действие этой заявке недоступно (статус «${serviceRequestStatusLabels[request.status]}»)`;
}

/**
 * Команды полосы для выбранных строк.
 *
 * Команда попадает в полосу, если она применима **хотя бы к одной** выбранной строке (Р6):
 * требование «годятся все» превратило бы полосу в загадку «какая из строк мешает». Счётчик
 * применимых и поимённый список пропущенных отвечают на этот вопрос прямо.
 *
 * Порядок команд — порядок пунктов в наборе действий: сперва ход заявки, потом обстоятельства, а
 * отмена последней, потому что она отнимает работу целиком. Свой список порядка разошёлся бы с
 * меню ровно так же, как разошлась бы своя карта доступности.
 */
export function serviceBulkCommands(
  selected: ServiceRequestDto[],
  actionsFor: (request: ServiceRequestDto) => ServiceMenuItem[],
  user: AuthUser | null,
): ServiceBulkCommand[] {
  const perRow = selected.map((request) => ({ request, items: bulkItemsOf(request, actionsFor) }));
  const order: ServiceBulkUiOperation[] = [];
  for (const { items } of perRow) {
    for (const operation of items.keys()) if (!order.includes(operation)) order.push(operation);
  }

  const commands: ServiceBulkCommand[] = [];
  for (const operation of order) {
    // Право операции — свойство субъекта, а не строки (Р5): его нет — команды нет вовсе.
    if (!canRunServiceBulkOperation(user, operation)) continue;
    const rows: ServiceRequestDto[] = [];
    const skipped: ServiceBulkSkipped[] = [];
    let danger = false;
    for (const { request, items } of perRow) {
      const item = items.get(operation);
      if (item?.danger) danger = true;
      if (item && !item.disabled) rows.push(request);
      else skipped.push({ request, reason: refusalOf(operation, item, request) });
    }
    // Ноль применимых — не команда, а обещание: нажатие по ней не сделало бы ничего.
    if (rows.length === 0) continue;
    commands.push({
      operation,
      label: serviceRequestBulkOperationLabels[operation],
      danger,
      rows,
      skipped,
    });
  }
  return commands;
}

/**
 * Почему строку нельзя выбрать; `null` — можно. Выключенный чекбокс без объяснения читается как
 * поломка портала, поэтому причина уходит подсказкой (`SelectionConfig.disabled`).
 */
export function serviceBulkRefusal(
  request: ServiceRequestDto,
  actionsFor: (request: ServiceRequestDto) => ServiceMenuItem[],
  user: AuthUser | null,
): string | null {
  for (const [operation, item] of bulkItemsOf(request, actionsFor)) {
    if (!item.disabled && canRunServiceBulkOperation(user, operation)) return null;
  }
  return 'Массовых действий по этой заявке нет';
}

/** Поле общей причины команды: то же поле и та же схема, что у одиночной ручки (§6.1). */
export interface ServiceBulkPrompt {
  label: string;
  /** Обязательность — свойство тела команды (Р5), а не вежливость формы. */
  required: boolean;
}

/**
 * У каких команд спрашивается общая причина. Обязательна она там, где её требует схема тела:
 * отмена, заморозка, включение срочности — одно объяснение честно описывает все строки пачки.
 * Возобновление и приёмка принимают слово вдогонку, и оно необязательно.
 */
export const serviceBulkPrompts: Partial<Record<ServiceBulkUiOperation, ServiceBulkPrompt>> = {
  cancel: { label: 'Причина отмены — одна на все заявки', required: true },
  hold: { label: 'Почему откладываем — одно объяснение на все заявки', required: true },
  urgency_on: { label: 'Чем вызвана срочность', required: true },
  resume: { label: 'Комментарий (необязательно)', required: false },
  accept: { label: 'Комментарий (необязательно)', required: false },
};

/**
 * О чём человек обязан узнать ДО нажатия, а не из отчёта (Р11): побочные эффекты у пачки те же,
 * что у одиночного действия, но повторённые полусотней чужих заявок.
 */
export const serviceBulkWarnings: Partial<Record<ServiceBulkUiOperation, string>> = {
  cancel:
    'Отмена необратима: с каждой заявки снимаются исполнители, а служба получит письмо «выезд не требуется».',
  archive: 'Заявки уйдут в архив: вернуть их оттуда сможет администратор.',
  accept: 'Приёмка закрывает заявку: вернуть её на доработку можно будет только поодиночке.',
  hold: 'Отложенные заявки уходят из очередей и ждут возобновления — сроки по ним не считаются.',
};

/** Тело команды: тот же размеченный союз, что принимает `POST /service-requests/bulk` (§6.1). */
export function serviceBulkBody(
  operation: ServiceBulkUiOperation,
  rows: ServiceBulkRowRef[],
  text: string,
): ServiceRequestBulkBody {
  switch (operation) {
    case 'cancel':
    case 'hold':
      return { operation, rows, reason: text };
    case 'resume':
    case 'accept':
      return { operation, rows, comment: text };
    case 'urgency_on':
      return { operation, rows, urgencyReason: text };
    case 'urgency_off':
    case 'start':
    case 'archive':
      return { operation, rows };
  }
}

/** «7 заявок» — число в подписи кнопки и в отчёте (Р11). */
export function serviceBulkRequestsLabel(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  const word =
    mod100 >= 11 && mod100 <= 14
      ? 'заявок'
      : mod10 === 1
        ? 'заявку'
        : mod10 >= 2 && mod10 <= 4
          ? 'заявки'
          : 'заявок';
  return `${count} ${word}`;
}

/**
 * Начатая пачка, пережившая перезагрузку вкладки (§7.2).
 *
 * Хранится тело целиком, а не одно намерение: после обрыва «Продолжить» обязано повторить ТОТ ЖЕ
 * запрос — тот же ключ и то же тело, — иначе повтор стал бы второй командой. Отпечаток лежит
 * рядом и сверяется при чтении: запись, не сходящаяся сама с собой, — мусор чужой вкладки.
 */
export interface ServiceBulkRun {
  key: string;
  operation: ServiceBulkUiOperation;
  fingerprint: string;
  body: ServiceRequestBulkBody;
}

/**
 * Отпечаток тела — нормализованный: порядок строк в пачке и порядок ключей в объекте его не
 * меняют, и разойтись отпечаток с телом может только по существу.
 */
export function serviceBulkFingerprint(body: ServiceRequestBulkBody): string {
  const fields = Object.entries(body as Record<string, unknown>)
    .filter(([name]) => name !== 'rows')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const rows = body.rows.map((row) => `${row.id}:${row.version}`).sort();
  return JSON.stringify([fields, rows]);
}

/**
 * Ключ хранилища — на вкладку, а не на сеанс: пачка идёт секундами, и переживать ей нужно
 * перезагрузку, а не закрытие браузера. `sessionStorage` недоступен в приватном режиме части
 * браузеров, и все три функции молча это переживают: без восстановления пачка всё равно доедет —
 * просто человек не увидит её после «F5».
 */
const RUN_STORAGE_KEY = 'service-bulk-run';

/**
 * Запись хранилища — пачка ПЛЮС её хозяин.
 *
 * Учётка лежит В ЗАПИСИ, а не в имени ключа, и это не мелочь оформления. Рабочее место в конторе
 * бывает общим, выход чистит серверную сессию и кэш запросов (`AuthContext`), но не хранилище
 * вкладки. Разведи мы записи по ключам с учёткой — брошенная пачка первого человека пережидала бы
 * чужую смену и всплывала бы «Продолжить» при его возвращении, с версиями строк, устаревшими часы
 * назад. Ключ один, запись одна, и чтение под другой учёткой её СНОСИТ (`readServiceBulkRun`):
 * незаконченная пачка — состояние одного разговора одного человека, а не архив вкладки.
 *
 * Проверка при чтении, а не «погасить при выходе», потому что выход — не единственная дверь:
 * сессия кончается ещё и сама (`onExpired`), а вкладку открывают заново уже под другим человеком.
 * Хозяин, записанный рядом с пачкой, отвечает на вопрос «твоё ли это» в любую из них.
 *
 * Хозяин — свойство ЗАПИСИ, а не самой пачки: `ServiceBulkRun` — это запрос к серверу (ключ, тело,
 * отпечаток), и от того, кто оставил его в браузере, он не зависит.
 */
interface StoredServiceBulkRun extends ServiceBulkRun {
  userId: string;
}

/**
 * Сохранить пачку от имени `userId`. Учётки нет — не сохраняем вовсе, тем же правилом живёт память
 * отборов списков (`shared/lib/listParamsStore`): запись без хозяина подхватил бы первый вошедший.
 */
export function saveServiceBulkRun(run: ServiceBulkRun, userId: string | undefined): void {
  if (!userId) return;
  try {
    const stored: StoredServiceBulkRun = { ...run, userId };
    sessionStorage.setItem(RUN_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    /* приватный режим: записывать некуда */
  }
}

/**
 * Незаконченная пачка этого человека — или `null`, если её нет, она чужая либо не сходится сама с
 * собой.
 *
 * Всё, что этому человеку не годится, чтение сносит на месте. Чужая запись и так ничего не сделает
 * — наружу её не отдают, — но и лежать ей незачем: пока она в хранилище, «Продолжить» над чужим
 * выбором строк остаётся возможным хотя бы теоретически, а мусор вкладки живёт до её закрытия.
 *
 * Пока учётка неизвестна (сессия ещё поднимается) хранилище не трогается вовсе: снести запись
 * здесь значило бы стереть СВОЮ пачку за мгновение до того, как выяснилось, что она своя.
 */
export function readServiceBulkRun(userId: string | undefined): ServiceBulkRun | null {
  if (!userId) return null;
  try {
    const raw = sessionStorage.getItem(RUN_STORAGE_KEY);
    // Пусто — и сносить нечего: лишний вызов хранилища на каждом открытии реестра.
    if (!raw) return null;
    const stored = JSON.parse(raw) as StoredServiceBulkRun | null;
    const own =
      !!stored &&
      stored.userId === userId &&
      !!stored.key &&
      // Список строк проверяется на массив, а не на «что-то есть»: отпечаток считается по нему
      // перебором, и запись, набранная не нами, роняла бы этим перебором открытие реестра.
      Array.isArray(stored.body?.rows) &&
      serviceBulkFingerprint(stored.body) === stored.fingerprint;
    if (own) return stored;
  } catch {
    /* приватный режим либо мусор вместо JSON: пачки нет */
  }
  // Сюда сходятся все отказы — чужая запись, битая, не сошедшаяся с отпечатком: лежать ей незачем.
  clearServiceBulkRun();
  return null;
}

export function clearServiceBulkRun(): void {
  try {
    sessionStorage.removeItem(RUN_STORAGE_KEY);
  } catch {
    /* приватный режим: удалять нечего */
  }
}

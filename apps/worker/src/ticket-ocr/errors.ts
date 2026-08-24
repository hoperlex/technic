import type { WasteTicketErrorClass, WasteTicketErrorScope } from '@technic/contracts';

/**
 * Отказ на файле — до того, как страница вообще дошла до модели (ADR 0114, план
 * `docs/waste-ticket-ocr-plan.md`, Р9, Р10).
 *
 * Отдельный тип ошибки, а не строка в логе, по трём причинам сразу.
 *
 * Первая: у файла есть **своя строка состояния** (`waste_ticket_files`), и отвергнутый файл
 * страниц не порождает — пометить его больше негде (Р10). Молчащее распознавание неотличимо от
 * «талоны в порядке», и это худшее, чем может закончиться недоступность подсистемы (Р29).
 *
 * Вторая: причина уезжает **человеку на экран**, а не администратору в журнал. «Это не
 * изображение и не PDF» и «в файле шесть страниц, обработано пять» — разные действия
 * пользователя, и различить их он должен, не открывая логи.
 *
 * Третья, и главная: **две оси классификации** (Р29) обязаны быть проставлены здесь же, а не
 * додуманы вызывающим. Отсутствие `pdftoppm` в образе воркера — это `terminal` + `subsystem`
 * (сломанный конфиг, поднимает баннер немедленно и ждёт администратора), а не пройденный
 * растеризатором PDF конкретного пользователя — `terminal` + `item` (строка файла, баннера нет).
 * Спутать их значит либо поднять красный баннер на одном кривом скане, либо промолчать о
 * несобранном образе.
 */
export class TicketFileError extends Error {
  /** Машинный код: он же `waste_ticket_files.reason` для тестов и метрик. */
  readonly code: string;
  /** Человеческая причина — ровно то, что увидит разбирающий заявку. */
  readonly reason: string;
  readonly errorClass: WasteTicketErrorClass;
  readonly errorScope: WasteTicketErrorScope;

  constructor(params: {
    code: string;
    reason: string;
    errorClass: WasteTicketErrorClass;
    errorScope: WasteTicketErrorScope;
    cause?: unknown;
  }) {
    super(`${params.code}: ${params.reason}`, { cause: params.cause });
    this.name = 'TicketFileError';
    this.code = params.code;
    this.reason = params.reason;
    this.errorClass = params.errorClass;
    this.errorScope = params.errorScope;
  }
}

/**
 * Файл отвергнут навсегда: повтор ничего не изменит, ждать нечего — `unsupported` в строке файла.
 * Ошибка принадлежит **этому** файлу и глобального баннера не поднимает (Р29).
 */
export function unsupportedFile(code: string, reason: string, cause?: unknown): TicketFileError {
  return new TicketFileError({ code, reason, errorClass: 'terminal', errorScope: 'item', cause });
}

/**
 * Обработка сорвалась, но повтор осмыслен: растеризатор не уложился в срок на тяжёлом скане,
 * временно не хватило памяти. Строка файла остаётся в работе, задача уходит на следующую попытку.
 */
export function retryableFile(code: string, reason: string, cause?: unknown): TicketFileError {
  return new TicketFileError({ code, reason, errorClass: 'transient', errorScope: 'item', cause });
}

/**
 * Сломан не файл, а сама подсистема: нет внешнего растеризатора, недоступен временный каталог.
 * Такое поднимает баннер сразу, минуя порог доли ошибок, и снимается только вмешательством
 * администратора (Р29): повторять эту задачу пятьсот раз бессмысленно, чинить нужно образ.
 */
export function brokenSubsystem(code: string, reason: string, cause?: unknown): TicketFileError {
  return new TicketFileError({
    code,
    reason,
    errorClass: 'terminal',
    errorScope: 'subsystem',
    cause,
  });
}

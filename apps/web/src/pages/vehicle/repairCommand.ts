import type {
  KnownFill,
  MachinistAnchor,
  RepairBody,
  RepairPreviewDto,
  TailResolution,
} from '@technic/contracts';

/**
 * Сборка тела двери ремонта (подэтап 6a плана `docs/assignment-periods-plan.md`, Р29).
 *
 * Отдельным файлом от окна по той же причине, что и у команды машиниста: окно ведёт разговор —
 * осмотр, предпросмотр, отказы, подтверждение, — а здесь только правила, по которым набранное
 * человеком превращается в запрос. Их можно проверить без единого рендера, и это единственное
 * место портала, знающее форму тела.
 */

/** Что человек набрал в окне: три работы ремонта плюс отдельная команда отмены. */
export type RepairDraft =
  | {
      kind: 'repair';
      /** Имена на границах, которые назвал предпросмотр (Р16). */
      anchors: MachinistAnchor[];
      /** Заполнение `unknown` отрезками (Ц4): пустой список — работы этого вида нет. */
      fills: KnownFill[];
      /** Решение о машине после конца срока (Р31); `null` — не трогаем. */
      tail: TailResolution | null;
    }
  | { kind: 'cancel_fill'; changeGroupId: string };

/** Рукопожатия, которые окно добавляет к телу на боевом вызове, но не на предпросмотре (§8). */
interface Handshake {
  version: number;
  previewFingerprint?: string | undefined;
  unlockFingerprint?: string | null | undefined;
  operation?: { operationId: string; reason: string } | null;
  /** Вывести заявку из архива вместе с ремонтом (Р29): спрашивается только там, где сервер требует. */
  restore?: boolean;
}

/**
 * Тело запроса из набранного и рукопожатий.
 *
 * Пустые работы не отправляются вовсе: `knownFills: []` схема отвергает («пустой список ничего не
 * сообщает»), и посылать его значило бы получать 400 там, где человек просто не заполнял этот
 * раздел. По той же причине `anchors` уезжает только непустым.
 */
export function repairBody(draft: RepairDraft, hand: Handshake): RepairBody {
  const common = {
    version: hand.version,
    ...(hand.previewFingerprint ? { previewFingerprint: hand.previewFingerprint } : {}),
    // Присутствие подтверждения задаёт **ответ сервера**, а не желание клиента: лишний отпечаток
    // отвергается так же строго, как недостающий.
    ...(hand.unlockFingerprint ? { unlockFingerprint: hand.unlockFingerprint } : {}),
    ...(hand.operation ? { operation: hand.operation } : {}),
    ...(hand.restore ? { restore: true } : {}),
  };
  if (draft.kind === 'cancel_fill') {
    return { mode: 'cancel_fill', target: { changeGroupId: draft.changeGroupId }, ...common };
  }
  return {
    mode: 'repair',
    ...(draft.anchors.length > 0 ? { anchors: draft.anchors } : {}),
    ...(draft.fills.length > 0 ? { knownFills: draft.fills } : {}),
    ...(draft.tail ? { tailResolution: draft.tail } : {}),
    ...common,
  };
}

/**
 * Названа ли в наборе хоть одна работа.
 *
 * Кнопка «Показать последствия» без этого гасится: пустой ремонт отвергает схема, и дать нажать
 * значило бы обещать разговор, который кончится 400-м на первом же шаге.
 */
export function repairHasWork(draft: RepairDraft): boolean {
  if (draft.kind === 'cancel_fill') return true;
  return draft.anchors.length > 0 || draft.fills.length > 0 || draft.tail !== null;
}

/**
 * Отрезок заполнения обязан целиком лежать внутри названного сервером промежутка (Ц4).
 *
 * Проверка здесь — не дубль серверной, а способ сказать это до отправки: чужая граница приходит
 * 422-м с текстом «Отрезок вне промежутка», и человек, сузивший окно на день, не поймёт, какой из
 * трёх его отрезков сервер счёл чужим.
 */
export function fillFitsGap(fill: { from: string; to: string }, gap: RepairGap): boolean {
  return fill.from >= gap.from && fill.to <= gap.to && fill.from <= fill.to;
}

export type RepairGap = { from: string; to: string };

/**
 * Нужно ли окно ремонта вообще: есть ли в истории заявки что чинить.
 *
 * Считается по ответу осмотра, а не по состоянию заявки: `ready` — не признак того, что делать
 * нечего. Заполнение живёт на заблокированных днях, а они блокерами не бывают (Р16), и заявка с
 * дырой в прошлом законно числится полной.
 */
export function repairHasSomethingToDo(state: RepairPreviewDto): boolean {
  return (
    state.fillableGaps.length > 0 ||
    state.requiredAnchors.length > 0 ||
    state.requiredVehicleResolution !== null ||
    state.blockedDays.length > 0
  );
}

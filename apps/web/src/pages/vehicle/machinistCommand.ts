import type {
  AssignmentChangeTarget,
  AssignmentCommandBody,
  MachinistAnchor,
  SpecialEquipmentRequestDto,
} from '@technic/contracts';
import type { AssignmentCommandResultDto } from '../../api/resources';
import type { AssignmentSegment } from './assignmentTimeline';

/**
 * Сборка команды машиниста и разбор её ответа (этап 6 плана `docs/assignment-periods-plan.md`, §8).
 *
 * Отдельным файлом от окна по той же границе, что `ReassignPreview` отделён от формы: окно
 * спрашивает и показывает, а здесь — правила разговора с дверью. Тело у предпросмотра и у боевой
 * ручки **одно** (§8), и собирается оно ровно в одном месте: вторая сборка разошлась бы с первой
 * на первом же новом поле, а вместе с ней разошёлся бы отпечаток, которым сервер сверяет
 * обещанное человеку.
 */

/** Что подтверждают: назначить человека с даты либо снять уже заведённое решение (Р13). */
export type MachinistCommandDraft =
  | { kind: 'set'; effectiveDate: string; driverPersonId: string }
  | { kind: 'cancel'; target: AssignmentChangeTarget; segment: AssignmentSegment };

/** Машина назначения — правая половина сравнения «хвост истории против назначения» (Р31). */
export function assignmentVehicle(
  request: SpecialEquipmentRequestDto | null,
): { vehicleId: string; name: string } | null {
  const a = request?.assignment;
  if (!a?.vehicleId) return null;
  return {
    vehicleId: a.vehicleId,
    name: [a.modelName, a.registrationNumber].filter(Boolean).join(' · ') || a.vehicleId,
  };
}

/**
 * Чем адресуется отменяемое решение (Р10). Идентификатор — если история материализована; иначе
 * логический ключ «шкала + дата»: у расчётных строк идентификаторов не существует, и без второго
 * адреса отменить восстановленное решение было бы нечем.
 */
export function cancelTargetOf(segment: AssignmentSegment): AssignmentChangeTarget | null {
  const row = segment.starts.find((r) => r.id) ?? segment.starts[0];
  if (!row) return null;
  return row.id
    ? { changeId: row.id }
    : { dimension: row.dimension, effectiveDate: row.effectiveDate };
}

/** Что уезжает подтверждениями поверх самой команды. */
export interface MachinistCommandExtras {
  version: number;
  anchors: MachinistAnchor[];
  /** Отпечаток показанных последствий; у предпросмотра его не бывает — он его и вычисляет. */
  previewFingerprint?: string;
  /**
   * Отпечаток отработанных листов под разблокировку. Присутствие поля задаёт **ответ сервера**, а
   * не желание клиента: лишний отпечаток отвергается так же строго, как недостающий, — он означает,
   * что тело посчитано по другому состоянию.
   */
  unlockFingerprint?: string | null;
  /** Причина и ключ идемпотентности — там, где их спросил `operationRequirement` (Р32). */
  operation?: { operationId: string; reason: string } | null;
}

/** Тело команды — одно на предпросмотр и на боевую ручку (§8). */
export function machinistCommandBody(
  draft: MachinistCommandDraft,
  extras: MachinistCommandExtras,
): AssignmentCommandBody {
  const common = {
    version: extras.version,
    // Пустой список якорей отвергается схемой: он ничего не сообщает, а от «поля нет» отличается
    // только формой.
    ...(extras.anchors.length > 0 ? { anchors: extras.anchors } : {}),
    ...(extras.previewFingerprint ? { previewFingerprint: extras.previewFingerprint } : {}),
    ...(extras.unlockFingerprint ? { unlockFingerprint: extras.unlockFingerprint } : {}),
    ...(extras.operation ? { operation: extras.operation } : {}),
  };
  return draft.kind === 'set'
    ? {
        ...common,
        kind: 'set',
        // Эта дверь меняет только машиниста (Р13): машину меняют своими дверями, и вторая дорога к
        // тому же решению означала бы два расходящихся набора правил про ставки, аренду и рейс.
        dimension: 'driver',
        effectiveDate: draft.effectiveDate,
        driverPersonId: draft.driverPersonId,
      }
    : { ...common, kind: 'cancel', target: draft.target };
}

/** Сервер назвал пробелы отказом, а не предпросмотром: спрашиваем имена заново. */
export function hasRequiredAnchors(details: unknown): boolean {
  if (typeof details !== 'object' || details === null) return false;
  const value = (details as { requiredAnchors?: unknown }).requiredAnchors;
  return Array.isArray(value) && value.length > 0;
}

/** Что случилось с бланками — номерами: по ним смену и ищут потом на бумаге. */
export function esm2Report(res: AssignmentCommandResultDto): string | null {
  const parts = [
    res.esm2.cancelled.length > 0 ? `аннулированы ${res.esm2.cancelled.join(', ')}` : null,
    res.esm2.issued.length > 0 ? `выписаны ${res.esm2.issued.join(', ')}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? `Машинист изменён; листы ЭСМ-2: ${parts.join('; ')}` : null;
}

import { and, desc, eq, inArray } from 'drizzle-orm';
import type {
  RequestChangeDto,
  RequestChangeFileDto,
  RequestHistoryEntryDto,
  RequestHistoryKind,
  RequestStatus,
} from '@technic/contracts';
import { db } from '../db/client';
import { auditLog, files, users } from '../db/schema';
import { fileNameView } from './file-view';
import { fileListText } from './request-diff';

// История заявки: кто и когда её завёл, правил и переводил по статусам (ADR 0012). Источников
// два и оба уже пишутся — история статусов своей таблицей у каждого модуля и общий аудит
// (audit_log); третья таблица была бы ещё одной точкой правды о тех же событиях. Что именно
// изменила правка, считает дифф модуля и кладёт в metadata аудита снимком.
//
// Здесь общая часть обоих модулей: выборка событий аудита (таблица одна на всех) и сборка
// хронологии. Своя у модуля только выборка истории статусов — таблицы у них разные.

/** Хвост длинной истории (правки → откаты → повторные закрытия) человеку уже не нужен. */
export const HISTORY_LIMIT = 200;

/** Строка истории статусов. Таблицы у модулей разные, набор колонок — один. */
export interface StatusEventRow {
  id: string;
  fromStatus: RequestStatus | null;
  toStatus: RequestStatus;
  comment: string;
  at: Date;
  /**
   * Кто перевёл. `null` — перевод выкатом (ADR 0135): статус меняла миграция, а не учётка.
   * Подпись такому переходу ставит сам модуль (`coalesce(..., 'Портал')`), поэтому имя здесь
   * остаётся строкой: событие без автора в ленте есть, а безымянного события не бывает.
   */
  actorId: string | null;
  actorName: string;
}

export interface AuditEventRow {
  id: string;
  action: string;
  metadata: unknown;
  at: Date;
  actorId: string | null;
  actorName: string | null;
}

/**
 * Пары «идентификатор → имя» из записи журнала. Проверяются строго: в `metadata` лежит JSON, и
 * положить его мог не только дифф — миграция, сид или прямой INSERT. Пара без строковых `id` и
 * `filename` отбрасывается, а не читается как есть: имя, о котором нельзя спросить правило
 * карантина, наружу не отдают. Записанный кем-то признак карантина тоже отбрасывается — он не
 * факт журнала, а сегодняшнее состояние файла, и спрашивают его у `files`.
 *
 * Массива нет вовсе — запись СТАРОГО ОБРАЗЦА: пар в ней не было и не появится (журнал заявки не
 * переписывают), и читается она как раньше, одним `to`.
 *
 * Выведена наружу вместе с самим правилом: свой разбор пар у заявок оргтехники
 * (`service-request-history.ts` собирает ленту сам) означал бы вторую проверку того же JSON — и
 * разойдясь, она пустила бы в ленту имя, о котором правило не спросили.
 */
export function fileEntriesOf(raw: unknown): RequestChangeFileDto[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .filter(
      (f): f is RequestChangeFileDto =>
        !!f &&
        typeof f === 'object' &&
        typeof (f as RequestChangeFileDto).id === 'string' &&
        typeof (f as RequestChangeFileDto).filename === 'string',
    )
    .map((f) => ({ id: f.id, filename: f.filename }));
}

/** Изменения из metadata аудита. Записи, сделанные до появления истории, деталей не несут. */
function changesOf(metadata: unknown): RequestChangeDto[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const raw = (metadata as { changes?: unknown }).changes;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (c): c is RequestChangeDto =>
        !!c && typeof c === 'object' && typeof (c as RequestChangeDto).field === 'string',
    )
    .map((c) => {
      const files = fileEntriesOf(c.files);
      // Без пар событие отдаётся как лежит; с парами — уже очищенными, чтобы дальше по пути не
      // оказалось ни одного имени, о котором не спросили правило.
      return files ? { ...c, files } : { field: c.field, from: c.from, to: c.to };
    });
}

/**
 * События аудита одной заявки. Смены статусов сюда не входят: они берутся из своей таблицы —
 * там есть переход и причина, а запись статуса в аудите их бы только продублировала.
 */
export async function loadAuditEvents(
  entityType: string,
  entityId: string,
  actions: readonly string[],
): Promise<AuditEventRow[]> {
  return (
    db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        metadata: auditLog.metadata,
        at: auditLog.createdAt,
        actorId: auditLog.actorUserId,
        actorName: users.fullName,
      })
      .from(auditLog)
      // Автора аудита может уже не быть: actor_user_id обнуляется при удалении пользователя.
      .leftJoin(users, eq(auditLog.actorUserId, users.id))
      .where(
        and(
          eq(auditLog.entityType, entityType),
          eq(auditLog.entityId, entityId),
          inArray(auditLog.action, [...actions]),
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(HISTORY_LIMIT)
  );
}

/**
 * Имена файлов в событиях истории проходят ТО ЖЕ правило, которым живут сборщики вложений
 * (`file-view.ts`): у запертого файла имя наружу не уходит. Своего условия здесь нет ни одного —
 * правило спрашивается, а не переписывается: вторая копия «если карантин» разошлась бы с первой на
 * первой же правке, и история осталась бы единственным местом, где имя ещё видно.
 *
 * ПОЧЕМУ ПРИ ЧТЕНИИ, а не при записи. Имена попали в журнал в момент подшивки — до карантина:
 * ошибочно загруженный документ замечают позже, и переписать журнал задним числом нельзя, это
 * история заявки. Состояние файла поэтому спрашивается у `files` каждый раз, когда историю читают,
 * а снятие карантина тем же движением возвращает имя на место.
 *
 * ЗАПИСЬ СТАРОГО ОБРАЗЦА — без пар «идентификатор → имя» — читается как раньше, одним `to`: о каких
 * файлах в ней речь, не знает никто, и угадывать это по имени значило бы гасить чужие строки либо
 * пропускать свои. Журнал не переписывают, так что такие записи остаются навсегда.
 *
 * Строки файла может уже не быть вовсе (неподшитый файл уносит уборка): «не нашли» — это «не в
 * карантине», потому что карантинный файл не удаляется ни автором, ни уборкой, ни `files.manageAny`.
 *
 * ВЫВЕДЕНА НАРУЖУ ради единственного читателя истории, который собирает ленту сам, — заявок
 * оргтехники (`service-request-history.ts`): своя копия правила там разошлась бы с этой на первой
 * же правке, а имя в ленте осталось бы видно ровно у того модуля, ради которого карантин и заведён.
 */
export async function applyFileNameRule(
  /*
   * ВХОД СТРУКТУРНЫЙ, А НЕ ПО ТИПУ ЗАПИСИ: правилу нужны только изменения со списком файлов, а лента
   * оргтехники несёт СВОИ статусы (`ServiceRequestHistoryEntryDto`) и в общий тип записи не
   * складывается. Требуй функция полную запись — второй читатель либо завёл бы копию правила, либо
   * приводил бы типы силой, и в обоих случаях имя запертого файла осталось бы видно ровно там, ради
   * чего карантин и заведён.
   */
  entries: readonly { changes: RequestChangeDto[] }[],
): Promise<void> {
  const ids = new Set<string>();
  for (const entry of entries)
    for (const change of entry.changes) for (const file of change.files ?? []) ids.add(file.id);
  if (ids.size === 0) return;
  const rows = await db
    .select({ id: files.id, quarantinedAt: files.quarantinedAt })
    .from(files)
    .where(inArray(files.id, [...ids]));
  const quarantinedAt = new Map(rows.map((r) => [r.id, r.quarantinedAt]));
  for (const entry of entries)
    for (const change of entry.changes) {
      if (!change.files) continue;
      change.files = change.files.map((file) => ({
        id: file.id,
        ...fileNameView({
          filename: file.filename,
          quarantinedAt: quarantinedAt.get(file.id) ?? null,
        }),
      }));
      // Строка события собирается заново из прошедших правило имён — той же функцией, что у
      // писателя: `to` из журнала несёт имя, записанное до карантина.
      change.to = fileListText(change.files);
    }
}

/**
 * Хронология событий заявки. `created` — запасной вариант для создания: обычно оно есть в
 * истории статусов (переход «— → Новая»), но у записей, заведённых в БД помимо приложения,
 * его может не быть.
 */
export async function mergeHistory(params: {
  requestId: string;
  statusRows: StatusEventRow[];
  auditRows: AuditEventRow[];
  /** Какое событие истории означает действие аудита; неизвестное считается правкой. */
  auditKinds: Record<string, RequestHistoryKind>;
  created: { at: Date; actorId: string; actorName: string };
}): Promise<RequestHistoryEntryDto[]> {
  const { requestId, statusRows, auditRows, auditKinds, created } = params;
  const entries: RequestHistoryEntryDto[] = [
    ...statusRows.map((row) => ({
      id: row.id,
      // Переход «ниоткуда» — это и есть заведение заявки.
      kind: (row.fromStatus === null ? 'created' : 'status') as RequestHistoryKind,
      at: row.at.toISOString(),
      actorId: row.actorId,
      actorName: row.actorName,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      comment: row.comment,
      changes: [],
    })),
    ...auditRows.map((row) => ({
      id: row.id,
      kind: auditKinds[row.action] ?? 'updated',
      at: row.at.toISOString(),
      actorId: row.actorId,
      actorName: row.actorName,
      fromStatus: null,
      toStatus: null,
      comment: '',
      changes: changesOf(row.metadata),
    })),
  ];

  // Обрезанную историю дополнять созданием нельзя: его запись просто не попала в выборку.
  if (statusRows.length < HISTORY_LIMIT && !entries.some((e) => e.kind === 'created')) {
    entries.push({
      id: `created:${requestId}`,
      kind: 'created',
      at: created.at.toISOString(),
      actorId: created.actorId,
      actorName: created.actorName,
      fromStatus: null,
      toStatus: null,
      comment: '',
      changes: [],
    });
  }

  // Свежие события отбираются первыми, а показываются в порядке, в котором происходили.
  const shown = entries
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, HISTORY_LIMIT)
    .reverse();
  // Правило имени — после обрезки: спрашивать состояние файлов у отброшенного хвоста незачем.
  await applyFileNameRule(shown);
  return shown;
}

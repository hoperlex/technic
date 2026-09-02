/**
 * Пометка «числа значка разбора талонов устарели» (план `docs/waste-ticket-auto-confirm-plan.md`,
 * Р19 и Р20).
 *
 * Числа значка живут в `waste_ticket_review_state` и считаются одним местом — `wasteTicketChecks`
 * в API. Воркер до него не дотягивается: у него свой `pg`-клиент и ни строчки кода приложения.
 * Второй реализацией правила эта задача не решается — расходились бы две копии молча, а «сколько
 * талонов ждёт человека» портал бы называл по-разному в реестре и в карточке. Поэтому воркер
 * делает единственное, что делает без правила: ставит `stale`, а числа пересчитает ближайшее
 * чтение (Р21 — заявка со `stale` из реестра не пропадает, а показывается).
 *
 * **Почему upsert, а не `UPDATE`.** Строки состояния у заявки может ещё не быть: её заводит первый
 * пересчёт, а первым к заявке приходит как раз воркер — со своей файловой строкой в `pending`.
 * `UPDATE` по несуществующей строке молча не сделал бы ничего, и пометка потерялась бы целиком.
 *
 * **Почему растёт `revision`.** Пересчёт в API читает ревизию до расчёта и пишет числа условно —
 * только если она не изменилась (Р19). Пометка воркера, пришедшая в это окно, обязана быть
 * заметной: без `revision + 1` пересчёт, начатый до неё, записал бы `stale = false` с числами,
 * посчитанными до наших талонов.
 */

/** `pg`-клиент в том виде, в каком его даёт и пул, и транзакция задачи. */
export interface ReviewStateClient {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/**
 * Ключи талонов, по которым ищутся соседи. Три семейства, потому что и причин предупреждения три:
 * повтор скана (`page_sha256`), повтор номера (`number_key`) и похожий номер (`number_fuzzy`).
 */
export interface TicketReviewKeys {
  numberKeys: readonly string[];
  numberFuzzy: readonly string[];
  pageSha256: readonly string[];
}

/**
 * Текст обоих запросов вынесен в константы намеренно: тот же SQL живёт в API, и это осознанный
 * дубль (Р20) — воркеру недоступны ни схема drizzle, ни правило сверки. Держать копии сверяемыми
 * можно только сравнив тексты, а сравнить их можно только тогда, когда они не размазаны по коду.
 */
export const TICKET_REVIEW_STALE_SQL = `
INSERT INTO waste_ticket_review_state (request_id, stale, revision)
     VALUES ($1, true, 1)
ON CONFLICT (request_id) DO UPDATE
        SET stale = true, revision = waste_ticket_review_state.revision + 1`;

/**
 * Соседи заявки: чужие живые заявки, чей **неотклонённый** талон совпал по номеру, похожему номеру
 * или скану страницы. Замечание о дубле живёт в заявке Б, а вызывает его талон заявки А (Р12): не
 * пометив соседа, портал оставил бы в его значке предупреждение о бумаге, которой уже нет, — или,
 * что хуже, промолчал бы о появившейся.
 *
 * Отклонённые талоны из отбора исключены: дублем считается только то, что кто-то ещё считает
 * бумагой. Частичный уникальный индекс по `number_key` этот отбор не покрывает — он про
 * `confirmed`, — поэтому у выпуска и есть свой обычный индекс (Р20).
 */
export const TICKET_REVIEW_NEIGHBORS_SQL = `
SELECT DISTINCT wt.request_id
  FROM waste_tickets wt
  JOIN waste_requests wr ON wr.id = wt.request_id AND wr.deleted_at IS NULL
  LEFT JOIN waste_ticket_pages wp ON wp.id = wt.page_id
 WHERE wt.request_id <> $1 AND wt.status <> 'dismissed'
   AND (wt.number_key = ANY($2::text[]) OR wt.number_fuzzy = ANY($3::text[]) OR wp.page_sha256 = ANY($4::bpchar[]))`;
// `bpchar[]`, а не `text[]`: колонка объявлена `character(64)`, и приведение массива к `text`
// заставляет Postgres приводить к нему саму колонку — индекс `waste_ticket_pages_sha256_idx`
// (bpchar_ops) после этого становится непригоден, что видно по `Filter` вместо `Index Cond` даже с
// выключенным seqscan. Запрос идёт в каждом T2, а таблица растёт с каждым распознанным файлом.

/**
 * Пустой ключ в массив не кладётся: `number_key = ''` стоит у каждого талона без прочитанного
 * номера, и один такой ключ вытащил бы в соседи все нечитаемые талоны портала разом.
 */
function keySet(values: readonly string[]): string[] {
  return [...new Set(values.filter((v) => v !== ''))];
}

/**
 * Пометка списка заявок. Строки берутся **по возрастанию `request_id` и по одной**, а не одним
 * `UPDATE … WHERE id = ANY(…)`: у такого запроса порядок блокировок выбирает планировщик, и две
 * встречные транзакции (А метит себя и Б, Б метит себя и А) встают в дедлок уже не на номерах, а
 * на самих строках состояния. Приём тот же, что в `grant-catalog.ts` и `vehicle-trailer-hitch.ts`.
 *
 * Своя заявка идёт в общем ряду, отдельной пометкой «сначала себя» — нет: она ровно так же строка
 * состояния, и вынести её из порядка значило бы вернуть тот же дедлок.
 */
export async function markReviewStale(
  client: ReviewStateClient,
  requestIds: readonly string[],
): Promise<string[]> {
  // Идентификаторы приходят из базы и из payload задачи — в каноническом нижнем регистре, поэтому
  // обычная сортировка строк совпадает с порядком, в котором сравнивает `uuid` сам PostgreSQL.
  const ordered = [...new Set(requestIds.filter((id) => id !== ''))].sort();
  for (const id of ordered) {
    await client.query(TICKET_REVIEW_STALE_SQL, [id]);
  }
  return ordered;
}

/**
 * Пометка своей заявки и соседей по ключам её талонов — то, что делает запись результата
 * распознавания (T2). Соседи ищутся в той же транзакции, что и пометка: список, прочитанный до
 * замка, к моменту записи уже неверен.
 */
export async function markReviewStaleWithNeighbors(
  client: ReviewStateClient,
  requestId: string,
  keys: TicketReviewKeys,
): Promise<string[]> {
  const numberKeys = keySet(keys.numberKeys);
  const numberFuzzy = keySet(keys.numberFuzzy);
  const pageSha256 = keySet(keys.pageSha256);
  // Ни одного ключа — соседей быть не может по построению, и запрос за ними был бы обходом всех
  // талонов ради заведомо пустого ответа.
  const neighbors =
    numberKeys.length + numberFuzzy.length + pageSha256.length === 0
      ? []
      : (
          await client.query<{ request_id: string }>(TICKET_REVIEW_NEIGHBORS_SQL, [
            requestId,
            numberKeys,
            numberFuzzy,
            pageSha256,
          ])
        ).rows.map((row) => row.request_id);
  return markReviewStale(client, [requestId, ...neighbors]);
}

/**
 * Версия контракта клиента: заголовки, которые портал ставит КАЖДОМУ запросу к своему API, и
 * состояние «сервер потребовал обновиться».
 *
 * **Зачем отдельный модуль.** Через `http.ts` идут не все запросы: обновление сессии зовёт `fetch`
 * напрямую (`session.ts`), потому что решение «сессия кончилась» принимает она сама, а не
 * транспорт. Заголовок, поставленный в одной обёртке, до второго вызова не доехал бы — и сервер
 * отбил бы обновление сессии, а старый код прочитал бы отказ как конец сессии и выкинул человека
 * из портала. Поэтому заголовки живут здесь, а обе двери берут их отсюда.
 *
 * **Что НЕ обслуживается этим модулем.** Запросы в S3 (загрузка вложения по presigned-ссылке),
 * в DaData (подсказки адресов) и за `/version.json` — это не наш API: заголовков они не несут и
 * гейту не подлежат.
 *
 * План: `docs/office-equipment-consumables-and-purchase-plan.md`, Р8; ADR 0146, решение 7.
 */

/**
 * Contract version of this portal build — a monotonic integer, not a build id.
 *
 * `__BUILD_ID__` cannot serve the gate: it is a short commit SHA, and SHAs have no "lower/higher"
 * at all — `a731bc2` and `f0184de` are incomparable. Hence a separate number, raised BY HAND AND
 * RARELY: exactly when what the server answers or accepts stops working with the code of earlier
 * builds. Whoever raises it must also raise the server floor (`MIN_CLIENT_CONTRACT`) — as a
 * separate action, after the new static is served.
 *
 * The number is deliberately NOT shared with the server: the portal bakes its own into the bundle,
 * the server reads its own from the environment. A shared module would bind both sides into one
 * rollout, and the whole point of the two phases is that they come apart. `deploy-auto` reads this
 * line from the served revision with a fixed pattern (`client_contract_deployed`), so its format is
 * pinned by `apps/api/test/client-floor-preflight.test.ts`.
 *
 * **1 → 2 (request without equipment).** The first raise, for exactly the reason the mechanism was
 * built: `equipment` and `object` in the request answer became optional, and contract-1 builds read
 * them unchecked — the first request without equipment broke their list and card.
 *
 * **2 → 3 (auto part receipts, phase 1).** The raise goes AHEAD of the breakage, not after it, and
 * that is its whole design (`docs/auto-part-receipts-plan.md`, R22). This build no longer shows the
 * warehouse while the server still keeps it whole: `parts` in the act DTO, the input schemas,
 * `/auto-parts`. The next release removes them, and that is when contract-2 builds would break
 * hard: `record.parts.length` in the maintenance log gives a white screen, the warehouse tab a 404
 * on every list. So the number rises here and the floor rises SEPARATELY —
 * `deploy-auto --client-floor=3`, after the new static is verifiably served (phase order in
 * `docs/runbook.md`). Between the two actions old tabs work as before: the server did not change.
 *
 * **3 → 4 (maintenance mode).** A different kind of reason: the answer did not stop parsing, it
 * stopped being READ CORRECTLY. During a window the gate answers `503 maintenance_mode`, and
 * contract-3 builds know neither the code nor `/maintenance.json`: they show a plain "service
 * unavailable" toast and leave the person guessing whether the portal broke or was closed on
 * purpose — exactly what the mode was built against (`docs/maintenance-mode-plan.md`, §3). So the
 * floor is raised BEFORE the first window: a tab below it gets 426 and the demand to reload, and
 * comes back with a build that shows the announcement. The barrier is in code:
 * `deploy-auto --maintenance=on` refuses while the floor is below the served bundle's contract.
 *
 * **4 → 5 (removing a person's card asks for confirmation).** Like 1 → 2: the server stopped
 * accepting what the old tab sends. `DELETE /drivers/:id` now answers
 * `409 driver_removal_ack_required` with the affected orders, terms and number of future forms, and
 * only a repeat with a body — the confirmation and the fingerprint of **that very** list — removes
 * (ADR 0190, decision 5). Contract-4 builds send `DELETE` without a body: HR would see a refusal on
 * every attempt and no dialog to get past it. The floor rises separately — `--client-floor=5`.
 *
 * **5 → 6 (article in an auto part receipt line).** The opposite of all the previous: the old build
 * reads the answer fine — it **writes** incompletely. Editing a receipt sends the lines WHOLE and
 * the server recreates them (`replaceLines`); a line carries no id in the body, so a tab that does
 * not know `article` would wipe the articles of every line on its first edit, and "field missing
 * means keep" cannot be expressed — there is nothing to match the sent line with. A silent loss of
 * input is what the receipts release declared unacceptable, so the floor rises separately —
 * `--client-floor=6` — and the old tab reloads instead of damaging documents
 * (`docs/auto-part-receipt-ocr-plan.md`, R2a).
 *
 * **6 → 7 (one raise for every floor-gated debt, ADR 0226).** The raise itself changes nothing in
 * what the bundle reads or writes — that is the reason, not an omission. Several releases kept
 * deprecated answer fields and old doors only for tabs built before their own portal half: the
 * waste statistics fields of ADR 0209 (R5) and ADR 0213 (`volumeM3`, `totalCost`, `confirmed*`, …)
 * and the other debts of release R2. Tabs from before and after those halves all carry 6, so no
 * floor can tell them apart; 7 is the first number that means "built after all of them". The
 * operator raises the floor with `deploy-auto --client-floor=7` once this build is verifiably
 * served, and only then may a release set `REQUIRED_CLIENT_FLOOR = 7` and remove the debts
 * (`docs/runbook.md`). The promise binds whoever removes a debt: the removal is safe at floor 7
 * only if a contract-7 bundle no longer depends on what is removed.
 */
export const CLIENT_CONTRACT = 7;

/** Диагностика: какая сборка прислала запрос. Гейт этот заголовок не толкует. */
export const CLIENT_BUILD_HEADER = 'X-Client-Build';

/** Гейт: версия контракта клиента. Сервер сравнивает её со своим полом. */
export const CLIENT_CONTRACT_HEADER = 'X-Client-Contract';

/**
 * Gate refusal code. The same literal is carried by the 409 of the vehicle-change preview
 * (`features/vehicle-assignment/model/preview.ts`), so the PAIR "status + code" is matched, never
 * the code alone: the two refusals lead to different conversations.
 */
export const CLIENT_UPGRADE_REQUIRED = 'client_upgrade_required';

/** 426 Upgrade Required — статус, которым сервер отбивает сборку ниже пола. */
export const CLIENT_UPGRADE_STATUS = 426;

/**
 * Заголовки клиента для запроса к своему API.
 *
 * `typeof __BUILD_ID__` — не перестраховка: константу подставляет сборка (`vite.config.ts`,
 * `define`), а в прогоне тестов её нет вовсе, и голое обращение упало бы на ReferenceError.
 */
export function clientRequestHeaders(): Record<string, string> {
  const build = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';
  return {
    [CLIENT_BUILD_HEADER]: build,
    [CLIENT_CONTRACT_HEADER]: String(CLIENT_CONTRACT),
  };
}

/** Тот ли это отказ гейта: 426 **и** его код. */
export function isClientUpgradeResponse(status: number, code: string | undefined): boolean {
  return status === CLIENT_UPGRADE_STATUS && code === CLIENT_UPGRADE_REQUIRED;
}

let upgradeRequired = false;
let handlers: (() => void)[] = [];

/**
 * Сервер отказал этой вкладке по версии. Состояние одностороннее и необратимое: «обратно
 * совместимым» ответ уже не станет, а перезагрузить страницу за человека портал не может — только
 * потребовать.
 */
export function requireClientUpgrade(): void {
  if (upgradeRequired) return;
  upgradeRequired = true;
  for (const handler of handlers) handler();
}

/** Требует ли сервер обновления прямо сейчас. */
export function isClientUpgradeRequired(): boolean {
  return upgradeRequired;
}

/**
 * Подписка на требование обновиться; возвращает функцию отписки. Подпиской, а не полем результата
 * запроса, — по тому же устройству, что у `onExpired` в `session.ts`: отказ приходит посреди
 * работы, любому запросу, и знать о нём должен экран, а не тот, кто этот запрос отправлял.
 */
export function onClientUpgradeRequired(handler: () => void): () => void {
  handlers = [...handlers, handler];
  return () => {
    handlers = handlers.filter((h) => h !== handler);
  };
}

/** Тестам: вернуть модуль в состояние «сервер ничего не требовал». */
export function __resetClientContractForTests(): void {
  upgradeRequired = false;
  handlers = [];
}

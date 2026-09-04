import { and, eq, inArray } from 'drizzle-orm';
import { can, serviceRequestAudienceOf, type ServiceRequestAudience } from '@technic/contracts';
import { db } from '../db/client';
import { serviceRequestExecutors } from '../db/schema';
import type { Principal } from '../auth/principal';

/**
 * Аудитория ПАЧКИ заявок — «кому из этих строк положены деньги» (ADR 0160, Р13).
 *
 * Спрашивают это трое, и все — списками: история обслуживания в карточке единицы техники, лента
 * событий аппарата и её выгрузка. Карточка заявки считает аудиторию своим путём
 * (`executorAssignment` в маршруте): там строка одна, и лишний запрос за исполнителями ей не нужен.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ ЗАПРОС, А НЕ КОРРЕЛИРОВАННЫЙ ПОДЗАПРОС В СПИСКЕ СТОЛБЦОВ. Драйвер переписывает
 * колонки односоставного запроса в голые идентификаторы, и корреляция, вписанная прямо в выражение
 * столбца, разрешается уже в таблицу подзапроса — молча, без отказа
 * (`office-equipment-sql-correlation.test.ts`). Здесь цена ошибки максимальная: «назначен» ответило
 * бы правдой для всех, и суммы уехали бы всей области. Один плоский `IN`-запрос по найденным
 * идентификаторам не ломается ни при каком переписывании и стоит одного похода в базу.
 *
 * ПРАВО СПРАШИВАЕТСЯ ДО ЗАПРОСА, как и в `executorAssignment`: у субъекта без
 * `serviceRequests.execute` поимённое назначение аудитории не открывает (оно работает в паре с
 * правом), и ходить за строками исполнителей незачем.
 */
export async function serviceAudienceByRequest(
  p: Principal,
  rows: readonly { id: string; serviceCounterpartyId: string | null }[],
): Promise<Map<string, ServiceRequestAudience>> {
  const audiences = new Map<string, ServiceRequestAudience>();
  if (rows.length === 0) return audiences;

  let named = new Set<string>();
  if (can(p, 'serviceRequests.execute')) {
    const assigned = await db
      .select({ requestId: serviceRequestExecutors.requestId })
      .from(serviceRequestExecutors)
      .where(
        and(
          inArray(
            serviceRequestExecutors.requestId,
            rows.map((row) => row.id),
          ),
          eq(serviceRequestExecutors.userId, p.id),
        ),
      );
    named = new Set(assigned.map((row) => row.requestId));
  }

  for (const row of rows) {
    audiences.set(
      row.id,
      // Правило целиком остаётся контрактным: здесь собираются только факты пары «человек ↔ эта
      // заявка», а решение принимает `serviceRequestAudienceOf` — тот же, что у карточки заявки и
      // у прямой ссылки на файл. Своё «если назначен, то деньги» здесь означало бы третью копию
      // правила, расходящуюся с двумя первыми молча.
      serviceRequestAudienceOf(p, {
        actsForAssignedCounterparty:
          row.serviceCounterpartyId !== null && row.serviceCounterpartyId === p.counterpartyId,
        isNamedExecutor: named.has(row.id),
      }),
    );
  }
  return audiences;
}

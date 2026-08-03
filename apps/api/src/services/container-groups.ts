import { and, eq, isNull } from 'drizzle-orm';
import {
  checkContainerOwner,
  FOREIGN_CONTAINER_SPLIT_MESSAGE,
  type PresentContainerGroupDto,
  type RequestType,
  usesContainerGroup,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  containerTypes,
  counterparties,
  presentContainerGroups,
  wasteRequests,
} from '../db/schema';
import { err } from '../lib/errors';

// Контейнеры, стоящие на площадке: что, чьё и сколько (миграция 0080). Присутствие считается
// тройкой «объект + тип + владелец», где владелец единицы — оператор её заявки установки.
//
// Здесь всё, что об этой тройке спрашивают: список групп для формы и подсказок, проверка
// «столько там есть» и правило «вывозит тот, кто привёз». Правила живут одним сервисом, а не
// внутри маршрута, потому что спрашивают их из четырёх мест — заведение заявки, её правка,
// назначение оператора и выбор в форме, — и разойтись ответам нельзя.

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Владелец сравнивается с NULL наравне со всеми: «оператор не указан» — такая же группа. */
function sameOwner(column: typeof presentContainerGroups.ownerCounterpartyId, id: string | null) {
  return id === null ? isNull(column) : eq(column, id);
}

/**
 * Группы присутствия на объекте — то, из чего выбирают контейнер в заявке на замену и снятие,
 * и то, что показывается подсказкой при назначении оператора.
 */
export async function loadPresentGroups(objectId: string): Promise<PresentContainerGroupDto[]> {
  const rows = await db
    .select({
      objectId: presentContainerGroups.objectId,
      containerTypeId: presentContainerGroups.containerTypeId,
      containerTypeName: containerTypes.name,
      ownerCounterpartyId: presentContainerGroups.ownerCounterpartyId,
      ownerName: counterparties.name,
      quantity: presentContainerGroups.quantity,
    })
    .from(presentContainerGroups)
    .innerJoin(containerTypes, eq(presentContainerGroups.containerTypeId, containerTypes.id))
    // Владельца может не быть: установку завели без оператора либо заявка старше миграции 0080.
    .leftJoin(counterparties, eq(presentContainerGroups.ownerCounterpartyId, counterparties.id))
    .where(eq(presentContainerGroups.objectId, objectId))
    .orderBy(containerTypes.sortOrder, containerTypes.name, counterparties.name);
  return rows.map((r) => ({
    objectId: r.objectId!,
    containerTypeId: r.containerTypeId!,
    containerTypeName: r.containerTypeName,
    ownerCounterpartyId: r.ownerCounterpartyId,
    ownerName: r.ownerName,
    quantity: r.quantity ?? 0,
  }));
}

/** Сколько единиц группы стоит на объекте прямо сейчас; группы нет — ноль. */
async function groupQuantity(
  tx: Tx,
  objectId: string,
  containerTypeId: string,
  ownerId: string | null,
): Promise<number> {
  const [row] = await tx
    .select({ quantity: presentContainerGroups.quantity })
    .from(presentContainerGroups)
    .where(
      and(
        eq(presentContainerGroups.objectId, objectId),
        eq(presentContainerGroups.containerTypeId, containerTypeId),
        sameOwner(presentContainerGroups.ownerCounterpartyId, ownerId),
      ),
    );
  return row?.quantity ?? 0;
}

/**
 * Сколько единиц группы вычитает из присутствия сама правимая заявка. Снятие вычитает их сразу,
 * как только заведено (присутствие — план, а не факт), поэтому правка «снимали 2, снимаем 2»
 * иначе упиралась бы в собственную заявку. Считается по сохранённому состоянию: сменили тройку —
 * прежний вклад к новой группе отношения не имеет.
 *
 * Замена присутствие не меняет, и вклада у неё нет.
 */
async function ownContribution(
  tx: Tx,
  requestId: string,
  objectId: string,
  containerTypeId: string,
  ownerId: string | null,
): Promise<number> {
  const [row] = await tx
    .select({
      requestType: wasteRequests.requestType,
      objectId: wasteRequests.objectId,
      containerTypeId: wasteRequests.containerTypeId,
      ownerId: wasteRequests.containerOwnerCounterpartyId,
      containersCount: wasteRequests.containersCount,
      status: wasteRequests.status,
      deletedAt: wasteRequests.deletedAt,
    })
    .from(wasteRequests)
    .where(eq(wasteRequests.id, requestId));
  if (!row || row.deletedAt || row.status === 'cancelled') return 0;
  if (row.requestType !== 'container_removal') return 0;
  const sameGroup =
    row.objectId === objectId && row.containerTypeId === containerTypeId && row.ownerId === ownerId;
  return sameGroup ? row.containersCount : 0;
}

/**
 * Проверяет, что на объекте есть столько контейнеров этой группы, сколько просит заявка.
 * Заменяет прежнюю проверку «контейнер такого типа на объекте есть»: с владельцем и количеством
 * вопрос стал точнее, а ответ на него — числом.
 */
export async function assertContainerGroupAvailable(
  tx: Tx,
  input: {
    requestType: RequestType;
    objectId: string;
    containerTypeId: string;
    ownerId: string | null;
    count: number;
    /** Правимая заявка: её собственный вклад в присутствие не должен мешать ей самой. */
    requestId?: string;
  },
): Promise<void> {
  const what = input.requestType === 'container_replace' ? 'замены' : 'снятия';
  const quantity = await groupQuantity(tx, input.objectId, input.containerTypeId, input.ownerId);
  const own = input.requestId
    ? await ownContribution(
        tx,
        input.requestId,
        input.objectId,
        input.containerTypeId,
        input.ownerId,
      )
    : 0;
  const available = quantity + own;
  if (available === 0) {
    throw err.badRequest(
      input.ownerId
        ? `На объекте нет контейнеров этого типа от выбранного оператора — выберите другой для ${what}`
        : `На объекте нет контейнера этого типа для ${what}`,
      { containerTypeId: 'Такого контейнера на объекте нет' },
    );
  }
  if (input.count > available) {
    throw err.badRequest(`На объекте ${available} таких контейнеров — больше указать нельзя`, {
      containersCount: `Не больше ${available}`,
    });
  }
}

/** Имя контрагента для текста отказа: «Контейнер установил «Оператор А»». */
async function counterpartyName(tx: Tx, id: string): Promise<string> {
  const [row] = await tx
    .select({ name: counterparties.name })
    .from(counterparties)
    .where(eq(counterparties.id, id));
  return row?.name ?? 'другой оператор';
}

/**
 * Правило «вывозит тот, кто привёз» (ADR 0054). Молчит там, где данных нет: оператор ещё не
 * назначен либо владелец контейнера не известен — запрет в этих случаях был бы запретом
 * отсутствия данных, а не запретом ошибки.
 *
 * Возвращает причину подтверждённого расхождения — её пишут в историю заявки. Пусто — расхождения
 * не было.
 */
export async function assertContainerOwnerAllowed(
  tx: Tx,
  input: {
    requestType: RequestType;
    operatorCounterpartyId: string | null;
    containerOwnerCounterpartyId: string | null;
    ownerMismatchReason?: string;
  },
): Promise<string> {
  if (!usesContainerGroup(input.requestType)) return '';
  const verdict = checkContainerOwner(input, !!input.ownerMismatchReason);
  if (verdict === 'ok') return '';
  const ownerName = await counterpartyName(tx, input.containerOwnerCounterpartyId!);
  if (verdict === 'splitRequired') {
    throw err.badRequest(`Контейнер установил «${ownerName}». ${FOREIGN_CONTAINER_SPLIT_MESSAGE}`, {
      operatorCounterpartyId: 'Заменить чужой контейнер нельзя',
    });
  }
  if (verdict === 'reasonRequired') {
    throw err.badRequest(
      `Контейнеры этого типа на объекте установил «${ownerName}» — назначьте его либо подтвердите вывоз чужого контейнера с указанием причины`,
      { operatorCounterpartyId: 'Контейнер вывозит не тот, кто его установил' },
    );
  }
  return input.ownerMismatchReason!;
}

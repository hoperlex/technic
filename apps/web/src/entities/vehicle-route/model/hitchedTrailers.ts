import {
  type HitchedTrailerDto,
  type RouteTripFields,
  vehicleStatusLabels,
  type VehicleTrailerVehicleRefDto,
} from '@technic/contracts';

/**
 * Правило чтения закреплённых прицепов — одно на все окна заведения рейса
 * (`docs/vehicle-trailers-plan.md`, §4.2.2).
 *
 * Правило целиком: **`hitched` не пуст — графы прицепа и галочка «с прицепом» берутся из него, а
 * под графами встаёт подпись, что подставлено и откуда; `hitched` пуст — новой подстановки нет
 * вовсе**, и окно ведёт себя ровно как вчера. Второе — решение, а не умолчание: подмешай сюда
 * историю рейсов, и портал начал бы предлагать вчерашний прицеп в окне «Новый маршрут», которое
 * сегодня не подставляет ничего (ADR 0083, решение 2). Граница проведена по источнику, а не по
 * окну: новая подстановка бывает только у машины с закреплённым прицепом.
 *
 * Функции здесь чистые и живут в сущности, а не в окне, ровно потому, что окон пять: подпись,
 * порядок слотов и предупреждение о ремонте, переписанные пять раз, разойдутся на первой же
 * правке — и человек прочтёт про один и тот же прицеп разное в двух соседних формах.
 */

/** Код типа техники «Тягачи с полуприцепами» (миграция 0013): им включается галочка по §4.4 (а). */
export const TRACTOR_TRAILERS_TYPE_CODE = 'tractor_trailers';

/**
 * Почему галочка у тягача встаёт сама и что с ней можно сделать (§4.4).
 *
 * Сказать это обязательно: ADR 0037 п. 8 обещал галочку несменяемой, и снимаемая молча читалась бы
 * как недоделка. Снимается она потому, что у тягача есть законный выезд без полуприцепа — перегон
 * в ремонт и обратно, — а запертая галочка потребовала бы от такого водителя категорию CE.
 * Фраза говорит о самой машине, а не о том, кто поставил галочку: показывается она и тогда, когда
 * её поставил человек, и «галочка встала сама» в этом случае было бы неправдой.
 */
export const TRACTOR_TRAILER_HINT =
  'Машина — седельный тягач: галочка у него встаёт сама. Снять её можно — голый тягач выезжает в ремонт и обратно.';

/** Графы прицепа формы рейса: ровно те пять полей, которыми их спрашивает бланк 4-П. */
export interface TrailerGraphs {
  withTrailer: boolean;
  trailer1Model: string;
  trailer1RegNumber: string;
  trailer2Model: string;
  trailer2RegNumber: string;
}

/** Пустые графы прицепа: ими окно очищает форму, переоткрываясь под соседний день или заказ. */
export function emptyTrailerGraphs(): TrailerGraphs {
  return {
    withTrailer: false,
    trailer1Model: '',
    trailer1RegNumber: '',
    trailer2Model: '',
    trailer2RegNumber: '',
  };
}

/** Закрепления по возрастанию слота: порядок пар граф — свойство бланка, а не ответа сервера. */
function ordered(hitched: readonly HitchedTrailerDto[] | undefined | null): HitchedTrailerDto[] {
  return [...(hitched ?? [])].sort((a, b) => a.position - b.position);
}

/**
 * Графы прицепа из закрепления; `null` — за машиной не закреплено ничего, и подставлять нечего.
 *
 * Слоты бланка заполняются **по порядку**, а не по номеру слота из реестра: за машиной может
 * стоять один прицеп во втором слоте (первый освободили), а второй прицеп при пустом первом бланк
 * печатает дырой посреди шапки — и сервер такой рейс не примет вовсе (§4.6). Реестр отвечает на
 * вопрос «что стоит за машиной», порядок граф — вопрос бумаги.
 */
export function hitchedTrailerGraphs(
  hitched: readonly HitchedTrailerDto[] | undefined | null,
): TrailerGraphs | null {
  const slots = ordered(hitched);
  if (slots.length === 0) return null;
  return {
    withTrailer: true,
    trailer1Model: slots[0]?.model ?? '',
    trailer1RegNumber: slots[0]?.registrationNumber ?? '',
    trailer2Model: slots[1]?.model ?? '',
    trailer2RegNumber: slots[1]?.registrationNumber ?? '',
  };
}

/**
 * Стоит ли сейчас в графах именно закреплённое — этим и решается, показывать ли подпись.
 *
 * Сравнением значений, а не памятью о том, что портал их подставил: человек вправе вписать другой
 * прицеп поверх подставленного (§4.3), и подпись «в графах — закреплённый за машиной» пережила бы
 * его правку враньём. Сравниваются и снятая галочка: рейс без прицепа не описывается закреплением.
 */
export function graphsAreHitched(
  hitched: readonly HitchedTrailerDto[] | undefined | null,
  current: Partial<TrailerGraphs>,
): boolean {
  const expected = hitchedTrailerGraphs(hitched);
  if (!expected) return false;
  const same = (a: string, b: string | undefined) => a === (b ?? '').trim();
  return (
    current.withTrailer === true &&
    same(expected.trailer1Model, current.trailer1Model) &&
    same(expected.trailer1RegNumber, current.trailer1RegNumber) &&
    same(expected.trailer2Model, current.trailer2Model) &&
    same(expected.trailer2RegNumber, current.trailer2RegNumber)
  );
}

/**
 * Подпись под графами: что стоит в них и откуда взялось; `null` — закрепления нет.
 *
 * Подстановка обязана быть видимой (§4.3): подставленное значение читается как уже принятое
 * решение, и единственное, что отличает законную подстановку от решения за человека, — названный
 * источник и возможность править. Поэтому подпись говорит обе вещи сразу.
 *
 * Прицеп не в строю **предупреждает, но не запрещает** (§4.2.3): закрепление `maintenance`-прицепа
 * законно — он физически стоит за тягачом и ждёт ремонта, — но молча поставить в рейс то, что
 * стоит в боксе, портал не вправе.
 */
export function hitchedTrailerNote(
  hitched: readonly HitchedTrailerDto[] | undefined | null,
): string | null {
  const slots = ordered(hitched);
  if (slots.length === 0) return null;
  const list = slots
    .map((t) =>
      [t.model, t.registrationNumber]
        .map((s) => s.trim())
        .filter(Boolean)
        .join(' '),
    )
    .filter(Boolean)
    .join(' · ');
  const head =
    slots.length > 1
      ? `В графах — прицепы, закреплённые за машиной: ${list}.`
      : `В графах — прицеп, закреплённый за машиной: ${list}.`;
  const idle = slots.filter((t) => t.status !== 'active');
  const warning = idle.length
    ? ` ${idle.length > 1 ? 'Прицепы' : 'Прицеп'} ${idle
        .map((t) => `${t.registrationNumber} — «${vehicleStatusLabels[t.status].toLowerCase()}»`)
        .join(', ')}: рейс это не запрещает, но проверьте, на чём выезжают.`
    : '';
  return `${head} Графы правятся: можно вписать другой прицеп или снять галочку.${warning}`;
}

/**
 * Графы прицепа от прошлого рейса машины — но только пока за ней ничего не закреплено.
 *
 * Ею окна, которые наследуют шапку (`VehicleAssignModal`, `VehicleDayRouteModal`), уступают
 * дорогу закреплению: `trip` — это **вчерашний рейс**, а `hitched` — сегодняшнее решение
 * человека из карточки прицепа, и вчерашнее поверх сегодняшнего поставило бы в бланк то, что за
 * машиной уже не стоит (§4.2.2). `null` — наследовать нечего либо нечего наследовать поверх:
 * графы прицепа в этом случае ставит закрепление, а объект `null` спокойно расходится в
 * `setFieldsValue` пустотой.
 *
 * Окон, которые шапку не наследуют, это не касается вовсе: наследовать они не начинают (пункт 2
 * того же правила) и функцию эту не зовут.
 */
export function inheritedTrailerGraphs(
  trip: RouteTripFields | null | undefined,
  hitched: readonly HitchedTrailerDto[] | undefined | null,
): TrailerGraphs | null {
  if (!trip || hitchedTrailerGraphs(hitched)) return null;
  return {
    withTrailer: trip.withTrailer,
    trailer1Model: trip.trailer1Model,
    trailer1RegNumber: trip.trailer1RegNumber,
    trailer2Model: trip.trailer2Model,
    trailer2RegNumber: trip.trailer2RegNumber,
  };
}

/**
 * Одинаковы ли графы прицепа у двух записей — формы и рейса.
 *
 * Нужна коррекции, где вопрос «меняет ли форма хоть что-то» решает, жечь ли номер бланка (Р31).
 * До Э4 она сравнивала одну галочку, и рейс, исправляемый ровно ради перепутанного госномера
 * полуприцепа, получал отказ «коррекция должна что-то менять»: менялось всё, кроме признака.
 */
export function sameTrailerGraphs(a: TrailerGraphs, b: TrailerGraphs): boolean {
  return (
    a.withTrailer === b.withTrailer &&
    a.trailer1Model === b.trailer1Model &&
    a.trailer1RegNumber === b.trailer1RegNumber &&
    a.trailer2Model === b.trailer2Model &&
    a.trailer2RegNumber === b.trailer2RegNumber
  );
}

// ── Э7: выбор прицепа из реестра (план §13) ──
// Правило одно на обе пары граф и на все пять окон, поэтому оно здесь, а не в блоке граф: режим и
// предупреждение — это то, что человек прочтёт, и написанное дважды оно разойдётся при первой
// правке ровно так же, как разошлась подпись прицепа (§2, расхождения 1 и 2).

/**
 * Два режима одной пары граф (Р17): выбор из реестра или ручной ввод.
 *
 * Названы, а не выражены булевым флагом, по той же причине, что и у адресного поля
 * (`features/address-input`, ADR 0069): `directory` читается в условии, а `true` требует помнить,
 * какая из двух половин им названа.
 *
 * Режим живёт в состоянии окна и в форму не попадает: в бланке его нет, а рейс помнит графы, а не
 * то, каким движением их заполнили (Р11).
 */
export type TrailerSlotMode = 'manual' | 'directory';

/** Режимы обеих пар граф. Именами слотов, а не кортежем: слот — это место в шапке бланка 4-П. */
export interface TrailerSlotModes {
  slot1: TrailerSlotMode;
  slot2: TrailerSlotMode;
}

/**
 * Ручной ввод в обоих слотах — с этого окно и открывается (Р17, пункт 3).
 *
 * Рейс с уже заполненными графами режим **не включает**: текст в них верен и без реестра, а
 * галочка, вставшая сама, обещала бы, что портал узнал в этих буквах запись справочника, — чего он
 * не проверял. Включив её рукой, человек увидит свой прицеп уже выбранным: значение списка
 * выводится сопоставлением графы с загруженным реестром.
 */
export const MANUAL_TRAILER_MODES: TrailerSlotModes = { slot1: 'manual', slot2: 'manual' };

/**
 * Режимы после подстановки закрепления (Р17, пункт 1): справочник там, куда подстановка положила
 * прицеп, и ручной ввод в пустом слоте.
 *
 * Порядок тот же, что у `hitchedTrailerGraphs`, и это не совпадение, а условие: режим обязан
 * описывать ту графу, которую заполнила подстановка. Разойдись они — второй слот показал бы список
 * там, где стоит пусто, а графы первого спрятались бы за выбором, которого не делали.
 */
export function substitutedTrailerModes(
  hitched: readonly HitchedTrailerDto[] | undefined | null,
): TrailerSlotModes {
  const slots = ordered(hitched);
  if (slots.length === 0) return MANUAL_TRAILER_MODES;
  return { slot1: 'directory', slot2: slots.length > 1 ? 'directory' : 'manual' };
}

/** Что в списке и чего выбор из него не делает: обе половины человеку нужны сразу (Р18). */
export const TRAILER_DIRECTORY_HINT =
  'В списке — прицепы реестра, кроме списанных. Выбор в рейсе прицеп за машиной не закрепляет.';

/**
 * Предупреждение о чужом закреплении (Р19); `null` — предупреждать не о чем.
 *
 * Не о чем в двух случаях: прицеп не закреплён ни за кем (взяли свободный) и закреплён за той же
 * машиной, что едет в рейсе (обычный случай — ровно его и подставляет портал).
 *
 * **Предупреждение, а не запрет.** Полуприцеп законно берут под чужой тягач на один выезд, и
 * портал не знает, договорились люди или нет; он знает только записанное — и говорит это. Тем же
 * правилом живут пометки о категории прав (ADR 0055, 0064): помечают, а не отсекают.
 *
 * Машина без госномера названа маркой, а безымянная — никак: «закреплён за другой машиной — »
 * с пустотой после тире человек прочтёт как сбой. Оба реквизита приезжают допускающими `null`,
 * потому что такими они лежат в `vehicles`.
 *
 * Машины в форме ещё нет — предупреждение остаётся: чужое закрепление от этого не перестаёт быть
 * чужим, а «своей» машины, с которой его можно спутать, в такой форме и нет.
 */
export function foreignHitchWarning(
  trailer: { hitchedVehicle: VehicleTrailerVehicleRefDto | null } | null | undefined,
  vehicleId: string | null | undefined,
): string | null {
  const at = trailer?.hitchedVehicle;
  if (!at || at.id === vehicleId) return null;
  const name = (at.registrationNumber ?? '').trim() || (at.modelName ?? '').trim();
  return `Прицеп закреплён за другой машиной${name ? ` — ${name}` : ''}. Рейс это не запрещает: закрепление не меняется.`;
}

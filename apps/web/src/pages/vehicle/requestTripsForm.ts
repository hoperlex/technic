import dayjs from 'dayjs';
import {
  type AddressMeta,
  normalizeTimeInput,
  type VehicleRequestTripDto,
} from '@technic/contracts';
import { MOSCOW_TZ } from '@shared/config';

/**
 * Ездки заявки в том виде, в каком их держит форма (этап 6 плана `docs/route-trips-plan.md`, §4.1).
 *
 * Отдельным файлом от самого списка (`RequestTripsField.tsx`) и от вкладки: здесь нет ни одного
 * обращения к экрану — только перевод ездки из DTO в поля формы и обратно в тело запроса. Тем же
 * разрезом живут `requestRowText.ts` и `weeklyComposition.ts`: правила о документе не должны
 * зависеть от того, каким компонентом его показывают, а `VehicleRequestsTab` давно упёрся в
 * бюджет длины (`scripts/quality.mjs`).
 */

/**
 * Строка списка ездок в значениях формы.
 *
 * Все поля необязательны намеренно: пустая строка — законное состояние **набираемой** ездки, а
 * обязательность держат правила самих полей. Требовать их здесь значило бы описывать типом не то,
 * что лежит в форме, а то, что уедет на сервер, — и приводить одно к другому пришлось бы `as`.
 */
export interface TripFormValue {
  /**
   * Ключ строки на клиенте — только для React и для правки списка; на сервер не уходит.
   *
   * Не индекс: строку удаляют из середины, и соседи по списку разъехались бы вместе с состоянием
   * своих полей — адресное поле помнит, набирали его подсказками или выбирали из справочника, и
   * после удаления второй ездки шестая открылась бы чужим режимом.
   *
   * И не `id`: у новой ездки его нет вовсе — номер назначает сервер (Р13а).
   */
  key: string;
  /** Идентификатор сохранённой ездки (Р2а); нет — строка новая, её заведут. */
  id?: string;
  fromLocation?: string;
  toLocation?: string;
  /**
   * Метаданные адреса (ADR 0006) — скрытыми полями той же формы, как и у прочих адресов портала:
   * `resetFields` и `setFieldsValue` работают над ними наравне со строкой.
   *
   * `null` — метаданных нет: так приходит ездка, доехавшая бэкфилом от заявки старше ADR 0006.
   * Форма их не выдумывает и отправляет как есть (Р2а).
   */
  fromAddress?: AddressMeta | null;
  toAddress?: AddressMeta | null;
  fromResponsibleName?: string;
  fromResponsiblePhone?: string;
  toResponsibleName?: string;
  toResponsiblePhone?: string;
  volumeM3?: number | null;
  weightTons?: number | null;
  /**
   * Своё время подачи `HH:mm` (Р3); пусто — «как у заявки».
   *
   * Временем, а не моментом: день ездки — это день заявки, и он обязан им остаться
   * (`tripsOutOfRequestDay`). Спроси форма дату — и первая же правка подачи оставила бы ездки во
   * вчерашнем дне, а сервер ответил бы 422 на поле, которого человек не трогал.
   */
  scheduledTime?: string;
  comment?: string;
}

/** Новый ключ строки: тем же генератором, что и ключ операции задним числом. */
function tripKey(): string {
  return crypto.randomUUID();
}

/** Пустая строка списка — с ней открывается новая заявка и ею добавляется «+ ездка». */
export function blankTrip(): TripFormValue {
  return { key: tripKey(), volumeM3: null, weightTons: null };
}

/**
 * Сохранённая ездка в поля формы. Всё переносится как есть, включая непроверенный адрес и пустой
 * контакт: правка старой заявки не обязана начинаться с выдумывания данных за прошлое (Р2а).
 */
export function tripToForm(t: VehicleRequestTripDto): TripFormValue {
  return {
    key: tripKey(),
    id: t.id,
    fromLocation: t.fromLocation,
    toLocation: t.toLocation,
    fromAddress: t.fromAddress,
    toAddress: t.toAddress,
    fromResponsibleName: t.fromResponsibleName,
    fromResponsiblePhone: t.fromResponsiblePhone,
    toResponsibleName: t.toResponsibleName,
    toResponsiblePhone: t.toResponsiblePhone,
    volumeM3: t.volumeM3,
    weightTons: t.weightTons,
    // Момент переводится в МСК, а не читается как московское время: `dayjs.tz(iso, tz)` потерял бы
    // пришедшее смещение и показал бы подачу на три часа раньше. Так же читает её сама заявка.
    scheduledTime: t.scheduledAt ? dayjs(t.scheduledAt).tz(MOSCOW_TZ).format('HH:mm') : undefined,
    comment: t.comment,
  };
}

/**
 * Нужен ли ездке разворот в список, чтобы её было видно целиком: своё время подачи и примечание
 * свёрнутый вид не показывает вовсе.
 *
 * Прятать их нельзя — «во сколько именно эта» и «песок, звонить за час» и есть то, ради чего они
 * заполнены; а показывать их у всякой заявки значит усложнить ввод тем, у кого ездка одна (§4.1).
 * Тем же правилом решает карточка (`VehicleRequestViewModal`), показывать ли ездку парой полей:
 * разъедься они — одна и та же заявка выглядела бы простой в карточке и списком в правке.
 */
export function tripNeedsList(t: VehicleRequestTripDto): boolean {
  return !!t.scheduledAt || !!t.comment;
}

/**
 * Размножить строку («повторить N раз», §4.1): «шесть раз с карьера на объект» вводится один раз.
 *
 * Копия несёт адреса с метаданными, контакты, количество и примечание — ровно то, что у повторной
 * ездки то же самое. Не копируется двоё:
 *
 *   - **`id`** — копия это новая ездка, и номер ей назначит сервер (Р13а). Скопируй его — и шесть
 *     строк с одним `id` означали бы шесть перезаписей одной ездки;
 *   - **время подачи** — шесть ездок за смену едут по графику, а не одновременно (Р3), и
 *     проставить им один час значило бы утверждать обратное от имени заявителя. Пустое время
 *     читается как «как у заявки» — то есть «не уточняли», что и есть правда сразу после копии.
 */
export function repeatTrip(source: TripFormValue, times: number): TripFormValue[] {
  return Array.from({ length: times }, () => {
    const copy: TripFormValue = { ...source, key: tripKey() };
    delete copy.id;
    delete copy.scheduledTime;
    return copy;
  });
}

/**
 * Момент подачи ездки из её времени и дня заявки; `null` — времени не задали (Р3).
 *
 * День берётся у заявки, а не у ездки, и это не упрощение: время ездки обязано лежать в
 * календарном дне подачи (Р18, `tripsOutOfRequestDay`), и собирать момент из чего-то ещё значило
 * бы уметь собрать тот, который сервер отклонит.
 */
function tripScheduledAt(time: string | undefined, requestDay: string): string | null {
  const normalized = normalizeTimeInput(time ?? '');
  if (normalized === undefined) return null;
  return dayjs.tz(`${requestDay} ${normalized}`, MOSCOW_TZ).format('YYYY-MM-DDTHH:mm:ssZ');
}

/**
 * Поля ездки, одинаковые у заведения и у правки. Разъехаться им нельзя: длины, точность
 * количества и рабочее окно у обеих схем одни и те же (`updateRequestTripSchema` расширяет
 * `requestTripSchema`), и вторая сборка тех же полей разошлась бы с первой при первой же правке.
 *
 * `!` здесь не бравада: пустое поле останавливает правило самого поля, и до сборки тела форма с
 * незаполненным адресом или контактом не доходит.
 */
function tripCommonFields(v: TripFormValue, requestDay: string) {
  return {
    fromLocation: v.fromLocation!,
    toLocation: v.toLocation!,
    volumeM3: v.volumeM3 ?? null,
    weightTons: v.weightTons ?? null,
    fromResponsibleName: v.fromResponsibleName!,
    fromResponsiblePhone: v.fromResponsiblePhone!,
    toResponsibleName: v.toResponsibleName!,
    toResponsiblePhone: v.toResponsiblePhone!,
    scheduledAt: tripScheduledAt(v.scheduledTime, requestDay),
    comment: v.comment ?? '',
  };
}

/**
 * Ездка для заведения заявки и для переоформления в грузоперевозку (ADR 0091).
 *
 * Жёсткая модель целиком (ADR 0006): адрес приходит парой со своими метаданными и обязан быть
 * верифицирован — у новой ездки значение всегда новое, и послаблять тут нечего. `id` не
 * передаётся: у переоформляемой заявки деталь заводится с нуля, и ездок у неё до этого не было
 * вовсе.
 */
export function newTripBody(v: TripFormValue, requestDay: string) {
  return {
    ...tripCommonFields(v, requestDay),
    fromAddress: v.fromAddress!,
    toAddress: v.toAddress!,
  };
}

/**
 * Ездка для правки заявки — полным списком (§7): строка с `id` перезаписывает существующую, без
 * него заводит новую, а ездка, которой в списке не оказалось, мягко удаляется (Р13а).
 *
 * Метаданные уходят **как есть**, вплоть до `null`: у ездки от заявки старше ADR 0006 их нет, и
 * `null` здесь значит «адрес прежний», а не «адрес не выбрали». Подставь тут что-нибудь
 * правдоподобное — и правка комментария переписала бы заявке адрес источником, которого у неё не
 * было. Требование верификации сервер вернёт ровно на изменившееся поле (Р2а).
 */
export function editTripBody(v: TripFormValue, requestDay: string) {
  return {
    ...tripCommonFields(v, requestDay),
    ...(v.id ? { id: v.id } : {}),
    fromAddress: v.fromAddress ?? null,
    toAddress: v.toAddress ?? null,
  };
}

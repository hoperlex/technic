import {
  formatPhone,
  type MechRequestDto,
  mechRequesterOf,
  mechRateUnitLabels,
  mechUnitsLabel,
  type RequestChangeDto,
} from '@technic/contracts';
import { changeSet, EMPTY, short } from './request-diff';

// Что изменило действие над заявкой механизации — для истории в её карточке (план
// `docs/mechanization-module-plan.md`, Р11). Общая механика диффа — в `request-diff.ts`; здесь
// перечень полей этого модуля и его собственные события.
//
// В `changes.field` идут ТЕХНИЧЕСКИЕ ключи, а не подписи: подписи живут словарём
// `mechRequestChangeLabels` в контрактах и подставляются при отрисовке. Иначе переименование поля
// в интерфейсе переписывало бы историю задним числом, а старые записи остались бы с прежними
// словами.
//
// Событий у модуля семь, а не одно, и делятся они не по прихоти: у заявки меняются пять разных
// сюжетов — форма, договорённость, факт выдачи, срок возврата и факт возврата, — и сведи их к одной
// «правке», в истории не осталось бы ни «была ставка 1200/час, стала 1500», ни «выдачу отметили
// ошибочно, причина такая-то», ни «срок продлили на неделю, потому что». Все эти вопросы задают,
// разбирая счёт.

/** Деньги человеку: 1 200,00 ₽. Ставка и итог показываются одинаково — их и сравнивают глазами. */
function money(v: number | null): string {
  if (v == null) return EMPTY;
  return `${v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

/**
 * Календарный день человеку: `2026-09-04` → «04.09.2026». Своя разборка строки, а не пересчёт
 * момента времени: в базе это `date`, зоны у него нет вовсе, и прогон через `Date` сдвинул бы день
 * на московские три часа.
 */
function day(dateKey: string | null): string {
  if (!dateKey) return EMPTY;
  const [yyyy, mm, dd] = dateKey.split('-');
  return dd && mm && yyyy ? `${dd}.${mm}.${yyyy}` : dateKey;
}

/**
 * Предмет аренды человеку — наименование модели из справочника (ADR 0156).
 *
 * Запасного хода через написание заявки здесь больше нет: этап Э3 снял колонку по решению
 * заказчика, и у заявки без модели предмета аренды нет вовсе. В истории это честный прочерк, а не
 * пустая строка: событие правки такой заявки обязано сказать, что названия техники у неё не стало,
 * — и сказать одинаково с карточкой и списком, где на том же месте тот же прочерк.
 */
function model(r: MechRequestDto): string {
  return r.mechModelName ?? EMPTY;
}

/** Площадка — код и наименование: справочник могут переименовать, история обязана помнить прежнее. */
function place(r: MechRequestDto): string {
  return `${r.objectCode} — ${r.objectName}`;
}

/**
 * Заявитель строкой. Отдел, если он заполнен, иначе «—»: ключ `department` подписан «Заявитель», и
 * пустая правая часть читается как «заявку завела сама площадка», а она названа отдельной строкой
 * `object`.
 */
function requester(r: MechRequestDto): string {
  return r.departmentId ? `${r.departmentCode ?? ''} — ${r.departmentName ?? ''}` : EMPTY;
}

/** Отработанное с единицей: «26 ч», «3 смены». Без единицы «120» не значит ничего (Р7). */
function units(r: Pick<MechRequestDto, 'actualUnits' | 'rateUnit'>): string {
  if (r.actualUnits == null) return EMPTY;
  // Единицы нет только у стёртой договорённости, а тогда нет и факта: число без подписи всё же
  // честнее выдуманного «часа».
  return r.rateUnit ? mechUnitsLabel(r.rateUnit, r.actualUnits) : String(r.actualUnits);
}

/**
 * Изменённые поля формы (`mech_request.update`). Значения — готовый текст на момент правки:
 * справочник могли переименовать или снять, а история обязана показывать то, что было.
 *
 * Договорённости и факта здесь нет намеренно: они правятся не формой, а своими действиями (Р19), и
 * у каждого своё событие ниже. Попади они сюда — «правка заявки» рассказывала бы про деньги, а
 * читатель истории не отличил бы исправленную опечатку от пересмотренной ставки.
 */
export function diffMechRequests(
  before: MechRequestDto,
  after: MechRequestDto,
): RequestChangeDto[] {
  const diff = changeSet();
  diff.changed('object', place(before), place(after));
  diff.changed('department', requester(before), requester(after));
  // Ключ остался прежним, хотя поле стало ссылкой, а колонка `kind_name` и вовсе снята уборкой Э3:
  // история append-only, и переименуй ключ — записи до Э2 остались бы в карточке без подписи
  // (`mechRequestChangeLabels`).
  diff.changed('kindName', model(before), model(after));
  diff.changed('plannedFrom', day(before.plannedFrom), day(after.plannedFrom));
  diff.changed('plannedTo', day(before.plannedTo), day(after.plannedTo));
  diff.changed('responsibleName', before.responsibleName || EMPTY, after.responsibleName || EMPTY);
  // Номер тем же видом, что в карточке (ADR 0066): «9261234567» против «+7 (926) 123-45-67»
  // выглядело бы сменой формата, а не сменой номера.
  diff.changed(
    'responsiblePhone',
    formatPhone(before.responsiblePhone) || EMPTY,
    formatPhone(after.responsiblePhone) || EMPTY,
  );
  diff.changed('comment', short(before.comment) || EMPTY, short(after.comment) || EMPTY);
  diff.files(before.files, after.files);
  return diff.changes;
}

/**
 * Договорённость (`mech_request.deal`): назначена, исправлена или стёрта входом в «Новую» (Р8, Р11).
 *
 * Своё событие, а не строки общей правки: без него «была ставка 1200/час, стала 1500» не остаётся
 * нигде — история статусов хранит только переход и комментарий, а строка заявки помнит одно
 * «сейчас». Очистка приезжает сюда же с пустой правой стороной: цифры обязаны попасть в историю в
 * тот момент, когда исчезают из карточки.
 */
export function mechDealChanges(
  before: Pick<MechRequestDto, 'lessorName' | 'rate' | 'rateUnit'>,
  after: Pick<MechRequestDto, 'lessorName' | 'rate' | 'rateUnit'>,
): RequestChangeDto[] {
  const diff = changeSet();
  diff.changed('lessor', before.lessorName ?? EMPTY, after.lessorName ?? EMPTY);
  diff.changed('rate', money(before.rate), money(after.rate));
  diff.changed(
    'rateUnit',
    before.rateUnit ? mechRateUnitLabels[before.rateUnit] : EMPTY,
    after.rateUnit ? mechRateUnitLabels[after.rateUnit] : EMPTY,
  );
  return diff.changes;
}

/**
 * Отметка выдачи (`mech_request.issue`): с этого дня пошли деньги. Пара «— → 04.09.2026», а не
 * событие-список: у выдачи «было» есть — его отсутствие, — и повторная отметка после снятия
 * читается по ней как исправление, а не как вторая выдача.
 */
export function mechIssueChanges(before: string | null, after: string): RequestChangeDto[] {
  const diff = changeSet();
  diff.changed('actualFrom', day(before), day(after));
  return diff.changes;
}

/**
 * Снятие ошибочной отметки (`mech_request.issue_revoke`, Р2). Дата уходит обычной парой, причина —
 * строкой вида «список» (`from === null`): у причины нет «было», и пара «— → текст» читалась бы как
 * потеря значения.
 *
 * После снятия строка снова выглядит невыданной, поэтому событие — единственный носитель факта:
 * что выдача была и почему её отменили, не помнит больше ничто (Р21, строгий аудит).
 */
export function mechIssueRevokeChanges(actualFrom: string, reason: string): RequestChangeDto[] {
  const diff = changeSet();
  diff.changed('actualFrom', day(actualFrom), EMPTY);
  diff.listed('issueRevokeReason', [reason]);
  return diff.changes;
}

/**
 * Продление срока (`mech_request.extend`, Р11). Обе даты идут обычной парой «было → стало»: у
 * плана возврата «было» есть всегда, и именно прежнюю дату спрашивают, разбирая счёт — по ней
 * видно, сколько дней добавили и когда.
 *
 * Причина — строкой вида «список» (`from === null`), как у снятия отметки: у неё нет «было», и
 * пара «— → текст» читалась бы как потеря значения.
 *
 * Ключ `plannedTo` тот же, что у правки формы, и это не путаница: поле одно, а событий два, и
 * различает их вид истории (`mechExtended` против `updated`), а не имя ключа. Прежний срок строка
 * не хранит — она помнит одно «сейчас», — поэтому событие и есть единственный носитель факта (Р21).
 */
export function mechExtendChanges(
  before: string,
  after: string,
  reason: string,
): RequestChangeDto[] {
  const diff = changeSet();
  diff.changed('plannedTo', day(before), day(after));
  diff.listed('extendReason', [reason]);
  return diff.changes;
}

/**
 * Завершение (`mech_request.complete`), в том числе повторное после отката «Выполнена» → «В работе».
 *
 * Повторное завершение перезаписывает все четыре значения, и прежние не сохранит ничто, кроме этой
 * записи, — а именно их спрашивают, разбирая счёт. Пустая правая сторона тоже возможна: откат в
 * «Новую» стирает факт, и история обязана показать это строками «3 смены → —», а не молчанием.
 */
export function mechCompletionChanges(
  before: Pick<
    MechRequestDto,
    'actualFrom' | 'actualTo' | 'actualUnits' | 'rateUnit' | 'finalCost'
  >,
  after: Pick<MechRequestDto, 'actualFrom' | 'actualTo' | 'actualUnits' | 'rateUnit' | 'finalCost'>,
): RequestChangeDto[] {
  const diff = changeSet();
  diff.changed('actualFrom', day(before.actualFrom), day(after.actualFrom));
  diff.changed('actualTo', day(before.actualTo), day(after.actualTo));
  diff.changed('actualUnits', units(before), units(after));
  diff.changed('finalCost', money(before.finalCost), money(after.finalCost));
  return diff.changes;
}

/**
 * Снимок исчезающей заявки для общего журнала (§6) — второй реестр аудита, не история карточки.
 *
 * Четырнадцать ключей отвечают ровно на один вопрос: **сможет ли журнал объяснить деньги заявки,
 * которой больше нет**. Ставка с единицей и отработанные единицы показывают, из чего сложилась
 * `finalCost`; без `actualUnits` итог оказался бы числом без вывода.
 *
 * Форма одна на все четыре действия второго реестра — `create`, `hard_delete`, `purge` (и `status`
 * со своим телом), — включая заведение, где половина ключей пуста по существу: у новой заявки нет
 * ни арендодателя, ни ставки, ни факта. Один набор с пустыми значениями честнее второго,
 * укороченного: тот разошёлся бы с первым при первой же правке модели.
 *
 * Чего в снимке нет намеренно: ответственного с телефоном, комментария и имён вложений. Для
 * финансового разбора они не нужны, а журнал append-only — переносить в него персональные данные
 * после уничтожения самой строки незачем.
 */
export function mechAuditSnapshot(r: MechRequestDto): Record<string, unknown> {
  return {
    num: r.num,
    objectId: r.objectId,
    // Кто просил: площадка сама за себя или отдел. Выводится тем же правилом, что и на экране
    // (`mechRequesterOf`), — колонки здесь не взаимоисключающие, и `objectId` заполнен всегда.
    requesterKind: mechRequesterOf(r)?.kind ?? null,
    departmentId: r.departmentId,
    // Обе половины предмета аренды: ссылка отвечает «какая это позиция справочника», имя — «как
    // она называлась». Имя берётся у справочника, а не у снятого написания заявки: уборка Э3
    // унесла `kindName`, но задача ключа осталась прежней — заявки после `purge` нет, а модель,
    // на которую она ссылалась, с этого момента можно снести насовсем (`RESTRICT` держал её только
    // пока заявка была). Останься здесь один идентификатор — журнал отвечал бы про деньги строкой
    // «за uuid», и дописать имя было бы уже некуда: журнал append-only. У заявки без модели пусто
    // и здесь, и это её честное состояние после Э3, а не пропажа записи.
    mechModelId: r.mechModelId,
    mechModelName: r.mechModelName,
    status: r.status,
    lessorId: r.lessorId,
    rate: r.rate,
    rateUnit: r.rateUnit,
    actualFrom: r.actualFrom,
    actualTo: r.actualTo,
    actualUnits: r.actualUnits,
    finalCost: r.finalCost,
  };
}

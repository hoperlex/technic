import {
  formatPhone,
  officeEquipmentTitle,
  type RequestChangeDto,
  SERVICE_REQUEST_NO_EQUIPMENT,
  serviceFileKindLabels,
  type ServiceRequestFileDto,
  serviceItemKindLabels,
  type ServiceRequestDto,
  type ServiceRequestItemDto,
  warrantyClaimSourceLabels,
} from '@technic/contracts';
import { changeSet, EMPTY, short } from './request-diff';

// Что изменила правка заявки на обслуживание оргтехники — для истории в её карточке (ADR 0012,
// ADR 0085). Общая механика диффа — в request-diff.ts; здесь перечень полей этого модуля.
//
// Смета сравнивается отдельно от полей заявки и по составу, а не по итогу: «было 7 100, стало
// 6 900» скрывает, что вместо термоузла поставили ролик. Спорят с сервисом именно о составе.

function money(value: number | null): string {
  return value == null ? EMPTY : `${value.toFixed(2)} ₽`;
}

/**
 * Строка сметы одним текстом: вид, наименование, количество и цена. По нему история и читается —
 * «Запчасть «Ролик подачи», 1 × 1800,00 ₽», — а идентификаторы человеку ничего не говорят.
 */
function itemLine(item: ServiceRequestItemDto): string {
  const warranty = item.warrantyMonths ? `, гарантия ${item.warrantyMonths} мес` : '';
  return `${serviceItemKindLabels[item.kind]} «${item.name}», ${item.quantity} × ${money(
    item.unitPrice,
  )}${warranty}`;
}

/** Ключ строки для сравнения составов: смета правится целиком, и id новых строк каждый раз другие. */
function itemKey(item: ServiceRequestItemDto): string {
  return `${item.kind}|${item.name}|${item.quantity}|${item.unitPrice}|${item.warrantyMonths ?? ''}`;
}

function warrantyClaimLabel(request: ServiceRequestDto): string {
  const claim = request.warrantyClaim;
  if (!claim) return EMPTY;
  const source = warrantyClaimSourceLabels[claim.source];
  if (claim.source === 'equipment') return source;
  const request_ = claim.sourceRequestNum ? ` (СО-${claim.sourceRequestNum})` : '';
  return `${source}: ${claim.itemName}${request_}`;
}

/**
 * Изменённые поля заявки. Значения — готовый текст на момент правки: отдел могли переименовать, а
 * история обязана показывать то, что было. Предмет заявки (единица техники) не сравнивается вовсе:
 * он неизменяем, и заявка хранит его снимком (ADR 0085 §7).
 */
export function diffServiceRequests(
  before: ServiceRequestDto,
  after: ServiceRequestDto,
): RequestChangeDto[] {
  const diff = changeSet();
  diff.changed('description', short(before.description), short(after.description));
  diff.changed(
    'customerDepartment',
    before.customerDepartment?.name ?? EMPTY,
    after.customerDepartment?.name ?? EMPTY,
  );
  diff.changed('responsibleName', before.responsibleName || EMPTY, after.responsibleName || EMPTY);
  diff.changed(
    'responsiblePhone',
    before.responsiblePhone ? formatPhone(before.responsiblePhone) : EMPTY,
    after.responsiblePhone ? formatPhone(after.responsiblePhone) : EMPTY,
  );
  diff.changed('comment', short(before.comment) || EMPTY, short(after.comment) || EMPTY);
  diff.changed('warrantyClaim', warrantyClaimLabel(before), warrantyClaimLabel(after));
  // Срочность и её причина — два поля, а не одно: снятая срочность с сохранившимся текстом
  // читалась бы как «причина осталась, а признак сам собой пропал», и спорить об этом было бы не о
  // чем. Пара обязана меняться вместе, и в истории это видно двумя строками.
  diff.changed('isUrgent', before.isUrgent ? 'да' : 'нет', after.isUrgent ? 'да' : 'нет');
  diff.changed(
    'urgencyReason',
    short(before.urgencyReason) || EMPTY,
    short(after.urgencyReason) || EMPTY,
  );
  // Файлы сравниваются по составу, а не по количеству: «было 3, стало 3» скрыло бы замену акта.
  // Своим кодом, а не общим `diff.files`: у вложения заявки на обслуживание есть вид документа
  // (акт, счёт, гарантийный талон), и в истории он значим — «прикреплён акт» и «прикреплено фото»
  // читаются по-разному.
  const was = new Map(before.files.map((f) => [f.id, f]));
  const now = new Map(after.files.map((f) => [f.id, f]));
  const label = (file: ServiceRequestFileDto): string =>
    file.kind === 'attachment'
      ? file.filename
      : `${serviceFileKindLabels[file.kind]}: ${file.filename}`;
  /*
   * РЯДОМ С ИМЕНАМИ ЕДУТ ИДЕНТИФИКАТОРЫ (план освобождения от подписи, Р6 п. 4, как у общего
   * `changeSet().files()`): имя попадает в журнал в момент подшивки, а карантин ошибочно
   * загруженного документа ставят позже — по инциденту, обнаруженному потом. Журнал заявки не
   * переписывают, значит гасить имя приходится при ЧТЕНИИ истории, а читателю нужно знать, о каком
   * файле речь: по имени файл не ищется — их бывает два одинаковых, и строки файла может уже не
   * быть.
   *
   * Вид документа остаётся в подписи имени («Акт: договор.pdf»): в этом модуле он значим, и
   * «прикреплён акт» читается не так, как «прикреплено фото». У запертого файла имя пустеет целиком
   * вместе с подписью вида — иначе перечень видов сам рассказывал бы, что именно заперли.
   */
  const pairs = (
    rows: Map<string, ServiceRequestFileDto>,
    other: Map<string, ServiceRequestFileDto>,
  ) =>
    [...rows].filter(([id]) => !other.has(id)).map(([id, file]) => ({ id, filename: label(file) }));
  diff.fileList('filesAdded', pairs(now, was));
  diff.fileList('filesRemoved', pairs(was, now));
  return diff.changes;
}

/**
 * Что изменилось в смете между двумя ревизиями. Отдельным событием от правки заявки: смету ведёт
 * исполнитель, а правит заявку заказчик, и в истории это два разных рассказа.
 *
 * Сравнение по составу строк, а не по их идентификаторам: смета передаётся целиком, старые строки
 * удаляются вместе с id, и по id всякая правка выглядела бы полной заменой сметы.
 */
export function diffServiceEstimate(
  before: readonly ServiceRequestItemDto[],
  after: readonly ServiceRequestItemDto[],
): RequestChangeDto[] {
  const diff = changeSet();
  const was = new Map(before.map((i) => [itemKey(i), i]));
  const now = new Map(after.map((i) => [itemKey(i), i]));
  diff.listed(
    'estimateItemsAdded',
    [...now].filter(([key]) => !was.has(key)).map(([, item]) => itemLine(item)),
  );
  diff.listed(
    'estimateItemsRemoved',
    [...was].filter(([key]) => !now.has(key)).map(([, item]) => itemLine(item)),
  );
  return diff.changes;
}

/**
 * Что предъявил исполнитель при закрытии: невыполненные строки и фактические количества. В историю
 * попадает именно это, а не итоговая сумма, — сумма видна в карточке, а вот «тормозную площадку не
 * ставили» иначе останется незамеченным, и гарантию на неё будут искать годом позже.
 */
export function diffServiceCompletion(items: readonly ServiceRequestItemDto[]): RequestChangeDto[] {
  const diff = changeSet();
  diff.listed(
    'itemsNotPerformed',
    items.filter((i) => i.performed === false).map((i) => `${i.name}`),
  );
  diff.listed(
    'itemsPartial',
    items
      .filter((i) => i.performed && i.actualQuantity != null && i.actualQuantity !== i.quantity)
      .map((i) => `${i.name}: ${i.actualQuantity} из ${i.quantity}`),
  );
  return diff.changes;
}

/**
 * Как заявка называется в письмах, подсказках и заголовках действий журнала: номер плюс предмет.
 *
 * У заявки без аппарата (Р8) предмета нет, и вторая половина заголовка говорит это словами. Не
 * одним номером: заголовок читают в ленте аудита вперемешку с чужими, и «СО-14» без продолжения
 * там неотличим от заголовка, у которого предмет потерялся при сборке.
 */
export function serviceRequestTitle(request: ServiceRequestDto): string {
  const subject = request.equipment
    ? officeEquipmentTitle({
        name: request.equipment.name,
        inventoryNumber: request.equipment.inventoryNumber,
        serialNumber: request.equipment.serialNumber,
      })
    : SERVICE_REQUEST_NO_EQUIPMENT;
  return `${request.displayNumber} · ${subject}`;
}

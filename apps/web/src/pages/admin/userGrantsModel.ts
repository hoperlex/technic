import {
  GRANT_MODULE_WIDE_SCOPE,
  OFFICE_EQUIPMENT_PROFILE_REGISTRY,
  OFFICE_EQUIPMENT_PROFILES,
  permissionsFor,
  roleLabels,
  type CounterpartyType,
  type GrantDto,
  type GrantStatement,
  type OfficeEquipmentProfileId,
  type Permission,
  type Role,
  type UserGrantRefDto,
} from '@technic/contracts';
import { permissionLabel } from './grantModel';

/**
 * Поле «Полномочия» окна учётки, посчитанное отдельно от экрана (план «полномочия назначаются в
 * окне учётки», Р4 и §6): гидратация галочек, сборка высказывания и строка «Добавится».
 *
 * Своим файлом, а не внутри компонента, по одной причине: **тело запроса здесь не равно значению
 * группы чекбоксов**, и это самое неочевидное место фичи. В группе лежат только совместимые
 * отмеченные наборы, а высказать форма обязана и то, что из группы исчезло, — назначение, которое
 * смена роли гасит (§6, «Сериализация тела»). Правило это проверяется юнит-тестами по значениям, а
 * не кликами по разметке: разложенное по обработчикам, оно проверялось бы через экран, то есть
 * заметно хуже.
 *
 * Своего представления о совместимости здесь нет ни строчки: что совместимо с итоговой ролью,
 * говорит каталог, отобранный сервером по роли (`grantFormApi.catalog`), а что действовало до
 * правки — `roleMismatch` назначения, посчитанный сервером же. Вторая копия любого из этих правил
 * разошлась бы с сервером в первую же правку `grant_roles`.
 */

/**
 * Что администратор тронул руками, пока окно открыто, — два устойчивых множества (Р4).
 *
 * Второе (`unchecked`) не роскошь: без него снятая галочка вернулась бы сама при следующей смене
 * роли — гидратация считает от **выданных**, а выданным набор остаётся до сохранения. Человек снял
 * бы полномочие, сменил роль и сохранил бы его обратно, ничего не заметив.
 *
 * Живут они ровно до закрытия окна: решение принимают за один заход.
 */
export interface GrantManualEdits {
  /** Отмеченные руками — в том числе те, что учётке ещё не выданы. */
  checked: readonly string[];
  /** Снятые руками: гидратация обязана их не возвращать. */
  unchecked: readonly string[];
}

/** Ничего не трогали: с этого состояния окно открывается и к нему же возвращается при закрытии. */
export const NO_GRANT_EDITS: GrantManualEdits = { checked: [], unchecked: [] };

/** Назначения, которые форма снять не даёт: взведённые переводом ролей (Р4, ADR 0113). */
export function lockedGrantIds(assigned: readonly UserGrantRefDto[]): Set<string> {
  return new Set(assigned.filter((g) => g.origin === 'migration').map((g) => g.id));
}

/**
 * Профиль модуля «Орг.техника» пунктом выпадающего списка (план профилей оргтехники, Р7).
 *
 * Список строится ИЗ РЕЕСТРА КОНТРАКТОВ (`OFFICE_EQUIPMENT_PROFILE_REGISTRY`), а не из здешней
 * таблицы «профиль → наборы»: вторая такая таблица разошлась бы с первой ровно так же молча, как
 * разошлась бы копия правил совместимости, — и администратор выдал бы половину профиля, считая, что
 * выдал целый.
 *
 * Отбор по каталогу — тот же способ, каким форма показывает несовместимость набора: каталог отобран
 * сервером по выбранной роли, и профиль, ни одного кода которого этой роли не положено, предлагать
 * нечего — выбор его ничего бы не отметил.
 *
 * «Сервисный центр» СТОИТ В СПИСКЕ ВСЕГДА И ВЫКЛЮЧЕННЫМ (Р11). Кодами он не выдаётся вовсе, и
 * отбор по каталогу выбросил бы его первым — а это ровно то, чего делать нельзя: администратор
 * ищет в списке все четыре профиля, и молчаливо пропавший читался бы как «такого профиля нет» либо
 * «я его уже выдал». Подпись объясняет, чем он выдаётся на самом деле: пустой список кодов в
 * реестре — это утверждение о способе выдачи, а не пропуск.
 */
export interface GrantProfileOption {
  value: OfficeEquipmentProfileId;
  /** Подпись пункта: у выключенного она же и объяснение — второго места под него в списке нет. */
  label: string;
  /** Кодами не выдаётся: выбрать нельзя, но видеть — обязательно. */
  disabled: boolean;
}

/** Чем «Сервисный центр» выдаётся вместо набора — дословно пара из Р2. */
const SERVICE_PROFILE_HINT =
  'выдаётся ролью «Оператор» и контрагентом сервисной компании, не здесь';

export function grantProfileOptions(catalog: readonly GrantDto[]): GrantProfileOption[] {
  const codes = new Set(catalog.map((g) => g.code));
  return OFFICE_EQUIPMENT_PROFILES.flatMap<GrantProfileOption>((value) => {
    const profile = OFFICE_EQUIPMENT_PROFILE_REGISTRY[value];
    if (profile.grants.length === 0) {
      return [{ value, label: `${profile.label} — ${SERVICE_PROFILE_HINT}`, disabled: true }];
    }
    if (!profile.grants.some((code) => codes.has(code))) return [];
    return [{ value, label: profile.label, disabled: false }];
  });
}

/**
 * Коды выбранного профиля — то, что уходит в **предложенные** гидратации (Р7), и ничего сверх того.
 *
 * Выбор профиля НИЧЕГО НЕ СОХРАНЯЕТ И НИЧЕГО НЕ ОТМЕЧАЕТ САМ: он лишь дополняет третье множество
 * формулы, а решают её выданные, ручные отметки и снятия. Отсюда даром достаются четыре свойства,
 * которых иначе пришлось бы добиваться по отдельности: снятое руками не возвращается (снятия
 * вычитаются последними), смена роли гасит несовместимое сама (пересечение с каталогом),
 * несовместимое не уходит на сервер (тело собирается от того же значения), а «повышение прав»
 * остаётся сохранением формы администратором — не побочным эффектом выбора в списке.
 *
 * Оба кода профиля ИТ уходят вместе и одним высказыванием (`buildGrantStatements` собирает тело
 * целиком, одним запросом): половина профиля — это человек, которого можно назначить исполнителем,
 * но который не видит модуль, либо наоборот.
 */
export function profilePresetCodes(profile: OfficeEquipmentProfileId | null): readonly string[] {
  return profile ? OFFICE_EQUIPMENT_PROFILE_REGISTRY[profile].grants : [];
}

/**
 * Значение группы чекбоксов (Р4; план «пожелание при регистрации заполняет форму активации», §3.6):
 *
 * ```text
 * ((выданные ∪ предложенные ∪ отмеченные_вручную) \ снятые_вручную) ∩ список_наборов_итоговой_роли
 * ```
 *
 * Пересчитывается при открытии и при **каждой** смене роли — иначе ломается тот самый переход,
 * ради которого заведён диапазон: у `shtab` взведённое переводом `vehicle_ordering` несовместимо и
 * скрыто, при переходе на `site` оно попадает в диапазон, и не отмеченное галочкой было бы отозвано
 * сервером вместе со своим `id`, которого ищет откат перевода ролей.
 *
 * **Предложенные** — третье множество, и подстановка по пожеланию делается здесь, а не отдельным
 * присваиванием в поле, ради трёх свойств, которые формула отдаёт даром (§3.6): снятое руками не
 * возвращается (`снятые_вручную` вычитаются последними); смена роли гасит предложенное сама —
 * «Заказ техники» совместим только с `site` и при другой роли выпадает из пересечения; несовместимое
 * не уходит на сервер, потому что тело собирает `buildGrantStatements` от этого же значения.
 *
 * Взведённое переводом из `снятых_вручную` изымается здесь же: снять его нельзя, и попади оно туда
 * обходом (устаревшая разметка, чужая правка), молчаливая потеря части перевода была бы дороже
 * лишней проверки.
 *
 * Порядок — каталожный: список читают глазами, и он не должен перескакивать при отметке.
 */
export function hydrateGrantSelection(input: {
  assigned: readonly UserGrantRefDto[];
  catalog: readonly GrantDto[];
  edits: GrantManualEdits;
  /**
   * Коды наборов, предложенных пожеланием заявителя (§3.6). Отсутствие поля и пустой список —
   * одно и то же: у обычной учётки и у заведения новой подстановки нет вовсе.
   *
   * Кодами, а не идентификаторами, и это не мелочь: код набора стабилен навсегда, а `id` строки
   * каталога — нет. Перевод в идентификаторы идёт по каталогу, отобранному сервером под выбранную
   * роль, — второго представления о том, что какой роли положено, форма не заводит. Кода, которого
   * в живом каталоге нет (набор переименован, роль другая), подстановка молча не находит: каталог
   * здесь источник правды, а не таблица умолчаний.
   */
  suggestedCodes?: readonly string[];
}): string[] {
  const { assigned, catalog, edits, suggestedCodes = [] } = input;
  const locked = lockedGrantIds(assigned);
  const wanted = new Set(assigned.map((g) => g.id));
  const suggested = new Set(suggestedCodes);
  for (const grant of catalog) if (suggested.has(grant.code)) wanted.add(grant.id);
  for (const id of edits.checked) wanted.add(id);
  // Снятые — последними и после предложенных: иначе подстановка возвращала бы галочку, которую
  // администратор только что снял, и делала бы это на каждой смене роли.
  for (const id of edits.unchecked) if (!locked.has(id)) wanted.delete(id);
  return catalog.filter((g) => wanted.has(g.id)).map((g) => g.id);
}

/**
 * Ручная правка, снятая с самой группы: что появилось — в «отмеченные», что исчезло — в «снятые».
 *
 * Считается разницей значений, а не событием чекбокса: `Checkbox.Group` отдаёт итоговый список, и
 * восстановить по нему намерение можно только сравнением с прежним. Множества при этом
 * взаимоисключающие — отметив снятое, человек берёт своё слово назад целиком.
 */
export function applyGrantToggle(
  edits: GrantManualEdits,
  before: readonly string[],
  after: readonly string[],
): GrantManualEdits {
  const was = new Set(before);
  const now = new Set(after);
  const checked = new Set(edits.checked);
  const unchecked = new Set(edits.unchecked);
  for (const id of after)
    if (!was.has(id)) {
      checked.add(id);
      unchecked.delete(id);
    }
  for (const id of before)
    if (!now.has(id)) {
      unchecked.add(id);
      checked.delete(id);
    }
  return { checked: [...checked], unchecked: [...unchecked] };
}

/** Назначения вне диапазона итоговой роли: выданы, но этой ролью не действуют (§13.1, §4.3). */
export function outOfRangeGrants(
  assigned: readonly UserGrantRefDto[],
  catalog: readonly GrantDto[],
): UserGrantRefDto[] {
  const inRange = new Set(catalog.map((g) => g.id));
  return assigned.filter((g) => !inRange.has(g.id));
}

/**
 * Тело запроса (§6, «Сериализация тела»):
 *
 * ```text
 * строки = управляемые назначения ∪ переключаемые назначения ∪ отмеченные наборы
 * selected(id) = id ∈ значение группы чекбоксов
 * version(id)  = из каталога, а для назначения вне списка — из `UserAccountDto.grants`
 * ```
 *
 * **Переключаемые** — те, чьё действие меняет сама смена роли: до правки набор действовал
 * (`roleMismatch: false`), а с новой ролью несовместим — или наоборот. Без такой строки переход
 * `site → shtab` уходил бы на сервер молча, и правило полноты (§4.2) отвечало бы 400 на верном по
 * смыслу запросе: в группе гасимого набора нет вовсе — он несовместим и не показан чекбоксом.
 * `selected: false` у него означает не «снять», а «вижу, что перестаёт действовать» (§4.3).
 *
 * Роль не менялась — переключаемых нет по определению, и лишних строк тело не несёт: назначение
 * вне диапазона роли операцией не затрагивается (Р4).
 *
 * Набор, версии которого нет ни в каталоге, ни в назначениях, пропускается: сказать о нём нечего —
 * подписывают состав, а он неизвестен.
 */
export function buildGrantStatements(input: {
  assigned: readonly UserGrantRefDto[];
  catalog: readonly GrantDto[];
  selected: readonly string[];
  /** Роль учётки до правки: по ней сервер считал `roleMismatch`. У новой учётки её нет. */
  roleBefore: Role | null;
  /** Роль, выбранная в форме прямо сейчас, — та, по которой отобран каталог. */
  roleAfter: Role | null;
}): GrantStatement[] {
  const { assigned, catalog, selected, roleBefore, roleAfter } = input;
  const inRange = new Set(catalog.map((g) => g.id));
  const chosen = new Set(selected);
  const versions = new Map<string, number>();
  for (const grant of assigned) versions.set(grant.id, grant.version);
  // Каталог поверх назначений: состав, который форма показала подсказкой, — это его версия.
  for (const grant of catalog) versions.set(grant.id, grant.version);

  const spoken = new Set<string>();
  for (const grant of assigned) {
    const managed = inRange.has(grant.id);
    const switched = roleAfter !== roleBefore && !grant.roleMismatch !== managed; // до ≠ после
    if (managed || switched) spoken.add(grant.id);
  }
  for (const id of chosen) spoken.add(id);

  // Порядок — каталожный, следом назначения вне списка: тело читают в отладке и в тестах, и
  // порядок, зависящий от обхода множества, сравнивать пришлось бы сортировкой на каждой стороне.
  const order = [...catalog.map((g) => g.id), ...assigned.map((g) => g.id)];
  const rows: GrantStatement[] = [];
  const done = new Set<string>();
  for (const id of order) {
    if (!spoken.has(id) || done.has(id)) continue;
    const version = versions.get(id);
    if (version === undefined) continue;
    done.add(id);
    rows.push({ id, version, selected: chosen.has(id) });
  }
  return rows;
}

/**
 * Строка «Добавится» — **что полномочия дают сверх должности** (§6).
 *
 * Считается двумя полными субъектами, а не вычитанием из прав учётки, и это не осторожность:
 * список прав записи отвечает про **прежнего** субъекта — до смены роли и до смены типа
 * контрагента, — а у нерассмотренной заявки он пуст вовсе, и в строку попали бы права самой роли.
 *
 * Гейт совместимости здесь не нужен: состав берётся у отмеченных наборов, а отмечены бывают только
 * совместимые с итоговой ролью — каталог отобран ею же.
 */
export function grantAddedPermissions(input: {
  role: Role | null;
  counterpartyType: CounterpartyType | null;
  catalog: readonly GrantDto[];
  selected: readonly string[];
}): Permission[] {
  const { role, counterpartyType, catalog, selected } = input;
  const chosen = new Set(selected);
  const grantPermissions = [
    ...new Set(catalog.filter((g) => chosen.has(g.id)).flatMap((g) => g.permissions)),
  ];
  const base = new Set(permissionsFor({ role, counterpartyType, grantPermissions: [] }));
  return permissionsFor({ role, counterpartyType, grantPermissions }).filter((p) => !base.has(p));
}

/** Модули, где набор снимает сужение области (ADR 0106, решение 2), — их именами витрины. */
const SCOPE_MODULE_LABELS: Record<string, string> = {
  serviceRequests: 'Орг.техника: заявки',
  officeEquipment: 'Орг.техника: справочник',
};

/**
 * Та же таблица сквозной области, но по ключу-строке: код набора приходит из базы, где рядом лежат
 * собранные администратором, и приведение его к `SystemGrantCode` обещало бы обратное.
 */
const WIDE_SCOPE_BY_CODE = new Map<string, readonly string[]>(
  Object.entries(GRANT_MODULE_WIDE_SCOPE),
);

/**
 * Подсказка чекбокса: состав набора правами и — у системного набора со сквозной областью —
 * предупреждение о ней.
 *
 * Область названа отдельной фразой, а не подразумевается составом: «Согласование ИТ» отличается от
 * прочих наборов не правом, а тем, что видит модуль целиком, минуя область роли. Умолчи форма об
 * этом, администратор выдал бы визу ИТ отделу, считая, что человек останется в своём отделе.
 */
export function grantCompositionText(grant: GrantDto): string {
  const composition =
    grant.permissions.length > 0
      ? `Даёт: ${grant.permissions.map(permissionLabel).join(', ')}`
      : 'Прав в наборе нет: доступа он не даёт';
  const modules = WIDE_SCOPE_BY_CODE.get(grant.code) ?? [];
  if (modules.length === 0) return composition;
  const names = modules.map((m) => SCOPE_MODULE_LABELS[m] ?? m).join(', ');
  return `${composition}. Область: видит эти разделы целиком (${names}), а не только свой объект или отдел`;
}

/** Как набор называют в сообщениях: имя в кавычках — так же, как его подписывает чекбокс. */
const grantNames = (grants: readonly UserGrantRefDto[]): string =>
  grants.map((g) => `«${g.name}»`).join(', ');

/**
 * Сообщение при смене роли — **о последствии, а не о снятии** (Р4).
 *
 * У надстроек текст звучал «надстройка снята», и это было правдой: несовместимую надстройку форма
 * действительно снимала. У наборов иначе, и разница принципиальная: назначение остаётся жить, а
 * прав по нему нет — их гасит гейт совместимости при чтении. Скажи форма «снято», администратор
 * пошёл бы выдавать набор заново, а он никуда не девался.
 */
export function roleGateNoticeText(
  role: Role | null,
  extinguished: readonly UserGrantRefDto[],
): string | null {
  if (!role || extinguished.length === 0) return null;
  const names = grantNames(extinguished);
  return extinguished.length === 1
    ? `${names} роли «${roleLabels[role]}» не действует; назначение остаётся — снять его можно в реестре выдач`
    : `${names} роли «${roleLabels[role]}» не действуют; назначения остаются — снять их можно в реестре выдач`;
}

/**
 * Справка под полем: что учётке ещё выдано, но этой ролью не действует.
 *
 * Показывается всегда, а не только сразу после смены роли: сообщение человек закроет, а вопрос
 * «почему в списке нет набора, который я точно выдавал» остаётся — и ответ на него должен быть на
 * экране в момент, когда его задают.
 */
export function outOfRangeHintText(grants: readonly UserGrantRefDto[]): string | null {
  if (grants.length === 0) return null;
  return `Ещё выдано, но этой роли не действует: ${grantNames(grants)} — снять можно в реестре выдач`;
}

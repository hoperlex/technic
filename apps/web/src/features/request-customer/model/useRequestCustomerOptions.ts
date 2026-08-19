import { useQuery } from '@tanstack/react-query';
import { costTargetKey, type CostTargetKey, type CostTargetRef } from '@technic/contracts';
import { departmentOptionsQuery } from '@entities/department';
import { objectOptionsQuery } from '@entities/object';
import { flattenOptions, soleOption, withSavedOption } from '@shared/lib';
import { useDepartmentScope } from '../../../hooks/useDepartmentScope';
import { useObjectScope } from '../../../hooks/useObjectScope';

/**
 * Подбор заказчика «Объект/отдел»: одно поле с составным ключом (план
 * `docs/department-requests-plan.md`, Р2 и Р3).
 *
 * Хук отвечает сразу на всё, что о поле спрашивают форма и фильтр: какие группы показать, заперто
 * ли поле, какой вариант единственный и что стояло у записи. Разложенные по местам, эти четыре
 * ответа разъезжались бы: запертость считается по обеим группам сразу, а сохранённое значение
 * обязано попадать в свою — по отдельности их считает каждый экран по-своему.
 */

/** Группа «Объекты» заказа ТС: площадки, на которые заказывают технику. */
export const OBJECTS_GROUP_LABEL = 'Объекты';
/** Группа «Отделы»: подразделения, от лица которых заводят заявку (ADR 0040). */
export const DEPARTMENTS_GROUP_LABEL = 'Отделы';
/**
 * Группа площадки в оргтехнике (Р11): пункт в ней ровно один — объект выбранной единицы. Своё имя,
 * а не «Объекты», потому что выбора среди площадок там нет вовсе: техника стоит там, где стоит.
 */
export const SITE_GROUP_LABEL = 'Площадка';

/**
 * Опция подбора. Род и идентификатор лежат в ней **данными** (Р2а): тело запроса собирается из
 * них, а не разбором ключа на каждом сабмите. Ключ — то же самое, свёрнутое в значение поля,
 * потому что значением у antd бывает только строка.
 *
 * Псевдонимом, а не интерфейсом: утилиты `@shared/lib` принимают «любой список antd»
 * (`OptionLike` с индексной сигнатурой), а интерфейс к такому типу не приводится.
 */
export type RequestCustomerOption = {
  value: CostTargetKey;
  label: string;
  target: CostTargetRef;
};

/** Группа выпадающего списка в том виде, в каком её принимает antd. */
export type RequestCustomerGroup = { label: string; options: RequestCustomerOption[] };

/**
 * Площадка, пришедшая снаружи (Р11): объект выбранной единицы оргтехники. Не из справочника,
 * потому что это не выбор — это снимок того, где аппарат стоит, и меняется он сменой единицы
 * (Р11а), а не открытием списка.
 *
 * Положена ли площадка этой учётке, решает потребитель: роли отдела она доступна только по своей
 * технике (Р12), а знание о том, чья это техника, есть у формы — здесь его неоткуда взять.
 * Не положена — приходит `null`, и группы нет.
 */
export type RequestCustomerSite = { id: string; label: string };

/**
 * Заказчик, уже стоящий у записи (К7): ссылка и подпись **из снимка заявки**, а не из
 * действующего справочника. Причин выпасть две — справочник (объект закрыт, отдел расформирован) и
 * сам состав поля (у видимой по сквозной области заявки заказчик бывает чужим, Р11б), — и обе
 * означают одно: обязательное поле не имеет права начинать правку пустым.
 */
export type RequestCustomerSaved = { target: CostTargetRef; label: string };

export interface RequestCustomerInput {
  /**
   * Откуда берутся объекты: `'scope'` — справочник по оси учётки (заказ ТС, Р3); готовая площадка —
   * объект выбранной единицы (оргтехника, Р11); `null` — единицу ещё не выбрали, площадки нет.
   */
  objects?: 'scope' | RequestCustomerSite | null;
  /**
   * Какие отделы предлагать:
   *
   * - `'scope'` — по оси учётки (заказ ТС, Р3): свои — отдельской роли, все действующие — учётке
   *   без оси, ни одного — объектной;
   * - `'requester'` — «от чьего имени просят» (оргтехника, Р11б): отдельской роли свои, всем
   *   прочим — все действующие. Осью это не является, поэтому объектная роль отделы здесь видит;
   * - `'none'` — группы нет вовсе (спецтехника, Р4).
   */
  departments?: 'scope' | 'requester' | 'none';
  /** Заказчик правимой записи — К7. */
  saved?: RequestCustomerSaved | null;
}

/** Пара колонок заказчика для тела запроса: заполнена ровно одна — так же, как в базе (CHECK). */
export interface RequestCustomerPair {
  objectId: string | null;
  departmentId: string | null;
}

export interface RequestCustomerOptions {
  options: RequestCustomerGroup[];
  /**
   * Единственный доступный вариант обеих групп — его форма ставит сама (Р3а, К6): `AutoSelect` в
   * заблокированном поле не подставляет ничего, а заперто оно как раз тогда, когда вариант один.
   */
  soleCustomerKey: CostTargetKey | null;
  /**
   * Выбирать не из чего: вариантов не больше одного — по обеим группам сразу, а не по одной оси.
   * Пока справочник грузится, их ноль, и поле заперто: списка ещё нет, а выбор из ничего — не
   * выбор.
   */
  disabled: boolean;
  loading: boolean;
  /**
   * Пара `{ objectId, departmentId }` по значению поля. Род и идентификатор берутся из опции
   * (Р2а), а значение вне состава поля наружу не уходит вовсе: иначе портал отправил бы
   * заказчика, которого сам же не предлагал, — например отдел у переоформленной спецтехники (К8).
   */
  customerPairOf: (value: string | null | undefined) => RequestCustomerPair;
}

function leafOf(target: CostTargetRef, label: string): RequestCustomerOption {
  return { value: costTargetKey(target), label, target };
}

/**
 * Дописывает к группе сохранённое значение её рода. Общая `withSavedOption` держит правило «не
 * дублировать то, что в списке уже есть»; чего она не знает — что род опции нужен потребителю
 * данными, поэтому добавленному варианту ссылка возвращается здесь.
 */
function withSavedLeaf(
  kind: CostTargetRef['kind'],
  leaves: RequestCustomerOption[],
  saved: RequestCustomerSaved | null | undefined,
): RequestCustomerOption[] {
  if (!saved || saved.target.kind !== kind) return leaves;
  const target = saved.target;
  const key = costTargetKey(target);
  return withSavedOption(leaves, { id: key, name: saved.label }).map((o) =>
    'target' in o ? o : { value: key, label: o.label, target },
  );
}

export function useRequestCustomerOptions({
  objects = 'scope',
  departments = 'scope',
  saved = null,
}: RequestCustomerInput = {}): RequestCustomerOptions {
  const { isObjectRole, limitObjectOptions } = useObjectScope();
  const { isDepartmentRole, limitDepartmentOptions } = useDepartmentScope();

  // Оси спрашиваются готовыми хуками (ADR 0039, ADR 0040), а не по имени роли: предикат один на
  // портал, и вторая его копия здесь открыла бы чужую площадку молча — фильтром, а не отказом.
  const wantObjects = objects === 'scope' && !isDepartmentRole;
  const wantDepartments = departments !== 'none' && !(departments === 'scope' && isObjectRole);

  const objectsQuery = useQuery({ ...objectOptionsQuery(), enabled: wantObjects });
  const departmentsQuery = useQuery({ ...departmentOptionsQuery(), enabled: wantDepartments });

  // Те же два признака применяются и к данным, а не только к `enabled`: выключенный запрос всё
  // равно отдаёт то, что уже лежит в кэше от соседнего экрана, — и справочник, которого учётке
  // видеть не положено, вошёл бы в список сам собой.
  const scopeObjects = wantObjects ? limitObjectOptions(objectsQuery.data ?? []) : [];
  const objectLeaves =
    objects === 'scope'
      ? scopeObjects.map((o) => leafOf({ kind: 'object', id: o.value }, o.label))
      : objects
        ? [leafOf({ kind: 'object', id: objects.id }, objects.label)]
        : [];
  const departmentLeaves = wantDepartments
    ? limitDepartmentOptions(departmentsQuery.data ?? []).map((d) =>
        leafOf({ kind: 'department', id: d.value }, d.label),
      )
    : [];

  /*
   * Сохранённый вариант держится в списке (К7) — но только тогда, когда его род вообще входит в
   * состав поля (К8). Спецтехника отделов не знает вовсе (Р4): прежний отдел переоформляемой
   * заявки вернул бы группу «Отделы», которую сам же тип заявки и отменил, — а выбранный там
   * снова, он ушёл бы пустой парой (`customerPairOf`), и заявка отправилась бы без заказчика
   * вовсе. Правило принадлежит подбору, а не форме: иначе каждый потребитель вспоминал бы его
   * заново, а второй (оргтехника) наступил бы на то же место.
   *
   * Ось учётки под это правило не подходит и подойти не может: она сужает справочник, а не
   * отменяет род. Заказчик видимой заявки бывает вне области того, кто её правит (Р11б), и ровно
   * ради него К7 и заведён — там сохранённый вариант остаётся в списке.
   */
  const savedInComposition =
    saved && !(saved.target.kind === 'department' && departments === 'none') ? saved : null;

  const objectGroup = withSavedLeaf('object', objectLeaves, savedInComposition);
  const departmentGroup = withSavedLeaf('department', departmentLeaves, savedInComposition);

  // Пустая группа не показывается: заголовок без единого пункта читается как «здесь пусто, но
  // должно быть», а «отделов у этой учётки нет вовсе» — не пропажа, а правило (Р3).
  const groups: RequestCustomerGroup[] = [];
  if (objectGroup.length) {
    groups.push({
      label: objects === 'scope' ? OBJECTS_GROUP_LABEL : SITE_GROUP_LABEL,
      options: objectGroup,
    });
  }
  if (departmentGroup.length) {
    groups.push({ label: DEPARTMENTS_GROUP_LABEL, options: departmentGroup });
  }

  // Раскрытие групп и «единственный вариант» — общими утилитами: ими же считает подстановку
  // `AutoSelect`, и своё правило рядом отвечало бы на тот же вопрос иначе. Приведение типа — цена
  // того, что утилиты описывают любой список antd и о роде заказчика не знают.
  const leaves = flattenOptions(groups) as RequestCustomerOption[];
  const sole = soleOption(groups) as RequestCustomerOption | undefined;

  return {
    options: groups,
    soleCustomerKey: sole?.value ?? null,
    disabled: leaves.length <= 1,
    loading: objectsQuery.isFetching || departmentsQuery.isFetching,
    customerPairOf: (value) => {
      const picked = value ? leaves.find((o) => o.value === value) : undefined;
      return {
        objectId: picked?.target.kind === 'object' ? picked.target.id : null,
        departmentId: picked?.target.kind === 'department' ? picked.target.id : null,
      };
    },
  };
}

import { useEffect, useRef, type ReactNode } from 'react';
import { Checkbox, Tooltip, type TableColumnsType } from 'antd';
import { NO_ROW_CLICK } from './columns';

/**
 * Выбор строк списка: контракт, колонка с чекбоксами и правила, общие для всего портала.
 *
 * Отдельным модулем, а не внутри `DataTable`: правил у выбора три — гашение при смене отбора,
 * потолок пачки и объяснённый отказ, — и вперемешку с разметкой таблицы они не читаются. Списков,
 * которые ими пользуются, больше одного (печать путевых листов, массовые действия заявок), а
 * правило, переписанное на второй странице своими словами, разъезжается с первым.
 */

/**
 * Выбор строк для действия над несколькими сразу (печать пачки путевых листов).
 *
 * Колонка выбора встаёт последней перед «Действиями» и закрепляется вместе с ней: список широкий,
 * и чекбокс, уехавший за правый край, пришлось бы искать прокруткой. Слева, где его рисует antd
 * своим `rowSelection`, он оказался бы у номера записи — то есть у самой читаемой колонки, ради
 * которой список и открывают.
 *
 * Что делать с выбранным, решает страница: сюда приходит готовая полоса (`bar`), и показывается
 * она на уровне управления страницами — выбор относится ко всему списку, а не к одной строке.
 */
export interface SelectionConfig<T> {
  /** Ключи выбранных строк. Живут у страницы: смена фильтра или страницы их сбрасывает. */
  keys: string[];
  onChange: (keys: string[]) => void;
  /**
   * Отпечаток того, что сейчас на экране: страница, размер страницы, сортировка, фильтры, поиск,
   * пресет — одной нормализованной строкой (`listScopeKey`). Ключ сменился — выбор погашен.
   *
   * Правило общее и живёт здесь, а не на странице: «отобрал срочные, выбрал десять, сменил отбор
   * на свою площадку и нажал „Отменить“» стоит чужой работы, а список, помнящий это правило у
   * себя, рано или поздно его забудет — и заметно это станет уже после нажатия. Накопление выбора
   * через страницы при этом теряется, и это осознанная плата: «выбрал на трёх страницах» не
   * просил никто.
   *
   * Поле необязательное: списки, которые ключа не передают, ведут себя как раньше — выбор живёт,
   * пока его не снимут сами.
   */
  scopeKey?: string;
  /**
   * Потолок выбора: столько строк уходит в одно действие. Упор в потолок не обрезает выбор молча —
   * лишние чекбоксы выключаются и объясняют себя подсказкой, а уже выбранное остаётся как было.
   * Тихое обрезание означало бы, что человек нажал кнопку над одним набором, а уехал другой.
   */
  maxSelected?: number;
  /**
   * Почему строку выбрать нельзя; `null` — можно. Текст идёт подсказкой к выключенному чекбоксу:
   * запрет без объяснения читается как поломка.
   */
  disabled?: (record: T) => string | null;
  /** Полоса действий над выбранным: показывается, только когда выбрана хотя бы одна строка. */
  bar: (keys: string[]) => ReactNode;
}

/**
 * Нормализованный отпечаток отбора для `scopeKey`: ключи по алфавиту, пустые значения выброшены.
 *
 * Нормализация здесь не украшение. `{ page: 1, status: undefined }` и `{ status: '', page: 1 }` —
 * один и тот же экран, но разные строки при наивной сериализации, и выбор гас бы на ровном месте:
 * порядок ключей в объекте параметров меняется от того, каким `setParams` его собрали последним.
 */
export function listScopeKey(query: Record<string, unknown>): string {
  const entries = Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

/** Отказ по потолку объясняется всегда: выключенный чекбокс без причины читается как поломка. */
const overLimit = (max: number) => `Лимит ${max}; снимите часть строк`;

/** Выключенный чекбокс подсказку не показывает сам — её держит обёртка. */
function withReason(box: ReactNode, reason: string | null): ReactNode {
  return reason ? (
    <Tooltip title={reason}>
      <span>{box}</span>
    </Tooltip>
  ) : (
    box
  );
}

/**
 * Выбор, привязанный к тому, что видно: смена `scopeKey` его гасит.
 *
 * Гашение двойное, и это не перестраховка. В том же рендере выбор считается пустым — иначе полоса
 * успела бы сказать «Выбрано 3» про строки другого отбора, а галочки встали бы у чужих строк с
 * теми же ключами. Эффект после коммита говорит о том же странице: состояние выбора живёт у неё,
 * и не сказав ей, портал отправил бы в действие ключи, которых на экране уже нет.
 *
 * Пустой выбор странице не сообщается: `onChange([])` на каждое листание означал бы лишнюю
 * перерисовку списка там, где сбрасывать нечего.
 */
export function useScopedSelection<T>(
  selection: SelectionConfig<T> | undefined,
): SelectionConfig<T> | undefined {
  const scopeKey = selection?.scopeKey;
  const keys = selection?.keys;
  const onChange = selection?.onChange;
  /**
   * Отбор, при котором набирали выбор. Ref, а не состояние: смена ключа и так пришла с рендером
   * страницы, и лишний рендер списка ради самого факта смены никому ничего не показал бы.
   */
  const scope = useRef(scopeKey);
  const stale = scopeKey !== undefined && scope.current !== scopeKey;

  useEffect(() => {
    if (scopeKey === undefined || scope.current === scopeKey) return;
    scope.current = scopeKey;
    if (keys && keys.length > 0) onChange?.([]);
  }, [scopeKey, keys, onChange]);

  if (!selection) return undefined;
  return stale ? { ...selection, keys: [] } : selection;
}

/**
 * Колонка выбора — последней перед «Действиями» и закреплённой так же, как она.
 *
 * Заголовок выбирает всю страницу разом: пачку печатают целыми днями, и щёлкать по полусотне
 * чекбоксов ради «всех» никто не станет. «Всё» здесь — это загруженная страница, а не весь
 * список: сервер отдал ровно её, и отвечать за строки, которых на экране нет, портал не может.
 */
export function withSelectionColumn<T extends object>(
  columns: TableColumnsType<T>,
  selection: SelectionConfig<T>,
  data: T[],
  rowKey: string,
): TableColumnsType<T> {
  const keyOf = (record: T): string => String((record as Record<string, unknown>)[rowKey]);
  const selectable = data.filter((record) => !selection.disabled?.(record));
  const selected = new Set(selection.keys);
  const onPage = selectable.filter((record) => selected.has(keyOf(record))).length;
  const pageKeys = selectable.map(keyOf);
  const allOnPage = selectable.length > 0 && onPage === selectable.length;

  const max = selection.maxSelected;
  /** Ещё не выбранная строка сверх потолка не берётся: набор остаётся тем, что человек составил. */
  const rowLimit = max !== undefined && selection.keys.length >= max ? overLimit(max) : null;
  /**
   * «Вся страница» — движение всё-или-ничего. Взять из неё столько, сколько влезло в потолок,
   * значило бы отдать в действие набор, которого никто не составлял: строки для него выбрал бы
   * порядок сортировки. Поэтому страница, не помещающаяся в потолок целиком, не отмечается вовсе,
   * и сказано об этом до нажатия, а не после.
   */
  const wholePage = new Set([...selection.keys, ...pageKeys]).size;
  const pageLimit =
    max !== undefined && !allOnPage && wholePage > max
      ? `Лимит ${max}; на странице ${selectable.length} — отметьте нужные строки или уменьшите размер страницы`
      : null;

  const toggle = (record: T, checked: boolean) => {
    const key = keyOf(record);
    // Страховка к выключенному чекбоксу: снять выбор можно всегда, добавить сверх потолка — нет.
    if (checked && rowLimit) return;
    selection.onChange(
      checked ? [...selection.keys, key] : selection.keys.filter((k) => k !== key),
    );
  };

  const head = (
    <Checkbox
      aria-label="Выбрать всё на странице"
      checked={allOnPage}
      indeterminate={onPage > 0 && !allOnPage}
      disabled={selectable.length === 0 || !!pageLimit}
      onChange={(e) => {
        if (e.target.checked && pageLimit) return;
        selection.onChange(
          e.target.checked
            ? [...new Set([...selection.keys, ...pageKeys])]
            : selection.keys.filter((k) => !pageKeys.includes(k)),
        );
      }}
    />
  );

  const column: TableColumnsType<T>[number] = {
    key: 'select',
    fixed: 'right',
    width: 48,
    // Колонка отдана нажатиям целиком: клик по ней не должен заодно открывать карточку записи.
    onCell: () => ({ className: NO_ROW_CLICK }),
    title: withReason(head, pageLimit),
    render: (_value: unknown, record: T) => {
      const checked = selected.has(keyOf(record));
      /*
       * Причин запрета две, и порядок их не случаен: доменная («аннулированный лист не печатают»)
       * сильнее потолка и не исчезает, когда часть строк снимут. Потолок же касается только строк,
       * которых в наборе ещё нет: снять выбор можно всегда, иначе из упора не выбраться.
       */
      const reason = selection.disabled?.(record) ?? (checked ? null : rowLimit);
      return withReason(
        <Checkbox
          checked={checked}
          disabled={!!reason}
          onChange={(e) => toggle(record, e.target.checked)}
        />,
        reason,
      );
    },
  };

  const actionsAt = columns.findIndex((c) => c.key === 'actions');
  if (actionsAt < 0) return [...columns, column];
  return [...columns.slice(0, actionsAt), column, ...columns.slice(actionsAt)];
}

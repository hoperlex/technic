import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Checkbox, Empty, Input, Spin, Typography } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { FormModal } from './FormModal';

/**
 * Окно выбора списком чекбоксов: поиск, строка «выбрать все», счётчик отмеченного.
 *
 * Заведено потому, что готового такого в портале нет: `DataTable` умеет выбор строк, но только на
 * текущей странице, а `Select mode="multiple"` показывает отмеченное лентой тегов — набор из
 * десятков строк в ней не читается, пояснение к строке не помещается вовсе, а недоступную строку
 * там нельзя показать вместе с причиной.
 *
 * Оболочка — `FormModal`: на телефоне то же окно открывается снизу во весь экран (ADR 0030).
 * Своего определения мобильного здесь нет намеренно — двух ответов на вопрос «узкий ли экран» в
 * портале быть не должно.
 */

export interface CheckboxPickerItem {
  value: string;
  label: string;
  /** Пояснение к строке: чем она отличается от соседних (роль, область, счётчик). */
  hint?: string;
  /**
   * Строку нельзя отметить, и вот почему. Не то же самое, что её отсутствие: неподтверждённый
   * адрес виден в форме вместе с причиной, а молча пропавшая строка читается как сбой списка.
   */
  disabledReason?: string;
}

/**
 * Как задан набор: «все и будущие» или перечень. Тот же союз, что `AudienceMode` в контрактах, но
 * объявленный здесь: нижний слой правил портала не знает (см. `no-restricted-imports` для
 * `shared`), а перечислять два слова заново дешевле, чем протаскивать домен в фундамент.
 */
export type CheckboxPickerMode = 'all' | 'selected';

export interface CheckboxPickerValue {
  mode: CheckboxPickerMode;
  ids: string[];
}

interface Props {
  title: ReactNode;
  open: boolean;
  items: CheckboxPickerItem[];
  value: CheckboxPickerValue;
  loading?: boolean;
  /**
   * Бывает ли у набора режим «все и будущие». У закрытого реестра его нет: он меняется миграцией,
   * а не работой пользователей, и «все» в нём — это просто все отмеченные строки.
   */
  allowAll?: boolean;
  /** Подпись строки-переключателя; у режима «все» она обещает и будущие записи. */
  allLabel?: string;
  /** Чем подписать сохранённое значение, которого в списке больше нет. */
  missingLabel?: string;
  emptyText?: ReactNode;
  /**
   * Необязательный переключатель «показывать только подходящие»: сворачивает список до строк,
   * которые проходят проверку. Именно вид, а не ограничение выбора — отметки скрытых строк
   * сохраняются, «выбрать все» по-прежнему означает все, и на счётчик отмеченного он не влияет.
   */
  filterToggle?: { label: string; predicate: (item: CheckboxPickerItem) => boolean };
  onCancel: () => void;
  onSubmit: (value: CheckboxPickerValue) => void;
}

export function CheckboxPicker({
  title,
  open,
  items,
  value,
  loading,
  allowAll = true,
  allLabel = 'Выбрать все (и тех, кто появится позже)',
  missingLabel = 'Значение вне справочника',
  emptyText = 'Список пуст',
  filterToggle,
  onCancel,
  onSubmit,
}: Props) {
  /**
   * Черновик, а не правка на лету: наполовину отмеченный список не должен уезжать в форму —
   * закрытое крестиком окно оставило бы расписание с набором, которого никто не выбирал.
   */
  const [all, setAll] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [onlyMatching, setOnlyMatching] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSearch('');
    setOnlyMatching(false);
    setAll(allowAll && value.mode === 'all');
    setIds(value.ids);
    // Черновик берётся ровно в момент открытия: следи он за `value`, набор перескакивал бы под
    // рукой у того, кто его правит.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /**
   * Сохранённые значения, которых в списке нет: запись могли закрыть, отправить в архив или она
   * не попала в выборку. Без своей строки они не видны вовсе, а «Готово» молча унесло бы их из
   * набора — рассылка перестала бы касаться площадки, которую никто не снимал.
   */
  const rows: CheckboxPickerItem[] = useMemo(() => {
    const known = new Set(items.map((i) => i.value));
    const missing = value.ids.filter((id) => !known.has(id));
    return [...items, ...missing.map((id) => ({ value: id, label: missingLabel }))];
  }, [items, value.ids, missingLabel]);

  const selectable = rows.filter((r) => !r.disabledReason);
  const checkedIds = all ? selectable.map((r) => r.value) : ids;
  const checked = new Set(checkedIds);
  const everyChecked = selectable.length > 0 && selectable.every((r) => checked.has(r.value));

  // Оба сужения — только вид: отметки скрытых строк остаются в черновике, а «выбрать все» и
  // счётчик считаются по всему списку. Иначе поиск молча снимал бы отмеченное вне вида.
  const query = search.trim().toLowerCase();
  const shown = rows.filter(
    (r) =>
      (!query || r.label.toLowerCase().includes(query)) &&
      (!onlyMatching || !filterToggle || filterToggle.predicate(r)),
  );

  const toggle = (row: { value: string }) => {
    // Снятая строка выключает и режим «все»: набор с этого мгновения — перечень, и хранить его
    // надо перечнем, иначе снятое вернулось бы при следующем открытии.
    const next = checked.has(row.value)
      ? checkedIds.filter((id) => id !== row.value)
      : [...checkedIds, row.value];
    setAll(false);
    setIds(next);
  };

  const toggleAll = () => {
    if (all || everyChecked) {
      setAll(false);
      setIds([]);
      return;
    }
    setAll(allowAll);
    setIds(allowAll ? [] : selectable.map((r) => r.value));
  };

  const submit = () =>
    onSubmit(
      allowAll && (all || everyChecked)
        ? { mode: 'all', ids: [] }
        : { mode: 'selected', ids: checkedIds },
    );

  return (
    <FormModal
      title={title}
      open={open}
      onCancel={onCancel}
      onSubmit={submit}
      okText="Готово"
      width={520}
      footerExtra={
        <Typography.Text type="secondary">
          Отмечено {checkedIds.length} из {rows.length}
        </Typography.Text>
      }
    >
      <Input
        allowClear
        prefix={<SearchOutlined />}
        placeholder="Поиск"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ marginBottom: 12 }}
      />

      <div
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
      >
        <Checkbox
          checked={all || everyChecked}
          indeterminate={!(all || everyChecked) && checkedIds.length > 0}
          onChange={toggleAll}
        >
          {allowAll ? allLabel : 'Выбрать все'}
        </Checkbox>
        {filterToggle ? (
          <Checkbox
            checked={onlyMatching}
            onChange={(e) => setOnlyMatching(e.target.checked)}
          >
            {filterToggle.label}
          </Checkbox>
        ) : null}
      </div>

      <div style={{ maxHeight: 360, overflowY: 'auto', marginTop: 8 }}>
        {loading && rows.length === 0 ? (
          <Spin style={{ display: 'block', margin: '24px auto' }} />
        ) : shown.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={query ? 'Ничего не найдено' : emptyText}
          />
        ) : (
          shown.map((row) => (
            <div key={row.value} style={{ padding: '3px 0' }}>
              <Checkbox
                checked={checked.has(row.value)}
                disabled={!!row.disabledReason}
                onChange={() => toggle(row)}
              >
                {row.label}
                {row.hint ? (
                  <Typography.Text type="secondary"> · {row.hint}</Typography.Text>
                ) : null}
                {row.disabledReason ? (
                  <Typography.Text type="warning"> · {row.disabledReason}</Typography.Text>
                ) : null}
              </Checkbox>
            </div>
          ))
        )}
      </div>
    </FormModal>
  );
}

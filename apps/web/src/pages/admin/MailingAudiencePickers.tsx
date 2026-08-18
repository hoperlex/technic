import { useState } from 'react';
import { Button, Modal } from 'antd';
import { type Permission } from '@technic/contracts';
import { CheckboxPicker, type CheckboxPickerItem, type CheckboxPickerValue } from '@shared/ui';
import { GrantPermissionPicker } from './GrantPermissionPicker';
import { PERMISSION_MODULE_GROUPS, permissionLabel } from './grantModel';

/**
 * Поля аудитории, которые открывают окно выбора: набор задаётся не строкой, а кнопкой с объёмом.
 *
 * Отдельно от самой формы, потому что решают другую задачу: форма отвечает, из чего складывается
 * адресация, а эти поля — как выбрать сотню значений так, чтобы выбранное осталось читаемым. Оттого
 * у них своя механика — черновик, применяемый по «Готово», подпись объёма вместо ленты тегов и
 * состояние «все и будущие», которого перечнем не выразить. В форме это выглядело бы вёрсткой
 * посреди правил отбора, а правила там и есть главное.
 */

interface PickerFieldProps {
  /** Приходит от `Form.Item`: им подпись поля связана с кнопкой, открывающей окно. */
  id?: string;
  title: string;
  items: CheckboxPickerItem[];
  loading?: boolean;
  allowAll?: boolean;
  missingLabel?: string;
  emptyText?: string;
  filterToggle?: { label: string; predicate: (item: CheckboxPickerItem) => boolean };
  /** Что написано на кнопке: объём набора словами. Читается вместо перечня — перечень в окне. */
  summary: string;
  value?: CheckboxPickerValue;
  onChange?: (value: CheckboxPickerValue) => void;
}

/**
 * Поле-кнопка: показывает объём набора и открывает окно выбора. Кнопка, а не `Select`, потому что
 * набор бывает и «все, включая будущих» — состояние, которого лентой отмеченных тегов не выразить.
 */
export function PickerField({ id, title, summary, value, onChange, ...picker }: PickerFieldProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button id={id} block style={{ textAlign: 'left' }} onClick={() => setOpen(true)}>
        {summary}
      </Button>
      <CheckboxPicker
        {...picker}
        title={title}
        open={open}
        value={value ?? { mode: 'all', ids: [] }}
        onCancel={() => setOpen(false)}
        onSubmit={(next) => {
          onChange?.(next);
          setOpen(false);
        }}
      />
    </>
  );
}

/** Подпись набора прав: первые два по имени, остальные числом — в строку кнопки больше не влезает. */
function permissionsSummary(permissions: Permission[]): string {
  if (permissions.length === 0) return 'Права не выбраны';
  const named = permissions.slice(0, 2).map(permissionLabel);
  const rest = permissions.length - named.length;
  return `${named.join('; ')}${rest > 0 ? ` и ещё ${rest}` : ''}`;
}

/**
 * Окно выбора прав-адресатов. Своё, а не `CheckboxPicker`, потому что плоским списком полсотни прав
 * не выбрать: нужны группировка по модулям и поиск — то самое, что уже умеет конструктор наборов.
 */
export function PermissionPickerField({
  id,
  value,
  onChange,
}: {
  /** Приходит от `Form.Item`: им подпись поля связана с кнопкой, открывающей окно. */
  id?: string;
  value?: Permission[];
  onChange?: (next: Permission[]) => void;
}) {
  const [open, setOpen] = useState(false);
  // Черновик: правка внутри окна применяется по «Готово», как и в остальных окнах формы, — иначе
  // «Отмена» не отменяла бы ничего.
  const [draft, setDraft] = useState<Permission[]>([]);
  const current = value ?? [];
  return (
    <>
      <Button
        id={id}
        block
        style={{ textAlign: 'left' }}
        onClick={() => {
          setDraft(current);
          setOpen(true);
        }}
      >
        {permissionsSummary(current)}
      </Button>
      <Modal
        title="Права-адресаты"
        open={open}
        okText="Готово"
        cancelText="Отмена"
        onCancel={() => setOpen(false)}
        onOk={() => {
          onChange?.(draft);
          setOpen(false);
        }}
      >
        <GrantPermissionPicker
          groups={PERMISSION_MODULE_GROUPS}
          value={draft}
          onChange={(next) => setDraft(next)}
        />
      </Modal>
    </>
  );
}

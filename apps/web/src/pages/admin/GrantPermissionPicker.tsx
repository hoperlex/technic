import { useMemo, useState } from 'react';
import { Checkbox, Empty, Input, Space, Tag, Typography } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import type { Permission } from '@technic/contracts';
import { GRANT_MODULE_GROUPS, type GrantModuleGroup, permissionLabel } from './grantModel';

/**
 * Средняя часть конструктора (план §12): права чекбоксами, сгруппированные по модулям, с
 * подписями-глаголами из каталога.
 *
 * Невыдаваемых прав в списке по умолчанию нет вовсе — их отсеивает `GRANT_MODULE_GROUPS`, и второй
 * отбор здесь не нужен. Поиск по списку заведён не для красоты: выдаваемых прав больше пятидесяти в
 * пятнадцати модулях, и «право визы объекта» ищут словом, а не прокруткой.
 *
 * Тот же компонент выбирает адресатов рассылки (ADR 0111) — со своим списком (`groups`), потому что
 * там спрашивают не «что выдать», а «у кого это есть», и невыдаваемые права из вопроса не выпадают.
 * Второй такой список решал бы уже решённое: словарь прав велик, и плоский перечень чекбоксов по
 * нему непригоден одинаково в обеих задачах.
 */

interface Props {
  value: Permission[];
  onChange: (next: Permission[]) => void;
  /**
   * Только показать состав, без выбора. Так открывается системный набор: править его нельзя
   * (решение 2), и выключенные галочки обещали бы выбор, которого не будет, — состав показывается
   * перечнем.
   */
  readOnly?: boolean;
  /** Что показывать; по умолчанию — выдаваемые права конструктора наборов. */
  groups?: GrantModuleGroup[];
}

export function GrantPermissionPicker({
  value,
  onChange,
  readOnly,
  groups: source = GRANT_MODULE_GROUPS,
}: Props) {
  const [search, setSearch] = useState('');
  const selected = useMemo(() => new Set(value), [value]);

  /** Отбор по подписи и по коду: в документации и в коде право зовут кодом, а не глаголом. */
  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return source
      .map((group) => ({
        ...group,
        // В режиме просмотра список сворачивается до состава: пустой модуль набора показывать нечем.
        permissions: group.permissions.filter(
          (permission) =>
            (!readOnly || selected.has(permission)) &&
            (!needle ||
              permissionLabel(permission).toLowerCase().includes(needle) ||
              permission.toLowerCase().includes(needle)),
        ),
      }))
      .filter((group) => group.permissions.length > 0);
  }, [source, search, readOnly, selected]);

  const toggle = (permission: Permission, checked: boolean) =>
    onChange(checked ? [...value, permission] : value.filter((current) => current !== permission));

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {!readOnly && (
        <Input
          allowClear
          prefix={<SearchOutlined />}
          aria-label="Поиск права"
          placeholder="Подпись или код права"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}
      {groups.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={readOnly ? 'В наборе нет ни одного права' : 'Ни одно право не подошло'}
        />
      ) : (
        groups.map((group) => {
          const checkedCount = group.permissions.filter((permission) =>
            selected.has(permission),
          ).length;
          return (
            <div key={group.module}>
              <Space size={6}>
                <Typography.Text strong>{group.label}</Typography.Text>
                {/* Счётчик отмеченного в модуле: по нему видно, где набор уже что-то открывает. */}
                {checkedCount > 0 && <Tag color="blue">{checkedCount}</Tag>}
              </Space>
              <Space direction="vertical" size={2} style={{ width: '100%', marginTop: 4 }}>
                {group.permissions.map((permission) =>
                  readOnly ? (
                    <Typography.Text key={permission}>
                      {permissionLabel(permission)}
                    </Typography.Text>
                  ) : (
                    <Checkbox
                      key={permission}
                      checked={selected.has(permission)}
                      onChange={(e) => toggle(permission, e.target.checked)}
                    >
                      {permissionLabel(permission)}
                    </Checkbox>
                  ),
                )}
              </Space>
            </div>
          );
        })
      )}
    </Space>
  );
}

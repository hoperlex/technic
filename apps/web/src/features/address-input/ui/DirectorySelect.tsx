import { useState } from 'react';
import { Select } from 'antd';
import type { DirectoryGroup, DirectoryOption } from '../model/useDirectoryOptions';

interface Props {
  /** Выбранная запись справочника; `undefined` — не выбрана. */
  selectedId?: string;
  /** Строка адреса в поле — ею подписывается запись, которой в списке уже нет. */
  address?: string;
  groups: DirectoryGroup[];
  loading: boolean;
  disabled?: boolean;
  onPick: (option: DirectoryOption) => void;
  onSearch: (text: string) => void;
}

const PICKED_EARLIER_LABEL = 'Выбрано ранее';

/**
 * Выбор места из справочника: объекты и склады поставщиков одним списком (ADR 0069).
 *
 * Поиск идёт по подписи, а в ней и наименование, и адрес, — поэтому набор находит запись обоими
 * способами, и отдельного поля поиска не нужно.
 *
 * Запись, которой в списке нет (площадку выключили после того, как заявку завели), поле показывает
 * отдельной группой с её же адресом: иначе на месте выбранного значения стоял бы идентификатор.
 */
export function DirectorySelect({
  selectedId,
  address,
  groups,
  loading,
  disabled,
  onPick,
  onSearch,
}: Props) {
  const [open, setOpen] = useState(false);

  const known = groups.some((g) => g.options.some((o) => o.value === selectedId));
  const options = [
    ...groups.map((g) => ({ label: g.label, options: g.options })),
    ...(selectedId && !known
      ? [
          {
            label: PICKED_EARLIER_LABEL,
            options: [{ value: selectedId, label: address || 'Прежний выбор' }],
          },
        ]
      : []),
  ];

  return (
    <Select
      value={selectedId}
      open={open}
      onOpenChange={(visible) => {
        setOpen(visible);
        // Закрытие списка возвращает подсказки наверх: следующее открытие — это новый вопрос
        // «куда ехать», а не продолжение прошлого поиска.
        if (!visible) onSearch('');
      }}
      onSearch={onSearch}
      onChange={(_id: string, option) => {
        const picked = (Array.isArray(option) ? option[0] : option) as DirectoryOption | undefined;
        if (picked?.address) onPick(picked);
      }}
      options={options}
      showSearch
      optionFilterProp="label"
      loading={loading}
      disabled={disabled}
      style={{ width: '100%' }}
      placeholder="Выберите объект или склад"
      notFoundContent={loading ? 'Загружаем справочник…' : 'Ничего не нашлось'}
    />
  );
}

import { useCallback, useRef, useState } from 'react';
import { AutoComplete, Input, Space, Tooltip } from 'antd';
import { CheckCircleTwoTone, WarningTwoTone } from '@ant-design/icons';
import { type AddressMeta, isAddressVerified } from '@technic/contracts';
import { type DadataSuggestion, dadataEnabled, suggestAddress } from '../api/dadata';

/** Подсказка DaData → метаданные адреса (ADR 0006). */
function toMeta(s: DadataSuggestion): AddressMeta {
  const level = s.data.fias_level != null ? Number(s.data.fias_level) : NaN;
  const lat = s.data.geo_lat != null ? Number(s.data.geo_lat) : NaN;
  const lon = s.data.geo_lon != null ? Number(s.data.geo_lon) : NaN;
  return {
    source: 'resolved',
    fiasId: s.data.fias_id ?? null,
    fiasLevel: Number.isFinite(level) ? level : null,
    geoLat: Number.isFinite(lat) ? lat : null,
    geoLon: Number.isFinite(lon) ? lon : null,
  };
}

interface AddressAutoCompleteProps {
  /** Строка адреса (значение из Form.Item). */
  value?: string;
  /** Обновление строки (передаётся Form.Item). */
  onChange?: (v: string) => void;
  /** Метаданные верификации: подсказка выбрана → resolved-meta; свободный ввод → null. */
  onMetaChange?: (meta: AddressMeta | null) => void;
  placeholder?: string;
  maxLength?: number;
}

/**
 * Поле адреса с подсказками DaData поверх AntD AutoComplete. Совместимо с ролью
 * child внутри Form.Item (принимает value/onChange). Верификация — «мягкая»:
 * meta ставится, только если введённая строка точно совпала с одной из подсказок.
 * Без токена деградирует в обычный ввод (meta всегда null → адрес «вручную»).
 */
export function AddressAutoComplete({
  value,
  onChange,
  onMetaChange,
  placeholder,
  maxLength = 1000,
}: AddressAutoCompleteProps) {
  const [options, setOptions] = useState<{ value: string; meta: AddressMeta }[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const abort = useRef<AbortController | undefined>(undefined);
  const enabled = dadataEnabled();

  const runSearch = useCallback((text: string) => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    suggestAddress(text, 8, ctrl.signal)
      .then((list) => setOptions(list.map((s) => ({ value: s.value, meta: toMeta(s) }))))
      // Сеть/лимит/CSP — тихо: поле продолжает работать как обычный ввод.
      .catch(() => undefined);
  }, []);

  const handleSearch = (text: string) => {
    if (timer.current) clearTimeout(timer.current);
    if (!text || text.trim().length < 3) {
      setOptions([]);
      return;
    }
    timer.current = setTimeout(() => runSearch(text), 250);
  };

  const handleChange = (val: string) => {
    onChange?.(val);
    const match = options.find((o) => o.value === val);
    onMetaChange?.(match ? match.meta : null);
  };

  return (
    <AutoComplete
      value={value}
      style={{ width: '100%' }}
      options={enabled ? options.map((o) => ({ value: o.value })) : []}
      onSearch={enabled ? handleSearch : undefined}
      onChange={handleChange}
      filterOption={false}
    >
      <Input maxLength={maxLength} placeholder={placeholder} />
    </AutoComplete>
  );
}

/** Ячейка таблицы: адрес + значок статуса верификации. */
export function AddressCell({ text, meta }: { text: string; meta: AddressMeta | null }) {
  if (!text) return <>—</>;
  const verified = isAddressVerified(meta);
  return (
    <Tooltip
      title={verified ? 'Адрес подтверждён (DaData / ФИАС)' : 'Введён вручную — не верифицирован'}
    >
      <Space size={4}>
        {verified ? (
          <CheckCircleTwoTone twoToneColor="#52c41a" />
        ) : (
          <WarningTwoTone twoToneColor="#faad14" />
        )}
        <span>{text}</span>
      </Space>
    </Tooltip>
  );
}

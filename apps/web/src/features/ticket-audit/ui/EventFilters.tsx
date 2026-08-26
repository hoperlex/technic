import { useEffect, useState } from 'react';
import { Button, Input, InputNumber, Select, Space } from 'antd';
import {
  WASTE_TICKET_FIELDS,
  wasteTicketFieldLabels,
  type TicketAuditEvent,
  type WasteTicketField,
} from '@technic/contracts';
import {
  NO_EVENT_FILTERS,
  hasEventFilters,
  type TicketAuditEventFilters,
} from '../model/eventFilters';
import { TICKET_AUDIT_EVENT_OPTIONS } from '../model/eventRows';

/**
 * Отбор ленты: поле, тип события, модель, версии промпта и подготовки, номер заявки (§5.3 плана).
 *
 * Полоса ничего не помнит: значения приходят из адреса и уходят в адрес. Держи она своё
 * состояние, «назад» разошлась бы с показанным на первом же переходе, а пересланная ссылка
 * открывала бы ленту с пустыми полями поверх отобранных строк.
 *
 * Пустой фильтр не сужает: «все поля» и «поле не выбрано» — одно и то же, как и на сервере.
 */
export function EventFilters({
  filters,
  onChange,
}: {
  filters: TicketAuditEventFilters;
  onChange: (filters: TicketAuditEventFilters) => void;
}) {
  const patch = (part: Partial<TicketAuditEventFilters>) => onChange({ ...filters, ...part });

  return (
    <Space size={8} wrap>
      <Select<WasteTicketField>
        aria-label="Поле бланка"
        placeholder="Все поля"
        allowClear
        style={{ width: 150 }}
        value={filters.field}
        onChange={(field) => patch({ field })}
        // Порядок бланка, а не алфавит: тот же, что в таблице сводки, — список, переставленный
        // по-своему, читался бы как другой набор полей.
        options={WASTE_TICKET_FIELDS.map((field) => ({
          value: field,
          label: wasteTicketFieldLabels[field],
        }))}
      />
      <Select<TicketAuditEvent>
        aria-label="Тип события"
        placeholder="Все события"
        allowClear
        style={{ width: 210 }}
        value={filters.event}
        onChange={(event) => patch({ event })}
        options={TICKET_AUDIT_EVENT_OPTIONS}
      />
      {/* Модель — строкой, а не списком: перечня моделей у портала нет, снимок имени приходит от
          прокси и меняется без спроса, а выдуманный список молча прятал бы когорты, которых в нём
          не оказалось. Имя берут из строки ленты или экрана когорт. */}
      <CommittedText
        label="Модель чтения"
        placeholder="Модель"
        width={220}
        maxLength={200}
        value={filters.model}
        onCommit={(model) => patch({ model })}
      />
      <CommittedNumber
        label="Версия промпта"
        placeholder="Промпт"
        value={filters.promptVersion}
        onCommit={(promptVersion) => patch({ promptVersion })}
      />
      <CommittedNumber
        label="Версия подготовки"
        placeholder="Подготовка"
        value={filters.preprocessingVersion}
        onCommit={(preprocessingVersion) => patch({ preprocessingVersion })}
      />
      <CommittedText
        label="Номер заявки"
        placeholder="№ заявки"
        width={130}
        maxLength={64}
        value={filters.requestNum}
        onCommit={(requestNum) => patch({ requestNum })}
      />
      {/* Кнопка сброса появляется, только когда есть что сбрасывать: постоянная — это кнопка, за
          которой ничего не стоит, и нажимают её на всякий случай. */}
      {hasEventFilters(filters) ? (
        <Button onClick={() => onChange(NO_EVENT_FILTERS)}>Сбросить фильтры</Button>
      ) : null}
    </Space>
  );
}

/**
 * Набранное значение уходит в адрес по Enter или уходу из поля, а не на каждой букве.
 *
 * Иначе «gemini» превращалось бы в шесть записей адреса и шесть запросов к ручке, а лента дёргалась
 * бы под руками — на первой же букве она показала бы пустоту. Очистка крестиком применяется сразу:
 * это законченное решение, а не набор.
 */
function CommittedText({
  label,
  placeholder,
  width,
  maxLength,
  value,
  onCommit,
}: {
  label: string;
  placeholder: string;
  width: number;
  maxLength: number;
  value: string | undefined;
  onCommit: (value: string | undefined) => void;
}) {
  const [draft, setDraft] = useState(value ?? '');

  // Значение из адреса главнее набранного: сюда приходят «назад», сброс фильтров и чужая ссылка,
  // и поле, оставшееся со старым текстом, врало бы о том, чем отобрана лента.
  useEffect(() => setDraft(value ?? ''), [value]);

  const commit = (next: string) => {
    const trimmed = next.trim();
    if (trimmed !== (value ?? '')) onCommit(trimmed === '' ? undefined : trimmed);
  };

  return (
    <Input
      aria-label={label}
      placeholder={placeholder}
      allowClear
      maxLength={maxLength}
      style={{ width }}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        if (e.target.value === '') commit('');
      }}
      onBlur={() => commit(draft)}
      onPressEnter={() => commit(draft)}
    />
  );
}

/** Версии — тем же правилом: «12» набирается двумя нажатиями, и лента не обязана видеть «1». */
function CommittedNumber({
  label,
  placeholder,
  value,
  onCommit,
}: {
  label: string;
  placeholder: string;
  value: number | undefined;
  onCommit: (value: number | undefined) => void;
}) {
  const [draft, setDraft] = useState<number | null>(value ?? null);

  useEffect(() => setDraft(value ?? null), [value]);

  const commit = (next: number | null) => {
    const cleaned = next === null ? undefined : Math.trunc(next);
    if (cleaned !== value) onCommit(cleaned);
  };

  return (
    <InputNumber
      aria-label={label}
      placeholder={placeholder}
      // Пределы те же, что у схемы ручки: поле, принимающее заведомо отвергаемое, обещает лишнее.
      min={0}
      max={9999}
      precision={0}
      style={{ width: 130 }}
      value={draft}
      onChange={(next) => {
        setDraft(next);
        if (next === null) commit(null);
      }}
      onBlur={() => commit(draft)}
      onPressEnter={() => commit(draft)}
    />
  );
}

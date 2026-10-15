import dayjs from 'dayjs';

/** DatePicker values use calendar dates, not the browser's ISO instant. */
export function storeFormDateFields<Values extends object>(
  values: Values,
  fields: readonly (keyof Values)[],
): Record<string, unknown> {
  const stored: Record<string, unknown> = { ...values } as Record<string, unknown>;
  for (const field of fields) {
    const value = values[field];
    if (dayjs.isDayjs(value)) stored[String(field)] = value.format('YYYY-MM-DD');
  }
  return stored;
}

export function restoreFormDateFields<Values extends object>(
  values: Record<string, unknown>,
  fields: readonly (keyof Values)[],
): Values {
  const restored = { ...values };
  for (const field of fields) {
    const value = values[String(field)];
    if (typeof value !== 'string') continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      restored[String(field)] = undefined;
      continue;
    }
    const parsed = dayjs(value);
    restored[String(field)] =
      parsed.isValid() && parsed.format('YYYY-MM-DD') === value ? parsed : undefined;
  }
  return restored as Values;
}

export function objectDraftPayload(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

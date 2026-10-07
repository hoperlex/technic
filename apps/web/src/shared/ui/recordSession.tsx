import { Alert, Button, type FormInstance } from 'antd';
import {
  useRecordSession,
  type RecordFillReason,
  type RecordSession,
  type RecordSessionOptions,
  type RecordVersion,
} from '@shared/lib';

/** What one record fills into an antd form: top-level field names to values. */
type FormFill<Values> = { [K in keyof Values]?: unknown };

export interface FormRecordSessionOptions<T, Values, V extends RecordVersion> extends Omit<
  RecordSessionOptions<T, V>,
  'fill' | 'isDirty'
> {
  /** Field values from the record — the same object for a first fill and for a refill. */
  values: (data: T) => FormFill<Values>;
  /**
   * State the window keeps outside the form fields (scan files, line rows): its own dirtiness,
   * added to the fields' one.
   */
  isDirty?: () => boolean;
  /** Fill of that outside state; runs after the fields. */
  fill?: (data: T, reason: RecordFillReason) => void;
}

/**
 * `useRecordSession` for an antd form (stage 5 plan §4.5).
 *
 * "CHANGED" IS `isFieldsTouched()`, NOT A COMPARISON OF VALUES. Touched is antd's record of the
 * person's input, kept per field: it gives at once "has the person changed anything" and the set
 * "fields the person has not touched" that a refill after an own mutation may overwrite. A
 * comparison would need a copy of the filled values and an equality per type (date fields hold
 * `dayjs` objects, equal only by reference).
 *
 * The fills take the mark back. This antd version marks a field touched on any external value
 * change too (`setFieldsValue` is its "quick access to update related status"), so without it every
 * form would count as changed right after its own fill, and the silent refresh would never happen.
 *
 * The price is conservative and accepted: a value typed and then restored still counts as changed,
 * and so does a value set by code outside the session (`AutoSelect` substituting the sole option
 * into an empty field, a default set by an effect) — the person gets the notice instead of a silent
 * refresh and loses nothing either way.
 */
export function useFormRecordSession<T, Values, V extends RecordVersion = number>(
  form: FormInstance<Values>,
  { values, isDirty, fill, ...options }: FormRecordSessionOptions<T, Values, V>,
): RecordSession<V> {
  // The field-name type of antd is a deep path union; fills use top-level names only.
  const fields = form as unknown as FormInstance;
  const put = (next: Record<string, unknown>) => {
    fields.setFieldsValue(next);
    fields.setFields(Object.keys(next).map((name) => ({ name, touched: false })));
  };
  return useRecordSession<T, V>({
    ...options,
    isDirty: () => form.isFieldsTouched() || (isDirty?.() ?? false),
    fill: (data, reason) => {
      const next = values(data) as Record<string, unknown>;
      if (reason === 'own') {
        put(
          Object.fromEntries(Object.entries(next).filter(([name]) => !fields.isFieldTouched(name))),
        );
      } else {
        // Reset first: validation marks belong to the previous fill.
        form.resetFields();
        put(next);
      }
      fill?.(data, reason);
    },
  });
}

/**
 * The notice of decision R6-a: someone else saved the record while the person was filling the
 * form. The input is not touched; "Reload" drops it and shows the fresh record — the only way the
 * input is lost, and only by the person's choice. Saving without reloading carries the old version
 * and gets the server's refusal rather than overwriting the colleague.
 */
export function StaleRecordNotice({
  session,
}: {
  session: Pick<RecordSession<RecordVersion>, 'stale' | 'reload'>;
}) {
  if (!session.stale) return null;
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 16 }}
      title="Запись изменена другим пользователем"
      description="Ваши правки ещё не сохранены. «Перечитать» покажет свежую запись — набранное здесь пропадёт."
      action={
        <Button size="small" onClick={session.reload}>
          Перечитать
        </Button>
      }
    />
  );
}

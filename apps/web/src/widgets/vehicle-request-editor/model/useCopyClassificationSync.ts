import { useEffect, useRef } from 'react';
import type { FormInstance } from 'antd';
import { classificationKeyOf } from '@entities/vehicle-type';
import type { CopySource, FormValues } from '@features/vehicle-request-editor';

interface Input {
  open: boolean;
  copy: CopySource | null;
  fresh: boolean;
  classifications: ReadonlyMap<string, unknown>;
  form: FormInstance<FormValues>;
}

/** A copied position is accepted only from a current PICK answer and while the source type remains untouched. */
export function useCopyClassificationSync({ open, copy, fresh, classifications, form }: Input) {
  const checked = useRef(false);
  const typeChanged = useRef(false);

  useEffect(() => {
    if (!open || !copy || !fresh) return;
    const firstCheck = !checked.current;
    checked.current = true;
    const key = classificationKeyOf(copy.source);
    const current = form.getFieldValue('classificationKey');
    if (current === key && !classifications.has(key)) {
      form.setFieldValue('classificationKey', '');
    } else if (
      firstCheck &&
      !typeChanged.current &&
      current === '' &&
      form.getFieldValue('requestType') === copy.source.requestType &&
      classifications.has(key)
    ) {
      form.setFieldValue('classificationKey', key);
    }
  }, [open, copy, fresh, classifications, form]);

  return {
    reset: () => {
      checked.current = false;
      typeChanged.current = false;
    },
    markTypeChanged: () => {
      // Changing away and back still clears the user's copied choice; a late reply cannot undo it.
      if (copy) typeChanged.current = true;
    },
  };
}

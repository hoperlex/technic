import {
  receiptRecognitionResponseSchema,
  type ReceiptRecognitionResponse,
} from '@technic/contracts';
import type { RecognitionTask } from '../ocr-engine';
import {
  MAX_TOKENS,
  PROMPT_VERSION,
  RESPONSE_JSON_SCHEMA,
  SYSTEM_PROMPT,
  USER_TEXT,
} from './prompt';

/**
 * Задание «прочитать чек на автозапчасти» (план `docs/auto-part-receipt-ocr-plan.md`, Р8).
 *
 * Устроено в точности как задание талонов и отличается только содержимым — в этом и смысл
 * разделения: транспорт, разбор ошибок, идемпотентность и учёт расхода у них общие, а предмет свой.
 */
export const partReceiptTask: RecognitionTask<ReceiptRecognitionResponse> = {
  slug: 'part_receipt',
  promptVersion: PROMPT_VERSION,
  systemPrompt: SYSTEM_PROMPT,
  userText: USER_TEXT,
  responseJsonSchema: RESPONSE_JSON_SCHEMA,
  maxTokens: MAX_TOKENS,
  parse(value) {
    const result = receiptRecognitionResponseSchema.safeParse(value);
    if (result.success) return { success: true, data: result.data };
    const issue = result.error.issues[0];
    return {
      success: false,
      where: issue ? `${issue.path.join('.') || 'ответ'}: ${issue.message}` : 'неизвестно',
    };
  },
};

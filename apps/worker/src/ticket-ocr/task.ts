import {
  wasteTicketRecognitionResponseSchema,
  type WasteTicketRecognitionResponse,
} from '@technic/contracts';
import type { RecognitionTask } from '../ocr-engine';
import { MAX_TOKENS, PROMPT_VERSION, RESPONSE_JSON_SCHEMA, SYSTEM_PROMPT, USER_TEXT } from './prompt';

/**
 * Задание «прочитать талоны вывоза» — то, ЧТО общий движок читает на странице
 * (ADR 0114; про само понятие задания — `ocr-engine/types.ts`).
 *
 * Файл существует затем, чтобы транспорт не знал предмета: промпт, схема ответа, потолок ответа и
 * проверка результата собраны здесь, а `ocr-engine` возит их до модели и обратно. Второе задание
 * (чеки на автозапчасти) устроено точно так же и отличается ровно содержимым.
 */
export const wasteTicketTask: RecognitionTask<WasteTicketRecognitionResponse> = {
  slug: 'waste_ticket',
  promptVersion: PROMPT_VERSION,
  systemPrompt: SYSTEM_PROMPT,
  userText: USER_TEXT,
  responseJsonSchema: RESPONSE_JSON_SCHEMA,
  maxTokens: MAX_TOKENS,
  parse(value) {
    const result = wasteTicketRecognitionResponseSchema.safeParse(value);
    if (result.success) return { success: true, data: result.data };
    const issue = result.error.issues[0];
    return {
      success: false,
      where: issue ? `${issue.path.join('.') || 'ответ'}: ${issue.message}` : 'неизвестно',
    };
  },
};

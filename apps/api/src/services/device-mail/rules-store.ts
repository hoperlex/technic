import { asc, eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { deviceMailParseRules } from '../../db/schema';
import type { ParseRuleRow, ParseRuleSet } from './rules';

/**
 * Чтение правил разбора из базы — ОТДЕЛЬНО ОТ ИХ ПРИМЕНЕНИЯ (`rules.ts`).
 *
 * Разделение не косметическое: применение правил — чистая работа над письмом, и проверяться оно
 * обязано без базы, без окружения и без конфигурации. Пока загрузчик жил в одном файле с
 * применением, тест разбора тянул за собой `db/client`, а тот — весь конфиг с адресами хранилища:
 * проверка правил падала на отсутствии `S3_ENDPOINT`, не дойдя ни до одного утверждения.
 */
/**
 * Включённые правила в порядке, заданном человеком. Без кэша: письма приходят раз в минуты, а кэш
 * означал бы, что правка правила действует «когда-нибудь» — ровно то, чего человек, нажавший
 * «сохранить» и открывший письмо, понять не сможет.
 */
export async function loadParseRules(reader: typeof db = db): Promise<ParseRuleSet> {
  const rows = await reader
    .select({
      id: deviceMailParseRules.id,
      target: deviceMailParseRules.target,
      keyKind: deviceMailParseRules.keyKind,
      metricCode: deviceMailParseRules.metricCode,
      component: deviceMailParseRules.component,
      valueForm: deviceMailParseRules.valueForm,
      matchKind: deviceMailParseRules.matchKind,
      expression: deviceMailParseRules.expression,
      scope: deviceMailParseRules.scope,
      whenProfile: deviceMailParseRules.whenProfile,
      whenFrom: deviceMailParseRules.whenFrom,
      whenSubject: deviceMailParseRules.whenSubject,
      updatedAt: deviceMailParseRules.updatedAt,
    })
    .from(deviceMailParseRules)
    .where(eq(deviceMailParseRules.isEnabled, true))
    .orderBy(asc(deviceMailParseRules.sortOrder), asc(deviceMailParseRules.id));

  let revision: Date | null = null;
  for (const row of rows) {
    if (!revision || row.updatedAt > revision) revision = row.updatedAt;
  }
  return { rules: rows.map((row) => row as ParseRuleRow), revision };
}


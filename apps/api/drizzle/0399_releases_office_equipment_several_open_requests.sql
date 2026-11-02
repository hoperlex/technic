-- Several open office-equipment requests on one unit (ADR 0236) were pushed without their release
-- entry; it is written before the deploy that brings them. Migration 0392 drops the unique indexes
-- before this entry, so the entry never announces a lift the database still refuses. The feed date
-- is the Moscow calendar day this migration reaches users (ADR 0077).
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 140;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  140, '0.1.129.0240', (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date,
  'Оргтехника: несколько открытых заявок на один аппарат', '{236}',
  '[
    {"kind":"feature","text":"На один аппарат можно открыть несколько заявок — и на обслуживание, и на расходники: новая заявка больше не отклоняется, пока не закрыта прежняя. Так же больше не мешает открытая заявка при восстановлении заявки из архива и при присоединении сообщённого аппарата к его карточке"},
    {"kind":"improvement","text":"При выборе аппарата форма заявки называет уже открытые заявки того же вида со ссылками: карточка открывается в новой вкладке, начатая форма остаётся. Если проблема та же, удобнее написать в обсуждении открытой заявки"}
  ]'::jsonb
);

-- Temporary transition: the new repair mailbox is the SMTP identity and primary destination;
-- optional API configuration keeps the old mailbox receiving full service notices too.
-- This feed-only migration is safe while the old application is still running.
-- The entry is dated on the Moscow calendar day the migration reaches users (ADR 0077).
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 154;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  154, '0.1.143.0248', (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date,
  'Оргтехника: временный переход на новую почту', '{159}',
  '[
    {"kind":"improvement","text":"Поддержан временный переход почты оргтехники на repair@su-10.ru: новый ящик становится отправителем уведомлений и основным адресом службы, а repair@mstroy.pro продолжает получать полные служебные письма дополнительной копией. Повторная обработка события не создаёт лишних копий"}
  ]'::jsonb
);

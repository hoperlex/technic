-- Mechanization: the lessor's invoice and a rate per day (ADR 0251, migration 0432). No schema change
-- in this file. The feed date is the Moscow calendar day this migration reaches users (ADR 0077).
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 158;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  158, '0.1.147.0251', (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date,
  'Механизация: счёт арендодателя, ставка за сутки', '{251}',
  '[
    {"kind":"improvement","text":"«Чек арендодателя» теперь называется «Счёт арендодателя»: «Прикрепить счёт», «Проверить счёт», «Без счёта», фильтр «Счёт» и подписи в истории заявки. Порядок согласования прежний: визирующий утверждает или отклоняет счёт, без утверждённого счёта аренду не завершить"},
    {"kind":"feature","text":"Ставку аренды можно указать за сутки — рядом с «час» и «смена». Отработанное в такой аренде вносится в сутках"},
    {"kind":"improvement","text":"В итогах журнала закрытых аренд и в выгрузке появилось «Отработано суток»"}
  ]'::jsonb
);

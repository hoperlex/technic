-- Sunday is a rest day for driver readings (ADR 0242, hotfix). The release has no schema change of
-- its own. The feed date is the Moscow calendar day this migration reaches users (ADR 0077).
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 146;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  146, '0.1.135.0242', (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date,
  'Кабинет водителя: воскресенье — выходной', '{242}',
  '[
    {"kind":"fix","text":"Показания за воскресенье по недельному листу ЭСМ-2 и по 4-П работы на объекте больше не требуются: в понедельник в кабинете нет строки «Не переданы показания» за воскресенье, а в гараже воскресенье не помечается «ждём показание»"},
    {"kind":"improvement","text":"Если техника в воскресенье работала, показания передаются как обычно и учитываются во всех отчётах. Грузоперевозка, доставка и вывоз техники, назначенные на воскресенье, по-прежнему ждут показаний"},
    {"kind":"fix","text":"Открытое, но не заполненное воскресенье больше не мешает проверке нормы и подписи понедельника в один клик"}
  ]'::jsonb
);

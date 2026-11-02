-- The vehicle change names the day it starts (ADR 0243). The release has no schema change of its
-- own. The feed date is the Moscow calendar day this migration reaches users (ADR 0077).
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 147;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  147, '0.1.136.0243', (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date,
  'Заказ ТС: у смены техники появилась дата', '{243}',
  '[
    {"kind":"improvement","text":"В окне «Смена техники» появилось поле «Новая техника работает с»: можно указать, с какого дня работает другая машина, — с сегодняшнего, с любого дня вперёд или с прошедшего дня в пределах срока заявки. Дни до этой даты остаются за прежней машиной, листы ЭСМ-2 режутся по этому дню"},
    {"kind":"improvement","text":"Дни, подписанные объектом до даты смены, больше не мешают сменить технику: подпись стоит под работой прежней машины и остаётся на месте. Смену запирают только подписанные дни начиная с выбранной даты — окно называет их и последний из них"},
    {"kind":"improvement","text":"Смена с прошедшей даты требует причину и права править прошедшие дни, не глубже тридцати дней. Листы ЭСМ-2 уже закончившихся недель по-прежнему переоформляются только галочкой «Исправить задним числом»"}
  ]'::jsonb
);

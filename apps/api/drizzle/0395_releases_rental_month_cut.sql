-- The rental month cut was published without its release entry. Editing 0394 would not add that
-- entry in databases that already applied it, so the correction needs a new forward migration.
-- The feed date is the Moscow calendar day this migration reaches users (ADR 0077, ADR 0238).
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 137;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  137, '0.1.126.0238', (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date,
  'Заказ техники: продление аренды по месяцам', '{238}',
  '[
    {"kind":"feature","text":"При принятии недельной заявки продление аренды теперь делится по границе месяца: прежний заказ заканчивается последним числом, а с 1-го числа на оставшиеся дни открывается отдельный заказ"},
    {"kind":"improvement","text":"Перед принятием недельной заявки видно предупреждение о новом заказе; после принятия результат показывает даты и номер созданного заказа. Уже принятые недели автоматически не пересчитываются"}
  ]'::jsonb
);

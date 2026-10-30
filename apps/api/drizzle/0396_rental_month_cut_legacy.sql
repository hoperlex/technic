-- A legacy month cut can shorten the source order, so its written end cannot be inferred from
-- the previous end. Old rows retain NULL and use the former reversal calculation. Old writers
-- can keep serving during migration because the new snapshot is nullable and ignored by them.
SET LOCAL lock_timeout = '10s';
ALTER TABLE weekly_vehicle_request_items ADD COLUMN applied_date_to date;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  138, '0.1.127.0238', (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date,
  'Продление аренды: старые переходящие заказы', '{238}',
  '[
    {"kind":"fix","text":"Продление аренды через недельную заявку учитывает старые заказы, уже захватившие следующий месяц: исходный заказ ограничивается своим месяцем, продолжение создаётся отдельно"},
    {"kind":"improvement","text":"Новый месячный заказ начинается с первого буднего дня; отдельный заказ ради выходных на границе месяца не создаётся. Выбранный конец продления, включая субботу или воскресенье, сохраняется"}
  ]'::jsonb
);

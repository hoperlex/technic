-- The readings export rebuilt as a report on the work of equipment by request days (ADR 0240) was
-- pushed without its release entry; it is written before the deploy that brings it. The release has
-- no schema change of its own. The feed date is the Moscow calendar day this migration reaches
-- users (ADR 0077).
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 143;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  143, '0.1.132.0240', (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date,
  'Выгрузки: отчёт о работе строительной техники', '{240}',
  '[
    {"kind":"feature","text":"Выгрузка «Показания автотранспорта» стала отчётом о работе строительной техники по образцу суточного отчёта: строка — заявка за день, с датой, машиной, водителем, объектом или маршрутом, выполненной задачей и одометром и моточасами на начало, конец и за день"},
    {"kind":"feature","text":"Своя техника — на листе «Собственная», арендованная — на листе «Аренда»: арендодатель, время смены, часы, ставка и стоимость дня"},
    {"kind":"improvement","text":"У каждой колонки есть фильтр, итоги в шапке считаются по отфильтрованным строкам; если конец меньше начала, разница помечена красным «Проверить»"},
    {"kind":"improvement","text":"В отчёт попадают и показания вне заявок: перегон — строкой своей заявки, прочие поездки своей машины — строкой «без заявки», поэтому пробег машины за период сходится с её одометром"},
    {"kind":"improvement","text":"Прежние листы книги показаний и колонки топлива из выгрузки убраны. Выгрузку делает сотрудник, которому видны показания и все заявки на технику по всей организации"}
  ]'::jsonb
);

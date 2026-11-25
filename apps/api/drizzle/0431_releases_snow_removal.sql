-- Snow removal request (ADR 0250, migrations 0427–0430): a request type «Вывоз снега» with the
-- service waste type «Снег», an ordered volume of at least 8 m³, a ticket at completion and a cost
-- entered by hand; the statistics tab gains a «Мусор / Снег» switch. No schema change in this file.
-- The feed date is the Moscow calendar day this migration reaches users (ADR 0077).
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 157;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  157, '0.1.146.0250', (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date,
  'Вывоз мусора: заявка «Вывоз снега»', '{250}',
  '[
    {"kind":"feature","text":"В разделе «Вывоз мусора» появился тип заявки «Вывоз снега». Укажите объект, дату, объём от 8 м³ и ответственного. Тип мусора определяет портал"},
    {"kind":"feature","text":"При выполнении заявки на вывоз снега приложите талон и внесите стоимость, если она известна"},
    {"kind":"feature","text":"На вкладке «Статистика» переключатель «Мусор / Снег» показывает раздельные итоги"},
    {"kind":"improvement","text":"Заявку на вывоз нельзя завершить, пока скан талона ещё распознаётся или распознавание оборвалось без результата. Если файл не прочитан, портал предлагает «Перераспознать» — ручной ввод талона такой файл не закрывает"},
    {"kind":"improvement","text":"В статистике вывоза сканы, у которых не распознана страница, считаются непрочитанными и не попадают в «прочитано без талонов»"}
  ]'::jsonb
);

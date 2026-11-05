-- «Виза отдела» for the manager with visa departments (ADR 0245). The schema change of the release
-- is migration 0410; this one only adds the feed entry, dated by the Moscow calendar day it reaches
-- users (ADR 0077). Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 148;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  148, '0.1.137.0245', (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date,
  'Доступ: менеджер может визировать заявки своего отдела', '{245}',
  '[
    {"kind":"feature","text":"Менеджеру можно выдать полномочие «Виза отдела», не меняя роль: все права менеджера сохраняются. В карточке учётки при отмеченной «Визе отдела» появляется поле «Отделы визы» — один или несколько отделов, новая строка добавляется кнопкой «+»"},
    {"kind":"improvement","text":"Менеджер с «Визой отдела» визирует заявки на технику и аренду механизации так же, как руководитель отдела: заявки своих отделов визы и закреплённых за ними площадок. Видит он по-прежнему все заявки, но кнопка «Согласовать» есть только на тех, которые он вправе визировать"},
    {"kind":"fix","text":"Кнопки визы на заявках теперь показываются только там, где виза действительно будет принята, а не всем, у кого есть право визировать"}
  ]'::jsonb
);

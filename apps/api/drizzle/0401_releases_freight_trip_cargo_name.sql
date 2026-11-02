-- The required «Что везём» of a freight trip (ADR 0239) was pushed without its release entry; it is
-- written before the deploy that brings it. Migration 0397 adds the column before this entry, so
-- the entry never announces a field that is not there yet. The feed date is the Moscow calendar
-- day this migration reaches users (ADR 0077).
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 142;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  142, '0.1.131.0240', (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date,
  'Заказ техники: в ездке указывают, что везём', '{239}',
  '[
    {"kind":"feature","text":"У каждой ездки грузоперевозки появилось обязательное поле «Что везём» — свободный текст до 200 знаков. Разные ездки одной заявки могут везти разное"},
    {"kind":"improvement","text":"Груз виден в карточке заявки и в таблице ездок, в списке заказов — под заказанной техникой, на телефоне — отдельной строкой. Поиск по заявкам находит и по грузу"},
    {"kind":"improvement","text":"Правка груза снимает согласование заявки, как и правка маршрута. В путевой лист и в кабинет водителя поле не попадает. Комментарий грузоперевозки больше не просит описать груз"},
    {"kind":"improvement","text":"У ездок, созданных до обновления, поле пустое: его можно заполнить при правке, а заполненный груз очистить нельзя. Вкладка, открытая до обновления, при создании заявки или новой ездки попросит обновить страницу — заполненное сохранится в черновике"}
  ]'::jsonb
);

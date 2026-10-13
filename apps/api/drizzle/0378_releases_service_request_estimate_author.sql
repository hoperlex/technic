-- Release note for wave 1 of the office-equipment role-walkthrough fixes (ADR 0174): the estimate
-- belongs to its author, the estimate step sits on its tab, the auto-close counts from the moment
-- of the transition. The tail repeats 0227: no decision of this block is newer. Release 128.
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 128;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  128, '0.1.117.0227', '2026-10-13',
  'Орг.техника: объём работ ведёт его автор', '{174}',
  '[
    {"kind":"fix","text":"Объём работ по заявке составляют подрядчик и держатель права на смету, а не любой назначенный сотрудник: при заявке с собственным администратором и сервисной компанией собственный сотрудник больше не может писать, передавать и снимать чужую смету"},
    {"kind":"improvement","text":"Шаг «Работы выполнены» или «Передать документ на согласование» исполнитель делает кнопкой на вкладке «Объём работ» рядом с решением по смете; из меню «Действия» карточки он убран"},
    {"kind":"fix","text":"Автоприёмка заявки через сутки в «Решена» считает эти сутки от момента, когда заявка стала решённой, а не от даты выполнения: заявка, закрытая вчерашним числом, больше не принимается в ту же секунду, не оставив заказчику времени на возражение"}
  ]'::jsonb
);

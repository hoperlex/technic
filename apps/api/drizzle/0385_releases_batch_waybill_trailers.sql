-- The batch waybill trailer change reached users on 7 October, after release 121 had already
-- been recorded. This retrospective entry names the shipped behavior without claiming that
-- the later on-site trailer display was deployed in the same window (ADR 0207).
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 131;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  131, '0.1.120.0227', '2026-10-07',
  'Заказ ТС: массовая выписка путевых листов учитывает полуприцепы', '{138,207}',
  '[
    {"kind":"improvement","text":"При массовой выписке путевых листов для работы на объекте новый рейс за сегодня или будущий день получает прицепы из текущей сцепки машины; они попадают в рейс и бланк листа"},
    {"kind":"fix","text":"Прицеп из второго места сцепки заполняет первое свободное место бланка. Уже созданный рейс и выписанный лист массовая команда не переписывает"},
    {"kind":"improvement","text":"Для прошедшего дня массовая выписка не подставляет сегодняшнюю сцепку: в справочнике нет истории прицепов за тот день"}
  ]'::jsonb
);

-- Weekend rows of the readings report in two shades (ADR 0241, decision 6). The release has no
-- schema change of its own. The feed date is the Moscow calendar day this migration reaches users
-- (ADR 0077).
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 145;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  145, '0.1.134.0241', (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date,
  'Выгрузки: выходные в отчёте о работе техники', '{241}',
  '[
    {"kind":"improvement","text":"В отчёте о работе строительной техники строки выходных дней подсвечены: суббота — сиреневым, воскресенье — абрикосовым. Подсветка идёт за датой строки и сохраняется при сортировке и фильтре"}
  ]'::jsonb
);

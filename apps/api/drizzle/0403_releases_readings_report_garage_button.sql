-- The readings report button in the garage header, with the book for managers and mechanics
-- (ADR 0241). The release has no schema change of its own: role sets are computed by the server.
-- The feed date is the Moscow calendar day this migration reaches users (ADR 0077).
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 144;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  144, '0.1.133.0241', (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date,
  'Гараж: кнопка «Отчёт» о работе строительной техники', '{241}',
  '[
    {"kind":"feature","text":"В шапке «Гаража» справа появилась кнопка «Отчёт»: в окне — пояснение и выбор периода по календарю, книга Excel о работе строительной техники скачивается одной кнопкой"},
    {"kind":"feature","text":"Отчёт доступен администраторам, менеджерам, механикам и главным механикам; механикам теперь открыты и вкладка «Показания» гаража, и раздел «Заказ ТС» — только для просмотра"},
    {"kind":"improvement","text":"Механики по-прежнему открывают портал на «Гараже»"}
  ]'::jsonb
);

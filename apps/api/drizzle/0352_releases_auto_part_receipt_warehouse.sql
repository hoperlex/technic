-- Release note for receipt-backed auto-part warehouse and application documents (ADR 0216),
-- release 118. Release 117 and migration 0350 are reserved by integrate/repair-history.
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 118;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  118, '0.1.107.0216', '2026-09-30',
  'Гараж: запас автозапчастей и документы применения', '{216}',
  '[
    {"kind":"feature","text":"Строку чека можно явно отправить на склад; склад показывает остаток каждой партии и её исходный чек"},
    {"kind":"feature","text":"Все строки распознанного или ручного чека одним действием относятся на склад либо на выбранную машину"},
    {"kind":"feature","text":"Запчасть со склада применяется к машине отдельным документом, попадает в затраты машины и в месячную Excel-форму"}
  ]'::jsonb
);

-- Release note for the printed trips and the issue check shown in the waybill journal, the sheet
-- window and the route card, and for the form's capacity counted in task rows on every door that
-- spends a number (ADR 0108, ADR 0068). The tail repeats 0227: no decision of this block is newer.
-- Release 127.
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 127;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  127, '0.1.116.0227', '2026-10-13',
  'Путевые листы: ездки и проверка выписки видны в портале', '{68,108}',
  '[
    {"kind":"feature","text":"В журнале путевых листов и в окне листа видно, по каким ездкам напечатаны строки задания, и чем была проверка при выписке; в карточке рейса то же показано для выписанного листа. Номер листа в журнале открывает окно кнопкой"},
    {"kind":"fix","text":"Ёмкость бланка (7 строк у 4-П, 10 у формы № 3) считается строками задания, а не заявками: рейс, у которого ездок больше, чем строк в бланке, отказывает при выписке, коррекции и переносе талона — до траты номера и до аннулирования выписанного листа, и отказ называет, сколько строк не хватает"}
  ]'::jsonb
);

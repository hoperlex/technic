-- The public df2c910e bundle was served on 2026-10-16. Its local request drafts and the
-- route-form guard were usable without the receipt table; this entry records those independent
-- changes at the date they reached users. Receipt-backed creation gets its own entry only after
-- migration 0384 and the matching API are deployed together (ADR 0077, ADR 0230).
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 133;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  133, '0.1.122.0230', '2026-10-16',
  'Заявки: черновики можно восстановить после закрытия вкладки', '{65,128,230}',
  '[
    {"kind":"feature","text":"При создании заказа техники, вывоза мусора, заявки на механизацию, обслуживание оргтехники и недельной заявки введённые поля сохраняются в этом браузере. После перезагрузки или закрытия вкладки форму можно восстановить либо начать заново"},
    {"kind":"improvement","text":"Черновик заказа техники сохраняет ездки и адреса. При восстановлении правки существующего заказа портал перечитывает его текущую версию; при восстановлении состава недельной заявки сохраняет новые строки других участников и просит проверить изменившееся"},
    {"kind":"improvement","text":"Если браузер не смог сохранить черновик, форма сообщает об этом. Файлы, которые не были загружены, после закрытия вкладки нужно прикрепить заново"},
    {"kind":"fix","text":"Типу ТС со старым бланком ЭСМ-2 больше нельзя выписать обычный путевой лист: портал просит выбрать для типа 4-П или форму № 3, а рейс с таким типом не попадает в отбор по бланку"}
  ]'::jsonb
);

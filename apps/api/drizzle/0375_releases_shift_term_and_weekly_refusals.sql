-- Release note for the term edit that may not drop a day with a filled shift (ADR 0184) and the
-- weekly reversal refusals shown in the server's words (ADR 0218, ADR 0219). The tail repeats
-- 0227: no decision of this block is newer. Release 126.
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 126;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  126, '0.1.115.0227', '2026-10-13',
  'Заказ ТС: срок не выбрасывает дни со сменами', '{184,218,219}',
  '[
    {"kind":"fix","text":"Сокращение срока заказа техники больше не выбрасывает дни с заполненными сменами: портал отказывает и называет эти дни. Оставьте их в сроке или сначала удалите их смены в окне смен на вкладке «На объекте» (подписанную — сняв согласование)"},
    {"kind":"fix","text":"Недельная заявка: отказ аннулирования или возврата на согласование показывается словами сервера и больше не выдаётся на карточке за «Применение не прошло»; если последствия изменились, окно говорит об этом и показывает их заново"}
  ]'::jsonb
);

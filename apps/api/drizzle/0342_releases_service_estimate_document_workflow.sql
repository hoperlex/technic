-- Release note for the completed office-equipment document workflow (ADR 0208).
-- Migration 0341 enables the two capabilities that have been deployed behind flags since ADR 0183.
--
-- seq 110 is the first unused repository sequence after 0340 (seq 109). Rollback of the feed entry:
-- DELETE FROM app_releases WHERE seq = 110;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  110, '0.1.99.0208', '2026-09-24', 'Выполненные работы по оргтехнике — документом и сразу с актом', '{208}',
  '[
    {"kind":"feature","text":"У исполнителя сервисной компании вместо действия «Объём работ» появилась основная кнопка «Работы выполнены»: перечень услуг заполнять больше не нужно — достаточно приложить счёт или его скриншот"},
    {"kind":"feature","text":"Нажатие «Работы выполнены» автоматически согласует документ по действующему правилу сервисной компании и сразу открывает подшивку закрывающего акта"},
    {"kind":"improvement","text":"Закрытие статуса осталось отдельным контролируемым действием: после подшивки акта портал показывает, что доступно «Закрыть работы», и не выдаёт загрузку файла за смену статуса"}
  ]'::jsonb
);

-- The driver's confirmation window keeps its buttons on screen: a layout fix of the window from
-- ADR 0237, no decision of its own. The tail is 0246, the latest decision already shipped
-- (0.1.138.0246), not the 0244 of the release just before: 1B shipped ADR 0244 after 0246, and
-- repeating its tail would make the number claim that 0246 is not in. The release has no schema
-- change. The feed date is the Moscow calendar day this migration reaches users (ADR 0077).
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 151;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  151, '0.1.140.0246', (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date,
  'Кабинет водителя: кнопки окна подтверждения всегда на экране', '{237}',
  '[
    {"kind":"fix","text":"В окне «Проверьте данные перед передачей» кнопки «Вернуться к исправлению» и «Подтверждаю, передать» закреплены внизу окна и видны всегда — даже на небольшом телефоне, с крупным шрифтом и при длинном списке расхождений. Раньше кнопка «Подтверждаю, передать» могла оказаться за краем экрана"},
    {"kind":"improvement","text":"Кнопки окна стоят одна под другой во всю его ширину, длинная подпись переносится на вторую строку, а не обрезается. Заголовок и текст окна прокручиваются над кнопками; лёгкая тень у нижнего края текста показывает, что ниже есть ещё строки, и пропадает, когда список дочитан"}
  ]'::jsonb
);

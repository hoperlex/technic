-- Whole shifts at the end of the shift in the driver cabinet (ADR 0237) were pushed without their
-- release entry; it is written before the deploy that brings them. The release has no schema change
-- of its own. The feed date is the Moscow calendar day this migration reaches users (ADR 0077).
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 141;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  141, '0.1.130.0240', (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date,
  'Кабинет водителя: показания целиком в конце смены', '{237}',
  '[
    {"kind":"improvement","text":"Начатую смену кабинет водителя передаёт только целиком: остаток топлива на начало и на конец смены и «Одометр» или «Моточасы» — одно из двух. «Заправлено» можно оставить пустым, это значит «не заправлялись». Все пропуски видны сразу, каждый под своим полем"},
    {"kind":"improvement","text":"Смена передаётся завершённой: у смены по ЭСМ-2 нужны её начало и конец, у рейса — прибытие на первую точку и убытие с каждой. Кнопка «сейчас» у полей времени убрана: время вводится вручную, «730» читается как 07:30"},
    {"kind":"feature","text":"Остаток топлива на начало смены сверяется с концом прошлой смены — под полем видно, например, «в конце прошлой смены: 92 л (27.10)». Вторая смена той же машины в одном отчёте сверяется с первой"},
    {"kind":"improvement","text":"Вместо галочки «Всё верно, подтверждаю» кнопка «Передать» открывает окно со всеми расхождениями дня: «Вернуться к исправлению» ничего не отправляет, «Подтверждаю, передать» отправляет показания с подтверждением"}
  ]'::jsonb
);

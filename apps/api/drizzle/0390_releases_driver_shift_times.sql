-- The feed entry is dated by the Moscow calendar day this migration runs, that is the day the
-- release reaches users, not the day the code was written (ADR 0077). Migration 0389 adds the
-- reading times before this entry, so the entry never announces columns that are not there yet.
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 135;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  135, '0.1.124.0234', (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date,
  'Смены заявки и время смены водителя', '{184,234}',
  '[
    {"kind":"feature","text":"Смены заказа техники на объект берут моточасы и заправку из показаний водителя: площадке больше не нужно перепечатывать числа, день по показаниям согласуется одним нажатием"},
    {"kind":"feature","text":"В кабинете водителя появились начало и конец смены по ЭСМ-2, а у рейса — прибытие на первую точку и убытие с каждой точки; у каждого поля времени есть кнопка «сейчас»"},
    {"kind":"feature","text":"Время рейса делится между заявками по точкам: карточка грузоперевозки показывает факт по точкам, а окно закрытия предлагает часы, округлённые вверх до целого часа"},
    {"kind":"improvement","text":"Гараж показывает время смены и остановок в журнале машины, в книгах показаний и в реестре приёма; персонал может внести время за водителя, в том числе первые остановки рейса"},
    {"kind":"improvement","text":"Подробности о водителе в сменах заявки — комментарии, причины и состояние отчёта — видят только сотрудники с правом чтения показаний"}
  ]'::jsonb
);

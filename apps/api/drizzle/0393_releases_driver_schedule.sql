-- The feed entry is dated by the Moscow calendar day this migration runs, that is the day the
-- release reaches users, not the day the code was written (ADR 0077).
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 136;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  136, '0.1.125.0236', (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date,
  'Гараж: график смен водителя', '{184,234}',
  '[
    {"kind":"feature","text":"На вкладке гаража «Водители» появилась кнопка «График»: она показывает смены водителя за месяц — даты, машины, рейсы и листы — и переданы ли по ним показания; дни назначения без листа помечены отдельно, из строки открывается отчёт дня"},
    {"kind":"improvement","text":"День по показаниям водителя теперь можно согласовать одним нажатием и после выходных без смен: разрыв между показаниями считается так же, как в гараже, — только по пропущенным ожидаемым сменам"},
    {"kind":"improvement","text":"Если день спецтехники стоит в одном рейсе с грузоперевозками, время его смены считается по его собственным точкам, а моточасы — за весь рейс с пометкой «рейс общий»"},
    {"kind":"improvement","text":"Сводная книга аналитики и занятость машин в гараже считают дни по показаниям водителя так же, как карточка заявки"}
  ]'::jsonb
);

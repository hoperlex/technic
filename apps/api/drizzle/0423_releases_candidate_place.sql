-- Candidate location role scopes use one rule (ADR 0249): the window offers active sites and
-- honours module-wide scope; departments temporarily may report a device on any existing object while
-- department data and the object directory remain incomplete. No schema change is required.
-- The feed date is the Moscow calendar day this migration reaches users (ADR 0077).
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 155;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  155, '0.1.144.0249', (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date,
  'Оргтехника: место аппарата в «Сообщить об аппарате»', '{249}',
  '[
    {"kind":"improvement","text":"Сотрудник отдела временно может сообщить об аппарате на любом активном объекте компании. Это вынужденная мера, пока данные об отделах и справочник объектов неполны. Площадки отдела стоят в списке «Где стоит» первыми. Раньше у отдела без закреплённых площадок список был пуст и сообщить об аппарате было нельзя"},
    {"kind":"fix","text":"Сотрудники ИТ-службы с доступом ко всей оргтехнике видят в списке «Где стоит» все активные объекты компании, а не только свои"}
  ]'::jsonb
);

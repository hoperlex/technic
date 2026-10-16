-- The public df2c910e bundle includes the Stage 5 form-session guard, the later cache fixes,
-- and the server-permission oracle. Existing releases 122-130 name list loading but omit the
-- user-visible form, refresh, and action-availability effects (ADR 0222, ADR 0223).
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 132;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  132, '0.1.121.0227', '2026-10-16',
  'Портал: формы сохраняют ввод при обновлении данных', '{222,223}',
  '[
    {"kind":"fix","text":"Фоновое обновление карточки больше не стирает несохранённые поля открытой формы. Если другой участник изменил запись, форма сообщает об этом и предлагает явно загрузить новую версию"},
    {"kind":"fix","text":"После отказа из-за изменившейся версии окна чека и объёма работ остаются открытыми с введёнными данными; карточка не закрывается из-за ошибки фонового перечитывания"},
    {"kind":"fix","text":"После изменения прицепов, рейсов, показаний водителя, типов техники, расходников или журнала рассылок связанные списки и карточки перечитываются без ожидания устаревшего кэша"},
    {"kind":"improvement","text":"Действия в заказах ТС, механизации и заявках оргтехники показываются по правам, которые сервер выдал текущей учётке; это касается статусов, смет, массовых действий, вложений и подсказок ожидания"}
  ]'::jsonb
);

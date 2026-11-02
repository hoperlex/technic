-- Rental closing hours, delivery and the request documents (ADR 0235) were pushed without their
-- release entry; it is written before the deploy that brings them. Migration 0391 adds the columns
-- before this entry, so the entry never announces fields that are not there yet. The feed date is
-- the Moscow calendar day this migration reaches users (ADR 0077).
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 139;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  139, '0.1.128.0240', (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date,
  'Заказ техники: часы и доставка в закрытии аренды, документы заявки', '{235}',
  '[
    {"kind":"feature","text":"Закрытие заявки на арендную технику — и на объект, и на грузоперевозку — принимает и смены, и фактические часы: под ними видно, по сколько часов выходит на смену. Стоимость считается по единице, выбранной в «Считаем работу», и правится вручную"},
    {"kind":"feature","text":"Галочка «Доставка на объект» открывает отдельную сумму за привоз и увоз техники. В стоимость заказа она не входит: в карточке заявки у неё своя строка, на вкладке «История» — своя колонка и итог"},
    {"kind":"feature","text":"В карточке заявки на технику появилась таблица документов «Файл, тип, дата»: счета, акты и другие бумаги подшиваются кнопкой «Добавить файл», пока заявка в работе, выполнена или отменена. Арендодатель добавляет документы к своим заявкам; снять документ может тот, кто его добавил, или администратор"},
    {"kind":"improvement","text":"Окно «Добавить документы» принимает несколько документов сразу: файл, тип и дата в одну строку, «Прикрепить ещё документ» добавляет следующую строку"}
  ]'::jsonb
);

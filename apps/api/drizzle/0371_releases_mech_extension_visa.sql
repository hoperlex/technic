-- Release note for the second R1 block of the 2026-10-12 roadmap: the rental extension visa of
-- mechanization (ADR 0171, stage 3), the office-equipment card bound to its model (ADR 0132,
-- release B) and the executor scope switched on (ADR 0179). The tail repeats 0226: no decision of
-- this block is newer. Release 124.
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 124;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  124, '0.1.113.0226', '2026-10-12',
  'Механизация: продление аренды — по визе площадки', '{132,171,179}',
  '[
    {"kind":"feature","text":"Продление аренды механизации теперь согласуется: диспетчер запрашивает новый срок с причиной («Запросить продление»), ответственное лицо площадки согласует или отклоняет его. Срок аренды сдвигается только после визы; пока запрос ждёт, карточка показывает «Продление до … ждёт визы площадки», а запрос можно изменить или отозвать"},
    {"kind":"improvement","text":"Запрос продления, ждущий визы, снимается сам, когда аренда завершена или отметка о выдаче отозвана"},
    {"kind":"improvement","text":"Исполнители заявок оргтехники видят в списках только свои заявки: назначенные им, созданные ими и снятые с них"},
    {"kind":"improvement","text":"Карточка оргтехники всегда привязана к модели: наименование задаёт модель, отдельного поля наименования больше нет"}
  ]'::jsonb
);

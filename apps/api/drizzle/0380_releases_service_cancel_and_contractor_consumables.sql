-- Release note for wave 2 of the office-equipment role-walkthrough fixes (ADR 0174): the IT service
-- cancels requests with its own right, a request handed to a contractor does not move the store,
-- and the contractor does not see the nomenclature of a consumables request. The tail repeats
-- 0227: no decision of this block is newer. Release 129.
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 129;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  129, '0.1.118.0227', '2026-10-13',
  'Орг.техника: отмена ИТ-службой и заявки на расходники у подрядчика', '{174}',
  '[
    {"kind":"feature","text":"У ИТ-службы появилось право «Отмена заявок»: она отменяет заявки оргтехники (в «Новой», «В работе» и «Отложена») из меню «Действия» и в массовом режиме, не получая вместе с этим приёмку работы, возврат на доработку и возврат в «Новую». Пункт появится после следующего обновления сессии — войти заново не нужно"},
    {"kind":"improvement","text":"Заявка на расходники, отданная подрядчику, больше не двигает склад: отметку выдачи по ней не ставит никто, а закрытие не просит строк выдачи — достаточно даты и слов"},
    {"kind":"improvement","text":"Подрядчик не видит перечень расходников и документы к заявке на расходники: вкладки «Расходники» и «Документы» ему не показываются, письмо о документе его адресату не уходит"},
    {"kind":"fix","text":"Массовая отмена заявки «В работе» с собственным исполнителем больше не заканчивается безымянным «Не удалось выполнить»: заявка отменяется, исполнитель снимается"}
  ]'::jsonb
);

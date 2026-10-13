-- Release note for the bulk actions on office-equipment requests (ADR 0167). The feature reached
-- users with migrations 0278 and 0279 on 2026-09-07, but its feed entry was never written: the
-- releases of those days (0281, 0282) carried other blocks. The owner closed the plan forks В1–В5
-- with the plan defaults on 2026-10-12 (survey S-17) and asked for the entry.
--
-- WHY THE DATE IS OLDER THAN THE PREVIOUS ENTRY. `released_on` says when the block reached people,
-- `seq` orders the feed (ADR 0077 §3): rewriting the order of entries people may already have read
-- is worse than one entry whose date is earlier than its neighbour's. The tail repeats 0227: no
-- decision of this block is newer (ADR 0191). Release 130.
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 130;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  130, '0.1.119.0227', '2026-09-07',
  'Орг.техника: массовые действия над заявками', '{167}',
  '[
    {"kind":"feature","text":"Заявки оргтехники можно обрабатывать пачкой: отметьте до 50 строк в списке, и под таблицей появится полоса действий — «Отменить», «Отложить», «Возобновить», «Поставить срочность», «Снять срочность», «Принять в работу», «Принять работу», «Архивировать»"},
    {"kind":"feature","text":"Действие показывается, если оно годится хотя бы для одной из выбранных заявок: окно до нажатия пишет «7 из 9» и перечисляет пропущенные заявки с причиной. Для отмены, отсрочки и срочности причина пишется одна на всю пачку"},
    {"kind":"feature","text":"После выполнения окно показывает отчёт по каждой заявке и само не закрывается. Перезагрузка вкладки пачку не теряет: «Продолжить» доводит тот же запуск, а не начинает второй"},
    {"kind":"improvement","text":"Адресаты получают одно письмо-сводку на пачку вместо письма на каждую заявку"},
    {"kind":"improvement","text":"Смена отбора снимает выбор строк — чтобы не применить действие к заявкам, которых уже не видно. На телефоне массовых действий нет: это работа за столом"}
  ]'::jsonb
);

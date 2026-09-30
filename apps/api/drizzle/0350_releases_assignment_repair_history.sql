-- Release note for repairing assignment history against issued waybills (ADRs 0212 and 0214),
-- release 117.
--
-- File number: `ls apps/api/drizzle` immediately before creation (30.09.2026) ended at 0349;
-- the completed parallel waves no longer hold an unmerged migration number. seq 117 follows 116
-- (0349); the version continues the 0.1 line counter (105 -> 106) and uses ADR 0214, the decision
-- that closes the repair door, as its tail.
--
-- What the entry promises: visible assignment and waybill behaviour plus the administrator's
-- reconciliation command. The schema is untouched, so this file survives the deployment window
-- while the old application is still running.
--
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 117;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  117, '0.1.106.0214', '2026-09-30',
  'История назначения сверяется с выданными путевыми листами', '{212,214}',
  '[
    {"kind":"fix","text":"Заполнение неизвестного прошлого больше не протягивает машиниста и не выписывает листы на сегодня и вперёд: текущий остаток заполняется отдельным действием"},
    {"kind":"fix","text":"Отмена заполнения гасит выписанные им листы, а заполнение поверх листа с другим машинистом или внутри его срока отклоняется с номером бланка"},
    {"kind":"improvement","text":"Окна ремонта, срока, смены машиниста и техники, закрытия и досрочного завершения показывают последствия для листов и передают подтверждение каждого предупреждения"},
    {"kind":"improvement","text":"Команда сверки истории назначения показывает следы прежнего дефекта отдельными разделами и автоматически исправляет только однозначные случаи"}
  ]'::jsonb
);

-- Виза отдела ИТ на заявке (план `docs/office-equipment-upgrade-plan.md`, Р51, Р52).
--
-- Статус `it_approved` пришёл миграцией 0117 — здесь появляется снимок решения: кто и когда
-- подтвердил, что внешний ремонт нужен.

ALTER TABLE service_requests
  ADD COLUMN it_approved_by uuid REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN it_approved_at timestamptz,
  -- Виза проставлена самим заведением: заявку завёл обладатель права (Р52). Флаг нужен истории —
  -- «согласовал сам себе» и «согласовал по чужой заявке» это разные события, а различает их
  -- только это поле.
  ADD COLUMN it_approved_auto boolean NOT NULL DEFAULT false;

-- «Кто» без «когда» — не согласование (приём ADR 0025, `vehicle_requests.approved_by/at`).
ALTER TABLE service_requests ADD CONSTRAINT service_requests_it_approval_check
  CHECK ((it_approved_by IS NULL) = (it_approved_at IS NULL));

-- Автоматической виза бывает только у существующей: флаг без подписи ничего не отмечает.
ALTER TABLE service_requests ADD CONSTRAINT service_requests_it_auto_check
  CHECK (NOT it_approved_auto OR it_approved_by IS NOT NULL);

-- Без исполнителя заявка бывает не только «Новой» и «Отменённой»: между ними встал статус
-- «Согласована ИТ», в котором сервис ещё не выбран. Ограничение перевыпускается — иначе виза
-- упирается в отказ базы на первом же переходе.
ALTER TABLE service_requests DROP CONSTRAINT service_requests_executor_check;
ALTER TABLE service_requests ADD CONSTRAINT service_requests_executor_check
  CHECK (status IN ('new', 'it_approved', 'cancelled') OR service_counterparty_id IS NOT NULL);

-- Правило «без визы сервис не назначают» держит сервер, а не CHECK, и это сознательно: заявки,
-- которые сейчас идут в «Назначен сервис» и дальше, прошли цикл по прежним правилам, и
-- ограничение объявило бы их испорченными — любое их обновление упиралось бы в отказ базы.
-- Заявки в «Новой» после выката начинают ждать ИТ, и это и есть ввод правила в действие.

-- Отдельного индекса под очередь ИТ не нужно: `service_requests_status_changed_idx` покрывает её
-- префиксом (статус + возраст в статусе).

-- Аддитивная миграция: колонки со значениями по умолчанию, данные не меняются. Протокол выката
-- необратимых миграций (`docs/schema-cutover-protocol.md`) к ней не применяется.

-- Заказчик заявки на технику: объект строительства или отдел, ровно один (ADR 0040).
--
-- До сих пор заказчик был один — объект, и колонка `object_id` была обязательной. Отдел с
-- объектами не пересекается: снабжение везёт материалы на склад, ПТО — оборудование между
-- офисами, и площадки у такой заявки нет вовсе. Поэтому не «отдел вдобавок к объекту», а вторая
-- колонка вместо первой.
ALTER TABLE vehicle_requests
  ADD COLUMN department_id uuid REFERENCES departments (id) ON DELETE RESTRICT;

-- RESTRICT, а не CASCADE: отдел из справочника не удаляют (деактивируют), но заявка не должна
-- исчезнуть вместе со строкой справочника — у неё свой номер и своя история.

ALTER TABLE vehicle_requests
  ALTER COLUMN object_id DROP NOT NULL;

-- Заказчик ровно один. Без верхней границы заявка получила бы двух ответственных и два ответа на
-- вопрос «кто визирует»; без нижней — ни одного, и заявка стала бы ничьей.
ALTER TABLE vehicle_requests
  ADD CONSTRAINT vehicle_requests_customer_check
  CHECK (num_nonnulls(object_id, department_id) = 1);

-- У отдела бывают только грузоперевозки: спецтехника выходит на площадку, а площадки у отдела
-- нет. Перечень типов, доступных роли, живёт в матрице (@technic/contracts) — здесь физическая
-- граница того же правила: заявка со спецтехникой от отдела невозможна, кем бы она ни заводилась.
ALTER TABLE vehicle_requests
  ADD CONSTRAINT vehicle_requests_department_freight_check
  CHECK (department_id IS NULL OR request_type = 'freight_transport');

CREATE INDEX vehicle_requests_department_idx
  ON vehicle_requests (department_id)
  WHERE department_id IS NOT NULL;

-- «Что ждёт визы» со стороны отдела — тот же вопрос, что у объекта (миграция 0049), и такой же
-- частичный индекс: руководитель отдела открывает день с него.
CREATE INDEX vehicle_requests_department_awaiting_approval_idx
  ON vehicle_requests (department_id)
  WHERE approved_at IS NULL AND deleted_at IS NULL AND department_id IS NOT NULL;

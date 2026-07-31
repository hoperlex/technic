-- Справочник отделов и привязка к нему учёток (ADR 0040).
--
-- Отдел — офисное подразделение: снабжение, ПТО, АХО. С объектами строительства отделы не
-- пересекаются, и вторая ось области видимости заводится именно поэтому: сотрудник отдела
-- заказывает грузоперевозку от отдела, а не от площадки, и «свой объект» ему не назначить.
CREATE TABLE departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Код уникален, как у объектов строительства: по нему отдел называют в разговоре и в документах.
CREATE UNIQUE INDEX departments_code_unique ON departments (code);
-- Поиск по наименованию — тем же способом, что в остальных справочниках.
CREATE INDEX departments_name_trgm ON departments USING gin (name gin_trgm_ops);

-- Отделы учётки — многие-ко-многим, как объекты (миграция 0063): человек ведёт снабжение и АХО
-- сразу, а руководитель отвечает за несколько подразделений.
CREATE TABLE user_departments (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES departments (id) ON DELETE CASCADE,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Пара и есть запись: дважды привязать учётку к одному отделу нельзя.
  PRIMARY KEY (user_id, department_id)
);

-- «Кто в отделе» — вопрос со стороны карточки отдела: в ней показываются руководители, и они же
-- правятся оттуда. PK покрывает только проход от учётки.
CREATE INDEX user_departments_department_idx ON user_departments (department_id);

-- Тестовые данные: справочник заводится пустым только там, где его наполняет заказчик своими
-- реквизитами (organizations, 0060). Здесь наоборот — без пары отделов не проверить ни роли, ни
-- визирование, а лишние строки администратор деактивирует одним нажатием.
INSERT INTO departments (code, name) VALUES
  ('dept_1', 'Отдел1'),
  ('dept_2', 'Отдел2');

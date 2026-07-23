-- Этап 2, упрощение: убираем отдельный справочник машин и экземпляры контейнеров.
-- Самосвалы возвращаются в container_types, различаются колонкой type ('cont'/'truck').
-- Заявка «Замена» опирается на заявку установки (install_request_id), а не на экземпляр.

-- 1. Колонка-дискриминатор вида записи справочника.
CREATE TYPE container_kind AS ENUM ('cont', 'truck');
ALTER TABLE container_types ADD COLUMN type container_kind NOT NULL DEFAULT 'cont';

-- 2. Возвращаем самосвалы в container_types (type='truck').
INSERT INTO container_types (code, name, sort_order, type) VALUES
  ('dump_truck_25', 'Самосвал 25 м³', 50, 'truck'),
  ('dump_truck_36', 'Самосвал 36 м³', 60, 'truck')
ON CONFLICT (code) DO NOTHING;

-- 3. Сброс заявок (dev): ссылки на containers/machine_types несовместимы с новой моделью.
--    CASCADE очищает request_files и request_status_history.
TRUNCATE waste_requests CASCADE;

-- 4. Полиморфные поля заявки: убираем ссылки на удаляемые таблицы, добавляем ссылку
--    на заявку установки заменяемого контейнера (self-reference).
ALTER TABLE waste_requests
  DROP COLUMN container_id,
  DROP COLUMN machine_type_id,
  ADD COLUMN install_request_id uuid REFERENCES waste_requests (id) ON DELETE SET NULL;

-- 5. Удаляем ставшие ненужными таблицы.
DROP TABLE containers;
DROP TABLE machine_types;

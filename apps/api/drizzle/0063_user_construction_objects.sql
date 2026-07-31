-- Учётка работает на нескольких объектах: связь «учётка ↔ объект», многие-ко-многим, вместо
-- колонки users.construction_object_id.
--
-- Один штаб ведёт несколько площадок, и руководитель строительства отвечает сразу за куст
-- объектов — колонка позволяла выдать ровно один, и второй объект приходилось закрывать второй
-- учёткой с тем же человеком за ней. Отдельная таблица, а не массив в users: набор правится с
-- обеих сторон (карточка учётки и, позже, карточка объекта), и привязке нужны свои created_by
-- и created_at.
CREATE TABLE user_construction_objects (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  construction_object_id uuid NOT NULL REFERENCES construction_objects (id) ON DELETE CASCADE,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Пара и есть запись: дважды привязать учётку к одному объекту нельзя.
  PRIMARY KEY (user_id, construction_object_id)
);

-- Обратная сторона связи («кто работает на объекте») — отдельным индексом: PK покрывает только
-- проход от учётки.
CREATE INDEX user_construction_objects_object_idx
  ON user_construction_objects (construction_object_id);

-- Перенос: один объект учётки становится набором из одного объекта. created_by пуст — привязку
-- завёл не человек, а миграция, и приписывать её администратору было бы неправдой в аудите.
INSERT INTO user_construction_objects (user_id, construction_object_id)
SELECT id, construction_object_id
FROM users
WHERE construction_object_id IS NOT NULL;

-- Инвариант «объектной роли обязателен объект» (миграция 0050) базой больше не держится:
-- CHECK читает только колонки своей строки, а набор объектов лежит в другой таблице. Проверка
-- переезжает в API (routes/users.ts) и закрепляется тестом — это осознанная цена перехода,
-- зафиксированная в ADR 0039.
ALTER TABLE users
  DROP CONSTRAINT users_rukstroy_object_check;

ALTER TABLE users
  DROP COLUMN construction_object_id;

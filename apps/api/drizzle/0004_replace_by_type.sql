-- Этап 2, вариант B: «Замена контейнера» ссылается на тип контейнера (container_type_id),
-- установленный на объекте, а не на конкретную заявку установки. Столбец install_request_id
-- (добавленный в 0003) больше не нужен.
ALTER TABLE waste_requests DROP COLUMN install_request_id;

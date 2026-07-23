-- Наличие контейнеров на площадках: установки минус снятия по типу, FIFO по num
-- (снятие «гасит» самую старую установку). View возвращает id «присутствующих» заявок установки.
-- Замена (container_replace) — свап, на количество не влияет и здесь не участвует.
CREATE VIEW present_containers AS
WITH ranked_installs AS (
  SELECT
    id,
    object_id,
    container_type_id,
    row_number() OVER (PARTITION BY object_id, container_type_id ORDER BY num) AS rn
  FROM waste_requests
  WHERE request_type = 'container_install'
    AND deleted_at IS NULL
    AND status <> 'cancelled'
),
removal_counts AS (
  SELECT object_id, container_type_id, count(*) AS cnt
  FROM waste_requests
  WHERE request_type = 'container_removal'
    AND deleted_at IS NULL
    AND status <> 'cancelled'
  GROUP BY object_id, container_type_id
)
SELECT ri.id, ri.object_id, ri.container_type_id
FROM ranked_installs ri
LEFT JOIN removal_counts rc
  ON rc.object_id = ri.object_id AND rc.container_type_id = ri.container_type_id
WHERE ri.rn > COALESCE(rc.cnt, 0);

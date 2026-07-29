-- Возврат техники при активации арендодателя (ADR 0018 §14).
--
-- Деактивация арендодателя гасит его технику (0038). Активация должна поднять ровно ту, что
-- погасла вместе с ним, — и не трогать позиции, выключенные отдельно и раньше. Для этого нужно
-- помнить причину выключения: без метки «включить всё» подняло бы и то, что человек выключил
-- сам, а «не включать ничего» заставляло бы поднимать десятки строк руками.

ALTER TABLE vehicles
  ADD COLUMN deactivated_with_lessor boolean NOT NULL DEFAULT false;

ALTER TABLE vehicles
  -- Метка осмысленна только у аренды: у собственной машины арендодателя нет.
  ADD CONSTRAINT vehicles_deactivated_with_lessor_own_check CHECK (
    ownership = 'rental' OR NOT deactivated_with_lessor
  ),
  -- Метка живёт только вместе с выключенным состоянием: при возврате она снимается тем же
  -- UPDATE, что включает строку, поэтому промежуточного состояния «активна и помечена» нет.
  ADD CONSTRAINT vehicles_deactivated_with_lessor_status_check CHECK (
    NOT deactivated_with_lessor OR status <> 'active'
  );

-- Выборка «что вернуть при активации арендодателя».
CREATE INDEX vehicles_deactivated_with_lessor_idx ON vehicles (lessor_id)
  WHERE deactivated_with_lessor;

-- ADR 0107, owner decision S-13: live-order linear-mode switching is permanent. The comments
-- installed by 0137 describe a cancelled removal sequence; replace metadata without changing data.
COMMENT ON COLUMN vehicle_requests.is_linear_frozen IS
  'Previous linear mode for a request caught in progress by a vehicle type mode switch. NULL means the request follows the live vehicle type. The value is cleared when the request leaves In progress. Switching under live requests remains available, so the column is permanent (ADR 0107, S-13).';

COMMENT ON COLUMN vehicle_requests.linear_frozen_at IS
  'Time of the switch that left this in-progress request on its previous linear mode. It is cleared together with is_linear_frozen. Switching under live requests remains available (ADR 0107, S-13).';

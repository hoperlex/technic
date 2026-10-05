import { useState, type ReactNode } from 'react';
import { FuelNormsModal } from '../ui/FuelNormsModal';

interface Target {
  id: string | null;
  label?: string;
}

export interface FuelNormDirectoryController {
  open: (target: Target) => void;
  node: ReactNode;
}

/** Keep the fuel-norm directory target with its modal so both registry entry points share it. */
export function useFuelNormDirectory(): FuelNormDirectoryController {
  const [target, setTarget] = useState<Target | null>(null);

  return {
    open: setTarget,
    node: (
      <FuelNormsModal
        open={target !== null}
        vehicleId={target?.id ?? null}
        vehicleLabel={target?.label}
        onClose={() => setTarget(null)}
      />
    ),
  };
}

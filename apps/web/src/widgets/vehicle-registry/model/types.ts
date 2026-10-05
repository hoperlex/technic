import type { VehicleDto, VehicleOwnership } from '@technic/contracts';

export interface VehicleRegistryActions {
  canRestore: boolean;
  create: (preferredOwnership?: VehicleOwnership) => void;
  edit: (record: VehicleDto) => void;
  remove: (record: VehicleDto) => void;
  restore: (id: string) => void;
  purge: {
    allowed: boolean;
    pending: boolean;
    confirm: (id: string, label: string) => void;
  };
}

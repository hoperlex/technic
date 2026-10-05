import type { CounterpartyDto } from '@technic/contracts';

export interface CounterpartyRegistryActions {
  canSeeArchive: boolean;
  canRestore: boolean;
  create: () => void;
  edit: (record: CounterpartyDto) => void;
  remove: (record: CounterpartyDto) => void;
  restore: (id: string) => void;
  purge: {
    allowed: boolean;
    pending: boolean;
    confirm: (id: string, label: string) => void;
  };
}

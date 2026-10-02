import type { CredentialTypeCode, DriverDto } from '@technic/contracts';

export interface DriverRegistryActions {
  canWrite: boolean;
  create: () => void;
  edit: (record: DriverDto) => void;
  replaceDocument: (record: DriverDto, type?: CredentialTypeCode) => void;
  remove: (record: DriverDto) => void;
  purge: {
    allowed: boolean;
    pending: boolean;
    confirm: (id: string, name: string) => void;
  };
}

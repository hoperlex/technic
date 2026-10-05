import type { ReactNode } from 'react';
import type { Dayjs } from 'dayjs';
import type { RequestType, WasteRequestDto } from '@technic/contracts';
import type { FilterOption } from '@shared/ui';

export interface WasteRequestEditorFile {
  contentType: string;
  filename: string;
  id: string;
  isNew: boolean;
  size: number;
}

export interface WasteRequestFormValues {
  comment?: string;
  containerGroupKey?: string;
  containersCount?: number;
  containerTypeId?: string;
  deliveryDate: Dayjs;
  deliveryTime?: string;
  objectId: string;
  operatorCounterpartyId?: string;
  ownerMismatchReason?: string;
  requestType: RequestType;
  responsibleName?: string;
  responsiblePhone?: string;
  volumeM3?: number;
  wasteTypeId?: string;
}

export interface SavedOperator {
  id: string | null;
  name: string | null;
}

export interface WasteRequestEditorSources {
  containerTypes: {
    cont: FilterOption[];
    loading: boolean;
  };
  objectFieldDisabled: boolean;
  objectOptions: FilterOption[];
  objectsLoading: boolean;
  operatorOptionsFor: (objectId: string | undefined, assigned?: SavedOperator) => FilterOption[];
  operatorsLoading: boolean;
  soleObjectId?: string;
  wasteTypes: {
    loading: boolean;
    options: FilterOption[];
  };
}

export interface WasteRequestEditorController {
  actions: {
    create: () => void;
    edit: (request: WasteRequestDto) => void;
  };
  node: ReactNode;
}

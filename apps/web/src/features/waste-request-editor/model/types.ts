import type { ReactNode } from 'react';
import type { Dayjs } from 'dayjs';
import type { RequestType, WasteRequestDto } from '@technic/contracts';
import type { FilterOption } from '@shared/ui';

export interface WasteRequestEditorFile {
  /** Needed by the file link: photos and PDFs open in the viewer, anything else downloads. */
  contentType: string;
  filename: string;
  id: string;
  isNew: boolean;
  size: number;
}

export interface WasteRequestFormValues {
  comment?: string;
  /**
   * Which container is replaced or removed: the presence group "type + owner" as one value
   * (ADR 0054). Installation has no such field: it brings its own container and picks the type
   * from the directory.
   */
  containerGroupKey?: string;
  containersCount?: number;
  containerTypeId?: string;
  deliveryDate: Dayjs;
  /** Optional HH:mm time; empty means "on this date, any time". */
  deliveryTime?: string;
  objectId: string;
  /** Waste operator (counterparty); may stay empty and be assigned when work starts. */
  operatorCounterpartyId?: string;
  /** Reason for removing another operator's container; the field exists only on a mismatch. */
  ownerMismatchReason?: string;
  requestType: RequestType;
  /** Who receives the truck on site and at which phone (migration 0062). */
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

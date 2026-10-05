/**
 * Driver: the person put behind the wheel, in whose name waybills and ESM-2 forms are issued.
 * Consumers import only @entities/driver — internal modules stay hidden, so the slice can be
 * restructured without touching its consumers.
 */
export { driversApi } from './api/driversApi';
export { driverKeys, licenseCategoryKeys } from './api/keys';
export { machinistOptionsQuery } from './api/queries';
export { driverErrorMessage } from './model/errorMessage';
export { useDriverOptions } from './model/useDriverOptions';
export { useLicenseCategoryOptions } from './model/useLicenseCategoryOptions';
export {
  documentBadge,
  documentCardLines,
  documentColumns,
  documentPrimary,
  documentsBlock,
} from './ui/driverDocuments';
export type { DriverDocumentActions } from './ui/driverDocuments';

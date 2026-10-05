/**
 * Public entry for hooks and utilities that do not own portal rules. External consumers use
 * @shared/lib so boundary lint can distinguish the supported contract from private module access.
 */
export * from './avatar';
export * from './calendarDays';
export * from './chunkRecovery';
export * from './dayBounds';
export * from './dayjs';
export * from './monthText';
export * from './errors';
export * from './format';
export * from './idempotency';
export * from './listParamsStore';
export * from './numberText';
export * from './objectScopeAnswers';
export * from './selectOptions';
export * from './siderCollapsed';
export * from './table';
export * from './useAddressParam';
export * from './useElementSize';
export * from './useIsMobile';
export * from './useListParams';
export * from './useOpenedRecord';
export * from './useScrollIntoViewWhen';
export * from './usePruneMissingFilters';
export * from './useSoleOptionAutoSelect';
export * from './useVersionCheck';

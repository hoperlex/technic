/**
 * Публичный вход сегмента: хуки и утилиты, не знающие правил портала. Снаружи берут `@shared/lib`,
 * а не отдельные модули внутри — так линт границ отличает пользование от залезания внутрь.
 */
export * from './avatar';
export * from './dayBounds';
export * from './dayjs';
export * from './errors';
export * from './idempotency';
export * from './listParamsStore';
export * from './selectOptions';
export * from './siderCollapsed';
export * from './table';
export * from './useAddressParam';
export * from './useElementSize';
export * from './useIsMobile';
export * from './useListParams';
export * from './useOpenedRecord';
export * from './usePruneMissingFilters';
export * from './useSoleOptionAutoSelect';
export * from './useVersionCheck';

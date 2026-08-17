/**
 * Публичный вход сегмента: хуки и утилиты, не знающие правил портала. Снаружи берут `@shared/lib`,
 * а не отдельные модули внутри — так линт границ отличает пользование от залезания внутрь.
 */
export * from './avatar';
export * from './dayjs';
export * from './errors';
export * from './selectOptions';
export * from './table';
export * from './useAddressParam';
export * from './useElementSize';
export * from './useIsMobile';
export * from './useListParams';
export * from './useOpenedRecord';
export * from './useSoleOptionAutoSelect';
export * from './useVersionCheck';

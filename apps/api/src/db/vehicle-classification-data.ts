// Этап 2: утверждённая типизация ТС (источник GPT-разбора двух Excel).
// Единый источник истины для тестов и анализатора; SQL-сид (0010) зеркалит эти данные.
// Самосвалы (dump_truck) и bunker_carrier здесь ОТСУТСТВУЮТ намеренно.

export type VehicleKindCode = 'special_equipment' | 'freight_transport';

export interface VehicleParentSeed {
  kindCode: VehicleKindCode;
  code: string;
  name: string;
  isActive: boolean;
}

export interface VehicleSubtypeSeed {
  kindCode: VehicleKindCode;
  parentCode: string;
  code: string;
  name: string;
  isActive: boolean;
  /** Число активных экземпляров со второго листа (06.26-06.27). */
  activeCount: number;
}

export const VEHICLE_PARENT_TYPES: readonly VehicleParentSeed[] = [
  // Спецтехника
  { kindCode: 'special_equipment', code: 'cranes', name: 'Краны', isActive: true },
  { kindCode: 'special_equipment', code: 'loaders', name: 'Погрузчики', isActive: true },
  { kindCode: 'special_equipment', code: 'excavators', name: 'Экскаваторы', isActive: true },
  { kindCode: 'special_equipment', code: 'road_construction_machinery', name: 'Дорожно-строительная техника', isActive: false },
  { kindCode: 'special_equipment', code: 'other_special_equipment', name: 'Прочая спецтехника', isActive: false },
  // Грузоперевозки
  { kindCode: 'freight_transport', code: 'road_transport', name: 'Автомобильный транспорт', isActive: true },
  { kindCode: 'freight_transport', code: 'kmu_transport', name: 'Транспорт с КМУ', isActive: true },
  { kindCode: 'freight_transport', code: 'specialized_transport', name: 'Специализированный транспорт', isActive: true },
  { kindCode: 'freight_transport', code: 'trailer_equipment', name: 'Прицепная техника', isActive: false },
] as const;

export const VEHICLE_SUBTYPES: readonly VehicleSubtypeSeed[] = [
  // cranes
  { kindCode: 'special_equipment', parentCode: 'cranes', code: 'truck_crane', name: 'Автокран', isActive: true, activeCount: 13 },
  { kindCode: 'special_equipment', parentCode: 'cranes', code: 'pneumatic_tire_crane', name: 'Пневмоколёсный кран', isActive: true, activeCount: 1 },
  { kindCode: 'special_equipment', parentCode: 'cranes', code: 'self_propelled_crane', name: 'Самоходный стреловой кран', isActive: true, activeCount: 1 },
  // loaders
  { kindCode: 'special_equipment', parentCode: 'loaders', code: 'forklift', name: 'Вилочный погрузчик', isActive: true, activeCount: 4 },
  { kindCode: 'special_equipment', parentCode: 'loaders', code: 'skid_steer_loader', name: 'Мини-погрузчик', isActive: true, activeCount: 12 },
  { kindCode: 'special_equipment', parentCode: 'loaders', code: 'telescopic_loader', name: 'Телескопический погрузчик', isActive: true, activeCount: 17 },
  { kindCode: 'special_equipment', parentCode: 'loaders', code: 'front_loader', name: 'Фронтальный погрузчик', isActive: true, activeCount: 4 },
  // excavators
  { kindCode: 'special_equipment', parentCode: 'excavators', code: 'wheeled_excavator', name: 'Колёсный экскаватор', isActive: true, activeCount: 2 },
  { kindCode: 'special_equipment', parentCode: 'excavators', code: 'crawler_excavator', name: 'Гусеничный экскаватор', isActive: true, activeCount: 2 },
  { kindCode: 'special_equipment', parentCode: 'excavators', code: 'backhoe_loader', name: 'Экскаватор-погрузчик', isActive: true, activeCount: 9 },
  // road_construction_machinery
  { kindCode: 'special_equipment', parentCode: 'road_construction_machinery', code: 'road_roller', name: 'Дорожный каток', isActive: false, activeCount: 0 },
  // other_special_equipment
  { kindCode: 'special_equipment', parentCode: 'other_special_equipment', code: 'municipal_machine', name: 'Коммунальная машина', isActive: false, activeCount: 0 },
  { kindCode: 'special_equipment', parentCode: 'other_special_equipment', code: 'tractor', name: 'Трактор', isActive: false, activeCount: 0 },
  // road_transport
  { kindCode: 'freight_transport', parentCode: 'road_transport', code: 'passenger_car', name: 'Легковой автомобиль', isActive: true, activeCount: 6 },
  { kindCode: 'freight_transport', parentCode: 'road_transport', code: 'light_truck', name: 'Малотоннажный грузовой автомобиль', isActive: true, activeCount: 4 },
  { kindCode: 'freight_transport', parentCode: 'road_transport', code: 'tractor_unit', name: 'Седельный тягач', isActive: true, activeCount: 10 },
  // kmu_transport
  { kindCode: 'freight_transport', parentCode: 'kmu_transport', code: 'light_kmu_truck', name: 'Малотоннажный автомобиль с КМУ', isActive: true, activeCount: 3 },
  { kindCode: 'freight_transport', parentCode: 'kmu_transport', code: 'heavy_kmu_truck', name: 'Тяжёлый автомобиль с КМУ', isActive: true, activeCount: 3 },
  // specialized_transport
  { kindCode: 'freight_transport', parentCode: 'specialized_transport', code: 'multilift', name: 'Мультилифт', isActive: true, activeCount: 2 },
  { kindCode: 'freight_transport', parentCode: 'specialized_transport', code: 'garbage_truck', name: 'Мусоровоз', isActive: false, activeCount: 0 },
  // trailer_equipment
  { kindCode: 'freight_transport', parentCode: 'trailer_equipment', code: 'semi_trailer', name: 'Полуприцеп', isActive: false, activeCount: 0 },
  { kindCode: 'freight_transport', parentCode: 'trailer_equipment', code: 'trailer', name: 'Прицеп', isActive: false, activeCount: 0 },
] as const;

export type ResolutionStrategy = 'direct' | 'by_model' | 'by_registry';

export interface VehicleSourceMappingSeed {
  sourceCode: string;
  sourceName: string;
  /** Целевой тип: конечный подтип (direct) или родитель (неоднозначные). */
  targetCode: string;
  strategy: ResolutionStrategy;
  requiresInstanceResolution: boolean;
  comment: string;
}

/** Источник строк «Тип ТС» — активный лист работавшей техники. */
export const VEHICLE_SOURCE = 'worked_list_06_26_06_27';

export const VEHICLE_SOURCE_MAPPINGS: readonly VehicleSourceMappingSeed[] = [
  // Однозначные → конечный подтип
  { sourceCode: VEHICLE_SOURCE, sourceName: 'Автокраны', targetCode: 'truck_crane', strategy: 'direct', requiresInstanceResolution: false, comment: '' },
  { sourceCode: VEHICLE_SOURCE, sourceName: 'Кран пневмоколесный', targetCode: 'pneumatic_tire_crane', strategy: 'direct', requiresInstanceResolution: false, comment: '' },
  { sourceCode: VEHICLE_SOURCE, sourceName: 'Кран самоходный', targetCode: 'self_propelled_crane', strategy: 'direct', requiresInstanceResolution: false, comment: '' },
  { sourceCode: VEHICLE_SOURCE, sourceName: 'Легковые автомобили', targetCode: 'passenger_car', strategy: 'direct', requiresInstanceResolution: false, comment: '' },
  { sourceCode: VEHICLE_SOURCE, sourceName: 'Тягачи с полуприцепами', targetCode: 'tractor_unit', strategy: 'direct', requiresInstanceResolution: false, comment: '' },
  { sourceCode: VEHICLE_SOURCE, sourceName: 'Фронтальные погрузчики', targetCode: 'front_loader', strategy: 'direct', requiresInstanceResolution: false, comment: '' },
  { sourceCode: VEHICLE_SOURCE, sourceName: 'Экскаватор колесный', targetCode: 'wheeled_excavator', strategy: 'direct', requiresInstanceResolution: false, comment: '' },
  { sourceCode: VEHICLE_SOURCE, sourceName: 'Экскаваторы гусеничные', targetCode: 'crawler_excavator', strategy: 'direct', requiresInstanceResolution: false, comment: '' },
  { sourceCode: VEHICLE_SOURCE, sourceName: 'Катки', targetCode: 'road_roller', strategy: 'direct', requiresInstanceResolution: false, comment: '' },
  // Неоднозначные → родитель (требуют анализа экземпляра)
  { sourceCode: VEHICLE_SOURCE, sourceName: 'Вилочные погрузчики и минипогрузчики', targetCode: 'loaders', strategy: 'by_model', requiresInstanceResolution: true, comment: 'Разделяется на вилочный/мини/телескопический по модели' },
  { sourceCode: VEHICLE_SOURCE, sourceName: 'Грузовые малотоннажные автомобили', targetCode: 'road_transport', strategy: 'by_registry', requiresInstanceResolution: true, comment: 'Часть — малотоннажные с КМУ (light_kmu_truck) по реестру' },
  { sourceCode: VEHICLE_SOURCE, sourceName: 'Тяжелые манипуляторы', targetCode: 'kmu_transport', strategy: 'by_registry', requiresInstanceResolution: true, comment: 'МАЗ-МКМВ9В У702/У782 фактически мультилифты' },
  { sourceCode: VEHICLE_SOURCE, sourceName: 'Бункеровозы, мультилифты', targetCode: 'specialized_transport', strategy: 'by_registry', requiresInstanceResolution: true, comment: 'Мультилифт/мусоровоз; самосвал исключён' },
  { sourceCode: VEHICLE_SOURCE, sourceName: 'Экскаваторы-погрузчики', targetCode: 'excavators', strategy: 'by_registry', requiresInstanceResolution: true, comment: 'JCB TLT30C фактически вилочный погрузчик' },
] as const;

/** Исходное значение «Тип ТС», исключаемое полностью (модуль вывоза мусора). */
export const EXCLUDED_SOURCE_NAME = 'Самосвалы';

/**
 * Ручные исправления ошибочной исходной классификации — по госномеру/модели.
 * Используются анализатором как override поверх source-mapping.
 */
export interface VehicleInstanceOverride {
  match: { plate?: string; modelIncludes?: string };
  targetCode: string;
  comment: string;
}

export const VEHICLE_INSTANCE_OVERRIDES: readonly VehicleInstanceOverride[] = [
  { match: { plate: 'У702АС777' }, targetCode: 'multilift', comment: 'МАЗ-МКМВ9В: в файле «тяжёлые манипуляторы», по реестру — мультилифт' },
  { match: { plate: 'У782АС777' }, targetCode: 'multilift', comment: 'МАЗ-МКМВ9В: в файле «тяжёлые манипуляторы», по реестру — мультилифт' },
  { match: { modelIncludes: 'JCB TLT30C' }, targetCode: 'forklift', comment: 'В файле «экскаваторы-погрузчики», фактически вилочный погрузчик' },
  { match: { modelIncludes: 'ГАЗ-33106' }, targetCode: 'light_kmu_truck', comment: 'ГАЗ-33106 с КМУ' },
  { match: { modelIncludes: 'JAC' }, targetCode: 'light_kmu_truck', comment: 'JAC с КМУ' },
] as const;

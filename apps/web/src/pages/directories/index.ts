import { lazy } from 'react';

export const DirectoriesPage = lazy(() =>
  import('./DirectoriesPage').then((module) => ({ default: module.DirectoriesPage })),
);

// These public scenario entries must be lazy too: static re-exports retain their registries in
// the initial bundle even though App only asks this entry for the DirectoriesPage factory.
export const CounterpartiesTab = lazy(() =>
  import('./CounterpartiesTab').then((module) => ({ default: module.CounterpartiesTab })),
);

export const VehiclesTab = lazy(() =>
  import('./VehiclesTab').then((module) => ({ default: module.VehiclesTab })),
);

export const WasteTariffsTab = lazy(() =>
  import('./WasteTariffsTab').then((module) => ({ default: module.WasteTariffsTab })),
);

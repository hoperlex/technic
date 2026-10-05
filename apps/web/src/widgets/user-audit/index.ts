import { lazy } from 'react';

/** User-account audit registry and one-account history path (ADR 0088, ADR 0109). */
export const UsersAuditTab = lazy(() =>
  import('./ui/UsersAuditTab').then((module) => ({ default: module.UsersAuditTab })),
);
export { UserAuditPathDrawer, type AuditTarget } from './ui/UserAuditPathDrawer';

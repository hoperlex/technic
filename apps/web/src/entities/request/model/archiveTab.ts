import type { Permission } from '@technic/contracts';

/**
 * May this role see the archive tab of a request list (ADR 0070, ADR 0063) — by the permission
 * matrix, an administrator.
 *
 * Lives in the slice both kinds of request may read, and that address is the whole reason this
 * slice exists for it. Three modules ask the question directly — equipment orders, mechanization
 * and office equipment — and two link wrappers ask it before handing out an address, one in each
 * request slice. A copy per asker would drift, and the drift would show as a link offered to
 * somebody who then lands on a tab they may not open: exactly the failure the wrappers prevent.
 */
export const canSeeArchiveTab = (can: (permission: Permission) => boolean): boolean =>
  can('archive.read');

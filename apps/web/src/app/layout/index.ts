/**
 * Public entry of the portal shell: sider (bottom navigation on a phone), account menu and the
 * outlet every section page renders into. `AppLayout`, `MobileAppBar` and `MobileNav` are one unit —
 * the mobile pair has no consumer but the shell, and the shell has no consumer but `App.tsx`.
 *
 * The unit lies in a SUBDIRECTORY of the layer, not in `src/app` itself, and that is a boundary
 * requirement rather than taste: elements of the matrix are matched as `src/<layer>/*`, so a file
 * lying directly in a layer directory is classified as nothing and is then checked by no boundary
 * rule at all. This unit reaches into `widgets`, `features`, `entities` and `shared`, so it is
 * exactly what must stay under the matrix. `widgets/app-layout` is no address for it either:
 * `@widgets/utility-menu` would be a neighbour there, and neighbours are forbidden by default.
 */
export { AppLayout } from './AppLayout';

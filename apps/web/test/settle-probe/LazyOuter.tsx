import { lazy, Suspense } from 'react';

/*
 * A separate module, not a component of the test file: the probe needs an import that is not in
 * the module cache yet, the way a section's page chunk is cold on its first render in a worker.
 */
const LazyInner = lazy(() => import('./LazyInner').then((m) => ({ default: m.LazyInner })));

/**
 * A lazily loaded page that renders a lazily loaded tab under its own boundary, as every section
 * page does (`AsyncTabs`). The tab's import starts only when this module has arrived and rendered.
 */
export function LazyOuter({ log }: { log: string[] }) {
  return (
    <Suspense fallback={<div>tab loading</div>}>
      <LazyInner log={log} />
    </Suspense>
  );
}

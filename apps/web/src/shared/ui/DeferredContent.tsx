import { useEffect, useState, type ReactNode } from 'react';
import { AsyncContent } from './AsyncContent';

/**
 * Delay the first mount, not every reopening. Some window owners keep sibling reports after
 * closing their form, and their effects must still receive the latest closed props. Unmounting
 * on !active would erase those reports and alter the established form/reset lifecycle.
 */
export function DeferredContent({
  active,
  children,
  fallback,
}: {
  active: boolean;
  children: ReactNode;
  fallback: ReactNode;
}) {
  const [visited, setVisited] = useState(active);
  useEffect(() => {
    if (active) setVisited(true);
  }, [active]);
  return active || visited ? <AsyncContent fallback={fallback}>{children}</AsyncContent> : null;
}

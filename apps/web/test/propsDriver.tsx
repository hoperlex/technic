import { useState, type ComponentType } from 'react';
import { act } from '@testing-library/react';
import type { QueryClient } from '@tanstack/react-query';
import { renderWithUser, type RenderOptions } from './render';

/**
 * Render a component whose props the test then changes the way a parent does — a reread
 * delivering a new record object, a window closed and opened again.
 *
 * Not `rerender`: `renderWithUser` wraps the screen into providers inline, and `rerender` would
 * replace the whole tree — every step would mount a fresh form and prove nothing about the old one.
 */
export function renderWithProps<P extends object>(
  Component: ComponentType<P>,
  initial: P,
  options: RenderOptions = {},
): { update: (next: Partial<P>) => void; queryClient: QueryClient } {
  let set: ((next: P) => void) | null = null;
  let current = initial;
  function Driver() {
    const [props, setProps] = useState(initial);
    set = setProps;
    return <Component {...props} />;
  }
  const { queryClient } = renderWithUser(<Driver />, options);
  return {
    queryClient,
    update: (next) => {
      current = { ...current, ...next };
      act(() => set!(current));
    },
  };
}

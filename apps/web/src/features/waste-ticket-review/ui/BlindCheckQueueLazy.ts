import { lazy } from 'react';

/**
 * The independent queue stays a separate chunk. It sits in its own module so that the public entry
 * is a plain list of re-exports: the page that only mounts the queue then does not pull the card
 * components (ticket panel, recognition state) through the same entry.
 */
export const BlindCheckQueue = lazy(() =>
  import('./BlindCheckQueue').then((module) => ({ default: module.BlindCheckQueue })),
);

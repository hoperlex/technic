let failed = false;
const listeners = new Set<() => void>();

/** A rejected lazy import stays rejected in React's module cache until the document is reloaded. */
export function requireChunkReload(): void {
  if (failed) return;
  failed = true;
  for (const listener of listeners) listener();
}

export function hasChunkLoadFailure(): boolean {
  return failed;
}

export function onChunkLoadFailure(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Vite also reports preload failures as an event; these messages cover direct import rejections. */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading chunk .+ failed|Unable to preload CSS/i.test(
    message,
  );
}

// Reload remains an explicit user action: automatic retries can loop offline and discard forms.
export function reloadPage(): void {
  window.location.reload();
}

export function __resetChunkLoadFailureForTests(): void {
  failed = false;
  for (const listener of listeners) listener();
}

import { createContext, useContext, type ReactNode } from 'react';

const WindowActivity = createContext(true);

/**
 * Put the scope OUTSIDE the modal and its consumer inside. rc-dialog caches children during
 * closing animations; context crosses that memo so a late import cannot start a closed window's
 * requests or advance read cursors. A prop on the cached child would keep the old open value.
 */
export function WindowActivityScope({ open, children }: { open: boolean; children: ReactNode }) {
  return <WindowActivity.Provider value={open}>{children}</WindowActivity.Provider>;
}

/** Only for bodies whose existing close policy discards their interaction state. */
export function ActiveWindowContent({ children }: { children: ReactNode }) {
  return useContext(WindowActivity) ? children : null;
}

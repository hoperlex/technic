import { useSearchParams } from 'react-router';

/**
 * The open «График» window in the «Водители» tab address: `?schedule=<personId>&scheduleMonth=…`.
 *
 * In the address, like the readings journal (`journalAddress.ts`), for two reasons. A link «the
 * month of Petrov» is sent to a colleague; and the window's own row link leads to the intake
 * registry on another tab, so Back must bring the window back on the month it was left at — state
 * in `useState` would reopen it on the current month or not at all.
 *
 * The month key is absent until an arrow is pressed: the default month is the server's current
 * Moscow month, and writing the browser's guess of it into the link would pin a stale month to it.
 */

const PERSON = 'schedule';
const MONTH = 'scheduleMonth';
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface DriverScheduleAddress {
  /** The person whose month is open; `null` — no window. */
  personId: string | null;
  /** The month asked for; `null` — the server's current month. */
  month: string | null;
  href: (personId: string) => string;
  /** Opening is navigation: Back closes the window instead of leaving the page. */
  open: (personId: string) => void;
  /** Stepping months is not navigation: Back returns to the previous screen, not the last month. */
  setMonth: (month: string) => void;
  close: () => void;
}

/**
 * `allowed` is "this tab is the visible one": a hidden tab stays mounted (`PageTabs`), and the
 * window must not hang over the tab the user switched to.
 */
export function useDriverScheduleAddress(allowed: boolean): DriverScheduleAddress {
  const [params, setParams] = useSearchParams();

  const patch = (change: (next: URLSearchParams) => void, replace: boolean) => {
    const next = new URLSearchParams(params);
    change(next);
    setParams(next, { replace });
  };
  const withPerson = (personId: string) => {
    const next = new URLSearchParams(params);
    next.set(PERSON, personId);
    // Another person's window starts on the current month, not on the month left for the previous.
    next.delete(MONTH);
    return next;
  };

  const rawMonth = params.get(MONTH) ?? '';
  return {
    personId: allowed ? params.get(PERSON) || null : null,
    // A malformed month from a pasted link falls back to the current one rather than a 400.
    month: MONTH_PATTERN.test(rawMonth) ? rawMonth : null,
    href: (personId) => `?${withPerson(personId).toString()}`,
    open: (personId) => setParams(withPerson(personId), { replace: false }),
    setMonth: (month) => patch((next) => next.set(MONTH, month), true),
    close: () =>
      patch((next) => {
        next.delete(PERSON);
        next.delete(MONTH);
      }, true),
  };
}

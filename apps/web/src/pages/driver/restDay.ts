import type { DriverAssignmentDto } from '@technic/contracts';

/**
 * Whether the day's task asks for any reading (ADR 0242). The server marks a Sunday shift of a
 * weekly sheet or of a site-day route optional; a day of optional shifts only is a rest day — no
 * debt in the header, «Выходной» over the form. The portal holds no weekday rule of its own, and the
 * day line and the debt line ask this one function.
 *
 * A module of its own, with nothing but a type import: `DriverLayout` sits in the route table's
 * static imports, and pulling `dayState` (react-query, the cabinet entity) in after it measured
 * +510 B gzip on every garage route.
 */
export function asksReadings(assignment: DriverAssignmentDto): boolean {
  return assignment.entries.some((entry) => entry.readingOptional !== true);
}

/**
 * Filter of the "Заказ ТС" tables by the ownership of the request's vehicle: own fleet or rental.
 *
 * A slice of its own, not a part of `vehicle-request-filters`, on purpose: that index also exports
 * the vehicle and lessor filters, which pull the fleet directory query into whoever imports it.
 * The "On site" and archive tabs never loaded those, and a shared index made each of them pay about
 * 3 KB gzip of the bundle budget for a filter that needs only a select and the session.
 *
 * Four consumers ask the same question: the requests feed, the closed-requests journal, "On site"
 * and the archive — one hook keeps the lessor rule and the wording identical on all of them.
 */
export { useOwnershipFilter } from './model/useOwnershipFilter';

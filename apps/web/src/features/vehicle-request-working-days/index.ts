/**
 * Working Sundays of a vehicle request (ADR 0246): the card's list of the term's Sundays with the
 * «Рабочая смена» switch. Outside the slice it is taken as `@features/vehicle-request-working-days`.
 *
 * A feature, not part of `entities/vehicle-request`: the switch is an action with its own rule, and
 * the entity's shared chunk should not carry it into every route that reads requests.
 */
export { WorkingSundaysView } from './ui/WorkingSundaysView';

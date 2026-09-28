/**
 * Техподдержка: куда человек идёт, когда портал повёл себя не так. Снаружи берут
 * `@entities/support` — внутренние модули слайса не видны.
 *
 * WHY A SLICE AND NOT A FOLDER SOMEWHERE ELSE. The contacts window is asked for by three layers at
 * once — `features/missing-equipment`, `widgets/utility-menu` and `pages/NoSectionsPage`. Only a
 * layer below all three may hold it, and of the two candidates the foundation is closed: the window
 * prints the phone through `formatPhone` from the contracts package, and `shared` is forbidden to
 * import contracts (`no-restricted-imports` in `eslint.config.mjs` — domain rules live in
 * `entities`, not in the foundation). So `entities` is the only lawful address, and the slice exists
 * for that reason, not because support is a stored record: there is no API and no query key here,
 * and there will be none until the portal grows its own correspondence (`docs/support-plan.md`).
 *
 * TWO REJECTED WAYS OUT, named so that the next reader does not propose them again:
 *
 * - «keep the formatted number as a string in `shared/config` and let the window live in
 *   `shared/ui`» contradicts the invariant written next to the constant itself
 *   (`apps/web/src/shared/config/support.ts`): the number is stored as ten digits, exactly as in the
 *   database (ADR 0066), «how to show it» is decided by `formatPhone` and «how to dial it» by
 *   `tel:`. A ready «+7 (986) …» string there would be a second spelling of one number, and the two
 *   would drift apart silently — which is precisely what ADR 0066 was written to stop;
 * - «pass the number as a prop from every caller» costs the window its self-sufficiency: three call
 *   sites would each decide what support's number and formatting are, and nothing would notice when
 *   one of them stopped agreeing with the other two.
 */
export { SupportContactsModal } from './ui/SupportContactsModal';

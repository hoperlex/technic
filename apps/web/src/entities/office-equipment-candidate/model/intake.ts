import { can, hasFeature, type AuthUser } from '@technic/contracts';

/** Both answers of the intake predicate; callers read them as one object, never one at a time. */
export interface CandidateIntakeAccess {
  /** The requester may report a device together with their own request (`officeEquipment.propose`). */
  canPropose: boolean;
  /** The reviewer sees the queue, edits the details and takes the three decisions (`officeEquipment.review`). */
  canReview: boolean;
}

/**
 * Who gets the equipment-report screens (plan `docs/office-equipment-candidate-plan.md`, R8, §9).
 *
 * ONE PLACE FOR BOTH SCREENS, and that is the whole reason this module exists. The portal asks two
 * questions — "does the request form show the «Report a device» window" and "is the review queue
 * visible" — but both answers are built from the same terms. Split per screen, they would drift
 * apart on the first edit of the condition: one half of the module would open while the other
 * stayed shut, and nobody would see it in a test — only in a phone call.
 *
 * THE ACCOUNT ARRIVES AS A PARAMETER, and it is not a convenience. This layer must not read the
 * session: `entities/office-equipment-candidate` importing `entities/session` is a neighbour
 * import, and the boundary rules forbid it. So every caller takes `user` from `useAuth` itself and
 * asks here — the same shape already used by `entities/service-request` (`ServiceHint`,
 * `model/waiting.ts`).
 *
 * THE PERMISSION IS ASKED OF THE CONTRACTS MATRIX (`can(subject, …)`), NOT OF THE SERVER LIST, and
 * that is a deliberate choice, not an accident of what this layer can import. The portal has two
 * oracles: the effective list the server computed (`useAuth().can`, `AuthUser.permissions`) and the
 * matrix of the contracts. In production they agree BY CONSTRUCTION — the server fills
 * `permissions` with `permissionsFor(subject)` and ships the whole subject alongside it (role,
 * addons, `grantPermissions`), so the matrix run over `AuthUser` recomputes the same answer. What
 * holds that agreement is an agreement, not a type and not a test, and the debt is written down
 * once for the whole portal as a debt, and the convergence, when it happens, goes towards the server
 * list: ADR 0106 and `docs/access-model.md` build the answer on it, and the list protects the portal
 * from a matrix version drifting inside a deploy window. Practical consequence for anyone building
 * a subject by hand: an account carrying only `permissions` is a state production never produces,
 * and here it reads as "no permission" — `officeEquipment.review` comes from a grant set, not from
 * a role, so it reaches the matrix through `grantPermissions` only.
 *
 * THE INTAKE SWITCH LIVES HERE, AND ONLY HERE (plan `docs/office-equipment-request-subject-plan.md`,
 * R10). Its value is a row of server state delivered in the session response. The portal asks that
 * answer and nothing else: it has no copy of the value — no env, no build-time constant, no local
 * state — and must never grow one, because a second source would drift from the server silently and
 * show a person a door with a 403 behind it.
 *
 * FAIL-CLOSED is the rule of `hasFeature`: no key in the list means the server considers the switch
 * off; no list at all means an older server answering, one that knows nothing about the switch (the
 * deploy window, when the portal is newer than the application). Both mean "closed" — the opposite
 * default would open intake exactly in the window the switch was built for, because the permission
 * migration is applied BEFORE the application restarts.
 *
 * THE SWITCH GATES THE ENTRANCE, NOT THE REVIEW, which is why it only guards `canPropose`. The
 * queue of already accepted reports has to stay reachable: an emergency shutdown stops the inflow,
 * but locking the review away with it would leave candidates that somebody must decide on without
 * their only door to a decision.
 */
export function candidateIntakeAccess(user: AuthUser | null | undefined): CandidateIntakeAccess {
  // Server-computed value from the session response; a missing field or a missing key both mean
  // "intake closed" (`hasFeature`). The permission is still asked: the switch opens intake for
  // those already allowed to use it, it does not stand in for the permission.
  const intakeOpen = hasFeature(user, 'office_equipment_candidate_intake');
  return {
    canPropose: intakeOpen && can(user, 'officeEquipment.propose'),
    canReview: can(user, 'officeEquipment.review'),
  };
}

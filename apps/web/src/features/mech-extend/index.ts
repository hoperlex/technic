/**
 * Rental extension with the site's visa (ADR 0171, stage 3; earlier the plain extension of plan
 * `docs/mechanization-module-plan.md`, R9, R11): the dispatcher asks for a new return date with a
 * reason, the site's visa holder approves or refuses, and the term moves with the approval.
 *
 * A slice of its own, not an item inside the issue: the extension lives by its own permissions
 * (`mechRequests.extend` to ask, `mechRequests.approve` to decide) and its own history events, so
 * it answers another question to other people.
 */
export { MechExtensionRequestModal } from './ui/MechExtensionRequestModal';
export {
  MechExtensionDecisionModal,
  type MechExtensionDecision,
} from './ui/MechExtensionDecisionModal';
export { MechExtensionStrip } from './ui/MechExtensionStrip';
export { useMechExtensionActions } from './model/useMechExtensionActions';

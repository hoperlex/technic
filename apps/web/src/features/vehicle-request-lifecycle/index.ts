/**
 * The conversation about the irreversible in a vehicle order's life: the return to "new" that
 * erases the work.
 *
 * The slice has no list of what is erased of its own any more — the server computes it (ADR 0211).
 * It holds the two halves of one conversation: the question to the server with the answer's
 * fingerprint, and the words that name the answer to the person.
 */
export { useRollbackConsequences } from './model/useRollbackConsequences';

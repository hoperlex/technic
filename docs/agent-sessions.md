# Agent sessions: one session, one stage

Every model call re-reads the whole accumulated context, so each next step of a long session costs
more than the previous one, and once the context is compacted the session works from a summary
instead of the facts. Work is therefore cut at stage boundaries and passed to a fresh session
through a file, not through the memory of a conversation. [AGENTS.md](../AGENTS.md) carries the short
form of this rule; this document is the full one.

Two roles follow it differently:

- an **executor** does one task or one stage of it: research, a plan, a wave of implementation, a
  review round. It stops at the first stage boundary;
- an **integrator** accepts work from executors (other sessions, subagents, worktrees), reviews it,
  assembles it in an integration worktree, runs the gates, commits and pushes. It works across
  item boundaries until its context is spent, then finishes the item in hand and hands the role over.

A session that was not explicitly made an integrator is an executor.

## Executor: one session — one stage

- **One session — one stage of a task.** At a stage boundary the work stops and passes to a new
  session; it does not continue in this one.
- **A stage boundary is:** a wave finished (committed, runs green); a structural stage of the task
  finished (research, a plan, a proofreading round with the owner's decisions, a gate); a plan
  approved — implementation starts in a new session, not in this one right after the approval.
  Waiting inside a stage (a test run, a workflow, the owner's answer to a survey) is not a boundary.
- **At the boundary — four steps, then stop:**
  1. Reach a stable state. The stage's changes are committed by explicit paths, in `main` or in the
     stage's worktree branch. Background runs, workflows and subagents have finished: a session is
     not closed while any of them works — its subagents die with it, and a new session cannot resume
     them. A push happens only under the push rules (read `Ждёт` first, every pushed commit builds);
     an unpushed commit is named as such in the handoff.
  2. Update the card in `.local/tasks/current.md`: the `Изменена` date, progress, tails, and a line
     `Передача: .local/handoff-<topic>-<YYYY-MM-DD>.md` under the description.
  3. Write the handoff file `.local/handoff-<topic>-<YYYY-MM-DD>.md` (see [below](#handoff-file)).
  4. Reply to the user with the stage outcome and a ready first line for the new session, in
     Russian: «Продолжи «<card title>»: этап <…>. Передача — `.local/handoff-….md`». Do not start
     the next stage.
- **The new session starts from the handoff file and the card, not from new research.** It
  spot-checks the handoff's claims through their links and redoes something only when it finds a
  discrepancy with the code.
- **A stage that does not fit into one session** (the context has grown and the boundary is far):
  stop at the nearest stable point — a commit, or an interim result written to a file — and hand over
  the same way. A small task that fits into one session whole is not split. The same session goes
  on only at the user's explicit request.

## Integrator: until the context is spent

An integrator's value is continuity across items: what was merged and in which order, which gates
are flaky, what executors reported and what was actually verified. Restarting it at every item
boundary would throw exactly that away, so stage boundaries of the items it integrates do not stop
it. It stops when its context is spent.

- **Threshold — whichever comes first:**
  - the owner says to hand over;
  - the harness reports context usage at 60% of the window or more (Codex and other harnesses that
    show it; Claude Code does not show it to the model);
  - the context has been compacted at least once — the conversation opens with a summary of
    earlier work.
- **The threshold is checked at every item boundary** and after every long wait, not only at the end.
- **Past the threshold no new item is taken:** no next wave is merged, no new review starts, no new
  executor is dispatched. The item in hand is brought to a stable state:
  1. the tip of the integration chain builds and its gates are green — or the chain is set back to
     its last green commit and the reason is written down;
  2. executors this session dispatched as subagents are either awaited or stopped at a commit point;
     each one's worktree, branch, last commit and remaining work go into the handoff — the next
     integrator cannot resume them and restarts them from that record;
  3. executors that are separate sessions (another agent, Codex) keep running; the handoff records
     where each one is and what the integrator expects from it;
  4. a push happens only if the item in hand included one and the push rules hold.
- **Then the handoff,** as for an executor (card, handoff file, first line), with integrator
  sections added to the file: the integration worktree and branch; the item queue (accepted, in
  review, waiting); executors and their state; gates and their known flakiness; what executors
  claimed and the integrator has not verified. The first line for the next integrator:
  «Прими интеграцию «<card title>». Передача — `.local/handoff-….md`».

## Handoff file

The handoff is written in English for a session that has not seen the conversation. It holds what
is expensive to find out again and points to sources instead of retelling them:

```markdown
# Handoff: <card title> — <stage> (<YYYY-MM-DD>)

## State

Branch and worktree, last commits, what is already in `origin/main`, what is uncommitted in the
tree and whose it is (the tree is shared: other sessions' changes are not yours to commit).

## Sources

Plan, owner's decisions, memory entries, the journal card — links only, no retelling.

## Done

Briefly, with commits.

## Next stage

The assignment, acceptance criteria, and obligations of the contour: gates, migrations and their
deploy window, client floor, manual deploy steps.

## Open questions to the owner

## Traps and techniques

What this stage found that the next one would otherwise rediscover.

## Frozen

What is not revisited without a new fact from the code.
```

`.local/` is outside git history, like the journal, and the handoff lives in the main working tree
even when the work happened in a worktree, so the next session finds it at one path. The card's
`Передача:` line names the latest handoff; when the card closes, its handoff files go to `Очистка`.

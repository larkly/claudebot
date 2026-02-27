# Development Process

A design-heavy, build-light pipeline. The core bet: time spent thinking is cheaper than time spent rewriting.

## Pipeline

```
idea
  → crystallized brief
    → grounded first-principles design
      → adversarial review
        → design iteration
          → atomic planning
            → parallel build
              → build validation
                → QA pipeline
                  → security review
```

## Stages

### 1. Idea

Raw input. A problem observed, a feature requested, a bug reported, a hunch. No filtering at this stage — capture it.

### 2. Crystallized Brief

Turn the idea into a concrete, bounded document:
- **What** is being built (and what is explicitly out of scope)
- **Who** it's for
- **Why** it matters (the problem, not the solution)
- **Success criteria** — how do we know it worked?

The brief exists to kill ambiguity. If two people can read it and imagine different outcomes, it's not done.

For features within an existing milestone, the PRD already covers what/who/why. The brief here is lighter: a one-paragraph scope statement and a clear success criterion are enough. The full brief format is for new milestones or significant scope changes.

### 3. Grounded First-Principles Design

Design the solution from fundamentals, not from "how did someone else do it":
- What are the actual constraints (technical, time, resource)?
- What are the core invariants that must hold?
- What is the simplest architecture that satisfies the brief?
- What are the data flows, state transitions, and failure modes?

"Grounded" means: read the existing code, understand the real system, design within it — not in a vacuum.

The design must also be codified precisely enough to serve as an agent prompt. If a Claude Code agent cannot implement the design unambiguously from the written spec alone — without asking clarifying questions — the design is not done. Ambiguity that a human would resolve through conversation becomes a defect when the builder is an agent.

In this codebase the key surfaces to read before designing are: the session manager's state machine, the streaming buffer's rate-limit logic, and the project config schema. Early in the project (before those exist), read PRD.md instead. The adversarial review checklist below is especially important here — this bot executes shell commands, spawns subprocesses with filesystem access, and echoes output to a semi-public channel.

### 4. Adversarial Review

Actively try to break the design before building it:
- What assumptions are we making? Which ones are wrong?
- Where does this fail at scale, under load, with bad input?
- What are the second-order effects on the rest of the system?
- What's the worst thing that happens if this ships with a bug?
- Is there a simpler design we're ignoring because we're attached to this one?

This stage is cheap. Finding a flaw here costs minutes. Finding it in production costs days.

### 5. Design Iteration

Incorporate findings from adversarial review. This may loop back to stage 3 if fundamental issues were found. The design is done when:
- The adversarial review produces no critical findings
- The design is the simplest thing that satisfies the brief
- Every decision has a clear rationale (not "it felt right")

### 6. Atomic Planning

Decompose the design into the smallest independently buildable and testable units:
- Each unit has a clear input, output, and success criterion
- Dependencies between units are explicit
- Units that can be built in parallel are identified
- Each unit is small enough that its correctness is obvious

Each unit must be scoped so it can be handed to an independent Claude Code agent without ambiguity or cross-contamination: self-contained file scope, a single well-defined interface boundary, and no implicit shared state that another agent might be simultaneously modifying. If a unit requires knowledge of another unit's internals to implement, it is not atomic enough.

The quality of this stage directly determines whether parallel build works or creates merge conflicts and integration bugs.

### 7. Parallel Build

Execute the atomic plan. Multiple units built concurrently where the dependency graph allows:
- Each unit is built against its spec from atomic planning
- Integration points are defined by contracts, not by "we'll figure it out"
- Progress is tracked at the unit level

In practice, parallelism here means spinning up multiple Claude Code agent instances simultaneously — each running in its own worktree or isolated working directory, each handed exactly one atomic unit's spec as its prompt. Agents operate independently and do not coordinate at runtime; coordination happened at the planning stage. When all agents complete, their outputs are integrated and any conflicts resolved before moving to validation.

### 8. Build Validation

Verify each unit and the integrated whole:
- Unit tests pass for each atomic piece
- Integration tests confirm units compose correctly
- The build matches the design (not just "it works" but "it works for the right reasons")
- Type checks, linting, and static analysis are clean
- Structured pino logs are emitted at the right levels and the audit log captures user, timestamp, and working directory for all commands and Claude Code invocations — this is the only production visibility window for a self-hosted bot

Validation commands (`npx tsc --noEmit`, `npx eslint .`, `npm test`) are run by Claude Code agents and their output reported back. The agent is responsible for interpreting failures, tracing them to the relevant unit, and either fixing in place or flagging for human review. A validation pass is not complete until all three exit zero.

### 9. QA Pipeline

End-to-end validation against the original brief:
- Does it actually solve the stated problem?
- Edge cases, error paths, and degraded-mode behavior
- Performance under realistic conditions
- User-facing behavior matches expectations
- Regression — did we break anything that was working?

Build validation asks "does the code work?" QA asks "does the product work?"

Discord interaction testing requires a live bot token and a dedicated test guild — this cannot be mocked away entirely. Establish the test guild before QA first runs, not during it. At minimum: a test server with the roles and channels the bot expects, a bot token scoped to that server, and a checklist that covers the streaming flow (initial message → edits → ✅ reaction) and the approval gate flow (embed → reaction → proceed/cancel).

### 10. Security Review

Dedicated security pass as a final gate:
- Input validation and sanitization
- Authentication and authorization boundaries
- Data exposure and leakage
- Dependency vulnerabilities
- OWASP top 10 applicability
- Principle of least privilege in any new permissions or access patterns

Priority threat vectors for this bot: secret leakage through the streaming buffer (does redaction run before every Discord write?), command injection via `/run` input (is the allowlist enforced before shell execution, not after?), and working-directory escape (can a path traversal in `/file` or `/tree` read outside the project root?).

## Notes on the Process

**This is not linear.** Any stage can loop back to an earlier one:
- Security review finds an architectural flaw → back to design
- QA reveals a misunderstood requirement → back to brief
- Build validation shows the atomic plan was wrong → back to planning

**The front-loading is the point.** Stages 2-5 are where most of the value is created. They're also where most teams cut corners. A 2-hour design session can save a 2-week rewrite.

**Parallel build only works if atomic planning was rigorous.** If units have hidden dependencies or unclear contracts, parallelism creates more work than it saves.

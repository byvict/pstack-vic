---
name: show-me-your-work
description: "Use only when the user explicitly names this skill or an active pstack workflow calls it. Keep and review a decision trail for work that needs an audit."
---

# Show me your work

Keep one canonical log.

## The format

A single TSV file, one row per decision. Cells stay single-line. Evidence is a pointer, not prose.

Copy `references/decision-log-template.tsv` (the header row) to start a clean log. Columns:

- **ts.** ISO8601 timestamp.
- **phase.** The phase or workstream.
- **decision.** What was chosen or done, one line.
- **why.** The reason in plain words. If a principle drove it, say it plainly, not as a jargon tag.
- **evidence.** A link or path that proves it: commit SHA, PR number, `file:line`, or an artifact, trace, or screenshot path. Never a paragraph.
- **result.** The outcome or predicate state: `tests green`, `reverted`, `pixel-diff 0`, `INCONCLUSIVE`, `open`.

An example, plain-spoken so a reviewer reads it at a glance.

```
ts	phase	decision	why	evidence	result
2026-05-24T09:02:00Z	frame	counted the work first, about 100 components and roughly 75 hours	wanted to know the size before starting a long run	commit 3a9f1c2	found 5 things to sort out before starting
2026-05-24T09:40:00Z	harness	took screenshots of the old version before changing anything	so we can compare old against new and catch any visual change	scripts/snapshot.sh, baseline/	saved 120 reference screenshots
2026-05-24T11:15:00Z	widget	moved the widget styles over without changing how it looks	keep the change small and the result identical	commit 7c21e0a, pixel-diff 0	looks identical, tests pass
2026-05-24T12:30:00Z	widget	threw out a helper's work because its screenshots were blank	checked the real files instead of trusting its summary	worktree reset	reverted, tightened the instructions for next time
```

## Logging a row

Write each entry the way you'd tell a teammate what you did. Plain words, concrete actions, no AI speak or abstract jargon (the **unslop** skill applies to log text too).

Use the helper `scripts/log.sh <logfile> <phase> <decision> <why> <evidence> <result>`. It stamps `ts`, writes the header on first use, strips stray tabs/newlines, and prefixes any cell starting with `=`, `+`, `-`, or `@` with a single quote. A bare `printf` appending a row works too, but mind those same bytes if cells come from generated or user-supplied text.

Log decision points and checkpoints, not every action: a fork chosen, a unit completed with its verification result, a pivot or revert with its trigger, a blocker surfaced, a gate fixed. For loop runs, one row per iteration. Skip the trivial and self-evident.

A run is one agent conversation, including its later turns and any summary of it. A pickup, a replacement agent, or a new chat starts a new run. When a run adds to a log that already has rows, its first row has phase `start`, and so does its first row after another run's `start` row. So a run that comes back to a log in a later turn first reads the log's last rows to see whether another run wrote since. A `start` row names the `ts` range of the rows before it that this run did not write, and its evidence names this run, such as its agent id. Use phase `start` for nothing else.

## Where it lives

By default the log is a working artifact, not committed. Keep it at `decisions.tsv` in the work dir, or `.audit/<task-slug>.tsv` when several efforts run at once, and leave it out of git.

Commit it only when the work is ambitious enough that a reviewer needs the trail to trust the result.

## Rules

- Append-only. A wrong call gets a new row that supersedes it. Never edit or delete history.
- Prefer evidence produced by committed scripts over hand-made one-offs (the **encode-lessons-in-structure** principle skill).

## Audit the log against the transcript

On Codex, resolve this run's known conversation UUID through [Active transcripts](../poteto-mode/references/codex-tools.md#active-transcripts), including its opening binding. If it cannot be verified, record the missing transcript evidence and use the session digest; the audit remains limited to evidence actually available.

At the end of the run, before handing back, check the log told the truth. On Claude Code, read this run's transcript under the per-project transcripts directory at `~/.claude/projects/<encoded-cwd>/`. Don't glob across `~/.claude/projects/`. That reads unrelated private chats. A native subagent's run is not under its own cwd: Claude Code files it at `~/.claude/projects/<encoded root cwd>/<root session id>/subagents/agent-<agent id>.jsonl`, where the root is the top-level session that launched it. The subagent's `CLAUDE_CODE_SESSION_ID` is the root's session id, and its environment names neither its own agent id nor the root's cwd. A worktree-isolated subagent's cwd and branch end in `agent-<agent id>`. So a root that launches a subagent which audits its own trail, such as an autopilot owner, names that `subagents/` directory in the brief. The file's first records can exceed one Read call, so read it by line ranges or extract fields (measured 2026-10-08 on Claude Code 2.1.293). Walk this run's rows against what actually happened. Each stretch of them begins at one of this run's `start` rows, or at the first row if this run created the log, and ends at the next `start` row of another run:

- Check that every row maps to a real decision or action.
- Check that each row's evidence resolves and shows what the row claims.
- A fork, pivot, or abandoned approach that shaped the work but isn't logged is a gap. Add it.

Correct the log, not the story. The audit never edits or removes a row, even an invented one. When a row records neither a real decision nor a real action, or its claim or evidence is wrong, add a row that supersedes it with what actually happened and a pointer that resolves. This audit does not check rows outside this run's stretches. If this run's own work shows one of them is wrong, supersede it like any wrong call.

## Cross-model review of the trail

Before handing back, launch one fresh, read-only reviewer lane from the `trail reviewer pool` role, on a provider different from the top-level session's provider. Self-review is not a substitute. The reviewer reads the audit trail and the run's transcript, then flags what the user should pay attention to. Not a redo of the work, a scan for what's suboptimal or risky.

The top-level session runs `node <plugin>/skills/setup-pstack/scripts/setup-pstack.ts pick --parent <parent> --role "trail reviewer pool"`, using its own parent, even for a child's trail. The script selects the first eligible entry in the operator's order. Other providers that authored parts of the result remain eligible; use a fresh reviewer context, not a resumed writer. For this role, this section owns eligibility and completion; use [`provider-dispatch.md`](../poteto-mode/references/provider-dispatch.md) for transport and receipt evidence. The integration contract is recorded in [ADR 0007](../../docs/adr/0007-revisor-da-trilha-de-outra-familia-da-raiz.md).

The brief names the trail and the transcript by path. Log the pick as a row, with the lane's receipt as evidence. If the chosen lane drops out, retain the evidence and try the next entry of `eligible`, with its configured model and effort. A run that is itself a subagent returns its trail and transcript path with its report; the top-level session launches one reviewer per trail.

- Decisions logged with weak or absent evidence.
- Verification steps skipped or claimed without proof in the transcript.
- Choices that look risky in hindsight (premature, scope-creeping, papering over a symptom).
- Gaps the user would otherwise miss on a casual skim.

Every reply for a run that produced a trail ends with an "Attention" section. Lead with the reviewer's model on its own line (`reviewed by <model>`), then list each flag pointing to specific rows or moments. "No flags" is a valid value. The model name is not. Take the name from the lane's receipt, as provider-dispatch says, never from the reviewer's own words.

When no eligible lane completes, the review remains outstanding. Report `review pending: no cross-family reviewer completed`, name the root provider, and explain each skipped entry or dropout with its evidence. Return the available artifacts as incomplete work; resume the review when the configuration or execution obstacle is resolved. An empty pool or exhausted attempts do not waive the review. A launch refused by the harness is a dropout with no receipt: quote the refusal and respect it. Keep the configured pool; the swarm fallback does not apply. A lane on the root's provider and the root itself cannot satisfy this review.

## Reviewing the trail

Read top to bottom, follow the evidence pointers, spot-check. GitHub renders a committed TSV as a table. `column -s$'\t' -t decisions.tsv` renders it in a terminal.

## Composing this skill

Other skills route their audit trail here instead of inventing one. Reference it by name and let it own the format. Don't restate the columns.

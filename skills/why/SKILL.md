---
name: why
description: "Use for 'why does X work this way', 'why we picked Y', design rationale, regressions, postmortems, or data-backed thresholds. Discovers available MCPs and queries each evidence category (source control, issue tracker, long-form docs, real-time chat, infrastructure observability, error tracking, product analytics warehouse) in parallel, then returns a cited read on decisions and tradeoffs. Use how for runtime behavior."
---

# Why

Investigate the motivation and intent behind code.

Companion to the `how` skill. `how` answers what the code does and how it works. `why` answers what forces led to its shape.

**Dispatch contract.** Resolve every configured role through [`provider-dispatch.md`](../poteto-mode/references/provider-dispatch.md). Investigators require the parent's live MCP surface, so the default and supported portable route is `inherit-parent` (or its `auto` alias). Pass the code anchor by path. On Codex, resolve remaining Claude tool names via [`codex-tools.md`](../poteto-mode/references/codex-tools.md).

## Operating Posture

Operate as a **careful, cautious, and precise investigator**. Be honest about what you know vs what you're inferring. Read `references/epistemics.md` for the full confidence framework and phrasing guide. The synthesizer must follow it.

## Step 1. Understand the Target and the Question

Parse what the user is asking. The **target** is usually a chunk of code, a pattern, a feature, or a named design decision. The **question** is usually a design rationale, a tradeoff, a motivating edge case, an external constraint, dead code, or a broad history sweep.

If the target is vague ("why do we do it this way?" with no clear referent), make your best guess from conversation context (open files, recent edits, cursor location, what was just discussed). State your interpretation briefly so the user can redirect if you're off, then proceed.

## Step 2. Establish the Code Anchor

Before spawning investigators, anchor the investigation in concrete code. You need:

- The relevant file path(s) and line range(s)
- The key symbols (function names, class names, constants)
- An initial commit list. The last few commits touching the target.
- PR numbers from merge commits (pattern `(#1234)` in the subject line)

Build this inline.

```bash
# Blame target lines for last-touch commits
git blame -L <start>,<end> <file>

# Full file history, with patches, through renames
git log --follow -p -- <file>

# Last N commits touching the file, PR numbers visible
git log --oneline -20 -- <file>

# Extract PR numbers from a commit message
git log -1 --format=%B <commit>
```

Pull PR bodies and discussion via `gh` for any substantive commits:

```bash
gh pr view <number> --json title,body,author,createdAt,mergedAt,labels,closingIssuesReferences,comments,reviews
```

Capture this as seed context (file paths, symbols, commits, PR numbers, linked ticket IDs). Pass it to the investigators.

## Step 3. Spawn Parallel Investigators (default posture)

**Default to the full parallel investigation.**

### Discovery

Before spawning investigators, discover callable MCP tools in the parent's live environment. Use its tool list and tool discovery. Configuration such as `.mcp.json` or `claude mcp list` can identify candidate servers, but cannot prove that a source was queried. Keep investigators on the inherited native route so they can consume the parent's MCP sources.

Map each available MCP to one evidence category:

1. Source control history
2. Issue / ticket tracker
3. Long-form documents
4. Real-time team chat
5. Infrastructure observability
6. Error / exception tracking
7. Product analytics warehouse

Investigate source control through git and `gh`. Record access failures as gaps. For the other six, classify using the MCP name, server instructions, tool names, and resource descriptors. If an MCP could fit more than one category, choose the one matching its primary evidence. Record ambiguous cases in the coverage map.

Account for all seven categories in the coverage map, including sources that are unavailable or skipped. Update the map from observed consumption at the gate in Step 4.

Launch all matching investigators in one fan-out phase so they run concurrently. Don't ask one agent to cover multiple MCPs. Route each through your configured `why investigators` role (default `inherit-parent`, per the role table in `provider-dispatch.md`) with the assigned MCP available. Investigators still do not write files; that is a posture even when the MCP-capable execution mode is not mechanically read-only.

Each investigator gets:
1. The base prompt from `references/investigator-prompt.md`
2. The category playbook `references/sources/<source>.md` for the selected MCP, adapted from the examples in `references/source-playbook.md`
3. The cross-cutting `references/sources/incident-postmortem.md` **if the target code looks defensive** (null checks, retry logic, timeout handling, rate limiting, feature flags, egress guards, OOM handlers)
4. The code anchor from Step 2 (file paths, symbols, commit hashes, PR numbers, ticket IDs)
5. The user's original question

### Investigator roster. One per available evidence category

Spawn one investigator per category that has a matching MCP. Each owns exactly one tool or MCP.

Each entry names the category and the kind of "why" it uniquely surfaces. Use it to know what to expect back, how to name a gap when a category returns empty, and (only in the rare provably-irrelevant case) to justify a skip.

1. **Source control investigator**. Git history, `gh` for PRs, code comments, tests. Always spawn. The only guaranteed source. Best at surfacing *implementation-time rationale captured during review*.

2. **Issue / ticket tracker investigator** (e.g. Linear, Jira, GitHub Issues, Plane, Shortcut MCP). Best at surfacing *the product or business forcing function*. Strongest when the why is external to engineering.

3. **Long-form documents investigator** (e.g. Notion, Confluence, Google Docs, Coda MCP). Best at surfacing *long-form design rationale*. Where the why is written out before it becomes code.

4. **Real-time team chat investigator** (e.g. Slack, Discord, Microsoft Teams, Mattermost MCP). Best at surfacing *real-time deliberation that never reached a doc*. Especially important when the source control, ticket, and doc paper trail is thin.

5. **Infrastructure observability investigator** (e.g. Datadog, New Relic, Honeycomb, Grafana, Splunk MCP). Infra/runtime view. Best at surfacing *infrastructure and runtime reality that motivated the code*. Strongest when the target reacts to an infra signal (timeouts, retries, rate limits, circuit breakers).

6. **Error / exception tracking investigator** (e.g. Sentry, Rollbar, Bugsnag, Airbrake MCP). Best at surfacing *the specific exceptions and error trajectories that motivated defensive or corrective code*. Strongest for catch blocks, null guards, type checks, retries, and other defenses.

7. **Product analytics warehouse investigator** (e.g. Databricks, Snowflake, BigQuery, ClickHouse, dbt, Redshift MCP). Product/data view. Best at surfacing *product and data reality that shaped the code*. Strongest for flag-gated code, experiment-driven ships, data migrations, and "where did this number come from" questions.

### Unavailable sources and justified skips

Record the reason in the coverage map and the final "Sources Consulted" section:

- **Unavailable.** No matching MCP is callable, or access fails. Name the missing tool or the observed error. This is a coverage gap.
- **Skipped.** The source is provably irrelevant. Give the evidence for that judgment. Example: "Error / exception tracking skipped. Target is a build-time script with no runtime code path."

An empty result requires a successful query with no matches. A failed call or an unqueried source is not empty.

For a single-commit trivial target, you may synthesize inline after the Step 4 consumption gate. Account for all categories through observed queries, unavailable sources, or justified skips.

## Step 4. Verify source consumption, then synthesize

Before dispatching the synthesizer, follow [`references/native-consumption.md`](references/native-consumption.md) to locate each investigator's host transcript from its native dispatch handle. Validate the receipt from [`references/investigator-prompt.md`](references/investigator-prompt.md) against the child's host-recorded tool calls and matching results. Confirm returned IDs and complete reads of relevant objects, comments, documents, and remaining pages.

The receipt is an index for this comparison. A child-authored receipt file, tool-shaped assistant text, search snippet, or inherited parent call cannot establish the child's consumption. Attribute recovered evidence to the runtime that actually read it, including a parent replay.

Recover missing queries or reads through a runtime with the required MCP access. If the host evidence is missing, mark consumption unverified. If access or a full read fails, record the source as unavailable or partial and name the gaps. Synthesis can proceed with these limitations. Claims based solely on an unverified source stay out of direct findings until a verified read supports them.

Record the validation verdict and native call or transcript references beside each receipt in the existing findings. Pass the coverage map with found, empty, unavailable, or justified skipped outcomes, complete or partial reads, and verified or unverified consumption to the synthesizer.

Dispatch one synthesizer through your configured `why synthesizer` role (default `inherit-parent`). Preserve relevant MCP access because the synthesizer's quality check spot-verifies citations. It does not write files.

The synthesizer gets:
1. The investigator findings, receipts, and parent-validated coverage map
2. The code anchor from Step 2 (file paths, symbols, commit hashes, PR numbers, ticket IDs)
3. The user's original question
4. The epistemics framework from `references/epistemics.md`
5. The synthesizer prompt template from `references/synthesizer-prompt.md`

## Step 5. Present

Take the synthesizer's output and present it to the user. You may lightly edit for clarity or add context from the conversation, but **do not rewrite the confidence language**.

## Output Format

The output structure is the one in `references/synthesizer-prompt.md`: The Question, The Code in Question, What We Found, What We Can Reasonably Infer, Competing Hypotheses, What We Don't Know, Sources Consulted, Confidence Summary. Adapt as needed, but keep the confidence separation intact, and keep Sources Consulted as one line per source, including unavailable or skipped categories. Preserve the validated outcome, read gaps, and consumption verdict.

After the Sources Consulted block, if the user's `why` question is a precursor to actually changing this code, convert the lineage findings into a Preserve / Change / Avoid / Risk constraint set suitable for planning the change.

## Common Failure Modes to Avoid

- **Recency bias**. Assuming the most recent commit is authoritative. The current shape is often the accretion of many earlier decisions. Trace back.

## Reference Files

- `references/epistemics.md`. Confidence tiers and phrasing guide. The synthesizer must follow it.
- `references/investigator-prompt.md`. Base prompt and consumption receipt contract for investigator subagents. Validate each receipt before synthesis.
- `references/native-consumption.md`. Native transcript locators, child identity checks, and call/result admission procedure. Follow it at the Step 4 gate.
- `references/source-playbook.md`. Index pointing at the category playbooks below.
- `references/sources/*.md`. One self-contained example playbook per category, plus cross-cutting `incident-postmortem.md`. Give an investigator the single file that matches its category and adapt it to the available MCP.
- `references/synthesizer-prompt.md`. Prompt template for the synthesizer, including its coverage check and output format.

# Converge

Converge is what happens to a PR after the Raiz certifies it and ends: on Victor's Mac, not in a cloud. The [Pré-PR](pre-pr.md) playbook publishes the Certificado and arms auto-merge with `--pending`; GitHub merges when the required checks pass. Two launchd jobs cover what the Raiz cannot see after it ends. Read the [contract](../references/converge-contract.md) and [`docs/pre-pr.md`](../../../docs/pre-pr.md). The Cursor cloud owner, its `start.ts` launcher and the three Automations are retired; 0.5.0 removes their code.

## Two jobs

| Job | Every 10 min | Model | Does |
|---|---|---|---|
| `com.pstack.converge-sweep` | `converge-local tick --job sweep` | none | Runs `converge-sweep` on every configured repository: arms each certified PR on trunk without a hold, disarms a held or refused one. Covers a stack child retargeted after its parent merged and a PR left unarmed on a red trunk. |
| `com.pstack.converge-raiz` | `converge-local tick --job raiz` | the `converge raiz` row of the sheet | Lists the open PRs, skips drafts, held PRs, forks, leased branches and PRs whose author is outside the trusted list (the `gh` account plus `trustedAuthors`), classifies the rest (`repair`, `recertify`, `certify`), skips a PR with work that someone outside the list commented on or reviewed, and launches one Raiz on the lowest PR with work to run [Catch-up](catch-up.md). |

`node <plugin>/skills/poteto-mode/scripts/converge/converge-local status` shows the configuration, the sheet row, `gh` and parent authentication, the leases, the ledgers and how each job's last tick ended. `node <plugin>/skills/poteto-mode/scripts/converge/converge-local run --repo OWNER/REPO --pr N` launches one attempt by hand through the same path. Caps: two failed or three deferred attempts on a head, or six hours from the first attempt, apply the hold label with a comment. After a deferred attempt, the next launch on that head waits 30 minutes. A Raiz that does not start, or ends without an outcome within two minutes, is a tick error and no attempt. After three launch failures on a head since its last recorded attempt, the PR waits an hour after the latest one; every tick that reaches it meanwhile reports the wait as an error and moves on to the next PR. A new head resets the counts, but a held PR stays skipped until the label is removed, which resets them too. Attempts are capped at two hours of wall time. A required check that concluded `neutral` or `skipped` counts as passing, as GitHub counts it: it opens no `repair`, and the arm accepts it.

## Handoff from the local agent

There is none. The Raiz ends at the arm receipt of Pré-PR step 8. A session that must touch a PR branch the daemon may also touch takes the branch lease first (`converge-local lease`), which is what Pré-PR, Babysit and Shipping do.

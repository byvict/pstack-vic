# Converge

Converge is what happens to a PR after the Raiz certifies it and ends: on Victor's Mac, not in a cloud. The [Pré-PR](pre-pr.md) playbook publishes the Certificado and arms auto-merge with `--pending`; GitHub merges when the required checks pass. Two launchd jobs cover what the Raiz cannot see after it ends. Read the [contract](../references/converge-contract.md) and [`docs/pre-pr.md`](../../../docs/pre-pr.md). The Cursor cloud owner, its `start.ts` launcher and the three Automations are retired; 0.5.0 removes their code.

## Two jobs

| Job | Every 10 min | Model | Does |
|---|---|---|---|
| `com.pstack.converge-sweep` | `converge-local tick --job sweep` | none | Runs `converge-sweep` on every configured repository: arms each certified PR on trunk without a hold, disarms a held or refused one. Covers a stack child retargeted after its parent merged and a PR left unarmed on a red trunk. |
| `com.pstack.converge-raiz` | `converge-local tick --job raiz` | the `converge raiz` row of the sheet | Lists the open PRs, skips drafts, held PRs, forks and leased branches, classifies the rest (`repair`, `recertify`, `certify`), and launches one Raiz on the lowest PR with work to run [Catch-up](catch-up.md). |

`converge-local status` shows the configuration, the sheet row, `gh` and parent authentication, the leases and the ledgers. `converge-local run --repo OWNER/REPO --pr N` launches one attempt by hand through the same path. Caps: two failed attempts on a head or six hours from the first attempt apply the hold label with a comment; a new head or removing the label resets. Attempts are capped at two hours of wall time.

## Handoff from the local agent

There is none. The Raiz ends at the arm receipt of Pré-PR step 8. A session that must touch a PR branch the daemon may also touch takes the branch lease first (`converge-local lease`), which is what Pré-PR, Babysit and Shipping do.

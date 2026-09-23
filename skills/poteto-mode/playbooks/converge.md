# Converge

The local agent opens a ready PR and launches one Cursor Cloud PR owner. The owner stays in Cloud through independent verification, repair, a fresh verification, automatic merge and the resulting `main` Tests run. The owner is the only branch writer. The independent verifier is read-only and includes risk review. Both use Grok 4.7: `high` for simple work and `xhigh` for complex work. Read the [contract](../references/converge-contract.md) and [v1 plan](../../../docs/converge-v1.md).

## Handoff from the local agent

After opening and checking the ready PR, push the pstack tooling commit used by this flow. Run:

```sh
node skills/poteto-mode/scripts/converge/start.ts --repo OWNER/REPO --pr NUMBER --tooling-ref FULL_PSTACK_SHA --effort high
```

Choose `xhigh` when the change crosses modules, changes behavior in a risky path, or needs deep investigation. `start.ts` uses a fixed local state directory for each repository and PR, checks the PR and Cursor model inventory, saves launch intent before the API request, injects the working Cursor API key as an encrypted run variable, and saves the returned agent/run receipt. A retry returns that receipt. If an intent exists without a receipt, recover that launch; do not create another owner. The local task ends after the receipt confirms launch. A failed or unknown launch is explicit and never authorizes merge.

## Cloud owner loop

The owner uses Node 24, `gh`, the pinned pstack commit, and its run-scoped Cursor key. The Cursor runtime secret `PSTACK_GITHUB_TOKEN` supplies `GH_TOKEN` for GitHub mutations and authenticated pushes; the sandbox's installation credential reads private check-runs because GitHub does not grant that endpoint to the fine-grained personal token. Scope the token to the managed repositories with Contents, Issues, Pull requests and Commit statuses write, plus Actions and Administration read. Do not expose the value in a remote URL or log. Rotate it before expiration. The required `verdict` protection context must accept a commit status from this credential without an app binding. The owner writes state before dispatch or branch mutation. Stop after two code repair attempts or six hours. CI waits and environment recovery do not spend a repair attempt. On an unknown writer outcome, recover the recorded agent/run before another writer. If the cycle cannot advance, post the cause, attempts and evidence, then apply `needs-victor`.

1. Reconcile the current PR head with `converge-reconcile`. It creates a fresh round and selects CI-only or one independent verifier. A held PR stops. Use `--execution verdict-only` only for an authorized held proof; that result cannot merge.
2. For full verification, prepare one `pr verifier` lane with `cursor:grok-4.7@high` or `cursor:grok-4.7@xhigh`. Run it read-only through `pstack-runner` with the exact repository and PR. The verifier checks risk, tests and the affected user paths. The owner admits its receipt and artifact bytes through `publish.ts`. CI-only runs need no model lane.
3. Continue in the same Cloud run after publication. If `NOT VERIFIED`, fix the named defect on the PR branch, push, wait for pertinent CI and start a fresh round. If `INCONCLUSIVE`, recover the missing evidence and verify again without spending a code repair. A changed patch always gets fresh independent evidence. Do not turn an absent artifact into a pass.
4. On `VERIFIED`, run `converge-arm` at the exact head. It requires the trusted verdict, latest required checks, effective branch protection including `verdict`, a green trunk Tests run and no human hold. Monitor pending auto-merge. Disarm if the head, verdict or hold changes, or when the 30 minute monitor expires.
5. After merge, watch the push-to-main Tests run at the merged commit. Report the PR, agent runs, requested model and effort, evidence, correction, verdict, merge and main Tests result. A request receipt proves the requested model, not the model actually served.

The owner may start a new Grok 4.7 `xhigh` owner for a complex escalation. It records the handoff and stops only after the new launch is confirmed. There is never more than one branch writer.

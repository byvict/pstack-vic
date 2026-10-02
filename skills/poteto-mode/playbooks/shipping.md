### Shipping

Before the first PR operation, read the Guarded operations section below. Capture its operation record and follow its identity, withdrawal, publication and evidence rules.

**You own what lands. Verify each PR independently, land only the verified run from the root, then keep your hands off the queue.**

This is the half after `playbooks/babysit.md`.

1. **Resolve the forge, then verify every PR independently.** Use the supported GitHub CLI path from Guarded operations with the captured operation record and explicit `--repo <owner/name>`. Refuse an Origin mutation path because its expected-head adapter is unproven. Never require Graphite (`gt`). One subagent per PR, not batched, each in its own worktree, each exercising the real surface with the matching driver skill (such as `verify` for UIs or `run` for CLIs and TUIs) against parent versus head. Each returns `PASS`, `PASS+NOTES` or `FAIL` and posts that verdict on its own PR. Safe means a verdict from an agent that did not write the code. CI green is not a verdict, and an approving bot review is not a verdict.
2. **Land only the contiguous verified run rooted at the bottom.** Walk up from the lowest unmerged PR and stop at the first one without a passing verdict, where both `PASS` and `PASS+NOTES` pass. A verified PR sitting above an unverified one is not landable. Report the ceiling as a PR number and say what breaks the chain.
3. **Audit each verdict against current inputs.** Preserve the original verdict head and base, exact patch bytes, and each lane's receipts and runtime inputs. Follow Guarded operations to compare exact patch bytes and audit changed base dependencies, configuration, build tools, and runtime inputs per lane. Matching stable patch-id alone never preserves evidence. Rerun a lane when its patch or relevant inputs changed, when impact is uncertain, or when live proof has no reproducible build output. Record any reuse against the original evidence identity. Always run current required checks.
4. **Prepare only the bottom PR.** Read and withdraw affected queue and auto-merge requests, including actual dependent descendants, before a rewrite or retarget. Fetch the selected trunk ref through Guarded operations, capture FETCH_HEAD and compare it to the observed destination SHA. Rebase the lowest verified branch onto that exact captured SHA when needed, publish with its captured-SHA lease, and retarget only that PR with `GH_HOST=<validated-host> gh pr edit --repo <owner/name> <pr> --base <trunk>`. Re-run step 3 after the push. Do not retarget, arm, or merge descendants yet.
5. **Land one PR at a time.** Require the current independent verdict and all current requirements to pass. For a merge-when-ready request, watch until current requirements pass, then re-read identity and base. Use the expected-head command in Guarded operations with the selected PR body file. Read back queue membership and auto-merge, and wait for actual `MERGED` before preparing the next PR. Operator-named items remain at merge-ready for the operator's click.
6. **Read queue membership and auto-merge separately.** Use the Guarded operations query. `autoMergeRequest` means auto-merge was requested; `mergeQueueEntry` means the PR is admitted to the queue. Neither proves that its independent verdict is current or that a descendant is ready. Failed reads and missing fields leave state unknown and stop progression.
7. **Recompute after every merge.** Fetch trunk through the Guarded operations exact-base recipe, capture and verify its SHA, and confirm the merged SHA is present, drop the merged PR from the frozen bottom-to-top list, and inspect the new bottom PR's base, head, checks, and verdict inputs. A host may retarget a child automatically, but do not assume it did. Restack through Guarded operations using the recorded old parent and child tips, the ancestry and own-range checks, and `rebase --onto`. After a squash, confirm the rewritten range contains only the child contribution. Repeat steps 3 through 6 for that one PR. Independent work stays outside this chain and ships on its own.
8. **Watch the current frontier until it merges or fails. Do not mutate the queue around it.** Use `scripts/watch-pr/watch-pr --owner <owner> --repo <repo> --queued-stack --stack-prs <bottom>` only as an event wake and poll `GH_HOST=<validated-host> gh pr view --repo <owner/name> <pr> --json state,mergedAt,mergeStateStatus,statusCheckRollup,autoMergeRequest` and the Guarded operations identity query after each wake, ignoring `READY` until `mergedAt` is non-null or `state` is `MERGED`. Only then run step 7. Hard-fail only when `state` is `CLOSED` with no `mergedAt`, a required check concludes `FAILURE` or `CANCELLED` and blocks merge after auto-merge is no longer pending, or `mergeStateStatus` is `UNSTABLE` or `DIRTY` with no auto-merge pending. `BLOCKED` while checks are pending or auto-merge is armed is not failure. Do not use Babysit's queued `WAITING`/`merge-queue` stop condition here. Hold the watch under `/loop` in dynamic mode. Report each merge and the new ceiling. If the queue stalls, diagnose before mutating.
9. **Stop at the ceiling.** When the verified run is merged, report what landed, what the next unverified PR is, and what verifying it would take. Extending the run is a new pass through step 1.

**Reply:** the verified run and its ceiling, each PR's verdict and who produced it, what you armed and how you confirmed it, what landed, and what the next gap needs.

#### Guarded operations

Read this section before the first PR operation. The invoking playbook retains its topology and merge authority. Loading this recipe grants neither. Operator-named items stop for the operator's review and click.

**Capture one operation record.** Record GitHub host, owner and repository name, PR number and node ID, one owned branch, validated fetch and push URLs, captured remote head, local pre-rewrite head, current published head, verdict head, and current base ref and SHA. Preserve the verdict's original base ref and SHA, exact patch file, lane receipts and runtime inputs. For a dependent child also record the parent PR, old parent tip and old child tip before either changes. Keep candidate SHA separate from contribution and verdict identities.

Resolve all fetch and push URLs with `git remote get-url --all <remote>` and `git remote get-url --push --all <remote>`. Support same-repository GitHub HTTPS URLs and SSH URLs for `git@github.com`, with optional `.git`. Normalize host, owner and repository. Require one fetch destination and one push destination, both equal to the selected repository and the PR's head repository. Refuse credential-bearing URLs, unsupported hosts or URL forms, multiple destinations and fork topology before a write. Git can rewrite a resolved URL again at transport time. Any `url.*.insteadOf` or `url.*.pushInsteadOf` configuration, including inherited and included entries, is unsupported. Check and refuse it before URL resolution and again in the transport blocks below. Do not remove configuration or disable hooks to proceed.

Origin has no proven expected-head adapter here. If requested, report `Unsupported Origin mutation path: expected-head submission is not verified` and perform no mutation. Use GitHub only when the task permits it.

Load recorded inputs in the same shell invocation as each complete block. Shell environment does not persist across tool calls. Every block refuses missing or empty inputs; do not copy only its last line. Bind the validated host on each `gh` command. Pass explicit repository and PR to every `gh pr` command. Before PR creation, validate branch and URLs and record its published head; read the created PR back to complete the record. Before every later mutation and after every wake, read this selected PR. Failed or partial reads stop progression.

```sh
: "${op_host:?}" "${op_owner:?}" "${op_name:?}" "${op_pr:?}"
GH_HOST="${op_host:?}" gh api --hostname "${op_host:?}" graphql -f owner="${op_owner:?}" -f name="${op_name:?}" -F number="${op_pr:?}" -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){nameWithOwner pullRequest(number:$number){id number state headRefName headRefOid headRepository{nameWithOwner} baseRefName baseRefOid mergedAt mergeCommit{oid} autoMergeRequest{enabledAt} mergeQueueEntry{id}}}}'
```

Compare repository, PR number, node ID, head repository, branch, published head and base ref with the record. Check local branch and HEAD against it too. Identity mismatch stops before a write. A retargeted base ref or changed contribution head invalidates progression. Withdraw affected work before repair and re-verification. Distinguish a retarget from an advancing SHA on the same target branch, and assess that movement against each lane's inputs. Read native queue membership through the query; the current watcher's `merge-queue` reason does not prove a queue entry.

**Withdraw before a change.** Before a rebase, retarget or verdict invalidation, identify the affected PR and its actual dependent descendants. Leave independent PRs untouched. Process descendants before their ancestor. Read both `mergeQueueEntry` and `autoMergeRequest`. Dequeue every observed entry with its PR node ID.

```sh
: "${op_host:?}" "${op_pr_node_id:?}"
GH_HOST="${op_host:?}" gh api --hostname "${op_host:?}" graphql -f id="${op_pr_node_id:?}" -f query='mutation($id:ID!){dequeuePullRequest(input:{id:$id}){mergeQueueEntry{id}}}'
```

Re-read. If auto-merge remains, disable it by that same PR node ID. This mutation avoids the CLI's queued-PR short circuit; a successful CLI disable exit alone is not proof of withdrawal.

```sh
: "${op_host:?}" "${op_pr_node_id:?}"
GH_HOST="${op_host:?}" gh api --hostname "${op_host:?}" graphql -f id="${op_pr_node_id:?}" -f query='mutation($id:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$id}){pullRequest{id autoMergeRequest{enabledAt}}}}'
```

Read both states back as absent for every affected PR before the first rewrite or retarget. A null payload, failed call or missing field proves no absence. Resume partial withdrawal by reading and removing only what remains, including a rearmed queue entry. If a concurrent merge wins, stop rewriting and reconcile the actual merged head, base and merge commit. Readback is an observation, not an atomic lock against another actor rearming the PR.

**Capture the lease before rewriting.** Use `op_branch` for the owned branch in every capture, restack, source and destination ref. Record the SHA printed below as `op_remote_head`; it must equal local pre-rewrite HEAD. Retain it across later fetches.

```sh
: "${op_push_url:?}" "${op_branch:?}" "${op_local_pre_head:?}"
set -eu
if git config --includes --get-regexp '^url\..*\.(insteadof|pushinsteadof)$' >/dev/null; then
  printf '%s\n' 'URL rewriting is unsupported' >&2; exit 1
else
  _status=$?; test "$_status" -eq 1 || exit "$_status"
fi
git check-ref-format "refs/heads/${op_branch:?}"
test "$(git symbolic-ref --short HEAD)" = "${op_branch:?}"
test "$(git rev-parse HEAD)" = "${op_local_pre_head:?}"
op_remote_head=$(git ls-remote --exit-code --refs "${op_push_url:?}" "refs/heads/${op_branch:?}")
op_remote_head=${op_remote_head%%[[:space:]]*}
test "${op_remote_head:?}" = "${op_local_pre_head:?}"
printf '%s\n' "${op_remote_head:?}"
```

**Fetch the exact selected base.** Read the destination's current ref and SHA, including trunk after a parent merge. Fetch that ref and require `FETCH_HEAD` to equal the observed SHA. Record the printed SHA as `op_new_base`. A URL fetch does not refresh `origin/main`; never use a tracking ref as its result. If the base advances between read and fetch, re-read and assess changed inputs before retrying.

```sh
: "${op_fetch_url:?}" "${op_base_ref:?}" "${op_base_sha:?}"
set -eu
if git config --includes --get-regexp '^url\..*\.(insteadof|pushinsteadof)$' >/dev/null; then
  printf '%s\n' 'URL rewriting is unsupported' >&2; exit 1
else
  _status=$?; test "$_status" -eq 1 || exit "$_status"
fi
git check-ref-format "refs/heads/${op_base_ref:?}"
git fetch --no-tags "${op_fetch_url:?}" "refs/heads/${op_base_ref:?}"
op_new_base=$(git rev-parse --verify 'FETCH_HEAD^{commit}')
test "${op_new_base:?}" = "${op_base_sha:?}"
printf '%s\n' "${op_new_base:?}"
```

For an independent branch with affected requests withdrawn and lease captured, rebase onto that exact fetched SHA.

```sh
: "${op_new_base:?}" "${op_branch:?}"
set -eu
test "$(git symbolic-ref --short HEAD)" = "${op_branch:?}"
git rebase "${op_new_base:?}"
```

**Publish a rewrite.** Verify the rewrite, recheck configuration and publish only the recorded branch with hooks enabled. A first publication uses the same URL and branch validation with explicit source/destination refs after proving the remote branch is absent; it does not use an empty captured-SHA rewrite lease.

```sh
: "${op_push_url:?}" "${op_branch:?}" "${op_remote_head:?}"
set -eu
if git config --includes --get-regexp '^url\..*\.(insteadof|pushinsteadof)$' >/dev/null; then
  printf '%s\n' 'URL rewriting is unsupported' >&2; exit 1
else
  _status=$?; test "$_status" -eq 1 || exit "$_status"
fi
git check-ref-format "refs/heads/${op_branch:?}"
test "$(git symbolic-ref --short HEAD)" = "${op_branch:?}"
git push "${op_push_url:?}" "refs/heads/${op_branch:?}:refs/heads/${op_branch:?}" "--force-with-lease=refs/heads/${op_branch:?}:${op_remote_head:?}"
```

On rejection, abort and report the newly observed identity for review. Never replace the captured SHA with a later tracking ref to retry. Read the published head back after success and keep it distinct from the original verdict head.

**Restack an actual child.** Select its operation record with `op_branch` equal to the child's branch. Capture old parent and child tips before either changes. Verify ancestry and list its own commit range.

```sh
: "${op_old_parent_tip:?}" "${op_old_child_tip:?}"
set -eu
git merge-base --is-ancestor "${op_old_parent_tip:?}" "${op_old_child_tip:?}"
git log --oneline "${op_old_parent_tip:?}..${op_old_child_tip:?}"
```

The subject list is diagnostic. Capture the exact original contribution from the old parent tip to the old child tip with the same canonical patch command below. Load those SHAs as `op_base_sha` and `op_head_sha`, save stdout in the child's original patch file and preserve its identity. After the parent actually merges, fetch the new selected base through the preceding block and verify its merge commit is on that base. Withdraw the child and affected descendants. Refuse restack if the child no longer equals its recorded old tip.

```sh
: "${op_new_base:?}" "${op_old_parent_tip:?}" "${op_old_child_tip:?}" "${op_branch:?}"
set -eu
git check-ref-format "refs/heads/${op_branch:?}"
test "$(git rev-parse --verify "refs/heads/${op_branch:?}")" = "${op_old_child_tip:?}"
git rebase --onto "${op_new_base:?}" "${op_old_parent_tip:?}" "${op_branch:?}"
```

Use the same canonical patch command to capture the rewritten own range, from `op_new_base` to the rewritten child SHA, into a separate file. Compare it byte for byte with the original contribution and confirm parent commits did not return. A changed patch requires fresh verification before publication. After squash or changed base inputs, verify final behavior too. Publish with this child's captured lease and reverify it. Never infer the old parent from the rewritten graph. Independent PRs remain independent.

**Audit evidence per lane.** Stable patch-id is a diagnostic, never permission to reuse evidence. Preserve complete patch bytes, including whitespace, binary changes and submodule commit identities. This option set overrides relative filtering, context, algorithm, color and submodule hiding from any working directory. External diff and text conversion are disabled.

```sh
: "${op_base_sha:?}" "${op_head_sha:?}"
unset GIT_DIFF_OPTS
git -c core.quotePath=true -c diff.suppressBlankEmpty=false -c diff.orderFile=/dev/null diff --no-relative --unified=3 --inter-hunk-context=0 --diff-algorithm=myers --no-indent-heuristic --no-color --ignore-submodules=none --submodule=short --no-ext-diff --no-textconv --binary --full-index --no-renames --src-prefix=a/ --dst-prefix=b/ --output-indicator-new=+ --output-indicator-old=- --output-indicator-context=' ' "${op_base_sha:?}" "${op_head_sha:?}" --
```

Compare those files byte for byte. For each lane also audit changes to the base, dependencies, configuration, build tools, and runtime inputs. A changed patch, changed relevant input, or uncertain impact requires a rerun. Even equal patch bytes cannot preserve a lane when a changed base dependency changes its output. `console.log("a b")` and `console.log("ab")` can have equal stable patch-id but different output and patch bytes. Both cases require fresh affected verification. Live lanes without reproducible build output rerun. Preserve original evidence identities and record each reuse decision without relabeling old proof as a run on the new head. Always run current required checks.

**Submit only the verified identity.** An agent-assisted Shipping merge needs its independent per-PR verifier verdict; a program needs the root's current independent verdict. Require all current PR requirements passed, published head equal to local `HEAD`, and a fresh head and base read. Resolve drift first. For a merge-when-ready request, watch until current requirements pass, then re-read identity and base before submission. Do not arm pending auto-merge as a substitute; `gh pr merge` can arm it when queue-branch checks are pending.

For an authorized direct squash merge or native queue submission, read the actual selected PR body into an operation-owned file. Keep text as data and submit only the published head.

```sh
: "${op_host:?}" "${op_repo:?}" "${op_pr:?}" "${op_published_head:?}" "${op_body_file:?}"
set -eu
GH_HOST="${op_host:?}" gh pr view --repo "${op_repo:?}" "${op_pr:?}" --json body --jq .body > "${op_body_file:?}"
GH_HOST="${op_host:?}" gh pr merge --repo "${op_repo:?}" "${op_pr:?}" --squash --match-head-commit "${op_published_head:?}" --body-file "${op_body_file:?}"
```

The file supplies the body for a direct squash merge. A native queue controls merge method and commit metadata under GitHub's repository policy; do not promise that a CLI body overrides the queue. Retain the body receipt, inspect the actual merge commit and report differences. `--match-head-commit` is a server precondition at submission, not a permanent lock on auto-merge or an atomic expected-base condition. Read back head, base, queue membership and auto-merge after submission and every wake. Withdraw an unexpected pending request the program did not authorize. Wait for actual `MERGED`, then reconcile commit and destination. An accepted server request can finish after chats close. Closing a chat does not withdraw it. GitHub's queue and required CI do not publish or enforce the independent root verdict.

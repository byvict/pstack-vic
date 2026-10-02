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
8. **Watch the current frontier until it merges or fails. Do not mutate the queue around it.** Use `GH_HOST="${op_host:?}" scripts/watch-pr/watch-pr --owner "${op_owner:?}" --repo "${op_name:?}" --pr "${op_pr:?}" --queued-stack --stack-prs "${op_pr:?}"` only as an event wake and poll `GH_HOST=<validated-host> gh pr view --repo <owner/name> <pr> --json state,mergedAt,mergeStateStatus,statusCheckRollup,autoMergeRequest` and the Guarded operations identity query after each wake, ignoring `READY` until `mergedAt` is non-null or `state` is `MERGED`. Compare the returned PR and head to the operation record; a mismatch stops progression. Only then run step 7. Hard-fail only when `state` is `CLOSED` with no `mergedAt`, a required check concludes `FAILURE` or `CANCELLED` and blocks merge after auto-merge is no longer pending, or `mergeStateStatus` is `UNSTABLE` or `DIRTY` with no auto-merge pending. `BLOCKED` while checks are pending or auto-merge is armed is not failure. Do not use Babysit's queued `WAITING`/`merge-queue` stop condition here. Hold the watch under `/loop` in dynamic mode. Report each merge and the new ceiling. If the queue stalls, diagnose before mutating.
9. **Stop at the ceiling.** When the verified run is merged, report what landed, what the next unverified PR is, and what verifying it would take. Extending the run is a new pass through step 1.

**Reply:** the verified run and its ceiling, each PR's verdict and who produced it, what you armed and how you confirmed it, what landed, and what the next gap needs.

#### Guarded operations

Read this section before the first PR operation. The invoking playbook retains its topology and merge authority. Loading this recipe grants neither. Operator-named items stop for the operator's review and click.

**Capture one operation record.** Record GitHub host, owner and repository name, PR number and node ID, one owned branch, selected Git remote name, validated fetch and push URLs, captured remote head, local pre-rewrite head, current published head, verdict head, and current base ref and SHA. Preserve the verdict's original base ref and SHA, exact patch file, lane receipts and runtime inputs. For a dependent child also record the parent PR, old parent tip and old child tip before either changes. Keep candidate SHA separate from contribution and verdict identities.

Record the selected Git remote name in `op_remote`. Resolve and validate both of its destinations with this complete block. It accepts same-repository GitHub HTTPS, scp-style SSH and `ssh://git@github.com/` URLs, with optional `.git`, and compares owner/name case-insensitively. It refuses local paths, other hosts or repositories, credentials, unsupported forms and multiple destinations before transport. URL rewrite configuration and URL-named remote definitions are unsupported, including inherited or included entries. Every transport block repeats this boundary check before resolving URLs; no recorded URL bypasses it. Do not modify user configuration or disable hooks to proceed.

```sh
: "${op_host:?}" "${op_owner:?}" "${op_name:?}" "${op_remote:?}"
set -eu
test "${op_host:?}" = github.com || { printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1; }
case "${op_owner:?}" in *[!A-Za-z0-9-]*|-*) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
case "${op_name:?}" in .|..|*[!A-Za-z0-9._-]*) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
if git config --includes --get-regexp '^(url\..*\.(insteadof|pushinsteadof)|remote\..*:.*)$' >/dev/null; then
  printf '%s\n' 'URL rewriting is unsupported, including URL-named remote aliases' >&2; exit 1
else
  _status=$?; test "$_status" -eq 1 || exit "$_status"
fi
op_fetch_url=$(git remote get-url --all "${op_remote:?}")
op_push_url=$(git remote get-url --push --all "${op_remote:?}")
_identity=$(printf '%s' "${op_owner:?}/${op_name:?}" | tr '[:upper:]' '[:lower:]')
for _url in "$op_fetch_url" "$op_push_url"; do
  case "$_url" in
    https://github.com/*) _path=${_url#https://github.com/};;
    git@github.com:*) _path=${_url#git@github.com:};;
    ssh://git@github.com/*) _path=${_url#ssh://git@github.com/};;
    *) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;;
  esac
  _path=$(printf '%s' "$_path" | tr '[:upper:]' '[:lower:]')
  case "$_path" in "$_identity"|"$_identity.git") ;; *) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
done
printf '%s\n' "${op_fetch_url:?}" "${op_push_url:?}"
```

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

**Capture before every later publication wave.** Use `op_branch` for the owned branch in every capture, restack, source and destination ref. Before creating commits for a fast-forward fix wave or rewriting history, record local HEAD as `op_local_pre_head`. Capture the SHA printed below as `op_remote_head`; it must equal that local tip. Retain it across later commits and fetches, then use the publication block with this actual captured SHA.

```sh
: "${op_host:?}" "${op_owner:?}" "${op_name:?}" "${op_remote:?}" "${op_branch:?}" "${op_local_pre_head:?}"
set -eu
test "${op_host:?}" = github.com || { printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1; }
case "${op_owner:?}" in *[!A-Za-z0-9-]*|-*) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
case "${op_name:?}" in .|..|*[!A-Za-z0-9._-]*) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
if git config --includes --get-regexp '^(url\..*\.(insteadof|pushinsteadof)|remote\..*:.*)$' >/dev/null; then
  printf '%s\n' 'URL rewriting is unsupported, including URL-named remote aliases' >&2; exit 1
else
  _status=$?; test "$_status" -eq 1 || exit "$_status"
fi
op_fetch_url=$(git remote get-url --all "${op_remote:?}")
op_push_url=$(git remote get-url --push --all "${op_remote:?}")
_identity=$(printf '%s' "${op_owner:?}/${op_name:?}" | tr '[:upper:]' '[:lower:]')
for _url in "$op_fetch_url" "$op_push_url"; do
  case "$_url" in
    https://github.com/*) _path=${_url#https://github.com/};;
    git@github.com:*) _path=${_url#git@github.com:};;
    ssh://git@github.com/*) _path=${_url#ssh://git@github.com/};;
    *) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;;
  esac
  _path=$(printf '%s' "$_path" | tr '[:upper:]' '[:lower:]')
  case "$_path" in "$_identity"|"$_identity.git") ;; *) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
done
git check-ref-format "refs/heads/${op_branch:?}"
test "$(git symbolic-ref --short HEAD)" = "${op_branch:?}"
test "$(git rev-parse HEAD)" = "${op_local_pre_head:?}"
op_remote_head=$(git ls-remote --exit-code --refs "${op_push_url:?}" "refs/heads/${op_branch:?}")
op_remote_head=${op_remote_head%%[[:space:]]*}
test "${op_remote_head:?}" = "${op_local_pre_head:?}"
printf '%s\n' "${op_remote_head:?}"
```

**Fetch the exact selected base.** Load the selected destination ref and observed SHA as `op_selected_ref` and `op_selected_sha`, including trunk after a parent merge. These identify the fetch target, not the patch endpoints. A plan boot uses the selected head ref and head SHA through the same block. Fetch that ref and require `FETCH_HEAD` to equal the observed SHA. Record the printed SHA as `op_new_base`. A URL fetch does not refresh `origin/main`; never use a tracking ref as its result. If the base advances between read and fetch, re-read and assess changed inputs before retrying.

```sh
: "${op_host:?}" "${op_owner:?}" "${op_name:?}" "${op_remote:?}" "${op_selected_ref:?}" "${op_selected_sha:?}"
set -eu
test "${op_host:?}" = github.com || { printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1; }
case "${op_owner:?}" in *[!A-Za-z0-9-]*|-*) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
case "${op_name:?}" in .|..|*[!A-Za-z0-9._-]*) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
if git config --includes --get-regexp '^(url\..*\.(insteadof|pushinsteadof)|remote\..*:.*)$' >/dev/null; then
  printf '%s\n' 'URL rewriting is unsupported, including URL-named remote aliases' >&2; exit 1
else
  _status=$?; test "$_status" -eq 1 || exit "$_status"
fi
op_fetch_url=$(git remote get-url --all "${op_remote:?}")
op_push_url=$(git remote get-url --push --all "${op_remote:?}")
_identity=$(printf '%s' "${op_owner:?}/${op_name:?}" | tr '[:upper:]' '[:lower:]')
for _url in "$op_fetch_url" "$op_push_url"; do
  case "$_url" in
    https://github.com/*) _path=${_url#https://github.com/};;
    git@github.com:*) _path=${_url#git@github.com:};;
    ssh://git@github.com/*) _path=${_url#ssh://git@github.com/};;
    *) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;;
  esac
  _path=$(printf '%s' "$_path" | tr '[:upper:]' '[:lower:]')
  case "$_path" in "$_identity"|"$_identity.git") ;; *) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
done
git check-ref-format "refs/heads/${op_selected_ref:?}"
git fetch --no-tags --no-recurse-submodules "${op_fetch_url:?}" "refs/heads/${op_selected_ref:?}"
op_new_base=$(git rev-parse --verify 'FETCH_HEAD^{commit}')
test "${op_new_base:?}" = "${op_selected_sha:?}"
printf '%s\n' "${op_new_base:?}"
```

For an independent branch with affected requests withdrawn and lease captured, rebase onto that exact fetched SHA.

```sh
: "${op_new_base:?}" "${op_branch:?}"
set -eu
test "$(git symbolic-ref --short HEAD)" = "${op_branch:?}"
git rebase "${op_new_base:?}" --no-update-refs
```

**Publish a later wave.** Verify the fast-forward changes or rewrite, then use its previously captured remote SHA. Publish only the recorded branch with hooks enabled. The flags suppress implicit tag and submodule pushes. Both rebase blocks suppress updates to other local branches. A failed operation stops publication.

```sh
: "${op_host:?}" "${op_owner:?}" "${op_name:?}" "${op_remote:?}" "${op_branch:?}" "${op_remote_head:?}"
set -eu
test "${op_host:?}" = github.com || { printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1; }
case "${op_owner:?}" in *[!A-Za-z0-9-]*|-*) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
case "${op_name:?}" in .|..|*[!A-Za-z0-9._-]*) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
if git config --includes --get-regexp '^(url\..*\.(insteadof|pushinsteadof)|remote\..*:.*)$' >/dev/null; then
  printf '%s\n' 'URL rewriting is unsupported, including URL-named remote aliases' >&2; exit 1
else
  _status=$?; test "$_status" -eq 1 || exit "$_status"
fi
op_fetch_url=$(git remote get-url --all "${op_remote:?}")
op_push_url=$(git remote get-url --push --all "${op_remote:?}")
_identity=$(printf '%s' "${op_owner:?}/${op_name:?}" | tr '[:upper:]' '[:lower:]')
for _url in "$op_fetch_url" "$op_push_url"; do
  case "$_url" in
    https://github.com/*) _path=${_url#https://github.com/};;
    git@github.com:*) _path=${_url#git@github.com:};;
    ssh://git@github.com/*) _path=${_url#ssh://git@github.com/};;
    *) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;;
  esac
  _path=$(printf '%s' "$_path" | tr '[:upper:]' '[:lower:]')
  case "$_path" in "$_identity"|"$_identity.git") ;; *) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
done
git check-ref-format "refs/heads/${op_branch:?}"
test "$(git symbolic-ref --short HEAD)" = "${op_branch:?}"
git push "${op_push_url:?}" "refs/heads/${op_branch:?}:refs/heads/${op_branch:?}" "--force-with-lease=refs/heads/${op_branch:?}:${op_remote_head:?}" --no-follow-tags --no-recurse-submodules
```

On rejection, abort and report the newly observed identity for review. Never replace the captured SHA with a later tracking ref to retry. Read the published head back after success and keep it distinct from the original verdict head.

**First publication.** Use this complete block for an unpublished owned branch. The explicit empty expected value atomically requires the destination ref to be absent, including a concurrent creator. It is an expected-absence creation condition, never a captured rewrite lease. An existing branch refuses; do not replace this condition to retry.

```sh
: "${op_host:?}" "${op_owner:?}" "${op_name:?}" "${op_remote:?}" "${op_branch:?}"
set -eu
test "${op_host:?}" = github.com || { printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1; }
case "${op_owner:?}" in *[!A-Za-z0-9-]*|-*) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
case "${op_name:?}" in .|..|*[!A-Za-z0-9._-]*) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
if git config --includes --get-regexp '^(url\..*\.(insteadof|pushinsteadof)|remote\..*:.*)$' >/dev/null; then
  printf '%s\n' 'URL rewriting is unsupported, including URL-named remote aliases' >&2; exit 1
else
  _status=$?; test "$_status" -eq 1 || exit "$_status"
fi
op_fetch_url=$(git remote get-url --all "${op_remote:?}")
op_push_url=$(git remote get-url --push --all "${op_remote:?}")
_identity=$(printf '%s' "${op_owner:?}/${op_name:?}" | tr '[:upper:]' '[:lower:]')
for _url in "$op_fetch_url" "$op_push_url"; do
  case "$_url" in
    https://github.com/*) _path=${_url#https://github.com/};;
    git@github.com:*) _path=${_url#git@github.com:};;
    ssh://git@github.com/*) _path=${_url#ssh://git@github.com/};;
    *) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;;
  esac
  _path=$(printf '%s' "$_path" | tr '[:upper:]' '[:lower:]')
  case "$_path" in "$_identity"|"$_identity.git") ;; *) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
done
git check-ref-format "refs/heads/${op_branch:?}"
test "$(git symbolic-ref --short HEAD)" = "${op_branch:?}"
git push --no-follow-tags --no-recurse-submodules "${op_push_url:?}" "refs/heads/${op_branch:?}:refs/heads/${op_branch:?}" "--force-with-lease=refs/heads/${op_branch:?}:"
```

**Restack an actual child.** Select its operation record with `op_branch` equal to the child's branch. Capture old parent and child tips before either changes. Verify ancestry and list its own commit range.

```sh
: "${op_old_parent_tip:?}" "${op_old_child_tip:?}"
set -eu
git merge-base --is-ancestor "${op_old_parent_tip:?}" "${op_old_child_tip:?}"
git log --oneline "${op_old_parent_tip:?}..${op_old_child_tip:?}"
```

The subject list is diagnostic. Capture the exact original contribution from the old parent tip to the old child tip with the same canonical patch command below. Load those SHAs as `op_patch_base` and `op_patch_head`, save stdout in the child's original patch file and preserve its identity. After the parent actually merges, fetch the new selected base through the preceding block and verify its merge commit is on that base. Withdraw the child and affected descendants. Refuse restack if the child no longer equals its recorded old tip. The complete block checks ancestry and a nonempty own range before changing refs. Preserve its printed original and rewritten counts. If the counts differ or any check fails, refuse publication and investigate before fresh verification.

```sh
: "${op_new_base:?}" "${op_old_parent_tip:?}" "${op_old_child_tip:?}" "${op_branch:?}"
set -eu
git check-ref-format "refs/heads/${op_branch:?}"
test "$(git rev-parse --verify "refs/heads/${op_branch:?}")" = "${op_old_child_tip:?}"
git merge-base --is-ancestor "${op_old_parent_tip:?}" "${op_old_child_tip:?}"
op_child_count=$(git rev-list --count "${op_old_parent_tip:?}..${op_old_child_tip:?}")
test "${op_child_count:?}" -gt 0
printf 'Original child commits: %s\n' "${op_child_count:?}"
git rebase --onto "${op_new_base:?}" "${op_old_parent_tip:?}" "${op_branch:?}" --no-update-refs
op_rewritten_count=$(git rev-list --count "${op_new_base:?}..refs/heads/${op_branch:?}")
printf 'Rewritten child commits: %s\n' "${op_rewritten_count:?}"
test "${op_rewritten_count:?}" -eq "${op_child_count:?}"
```

Use the same canonical patch command to capture the rewritten own range, from `op_new_base` to the rewritten child SHA, into a separate file. Compare it byte for byte with the original contribution and confirm parent commits did not return. A changed patch requires fresh verification before publication. After squash or changed base inputs, verify final behavior too. Publish with this child's captured lease and reverify it. Never infer the old parent from the rewritten graph. Independent PRs remain independent.

**Audit evidence per lane.** Stable patch-id is a diagnostic, never permission to reuse evidence. Preserve complete patch bytes, including whitespace, binary changes and submodule commit identities. Touched-file base content is part of this exact identity because full-index records both complete blob identities. Base drift in a touched file can therefore require fresh verification even when the semantic contribution seems unchanged. Include that preparation and rerun cost in performance evidence. This option set overrides relative filtering, context, algorithm, color and submodule hiding from any working directory. External diff and text conversion are disabled.

```sh
: "${op_patch_base:?}" "${op_patch_head:?}"
unset GIT_DIFF_OPTS
git -c core.quotePath=true -c diff.suppressBlankEmpty=false -c diff.orderFile=/dev/null diff --no-relative --unified=3 --inter-hunk-context=0 --diff-algorithm=myers --no-indent-heuristic --no-color --ignore-submodules=none --submodule=short --no-ext-diff --no-textconv --binary --full-index --no-renames --src-prefix=a/ --dst-prefix=b/ --output-indicator-new=+ --output-indicator-old=- --output-indicator-context=' ' "${op_patch_base:?}" "${op_patch_head:?}" --
```

Compare those files byte for byte. For each lane also audit changes to the base, dependencies, configuration, build tools, and runtime inputs. A changed patch, changed relevant input, or uncertain impact requires a rerun. Even equal patch bytes cannot preserve a lane when a changed base dependency changes its output. `console.log("a b")` and `console.log("ab")` can have equal stable patch-id but different output and patch bytes. Both cases require fresh affected verification. Live lanes without reproducible build output rerun. Preserve original evidence identities and record each reuse decision without relabeling old proof as a run on the new head. Always run current required checks.

**Submit only the verified identity.** An agent-assisted Shipping merge needs its independent per-PR verifier verdict; a program needs the root's current independent verdict. Require all current PR requirements passed, published head equal to local `HEAD`, and a fresh head and base read. Resolve drift first. For a merge-when-ready request, watch until current requirements pass, then re-read identity and base before submission. Do not arm pending auto-merge as a substitute; `gh pr merge` can arm it when queue-branch checks are pending.

For an authorized direct squash merge or native queue submission, read the actual selected PR body into an operation-owned file. Keep text as data and submit only the published head.

```sh
: "${op_host:?}" "${op_owner:?}" "${op_name:?}" "${op_pr:?}" "${op_published_head:?}" "${op_body_file:?}"
set -eu
test "${op_host:?}" = github.com || { printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1; }
case "${op_owner:?}" in *[!A-Za-z0-9-]*|-*) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
case "${op_name:?}" in .|..|*[!A-Za-z0-9._-]*) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
op_repo="${op_owner:?}/${op_name:?}"
GH_HOST="${op_host:?}" gh pr view --repo "${op_repo:?}" "${op_pr:?}" --json body --jq .body > "${op_body_file:?}"
GH_HOST="${op_host:?}" gh pr merge --repo "${op_repo:?}" "${op_pr:?}" --squash --match-head-commit "${op_published_head:?}" --body-file "${op_body_file:?}"
```

The raw `gh --jq .body` output adds a trailing LF; preserve that captured file as data. Only final LF normalization is allowed when comparing the selected PR body with the actual direct squash commit body. Preserve all other whitespace and literal text. The file supplies the body for a direct squash merge. A native queue controls merge method and commit metadata under GitHub's repository policy; do not promise that a CLI body overrides the queue. Retain the body receipt, inspect the actual merge commit and report differences. `--match-head-commit` is a server precondition at submission, not a permanent lock on auto-merge or an atomic expected-base condition. Read back head, base, queue membership and auto-merge after submission and every wake. Withdraw an unexpected pending request the program did not authorize. Wait for actual `MERGED`, then reconcile commit and destination. An accepted server request can finish after chats close. Closing a chat does not withdraw it. GitHub's queue and required CI do not publish or enforce the independent root verdict.

### Shipping

Before the first PR operation, read the Guarded operations section below. Capture its operation record and follow its identity, withdrawal, publication and evidence rules.

**You own what lands. Verify each PR independently, land only the verified run from the root, then keep your hands off the queue.**

This is the half after `playbooks/babysit.md`.

1. **Resolve the forge, then verify every PR independently.** Use the supported GitHub CLI path from Guarded operations with the captured operation record and explicit `--repo <owner/name>`. Refuse an Origin mutation path because its expected-head adapter is unproven. Never require Graphite (`gt`). One subagent per PR, not batched, each in its own worktree, each exercising the real surface with the matching driver skill (such as `verify` for UIs or `run` for CLIs and TUIs) against parent versus head. Each returns `PASS`, `PASS+NOTES` or `FAIL` and posts that verdict on its own PR. Safe means a verdict from an agent that did not write the code. CI green is not a verdict, and an approving bot review is not a verdict.
2. **Land only the contiguous verified run rooted at the bottom.** Walk up from the lowest unmerged PR and stop at the first one without a passing verdict, where both `PASS` and `PASS+NOTES` pass. A verified PR sitting above an unverified one is not landable. Report the ceiling as a PR number and say what breaks the chain.
3. **Audit each verdict against current inputs.** Preserve the original verdict head and base, exact patch bytes, and each lane's receipts and runtime inputs. Follow Guarded operations to compare exact patch bytes and audit changed base dependencies, configuration, build tools, and runtime inputs per lane. Matching stable patch-id alone never preserves evidence. Rerun a lane when its patch or relevant inputs changed, when impact is uncertain, or when live proof has no reproducible build output. Record any reuse against the original evidence identity. Always run current required checks.
4. **Prepare only the bottom PR.** Read and withdraw affected queue and auto-merge requests, including actual dependent descendants, before a rewrite or retarget. Fetch the selected trunk ref through Guarded operations, capture FETCH_HEAD and compare it to the observed destination SHA. Rebase the lowest verified branch onto that exact captured SHA when needed, publish with its captured-SHA lease, and retarget only that PR with the complete Guarded operations Retarget block. Re-run step 3 after the push. Do not retarget, arm, or merge descendants yet.
5. **Land one PR at a time.** Require the current independent verdict and all current requirements to pass. For a merge-when-ready request, watch until current requirements pass, then re-read identity and base. Use the expected-head command in Guarded operations with the selected PR body file. Read back queue membership and auto-merge, and wait for actual `MERGED` before preparing the next PR. Operator-named items remain at merge-ready for the operator's click.
6. **Read queue membership and auto-merge separately.** Use the Guarded operations query. `autoMergeRequest` means auto-merge was requested; `mergeQueueEntry` means the PR is admitted to the queue. Neither proves that its independent verdict is current or that a descendant is ready. Failed reads and missing fields leave state unknown and stop progression.
7. **Recompute after every merge.** Fetch trunk through the Guarded operations exact-base recipe, capture and verify its SHA, and confirm the merged SHA is present, drop the merged PR from the frozen bottom-to-top list, and inspect the new bottom PR's base, head, checks, and verdict inputs. A host may retarget a child automatically, but do not assume it did. Restack through Guarded operations using the recorded old parent and child tips, the ancestry and own-range checks, and `rebase --onto`. After a squash, confirm the rewritten range contains only the child contribution. Repeat steps 3 through 6 for that one PR. Independent work stays outside this chain and ships on its own.
8. **Watch the current frontier until it merges or fails. Do not mutate the queue around it.** Use `GH_HOST="${op_host:?}" scripts/watch-pr/watch-pr --owner "${op_owner:?}" --repo "${op_name:?}" --pr "${op_pr:?}" --queued-stack --stack-prs "${op_pr:?}"` only as an event wake and poll `GH_HOST=<validated-host> gh pr view --repo <owner/name> <pr> --json state,mergedAt,mergeStateStatus,statusCheckRollup,autoMergeRequest` and the Guarded operations identity query after each wake, ignoring `READY` until `mergedAt` is non-null or `state` is `MERGED`. Compare the watcher's owner, repository and PR number to the record; after each wake execute the Guarded identity query, then compare head, base, queue and auto-merge from that complete response. A mismatch stops progression. Only then run step 7. Hard-fail only when `state` is `CLOSED` with no `mergedAt`, a required check concludes `FAILURE` or `CANCELLED` and blocks merge after auto-merge is no longer pending, or `mergeStateStatus` is `UNSTABLE` or `DIRTY` with no auto-merge pending. `BLOCKED` while checks are pending or auto-merge is armed is not failure. Do not use Babysit's queued `WAITING`/`merge-queue` stop condition here. Hold the watch under `/loop` in dynamic mode. Report each merge and the new ceiling. If the queue stalls, diagnose before mutating.
9. **Stop at the ceiling.** When the verified run is merged, report what landed, what the next unverified PR is, and what verifying it would take. Extending the run is a new pass through step 1.

**Reply:** the verified run and its ceiling, each PR's verdict and who produced it, what you armed and how you confirmed it, what landed, and what the next gap needs.

#### Guarded operations

Read this section before the first PR operation. Git 2.38 or newer is required for the explicit no-update-refs control; stop on older Git, with no fallback rebase. The invoking playbook retains its topology and merge authority. Loading this recipe grants neither. Operator-named items stop for the operator's review and click.

**Capture one operation record.** Record GitHub host, owner and repository name, PR number and node ID, one owned branch, selected Git remote name, validated fetch and push URLs, captured remote head, local pre-rewrite head, current published head, verdict head, and current base ref and SHA. Preserve the verdict's original base ref and SHA, exact patch file, lane receipts and runtime inputs. For a dependent child also record the parent PR, old parent tip and old child tip before either changes. Keep candidate SHA separate from contribution and verdict identities.

Record the selected Git remote name in `op_remote`. Resolve and validate both of its destinations with this complete block. It accepts same-repository GitHub HTTPS, scp-style SSH and `ssh://git@github.com/` URLs, with optional `.git`, and compares owner/name case-insensitively. It refuses local paths, other hosts or repositories, credentials, unsupported forms and multiple destinations before transport. URL rewrite configuration and URL-named remote definitions are unsupported, including inherited or included entries. Every transport block repeats this boundary check before resolving URLs; no recorded URL bypasses it. Do not modify user configuration or disable hooks to proceed. This validates Git URL resolution. The Git executable, SSH host authentication, TLS, custom transport programs and enabled hooks remain trusted runtime inputs. Canonical forge readbacks detect a differing observed repository head; they do not authenticate an arbitrary executable or undo a write.

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

Load recorded inputs in the same shell invocation as each complete block. Shell environment does not persist across tool calls. Every block refuses missing or empty inputs; do not copy only its last line. Bind the validated host on each `gh` command. Pass explicit repository and PR to every `gh pr` command. Before PR creation, validate branch and URLs and record its published head; use the complete Create block below to read the created PR back and complete the record. Use the complete Retarget and Ready blocks for those mutations. Use the standalone read-only canonical identity block below after every wake, for reconciliation and before withdrawal or merge preparation. It preserves the expected tuple, observed state, both pending modes, request times and status on stderr. Retain stdout and stderr with the exact source head and operation inputs. Every write block also checks its own identity. Failed or partial reads stop progression; preserve the failed receipt and use a new read-only observation, never a repeated write, to investigate.

```sh
: "${op_host:?}" "${op_owner:?}" "${op_name:?}" "${op_branch:?}" "${op_published_head:?}" "${op_pr:?}" "${op_pr_node_id:?}" "${op_base_ref:?}" "${op_base_sha:?}"
set -eu
test "${op_host:?}" = github.com || { printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1; }
case "${op_owner:?}" in *[!A-Za-z0-9-]*|-*) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
case "${op_name:?}" in .|..|*[!A-Za-z0-9._-]*) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
_operation=reconcile
case "${op_pr:?}" in *[!0-9]*|0*) exit 1;; esac
test "$(git check-ref-format --branch "${op_branch:?}")" = "${op_branch:?}"
git check-ref-format "refs/heads/${op_branch:?}"
_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_read_status=0
_forge_record=$(GH_HOST="${op_host:?}" gh api --hostname "${op_host:?}" graphql -f owner="${op_owner:?}" -f name="${op_name:?}" -F number="${op_pr:?}" -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){nameWithOwner pullRequest(number:$number){id number state isDraft headRefName headRefOid headRepository{nameWithOwner} baseRefName baseRefOid mergedAt mergeCommit{oid} autoMergeRequest{enabledAt} mergeQueueEntry{id}}}}' --jq 'if .errors == null then .data.repository as $r | $r.pullRequest as $p | if ($r.nameWithOwner|type) == "string" and ($p.id|type) == "string" and ($p.number|type) == "number" and ($p.isDraft|type) == "boolean" and ($p.headRepository.nameWithOwner|type) == "string" and ($p.headRefName|type) == "string" and ($p.headRefOid|type) == "string" and ($p.baseRefName|type) == "string" and ($p.baseRefOid|type) == "string" and (["OPEN","CLOSED","MERGED"]|index($p.state)) != null and ($p|has("autoMergeRequest")) and ($p.autoMergeRequest == null or ($p.autoMergeRequest.enabledAt|type) == "string") and ($p|has("mergeQueueEntry")) and ($p.mergeQueueEntry == null or ($p.mergeQueueEntry.id|type) == "string") and ($p.state != "MERGED" or (($p.mergeCommit.oid|type) == "string" and ($p.mergedAt|type) == "string")) then [($r.nameWithOwner|ascii_downcase),($p.number|tostring),$p.id,($p.headRepository.nameWithOwner|ascii_downcase),$p.headRefName,$p.headRefOid,$p.baseRefName,$p.baseRefOid,($p.isDraft|tostring),$p.state,($p.autoMergeRequest != null|tostring),($p.mergeQueueEntry != null|tostring),($p.mergeCommit.oid // "-")] | @tsv else ["INVALID",tojson] | @tsv end else ["INVALID",tojson] | @tsv end') || _read_status=$?
_ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_identity=$(printf '%s' "${op_owner:?}/${op_name:?}" | tr '[:upper:]' '[:lower:]')
_expected=$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' "$_identity" "${op_pr:?}" "${op_pr_node_id:?}" "$_identity" "${op_branch:?}" "${op_published_head:?}" "${op_base_ref:?}" "${op_base_sha:?}")
_observed=$(printf '%s\n' "$_forge_record" | cut -f 1-8)
printf 'operation=%s started=%s ended=%s status=%s expected=%s observed=%s\n' "$_operation" "$_started" "$_ended" "$_read_status" "$_expected" "$_forge_record" >&2
test "$_read_status" -eq 0 && test "$_observed" = "$_expected" || { printf '%s\n' 'Canonical PR identity mismatch: stop and reconcile without repeating a write; an observed unauthorized pending mode requires a reviewed current tuple and complete Withdraw' >&2; exit 1; }
_draft=$(printf '%s\n' "$_forge_record" | cut -f 9)
_state=$(printf '%s\n' "$_forge_record" | cut -f 10)
_auto=$(printf '%s\n' "$_forge_record" | cut -f 11)
_queue=$(printf '%s\n' "$_forge_record" | cut -f 12)
printf '%s\n' "$_forge_record"
```

Compare repository, PR number, node ID, head repository, branch, published head and base ref with the record. Check local branch and HEAD against it too. Identity mismatch stops before a write. A retargeted base ref or changed contribution head invalidates progression. Withdraw affected work before repair and re-verification. Distinguish a retarget from an advancing SHA on the same target branch, and assess that movement against each lane's inputs. Read native queue membership through the query; the current watcher's `merge-queue` reason does not prove a queue entry.

**Withdraw before a change.** Identify the affected PR and actual dependent descendants. Process descendants before their ancestor, each with its own complete record, and leave independent PRs untouched. Run this whole block. Its canonical pre-read must match repository, PR/node, branch, head and recorded base before either mutation. It removes only observed queue and auto-merge requests, then reads both states again. The GraphQL auto-merge mutation avoids the CLI's queued-PR short circuit.

```sh
: "${op_host:?}" "${op_owner:?}" "${op_name:?}" "${op_branch:?}" "${op_published_head:?}" "${op_pr:?}" "${op_pr_node_id:?}" "${op_base_ref:?}" "${op_base_sha:?}"
set -eu
test "${op_host:?}" = github.com || { printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1; }
case "${op_owner:?}" in *[!A-Za-z0-9-]*|-*) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
case "${op_name:?}" in .|..|*[!A-Za-z0-9._-]*) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
_operation=withdraw
case "${op_pr:?}" in *[!0-9]*|0*) exit 1;; esac
test "$(git check-ref-format --branch "${op_branch:?}")" = "${op_branch:?}"
git check-ref-format "refs/heads/${op_branch:?}"
_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_read_status=0
_forge_record=$(GH_HOST="${op_host:?}" gh api --hostname "${op_host:?}" graphql -f owner="${op_owner:?}" -f name="${op_name:?}" -F number="${op_pr:?}" -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){nameWithOwner pullRequest(number:$number){id number state isDraft headRefName headRefOid headRepository{nameWithOwner} baseRefName baseRefOid mergedAt mergeCommit{oid} autoMergeRequest{enabledAt} mergeQueueEntry{id}}}}' --jq 'if .errors == null then .data.repository as $r | $r.pullRequest as $p | if ($r.nameWithOwner|type) == "string" and ($p.id|type) == "string" and ($p.number|type) == "number" and ($p.isDraft|type) == "boolean" and ($p.headRepository.nameWithOwner|type) == "string" and ($p.headRefName|type) == "string" and ($p.headRefOid|type) == "string" and ($p.baseRefName|type) == "string" and ($p.baseRefOid|type) == "string" and (["OPEN","CLOSED","MERGED"]|index($p.state)) != null and ($p|has("autoMergeRequest")) and ($p.autoMergeRequest == null or ($p.autoMergeRequest.enabledAt|type) == "string") and ($p|has("mergeQueueEntry")) and ($p.mergeQueueEntry == null or ($p.mergeQueueEntry.id|type) == "string") and ($p.state != "MERGED" or (($p.mergeCommit.oid|type) == "string" and ($p.mergedAt|type) == "string")) then [($r.nameWithOwner|ascii_downcase),($p.number|tostring),$p.id,($p.headRepository.nameWithOwner|ascii_downcase),$p.headRefName,$p.headRefOid,$p.baseRefName,$p.baseRefOid,($p.isDraft|tostring),$p.state,($p.autoMergeRequest != null|tostring),($p.mergeQueueEntry != null|tostring),($p.mergeCommit.oid // "-")] | @tsv else ["INVALID",tojson] | @tsv end else ["INVALID",tojson] | @tsv end') || _read_status=$?
_ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_identity=$(printf '%s' "${op_owner:?}/${op_name:?}" | tr '[:upper:]' '[:lower:]')
_expected=$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' "$_identity" "${op_pr:?}" "${op_pr_node_id:?}" "$_identity" "${op_branch:?}" "${op_published_head:?}" "${op_base_ref:?}" "${op_base_sha:?}")
_observed=$(printf '%s\n' "$_forge_record" | cut -f 1-8)
printf 'operation=%s started=%s ended=%s status=%s expected=%s observed=%s\n' "$_operation" "$_started" "$_ended" "$_read_status" "$_expected" "$_forge_record" >&2
test "$_read_status" -eq 0 && test "$_observed" = "$_expected" || { printf '%s\n' 'Canonical PR identity mismatch: stop and reconcile without repeating a write; an observed unauthorized pending mode requires a reviewed current tuple and complete Withdraw' >&2; exit 1; }
_draft=$(printf '%s\n' "$_forge_record" | cut -f 9)
_state=$(printf '%s\n' "$_forge_record" | cut -f 10)
_auto=$(printf '%s\n' "$_forge_record" | cut -f 11)
_queue=$(printf '%s\n' "$_forge_record" | cut -f 12)
test "$_state" != MERGED || { printf '%s\n' 'MERGED: stop rewriting and reconcile the observed merge commit and destination' >&2; exit 1; }
_withdraw_status=0
if test "$_queue" = true; then
  GH_HOST="${op_host:?}" gh api --hostname "${op_host:?}" graphql -f id="${op_pr_node_id:?}" -f query='mutation($id:ID!){dequeuePullRequest(input:{id:$id}){mergeQueueEntry{id}}}' || _withdraw_status=$?
fi
_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_read_status=0
_forge_record=$(GH_HOST="${op_host:?}" gh api --hostname "${op_host:?}" graphql -f owner="${op_owner:?}" -f name="${op_name:?}" -F number="${op_pr:?}" -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){nameWithOwner pullRequest(number:$number){id number state isDraft headRefName headRefOid headRepository{nameWithOwner} baseRefName baseRefOid mergedAt mergeCommit{oid} autoMergeRequest{enabledAt} mergeQueueEntry{id}}}}' --jq 'if .errors == null then .data.repository as $r | $r.pullRequest as $p | if ($r.nameWithOwner|type) == "string" and ($p.id|type) == "string" and ($p.number|type) == "number" and ($p.isDraft|type) == "boolean" and ($p.headRepository.nameWithOwner|type) == "string" and ($p.headRefName|type) == "string" and ($p.headRefOid|type) == "string" and ($p.baseRefName|type) == "string" and ($p.baseRefOid|type) == "string" and (["OPEN","CLOSED","MERGED"]|index($p.state)) != null and ($p|has("autoMergeRequest")) and ($p.autoMergeRequest == null or ($p.autoMergeRequest.enabledAt|type) == "string") and ($p|has("mergeQueueEntry")) and ($p.mergeQueueEntry == null or ($p.mergeQueueEntry.id|type) == "string") and ($p.state != "MERGED" or (($p.mergeCommit.oid|type) == "string" and ($p.mergedAt|type) == "string")) then [($r.nameWithOwner|ascii_downcase),($p.number|tostring),$p.id,($p.headRepository.nameWithOwner|ascii_downcase),$p.headRefName,$p.headRefOid,$p.baseRefName,$p.baseRefOid,($p.isDraft|tostring),$p.state,($p.autoMergeRequest != null|tostring),($p.mergeQueueEntry != null|tostring),($p.mergeCommit.oid // "-")] | @tsv else ["INVALID",tojson] | @tsv end else ["INVALID",tojson] | @tsv end') || _read_status=$?
_ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_identity=$(printf '%s' "${op_owner:?}/${op_name:?}" | tr '[:upper:]' '[:lower:]')
_expected=$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' "$_identity" "${op_pr:?}" "${op_pr_node_id:?}" "$_identity" "${op_branch:?}" "${op_published_head:?}" "${op_base_ref:?}" "${op_base_sha:?}")
_observed=$(printf '%s\n' "$_forge_record" | cut -f 1-8)
printf 'operation=%s started=%s ended=%s status=%s expected=%s observed=%s\n' "$_operation" "$_started" "$_ended" "$_read_status" "$_expected" "$_forge_record" >&2
test "$_read_status" -eq 0 && test "$_observed" = "$_expected" || { printf '%s\n' 'Canonical PR identity mismatch: stop and reconcile without repeating a write; an observed unauthorized pending mode requires a reviewed current tuple and complete Withdraw' >&2; exit 1; }
_draft=$(printf '%s\n' "$_forge_record" | cut -f 9)
_state=$(printf '%s\n' "$_forge_record" | cut -f 10)
_auto=$(printf '%s\n' "$_forge_record" | cut -f 11)
_queue=$(printf '%s\n' "$_forge_record" | cut -f 12)
test "$_state" != MERGED || { printf '%s\n' 'MERGED: stop rewriting and reconcile the observed merge commit and destination' >&2; exit 1; }
if test "$_auto" = true; then
  GH_HOST="${op_host:?}" gh api --hostname "${op_host:?}" graphql -f id="${op_pr_node_id:?}" -f query='mutation($id:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$id}){pullRequest{id autoMergeRequest{enabledAt}}}}' || _withdraw_status=$?
fi
_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_read_status=0
_forge_record=$(GH_HOST="${op_host:?}" gh api --hostname "${op_host:?}" graphql -f owner="${op_owner:?}" -f name="${op_name:?}" -F number="${op_pr:?}" -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){nameWithOwner pullRequest(number:$number){id number state isDraft headRefName headRefOid headRepository{nameWithOwner} baseRefName baseRefOid mergedAt mergeCommit{oid} autoMergeRequest{enabledAt} mergeQueueEntry{id}}}}' --jq 'if .errors == null then .data.repository as $r | $r.pullRequest as $p | if ($r.nameWithOwner|type) == "string" and ($p.id|type) == "string" and ($p.number|type) == "number" and ($p.isDraft|type) == "boolean" and ($p.headRepository.nameWithOwner|type) == "string" and ($p.headRefName|type) == "string" and ($p.headRefOid|type) == "string" and ($p.baseRefName|type) == "string" and ($p.baseRefOid|type) == "string" and (["OPEN","CLOSED","MERGED"]|index($p.state)) != null and ($p|has("autoMergeRequest")) and ($p.autoMergeRequest == null or ($p.autoMergeRequest.enabledAt|type) == "string") and ($p|has("mergeQueueEntry")) and ($p.mergeQueueEntry == null or ($p.mergeQueueEntry.id|type) == "string") and ($p.state != "MERGED" or (($p.mergeCommit.oid|type) == "string" and ($p.mergedAt|type) == "string")) then [($r.nameWithOwner|ascii_downcase),($p.number|tostring),$p.id,($p.headRepository.nameWithOwner|ascii_downcase),$p.headRefName,$p.headRefOid,$p.baseRefName,$p.baseRefOid,($p.isDraft|tostring),$p.state,($p.autoMergeRequest != null|tostring),($p.mergeQueueEntry != null|tostring),($p.mergeCommit.oid // "-")] | @tsv else ["INVALID",tojson] | @tsv end else ["INVALID",tojson] | @tsv end') || _read_status=$?
_ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_identity=$(printf '%s' "${op_owner:?}/${op_name:?}" | tr '[:upper:]' '[:lower:]')
_expected=$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' "$_identity" "${op_pr:?}" "${op_pr_node_id:?}" "$_identity" "${op_branch:?}" "${op_published_head:?}" "${op_base_ref:?}" "${op_base_sha:?}")
_observed=$(printf '%s\n' "$_forge_record" | cut -f 1-8)
printf 'operation=%s started=%s ended=%s status=%s expected=%s observed=%s\n' "$_operation" "$_started" "$_ended" "$_read_status" "$_expected" "$_forge_record" >&2
test "$_read_status" -eq 0 && test "$_observed" = "$_expected" || { printf '%s\n' 'Canonical PR identity mismatch: stop and reconcile without repeating a write; an observed unauthorized pending mode requires a reviewed current tuple and complete Withdraw' >&2; exit 1; }
_draft=$(printf '%s\n' "$_forge_record" | cut -f 9)
_state=$(printf '%s\n' "$_forge_record" | cut -f 10)
_auto=$(printf '%s\n' "$_forge_record" | cut -f 11)
_queue=$(printf '%s\n' "$_forge_record" | cut -f 12)
test "$_state" != MERGED || { printf '%s\n' 'MERGED: stop rewriting and reconcile the observed merge commit and destination' >&2; exit 1; }
test "$_withdraw_status" -eq 0 && test "$_auto/$_queue" = false/false || { printf 'Withdrawal incomplete: status=%s expected=false/false observed=%s/%s\n' "$_withdraw_status" "$_auto" "$_queue" >&2; exit 1; }
```

A failed mutation, missing response or mismatched tuple stops progression without retrying a write. Use the standalone read-only identity block to reconcile, then resume withdrawal only for observed remaining states. If a merge wins, preserve the complete response and reconcile its merge commit and destination before any rewrite. Readback is an observation, not an atomic lock against rearming.

**Capture before every later publication wave.** Use `op_branch` for the owned branch in every capture, restack, source and destination ref. Before creating commits for a fast-forward fix wave or rewriting history, record local HEAD as `op_local_pre_head`. Capture the SHA printed below as `op_remote_head`; it must equal that local tip. Retain it across later commits and fetches, then use the publication block with this actual captured SHA. A missed capture stops publication: preserve unpublished commits and receipts and ask the root to reconcile them. Do not improvise a push, widen the lease, refresh tracking refs to manufacture it, or retry through First publication. Existing-PR capture and later publication require the recorded PR number, node ID and base ref/SHA; their fresh canonical query must also show both pending states absent.

```sh
: "${op_host:?}" "${op_owner:?}" "${op_name:?}" "${op_remote:?}" "${op_branch:?}" "${op_local_pre_head:?}" "${op_pr:?}" "${op_pr_node_id:?}" "${op_base_ref:?}" "${op_base_sha:?}"
set -eu
_operation=capture
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
export GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null
test "$(git rev-parse --is-shallow-repository)" = false || { printf '%s\n' 'Shallow history is unsupported: obtain a verified complete checkout before this operation' >&2; exit 1; }
test "$(git check-ref-format --branch "${op_branch:?}")" = "${op_branch:?}"
git check-ref-format "refs/heads/${op_branch:?}"
test "$(git symbolic-ref HEAD)" = "refs/heads/${op_branch:?}"
for _oid in "${op_local_pre_head:?}"; do
  case "$_oid" in *[!0-9a-f]*) exit 1;; esac
  test "${#_oid}" -eq 40
  test "$(git rev-parse --verify "${_oid}^{commit}")" = "$_oid"
done
test "$(git rev-parse HEAD)" = "${op_local_pre_head:?}"
op_remote_head=$(git ls-remote --exit-code --refs "${op_push_url:?}" "refs/heads/${op_branch:?}")
op_remote_head=$(printf '%s\n' "$op_remote_head" | awk -v ref="refs/heads/${op_branch:?}" 'NF == 2 && $2 == ref { count++; oid=$1 } END { if (count != 1) exit 1; print oid }')
test "${op_remote_head:?}" = "${op_local_pre_head:?}"
case "${op_pr:?}" in *[!0-9]*|0*) exit 1;; esac
_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_read_status=0
_forge_record=$(GH_HOST="${op_host:?}" gh api --hostname "${op_host:?}" graphql -f owner="${op_owner:?}" -f name="${op_name:?}" -F number="${op_pr:?}" -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){nameWithOwner pullRequest(number:$number){id number state isDraft headRefName headRefOid headRepository{nameWithOwner} baseRefName baseRefOid mergedAt mergeCommit{oid} autoMergeRequest{enabledAt} mergeQueueEntry{id}}}}' --jq 'if .errors == null then .data.repository as $r | $r.pullRequest as $p | if ($r.nameWithOwner|type) == "string" and ($p.id|type) == "string" and ($p.number|type) == "number" and ($p.isDraft|type) == "boolean" and ($p.headRepository.nameWithOwner|type) == "string" and ($p.headRefName|type) == "string" and ($p.headRefOid|type) == "string" and ($p.baseRefName|type) == "string" and ($p.baseRefOid|type) == "string" and (["OPEN","CLOSED","MERGED"]|index($p.state)) != null and ($p|has("autoMergeRequest")) and ($p.autoMergeRequest == null or ($p.autoMergeRequest.enabledAt|type) == "string") and ($p|has("mergeQueueEntry")) and ($p.mergeQueueEntry == null or ($p.mergeQueueEntry.id|type) == "string") and ($p.state != "MERGED" or (($p.mergeCommit.oid|type) == "string" and ($p.mergedAt|type) == "string")) then [($r.nameWithOwner|ascii_downcase),($p.number|tostring),$p.id,($p.headRepository.nameWithOwner|ascii_downcase),$p.headRefName,$p.headRefOid,$p.baseRefName,$p.baseRefOid,($p.isDraft|tostring),$p.state,($p.autoMergeRequest != null|tostring),($p.mergeQueueEntry != null|tostring),($p.mergeCommit.oid // "-")] | @tsv else ["INVALID",tojson] | @tsv end else ["INVALID",tojson] | @tsv end') || _read_status=$?
_ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_identity=$(printf '%s' "${op_owner:?}/${op_name:?}" | tr '[:upper:]' '[:lower:]')
_expected=$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' "$_identity" "${op_pr:?}" "${op_pr_node_id:?}" "$_identity" "${op_branch:?}" "${op_remote_head:?}" "${op_base_ref:?}" "${op_base_sha:?}")
_observed=$(printf '%s\n' "$_forge_record" | cut -f 1-8)
printf 'operation=%s started=%s ended=%s status=%s expected=%s observed=%s\n' "$_operation" "$_started" "$_ended" "$_read_status" "$_expected" "$_forge_record" >&2
test "$_read_status" -eq 0 && test "$_observed" = "$_expected" || { printf '%s\n' 'Canonical PR identity mismatch: stop and reconcile without repeating a write; an observed unauthorized pending mode requires a reviewed current tuple and complete Withdraw' >&2; exit 1; }
_draft=$(printf '%s\n' "$_forge_record" | cut -f 9)
_state=$(printf '%s\n' "$_forge_record" | cut -f 10)
_auto=$(printf '%s\n' "$_forge_record" | cut -f 11)
_queue=$(printf '%s\n' "$_forge_record" | cut -f 12)
test "$_state/$_auto/$_queue" = OPEN/false/false || { printf 'expected=OPEN/false/false observed=%s/%s/%s\n' "$_state" "$_auto" "$_queue" >&2; exit 1; }
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
export GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null
test "$(git rev-parse --is-shallow-repository)" = false || { printf '%s\n' 'Shallow history is unsupported: obtain a verified complete checkout before this operation' >&2; exit 1; }
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
export GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null
test "$(git rev-parse --is-shallow-repository)" = false || { printf '%s\n' 'Shallow history is unsupported: obtain a verified complete checkout before this operation' >&2; exit 1; }
test "$(git check-ref-format --branch "${op_branch:?}")" = "${op_branch:?}"
git check-ref-format "refs/heads/${op_branch:?}"
test "$(git symbolic-ref HEAD)" = "refs/heads/${op_branch:?}"
for _oid in "${op_new_base:?}"; do
  case "$_oid" in *[!0-9a-f]*) exit 1;; esac
  test "${#_oid}" -eq 40
  test "$(git rev-parse --verify "${_oid}^{commit}")" = "$_oid"
done
test -z "$(git status --porcelain)"
test -z "$(git rev-list --merges "${op_new_base:?}..HEAD")" || { printf '%s\n' 'Non-linear own range: preserve merge content and request root review' >&2; exit 1; }
git rebase "${op_new_base:?}" --no-update-refs
```

**Publish a later wave.** Verify the fast-forward changes or rewrite, then use its previously captured remote SHA. Publish only the recorded branch with hooks enabled. The flags suppress implicit tag and submodule pushes. Both rebase blocks suppress updates to other local branches. A failed operation stops publication.

```sh
: "${op_host:?}" "${op_owner:?}" "${op_name:?}" "${op_remote:?}" "${op_branch:?}" "${op_remote_head:?}" "${op_pr:?}" "${op_pr_node_id:?}" "${op_base_ref:?}" "${op_base_sha:?}"
set -eu
_operation=publish
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
export GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null
test "$(git rev-parse --is-shallow-repository)" = false || { printf '%s\n' 'Shallow history is unsupported: obtain a verified complete checkout before this operation' >&2; exit 1; }
test "$(git check-ref-format --branch "${op_branch:?}")" = "${op_branch:?}"
git check-ref-format "refs/heads/${op_branch:?}"
test "$(git symbolic-ref HEAD)" = "refs/heads/${op_branch:?}"
for _oid in "${op_remote_head:?}"; do
  case "$_oid" in *[!0-9a-f]*) exit 1;; esac
  test "${#_oid}" -eq 40
  test "$(git rev-parse --verify "${_oid}^{commit}")" = "$_oid"
done
case "${op_pr:?}" in *[!0-9]*|0*) exit 1;; esac
op_published_head=$(git rev-parse --verify 'HEAD^{commit}')
git push "${op_push_url:?}" "refs/heads/${op_branch:?}:refs/heads/${op_branch:?}" "--force-with-lease=refs/heads/${op_branch:?}:${op_remote_head:?}" --no-follow-tags --no-recurse-submodules
case "${op_pr:?}" in *[!0-9]*|0*) exit 1;; esac
_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_read_status=0
_forge_record=$(GH_HOST="${op_host:?}" gh api --hostname "${op_host:?}" graphql -f owner="${op_owner:?}" -f name="${op_name:?}" -F number="${op_pr:?}" -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){nameWithOwner pullRequest(number:$number){id number state isDraft headRefName headRefOid headRepository{nameWithOwner} baseRefName baseRefOid mergedAt mergeCommit{oid} autoMergeRequest{enabledAt} mergeQueueEntry{id}}}}' --jq 'if .errors == null then .data.repository as $r | $r.pullRequest as $p | if ($r.nameWithOwner|type) == "string" and ($p.id|type) == "string" and ($p.number|type) == "number" and ($p.isDraft|type) == "boolean" and ($p.headRepository.nameWithOwner|type) == "string" and ($p.headRefName|type) == "string" and ($p.headRefOid|type) == "string" and ($p.baseRefName|type) == "string" and ($p.baseRefOid|type) == "string" and (["OPEN","CLOSED","MERGED"]|index($p.state)) != null and ($p|has("autoMergeRequest")) and ($p.autoMergeRequest == null or ($p.autoMergeRequest.enabledAt|type) == "string") and ($p|has("mergeQueueEntry")) and ($p.mergeQueueEntry == null or ($p.mergeQueueEntry.id|type) == "string") and ($p.state != "MERGED" or (($p.mergeCommit.oid|type) == "string" and ($p.mergedAt|type) == "string")) then [($r.nameWithOwner|ascii_downcase),($p.number|tostring),$p.id,($p.headRepository.nameWithOwner|ascii_downcase),$p.headRefName,$p.headRefOid,$p.baseRefName,$p.baseRefOid,($p.isDraft|tostring),$p.state,($p.autoMergeRequest != null|tostring),($p.mergeQueueEntry != null|tostring),($p.mergeCommit.oid // "-")] | @tsv else ["INVALID",tojson] | @tsv end else ["INVALID",tojson] | @tsv end') || _read_status=$?
_ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_identity=$(printf '%s' "${op_owner:?}/${op_name:?}" | tr '[:upper:]' '[:lower:]')
_expected=$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' "$_identity" "${op_pr:?}" "${op_pr_node_id:?}" "$_identity" "${op_branch:?}" "${op_published_head:?}" "${op_base_ref:?}" "${op_base_sha:?}")
_observed=$(printf '%s\n' "$_forge_record" | cut -f 1-8)
printf 'operation=%s started=%s ended=%s status=%s expected=%s observed=%s\n' "$_operation" "$_started" "$_ended" "$_read_status" "$_expected" "$_forge_record" >&2
test "$_read_status" -eq 0 && test "$_observed" = "$_expected" || { printf '%s\n' 'Canonical PR identity mismatch: stop and reconcile without repeating a write; an observed unauthorized pending mode requires a reviewed current tuple and complete Withdraw' >&2; exit 1; }
_draft=$(printf '%s\n' "$_forge_record" | cut -f 9)
_state=$(printf '%s\n' "$_forge_record" | cut -f 10)
_auto=$(printf '%s\n' "$_forge_record" | cut -f 11)
_queue=$(printf '%s\n' "$_forge_record" | cut -f 12)
test "$_state/$_auto/$_queue" = OPEN/false/false || { printf 'expected=OPEN/false/false observed=%s/%s/%s\n' "$_state" "$_auto" "$_queue" >&2; exit 1; }
printf '%s\n' "${op_published_head:?}"
```

On rejection, abort and report the newly observed identity for review. Never replace the captured SHA with a later tracking ref to retry. The complete block reads the canonical PR head back after the push and checks repository, PR/node, branch, head, base and both pending states. Keep published identity distinct from the original verdict head. A failed, missing or mismatched postcondition stops progression and requires reconciliation of possible wrong-destination or concurrent writes; it does not undo a write.

**First publication.** Use this complete block for an unpublished owned branch. Retain its machine-readable output at the operation-owned `op_push_receipt` path. The empty expected lease protects a creation update; Git can still exit zero for an existing same-tip ref. Require exactly one new-ref status for the literal owned source/destination, then a complete canonical forge ref response equal to the local published head. A no-op is not an owned creation. Preserve all failed/no-op receipts and reconcile; never replace the condition to retry. A preflight absence read alone cannot resolve a concurrent same-tip creator. Before PR creation this bound ref query is the authority; later waves use the existing PR identity.

```sh
: "${op_host:?}" "${op_owner:?}" "${op_name:?}" "${op_remote:?}" "${op_branch:?}" "${op_push_receipt:?}"
set -eu
_operation=first-publication
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
export GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null
test "$(git rev-parse --is-shallow-repository)" = false || { printf '%s\n' 'Shallow history is unsupported: obtain a verified complete checkout before this operation' >&2; exit 1; }
test "$(git check-ref-format --branch "${op_branch:?}")" = "${op_branch:?}"
git check-ref-format "refs/heads/${op_branch:?}"
test "$(git symbolic-ref HEAD)" = "refs/heads/${op_branch:?}"
op_published_head=$(git rev-parse --verify 'HEAD^{commit}')
if _push_output=$(git push --porcelain --no-follow-tags --no-recurse-submodules "${op_push_url:?}" "refs/heads/${op_branch:?}:refs/heads/${op_branch:?}" "--force-with-lease=refs/heads/${op_branch:?}:"); then
  _push_status=0
else
  _push_status=$?
fi
printf '%s\n' "$_push_output" > "${op_push_receipt:?}"
test "$_push_status" -eq 0 || exit "$_push_status"
awk -F '\t' -v ref="refs/heads/${op_branch:?}" 'index($0, "\t") { count++; if (NF != 3 || $1 != "*" || $2 != ref ":" ref) bad=1 } END { exit !(count == 1 && !bad) }' "${op_push_receipt:?}" || { printf '%s\n' 'No owned creation: retain the push receipt and reconcile the existing ref' >&2; exit 1; }
_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_read_status=0
_forge_record=$(GH_HOST="${op_host:?}" gh api --hostname "${op_host:?}" graphql -f owner="${op_owner:?}" -f name="${op_name:?}" -f ref="refs/heads/${op_branch:?}" -f query='query($owner:String!,$name:String!,$ref:String!){repository(owner:$owner,name:$name){nameWithOwner ref(qualifiedName:$ref){name prefix target{oid __typename}}}}' --jq 'if .errors == null then .data.repository as $r | $r.ref as $f | if ($r.nameWithOwner|type) == "string" and ($f.name|type) == "string" and $f.prefix == "refs/heads/" and $f.target.__typename == "Commit" and ($f.target.oid|type) == "string" then [($r.nameWithOwner|ascii_downcase),($f.prefix + $f.name),$f.target.oid] | @tsv else error("Incomplete canonical branch identity") end else error("Failed canonical branch identity") end') || _read_status=$?
_ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_identity=$(printf '%s' "${op_owner:?}/${op_name:?}" | tr '[:upper:]' '[:lower:]')
_expected=$(printf '%s\t%s\t%s' "$_identity" "refs/heads/${op_branch:?}" "${op_published_head:?}")
printf 'operation=%s started=%s ended=%s status=%s expected=%s observed=%s\n' "$_operation" "$_started" "$_ended" "$_read_status" "$_expected" "$_forge_record" >&2
test "$_read_status" -eq 0 && test "$_forge_record" = "$_expected" || { printf '%s\n' 'Canonical branch readback mismatch: stop and reconcile possible wrong-destination or concurrent write' >&2; exit 1; }
printf '%s\n' "${op_published_head:?}"
```

**Restack an actual child.** Select its operation record with `op_branch` equal to the child's branch. Capture old parent and child tips before either changes. Verify ancestry and list its own commit range.

```sh
: "${op_old_parent_tip:?}" "${op_old_child_tip:?}"
set -eu
export GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null
test "$(git rev-parse --is-shallow-repository)" = false || { printf '%s\n' 'Shallow history is unsupported: obtain a verified complete checkout before this operation' >&2; exit 1; }
for _oid in "${op_old_parent_tip:?}" "${op_old_child_tip:?}"; do
  case "$_oid" in *[!0-9a-f]*) exit 1;; esac
  test "${#_oid}" -eq 40
  test "$(git rev-parse --verify "${_oid}^{commit}")" = "$_oid"
done
git merge-base --is-ancestor "${op_old_parent_tip:?}" "${op_old_child_tip:?}"
git log --oneline "${op_old_parent_tip:?}..${op_old_child_tip:?}"
```

The subject list is diagnostic. Capture the exact original contribution from the old parent tip to the old child tip with the same canonical patch command below. Load those SHAs as `op_patch_base` and `op_patch_head`, save stdout in the child's original patch file and preserve its identity. After the parent actually merges, fetch the new selected base through the preceding block and verify its merge commit is on that base. Withdraw the child and affected descendants. Refuse restack if the child no longer equals its recorded old tip. The complete block first requires the actual child owning checkout with full symbolic HEAD equal to the recorded branch and a clean tree. A root topology writer uses that granted checkout while the owner stops source writes. It checks raw endpoints, ancestry and a nonempty linear own range before detaching; never run it from another worktree. Non-linear own ranges are unsupported: preserve merge-resolution content and request root investigation instead of linearizing it. The block creates a fresh operation-owned directory with distinct original and rewritten patch files; retain its printed path and both files. These files are the comparison inputs, not caller-supplied aliases. It captures both contributions with the same canonical raw-object reader, replays while detached, and compares counts and exact bytes before a compare-and-swap of only the owned ref. Any refusal leaves the owned branch at its recorded tip unless another actor moved it; compare-and-swap refuses that race. Preserve detached work and receipts for diagnosis. To abandon a conflict, run `GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null git rebase --abort` only in this operation checkout, then return with `git switch -- "${op_branch:?}"`; after another detached refusal, record detached HEAD before that switch. Investigate and reverify before any retry. Never publish detached failed work or reset a shared ref. For a legitimate changed contribution, use Complete a reviewed changed contribution below.

```sh
: "${op_new_base:?}" "${op_old_parent_tip:?}" "${op_old_child_tip:?}" "${op_branch:?}"
set -eu
export GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null
test "$(git rev-parse --is-shallow-repository)" = false || { printf '%s\n' 'Shallow history is unsupported: obtain a verified complete checkout before this operation' >&2; exit 1; }
test "$(git check-ref-format --branch "${op_branch:?}")" = "${op_branch:?}"
git check-ref-format "refs/heads/${op_branch:?}"
test "$(git symbolic-ref HEAD)" = "refs/heads/${op_branch:?}"
op_child_git_dir=$(git rev-parse --absolute-git-dir)
for _oid in "${op_new_base:?}" "${op_old_parent_tip:?}" "${op_old_child_tip:?}"; do
  case "$_oid" in *[!0-9a-f]*) exit 1;; esac
  test "${#_oid}" -eq 40
  test "$(git rev-parse --verify "${_oid}^{commit}")" = "$_oid"
done
test "$(git rev-parse --verify "refs/heads/${op_branch:?}")" = "${op_old_child_tip:?}"
test -z "$(git status --porcelain)"
git merge-base --is-ancestor "${op_old_parent_tip:?}" "${op_old_child_tip:?}"
test -z "$(git rev-list --merges "${op_old_parent_tip:?}..${op_old_child_tip:?}")"
op_child_count=$(git rev-list --count "${op_old_parent_tip:?}..${op_old_child_tip:?}")
test "${op_child_count:?}" -gt 0
printf 'Original child commits: %s\n' "${op_child_count:?}"
op_patch_dir=$(mktemp -d "${TMPDIR:-/tmp}/pstack-restack.XXXXXXXX")
op_original_patch="${op_patch_dir:?}/original.patch"
op_rewritten_patch="${op_patch_dir:?}/rewritten.patch"
printf 'Contribution receipts: %s\n' "${op_patch_dir:?}"
op_patch_base=${op_old_parent_tip:?}
op_patch_head=${op_old_child_tip:?}
unset GIT_DIFF_OPTS
_diff_root=$(git rev-parse --show-toplevel)
if git config --show-origin --get-regexp '^(diff\.|core\.attributesfile$)' > "${op_patch_dir:?}/original.inputs"; then :; else _status=$?; test "$_status" -eq 1 || exit "$_status"; fi
git diff-tree --no-commit-id --no-renames --name-only -r -z "${op_patch_base:?}" "${op_patch_head:?}" > "${op_patch_dir:?}/original.inputs.paths"
git -C "$_diff_root" check-attr --all -z --stdin < "${op_patch_dir:?}/original.inputs.paths" >> "${op_patch_dir:?}/original.inputs"
git -c core.quotePath=true -c diff.suppressBlankEmpty=false -c diff.orderFile=/dev/null diff --no-relative --unified=3 --inter-hunk-context=0 --diff-algorithm=myers --no-indent-heuristic --no-color --ignore-submodules=none --submodule=short --no-ext-diff --no-textconv --binary --full-index --no-renames --src-prefix=a/ --dst-prefix=b/ --output-indicator-new=+ --output-indicator-old=- --output-indicator-context=' ' "${op_patch_base:?}" "${op_patch_head:?}" -- > "${op_original_patch:?}"
git switch --detach "${op_old_child_tip:?}"
git rebase --onto "${op_new_base:?}" "${op_old_parent_tip:?}" --no-update-refs
op_rewritten_head=$(git rev-parse --verify 'HEAD^{commit}')
op_rewritten_count=$(git rev-list --count "${op_new_base:?}..${op_rewritten_head:?}")
printf 'Rewritten child commits: %s\n' "${op_rewritten_count:?}"
test "${op_rewritten_count:?}" -eq "${op_child_count:?}"
op_patch_base=${op_new_base:?}
op_patch_head=${op_rewritten_head:?}
_diff_root=$(git rev-parse --show-toplevel)
if git config --show-origin --get-regexp '^(diff\.|core\.attributesfile$)' > "${op_patch_dir:?}/rewritten.inputs"; then :; else _status=$?; test "$_status" -eq 1 || exit "$_status"; fi
git diff-tree --no-commit-id --no-renames --name-only -r -z "${op_patch_base:?}" "${op_patch_head:?}" > "${op_patch_dir:?}/rewritten.inputs.paths"
git -C "$_diff_root" check-attr --all -z --stdin < "${op_patch_dir:?}/rewritten.inputs.paths" >> "${op_patch_dir:?}/rewritten.inputs"
git -c core.quotePath=true -c diff.suppressBlankEmpty=false -c diff.orderFile=/dev/null diff --no-relative --unified=3 --inter-hunk-context=0 --diff-algorithm=myers --no-indent-heuristic --no-color --ignore-submodules=none --submodule=short --no-ext-diff --no-textconv --binary --full-index --no-renames --src-prefix=a/ --dst-prefix=b/ --output-indicator-new=+ --output-indicator-old=- --output-indicator-context=' ' "${op_patch_base:?}" "${op_patch_head:?}" -- > "${op_rewritten_patch:?}"
cmp -s "${op_original_patch:?}" "${op_rewritten_patch:?}"
test "$(git rev-parse --absolute-git-dir)" = "${op_child_git_dir:?}"
if git worktree list --porcelain | grep -Fx "branch refs/heads/${op_branch:?}"; then exit 1; else _status=$?; test "$_status" -eq 1 || exit "$_status"; fi
git update-ref "refs/heads/${op_branch:?}" "${op_rewritten_head:?}" "${op_old_child_tip:?}"
git switch -- "${op_branch:?}"
```

Retain both exact contribution files from the complete block and confirm parent commits did not return. A changed patch requires fresh verification before publication. After squash or changed base inputs, verify final behavior too. Publish with this child's captured lease and reverify it. Never infer the old parent from the rewritten graph. Independent PRs remain independent.

**Audit evidence per lane.** Stable patch-id is a diagnostic, never permission to reuse evidence. Every object/graph boundary refuses shallow history, explicitly ignores Git replacement objects and legacy graft files, and requires raw full commit endpoints. The original and rewritten contribution use this same reader; an overlay checkout HEAD is not its source identity. Preserve complete patch bytes, including whitespace, binary changes and submodule commit identities. Touched-file base content is part of this exact identity because full-index records both complete blob identities. Base drift in a touched file can therefore require fresh verification even when the semantic contribution seems unchanged. Include that preparation and rerun cost in performance evidence. This option set overrides relative filtering, context, algorithm, color and submodule hiding from any working directory. External diff and text conversion are disabled.

```sh
: "${op_patch_base:?}" "${op_patch_head:?}" "${op_diff_inputs:?}"
set -eu
export GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null
test "$(git rev-parse --is-shallow-repository)" = false || { printf '%s\n' 'Shallow history is unsupported: obtain a verified complete checkout before this operation' >&2; exit 1; }
for _oid in "${op_patch_base:?}" "${op_patch_head:?}"; do
  case "$_oid" in *[!0-9a-f]*) exit 1;; esac
  test "${#_oid}" -eq 40
  test "$(git rev-parse --verify "${_oid}^{commit}")" = "$_oid"
done
unset GIT_DIFF_OPTS
_diff_root=$(git rev-parse --show-toplevel)
if git config --show-origin --get-regexp '^(diff\.|core\.attributesfile$)' > "${op_diff_inputs:?}"; then :; else _status=$?; test "$_status" -eq 1 || exit "$_status"; fi
git diff-tree --no-commit-id --no-renames --name-only -r -z "${op_patch_base:?}" "${op_patch_head:?}" > "${op_diff_inputs:?}.paths"
git -C "$_diff_root" check-attr --all -z --stdin < "${op_diff_inputs:?}.paths" >> "${op_diff_inputs:?}"
git -c core.quotePath=true -c diff.suppressBlankEmpty=false -c diff.orderFile=/dev/null diff --no-relative --unified=3 --inter-hunk-context=0 --diff-algorithm=myers --no-indent-heuristic --no-color --ignore-submodules=none --submodule=short --no-ext-diff --no-textconv --binary --full-index --no-renames --src-prefix=a/ --dst-prefix=b/ --output-indicator-new=+ --output-indicator-old=- --output-indicator-context=' ' "${op_patch_base:?}" "${op_patch_head:?}" --
```

Compare those files byte for byte. For each lane also audit changes to the base, dependencies, configuration, build tools, and runtime inputs. A changed patch, changed relevant input, or uncertain impact requires a rerun. Even equal patch bytes cannot preserve a lane when a changed base dependency changes its output. `console.log("a b")` and `console.log("ab")` can have equal stable patch-id but different output and patch bytes. Both cases require fresh affected verification. Live lanes without reproducible build output rerun. Preserve original evidence identities and record each reuse decision without relabeling old proof as a run on the new head. Always run current required checks.

**Submit only the verified identity.** An agent-assisted Shipping merge needs its independent per-PR verifier verdict; a program needs the root's current independent verdict. Require all current PR requirements passed, published head equal to local `HEAD`, and a fresh head and base read. Resolve drift first. For a merge-when-ready request, watch until current requirements pass, then re-read identity and base before submission. Do not arm pending auto-merge as a substitute; `gh pr merge` can arm it when queue-branch checks are pending.

**Complete a reviewed changed contribution.** The default restack requires identical patch bytes and counts. If legitimate touched-file drift or a conflict changes the contribution, retain the detached work in the original child checkout. Resolve a conflict there and continue with `GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null git rebase --continue`; do not switch or move the branch yet. Record the raw rewritten head. Investigate the original and rewritten contributions, commit lists, counts, containment and any conflict resolution, then run fresh verification. A root authorized to change stack topology must review this changed source and authorize the exact completion tuple. Every changed contribution requires a fresh full evidence round before publication or merge.

Load the original checkout's absolute Git directory as `op_child_git_dir` and the reviewed detached SHA as `op_reviewed_rewritten_head`. This block prints the required TSV authorization tuple and new raw receipts before comparing `op_restack_review_file`. An empty operation-owned review file gives a read-only preparation refusal; it is not authorization. Preserve that attempt. After review, the root writes the exact approved tuple into that file, with its review and verification receipts in the decision trail. Only then rerun this block. It checks the same raw endpoints, counts and containment, requires the original clean detached checkout, and uses the captured old child tip for compare-and-swap. A changed tuple requires new review; never copy an unreviewed expected tuple to bypass refusal. Range-diff may help investigation but grants no exact-identity authority.

```sh
: "${op_new_base:?}" "${op_old_parent_tip:?}" "${op_old_child_tip:?}" "${op_branch:?}" "${op_child_git_dir:?}" "${op_reviewed_rewritten_head:?}" "${op_restack_review_file:?}"
set -eu
export GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null
test "$(git rev-parse --is-shallow-repository)" = false || { printf '%s\n' 'Shallow history is unsupported: obtain a verified complete checkout before this operation' >&2; exit 1; }
test "$(git check-ref-format --branch "${op_branch:?}")" = "${op_branch:?}"
git check-ref-format "refs/heads/${op_branch:?}"
for _oid in "${op_new_base:?}" "${op_old_parent_tip:?}" "${op_old_child_tip:?}" "${op_reviewed_rewritten_head:?}"; do
  case "$_oid" in *[!0-9a-f]*) exit 1;; esac
  test "${#_oid}" -eq 40
  test "$(git rev-parse --verify "${_oid}^{commit}")" = "$_oid"
done
test "$(git rev-parse --absolute-git-dir)" = "${op_child_git_dir:?}"
if git symbolic-ref -q HEAD; then exit 1; else _status=$?; test "$_status" -eq 1 || exit "$_status"; fi
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "${op_reviewed_rewritten_head:?}"
test "$(git rev-parse "refs/heads/${op_branch:?}")" = "${op_old_child_tip:?}"
git merge-base --is-ancestor "${op_old_parent_tip:?}" "${op_old_child_tip:?}"
git merge-base --is-ancestor "${op_new_base:?}" "${op_reviewed_rewritten_head:?}"
test -z "$(git rev-list --merges "${op_old_parent_tip:?}..${op_old_child_tip:?}")"
test -z "$(git rev-list --merges "${op_new_base:?}..${op_reviewed_rewritten_head:?}")"
_old_count=$(git rev-list --count "${op_old_parent_tip:?}..${op_old_child_tip:?}")
_new_count=$(git rev-list --count "${op_new_base:?}..${op_reviewed_rewritten_head:?}")
test "$_old_count" -gt 0 && test "$_new_count" -eq "$_old_count"
op_patch_dir=$(mktemp -d "${TMPDIR:-/tmp}/pstack-restack-review.XXXXXXXX")
git rev-list "${op_old_parent_tip:?}..${op_old_child_tip:?}" > "${op_patch_dir:?}/original.commits"
git rev-list "${op_new_base:?}..${op_reviewed_rewritten_head:?}" > "${op_patch_dir:?}/rewritten.commits"
op_patch_base=${op_old_parent_tip:?}
op_patch_head=${op_old_child_tip:?}
unset GIT_DIFF_OPTS
_diff_root=$(git rev-parse --show-toplevel)
if git config --show-origin --get-regexp '^(diff\.|core\.attributesfile$)' > "${op_patch_dir:?}/original.inputs"; then :; else _status=$?; test "$_status" -eq 1 || exit "$_status"; fi
git diff-tree --no-commit-id --no-renames --name-only -r -z "${op_patch_base:?}" "${op_patch_head:?}" > "${op_patch_dir:?}/original.inputs.paths"
git -C "$_diff_root" check-attr --all -z --stdin < "${op_patch_dir:?}/original.inputs.paths" >> "${op_patch_dir:?}/original.inputs"
git -c core.quotePath=true -c diff.suppressBlankEmpty=false -c diff.orderFile=/dev/null diff --no-relative --unified=3 --inter-hunk-context=0 --diff-algorithm=myers --no-indent-heuristic --no-color --ignore-submodules=none --submodule=short --no-ext-diff --no-textconv --binary --full-index --no-renames --src-prefix=a/ --dst-prefix=b/ --output-indicator-new=+ --output-indicator-old=- --output-indicator-context=' ' "${op_patch_base:?}" "${op_patch_head:?}" -- > "${op_patch_dir:?}/original.patch"
op_patch_base=${op_new_base:?}
op_patch_head=${op_reviewed_rewritten_head:?}
_diff_root=$(git rev-parse --show-toplevel)
if git config --show-origin --get-regexp '^(diff\.|core\.attributesfile$)' > "${op_patch_dir:?}/rewritten.inputs"; then :; else _status=$?; test "$_status" -eq 1 || exit "$_status"; fi
git diff-tree --no-commit-id --no-renames --name-only -r -z "${op_patch_base:?}" "${op_patch_head:?}" > "${op_patch_dir:?}/rewritten.inputs.paths"
git -C "$_diff_root" check-attr --all -z --stdin < "${op_patch_dir:?}/rewritten.inputs.paths" >> "${op_patch_dir:?}/rewritten.inputs"
git -c core.quotePath=true -c diff.suppressBlankEmpty=false -c diff.orderFile=/dev/null diff --no-relative --unified=3 --inter-hunk-context=0 --diff-algorithm=myers --no-indent-heuristic --no-color --ignore-submodules=none --submodule=short --no-ext-diff --no-textconv --binary --full-index --no-renames --src-prefix=a/ --dst-prefix=b/ --output-indicator-new=+ --output-indicator-old=- --output-indicator-context=' ' "${op_patch_base:?}" "${op_patch_head:?}" -- > "${op_patch_dir:?}/rewritten.patch"
_expected=$(printf 'reviewed-changed-contribution\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' "${op_child_git_dir:?}" "${op_branch:?}" "${op_old_parent_tip:?}" "${op_old_child_tip:?}" "${op_new_base:?}" "${op_reviewed_rewritten_head:?}" "$_old_count" "$(git hash-object "${op_patch_dir:?}/original.patch")" "$(git hash-object "${op_patch_dir:?}/rewritten.patch")" "$(git hash-object "${op_patch_dir:?}/original.inputs")" "$(git hash-object "${op_patch_dir:?}/rewritten.inputs")")
_observed=$(cat "${op_restack_review_file:?}")
printf 'Contribution receipts: %s\nexpected=%s\nobserved=%s\n' "${op_patch_dir:?}" "$_expected" "$_observed" >&2
test "$_observed" = "$_expected"
if git worktree list --porcelain | grep -Fx "branch refs/heads/${op_branch:?}"; then exit 1; else _status=$?; test "$_status" -eq 1 || exit "$_status"; fi
git update-ref "refs/heads/${op_branch:?}" "${op_reviewed_rewritten_head:?}" "${op_old_child_tip:?}"
git switch -- "${op_branch:?}"
```

**Create the selected PR.** After the first publication receipt and canonical ref readback, use this block. It binds the literal owned branch, published head, selected base and title/body data; retain the returned URL, PR number and node ID. A failed post-create read can leave a real PR: stop and reconcile it before retrying.

```sh
: "${op_host:?}" "${op_owner:?}" "${op_name:?}" "${op_branch:?}" "${op_published_head:?}" "${op_base_ref:?}" "${op_base_sha:?}" "${op_title:?}" "${op_body_file:?}"
set -eu
_operation=create
export GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null
test "$(git rev-parse --is-shallow-repository)" = false || { printf '%s\n' 'Shallow history is unsupported: obtain a verified complete checkout before this operation' >&2; exit 1; }
test "${op_host:?}" = github.com || { printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1; }
case "${op_owner:?}" in *[!A-Za-z0-9-]*|-*) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
case "${op_name:?}" in .|..|*[!A-Za-z0-9._-]*) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
test "$(git check-ref-format --branch "${op_branch:?}")" = "${op_branch:?}"
git check-ref-format "refs/heads/${op_branch:?}"
test "$(git symbolic-ref HEAD)" = "refs/heads/${op_branch:?}"
test "$(git rev-parse HEAD)" = "${op_published_head:?}"
git check-ref-format "refs/heads/${op_base_ref:?}"
_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_read_status=0
_forge_record=$(GH_HOST="${op_host:?}" gh api --hostname "${op_host:?}" graphql -f owner="${op_owner:?}" -f name="${op_name:?}" -f ref="refs/heads/${op_branch:?}" -f query='query($owner:String!,$name:String!,$ref:String!){repository(owner:$owner,name:$name){nameWithOwner ref(qualifiedName:$ref){name prefix target{oid __typename}}}}' --jq 'if .errors == null then .data.repository as $r | $r.ref as $f | if ($r.nameWithOwner|type) == "string" and ($f.name|type) == "string" and $f.prefix == "refs/heads/" and $f.target.__typename == "Commit" and ($f.target.oid|type) == "string" then [($r.nameWithOwner|ascii_downcase),($f.prefix + $f.name),$f.target.oid] | @tsv else error("Incomplete canonical branch identity") end else error("Failed canonical branch identity") end') || _read_status=$?
_ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_identity=$(printf '%s' "${op_owner:?}/${op_name:?}" | tr '[:upper:]' '[:lower:]')
_expected=$(printf '%s\t%s\t%s' "$_identity" "refs/heads/${op_branch:?}" "${op_published_head:?}")
printf 'operation=%s started=%s ended=%s status=%s expected=%s observed=%s\n' "$_operation" "$_started" "$_ended" "$_read_status" "$_expected" "$_forge_record" >&2
test "$_read_status" -eq 0 && test "$_forge_record" = "$_expected" || { printf '%s\n' 'Canonical branch readback mismatch: stop and reconcile possible wrong-destination or concurrent write' >&2; exit 1; }
op_repo="${op_owner:?}/${op_name:?}"
op_created_url=$(GH_HOST="${op_host:?}" gh pr create --repo "${op_repo:?}" --base "${op_base_ref:?}" --head "${op_branch:?}" --title "${op_title:?}" --body-file "${op_body_file:?}")
op_pr=${op_created_url##*/}
case "${op_pr:?}" in *[!0-9]*|0*) exit 1;; esac
test "$(printf '%s' "$op_created_url" | tr '[:upper:]' '[:lower:]')" = "https://github.com/$_identity/pull/${op_pr:?}"
case "${op_pr:?}" in *[!0-9]*|0*) exit 1;; esac
_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_read_status=0
_forge_record=$(GH_HOST="${op_host:?}" gh api --hostname "${op_host:?}" graphql -f owner="${op_owner:?}" -f name="${op_name:?}" -F number="${op_pr:?}" -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){nameWithOwner pullRequest(number:$number){id number state isDraft headRefName headRefOid headRepository{nameWithOwner} baseRefName baseRefOid mergedAt mergeCommit{oid} autoMergeRequest{enabledAt} mergeQueueEntry{id}}}}' --jq 'if .errors == null then .data.repository as $r | $r.pullRequest as $p | if ($r.nameWithOwner|type) == "string" and ($p.id|type) == "string" and ($p.number|type) == "number" and ($p.isDraft|type) == "boolean" and ($p.headRepository.nameWithOwner|type) == "string" and ($p.headRefName|type) == "string" and ($p.headRefOid|type) == "string" and ($p.baseRefName|type) == "string" and ($p.baseRefOid|type) == "string" and (["OPEN","CLOSED","MERGED"]|index($p.state)) != null and ($p|has("autoMergeRequest")) and ($p.autoMergeRequest == null or ($p.autoMergeRequest.enabledAt|type) == "string") and ($p|has("mergeQueueEntry")) and ($p.mergeQueueEntry == null or ($p.mergeQueueEntry.id|type) == "string") and ($p.state != "MERGED" or (($p.mergeCommit.oid|type) == "string" and ($p.mergedAt|type) == "string")) then [($r.nameWithOwner|ascii_downcase),($p.number|tostring),$p.id,($p.headRepository.nameWithOwner|ascii_downcase),$p.headRefName,$p.headRefOid,$p.baseRefName,$p.baseRefOid,($p.isDraft|tostring),$p.state,($p.autoMergeRequest != null|tostring),($p.mergeQueueEntry != null|tostring),($p.mergeCommit.oid // "-")] | @tsv else ["INVALID",tojson] | @tsv end else ["INVALID",tojson] | @tsv end') || _read_status=$?
_ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_identity=$(printf '%s' "${op_owner:?}/${op_name:?}" | tr '[:upper:]' '[:lower:]')
op_pr_node_id=$(printf '%s\n' "$_forge_record" | cut -f 3)
op_pr_node_id=${op_pr_node_id:-UNKNOWN}
_expected=$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' "$_identity" "${op_pr:?}" "${op_pr_node_id:?}" "$_identity" "${op_branch:?}" "${op_published_head:?}" "${op_base_ref:?}" "${op_base_sha:?}")
_observed=$(printf '%s\n' "$_forge_record" | cut -f 1-8)
printf 'operation=%s started=%s ended=%s status=%s expected=%s observed=%s\n' "$_operation" "$_started" "$_ended" "$_read_status" "$_expected" "$_forge_record" >&2
test "$_read_status" -eq 0 && test "$_observed" = "$_expected" || { printf '%s\n' 'Canonical PR identity mismatch: stop and reconcile without repeating a write; an observed unauthorized pending mode requires a reviewed current tuple and complete Withdraw' >&2; exit 1; }
_draft=$(printf '%s\n' "$_forge_record" | cut -f 9)
_state=$(printf '%s\n' "$_forge_record" | cut -f 10)
_auto=$(printf '%s\n' "$_forge_record" | cut -f 11)
_queue=$(printf '%s\n' "$_forge_record" | cut -f 12)
test "$_state/$_auto/$_queue" = OPEN/false/false || { printf 'expected=OPEN/false/false observed=%s/%s/%s\n' "$_state" "$_auto" "$_queue" >&2; exit 1; }
test "$_draft" = false
printf '%s\n' "${op_created_url:?}" "${op_pr_node_id:?}"
```

**Retarget the selected withdrawn PR.** Load the new recorded base as `op_target_base` and `op_target_base_sha`. Both current and target identities must match their complete canonical reads. The before-read requires an OPEN PR with both pending states absent; preserve the remaining read/write race and stop on any changed response.

```sh
: "${op_host:?}" "${op_owner:?}" "${op_name:?}" "${op_branch:?}" "${op_published_head:?}" "${op_pr:?}" "${op_pr_node_id:?}" "${op_base_ref:?}" "${op_base_sha:?}" "${op_target_base:?}" "${op_target_base_sha:?}"
set -eu
_operation=retarget
test "${op_host:?}" = github.com || { printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1; }
case "${op_owner:?}" in *[!A-Za-z0-9-]*|-*) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
case "${op_name:?}" in .|..|*[!A-Za-z0-9._-]*) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
test "$(git check-ref-format --branch "${op_branch:?}")" = "${op_branch:?}"
git check-ref-format "refs/heads/${op_branch:?}"
case "${op_pr:?}" in *[!0-9]*|0*) exit 1;; esac
_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_read_status=0
_forge_record=$(GH_HOST="${op_host:?}" gh api --hostname "${op_host:?}" graphql -f owner="${op_owner:?}" -f name="${op_name:?}" -F number="${op_pr:?}" -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){nameWithOwner pullRequest(number:$number){id number state isDraft headRefName headRefOid headRepository{nameWithOwner} baseRefName baseRefOid mergedAt mergeCommit{oid} autoMergeRequest{enabledAt} mergeQueueEntry{id}}}}' --jq 'if .errors == null then .data.repository as $r | $r.pullRequest as $p | if ($r.nameWithOwner|type) == "string" and ($p.id|type) == "string" and ($p.number|type) == "number" and ($p.isDraft|type) == "boolean" and ($p.headRepository.nameWithOwner|type) == "string" and ($p.headRefName|type) == "string" and ($p.headRefOid|type) == "string" and ($p.baseRefName|type) == "string" and ($p.baseRefOid|type) == "string" and (["OPEN","CLOSED","MERGED"]|index($p.state)) != null and ($p|has("autoMergeRequest")) and ($p.autoMergeRequest == null or ($p.autoMergeRequest.enabledAt|type) == "string") and ($p|has("mergeQueueEntry")) and ($p.mergeQueueEntry == null or ($p.mergeQueueEntry.id|type) == "string") and ($p.state != "MERGED" or (($p.mergeCommit.oid|type) == "string" and ($p.mergedAt|type) == "string")) then [($r.nameWithOwner|ascii_downcase),($p.number|tostring),$p.id,($p.headRepository.nameWithOwner|ascii_downcase),$p.headRefName,$p.headRefOid,$p.baseRefName,$p.baseRefOid,($p.isDraft|tostring),$p.state,($p.autoMergeRequest != null|tostring),($p.mergeQueueEntry != null|tostring),($p.mergeCommit.oid // "-")] | @tsv else ["INVALID",tojson] | @tsv end else ["INVALID",tojson] | @tsv end') || _read_status=$?
_ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_identity=$(printf '%s' "${op_owner:?}/${op_name:?}" | tr '[:upper:]' '[:lower:]')
_expected=$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' "$_identity" "${op_pr:?}" "${op_pr_node_id:?}" "$_identity" "${op_branch:?}" "${op_published_head:?}" "${op_base_ref:?}" "${op_base_sha:?}")
_observed=$(printf '%s\n' "$_forge_record" | cut -f 1-8)
printf 'operation=%s started=%s ended=%s status=%s expected=%s observed=%s\n' "$_operation" "$_started" "$_ended" "$_read_status" "$_expected" "$_forge_record" >&2
test "$_read_status" -eq 0 && test "$_observed" = "$_expected" || { printf '%s\n' 'Canonical PR identity mismatch: stop and reconcile without repeating a write; an observed unauthorized pending mode requires a reviewed current tuple and complete Withdraw' >&2; exit 1; }
_draft=$(printf '%s\n' "$_forge_record" | cut -f 9)
_state=$(printf '%s\n' "$_forge_record" | cut -f 10)
_auto=$(printf '%s\n' "$_forge_record" | cut -f 11)
_queue=$(printf '%s\n' "$_forge_record" | cut -f 12)
test "$_state/$_auto/$_queue" = OPEN/false/false || { printf 'expected=OPEN/false/false observed=%s/%s/%s\n' "$_state" "$_auto" "$_queue" >&2; exit 1; }
op_repo="${op_owner:?}/${op_name:?}"
git check-ref-format "refs/heads/${op_target_base:?}"
GH_HOST="${op_host:?}" gh pr edit --repo "${op_repo:?}" "${op_pr:?}" --base "${op_target_base:?}"
case "${op_pr:?}" in *[!0-9]*|0*) exit 1;; esac
_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_read_status=0
_forge_record=$(GH_HOST="${op_host:?}" gh api --hostname "${op_host:?}" graphql -f owner="${op_owner:?}" -f name="${op_name:?}" -F number="${op_pr:?}" -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){nameWithOwner pullRequest(number:$number){id number state isDraft headRefName headRefOid headRepository{nameWithOwner} baseRefName baseRefOid mergedAt mergeCommit{oid} autoMergeRequest{enabledAt} mergeQueueEntry{id}}}}' --jq 'if .errors == null then .data.repository as $r | $r.pullRequest as $p | if ($r.nameWithOwner|type) == "string" and ($p.id|type) == "string" and ($p.number|type) == "number" and ($p.isDraft|type) == "boolean" and ($p.headRepository.nameWithOwner|type) == "string" and ($p.headRefName|type) == "string" and ($p.headRefOid|type) == "string" and ($p.baseRefName|type) == "string" and ($p.baseRefOid|type) == "string" and (["OPEN","CLOSED","MERGED"]|index($p.state)) != null and ($p|has("autoMergeRequest")) and ($p.autoMergeRequest == null or ($p.autoMergeRequest.enabledAt|type) == "string") and ($p|has("mergeQueueEntry")) and ($p.mergeQueueEntry == null or ($p.mergeQueueEntry.id|type) == "string") and ($p.state != "MERGED" or (($p.mergeCommit.oid|type) == "string" and ($p.mergedAt|type) == "string")) then [($r.nameWithOwner|ascii_downcase),($p.number|tostring),$p.id,($p.headRepository.nameWithOwner|ascii_downcase),$p.headRefName,$p.headRefOid,$p.baseRefName,$p.baseRefOid,($p.isDraft|tostring),$p.state,($p.autoMergeRequest != null|tostring),($p.mergeQueueEntry != null|tostring),($p.mergeCommit.oid // "-")] | @tsv else ["INVALID",tojson] | @tsv end else ["INVALID",tojson] | @tsv end') || _read_status=$?
_ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_identity=$(printf '%s' "${op_owner:?}/${op_name:?}" | tr '[:upper:]' '[:lower:]')
_expected=$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' "$_identity" "${op_pr:?}" "${op_pr_node_id:?}" "$_identity" "${op_branch:?}" "${op_published_head:?}" "${op_target_base:?}" "${op_target_base_sha:?}")
_observed=$(printf '%s\n' "$_forge_record" | cut -f 1-8)
printf 'operation=%s started=%s ended=%s status=%s expected=%s observed=%s\n' "$_operation" "$_started" "$_ended" "$_read_status" "$_expected" "$_forge_record" >&2
test "$_read_status" -eq 0 && test "$_observed" = "$_expected" || { printf '%s\n' 'Canonical PR identity mismatch: stop and reconcile without repeating a write; an observed unauthorized pending mode requires a reviewed current tuple and complete Withdraw' >&2; exit 1; }
_draft=$(printf '%s\n' "$_forge_record" | cut -f 9)
_state=$(printf '%s\n' "$_forge_record" | cut -f 10)
_auto=$(printf '%s\n' "$_forge_record" | cut -f 11)
_queue=$(printf '%s\n' "$_forge_record" | cut -f 12)
test "$_state/$_auto/$_queue" = OPEN/false/false || { printf 'expected=OPEN/false/false observed=%s/%s/%s\n' "$_state" "$_auto" "$_queue" >&2; exit 1; }
```

**Make the selected PR ready.** Read its complete recorded identity first. Convert only an observed draft, then require the same identity and non-draft state. No other PR is selected from the checkout or environment.

```sh
: "${op_host:?}" "${op_owner:?}" "${op_name:?}" "${op_branch:?}" "${op_published_head:?}" "${op_pr:?}" "${op_pr_node_id:?}" "${op_base_ref:?}" "${op_base_sha:?}"
set -eu
_operation=ready
test "${op_host:?}" = github.com || { printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1; }
case "${op_owner:?}" in *[!A-Za-z0-9-]*|-*) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
case "${op_name:?}" in .|..|*[!A-Za-z0-9._-]*) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
test "$(git check-ref-format --branch "${op_branch:?}")" = "${op_branch:?}"
git check-ref-format "refs/heads/${op_branch:?}"
case "${op_pr:?}" in *[!0-9]*|0*) exit 1;; esac
_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_read_status=0
_forge_record=$(GH_HOST="${op_host:?}" gh api --hostname "${op_host:?}" graphql -f owner="${op_owner:?}" -f name="${op_name:?}" -F number="${op_pr:?}" -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){nameWithOwner pullRequest(number:$number){id number state isDraft headRefName headRefOid headRepository{nameWithOwner} baseRefName baseRefOid mergedAt mergeCommit{oid} autoMergeRequest{enabledAt} mergeQueueEntry{id}}}}' --jq 'if .errors == null then .data.repository as $r | $r.pullRequest as $p | if ($r.nameWithOwner|type) == "string" and ($p.id|type) == "string" and ($p.number|type) == "number" and ($p.isDraft|type) == "boolean" and ($p.headRepository.nameWithOwner|type) == "string" and ($p.headRefName|type) == "string" and ($p.headRefOid|type) == "string" and ($p.baseRefName|type) == "string" and ($p.baseRefOid|type) == "string" and (["OPEN","CLOSED","MERGED"]|index($p.state)) != null and ($p|has("autoMergeRequest")) and ($p.autoMergeRequest == null or ($p.autoMergeRequest.enabledAt|type) == "string") and ($p|has("mergeQueueEntry")) and ($p.mergeQueueEntry == null or ($p.mergeQueueEntry.id|type) == "string") and ($p.state != "MERGED" or (($p.mergeCommit.oid|type) == "string" and ($p.mergedAt|type) == "string")) then [($r.nameWithOwner|ascii_downcase),($p.number|tostring),$p.id,($p.headRepository.nameWithOwner|ascii_downcase),$p.headRefName,$p.headRefOid,$p.baseRefName,$p.baseRefOid,($p.isDraft|tostring),$p.state,($p.autoMergeRequest != null|tostring),($p.mergeQueueEntry != null|tostring),($p.mergeCommit.oid // "-")] | @tsv else ["INVALID",tojson] | @tsv end else ["INVALID",tojson] | @tsv end') || _read_status=$?
_ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_identity=$(printf '%s' "${op_owner:?}/${op_name:?}" | tr '[:upper:]' '[:lower:]')
_expected=$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' "$_identity" "${op_pr:?}" "${op_pr_node_id:?}" "$_identity" "${op_branch:?}" "${op_published_head:?}" "${op_base_ref:?}" "${op_base_sha:?}")
_observed=$(printf '%s\n' "$_forge_record" | cut -f 1-8)
printf 'operation=%s started=%s ended=%s status=%s expected=%s observed=%s\n' "$_operation" "$_started" "$_ended" "$_read_status" "$_expected" "$_forge_record" >&2
test "$_read_status" -eq 0 && test "$_observed" = "$_expected" || { printf '%s\n' 'Canonical PR identity mismatch: stop and reconcile without repeating a write; an observed unauthorized pending mode requires a reviewed current tuple and complete Withdraw' >&2; exit 1; }
_draft=$(printf '%s\n' "$_forge_record" | cut -f 9)
_state=$(printf '%s\n' "$_forge_record" | cut -f 10)
_auto=$(printf '%s\n' "$_forge_record" | cut -f 11)
_queue=$(printf '%s\n' "$_forge_record" | cut -f 12)
test "$_state/$_auto/$_queue" = OPEN/false/false || { printf 'expected=OPEN/false/false observed=%s/%s/%s\n' "$_state" "$_auto" "$_queue" >&2; exit 1; }
op_repo="${op_owner:?}/${op_name:?}"
if test "$_draft" = true; then
  GH_HOST="${op_host:?}" gh pr ready --repo "${op_repo:?}" "${op_pr:?}"
fi
case "${op_pr:?}" in *[!0-9]*|0*) exit 1;; esac
_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_read_status=0
_forge_record=$(GH_HOST="${op_host:?}" gh api --hostname "${op_host:?}" graphql -f owner="${op_owner:?}" -f name="${op_name:?}" -F number="${op_pr:?}" -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){nameWithOwner pullRequest(number:$number){id number state isDraft headRefName headRefOid headRepository{nameWithOwner} baseRefName baseRefOid mergedAt mergeCommit{oid} autoMergeRequest{enabledAt} mergeQueueEntry{id}}}}' --jq 'if .errors == null then .data.repository as $r | $r.pullRequest as $p | if ($r.nameWithOwner|type) == "string" and ($p.id|type) == "string" and ($p.number|type) == "number" and ($p.isDraft|type) == "boolean" and ($p.headRepository.nameWithOwner|type) == "string" and ($p.headRefName|type) == "string" and ($p.headRefOid|type) == "string" and ($p.baseRefName|type) == "string" and ($p.baseRefOid|type) == "string" and (["OPEN","CLOSED","MERGED"]|index($p.state)) != null and ($p|has("autoMergeRequest")) and ($p.autoMergeRequest == null or ($p.autoMergeRequest.enabledAt|type) == "string") and ($p|has("mergeQueueEntry")) and ($p.mergeQueueEntry == null or ($p.mergeQueueEntry.id|type) == "string") and ($p.state != "MERGED" or (($p.mergeCommit.oid|type) == "string" and ($p.mergedAt|type) == "string")) then [($r.nameWithOwner|ascii_downcase),($p.number|tostring),$p.id,($p.headRepository.nameWithOwner|ascii_downcase),$p.headRefName,$p.headRefOid,$p.baseRefName,$p.baseRefOid,($p.isDraft|tostring),$p.state,($p.autoMergeRequest != null|tostring),($p.mergeQueueEntry != null|tostring),($p.mergeCommit.oid // "-")] | @tsv else ["INVALID",tojson] | @tsv end else ["INVALID",tojson] | @tsv end') || _read_status=$?
_ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_identity=$(printf '%s' "${op_owner:?}/${op_name:?}" | tr '[:upper:]' '[:lower:]')
_expected=$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' "$_identity" "${op_pr:?}" "${op_pr_node_id:?}" "$_identity" "${op_branch:?}" "${op_published_head:?}" "${op_base_ref:?}" "${op_base_sha:?}")
_observed=$(printf '%s\n' "$_forge_record" | cut -f 1-8)
printf 'operation=%s started=%s ended=%s status=%s expected=%s observed=%s\n' "$_operation" "$_started" "$_ended" "$_read_status" "$_expected" "$_forge_record" >&2
test "$_read_status" -eq 0 && test "$_observed" = "$_expected" || { printf '%s\n' 'Canonical PR identity mismatch: stop and reconcile without repeating a write; an observed unauthorized pending mode requires a reviewed current tuple and complete Withdraw' >&2; exit 1; }
_draft=$(printf '%s\n' "$_forge_record" | cut -f 9)
_state=$(printf '%s\n' "$_forge_record" | cut -f 10)
_auto=$(printf '%s\n' "$_forge_record" | cut -f 11)
_queue=$(printf '%s\n' "$_forge_record" | cut -f 12)
test "$_state/$_auto/$_queue" = OPEN/false/false || { printf 'expected=OPEN/false/false observed=%s/%s/%s\n' "$_state" "$_auto" "$_queue" >&2; exit 1; }
test "$_draft" = false
```

For an authorized direct squash merge or native queue submission, set `op_queue_authorized` from the actual program authorization. This block requires a cleanly bound OPEN, ready, unarmed PR and matching local published head, captures its literal body, submits that expected head and reads the actual result. A queue request requires explicit queue authority. This flag does not create merge authority or override any operator hold.

```sh
: "${op_host:?}" "${op_owner:?}" "${op_name:?}" "${op_branch:?}" "${op_published_head:?}" "${op_pr:?}" "${op_pr_node_id:?}" "${op_base_ref:?}" "${op_base_sha:?}" "${op_body_file:?}" "${op_queue_authorized:?}"
set -eu
test "${op_host:?}" = github.com || { printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1; }
case "${op_owner:?}" in *[!A-Za-z0-9-]*|-*) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
case "${op_name:?}" in .|..|*[!A-Za-z0-9._-]*) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
_operation=merge
export GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null
test "$(git rev-parse --is-shallow-repository)" = false || { printf '%s\n' 'Shallow history is unsupported: obtain a verified complete checkout before this operation' >&2; exit 1; }
case "${op_pr:?}" in *[!0-9]*|0*) exit 1;; esac
test "$(git check-ref-format --branch "${op_branch:?}")" = "${op_branch:?}"
git check-ref-format "refs/heads/${op_branch:?}"
test "$(git symbolic-ref HEAD)" = "refs/heads/${op_branch:?}"
test "$(git rev-parse --verify 'HEAD^{commit}')" = "${op_published_head:?}"
case "${op_queue_authorized:?}" in true|false) ;; *) exit 1;; esac
_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_read_status=0
_forge_record=$(GH_HOST="${op_host:?}" gh api --hostname "${op_host:?}" graphql -f owner="${op_owner:?}" -f name="${op_name:?}" -F number="${op_pr:?}" -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){nameWithOwner pullRequest(number:$number){id number state isDraft headRefName headRefOid headRepository{nameWithOwner} baseRefName baseRefOid mergedAt mergeCommit{oid} autoMergeRequest{enabledAt} mergeQueueEntry{id}}}}' --jq 'if .errors == null then .data.repository as $r | $r.pullRequest as $p | if ($r.nameWithOwner|type) == "string" and ($p.id|type) == "string" and ($p.number|type) == "number" and ($p.isDraft|type) == "boolean" and ($p.headRepository.nameWithOwner|type) == "string" and ($p.headRefName|type) == "string" and ($p.headRefOid|type) == "string" and ($p.baseRefName|type) == "string" and ($p.baseRefOid|type) == "string" and (["OPEN","CLOSED","MERGED"]|index($p.state)) != null and ($p|has("autoMergeRequest")) and ($p.autoMergeRequest == null or ($p.autoMergeRequest.enabledAt|type) == "string") and ($p|has("mergeQueueEntry")) and ($p.mergeQueueEntry == null or ($p.mergeQueueEntry.id|type) == "string") and ($p.state != "MERGED" or (($p.mergeCommit.oid|type) == "string" and ($p.mergedAt|type) == "string")) then [($r.nameWithOwner|ascii_downcase),($p.number|tostring),$p.id,($p.headRepository.nameWithOwner|ascii_downcase),$p.headRefName,$p.headRefOid,$p.baseRefName,$p.baseRefOid,($p.isDraft|tostring),$p.state,($p.autoMergeRequest != null|tostring),($p.mergeQueueEntry != null|tostring),($p.mergeCommit.oid // "-")] | @tsv else ["INVALID",tojson] | @tsv end else ["INVALID",tojson] | @tsv end') || _read_status=$?
_ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_identity=$(printf '%s' "${op_owner:?}/${op_name:?}" | tr '[:upper:]' '[:lower:]')
_expected=$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' "$_identity" "${op_pr:?}" "${op_pr_node_id:?}" "$_identity" "${op_branch:?}" "${op_published_head:?}" "${op_base_ref:?}" "${op_base_sha:?}")
_observed=$(printf '%s\n' "$_forge_record" | cut -f 1-8)
printf 'operation=%s started=%s ended=%s status=%s expected=%s observed=%s\n' "$_operation" "$_started" "$_ended" "$_read_status" "$_expected" "$_forge_record" >&2
test "$_read_status" -eq 0 && test "$_observed" = "$_expected" || { printf '%s\n' 'Canonical PR identity mismatch: stop and reconcile without repeating a write; an observed unauthorized pending mode requires a reviewed current tuple and complete Withdraw' >&2; exit 1; }
_draft=$(printf '%s\n' "$_forge_record" | cut -f 9)
_state=$(printf '%s\n' "$_forge_record" | cut -f 10)
_auto=$(printf '%s\n' "$_forge_record" | cut -f 11)
_queue=$(printf '%s\n' "$_forge_record" | cut -f 12)
test "$_state/$_auto/$_queue" = OPEN/false/false || { printf 'expected=OPEN/false/false observed=%s/%s/%s\n' "$_state" "$_auto" "$_queue" >&2; exit 1; }
test "$_draft" = false || { printf 'expected=draft:false observed=draft:%s\n' "$_draft" >&2; exit 1; }
op_repo="${op_owner:?}/${op_name:?}"
GH_HOST="${op_host:?}" gh pr view --repo "${op_repo:?}" "${op_pr:?}" --json body --jq .body > "${op_body_file:?}"
git check-ref-format "refs/heads/${op_base_ref:?}"
_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_read_status=0
_base_record=$(GH_HOST="${op_host:?}" gh api --hostname "${op_host:?}" graphql -f owner="${op_owner:?}" -f name="${op_name:?}" -f ref="refs/heads/${op_base_ref:?}" -f query='query($owner:String!,$name:String!,$ref:String!){repository(owner:$owner,name:$name){nameWithOwner ref(qualifiedName:$ref){name prefix target{__typename oid}}}}' --jq 'if .errors == null then .data.repository as $r | $r.ref as $b | if ($r.nameWithOwner|type) == "string" and ($b.name|type) == "string" and ($b.prefix|type) == "string" and $b.target.__typename == "Commit" and ($b.target.oid|type) == "string" then [($r.nameWithOwner|ascii_downcase),$b.name,$b.prefix,$b.target.oid] | @tsv else ["INVALID",tojson] | @tsv end else ["INVALID",tojson] | @tsv end') || _read_status=$?
_ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_expected_base=$(printf '%s\t%s\t%s\t%s' "$_identity" "${op_base_ref:?}" 'refs/heads/' "${op_base_sha:?}")
printf 'operation=merge-base started=%s ended=%s status=%s expected=%s observed=%s\n' "$_started" "$_ended" "$_read_status" "$_expected_base" "$_base_record" >&2
test "$_read_status" -eq 0 && test "$_base_record" = "$_expected_base" || { printf '%s\n' 'Authoritative base ref mismatch: stop and reconcile the base before merge submission' >&2; exit 1; }
_write_status=0
GH_HOST="${op_host:?}" gh pr merge --repo "${op_repo:?}" "${op_pr:?}" --squash --match-head-commit "${op_published_head:?}" --body-file "${op_body_file:?}" || _write_status=$?
printf 'operation=merge submission-status=%s\n' "$_write_status" >&2
_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_read_status=0
_forge_record=$(GH_HOST="${op_host:?}" gh api --hostname "${op_host:?}" graphql -f owner="${op_owner:?}" -f name="${op_name:?}" -F number="${op_pr:?}" -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){nameWithOwner pullRequest(number:$number){id number state isDraft headRefName headRefOid headRepository{nameWithOwner} baseRefName baseRefOid mergedAt mergeCommit{oid} autoMergeRequest{enabledAt} mergeQueueEntry{id}}}}' --jq 'if .errors == null then .data.repository as $r | $r.pullRequest as $p | if ($r.nameWithOwner|type) == "string" and ($p.id|type) == "string" and ($p.number|type) == "number" and ($p.isDraft|type) == "boolean" and ($p.headRepository.nameWithOwner|type) == "string" and ($p.headRefName|type) == "string" and ($p.headRefOid|type) == "string" and ($p.baseRefName|type) == "string" and ($p.baseRefOid|type) == "string" and (["OPEN","CLOSED","MERGED"]|index($p.state)) != null and ($p|has("autoMergeRequest")) and ($p.autoMergeRequest == null or ($p.autoMergeRequest.enabledAt|type) == "string") and ($p|has("mergeQueueEntry")) and ($p.mergeQueueEntry == null or ($p.mergeQueueEntry.id|type) == "string") and ($p.state != "MERGED" or (($p.mergeCommit.oid|type) == "string" and ($p.mergedAt|type) == "string")) then [($r.nameWithOwner|ascii_downcase),($p.number|tostring),$p.id,($p.headRepository.nameWithOwner|ascii_downcase),$p.headRefName,$p.headRefOid,$p.baseRefName,$p.baseRefOid,($p.isDraft|tostring),$p.state,($p.autoMergeRequest != null|tostring),($p.mergeQueueEntry != null|tostring),($p.mergeCommit.oid // "-")] | @tsv else ["INVALID",tojson] | @tsv end else ["INVALID",tojson] | @tsv end') || _read_status=$?
_ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_identity=$(printf '%s' "${op_owner:?}/${op_name:?}" | tr '[:upper:]' '[:lower:]')
_expected=$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' "$_identity" "${op_pr:?}" "${op_pr_node_id:?}" "$_identity" "${op_branch:?}" "${op_published_head:?}" "${op_base_ref:?}" "${op_base_sha:?}")
_observed=$(printf '%s\n' "$_forge_record" | cut -f 1-8)
printf 'operation=%s started=%s ended=%s status=%s expected=%s observed=%s\n' "$_operation" "$_started" "$_ended" "$_read_status" "$_expected" "$_forge_record" >&2
test "$_read_status" -eq 0 && test "$_observed" = "$_expected" || { printf '%s\n' 'Canonical PR identity mismatch: stop and reconcile without repeating a write; an observed unauthorized pending mode requires a reviewed current tuple and complete Withdraw' >&2; exit 1; }
_draft=$(printf '%s\n' "$_forge_record" | cut -f 9)
_state=$(printf '%s\n' "$_forge_record" | cut -f 10)
_auto=$(printf '%s\n' "$_forge_record" | cut -f 11)
_queue=$(printf '%s\n' "$_forge_record" | cut -f 12)
if test "$_state" = MERGED; then
  printf 'MERGED: reconcile commit and destination from %s\n' "$_forge_record"
elif test "$_state/$_auto/$_queue/${op_queue_authorized:?}" = OPEN/false/true/true; then
  printf 'QUEUED: retain the observed entry and watch the bound PR\n'
elif test "$_auto" = true || test "$_queue" = true; then
  printf '%s\n' 'Unexpected pending request: withdraw and reconcile before progression' >&2
test "$_state" != MERGED || { printf '%s\n' 'MERGED: stop rewriting and reconcile the observed merge commit and destination' >&2; exit 1; }
_withdraw_status=0
if test "$_queue" = true; then
  GH_HOST="${op_host:?}" gh api --hostname "${op_host:?}" graphql -f id="${op_pr_node_id:?}" -f query='mutation($id:ID!){dequeuePullRequest(input:{id:$id}){mergeQueueEntry{id}}}' || _withdraw_status=$?
fi
_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_read_status=0
_forge_record=$(GH_HOST="${op_host:?}" gh api --hostname "${op_host:?}" graphql -f owner="${op_owner:?}" -f name="${op_name:?}" -F number="${op_pr:?}" -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){nameWithOwner pullRequest(number:$number){id number state isDraft headRefName headRefOid headRepository{nameWithOwner} baseRefName baseRefOid mergedAt mergeCommit{oid} autoMergeRequest{enabledAt} mergeQueueEntry{id}}}}' --jq 'if .errors == null then .data.repository as $r | $r.pullRequest as $p | if ($r.nameWithOwner|type) == "string" and ($p.id|type) == "string" and ($p.number|type) == "number" and ($p.isDraft|type) == "boolean" and ($p.headRepository.nameWithOwner|type) == "string" and ($p.headRefName|type) == "string" and ($p.headRefOid|type) == "string" and ($p.baseRefName|type) == "string" and ($p.baseRefOid|type) == "string" and (["OPEN","CLOSED","MERGED"]|index($p.state)) != null and ($p|has("autoMergeRequest")) and ($p.autoMergeRequest == null or ($p.autoMergeRequest.enabledAt|type) == "string") and ($p|has("mergeQueueEntry")) and ($p.mergeQueueEntry == null or ($p.mergeQueueEntry.id|type) == "string") and ($p.state != "MERGED" or (($p.mergeCommit.oid|type) == "string" and ($p.mergedAt|type) == "string")) then [($r.nameWithOwner|ascii_downcase),($p.number|tostring),$p.id,($p.headRepository.nameWithOwner|ascii_downcase),$p.headRefName,$p.headRefOid,$p.baseRefName,$p.baseRefOid,($p.isDraft|tostring),$p.state,($p.autoMergeRequest != null|tostring),($p.mergeQueueEntry != null|tostring),($p.mergeCommit.oid // "-")] | @tsv else ["INVALID",tojson] | @tsv end else ["INVALID",tojson] | @tsv end') || _read_status=$?
_ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_identity=$(printf '%s' "${op_owner:?}/${op_name:?}" | tr '[:upper:]' '[:lower:]')
_expected=$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' "$_identity" "${op_pr:?}" "${op_pr_node_id:?}" "$_identity" "${op_branch:?}" "${op_published_head:?}" "${op_base_ref:?}" "${op_base_sha:?}")
_observed=$(printf '%s\n' "$_forge_record" | cut -f 1-8)
printf 'operation=%s started=%s ended=%s status=%s expected=%s observed=%s\n' "$_operation" "$_started" "$_ended" "$_read_status" "$_expected" "$_forge_record" >&2
test "$_read_status" -eq 0 && test "$_observed" = "$_expected" || { printf '%s\n' 'Canonical PR identity mismatch: stop and reconcile without repeating a write; an observed unauthorized pending mode requires a reviewed current tuple and complete Withdraw' >&2; exit 1; }
_draft=$(printf '%s\n' "$_forge_record" | cut -f 9)
_state=$(printf '%s\n' "$_forge_record" | cut -f 10)
_auto=$(printf '%s\n' "$_forge_record" | cut -f 11)
_queue=$(printf '%s\n' "$_forge_record" | cut -f 12)
test "$_state" != MERGED || { printf '%s\n' 'MERGED: stop rewriting and reconcile the observed merge commit and destination' >&2; exit 1; }
if test "$_auto" = true; then
  GH_HOST="${op_host:?}" gh api --hostname "${op_host:?}" graphql -f id="${op_pr_node_id:?}" -f query='mutation($id:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$id}){pullRequest{id autoMergeRequest{enabledAt}}}}' || _withdraw_status=$?
fi
_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_read_status=0
_forge_record=$(GH_HOST="${op_host:?}" gh api --hostname "${op_host:?}" graphql -f owner="${op_owner:?}" -f name="${op_name:?}" -F number="${op_pr:?}" -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){nameWithOwner pullRequest(number:$number){id number state isDraft headRefName headRefOid headRepository{nameWithOwner} baseRefName baseRefOid mergedAt mergeCommit{oid} autoMergeRequest{enabledAt} mergeQueueEntry{id}}}}' --jq 'if .errors == null then .data.repository as $r | $r.pullRequest as $p | if ($r.nameWithOwner|type) == "string" and ($p.id|type) == "string" and ($p.number|type) == "number" and ($p.isDraft|type) == "boolean" and ($p.headRepository.nameWithOwner|type) == "string" and ($p.headRefName|type) == "string" and ($p.headRefOid|type) == "string" and ($p.baseRefName|type) == "string" and ($p.baseRefOid|type) == "string" and (["OPEN","CLOSED","MERGED"]|index($p.state)) != null and ($p|has("autoMergeRequest")) and ($p.autoMergeRequest == null or ($p.autoMergeRequest.enabledAt|type) == "string") and ($p|has("mergeQueueEntry")) and ($p.mergeQueueEntry == null or ($p.mergeQueueEntry.id|type) == "string") and ($p.state != "MERGED" or (($p.mergeCommit.oid|type) == "string" and ($p.mergedAt|type) == "string")) then [($r.nameWithOwner|ascii_downcase),($p.number|tostring),$p.id,($p.headRepository.nameWithOwner|ascii_downcase),$p.headRefName,$p.headRefOid,$p.baseRefName,$p.baseRefOid,($p.isDraft|tostring),$p.state,($p.autoMergeRequest != null|tostring),($p.mergeQueueEntry != null|tostring),($p.mergeCommit.oid // "-")] | @tsv else ["INVALID",tojson] | @tsv end else ["INVALID",tojson] | @tsv end') || _read_status=$?
_ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_identity=$(printf '%s' "${op_owner:?}/${op_name:?}" | tr '[:upper:]' '[:lower:]')
_expected=$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' "$_identity" "${op_pr:?}" "${op_pr_node_id:?}" "$_identity" "${op_branch:?}" "${op_published_head:?}" "${op_base_ref:?}" "${op_base_sha:?}")
_observed=$(printf '%s\n' "$_forge_record" | cut -f 1-8)
printf 'operation=%s started=%s ended=%s status=%s expected=%s observed=%s\n' "$_operation" "$_started" "$_ended" "$_read_status" "$_expected" "$_forge_record" >&2
test "$_read_status" -eq 0 && test "$_observed" = "$_expected" || { printf '%s\n' 'Canonical PR identity mismatch: stop and reconcile without repeating a write; an observed unauthorized pending mode requires a reviewed current tuple and complete Withdraw' >&2; exit 1; }
_draft=$(printf '%s\n' "$_forge_record" | cut -f 9)
_state=$(printf '%s\n' "$_forge_record" | cut -f 10)
_auto=$(printf '%s\n' "$_forge_record" | cut -f 11)
_queue=$(printf '%s\n' "$_forge_record" | cut -f 12)
test "$_state" != MERGED || { printf '%s\n' 'MERGED: stop rewriting and reconcile the observed merge commit and destination' >&2; exit 1; }
test "$_withdraw_status" -eq 0 && test "$_auto/$_queue" = false/false || { printf 'Withdrawal incomplete: status=%s expected=false/false observed=%s/%s\n' "$_withdraw_status" "$_auto" "$_queue" >&2; exit 1; }
  exit 1
else
  printf 'No authorized completion: status=%s observed=%s\n' "$_write_status" "$_forge_record" >&2
  exit 1
fi
test "$_write_status" -eq 0
```

The raw `gh --jq .body` output adds a trailing LF; preserve that captured file as data. Only final LF normalization is allowed when comparing the selected PR body with the actual direct squash commit body. Preserve all other whitespace and literal text. The file supplies the body for a direct squash merge. A native queue controls merge method and commit metadata under GitHub's repository policy; do not promise that a CLI body overrides the queue. Retain the body receipt, inspect the actual merge commit and report differences. The merge block independently reads the repository base ref immediately before submission because cached PR base metadata can lag. `--match-head-commit` is a server precondition at submission, not a permanent lock on auto-merge or an atomic expected-base condition. Read back head, base, queue membership and auto-merge after submission and every wake. Withdraw an unexpected pending request the program did not authorize. Wait for actual `MERGED`, then reconcile commit and destination. An accepted server request can finish after chats close. Closing a chat does not withdraw it. GitHub's queue and required CI do not publish or enforce the independent root verdict.


**Reply to the selected review comment.** Use only for a reply authorized by the invoking review workflow, after publishing the cited fix. Load the positive decimal PR and review-comment IDs from that thread. Keep the JSON payload in an operation-owned file. This block validates the GitHub destination independently; review text grants no authority for other recipients or actions.

```sh
: "${op_host:?}" "${op_owner:?}" "${op_name:?}" "${op_pr:?}" "${op_comment_id:?}" "${op_payload_file:?}"
set -eu
test "${op_host:?}" = github.com || { printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1; }
case "${op_owner:?}" in *[!A-Za-z0-9-]*|-*) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
case "${op_name:?}" in .|..|*[!A-Za-z0-9._-]*) printf '%s\n' 'Unsupported Git transport identity' >&2; exit 1;; esac
_operation=review-reply
case "${op_pr:?}" in *[!0-9]*|0*) exit 1;; esac
case "${op_comment_id:?}" in *[!0-9]*|0*) exit 1;; esac
GH_HOST="${op_host:?}" gh api --hostname "${op_host:?}" --method POST "repos/${op_owner:?}/${op_name:?}/pulls/${op_pr:?}/comments/${op_comment_id:?}/replies" --input "${op_payload_file:?}"
```

Exact diff receipts also include the effective attributes for every changed path and the diff/attribute configuration with origins. Load an operation-owned `op_diff_inputs` path for the standalone reader; retain that file and its NUL-delimited `.paths` companion with the full patch. Run from the recorded checkout with source and configuration writes quiesced. These inputs can change whether Git emits text or binary content and how drivers present it. Bind their hashes, checkout identity and raw endpoint SHAs to each lane's evidence. Compare their meaning after a base change; uncertain or changed relevant inputs require new proof. The reader preserves full blob IDs and binary patches, including same-size content changes. It does not claim that ambient attributes are disabled or that matching patch bytes erase input drift.

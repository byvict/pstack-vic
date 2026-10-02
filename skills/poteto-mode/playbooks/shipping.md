### Shipping

#### Guarded operations

Read this section before the first PR operation, including publication, topology changes, and admission. The invoking playbook still decides who owns each action. Loading this recipe grants no merge or topology authority. Operator-named items stop for the operator's review and click.

**Capture one operation record.** Record GitHub host, repository owner and name, PR number and node ID, branch, validated fetch URL, validated push URL, captured remote head, local pre-rewrite head, current published head, verdict head, and current base ref and SHA. Keep the verdict's original base ref, base SHA, exact patch file, lane receipts, and runtime inputs. For a dependent child also record the parent PR, old parent tip, and old child tip before either changes. Keep any observed candidate SHA separate from those contribution and verdict identities.

Resolve all fetch and push URLs with `git remote get-url --all <remote>` and `git remote get-url --push --all <remote>`. Support same-repository GitHub HTTPS URLs and SSH URLs for `git@github.com`, with an optional `.git` suffix. Normalize each to its host, owner, and repository name. Require one fetch destination and one push destination, both equal to the explicitly selected repository and the PR's head repository. Refuse credential-bearing URLs, unsupported hosts or URL forms, multiple destinations, and cross-repository fork topology before any write. Preserve the validated URLs in the record. Origin has no proven expected-head adapter here. If Origin is requested, report `Unsupported Origin mutation path: expected-head submission is not verified` and perform no mutation. Use the supported GitHub CLI path only when the task permits it.

Pass `--repo "$op_repo"` on every `gh pr` command, with `op_repo` equal to the recorded `owner/name`. Set `GH_HOST` to the validated `github.com` host for these commands and pass `--hostname "$op_host"` on every `gh api` command. Before creating a PR, validate the branch and URLs and record its published head. Read the new PR back to complete the same record. Before each later mutation and after every wake, read this explicitly selected PR. Failed or partial API reads stop progression.

```sh
export GH_HOST="$op_host"
gh api --hostname "$op_host" graphql -f owner="$op_owner" -f name="$op_name" -F number="$op_pr" -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){nameWithOwner pullRequest(number:$number){id number state headRefName headRefOid headRepository{nameWithOwner} baseRefName baseRefOid mergedAt mergeCommit{oid} autoMergeRequest{enabledAt} mergeQueueEntry{id}}}}'
```

Compare the returned repository, PR number, node ID, head repository, branch, published head, and base ref with the record. Verify the local branch and HEAD against the same record. An identity mismatch stops before any write. A retargeted base ref or changed contribution head invalidates progression. Withdraw the affected work before repair and re-verification. Distinguish retargeting from an advancing SHA on the same target branch. Assess that base movement against each lane's inputs. Observe native queue membership through the query above; the current watcher's `merge-queue` reason does not prove a native queue entry.

**Withdraw before a change.** Before rebasing, retargeting, or invalidating a verdict, identify the affected PR and its actual dependent descendants from the recorded topology. Leave independent PRs untouched. Process affected descendants before their ancestor. Read both `mergeQueueEntry` and `autoMergeRequest`. For each observed queue entry, use its PR node ID in this mutation:

```sh
gh api --hostname "$op_host" graphql -f id="$op_pr_node_id" -f query='mutation($id:ID!){dequeuePullRequest(input:{id:$id}){mergeQueueEntry{id}}}'
```

Re-read the PR. If an auto-merge request remains, disable it explicitly:

```sh
gh pr merge --repo "$op_repo" "$op_pr" --disable-auto
```

Then read both states back as absent for every affected PR before the first rewrite or retarget. A null mutation payload, failed call, or missing field proves no absence. Resume partial withdrawal by reading current state and withdrawing only what remains. If a concurrent merge wins, stop the rewrite and reconcile the actual merged head, base, and merge commit. Readback is an observation, not an atomic lock against another actor rearming the PR.

**Publish a rewrite.** Read the remote branch from the validated push URL before rewriting. Require that captured remote SHA to equal the local pre-rewrite `HEAD`, and retain the SHA in `op_remote_head` across every later fetch. Verify the rewrite and publish only the owned branch:

```sh
git push "$op_push_url" "HEAD:refs/heads/$op_branch" "--force-with-lease=refs/heads/$op_branch:$op_remote_head"
```

On rejection, abort and report the newly observed identity for review. Never replace the captured SHA with a later tracking ref to retry. Read the published head back after success and keep it distinct from the original verdict head. A first publication uses the validated push URL and an explicit `HEAD:refs/heads/<branch>` refspec, with hooks enabled.

**Restack an actual child.** Capture the old parent tip and old child tip before the parent moves or merges. Verify ancestry and record the child's own commit range:

```sh
git merge-base --is-ancestor "$op_old_parent_tip" "$op_old_child_tip"
git log --oneline "$op_old_parent_tip..$op_old_child_tip"
```

After the parent actually merges, verify its merge commit is on the new base. Withdraw the child and affected descendants before rewriting. Confirm the child still equals its recorded old tip, then apply only its own range:

```sh
git rebase --onto "$op_new_base" "$op_old_parent_tip" "$op_child_branch"
```

After a squash merge, compare the recorded child contribution with the rewritten range and final behavior. Confirm that parent commits did not return in the child's range. Publish with the child's captured lease and reverify it. Never infer the old parent from the rewritten graph. Independent PRs remain independent.

**Audit evidence per lane.** Stable patch-id is a diagnostic, never permission to reuse evidence. Preserve complete patch bytes, including whitespace and binary changes, with one option set for both the original verdict and current record:

```sh
git -c core.quotePath=true diff --no-ext-diff --no-textconv --binary --full-index --no-renames --src-prefix=a/ --dst-prefix=b/ "$op_base_sha" "$op_head_sha" --
```

Compare those files byte for byte. For each lane also audit changes to the base, dependencies, configuration, build tools, and runtime inputs. A changed patch, changed relevant input, or uncertain impact requires a rerun. Even equal patch bytes cannot preserve a lane when a changed base dependency changes its output. `console.log("a b")` and `console.log("ab")` can have equal stable patch-id but different output and patch bytes. Both cases require fresh affected verification. Live lanes without reproducible build output rerun. Preserve original evidence identities and record each reuse decision without relabeling old proof as a run on the new head. Always run current required checks.

**Submit only the verified identity.** Require the root's current independent verdict, all current PR requirements passed, the recorded published head equal to local `HEAD`, and a fresh head and base read. Resolve any drift through the preceding rules first. Check current requirements before submission because `gh pr merge` can arm auto-merge when a queue branch still has pending checks. For an authorized merge or enqueue, submit the published head:

```sh
gh pr merge --repo "$op_repo" "$op_pr" --squash --match-head-commit "$op_published_head"
```

`--match-head-commit` is a server precondition at submission, not a permanent lock on an auto-merge request. It does not provide an atomic expected-base condition. Read back head, base, queue membership, and auto-merge after submission and every wake. Withdraw an unexpected pending request that the program did not authorize. Wait for actual `MERGED`, then reconcile the merge commit and destination before progressing. A request GitHub already accepted can finish after chats close. Closing a chat does not withdraw it. GitHub's queue and required CI do not publish or enforce the independent root verdict.

**You own what lands. Verify each PR independently, land only the verified run from the root, then keep your hands off the queue.**

This is the half after `playbooks/babysit.md`.

1. **Resolve the forge, then verify every PR independently.** Use the supported GitHub CLI path from Guarded operations with the captured operation record and explicit `--repo <owner/name>`. Refuse an Origin mutation path because its expected-head adapter is unproven. Never require Graphite (`gt`). One subagent per PR, not batched, each in its own worktree, each exercising the real surface with the matching driver skill (such as `verify` for UIs or `run` for CLIs and TUIs) against parent versus head. Each returns `PASS`, `PASS+NOTES` or `FAIL` and posts that verdict on its own PR. Safe means a verdict from an agent that did not write the code. CI green is not a verdict, and an approving bot review is not a verdict.
2. **Land only the contiguous verified run rooted at the bottom.** Walk up from the lowest unmerged PR and stop at the first one without a passing verdict, where both `PASS` and `PASS+NOTES` pass. A verified PR sitting above an unverified one is not landable. Report the ceiling as a PR number and say what breaks the chain.
3. **Audit each verdict against current inputs.** Preserve the original verdict head and base, exact patch bytes, and each lane's receipts and runtime inputs. Follow Guarded operations to compare exact patch bytes and audit changed base dependencies, configuration, build tools, and runtime inputs per lane. Matching stable patch-id alone never preserves evidence. Rerun a lane when its patch or relevant inputs changed, when impact is uncertain, or when live proof has no reproducible build output. Record any reuse against the original evidence identity. Always run current required checks.
4. **Prepare only the bottom PR.** Read and withdraw affected queue and auto-merge requests, including actual dependent descendants, before a rewrite or retarget. Fetch current trunk from the validated fetch URL. Rebase the lowest verified branch when needed, publish with its captured-SHA lease, and retarget only that PR with `gh pr edit --repo <owner/name> <pr> --base <trunk>`. Re-run step 3 after the push. Do not retarget, arm, or merge descendants yet.
5. **Land one PR at a time.** Require the current independent verdict and all current PR requirements to pass before submission. Use the expected-head merge command in Guarded operations for the published head. Read back queue membership and auto-merge state and wait for actual `MERGED` before preparing the next PR. Operator-named items remain at merge-ready for the operator's click.
6. **Read queue membership and auto-merge separately.** Use the Guarded operations query. `autoMergeRequest` means auto-merge was requested; `mergeQueueEntry` means the PR is admitted to the queue. Neither proves that its independent verdict is current or that a descendant is ready. Failed reads and missing fields leave state unknown and stop progression.
7. **Recompute after every merge.** Fetch trunk, confirm the merged SHA is present, drop the merged PR from the frozen bottom-to-top list, and inspect the new bottom PR's base, head, checks, and verdict inputs. A host may retarget a child automatically, but do not assume it did. Restack through Guarded operations using the recorded old parent and child tips, the ancestry and own-range checks, and `rebase --onto`. After a squash, confirm the rewritten range contains only the child contribution. Repeat steps 3 through 6 for that one PR. Independent work stays outside this chain and ships on its own.
8. **Watch the current frontier until it merges or fails. Do not mutate the queue around it.** Use `scripts/watch-pr/watch-pr --owner <owner> --repo <repo> --queued-stack --stack-prs <bottom>` only as an event wake and poll `gh pr view --repo <owner/name> <pr> --json state,mergedAt,mergeStateStatus,statusCheckRollup,autoMergeRequest` and the Guarded operations identity query after each wake, ignoring `READY` until `mergedAt` is non-null or `state` is `MERGED`. Only then run step 7. Hard-fail only when `state` is `CLOSED` with no `mergedAt`, a required check concludes `FAILURE` or `CANCELLED` and blocks merge after auto-merge is no longer pending, or `mergeStateStatus` is `UNSTABLE` or `DIRTY` with no auto-merge pending. `BLOCKED` while checks are pending or auto-merge is armed is not failure. Do not use Babysit's queued `WAITING`/`merge-queue` stop condition here. Hold the watch under `/loop` in dynamic mode. Report each merge and the new ceiling. If the queue stalls, diagnose before mutating.
9. **Stop at the ceiling.** When the verified run is merged, report what landed, what the next unverified PR is, and what verifying it would take. Extending the run is a new pass through step 1.

**Reply:** the verified run and its ceiling, each PR's verdict and who produced it, what you armed and how you confirmed it, what landed, and what the next gap needs.

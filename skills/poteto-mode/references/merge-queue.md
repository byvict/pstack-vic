# Native merge queue

pstack certifies each original PR head. GitHub constructs speculative merge-group commits, and the repository tests each exact combined candidate. `actions/merge-queue` validates that candidate against the live queue, the protected trunk policy, the pinned certificate publisher and current PR holds. It never copies a green PR status onto a group.

## Candidate identity

The `merge_group: checks_requested` event identifies an immediate base and synthetic head. That base can be the previous speculative candidate rather than trunk. `candidate` reads `Repository.mergeQueue` and both live refs, finds the exact event head, and requires a contiguous prefix rooted at current trunk. It returns `base-sha`, `head-sha` and `members` (`[{pr,head}]`, with each original PR head).

Use these outputs for changed-file filters and combined checks. Test the full prefix or run the complete suite on every group; filtering only from the event's immediate base can miss a predecessor's changes. Scan the combined tree for secrets too, including changes introduced by the merge itself. A predecessor that has landed at its exact synthetic SHA becomes the prefix's new trunk root. Missing, moved, truncated or inconsistent membership refuses the candidate. A temporarily inconsistent GitHub read can require a fresh candidate.

## Required checks

Pin the action to a reviewed full pstack commit SHA, and pin the trusted publisher's numeric GitHub account ID in the protected workflow. The Actions actor is not that publisher. Use `candidate` for the diff root, and run separate required jobs named `verdict` and `hold` with their matching modes:

```yaml
permissions:
  contents: read
  pull-requests: read
  actions: read
  checks: read
  statuses: read
steps:
  - uses: byvict/pstack-vic/actions/merge-queue@<reviewed-full-commit-sha>
    with:
      mode: verdict
      publisher-id: '<trusted-numeric-id>'
```

The action waits for every other effective protected context to succeed on the synthetic head, then reads live membership, holds and certificates again. `hold` checks every current member is open, ready, at its admitted head and free of hold labels. `verdict` also re-derives each member's real pre-PR certificate against current trunk, using the pinned publisher identity. A missing or untrusted certificate, changed policy or coverage, or a failed or skipped combined check refuses success. Reads use the branch summary and effective branch rules, which work with the read-only Actions token; no administrator credential is needed.

Keep the normal PR verdict publication and hold workflow. A workflow that skips a job named `verdict` on ordinary PRs would create a successful check without a certificate. Restrict the group jobs to `merge_group` and publish ordinary PR verdicts only through `publish.ts`.

A prefix with multiple members may not change the contract, verification recipes, feature map or trusted Tests workflow. Land the policy PR first, then certify later PRs against the new policy. A single policy-changing PR still follows the current protected policy. Combined behavioral checks establish integration; individual feature certificates do not establish new combined feature coverage.

## Invalidate live authorization

An original-head check that turns red after the group's equivalent is green does not stop GitHub from merging that group. Run `invalidate` from `pull_request_target` and `issue_comment` workflows on the protected default branch. Review and review-comment events execute their workflow from the PR merge commit: give their signal workflow no permissions, then use a trusted `workflow_run` workflow for invalidation. The action reads the completed run and its GitHub PR associations, with a commit-association fallback, and revalidates each live PR. It never downloads signal artifacts. It reads the live PR, holds and certificate, and dequeues a member whose authorization fails. Execute the pinned action without checking out PR code, with these permissions:

```yaml
permissions:
  contents: write
  pull-requests: read
  actions: read
  statuses: read
```

Queue removal needs `contents: write`; `pull-requests: write` alone is insufficient. The read-only group jobs have no write permission. [GitHub's event trust rules](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target) require this separation. Event invalidation and final validation reduce the stale-authorization window, but GitHub offers no atomic operation that validates authorization and merges. A hold received after the last validation can race the invalidation job's scheduling and the merge.

## Admission and repair

`converge-arm --pending` uses the existing squash admission command. With a native queue, it allows pending trunk push CI so successive green candidates do not wait for another CI cycle. An explicitly failed trunk run still refuses new admission. A repository without a queue keeps the existing green-trunk requirement.

A queued PR can have no auto-merge request. The sweep and daemon inspect explicit queue membership, leave a valid candidate to GitHub and never apply the five-minute auto-merge retry to it. Holds, certificate refusals and authorized repairs explicitly dequeue it. `publish.ts` refuses a new publication while it is queued.

A removal records its timestamp, reason and rejected synthetic head. `failed_checks` becomes repair work on that head. Other removals require recertification. Admission requires a trusted certificate published strictly after removal, so repeated sweep ticks cannot reenqueue a failed candidate with old green evidence. A same-second publication is conservatively refused.

## Adopt the queue

Make every required context available on merge groups before activation. An adopting PR can introduce its group workflows; GitHub runs them from the candidate. Preserve existing protections, use the native `ALLGREEN` policy, and activate only after the adoption PR has completed review and certification. Queue settings belong to the repository owner. An author still ends at the admission receipt, as [Pré-PR](../playbooks/pre-pr.md) requires.

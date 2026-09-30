# Parallel PR delivery

Read this before concurrent writing tasks, dependent PRs, or changes to a queued branch. Repository instructions supply the local database, port, cache and verification setup.

## Isolate ownership

Give each independent writing task its own branch and worktree from current trunk. One active owner writes a branch. Read-only helpers may share its checkout; helpers that write get separate worktrees, and the owner reviews their commits before integrating them. Never reset, switch or clean another owner's checkout.

Keep mutable runtime resources with the worktree owner: databases, ports, caches, processes and generated output. A worktree separates Git files; it does not isolate an external service or a shared database. Use disposable verification data and the repository's existing setup helper.

Take the branch lease before a push or delegated repair, as [Pré-PR](../playbooks/pre-pr.md) and [Catch-up](../playbooks/catch-up.md) require. Renew it before each lane launch and push, with the same holder throughout the attempt. A lease protects one branch from competing owners; independent branches can still touch the same files.

## Order dependencies

Independent PRs target trunk and proceed through development, review and certification in parallel. A dependent PR starts from its parent's exact tip and targets the parent branch. Publish its certificate, then let the sweep admit it after the parent merges. Reconcile the child with the new trunk and renew evidence when its patch or verification policy changes.

Keep changes that need one shared feature proof in the same verifiable unit. A group verdict revalidates the original PR certificates. The repository's combined suites prove the behavior of the candidate; they do not create a combined feature certificate.

## Hand off delivery

The author publishes the exact-head certificate, arms admission through `converge-arm --pending`, releases the lease and nudges Converge. The author stops writing at that receipt. Converge owns repair and recertification; GitHub's native queue owns candidate construction and merge order. [Native merge queue](merge-queue.md) describes the CI contract and its adoption.

GitHub rejects a push to a queued branch. Before an authorized repair or new publication, dequeue it:

```sh
node <plugin>/skills/poteto-mode/scripts/converge/converge-queue dequeue --repo OWNER/REPO --pr N
```

Disable a pending auto-merge request too, as Pré-PR describes. After queue removal, publish a certificate newer than the removal before admission. Repair a combined-check failure using the rejected candidate SHA, then reconcile against current trunk.

## Clean up

Remove a worktree only after its owner and writing helpers have stopped, its changes are preserved, and needed local data is saved. Follow the host's managed-worktree cleanup procedure when one exists. Keep a pending delivery branch and its evidence available to its next owner.

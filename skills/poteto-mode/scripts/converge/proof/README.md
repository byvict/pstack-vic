# Converge proof corpus

`corpus.json` preserves the Clinext verdict export from September 21, 2026.
Its source filename is `2026-09-21_clinext-verdict-corpus.json`.
Its SHA256 is `aa81a742b722c8ddc0ab58d2d6f528132fb7ae906ace74c58d2ebdb5777aa7bf`.

The `hits` array contains 15 distinct failed heads across 11 PRs. Each head is a
separate scoring case. The `prsWithFail` array lists 15 PR numbers, and `total`
is 22. Those export metadata fields do not replace the 15 available head records.

Finding paths appear in either `findings[].files` or `findings[].evidence`.
The scoring inputs retain repeated PRs and the original findings. PR 2776 has
the same `failHead` and `passHead` despite different verdict labels. This source
limitation remains visible rather than changing the recorded label.

Keep this labelled corpus outside the workspace and prompt that a blind role
can read. Supply that role only the pinned revision, its verified base, the
change under review, and the ordinary role instructions. Score its returned
finding paths against this file after it finishes.

The proof harness lives in this directory plus `../converge-proof`. Parent-only
catalog expectations stay in `catalog.json` and never travel in PR titles,
prompts, or candidate worktrees. Historical bases for the 15 records are in
`historical-revisions.json`.

`run` requires a parent harness and a root-issued repository epoch. Its default
services plant held PRs, wait for exact-head checks to become terminal, prepare
and execute the supplied descriptors through the shared runner, call C's
publisher, and clean only the recorded PR and branch. The injected service
object is a process/network test seam. Every runner launch and publisher call
has a durable pre-call record. A launch left in the unknown state stays blocked
until its terminal receipt is recovered.

The run envelope retains the selected catalog bytes and copies every pool audit
into immutable evidence before admission. Pool expiry and the fixed 80 percent
stop suspend new launches without preventing publication recovery, reader
drain, or cleanup. Cleanup requires the same repository epoch, checkout,
origin, ref and head; it reads the PR back as `CLOSED` before ordinary deletion.

The live catalog keeps exact-head CI for every distinct PR. The runner plants
all ten held PRs with one writer before it waits for the first result, so their
independent workflows can overlap. Lane execution, publication and cleanup stay
serial. The suite records elapsed time including cleanup without an acceptance ceiling. Reusing CI
across heads or replacing live runs with fixtures would test a weaker contract.

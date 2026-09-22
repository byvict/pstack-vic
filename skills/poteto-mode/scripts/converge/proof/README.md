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

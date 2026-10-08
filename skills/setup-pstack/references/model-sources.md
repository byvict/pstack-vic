# Codex model sources

`state`, `plan`, `pick` and `write` use the same resolver. `--cwd` supplies the project directory; its default is the command's cwd, never the installed plugin's directory. `CODEX_HOME` selects the global profile, with the existing empty/absolute-path rules. It does not relocate the project or imply worktree inheritance.

## Instruction chain

With standard Codex discovery, inspect the global profile and the directories from the nearest `.git` entry down to cwd. A `.git` file bounds a linked worktree just as a `.git` directory bounds a checkout. Outside Git, inspect only cwd. In the global profile use the first nonempty `AGENTS.override.md`, then `AGENTS.md`. In a project directory use the first existing instruction file in that order: Codex CLI 0.162.0 treats an empty project override as hiding `AGENTS.md`, and loads neither file.

Codex builds its instruction chain when the session starts. A command cannot reconstruct that session's CLI overrides, trust, custom root markers, fallback filenames, byte budget, injected instructions or earlier file contents by inspecting cwd alone. For those cases, pass the complete observed loaded chain, global first, with repeated `--instruction-source <absolute-file>` to `state`, `plan` and `pick`. The supplied chain replaces automatic discovery; it is not appended to it. Use `--no-instruction-sources` when the observed chain is empty; selection then uses defaults and setup refuses to write until a destination is established. Codex app-server `thread/start`, `thread/resume` and `thread/fork` expose `instructionSources` in CLI 0.162.0. A session's instruction headers/transcript can also establish its paths. Verify that the declaration itself was loaded completely; a path alone does not prove that a block survived truncation. An untrusted session must supply its actual chain rather than use trusted-project discovery.

This is a pstack resolver of model sources, not another Codex TOML loader. [Codex instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md) and [config precedence](https://learn.chatgpt.com/docs/config-file/config-basic) distinguish instruction files from trusted `.codex/config.toml` layers. Codex has no Claude-style `@` import. A Markdown link or a prose path does not prove automatic inclusion of the target's contents.

## Precedence and recovery

Inspect scopes from nearest to broadest. Select the first scope declaring a model source:

1. An explicit reference in its selected instruction file, on one unindented prose line: `pstack-models: <path>`. Paths resolve relative to that instruction file, or relative to the user's home for `~/`. Angle brackets allow spaces. A missing target or multiple references is an error. References inside fenced examples or front matter are ignored. Read this referenced sheet before dispatching configured roles; this declaration is a pstack instruction, not native Codex import syntax.
2. Otherwise, that scope's canonical sheet: `<scope>/.codex/pstack-models.md` for a project, `<config-home>/pstack-models.md` for the global profile.
3. If its sheet is absent, recover the bounded `pstack:models` block from the selected instruction file.

The nearest project source takes precedence over broader project sources and the global source. Defaults apply when no source exists. Within a selected source, an absent role uses its matrix default, matching the existing setup contract; it does not borrow a role from a broader sheet. Explicit source references allow sharing with another checkout, but a worktree never searches its Git common directory or main checkout automatically.

A standalone sheet remains recoverable, as in global setup before this change. Its presence proves operator configuration, not that Codex injected its bytes. `plan` preserves its rows and `write` mirrors the sheet into the selected instruction file so a new Codex session can load it. At the same scope, sheet and block must agree; differing rows, malformed descriptors or malformed markers fail rather than silently falling back. Broader sources are not compared with a legitimate local override.

## Provenance and writes

`state.source` and `pick.configurationSource` identify the actual file and whether it supplied a sheet, a recovered block or first-run defaults. `pick.source` retains its existing `sheet`/`default` meaning for the selected role. `sheetPath` and `integrationPath` identify the destinations too; `state.ledgerPath` is beside the resolved sheet. When a role uses defaults, its `configurationSource` still identifies the inspected source that lacked that row.

`plan` saves cwd and any explicit instruction chain in `sourceContext`. `write` re-resolves that context and refuses changed destinations before probes or writes. It uses the resolved sheet, integration and ledger in the existing admission/snapshot/write/readback/rollback transaction. A project ledger is not copied from the global profile. Selection and state reads write nothing; planning writes only its run artifact. Provider, model, effort, aliases, lane order and pool exclusions remain governed by the model matrix and provider-dispatch contract.

For automatic first-run setup without any declared source, the destination remains the global profile. With a nonempty explicit chain but no model source, defaults apply and the destination is beside the last supplied instruction file, preserving excluded global contents. To configure a project, use its existing local sheet/block or a source reference in the actual loaded project instruction file. Setup never moves a project sheet back to the global profile.

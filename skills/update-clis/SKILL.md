---
name: update-clis
description: Update the claude, codex, and grok CLIs that pstack's external runner launches, one CLI at a time, only when the plugin keeps working on the new version; otherwise hold it and say what to adjust. Use for /update-clis, the weekly pstack-vic-cli-updates routine, "atualiza as CLIs", "atualiza o grok", or checking whether a new CLI version is safe for pstack.
---

# Update CLIs

The external runner (`poteto-mode/scripts/runner`) launches three CLIs: `claude`, `codex`, and `grok`. A new version can rename a flag, change an output event, or change what its sandbox allows, and every lane on that CLI breaks mid-run. This skill moves each CLI to the latest version of the channel it already uses, but only after the release notes and a live probe show that the plugin still works. Otherwise it holds the version. Cursor has no CLI (`transport: http`) and is out of scope. The desktop apps' bundled binaries are reported, never touched.

You never edit the plugin. A version that needs a plugin change stays held, and the fix is a normal session with a PR.

**Claude Code parent only.** In Codex, stop and say why: the run replaces the codex binary that a Codex parent may be running, simulates the Codex parent through `codex sandbox`, and posts through the Linear connector of Claude Code.

The mechanical half is `scripts/update-clis.ts`, next to this file (Node 24, no dependencies). Run it as `node <this skill's directory>/scripts/update-clis.ts <subcommand>`. Every subcommand prints JSON, and `--help` prints the usage. The script decides nothing. `references/cli-touchpoints.json`, next to this file, lists every place where the plugin depends on a CLI's behavior. You read the notes against it.

The cost that a receipt shows is a list-price equivalent, not a charge: the three CLIs run on subscriptions.

## Linear

The report goes to the Linear project pstack-vic (id `03492344-5c99-4be2-adfe-abaebc7f82b9`, team Clinext/CLI). Load the connector tools with ToolSearch (`select:` `list_issues`, `save_issue`, `save_comment`). If the connector is still `pending`, wait and try again.

Nothing is stored between runs except open issues in that project:

- `CLI <cli> <version> segurada`: that version is held. Closing the issue, after the PR that adjusts the plugin, allows the next attempt.
- `CLI <cli> quebrada: volta falhou`: a rollback failed. Do not touch that CLI until someone closes the issue.

First, list the open issues: `list_issues` with `project` set to the id above, `query` set to `CLI `, and `fields` `["title", "statusType", "url"]`. Keep the issues whose title starts with `CLI ` and whose `statusType` is neither `completed` nor `canceled`. If Linear does not answer, the run only reports: `start`, `check`, `finish`, and the summary in the chat (or in the routine's final message). Without Linear you cannot know which versions are held, so install nothing.

## Run

1. `start`. The output gives `dir`, the run directory under `~/Library/Caches/pstack-vic/update-clis/`. Exit 3 means that another execution holds the lock: report "já em execução" and stop. From here on, the run always ends with step 4, whatever happens.
2. `check`, or `check --cli <cli>` when the operator named one CLI ("atualiza o grok"). For each CLI, the output gives `status` (`current`, `update-available`, `unverified`, `not-installed`), `resolved` (the path, version, and installer that both parents use), `latest` and `channel`, `duplicates`, `inUse`, `apps`, and `error`.
3. Handle each CLI in the order **codex → grok → claude**. Follow "One CLI" below and record one outcome per CLI. Codex goes first because the grok and claude `seatbelt` lanes run under `codex sandbox`.
4. `finish --dir <dir>`. Add `--keep-copies` when a grok rollback failed, because the copy is then the way back.
5. Report, as described at the end.

## One CLI

`from` is `resolved.version` and `to` is `latest`.

1. **Status.** `current` gives the outcome "em dia". `unverified` or `not-installed` gives "sem verificação", with `error`. Only `update-available` continues.
2. **Broken.** An open `CLI <cli> quebrada: volta falhou` issue gives "não tocada", with a link to the issue.
3. **Held.** An open `CLI <cli> <to> segurada` issue gives "segurada", with a link to the issue. A held issue for an older version does not block `to`: evaluate `to`.
4. **In use.** A non-empty `inUse`, or `null` because lsof could not answer, gives "adiada", with the processes. The apps' bundled binaries live in other paths and never appear there.
5. **Notes.** Run `notes --cli <cli> --from <from> --to <to> --dir <dir>`. Exit 2 gives "notas indisponíveis", with the error. Open no issue, and go to the next CLI.
6. **Reading.** Read every entry of `versions[].entries[]` (an entry that the source repeats appears once, under the oldest version) against `cli-touchpoints.json`. Judge each entry in the configuration the plugin actually uses: the flags, modes, tools, and events that the touchpoints' contracts name. When a contract alone does not settle an entry, open that touchpoint's pointers. Put each entry in one class:
   - unrelated: it concerns something no lane and no harness touchpoint reaches (the TUI, interactive slash commands, MCP, subagents, a mode or policy the runner never uses);
   - a fix or an addition that keeps every contract, including entries with no content ("miscellaneous fixes");
   - a contract change at one or more touchpoints: a flag removed or renamed, a default changed, an output format changed, or a behavior changed at a place that a touchpoint's `contract` describes. Name every touchpoint `id` it reaches.

   An entry with `breaking: true` is a contract change, unless it has nothing to do with any touchpoint. When you classify it as unrelated, write why. An entry that would change how a lane behaves but matches no touchpoint means the list is missing one. It does not hold the update: record it as "possível ponto de contato faltando", with the touchpoint you would add, and put it in the report. Write `reading-<cli>-<to>.md` in Portuguese in the run directory: a table of the contract changes (version, entry, touchpoints, kind, coveredBy, consequence), the missing touchpoints, then the count of each of the other two classes.

   The consequence of a contract change depends on the touchpoint:
   - `kind: lane` with a non-empty `coveredBy`: the probe decides. List the change.
   - `kind: lane` with an empty `coveredBy`: hold. Do not install. Open or update the held issue with the reason "mudança sem cobertura", and go to the next CLI.
   - `kind: harness`: it never holds. Report it as "vai chegar no app", with the touchpoint's pointer.
7. **Install.** Run `install --cli <cli> --version <to> --dir <dir>`. Exit 1 means that the installed version did not verify: roll back (step 9). The outcome is then "instalação falhou", with the detail, and no issue.
8. **Probe.** Run `probe --cli <cli> --dir <dir>` in a background Bash call (`run_in_background: true`) and wait for its completion notification. Never run it in the foreground: a foreground Bash call stops at ten minutes, and the worst case today is 10 lanes of up to 600 s each. Exit 0 (`ok: true`) gives the outcome "atualizada `from` → `to`", with the lanes that passed and the covered contract changes that the probe validated. Exit 1, or output without a summary, means roll back (step 9) and then run the counter-probe (step 10).
9. **Rollback.** Run `install --cli <cli> --version <from> --dir <dir>`. For grok, the script restores the binary copy by itself when `grok update` fails. If the rollback exits 1, open the broken issue (below), run `finish --dir <dir> --keep-copies`, and stop the run: the next CLIs are not touched.
10. **Counter-probe**, after a failed probe only. Run `probe --cli <cli> --dir <dir>` again. The previous version gets its own directory, because the directory name carries the version. The counter-probe decides whose fault the failure is:
    - The previous version passes: the new version is at fault. Open or update the held issue with the reason "falha na sonda".
    - The previous version fails too: the environment is at fault (login, quota, network). The outcome is "sonda inconclusiva", with no issue, and the next run tries again. Name the failing receipt status. `unauthenticated` means that the login of that CLI expired: say which CLI needs a new login.

## Issues

A held issue: `save_issue` with `team` `Clinext/CLI`, `project` set to the project id, and `assignee` `me`. The title is `CLI <cli> <to> segurada`. The body has:

- the reason: "mudança sem cobertura" or "falha na sonda";
- the note entries in question, each with its version;
- the touchpoint `id`s and their pointers (file and anchor);
- for a probe failure, the failing lane's `detail` and the relevant excerpt of its `receipt.json`;
- the path of the run directory;
- one line per CLI for the rest of this run, in the format of the report below.

Before you create an issue, search the open issues for the same title. When one exists, update it (`save_issue` with its `id`) instead of creating a duplicate.

A broken issue: the same fields plus `priority` 1 (Urgent), and the title `CLI <cli> quebrada: volta falhou`. The body has `from` and `to`, the JSON of both install results, and the exact manual commands:

- claude or codex: `PATH="<resolved.installer.prefix>/bin:$PATH" npm install -g <package>@<from>`, then `<resolved.path> --version`. Keep the `PATH` prefix: npm installs into the prefix of the first `node` in PATH, not of the directory its own binary is in.
- grok: `grok update --version <from>`. If that fails, `cp <dir>/grok-backup-<from> <resolved.installer.binary>`, then `grok --version`.

## Report

When this run opened or updated no issue, post one project comment (`save_comment` with `projectId`), in Portuguese:

```text
CLIs <data>:
- codex: <outcome>
- grok: <outcome>
- claude: <outcome>
Apps: Claude <versões>; codex do ChatGPT <versão>.
Mudanças de contrato no app: <as mudanças harness, com o ponteiro, ou "nenhuma">.
Pontos de contato faltando: <entrada e ponto sugerido, ou "nenhum">.
Duplicatas: <caminho e versão, ou "nenhuma">.
Execução: <dir>
```

When this run held a version, the held issue carries the report, so do not post the comment.

When the operator started the skill by hand, show the same summary in the chat. If the npm `claude` changed version, remind the operator to restart the terminal `claude` sessions. The desktop app runs its own binary and does not change.

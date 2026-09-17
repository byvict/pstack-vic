# CHANGES

Veredito por hunk da fase 4 do plano: as substituições Cursor → Claude Code / Codex que o [open-pstack](https://github.com/ericlitman/open-pstack) fez sobre o pstack da Cursor, reaplicadas aqui sobre a árvore 0.15.2, uma a uma. Cada hunk recebeu um de três vereditos:

- **aplica**: o texto do open entra como está (cópia auditada; proveniência em `NOTICE.md`).
- **adapta**: o texto do open é o ponto de partida, mas o desenho aqui muda (matriz de modelos como dado, `skill-creator`, defaults 0.15.2, Node 24).
- **recusa**: o hunk fica fora, com o motivo. A prosa da Cursor 0.15.2 permanece.

Hunks que pertencem a outra fase estão listados em **Fora desta fase**, com a fase que os decide.

## Base do diff

| Lado | Commit | Conteúdo |
| --- | --- | --- |
| Cursor 0.15.1 | `f8abedd:pstack` (remote `cursor`) | base que o open portou |
| open-pstack 1.4.1 | `de67e6b:plugins/pstack` (remote `open`) | port de referência, só leitura |
| Cursor 0.15.2 | `91e5b82` (tip do split, árvore deste repo antes da fase 4) | base real deste port |

O checklist foi `git diff f8abedd:pstack open/main:plugins/pstack` (154 arquivos: 78 hunks de substituição mais runner, skills novas, manifests, hooks e remoções). O delta 0.15.1 → 0.15.2 (`git diff f8abedd:pstack 91e5b82`, 11 arquivos: bug-fix/perf/hillclimb de Sol para Grok, pronomes neutros, pergunta de budget no `setup-pstack`) foi preservado onde o open ainda não o tinha.

Método de aplicação, por arquivo: (1) onde o resultado seria igual ao open, `git show open/main:plugins/pstack/<arquivo>`; (2) onde o open mistura substituição de plataforma com mudança editorial, parte-se do HEAD 0.15.2 e só o hunk de plataforma entra; (3) adaptações feitas por substituição textual com âncora única, para o diff ser auditável. Script da sessão em `git log` do commit desta fase.

## Decisões transversais

1. **Frontmatter `disable-model-invocation: true` removido de todas as skills de fluxo**, inclusive `how`, `why`, `unslop` e `typescript-best-practices` (as quatro que o plano pedia para refazer conscientemente). No Claude Code esse campo impede o modelo de carregar a skill e a exclui da ferramenta `Skill`; `poteto-mode` invoca `how`, `why`, `arena`, `interrogate` etc. pelo modelo, então mantê-lo quebraria o roteamento. `unslop` diz "Must always apply" e `typescript-best-practices` carrega por `paths` (campo suportado pelo Claude Code, mantido). Nas 24 skills `principle-*` o campo virou `user-invocable: false`: ficam fora do menu `/`, o modelo continua podendo lê-las. Semântica confirmada na documentação do Claude Code em 2026-09-17.
2. **Seletores Cursor viram papéis, não descritores.** O open troca `claude-fable-5-1-thinking-max` por `claude:fable@max` em 15 arquivos. Aqui a skill cita o **papel** (`arena runners`, `bug-fix`, `how explainer`...) e aponta para a tabela de papéis de `provider-dispatch.md`. A tabela é dado: `roles` em `model-matrix.json`, um default por papel e por pai (`family@effort`, alias, lista para painel, ou objeto por pai quando o papel usa a frontier nativa do pai), renderizada por `scripts/render-model-matrix.ts` em `provider-dispatch.md` e nos dois sheets de exemplo de `setup-pstack`. Os rótulos são as linhas do sheet que `/setup-pstack` escreve, então um sheet sobrescreve exatamente o que a skill cita. Teste: todo rótulo citado em `skills/` existe na matriz; nenhum arquivo cita seletor Cursor; os blocos gerados estão em dia.
3. **Defaults da tabela = mapa da fase 6 do plano**, materializado agora como dado: volume (`feature, refactoring`, `bug-fix`, `perf-issue`, `hillclimb`, `swarm workers`, `how explorer`) em `grok:grok-4.6@xhigh`; frontier solo (`hardest tasks`, `judgment and prose`, `how explainer`) na frontier nativa do pai (fable no Claude Code, astra no Codex); painéis (`arena runners`, `arena cross-judge pool`, `architect runners`, `interrogate reviewers`) em fable/astra/grok/opus; `why *` e `reflect *` em `inherit-parent` (o runner externo não leva MCPs). Diverge do 0.15.2 em dois pontos conscientes: Sol sai do painel em favor de Astra (decisão de 2026-09-17; Sol fica na matriz) e `why`/`reflect` deixam de nomear grok/sol/fable. Diverge do open 1.4.1 (= 0.15.1) em `bug-fix`/`perf-issue`/`hillclimb`: o open usa Sol; 0.15.2 e a fase 6 usam Grok.
4. **Autoria de skills: `create-skill` (Cursor) → `skill-creator`.** O open aponta para `plugin-dev:skill-development`. `skill-creator@claude-plugins-official` é a skill oficial da Anthropic para SKILL.md e é a instalada neste ambiente; `codex-tools.md` mapeia a mesma linha para o Codex.
5. **Control skills da `cursor-team-kit` → `run` e `verify`**, skills embutidas do Claude Code (confirmadas na documentação); no Codex, `codex-tools.md` dá o substituto.
6. **`/goal` → standing orders + todolist; `git show origin/main:pstack/...` → caminho no plugin instalado.** Claude Code não tem `/goal`; o plugin instalado é a fonte estável dos playbooks.
7. **Cloud agents e VMs → subagents em background, um worktree por escritor.** `environment: "cloud"`, `cloud_base_branch`, "lane VM", "Cursor dashboard" e "Cursor restart" saem; `run_in_background: true` e "session restart" entram.
8. **Transcripts → `~/.claude/projects/<encoded-cwd>/*.jsonl`**, com a mesma regra de não varrer outros projetos.
9. **Liveness dos ticks de auditoria** (`autopilot-full`, `autopilot-stack`, `multi-phase-plan`): adotada a regra do open, tempo decorrido sem efeito colateral não prova lane travada, derrubar só com evidência afirmativa. É consequência do runner externo (lanes de 90 minutos são saudáveis), coerente com `provider-dispatch.md`.
10. **Recusadas as mudanças editoriais do open sem motivo de plataforma**, para manter a prosa da Cursor e reduzir conflito no merge do remote `cursor` (fase 8): reescrita de `shipping.md` (GraphQL de disarm, `--match-head-commit`, variáveis de shell), mecânica de fork e `--repo` em `opening-a-pr.md`, `autopilot-*` e `multi-phase-plan.md`, reescrita de `principle-attack-the-premise` e `principle-test-behavior-not-implementation` (e as linhas correspondentes em `poteto-mode/SKILL.md`), a regra "Terse is not an excuse" reescrita, a linha de reply de `bug-fix.md`, `databricks.md` citando uma skill dbt do open. Cada uma pode voltar por veredito no digest semanal do open.

## Veredito por arquivo

Legenda: **A** aplica (cópia do open), **Ad** adapta (open + mudança de desenho), **H** parte do HEAD 0.15.2 e recebe só os hunks de plataforma, **R** recusa (hunk fica fora).

### Skills de fluxo

| Arquivo | Veredito | O que entrou / o que ficou fora |
| --- | --- | --- |
| `skills/architect/SKILL.md` | Ad | frontmatter, contrato de dispatch; defaults dos runners → papel `architect runners` |
| `skills/arena/SKILL.md` | Ad | frontmatter, contrato, fan-out por lanes nativas/externas, receipts e dropout; defaults → papéis `arena runners` e `arena cross-judge pool`; `~/.cursor/rules/pstack-models.mdc` → "pstack model sheet" |
| `skills/automate-me/SKILL.md` | Ad | `.cursor/skills` → `.claude/skills`, `AskQuestion` → `AskUserQuestion`, transcripts, nota de plataforma; `create-skill` → `skill-creator` (open: `plugin-dev:skill-development`) |
| `skills/blast-radius`, `bro`, `figure-it-out`, `tdd`, `technical-writing`, `typescript-best-practices`, `unslop` | A | só frontmatter (decisão 1); `paths` mantido em typescript-best-practices |
| `skills/create-verification-skill/SKILL.md` | A | `.cursor/skills/verify-<app>` → `.claude/skills/verify-<app>`, nota de plataforma |
| `skills/how/SKILL.md` | Ad | blocos `subagent_type`/`model`/`readonly` → dispatch por papel `how explorer` / `how explainer` em `read-only` |
| `skills/interrogate/SKILL.md` | Ad | contrato, fan-out, dropout sem fallback (substitui a regra Cursor de "pegar o slug mais próximo"); tabela de reviewers aponta para as entradas do papel `interrogate reviewers` |
| `skills/maintain-verification-skill/SKILL.md` | A | `.cursor/skills` → `.claude/skills`, nota de plataforma |
| `skills/no-comments/SKILL.md` | A | `Comment Sicko` → `comment-sicko`, `Task` → `Agent`, nota de plataforma |
| `skills/poteto-mode/SKILL.md` | Ad | `name` kebab, campos Cursor-only (`mode`, `icon`, `color`, `reminder`) removidos, Platform Adaptation, `AskUserQuestion`, `run`/`verify`, `deslop` sem `cursor-team-kit` ("when it is installed", fase 5 decide), babysit standalone, "Cursor restart" → "session restart", Subagents reescrito para dispatch; parágrafo de defaults aponta para a tabela de papéis e recupera o "tier by difficulty" da Cursor. **R**: linhas Attack the Premise, Test Behavior e Terse (editoriais); Autopilot-stack mantém texto 0.15.2 |
| `skills/recall/SKILL.md` | A | transcripts |
| `skills/reflect/SKILL.md` + `references/*` | Ad | contrato, transcripts, `Task` → `Agent`, `.cursor/` → `.claude/`; tabela de lentes cita papéis `reflect judgment, divergent, synthesizer` e `reflect tooling` (default `inherit-parent`); `create-skill` → `skill-creator` |
| `skills/show-me-your-work/SKILL.md` | A | transcripts |
| `skills/swarm/SKILL.md` | Ad | "cloud workers" → workers, contrato, fan-out sem `environment: "cloud"`/`cloud_base_branch`; default → papel `swarm workers` |
| `skills/teach/SKILL.md` | A | nota de plataforma |
| `skills/why/SKILL.md` | Ad | descoberta de MCPs no Claude Code (`mcp__<server>__<name>`, `.mcp.json`, `claude mcp list`), fan-out; papéis `why investigators` / `why synthesizer` (default `inherit-parent`). **R**: `references/sources/databricks.md` (skill dbt do open) |
| `skills/principle-*` (22) | A | `disable-model-invocation: true` → `user-invocable: false` |
| `skills/principle-attack-the-premise`, `principle-test-behavior-not-implementation` | H | só o frontmatter; **R** reescrita do corpo (editorial) |
| `skills/setup-pstack/SKILL.md` | Ad | ponto de partida da fase 6, copiado do open: sheets `~/.claude/pstack-models.md` + include em `CLAUDE.md`, `~/.codex/pstack-models.md` + bloco em `AGENTS.md`, effort por família, probe, render, confirmação, wire-in, smoke. Adaptado para ler a matriz inteira (o open fixa "Fable, Sol, Grok, Opus" e quatro probes) e para o exemplo de sheet ser o bloco gerado da tabela de papéis, um por pai. A pergunta de budget do 0.15.2 é substituída pelo effort por família do open. A fase 6 fecha probe real, rerun byte-idêntico e escrita |

### Playbooks de `poteto-mode`

| Arquivo | Veredito | O que entrou / o que ficou fora |
| --- | --- | --- |
| `authoring-a-skill.md` | Ad | `create-skill` → `skill-creator` |
| `autonomous-run.md` | A | `/loop` do Claude Code, `AskUserQuestion` |
| `autopilot-full.md` | H | `/goal` → standing orders; cloud agent → subagent em worktree; Bugbot → review-bot; `deslop` sem `cursor-team-kit`; control → `run`/`verify`; tick em `/loop` dinâmico lendo o plugin instalado; liveness (decisão 9). **R**: remotes/`--repo`, disarm, expected-head merge |
| `autopilot-stack.md` | H | idem (steps 1–3). **R**: steps 5–8 do open (fork, `gh api`, lease) |
| `babysit.md` | H | "Cursor's built-in babysit" → standalone `babysit`; caminho do `watch-pr` no plugin instalado. **R**: `--repo`/variáveis de shell |
| `bug-fix.md` | H | control → driver skill; `/loop` do Claude Code; delegação por papel `bug-fix` com `isolated-write`. **R**: linha de reply |
| `eval.md` | A | transcripts |
| `feature.md` | H | delegação por papel `feature, refactoring` com `isolated-write`. **R**: remoção das frases "You can spawn a subagent even though you are one" |
| `hillclimb.md` | H | papel `hillclimb` com `isolated-write` |
| `multi-phase-plan.md` | H | step 3 (papel `judgment and prose`, `poteto-agent` só para alias, nunca o agent `Plan`), store → `docs/` do repo, `check-plan.mjs` no plugin instalado, lanes no papel `swarm workers`, Driver skill, tick em `/loop` dinâmico, standing orders, leituras do plugin instalado, boot recipe por lane com receipt, apêndice D. **R**: fork/`--repo`/`gh api`, `<scratch path>`, fetch por URL |
| `opening-a-pr.md` | H | `Task` → `Agent`, `/deslop` sem `cursor-team-kit`. **R**: fork, `--repo`, readiness com draft, corte do limite de 40 linhas |
| `orchestrate.md` | A | coordenador sem local/cloud, `Agent` tool, workers em background com worktree, store em `~/.claude/orchestrate/`, `run`/`verify`, "Cursor restart" → "session restart", liveness pela lista de tasks |
| `perf-issue.md` | H | control → driver skill; papel `perf-issue` com `isolated-write` |
| `prototype.md`, `runtime-forensics.md`, `visual-parity.md` | A | control → driver skill |
| `refactoring.md` | Ad | driver skill; papel `feature, refactoring` |
| `session-pickup.md` | A | transcripts |
| `shipping.md` | H | step 1 cloud agents/control → worktree/`run`/`verify`; step 8 caminho do `watch-pr`. **R**: reescrita completa dos steps 1–8 (GraphQL, `--match-head-commit`, variáveis) |
| `worktree-cleanup.md` | A | caminhos, "sidebar" → session list, caches do Claude Code |

### Referências, scripts e agents

| Arquivo | Veredito | O que entrou / o que ficou fora |
| --- | --- | --- |
| `skills/poteto-mode/references/codex-tools.md` | Ad | novo, copiado do open: mapa de tools Claude → Codex, `multi_agent`, política de subagents, built-ins, instructions file. Adaptado: `skill-creator`, descritores só pela gramática e pela tabela de papéis, runner em Node 24 |
| `skills/poteto-mode/references/provider-dispatch.md` | Ad | seção **Role defaults** com bloco gerado (o resto veio na fase 1) |
| `skills/poteto-mode/scripts/check-plan.mjs` | H | `LANES` → "Ten lanes on the configured `swarm workers` role at the PR head"; marcadores `/goal` e `git show origin/main:` → "standing orders" e "the installed plugin". **R**: reescrita de 761 linhas do open + `check-plan.test.ts` (616 linhas, `bun:test`) + `check-plan.tsconfig.json`; tooling Bun fora do desenho Node 24, reavaliar no digest |
| `skills/poteto-mode/scripts/worktree-audit.sh` | A | transcripts em `~/.claude/projects`, avisos de `jq`/`rg` |
| `skills/poteto-mode/scripts/bootstrap.ts`, `package.json`, `bun.lock`, `bootstrap.test.ts` | R | guarda de Bun e scripts de teste Bun; o runner já roda em Node 24 (fase 2), `watch-pr`/`orch` seguem como vieram da Cursor |
| `agents/comment-sicko.md` | A | `name: comment-sicko` |
| `agents/poteto-agent.md` | A | `generalPurpose` → `general-purpose`; `is_background` removido (campo inexistente no Claude Code; `background` é o válido e o open optou por não marcar o roteador como background) |

## Fora desta fase

| Item do diff | Fase | Nota |
| --- | --- | --- |
| Skills novas do open: `babysit`, `deslop`, `fix-ci`, `fix-merge-conflicts`, `get-pr-comments`, `make-pr-easy-to-review`, `thermo-nuclear-code-quality-review`, `what-did-i-get-done` | 5 | avaliadas uma a uma lá; `poteto-mode` já cita `deslop` e `babysit` de forma condicional |
| Remoção de `skills/make-bot-ui`, `automations/benny`, `docs/guide/`, `README.md` da Cursor | 5 | conteúdo Cursor-only e documentação; `docs/reference.md` nasce na fase 5 |
| `hooks/` (`hooks.json`, `session-start`, `session-start-context.md`, `run-hook.cmd` + `LICENSE-superpowers`) | 7 | hook SessionStart com precedência a `CLAUDE.md`/`AGENTS.md` |
| `.claude-plugin/plugin.json` (campo `logo`), `.codex-plugin/plugin.json`, remoção de `.cursor-plugin/`, `.gitignore`, `LICENSE` na raiz do plugin | 7 | manifests e instalação por tag |
| `agents/pstack-*.md` | 3 | já gerados da matriz, byte-idênticos ao open |
| `skills/poteto-mode/scripts/runner/*` | 2 | já copiado e adaptado; `model-aliases.ts` e `model-matrix.test.ts` do open não entram (matriz substitui) |

## Verificação (2026-09-17)

- `npm test`: 80 testes, 0 falhas, 0 `todo`. O rastreador "no longer cite Cursor 0.15.2 selectors" saiu de `todo` e passa (partia de 16 arquivos).
- `npm run matrix:check` e `npm run agents:check` verdes.
- `grep` por primitivas Cursor-only em `skills/` e `agents/` (`.cursor/`, `AskQuestion`, `generalPurpose`, `Task` tool, `cursor-team-kit`, `create-skill`, `control-ui`/`control-cli`, `environment: "cloud"`, `is_background`, `agent-transcripts`, `pstack-models.mdc`, `/goal`, `git show origin/main:`, `pstack/skills/`) retorna só três menções explicativas: `codex-tools.md` cita `Task` como nome alternativo do `Agent`, e `autopilot-*` dizem que o Claude Code não tem `/goal`. A palavra "Cursor" sobra em `provider-dispatch.md` (coluna "Replaces (Cursor 0.15.2)" e nota sobre `fast`) e no `watch-pr` (Bugbot é produto da Cursor, roda em qualquer harness).
- `check-plan.mjs` sobre o esqueleto extraído de `multi-phase-plan.md`: todos os marcadores estruturais presentes.
- Smoke do `poteto-mode` nos dois pais, tarefa trivial (criar `hello.md` com uma linha exata numa pasta de rascunho, sem worktree/commit/PR), prompt idêntico: pai Claude Code (`claude -p`, `acceptEdits`, `--add-dir` do plugin) criou o arquivo com os bytes exatos, respondeu no formato de **Writing the reply**, listou o todolist do playbook Feature e nomeou `principle-laziness-protocol`, `principle-prove-it-works` e `principle-never-block-on-the-human` como lidos; leu `provider-dispatch.md` e `feature.md`, e explicou que não leu `codex-tools.md` por ser Claude Code. Pai Codex (`codex exec`, `workspace-write`, gpt-5.6-sol high) criou o arquivo com os bytes exatos, leu `SKILL.md`, `provider-dispatch.md` e `codex-tools.md`, respondeu no formato e nomeou Laziness Protocol e Prove It Works. Nenhum dos dois tentou `AskQuestion`, `Task`, `create-skill`, `control-*` ou caminho `.cursor/`.

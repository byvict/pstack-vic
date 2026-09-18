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
| Skills novas do open: `babysit`, `deslop`, `fix-ci`, `fix-merge-conflicts`, `get-pr-comments`, `make-pr-easy-to-review`, `thermo-nuclear-code-quality-review`, `what-did-i-get-done` | 5 | decididas em **Fase 5** abaixo: as oito entram |
| Remoção de `skills/make-bot-ui`, `automations/benny`, `docs/guide/`, `README.md` da Cursor | 5 | decididas em **Fase 5** abaixo: os três saem, o README é substituído, `docs/reference.md` nasce |
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

# Fase 5 — Subconjunto de skills (2026-09-17)

Vereditos sobre o que a fase 4 adiou: as oito skills que o open-pstack 1.4.1 acrescenta ao pstack da Cursor, e o conteúdo Cursor-only que ainda estava na árvore 0.15.2. Mesma legenda: **A** aplica (cópia do open ou do `cursor-team-kit` via open), **Ad** adapta, **R** recusa (sai da árvore ou não entra). Proveniência das cópias em `NOTICE.md`.

## Skills extras do open

Critério: entra o que não depende de primitiva da Cursor e não duplica um built-in do Claude Code nem uma skill que o pstack já tem. As sete do `cursor-team-kit` são byte-idênticas ao original em `cursor/main` (`git diff` vazio contra `cursor/main:cursor-team-kit/skills/<nome>/SKILL.md`), então a cópia vem do open mas a proveniência é a Cursor, com `LICENSE-cursor-team-kit` na raiz.

| Skill | Veredito | Motivo |
| --- | --- | --- |
| `deslop` | A | `poteto-mode`, `opening-a-pr`, `autopilot-*` e `multi-phase-plan` já mandam rodar `/deslop` antes de cada commit; a Cursor 0.15.2 a buscava no `cursor-team-kit`, que não existe fora da Cursor. Só usa o diff contra `main`. A frase "when it is installed" de `poteto-mode/SKILL.md` (fase 4) volta a ser incondicional |
| `babysit` | A | Análogo standalone do `/babysit` embutido da Cursor, escrito pelo open (sem prosa da Cursor, proveniência declarada no próprio arquivo). Cobre o caso que o playbook Babysit não cobre: um PR isolado fora do `poteto-mode`. Usa `gh`, `loop`, `AskUserQuestion` e aponta para `bugbot-triage.md`, tudo já mapeado em `codex-tools.md`. O playbook continua mandando dentro do `poteto-mode`; as frases condicionais ("if one is installed") de `poteto-mode/SKILL.md` e `playbooks/babysit.md` viram referência direta, e o script de colisão verifica a precedência dos dois lados |
| `thermo-nuclear-code-quality-review` | A | Rubrica de revisão estrita, prosa pura. A Cursor a marca `disable-model-invocation: true`; aqui o campo sai (decisão 1 da fase 4: no Claude Code ele exclui a skill da ferramenta `Skill`), como o open já fazia. Não substitui a lente de qualidade de `interrogate/references/code-quality-review.md`, que a Cursor 0.15.2 já tem; é a entrada standalone da mesma postura |
| `make-pr-easy-to-review` | A | Só `gh` e `git`; atua num PR já aberto, o que `opening-a-pr` (que rege a abertura) não faz |
| `fix-ci` | A | Só `gh`; escopo mais estreito que Babysit (CI de branch ou PR, sem loop de review threads) |
| `fix-merge-conflicts` | A | Só `git`; o playbook Babysit proíbe resolver conflitos dentro do babysit e manda reportar, então um resolvedor standalone é uma entrada distinta, não duplicata |
| `get-pr-comments` | A | Só `gh`, só leitura; resumo de feedback sem entrar no loop de triagem |
| `what-did-i-get-done` | A | Só `git`; é a de encaixe mais fraco no pstack (não é roteada por nenhum playbook), mas é minúscula e sem primitiva de plataforma. Entra com a ressalva de que pode sair no primeiro digest em que estorvar |

Nenhuma das oito cita descritor de modelo, então nada muda na matriz nem na tabela de papéis. Nenhuma tem `references/` ou scripts.

## Conteúdo Cursor-only adiado da fase 4

| Item | Veredito | Motivo |
| --- | --- | --- |
| `skills/make-bot-ui` | R (sai) | Construída sobre `update_state` de rotinas, webhook `api2.cursor.sh`, painel do agente e Tailscale. Não há mapeamento comum Claude Code / Codex; uma reescrita seria feature nova, não port. O script de colisão garante a ausência |
| `automations/benny/` | R (sai) | Pacote dormente de duas automações Slack sobre o runtime de eventos da Cursor (`.cursor/automations/`, `.cursor/settings.json`, control adapter). Não registrava skill nem no original, então remover não muda o comportamento do plugin. Volta a ser avaliado só se a Cursor mover algo dele para `skills/` |
| `docs/guide/` | R (sai) | Dez capítulos e seis imagens (2,3 MB) que ensinam pstack pela UI da Cursor, sticky mode e cloud agents. Port fiel seria reescrita; `docs/reference.md` aponta para o original no upstream |
| `README.md` da Cursor | Ad (substituído) | Falava de `/add-plugin`, "cursor gives you the best of all worlds", `/make-bot-ui`, benny e "`/deslop` ships in `cursor-team-kit`", tudo falso aqui. Substituído por um README curto do port (o que é, começar, documentos); o texto da Cursor fica no histórico (`91e5b82:README.md`) e no upstream. O open preserva o dele em `README-UPSTREAM.md`; aqui não, porque o split já carrega o histórico e o merge da fase 8 conflita do mesmo jeito |
| Sticky mode | R | Já decidido na fase 4 (frontmatter `mode`/`icon`/`color`/`reminder` removido de `poteto-mode`); a menção "sticky" que sobrava estava só em `docs/guide/` |

Consequência para a fase 8: um commit do remote `cursor` que toque `automations/benny/`, `docs/guide/`, `skills/make-bot-ui` ou `README.md` vai aparecer no digest como conflito modify/delete (ou de conteúdo, no README). O veredito padrão para esses caminhos é "não aplica".

## `docs/reference.md` e testes

- `docs/reference.md` é escrita nova (em português, como `UPSTREAM.md`/`NOTICE.md`/`CHANGES.md`): instalação provisória até a fase 7, layout, notas de Codex, dependências, tabela das 31 skills de fluxo, tabela dos 23 princípios, subagents, verificação, o que ficou de fora, licenças. O `docs/reference.md` do open serviu de esqueleto, mas o texto não é cópia (o dele descreve marketplace, Bun, quad fixo e `plugin-dev`).
- `scripts/reference.test.ts`: o conjunto de nomes nas duas tabelas da referência é exatamente o conjunto de `skills/*/SKILL.md`; diretório = `name` do frontmatter; `principle-*` só na tabela de princípios.
- `tests/skill-collision-repro.sh`: adaptado do open (ver `NOTICE.md` para o que mudou). Parte estática roda dentro de `npm test` via `scripts/skill-collision.test.ts` e sozinha com `npm run collision:check`; a prova comportamental (`claude -p --plugin-dir` com um plugin de uma skill, invocação pela tool `Skill` e por `/testplug:foo`) roda com `PSTACK_BEHAVIORAL=1`, modelo `PSTACK_TEST_MODEL` (default `haiku`).

## Verificação (2026-09-17)

- `npm test`: 85 testes (80 da fase 4 + 4 de `reference.test.ts` + 1 de `skill-collision.test.ts`), 0 `todo`. Primeira rodada 85/85. Rodadas seguintes, com a máquina em load ~3,8, 84/85: `run.test.ts` "spends one explicit deadline across preflight and model execution" (runner, fase 2) dá 300 ms para o fake CLI subir depois de 1,2 s de preflight e estoura sob carga. Falha igual num worktree limpo de `f087f8e`, então é flake pré-existente do runner, não desta fase; fica anotado para ajuste em sessão própria.
- Flake ajustado na mesma data, em commit próprio: o teste passou de `timeoutMs` 1 500 para 2 000 e de `elapsedMs < 2 100` para `< 2 700`, com os mesmos delays de 1,2 s em cada estágio (cada um cabe sozinho no prazo, os dois juntos não), sem mexer em `run.ts`. 10/10 no caso isolado e 3/3 no arquivo inteiro com quatro `yes > /dev/null` em paralelo (load ~5,8); `npm test` 85/85.
- `npm run matrix:check` e `npm run agents:check` verdes.
- `PSTACK_BEHAVIORAL=1 bash tests/skill-collision-repro.sh`: todos os invariantes estáticos `ok`, manifests `skip` (fase 7), e as duas invocações (tool `Skill` e `/testplug:foo`) devolveram `SKILL-RAN` com `haiku`.
- `diff` das sete skills do `cursor-team-kit` contra `cursor/main`: vazio, salvo o frontmatter de `thermo-nuclear-code-quality-review`. `LICENSE-cursor-team-kit` byte-idêntico a `cursor/main:cursor-team-kit/LICENSE`.
- `grep -ri 'if one is installed\|when it is installed' skills`: vazio.

# Fase 6 — `setup-pstack` consumindo a matriz (2026-09-18)

O `setup-pstack` do open-pstack 1.4.1 é só prosa: o modelo lê o sheet, normaliza, probe, escreve e compara "de cabeça". O critério de pronto da fase (rerun byte-idêntico; probe falha ⇒ nada escrito) exige exatidão que prosa não garante, então aqui o desenho muda: a metade determinística vira script testado e a prosa do skill passa a chamá-lo. É escrita nova (sem origem upstream); a prosa do open continua a base dos passos de conversa (pai, effort por família, confirmação, smoke).

## Desenho

- `skills/setup-pstack/scripts/setup-pstack.ts` (Node 24, sem dependências, mesmo padrão do runner) com cinco subcomandos, todos com saída JSON: `state` (lê o sheet do pai, normaliza aliases móveis, deriva um effort por família e lista conflitos), `plan` (render em memória: linhas carregadas ou mapa de primeira execução, papéis faltantes materializados do default, mudanças de papel nomeadas, effort da família reescrito em toda ocorrência; salva `plan.json` num diretório de execução com um marker único por par), `probe` (roda em paralelo cada par de rota `runner` pelo runner externo em `read-only`, um prompt/output/receipt por família; lista os pares nativos com o prompt a enviar), `attest` (registra a resposta de um probe nativo que o modelo rodou pelo primitivo do pai; recusa resposta sem o marker) e `write` (verifica todo par contra o diretório, snapshot dos dois alvos, render da integração, compara, escreve só o que mudou, relê, restaura tudo em falha).
- O modelo faz o que é conversa (pai, uma pergunta de effort por família do mapa, mudanças de papel, confirmação) e os probes nativos (`Agent` com `pstack-<stem>-<effort>` no Claude Code; `spawn_agent` com `model` + `reasoning_effort` no Codex). Um probe externo passa só com receipt `complete` do par exato (provider, model, effort), modelo verificado (`provider-report`) ou fixado por argv (Codex) e o marker no output.
- Integração: no Claude Code, a linha única `@~/.claude/pstack-models.md` em `~/.claude/CLAUDE.md` (acrescentada uma vez; presente fica; duplicada é inconsistente). No Codex, um bloco `<!-- pstack:models:begin/end -->` em `~/.codex/AGENTS.md` com os bytes exatos do sheet (acrescentado no fim na primeira execução, substituído inteiro no rerun; marcador faltante, duplicado ou invertido para a escrita). Diretório onde deveria haver arquivo é inconsistente antes de qualquer escrita; a restauração só reescreve alvo cujos bytes mudaram.
- `SHEET_TITLE`, `SHEET_PREAMBLE` e `renderSheetDocument` entram em `scripts/model-matrix.ts` e passam a servir tanto o bloco de exemplo de `SKILL.md` quanto o sheet real, para que os dois nunca divirjam.

## Decisões

1. **Probe de cada família do mapa final, não "das 5".** O plano dizia "probe das 5" antes da decisão de 2026-09-17 que tirou Sol do mapa padrão. Uma família sem papel não pode persistir effort (o sheet só guarda effort dentro de descritores), então perguntar e probar Sol seria gasto sem efeito. `state` reporta Sol como `outside-map`; um `--effort sol=…` sem papel é recusado; `--role "<papel>=codex:gpt-5.6-sol@<effort>"` traz Sol para o mapa e para o probe. O requisito do open "o mapa final contém ao menos um descritor de cada família da matriz" vira "toda família com effort pedido está no mapa".
2. **Migração de alias móvel no script**, não na prosa: `claude:claude-fable-<rev>@e` e `claude:claude-opus-<rev>@e` viram `fable`/`opus` em memória com registro em `migrations`; qualquer outro modelo Claude versionado, slug sem provider, par fora da matriz ou effort fora da linha é inconsistente e para antes do probe.
3. **Mudança de papel com effort divergente é contradição**, não precedência: `--role "bug-fix=grok:grok-4.6@high"` com a família em `xhigh` é recusado com a instrução de passar `--effort grok=high` (que muda toda ocorrência). Não há regra de precedência inventada, como o open já pedia.
4. **Atestado nativo é do modelo, com marker.** O runner não pode rodar o provider do próprio pai (contrato da fase 2), então o probe nativo é uma volta do primitivo do pai executada pelo modelo; `attest` só aceita resposta que contenha o marker do par e `write` exige o arquivo de evidência do par exato. É auto-atestado honesto: a evidência fica no diretório da execução, ao lado dos receipts.
5. **Sem timeout implícito**: `probe --timeout` só repassa um prazo real ao runner.
6. **Fixtures de teste fora dos scans**: o scan de descritores de `scripts/model-matrix.test.ts` e o grep de pins de revisão de `tests/skill-collision-repro.sh` passam a ignorar `*.test.ts`, porque `setup-pstack.test.ts` usa de propósito descritores inválidos e pins `claude-fable-5-1` para provar a rejeição e a migração.

## Verificação (2026-09-18)

- `npm test`: 121 testes (85 anteriores + 36 de `setup-pstack.test.ts`: parse, normalização, estado, plano, probe com CLIs falsos, atestado, escrita com snapshot/rollback, linha de comando), 0 falhas, 0 `todo`. `matrix:check`, `agents:check` e `collision:check` verdes.
- **Primeira execução real, pai Claude Code** (`plan` → `probe` → 2 nativos → `attest` → `write`): astra `complete` fixado por argv em 8,0 s; grok `complete`, reportou `grok-4.6-build`, 7,2 s, US$ 0,0076. Nativos rodados com `claude -p --plugin-dir` sobre um plugin temporário (manifest só na fase 7) contendo `agents/`, pai `haiku` delegando ao agent `pstack-fable-max` e `pstack-opus-xhigh`: `modelUsage` do pai lista `claude-fable-5-1` e `claude-opus-5[1m]` ao lado do haiku, e as respostas trouxeram o marker exato. `write` criou `~/.claude/pstack-models.md` e `~/.claude/CLAUDE.md` (nenhum existia).
- **Primeira execução real, pai Codex**: fable `complete` reportou `claude-fable-5-1` (4,4 s, US$ 0,128); opus reportou `claude-opus-5` (4,3 s, US$ 0,057); grok `grok-4.6-build` (10,8 s, US$ 0,0075). Astra nativo por `codex exec --model gpt-6-astra --config model_reasoning_effort="max"` de uma volta (o `config.toml` do Victor não liga `multi_agent`, então `spawn_agent` fica para a sessão interativa; o CLI do Codex é o processo nativo do pai, não o launcher externo): marker exato, 19 tokens de saída. `write` criou `~/.codex/pstack-models.md` e `~/.codex/AGENTS.md`. Os dois sheets diferem só nas três linhas de frontier solo (`claude:fable@max` vs `codex:gpt-6-astra@max`).
- **Probe falha ⇒ nada escrito, real**: `plan --effort grok=high` num diretório novo e `write` sem probe ⇒ exit 1 listando as quatro pendências (2 nativos não atestados, 2 receipts ausentes); `shasum -c` dos quatro arquivos da home igual ao da primeira escrita. Nos testes, o fake CLI não autenticado (`unauthenticated`) e o output sem marker também reprovam o par.
- **Rerun byte-idêntico, real**: plano novo nos dois pais (`firstRun: false`), 5 probes externos e 3 nativos novos, todos passaram; `write` devolveu `unchanged` para sheet e integração nos dois pais, `shasum -c` idêntico à primeira escrita e o `sheet` do plano igual byte a byte ao arquivo em disco.
- O passo 9 do skill (painel misto de smoke) é etapa de uso do skill, não critério desta fase; cada descritor do mapa rodou uma lane `read-only` real nos dois pais pelos probes acima.


# Fase 7 — Manifests, marketplace, hook e instalação por tag (2026-09-18)

O plugin é a raiz do repo (no open ele fica em `plugins/pstack/`), então os dois manifests do plugin e os dois marketplaces convivem na mesma árvore. Instalação é por tag, nunca por `main`: no Claude Code a entrada do marketplace fixa `ref: vX.Y.Z` (o `claude plugin marketplace add` não tem `--ref`; quem fixa a tag é a fonte do plugin); no Codex o `--ref` do `marketplace add` fixa o snapshot inteiro. Versão inicial `0.1.0`, independente das versões dos upstreams (`UPSTREAM.md`).

## Veredito por arquivo

| Arquivo | Veredito | O que entrou / o que ficou fora |
| --- | --- | --- |
| `.claude-plugin/plugin.json` | Ad | ponto de partida: o manifest da Cursor 0.15.2 (`.cursor-plugin/plugin.json`) com os campos que o open manteve. `claude plugin validate --strict` (CLI 2.1.273) reprova `logo` (campo desconhecido), `category` e `tags` (campos de entrada de marketplace) e `agents` como string; saem os três (o logo segue no manifest do Codex; `category`/`tags` vão para a entrada do marketplace) e `skills`/`agents`/`hooks` ficam nos defaults (`skills/`, `agents/`, `hooks/hooks.json`). Ficam `name`, `displayName`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`. Fecha a decisão "campo logo" pendente da fase 4: fora, pela mesma razão do open |
| `.claude-plugin/marketplace.json` | Ad | do open: nome `pstack-vic`, owner, um plugin `pstack`. Muda a fonte: `{"source":"github","repo":"byvict/pstack-vic","ref":"v0.1.0"}` no lugar de `./plugins/pstack`, porque o marketplace é lido de `main` e a fonte é o que fixa a tag; `category: development` e `tags` vêm do manifest da Cursor |
| `.codex-plugin/plugin.json` | Ad | do open: `skills: ./skills/`, bloco `interface` (logo, descrições, capabilities, prompts). Adaptados nome de desenvolvedor, URLs e descrições |
| `.agents/plugins/marketplace.json` | Ad | do open: fonte `local` com `path: "./"` (raiz) no lugar de `./plugins/pstack`; nome `pstack-vic` |
| `hooks/hooks.json`, `hooks/session-start`, `hooks/session-start-context.md` | A | byte-idênticos ao open 1.4.1. O mandato já declara precedência de `CLAUDE.md`, `AGENTS.md` e pedidos diretos, manda subagents despachados ignorarem o bloco, compõe com o superpowers e cita só skills que existem aqui (`poteto-mode`, `tdd`, `architect`, `how`, `why`, `arena`, `interrogate`). Sem `shell: "bash"` (o superpowers 6.3 acrescentou; o polyglot dispensa e o validador aceita as duas formas) |
| `hooks/run-hook.cmd` + `LICENSE-superpowers` | A | via open, quase verbatim do superpowers (MIT, Jesse Vincent); ambos os scripts entram executáveis |
| `.cursor-plugin/plugin.json` | R | removido; fica no histórico (`91e5b82`) e serviu de base ao manifest do Claude Code |
| `.gitignore` do open | R | o nosso já cobre (`node_modules/`, `.DS_Store`); `.remember/`, `.vscode/` e o `node_modules` do Bun não se aplicam |
| `.github/workflows/ci.yml`, `scripts/upstream-*.py`, `open-pstack.code-workspace`, `AGENTS.md` do open | — | fora: CI não está no plano; scripts de sync são a fase 8 |
| `tests/skill-collision-repro.sh` | Ad | voltam os checks de manifest do open: versão única (agora entre os dois manifests, o marketplace do Claude Code com a tag `ref` e `package.json`) e logo do Codex resolvendo para arquivo regular dentro do plugin; check novo: manifest do Claude Code sem `logo` |

## Escrita nova

- `scripts/manifests.test.ts`: os quatro manifests e `hooks/hooks.json` parseiam; nome `pstack` e versão iguais em todos, `ref` = `v<versão>`, `package.json` igual; URLs iguais entre os manifests; manifest do Claude Code só com campos conhecidos; `skills` e `interface.logo` do Codex resolvem dentro do plugin; `.cursor-plugin/` ausente; `claude plugin validate --strict --json` passa para o marketplace e para o plugin (pula sem o CLI); hook registrado em `startup|clear|compact` pelo polyglot, scripts executáveis, saída byte-idêntica ao arquivo de contexto, falha limpa e sem injeção quando o arquivo falta, skills citadas no mandato existem.
- `package.json` ganha `version` (quarto lugar da versão única).
- `docs/reference.md`: seção Instalação (marketplace e tag nos dois pais, opt-out do hook, clone para desenvolvimento, publicar uma versão), layout, auto-fire, sticky mode, verificação, licenças. `README.md`: o passo 1 vira a instalação. `NOTICE.md`: linhas dos arquivos copiados.
- `skills/setup-pstack/SKILL.md`: o par nativo do Codex sem `multi_agent` roda como uma volta de `codex exec` do próprio CLI do pai (nota herdada da fase 6).
- Higiene de tags: `remote.{cursor,open}.tagOpt --no-tags` e as seis tags `v1.x` do open que o `fetch` tinha trazido foram apagadas localmente, para que `git push --tags` nunca reexporte tag de upstream; `docs/reference.md` manda publicar a tag pelo nome.

## Decisões

1. **Nome do plugin `pstack`, marketplace `pstack-vic`.** O prefixo `/pstack:` e o mandato `pstack:poteto-mode` já estão nas skills, no hook e em `codex-tools.md`; o que distingue este port do open é o marketplace (`pstack@pstack-vic` vs `pstack@open-pstack`). Os dois não devem ficar habilitados ao mesmo tempo no mesmo pai (colisão de nomes de skill); a fase 9 troca um pelo outro.
2. **Tag fixada na fonte do plugin (Claude Code) e no `--ref` do marketplace (Codex).** O marketplace do Claude Code é lido de `main` e o CLI não tem `--ref`, então `ref: vX.Y.Z` na entrada é o único ponto que fixa a versão instalada; teste e script exigem `ref` = `v` + versão. Publicar uma versão é subir a versão nos quatro arquivos, commit, tag com o mesmo nome. A árvore da tag carrega a própria tag na entrada do marketplace, o que é consistente.
3. **Versão `0.1.0`**, semver próprio do port; `1.0.0` depois da validação no primeiro consumidor (fase 9).
4. **Sem `logo` no manifest do Claude Code**, com `interface.logo` no do Codex: é o que o validador estrito do Claude Code aceita, e é o que o open já fazia.
5. **Instalação de verificação é desfeita.** As provas abaixo instalaram e desinstalaram o plugin; o ambiente do Victor fica como estava (`config.toml` do Codex byte-idêntico) até a fase 9 instalar de verdade.
6. **URL do repositório assumida** como `byvict/pstack-vic` (conta GitHub ativa do `gh`) nos manifests e docs; o repo é criado ao fechar esta fase, e o dono/visibilidade é decisão do Victor.

## Verificação (2026-09-18)

- `npm test`: 131 testes (121 + 10 de `manifests.test.ts`), 0 falhas, 0 `todo`. `matrix:check`, `agents:check` e `collision:check` verdes. `claude plugin validate --strict` passa para `.` (marketplace) e para `.claude-plugin/plugin.json`.
- **Claude Code, clone carregado direto** (`claude -p --plugin-dir ~/Dev/pstack-vic`, pai `haiku`): o hook injetou o mandato (a resposta citou as duas primeiras frases do bloco); as 54 skills listadas com prefixo `pstack:` (31 de fluxo + 23 princípios); o probe nativo `Agent` → `pstack-fable-max` respondeu o marker exato e `modelUsage` do pai lista `claude-fable-5-1` ao lado do haiku (3,4 s, US$ 0,55). Aposenta a receita do plugin temporário da fase 6.
- **Codex, marketplace local** (`codex plugin marketplace add ~/Dev/pstack-vic` → `codex plugin add pstack@pstack-vic`, CLI 0.154.0): instalou `0.1.0` em `~/.codex/plugins/cache/pstack-vic/pstack/0.1.0`; `config.toml` ganhou `[marketplaces.pstack-vic]` e `[plugins."pstack@pstack-vic"]`; `codex exec` (astra, `low`) listou as 54 skills como `pstack:<nome>`, os `principle-*` inclusive (`user-invocable: false` é do Claude Code). `plugin remove` + `marketplace remove` devolveram o `config.toml` aos bytes originais.

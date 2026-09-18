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
- **Instalação por tag, real** (repo `byvict/pstack-vic`, público, tag `v0.1.0` sobre `8dfa4cb`). Claude Code (`claude plugin marketplace add byvict/pstack-vic` → `claude plugin install pstack@pstack-vic`, CLI 2.1.273): clonou o marketplace, instalou `0.1.0` em `~/.claude/plugins/cache/pstack-vic/pstack/0.1.0` com `gitCommitSha` igual ao commit da tag; uma sessão `claude -p` sem `--plugin-dir` recebeu o mandato do hook e contou 66 nomes com prefixo `pstack:` (54 skills + 12 agents). Codex (`codex plugin marketplace add byvict/pstack-vic --ref v0.1.0` → `codex plugin add pstack@pstack-vic`, CLI 0.154.0): `config.toml` registrou `source_type = "git"` e `ref = "v0.1.0"`, instalou `0.1.0`; `codex exec` contou 54 skills e nomeou `pstack:poteto-mode` como entrada. Os dois desinstalados em seguida: `installed_plugins.json`, `known_marketplaces.json` e `config.toml` byte-idênticos ao estado anterior, caches vazios removidos. Critério de pronto da fase cumprido nos dois pais; a instalação de verdade é a fase 9.


# Fase 8 — Tracking semanal dos dois upstreams (2026-09-18)

O que a fase 0 deixou como comandos manuais em `UPSTREAM.md` vira um script e uma rotina: `scripts/upstream-digest.ts` lê os dois pontos de sync da tabela de `UPSTREAM.md`, faz `git fetch` dos remotes `cursor` e `open` e imprime um digest em markdown (ou JSON) com uma linha por commit novo e a coluna de veredito vazia; uma tarefa agendada do app Claude Code roda o script toda segunda-feira e posta o resultado no projeto pstack-vic do Linear. O ponto de sync continua avançando só à mão, quando todos os commits do intervalo têm veredito.

## Veredito por arquivo

| Arquivo do open | Veredito | Motivo |
| --- | --- | --- |
| `scripts/upstream-audit.py` | R | Compara as árvores `pstack/` base → alvo com a árvore do port e classifica cada arquivo (`already-matches-target`, `unchanged-since-base`, `port-diverged-review`, `upstream-addition`, `absent-from-port-review-exclusion`, `distribution-review`). Python num tooling que é Node 24 sem Python; um upstream só; mapa de caminhos `pstack/` → `plugins/pstack/` e `README.md` → `README-UPSTREAM.md` que não vale aqui (plugin na raiz, README próprio). A ideia que sobrevive é a classificação por caminho, reescrita em TS: mapa por upstream, "fora do plugin", "excluído na fase 5", "ausente aqui" |
| `scripts/upstream-merge.py` | R | Aplicação mecânica do JSON do audit (checkout verbatim, `git merge-file` de três vias, recusa de HEAD divergente e de paths sujos). No plano, aplicar é sessão normal com PR, não parte do digest; do lado `cursor` a aplicação é merge da linha do split, que o git já faz em três vias |
| `scripts/upstream-merge-probe.py` | R | Prova do merge em worktrees descartáveis; cai com o merge |
| `UPSTREAM.md` do open (seção *Check for changes*) | — | Já absorvido na fase 0, para os dois remotes |
| `.github/workflows/ci.yml`, `AGENTS.md`, `open-pstack.code-workspace` | — | Continuam fora (CI não está no plano) |

A linha "prevista" para `scripts/upstream-*.py` sai de `NOTICE.md`; o digest entra na lista de escrita nova.

## Escrita nova

- `scripts/upstream-digest.ts` (Node 24, só `node:child_process`, `node:fs`, `node:util.parseArgs`): `readSyncPoints` (regex sobre a linha `| Commit | \`<sha>\` | \`<sha>\` |` de `UPSTREAM.md`, falha limpa se a linha mudar de forma), `UPSTREAMS` (por upstream: ref, remote, prefixo do plugin, filtro de log, manifest de versão), `buildDigest` (fetch opcional, `rev-parse` dos dois pontos e dos dois tips, versão lida do `plugin.json` no tip, `git log --reverse` do intervalo restrito a `pstack/` no cursor e inteiro no open, `--name-status --no-renames` por commit), `renderMarkdown` (cabeçalho com data, tabela de intervalo/tip/versão/contagem por upstream, tabela `Commit · Data · Assunto · Arquivos · Veredito`, "Sem novidades" no intervalo vazio, rodapé com a regra de aplicação), `--json`, `--since cursor=<sha>` / `--since open=<sha>` (aceita abreviado, resolve para o hash inteiro, marca "início por `--since`"), `--repo <dir>`, `--no-fetch`. Exit 0 com intervalo vazio; 2 em fetch, parse ou sync point inválido. `EXCLUDED_PATHS` codifica a consequência anotada na fase 5: commit que só toca `automations/benny/`, `docs/guide/`, `skills/make-bot-ui/`, `README.md` ou `.cursor-plugin/` já vem com `não aplica`.
- `scripts/upstream-digest.test.ts` (10 testes): parse do `UPSTREAM.md` real com os dois pontos resolvendo no clone; recusa de tabela sem hash inteiro; `--since` válido e inválido; mapa de caminhos e exclusões; repo de fixture em diretório temporário em que um único repositório faz os três papéis (port na raiz, `refs/remotes/cursor/main` com o plugin em `pstack/`, `refs/remotes/open/main` com o plugin em `plugins/pstack/`): ordem e filtro dos commits do cursor (commit fora de `pstack/` não aparece), veredito pré-preenchido só quando todos os arquivos do plugin são excluídos, open com arquivo fora do plugin e arquivo novo ausente no port, deleção não marcada como ausente, markdown linha a linha, "Sem novidades" nos dois lados quando o sync é o tip, `--since` reabrindo o intervalo, sync point inválido, linha de comando (`--json`, markdown igual ao render, `--since` ruim ⇒ 2, `--help` ⇒ 0, fetch sem remotes ⇒ 2 com a mensagem do git).
- `package.json`: `upstream:digest`. `UPSTREAM.md`: seção *Digest semanal* (comandos, mapa de caminhos, exclusões, rotina) e passo 1 de *Incorporar uma mudança* apontando para a issue. `docs/reference.md`: layout, verificação. `NOTICE.md`: escrita nova; tabela "prevista" removida.
- Tarefa agendada do app Claude Code `pstack-vic-upstream-digest` (`~/.claude/scheduled-tasks/pstack-vic-upstream-digest/SKILL.md`, cron `0 9 * * 1`, hora local): roda `node scripts/upstream-digest.ts --json` e o markdown no clone, e posta pelo conector Linear: com novidade, uma issue `Upstream digest <data>` no projeto (descrição = o markdown, sem duplicar título já existente); sem novidade, um comentário de uma linha no projeto com os tips; falha do script vira comentário com o erro. A tarefa não edita o repo nem avança o sync point. Fora do repo por natureza (é estado da máquina do Victor), como as quatro entradas da home que `setup-pstack` escreve.

## Decisões

1. **Escrita nova em Node, não cópia dos scripts Python do open.** O tooling do port é Node 24 sem Bun e sem Python; o open resolve um upstream só e aplicação mecânica, que aqui é sessão com PR. Sobrevive a classificação por caminho, em TS.
2. **Destino = issue no projeto do Linear, não Slack.** O veredito por commit fica onde o plano está, a sessão de aplicar cita a issue, e o projeto não tinha issue nenhuma para conflitar.
3. **Agendador = tarefa agendada do app Claude Code, não rotina em nuvem nem `launchd`.** Tem o conector Linear e roda no clone local com os dois remotes já registrados; roda com o app aberto e, fechado, dispara na próxima abertura, o que para cadência semanal serve. A rotina em nuvem precisaria clonar, registrar remotes e ter o conector na nuvem (não verificado); `launchd` (precedente `com.clinext.*`) só posta com token da API.
4. **Semana vazia = comentário de uma linha no projeto**, não issue, para a ausência de novidade ficar visível sem sujar a lista.
5. **`--since` é só leitura**: reabre o intervalo para demonstração ou reprocessamento e nunca escreve em `UPSTREAM.md`. Avançar o sync point continua sendo edição manual da tabela mais a linha de `NOTICE.md`, como a fase 0 definiu.
6. **Exclusões da fase 5 como dado do script** (`EXCLUDED_PATHS`), em vez de o Victor redescobrir a cada semana que `docs/guide/` não entra.

## Verificação (2026-09-18)

- `npm test`: 141 testes (131 + 10 de `upstream-digest.test.ts`), 0 falhas, 0 `todo`. `matrix:check`, `agents:check` e `collision:check` verdes.
- **Primeira rodada real, com fetch** (`npm run upstream:digest`): os dois remotes buscados, `5bf2b15..cursor/main -- pstack` e `de67e6b..open/main` vazios, "Sem novidades" nos dois lados, tip do cursor `e31650e` (2026-09-16, `0.15.2`; o tip de `cursor/main` anda por commits fora de `pstack/`) e tip do open `de67e6b` (2026-09-10, `1.4.1`), exit 0. Critério de pronto da fase cumprido: o delta atual é vazio porque 0.15.2 já está absorvido e o open não saiu de 1.4.1.
- **Renderização com commits, real**: `--since cursor=f8abedd` reabre o delta 0.15.1 → 0.15.2 e lista os 3 commits (`f5bdd68`, `889ec4b`, `5bf2b15`) com 5, 5 e 3 arquivos, `README.md`, `docs/guide/01-setup.md` e `.cursor-plugin/plugin.json` marcados "excluído na fase 5" e o veredito vazio porque cada commit também toca skills mantidas.
- **Rotina, real**: tarefa `pstack-vic-upstream-digest` criada (o app aplica um jitter e mostra "09:03, segunda-feira"; próxima execução 2026-09-21) e disparada uma vez por "Run now": a sessão rodou o script com fetch, viu intervalo vazio e postou no projeto pstack-vic do Linear o comentário `Upstream digest 2026-09-18: sem novidades (cursor em e31650e, open em de67e6b).` em 30 s, sem tocar no repo (`git status` limpo fora dos arquivos desta fase). As aprovações de tool dessa rodada ficam guardadas na tarefa, então as próximas não param em prompt.


# Fase 9 — Validação no primeiro consumidor, o Clinext (2026-09-18)

O plano previa instalar no worktree `~/Dev/clinext-open-pstack` no lugar do open-pstack. Nenhum dos dois existia mais na máquina (o worktree foi removido e o open-pstack não estava instalado em nenhum pai), então não houve o que substituir: a instalação real foi feita por tag nos dois pais e a validação rodou em dois worktrees descartáveis do Clinext, um por pai (`test/pstack-vic-claude` e `test/pstack-vic-codex`, ambos de `main` em `50eadb6e9`), cada um com uma issue real do backlog: CLI-148 (o `AI_PARSE_ERROR` que nunca chegava ao log) no pai Claude Code e CLI-150 (`pendingFacts` repetidos por `rule id`) no pai Codex. Cada pai rodou `arena` (quatro runners e um juiz) e depois `interrogate` (quatro revisores) sobre o diff que a própria arena produziu, sem push nem PR: a decisão de mandar essas correções para o Clinext é do Victor.

## O que a validação encontrou e o que mudou

| Achado | Onde | O que mudou |
| --- | --- | --- |
| Dentro do seatbelt do Codex, o Grok não inicializa o próprio perfil de sandbox (`sandbox initialization failed: Operation not permitted`) e se recusa a rodar | runner, lane Grok com pai Codex | `commands.ts`: quando o runner vê `CODEX_SANDBOX` no próprio ambiente, passa `--sandbox none` ao Grok e o seatbelt externo manda; teste em `commands.test.ts`. Release `0.1.1` (`d2ddb4c`) |
| O Grok grava a sessão em `~/.grok`, que o seatbelt bloqueia (`FS_PERMISSION_DENIED`), e as CLIs filhas precisam de rede | pai Codex | Precondição documentada em `provider-dispatch.md` e `docs/reference.md`: `sandbox_workspace_write.network_access = true` e `~/.grok` em `writable_roots` (no `config.toml` ou por sessão com `-c`). Provado com a lane Grok `complete` dentro do sandbox |
| Um pai headless (`claude -p`) encerrou o turno "esperando as lanes" e o processo cancelou os runners aos 10 min 47 s (receipts `cancelled`, `SIGTERM`); a primeira arena não chegou ao julgamento (US$ 15,83 perdidos) | pai Claude Code, primeira rodada | `provider-dispatch.md`: drenar os handles é dever do pai em qualquer modo; num pai não interativo nada o acorda, então ele bloqueia em `TaskOutput`/`wait_agent` até cada lane ter receipt. A segunda rodada, com essa instrução, drenou tudo |
| Lanes Grok caíram nos dois pais como `malformed-output`: escritoras nas arenas (`acceptEdits`) e a revisora read-only no interrogate do Claude (`plan`). O motor de permissões do Grok pede aprovação para segmentos de shell que as heurísticas não liberam; sem TTY, o turno inteiro é cancelado (`permission_cancelled`) | runner, todas as lanes Grok | Reproduzido de forma determinística: o mesmo `node -e` multilinha é aprovado num repo de sonda e pede aprovação dentro do Clinext (worktree e checkout principal), em `plan`, `acceptEdits` e `dontAsk`; `.grok/config.toml` e `.claude/settings.json` do projeto copiados para a sonda não disparam, então o gatilho é do conteúdo do repo. A documentação do Grok manda automação sem operador para always-approve e diz que o "piso" de aprovação só cede a esse modo. `commands.ts`: lanes Grok rodam em `bypassPermissions` nos dois modos e o confinamento é do sandbox (`read-only`/`workspace`, ou o seatbelt do Codex quando o Grok roda em `none`) mais a lista de tools; provado no worktree do Clinext (comando que cancelava rodou sem prompt; `touch` bloqueado pelo sandbox `read-only`). Entra na `0.1.2` |
| O receipt de uma lane que falha guardava os primeiros 4.000 caracteres do stream, isto é, a linha de `init` com a lista de tools, e perdia o evento `result` com o erro | runner, `run.ts` | `evidence()` guarda os primeiros 1.000 caracteres e os últimos 2.995, com teste. Entra na `0.1.2` |
| O `codex exec` headless expõe `collaboration.spawn_agent` quando `features.multi_agent=true` vai por flag; a nota da fase 6 ("só em sessão interativa") estava errada | pai Codex | `-c features.multi_agent=true` na chamada; a lane nativa astra rodou por `spawn_agent` na arena e no interrogate |
| O sandbox `workspace-write` do Codex protege `.git`, então o pai não consegue fazer o commit da síntese num worktree (recusa `index.lock`) | pai Codex | Registrado; o commit `28cad37fb` foi feito à mão com a mensagem que o pai deixou em `commit-message.txt`. O Playwright do `verify-clinext` também é bloqueado (MachPortRendezvous) e o pai provou a UI pelo CUA Chrome |
| O `README.md` ficou com `--ref v0.1.0` depois da release 0.1.1 | docs | Teste novo em `manifests.test.ts`: README e `docs/reference.md` citam a tag da versão corrente |

## `verify-clinext` a partir do `poteto-mode`

`claude -p` no checkout principal do Clinext, plugin instalado, pai `opus`: carregou `pstack:poteto-mode`, `pstack:principle-prove-it-works` e a skill do projeto `verify-clinext` pela tool `Skill` (o link `.claude/skills/verify-clinext` resolve no worktree também), rodou `launch`, `doctor`, `drive-login` e `cleanup` em 3371/5271 com banco descartável, e deixou sete evidências (`01-login-form.png` + ARIA, `02-shell-after-login.png` + ARIA, `03-auth-me.json`, `04-auth-sessions.json`, `report.json`). `git status` limpo depois; 14 turnos, 70 s, US$ 1,16.

## Arena, pai Claude Code (CLI-148)

Segunda rodada, plugin `0.1.1`, `claude -p` sem flags de bypass (as permissões vêm do `settings.json` do Clinext), pai `opus`: 100 turnos, 42 min, US$ 26,17 (opus 17,98 + fable 8,19; astra e grok cobram fora). Commit `fddc2003d` em `test/pstack-vic-claude` (2 arquivos, +100/−1): `_fail` emite `warn` com `{ conversationId, operationId, cause, code, detail }`, `detail` = rótulo da mensagem até o primeiro `: ` (o valor emitido pelo modelo fica fora do log); checks 47 e 48 falham sem a mudança e passam com ela; `npm test` 1278/0.

| Lane | Descritor | Rota | Receipt | `reportedModel` | Evidência | Tempo |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `claude:fable@max` | nativa, `Agent` → `pstack:pstack-fable-max` | n/a (rationale `native-1.md`, commit `4b8f0977c` no worktree) | n/a | transcript da tool | 928 s |
| 2 | `codex:gpt-6-astra@max` | runner externo, `isolated-write` | `complete` | `null` | `pinned-argv` | 623 s |
| 3 | `grok:grok-4.6@xhigh` | runner externo, `isolated-write` | `malformed-output` (dropout) | `null` | `null` | 777 s |
| 4 | `claude:opus@xhigh` | nativa, `Agent` → `pstack:pstack-opus-xhigh` | n/a (rationale `native-4.md`, commit `c4a37bb29`) | n/a | transcript da tool | 530 s |
| juiz | `codex:gpt-6-astra@max` | runner externo, `read-only` | `complete` | `null` | `pinned-argv` | 462 s |

Base C (opus), enxertos de B (rótulo estático, ideia do juiz) e de A (forma do segundo check); rejeitada a coluna `failure_detail` de A (oito arquivos de migração e texto livre numa tabela cujos snapshots viajam). O juiz discordou do pai na base (recomendou B) e a nota de síntese registra a resolução.

## Arena, pai Codex (CLI-150)

`codex exec -m gpt-6-astra` em `xhigh`, `-c features.multi_agent=true`, sandbox `workspace-write` com rede e `writable_roots` = `~/Dev/clinext` e `~/.grok`; 16,8 M tokens de entrada (16,6 M em cache), 33,7 k de saída. Commit `28cad37fb` em `test/pstack-vic-codex` (2 arquivos, +89/−1): dedupe dos `pendingFacts` por id antes da persistência, primeira ocorrência vence, fatos da consulta preservados; 47/47, `npm run preflight` verde, cliente 5.942 testes, raiz 1.278 (o teste de dependências precisou de `npm_config_cache` dentro do sandbox), prova de UI com `verify-clinext` (oito pendências antes, duas depois).

| Lane | Descritor | Rota | Receipt | `reportedModel` | Evidência | Tempo |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `claude:fable@max` | runner externo, `isolated-write` | `complete` | `claude-fable-5-1` | `provider-report` | 326 s |
| 2 | `codex:gpt-6-astra@max` | nativa, `spawn_agent` | n/a (rationale `native-2.md`) | n/a | resultado nativo | ≤ 446 s |
| 3 | `grok:grok-4.6@xhigh` | runner externo, `isolated-write` | `malformed-output` (dropout) | `null` | `null` | 252 s |
| 4 | `claude:opus@xhigh` | runner externo, `isolated-write` | `complete` | `claude-opus-5` | `provider-report` | 302 s |
| juiz | `claude:fable@max` | runner externo, `read-only` | `complete` | `claude-fable-5-1` | `provider-report` | 474 s |

Base B (astra nativa), uma frase de JSDoc enxertada de A/D; A, B e D convergiram na semântica da agregação.

## Interrogate

Cada pai revisou o diff que a própria arena produziu, com os quatro revisores do sheet, todos read-only, cwd = o worktree.

**Pai Codex (CLI-150, `28cad37fb`)**, plugin `0.1.1`: 3,33 M tokens de entrada (3,23 M em cache), 18,1 k de saída. Veredito: *changes requested* por um achado consensual (fable e opus): o dedupe trata `id` ausente ou nulo como identidade compartilhada e descarta fatos distintos do rascunho em silêncio; o pai reproduziu com entrada sintética pela fronteira real do provedor. Astra e Grok sem achados.

| Revisor | Descritor | Rota | Receipt | `reportedModel` | Evidência | Tempo | Achados |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | `claude:fable@max` | runner externo | `complete` | `claude-fable-5-1` | `provider-report` | 243 s | 1 |
| B | `codex:gpt-6-astra@max` | nativa, `spawn_agent` | n/a (`native-reviewer-b-astra.md`) | n/a | resultado nativo | ≤ 240 s | 0 |
| C | `grok:grok-4.6@xhigh` | runner externo (`--sandbox none` sob o seatbelt) | `complete` | `grok-4.6-build` | `provider-report` | 510 s | 0 |
| D | `claude:opus@xhigh` | runner externo | `complete` | `claude-opus-5` | `provider-report` | 276 s | 3 |

**Pai Claude Code (CLI-148, `fddc2003d`)**, duas rodadas. A primeira, com o plugin `0.1.1`, perdeu o revisor Grok (`malformed-output`, `permission_cancelled` num `node -e` em modo `plan`): 29 turnos, 17 min, US$ 13,95, veredito com um "act on". A segunda, com o plugin `0.1.2` (Grok em always-approve sob sandbox `read-only`), é a prova da correção: quatro revisores, três provedores, zero dropouts; 28 turnos, 17 min, US$ 12,82 (opus 8,15 + fable 4,67). Veredito: três "act on" (o check 48 fixa o rótulo e não a propriedade de contenção, apontado por fable, grok e opus de forma independente; o `warn` sai com `subsystem` errado; o corte no `: ` é decidido no `catch` e perde o diagnóstico das classes de provedor e capacidade), dois "consider".

| Revisor | Descritor | Rota | Receipt | `reportedModel` | Evidência | Tempo | Achados |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | `claude:fable@max` | nativa, `Agent` → `pstack:pstack-fable-max` | n/a (`native-reviewer-a-fable.md`) | n/a | transcript da tool | 555 s | 3 |
| B | `codex:gpt-6-astra@max` | runner externo | `complete` | `null` | `pinned-argv` | 273 s | 0 |
| C | `grok:grok-4.6@xhigh` | runner externo (`bypassPermissions`, sandbox `read-only`) | `complete` | `grok-4.6-build` | `provider-report` | 672 s | 2 |
| D | `claude:opus@xhigh` | nativa, `Agent` → `pstack:pstack-opus-xhigh` | n/a (`native-reviewer-d-opus.md`) | n/a | transcript da tool | 551 s | 4 |

Os dois vereditos ficam com o Victor junto das branches: nenhuma das correções foi aplicada ao Clinext.

## Decisões

1. **Instalação real por tag e em escopo `user`** no Claude Code (o mesmo caminho provado na fase 7) e na marketplace do Codex; a versão instalada ao fechar a fase é a `0.1.2`.
2. **A `1.0.0` espera o smoke visual do Victor**, que o plano deixa com ele; as duas correções do Clinext ficam nas branches de teste até ele decidir.
3. **Correções do runner entram na fase**, com release, porque a validação existe para isso; o que não reproduziu fora do Clinext (o gatilho do prompt do Grok) fica registrado como decisão por documentação.
4. **As arenas rodaram headless** (`claude -p`, `codex exec`) por serem reprodutíveis e observáveis; a lição da drenagem vale também para o uso interativo, onde a notificação da task acorda o pai.

## Verificação (2026-09-18)

- `npm test`: 144 testes (141 + `evidence` em `run.test.ts`, `--sandbox none`/always-approve em `commands.test.ts`, tag nos docs em `manifests.test.ts`), 0 falhas, 0 `todo`. `matrix:check`, `agents:check` e `collision:check` verdes.
- **Instalação real**: Claude Code `pstack@pstack-vic` em escopo `user` (`claude plugin marketplace add byvict/pstack-vic` + `install`, depois `marketplace update` + `plugin update` a cada release: 0.1.0 → 0.1.1 → 0.1.2, cache em `~/.claude/plugins/cache/pstack-vic/pstack/<versão>`); Codex `marketplace add byvict/pstack-vic --ref v0.1.2` + `plugin add`, `config.toml` com `ref = "v0.1.2"`. Nenhuma instalação de verificação a desfazer: esta é a instalação de verdade.
- **Sonda do runner dentro do sandbox do Codex** (`codex exec --sandbox workspace-write`, rede ligada): opus `complete`/`provider-report` já na 0.1.0; grok `child-failed` (seatbelt aninhado) na 0.1.0, `unavailable-model`/`FS_PERMISSION_DENIED` com `--sandbox none` e `~/.grok` bloqueado, `complete`/`grok-4.6-build` com `--sandbox none` e `~/.grok` em `writable_roots`.
- **Sonda do Grok headless** no worktree do Clinext: o `node -e` que cancelou a lane do interrogate cancela também em `plan` e `dontAsk`; em `bypassPermissions` com sandbox `read-only` roda, e um `touch` no worktree é bloqueado pelo sandbox (arquivo não criado).
- **Critério de pronto do plano**: receipts das quatro lanes com a rota certa e o `reportedModel` de cada família nos dois pais, vindos dos dois `interrogate` finais (Codex na 0.1.1, Claude na 0.1.2); a lane nativa de cada pai não tem receipt por desenho (o transcript da tool é a evidência). Os pacotes de evidência (prompts, saídas, rationales, receipts, sínteses e vereditos, um por pai) estão anexados à issue "Fase 9 — receipts de validação" do projeto pstack-vic no Linear; não entram neste repo público porque carregam diffs e código do Clinext.
- **`verify-clinext` a partir do `poteto-mode`**: provado no pai Claude Code (tabela acima); o pai Codex também o usou por conta própria na verificação da arena.
- **Consumo reportado** (o `total_cost_usd` que o `claude -p` imprime é equivalente de tabela, `costBasis: list`; nada foi cobrado por uso, os três CLIs rodam nas assinaturas: Claude Max pelo login claude.ai, ChatGPT no Codex, OAuth no Grok): verify US$ 1,16; arena Claude rodada 1 (perdida) US$ 15,83 e rodada 2 US$ 26,17; interrogate Claude US$ 13,95 + 12,82. Pai Codex: 16,8 M + 3,3 M tokens de entrada, 96 % em cache. Serve para comparar rodadas, não como fatura.

# CLI-179 — Effort por lane no `setup-pstack` (2026-09-18)

A fase 6 guardava um effort por família: `state` lia dois efforts de uma família como `conflict`, `plan` recusava mudança de papel com effort divergente (decisão 3 da fase 6) e reescrevia toda lane da família para o effort único. O runtime nunca teve esse limite: o descritor `provider:model@effort` é por lane, o runner recebe `--effort` por chamada e os agentes nativos existem em todo nível. A CLI-179 pede `bug-fix: codex:gpt-5.6-sol@xhigh` e `hillclimb: codex:gpt-5.6-sol@high` na mesma planilha.

## Desenho

- O effort pertence à lane, não à família. A unidade de sonda passa a ser o par (família, effort): um por descritor distinto no mapa final, arquivos `probe-<família>@<effort>.*` e `native-<família>@<effort>.json`, marker com o effort, `attest --pair <família>@<effort>`.
- `state`: `efforts` por família com `status` (`current`, `mixed`, `unassigned`, `outside-map`), os efforts distintos em uso e as linhas que os usam. `mixed` é estado válido; `conflicts` deixa de existir.
- `plan`: `--effort <família>=<effort>` é reescrita em bloco de toda lane da família nas linhas de base; `--role` aplica depois, lane a lane, cada uma com o effort escrito. Assim `--effort grok=high --role "bug-fix=grok:grok-4.6@xhigh"` cabe num plano só. `plan.json` sobe para `schemaVersion: 2`; um diretório de execução do formato anterior é recusado.
- Prosa do skill: a conversa passa a ser papel por papel, em ordem da matriz, uma chamada de `AskUserQuestion` por papel com duas perguntas de opções, modelo e depois effort (painel recebe uma pergunta só, com a lista digitada). Cada pergunta traz a `description` do papel, campo novo e obrigatório em `model-matrix.json` (uma linha sobre o que a lane faz), renderizado como coluna "What the lane does" na tabela de papéis de `provider-dispatch.md`. A pergunta por família some; `--effort` fica como atalho para mover uma família inteira. `provider-dispatch.md` registra que a família não tem effort próprio e que a coluna Default só semeia a primeira execução.

## Decisões

1. **Reverte a decisão 3 da fase 6.** Mudança de papel com effort divergente deixa de ser contradição porque o sheet não guarda mais um effort por família; a precedência é a ordem de aplicação (bloco, depois papel), não uma regra inventada.
2. **`--effort` em bloco continua existindo** porque "sobe todo Grok para xhigh" é a operação comum; a exceção por papel vai em `--role`.
3. **Versão 0.1.3**: mudança de comportamento e de linha de comando (`attest --pair`).

## Verificação (2026-09-18)

- `npm test`: 151 testes (144 + 7 em `setup-pstack.test.ts`: `mixed` no `state`, papel com effort diferente das outras lanes da família, `--effort` em bloco seguido de `--role`, rerun byte-idêntico de sheet misto, duas lanes externas de Sol com caminhos distintos, dois pares nativos de Fable, `attest --pair` e recusa de `plan.json` do schema 1), 0 falhas, 0 `todo`. `matrix:check` e `agents:check` verdes.
- **Sonda real, pai Claude Code**, sobre uma cópia do sheet do Victor com `--role "bug-fix=codex:gpt-5.6-sol@xhigh"` (hillclimb já em `sol@high`): seis pares, `sol@high` e `sol@xhigh` separados. Externos `complete` com o effort pedido no receipt: sol high 6,2 s, sol xhigh 8,1 s, astra medium 6,9 s (os três `pinned-argv`), grok high 5,9 s (`grok-4.6-build`). Nativos por `pstack-fable-medium` e `pstack-opus-high`, um turno cada, marker exato. `write` numa home de rascunho: sheet `updated` com as duas linhas de Sol, integração `unchanged`; segundo `write` do mesmo plano: `unchanged`/`unchanged`; `plan` sem argumentos sobre o sheet escrito rende o mesmo byte a byte e os mesmos seis pares.
- Código escrito por uma lane `grok:grok-4.6@high` (papel `feature, refactoring`) em worktree isolado pelo runner, `isolated-write`, receipt `complete`, 14,8 min, 52 k tokens de saída; a lane não conseguiu commitar porque o sandbox `workspace` do Grok não escreve em `.git` do checkout pai (mesmo achado do seatbelt do Codex na fase 9), commit feito pelo pai.

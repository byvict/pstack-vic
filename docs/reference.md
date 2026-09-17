# pstack-vic — referência técnica

pstack-vic é um port autoral do [pstack](https://github.com/cursor/plugins/tree/main/pstack) de Lauren Tan ([@poteto](https://x.com/poteto)) para Claude Code e Codex. Uma única árvore de skills serve os dois pais. Os modelos de cada papel vêm de uma matriz como dado (`model-matrix.json`), não de constantes espalhadas pelas skills.

Conteúdo sincronizado com Cursor pstack **0.15.2** (`5bf2b15`) e com open-pstack **1.4.1** (`de67e6b`). O contrato de sync está em [`UPSTREAM.md`](../UPSTREAM.md), a proveniência de cada arquivo em [`NOTICE.md`](../NOTICE.md) e o veredito de cada mudança em [`CHANGES.md`](../CHANGES.md).

> if you want to go fast, go deep first.

## Instalação

A instalação por marketplace e tag (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `--ref vX.Y.Z`) é a fase 7 do plano. Até lá o plugin roda a partir do clone:

```shell
# Claude Code: carrega o clone como plugin da sessão
claude --plugin-dir ~/Dev/pstack-vic
```

```shell
# Codex: liga as skills no diretório de skills do usuário
for s in ~/Dev/pstack-vic/skills/*/; do ln -s "$s" ~/.agents/skills/"$(basename "$s")"; done
```

No Codex, ligue subagents em `~/.codex/config.toml` para as skills que fazem fan-out (`interrogate`, `arena`, `how`, `why`, `reflect`, `architect`, `swarm`):

```toml
[features]
multi_agent = true
```

Rode `/setup-pstack` uma vez em cada pai para escrever o sheet de modelos (`~/.claude/pstack-models.md` e `~/.codex/pstack-models.md`). Depois, `/poteto-mode` é o ponto de entrada para qualquer tarefa que peça rigor.

## Layout

```text
.
├── model-matrix.json                 # famílias, efforts, pais, rota por pai, papéis (dado canônico)
├── scripts/                          # loader/validação da matriz, render dos blocos gerados, gerador de agents, testes
├── skills/                           # 54 skills compartilhadas por Claude Code e Codex
│   ├── poteto-mode/references/       # provider-dispatch.md (rota e papéis), codex-tools.md (mapa de tools), bugbot-triage.md
│   └── poteto-mode/scripts/          # runner externo (Node 24), watch-pr, orch, check-plan.mjs, worktree-audit.sh
├── agents/                           # poteto-agent, comment-sicko e as lanes nativas pstack-<família>-<effort> geradas da matriz
├── assets/                           # logo
├── docs/reference.md                 # esta referência
├── tests/skill-collision-repro.sh    # invariantes do pacote de skills (estático) e prova de invocação no Claude Code (opcional)
├── LICENSE                           # pstack (Lauren Tan), MIT
├── LICENSE-open-pstack               # open-pstack (Eric Litman), MIT
├── LICENSE-cursor-team-kit           # cursor-team-kit (Cursor), MIT
├── NOTICE.md · UPSTREAM.md · CHANGES.md
└── package.json                      # npm test, matrix:check, agents:check, collision:check
```

## Rodar no Codex

Nada é gerado nem bifurcado por pai. Duas referências fazem a tradução em tempo de execução: [`codex-tools.md`](../skills/poteto-mode/references/codex-tools.md) mapeia tools e built-ins do Claude Code (`Agent` → `spawn_agent`, `AskUserQuestion`, `run`, `verify`, `loop`, `skill-creator`) e [`provider-dispatch.md`](../skills/poteto-mode/references/provider-dispatch.md) mapeia famílias de modelo para a rota certa em cada pai. As skills que citam um primitivo do Claude Code carregam uma nota de plataforma de uma linha apontando para o mapa.

- **Invocação.** O Codex carrega `SKILL.md` nativamente; não há tool `Skill`. Peça a skill pelo nome.
- **Rota de modelos.** Quem é pai escolhe a rota. No Claude Code, Fable e Opus rodam em agents nativos e Sol, Astra e Grok no runner externo. No Codex, Sol e Astra rodam em `spawn_agent` e Fable, Opus e Grok no runner. Um filho nunca escolhe provider nem troca de rota por conta própria; lane indisponível vira dropout nomeado, nunca substituição silenciosa.
- **Papéis.** As skills citam papéis (`arena runners`, `bug-fix`, `how explainer`…), não descritores. O default de cada papel, por pai, está na seção *Role defaults* de `provider-dispatch.md` e é o que `/setup-pstack` escreve no sheet.
- **Auto-fire.** O hook SessionStart (fase 7) é só do Claude Code. No Codex, entre com `poteto-mode` pelo nome ou coloque uma instrução fixa em `~/.codex/AGENTS.md`.

## Dependências

Nada é declarado em manifest. O que as skills usam:

- **Node 24** — runner externo, scripts da matriz, `check-plan.mjs` e a suíte de testes rodam TypeScript direto, sem build e sem Bun.
- **CLIs `claude`, `codex` e `grok`** — autenticados, só os que o sheet de modelos usa. O runner recusa provider igual ao do pai (essa lane é nativa).
- **`gh`** — forge padrão dos playbooks de PR e da skill `babysit`; `origin` é usado quando resolve o repositório; `gt` só no playbook Orchestrate.
- **`bun`** — só para `watch-pr` e `orch`, que vieram da Cursor como estão.
- **`jq` e `rg`** — só para `worktree-audit.sh` (playbook Worktree cleanup); sem eles o audit avisa e deixa colunas em branco.
- **`run`, `verify`, `loop`** — built-ins do Claude Code; **`skill-creator`** — skill oficial da Anthropic para autoria de SKILL.md. Os quatro têm substituto em `codex-tools.md`.

## Skills

Nomes curtos; no Claude Code cada uma aparece com o prefixo do plugin (`/pstack:poteto-mode`, quando instalado por manifest) e no Codex como `pstack:poteto-mode`.

| skill | quando usar |
| --- | --- |
| `poteto-mode` | ponto de entrada de qualquer tarefa não trivial: escolhe um playbook e roteia para as outras skills |
| `how` | entender como um subsistema funciona |
| `why` | evidência de por que algo foi construído assim, em paralelo pelos MCPs disponíveis |
| `architect` | assentar tipos e forma de módulo antes de código que cruza fronteira de função |
| `arena` | N tentativas paralelas da mesma coisa, depois enxertar as melhores partes |
| `swarm` | N workers paralelos em fatias ou corridas, um relatório agregado |
| `interrogate` | vários modelos tentando quebrar um design ou diff, com lente de qualidade de código |
| `automate-me` | rascunhar sua própria skill `-mode` a partir dos seus transcripts |
| `reflect` | capturar as lições de uma tarefa longa como edição de skill |
| `tdd` | corrigir bug escrevendo o teste que falha antes da correção |
| `typescript-best-practices` | aterrar a disciplina de tipos em sintaxe TypeScript |
| `teach` | entender de verdade uma mudança ou subsistema: `how` + `why` numa explicação só |
| `technical-writing` | docs, RFCs, readmes, descrições de PR e commits num padrão em camadas |
| `bro` | reafirmar a última mensagem em linguagem simples |
| `figure-it-out` | desenhar um playbook rigoroso quando nenhum embutido serve |
| `show-me-your-work` | trilha de decisões revisável em tsv |
| `blast-radius` | o que uma mudança pequena pode quebrar fora do diff, provado rodando código |
| `recall` | reconstruir o contexto recente de um tema a partir do histórico e do registro compartilhado |
| `setup-pstack` | escolher modelo por papel e effort por família; probe e escrita do sheet |
| `unslop` | limpar marcas de IA de qualquer prosa |
| `no-comments` | tirar comentários antes da revisão via o subagent `comment-sicko` |
| `create-verification-skill` | gerar uma skill de verificação local ao projeto com mapa de features |
| `maintain-verification-skill` | ressincronizar uma skill de verificação cujo mapa de features derivou |
| `deslop` | remover slop de IA do diff antes de commitar |
| `babysit` | acompanhar um PR isolado fora do `poteto-mode`: CI, comentários, merge-ready |
| `thermo-nuclear-code-quality-review` | auditoria de manutenibilidade extremamente estrita |
| `make-pr-easy-to-review` | limpar histórico e descrição de um PR antes da revisão |
| `fix-ci` | achar checks falhando, ler logs, aplicar correções focadas |
| `fix-merge-conflicts` | resolver conflitos de merge sem interação, validar, finalizar |
| `get-pr-comments` | buscar e resumir os comentários de revisão do PR ativo |
| `what-did-i-get-done` | resumir os commits de autoria própria num período |

Dentro do `poteto-mode`, pedidos de status de PR vão para o playbook Babysit, não para a skill `babysit`; a skill é a entrada standalone para um PR isolado.

## Princípios

Vinte e três skills de um princípio cada. `poteto-mode` indexa todas inline e lê a folha completa de cada princípio que aplica. Carregam `user-invocable: false`: ficam fora do menu `/`, o modelo continua podendo lê-las.

| princípio | grupo | regra |
| --- | --- | --- |
| `principle-laziness-protocol` | core | deleção e a menor mudança que resolve o problema |
| `principle-foundational-thinking` | core | tipos e estruturas de dados antes da lógica; o que atores concorrentes compartilham |
| `principle-redesign-from-first-principles` | core | redesenhar como se o requisito fosse fundacional, não bolt-on |
| `principle-attack-the-premise` | core | duas correções com a mesma premissa falharam o mesmo gate: questionar a premissa |
| `principle-subtract-before-you-add` | core | remover peso morto antes de construir sobre a base mais simples |
| `principle-minimize-reader-load` | core | contar camadas e estado oculto; colapsar wrappers de um chamador |
| `principle-outcome-oriented-execution` | core | convergir para a arquitetura alvo sem estados intermediários descartáveis |
| `principle-experience-first` | core | delícia do usuário acima de conveniência de implementação |
| `principle-exhaust-the-design-space` | core | dois ou três protótipos concorrentes antes de decidir |
| `principle-build-the-lever` | core | construir a ferramenta que faz ou prova o trabalho, não fazer à mão |
| `principle-model-the-domain` | architecture | codificar o domínio numa estrutura, não em condicionais espalhados |
| `principle-boundary-discipline` | architecture | guardas nas fronteiras, tipos internos confiáveis, lógica pura |
| `principle-type-system-discipline` | architecture | estados ilegais irrepresentáveis; parse na fronteira |
| `principle-make-operations-idempotent` | architecture | convergir para o mesmo estado final apesar de execuções parciais |
| `principle-migrate-callers-then-delete-legacy-apis` | architecture | migrar chamadores e apagar a API antiga na mesma onda |
| `principle-separate-before-serializing-shared-state` | architecture | eliminar o compartilhamento antes de serializar |
| `principle-prove-it-works` | verification | verificar no artefato real antes de declarar pronto |
| `principle-fix-root-causes` | verification | reproduzir, perguntar por quê até a causa, corrigir lá |
| `principle-sequence-verifiable-units` | verification | unidades pequenas que terminam em estado verificável, em ordem que se prova |
| `principle-test-behavior-not-implementation` | verification | chamar o código como o usuário e afirmar o resultado observável |
| `principle-guard-the-context-window` | delegation | volume vai para subagents; só resumos na thread principal |
| `principle-never-block-on-the-human` | delegation | agir, apresentar, deixar corrigir depois; confirmação só para o irreversível |
| `principle-encode-lessons-in-structure` | meta | codificar a regra como lint, flag, check ou script, não como mais texto |

## Subagents

- **`poteto-agent`** — roda o estilo inteiro a partir de um pai (`subagent_type: "poteto-agent"`). Lê `poteto-mode` por completo antes de trabalhar.
- **`comment-sicko`** — revisor de comentários, só leitura, que `no-comments` dispara. Renomeado de `Comment Sicko` para valer como `subagent_type`.
- **`pstack-<família>-<effort>`** — lanes nativas do Claude Code para cada família com `agentStem` na matriz (hoje `fable` e `opus`) em cada effort selecionável, geradas por `npm run agents:generate` e verificadas por `agents:check`. Não são fluxos de usuário; `provider-dispatch.md` as despacha a partir do papel configurado. No Codex não há arquivo: `spawn_agent` recebe `model` e `reasoning_effort`.

## Verificação

```shell
npm test               # matriz, gerador de agents, runner, referência de skills, invariantes do pacote
npm run matrix:check   # blocos gerados de provider-dispatch.md e setup-pstack em dia
npm run agents:check   # agents/pstack-*.md em dia com a matriz
npm run collision:check
```

`tests/skill-collision-repro.sh` verifica os invariantes estáticos do pacote (sem camada `commands/`, `principle-*` ocultos e legíveis pelo modelo, skills de fluxo sem `disable-model-invocation`, nome do diretório igual ao `name`, aliases móveis de Fable e Opus, vínculo do Bugbot entre a skill `babysit` e o playbook, playbooks sem comandos Graphite, conteúdo Cursor-only ausente). Com `PSTACK_BEHAVIORAL=1` ele também monta um plugin de uma skill e prova, com `claude -p`, que a invocação pela tool `Skill` e pelo `/comando` chegam à skill.

## O que ficou de fora

- **`skills/make-bot-ui`** — construída sobre rotinas, webhooks e UI da Cursor; não há mapeamento comum Claude Code / Codex.
- **`automations/benny/`** — pacote dormente de automações Slack sobre o runtime de eventos da Cursor. Não registrava skills nem no original.
- **`docs/guide/`** — tutorial de dez capítulos que ensina pstack pela UI da Cursor, sticky mode e cloud agents (2,3 MB de imagens). Leia no original em [cursor/plugins/pstack/docs/guide](https://github.com/cursor/plugins/tree/main/pstack/docs/guide); os conceitos mapeiam pela tabela de substituições de `CHANGES.md`.
- **Sticky mode** — frontmatter `mode`/`icon`/`color`/`reminder` só da Cursor. O análogo é o hook SessionStart da fase 7.
- **Resto do `cursor-team-kit`** — `control-cli`/`control-ui` viraram `run`/`verify`; `verify-this` e `check-compiler-errors` duplicam built-ins; `loop-on-ci`, `review-and-ship`, `weekly-review` sobrepõem `babysit`, `fix-ci`, `make-pr-easy-to-review` e `what-did-i-get-done`; `pr-review-canvas` é UI da Cursor.
- **`README.md` da Cursor** — substituído por um README do port; o original está no histórico (`git show 91e5b82:README.md`) e no upstream.

## Licença

MIT. Três arquivos de licença preservados: [`LICENSE`](../LICENSE) (pstack, Lauren Tan), [`LICENSE-open-pstack`](../LICENSE-open-pstack) (open-pstack, Eric Litman) e [`LICENSE-cursor-team-kit`](../LICENSE-cursor-team-kit) (Cursor; cobre `deslop`, `thermo-nuclear-code-quality-review`, `make-pr-easy-to-review`, `fix-ci`, `fix-merge-conflicts`, `get-pr-comments` e `what-did-i-get-done`).

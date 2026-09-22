# pstack-vic — referência técnica

pstack-vic é um port autoral do [pstack](https://github.com/cursor/plugins/tree/main/pstack) de Lauren Tan ([@poteto](https://x.com/poteto)) para Claude Code e Codex. Uma única árvore de skills serve os dois pais. Os modelos de cada papel vêm de uma matriz como dado (`model-matrix.json`), não de constantes espalhadas pelas skills.

Conteúdo sincronizado com Cursor pstack **0.15.2** (`5bf2b15`) e com open-pstack **1.4.1** (`de67e6b`). O contrato de sync está em [`UPSTREAM.md`](../UPSTREAM.md), a proveniência de cada arquivo em [`NOTICE.md`](../NOTICE.md) e o veredito de cada mudança em [`CHANGES.md`](../CHANGES.md).

> if you want to go fast, go deep first.

## Instalação

O plugin é a raiz deste repositório. Ele se instala por marketplace a partir de uma tag (`vX.Y.Z`), nunca de `main`: no Claude Code a entrada do marketplace fixa a tag (`ref`); no Codex o `--ref` fixa o snapshot inteiro.

### Claude Code

```text
/plugin marketplace add byvict/pstack-vic
/plugin install pstack@pstack-vic
```

No shell, `claude plugin marketplace add byvict/pstack-vic` e `claude plugin install pstack@pstack-vic`. As skills aparecem com o prefixo do plugin (`/pstack:poteto-mode`).

O hook SessionStart (`hooks/hooks.json`, em startup, `/clear` e pós-compact) injeta o mandato de `hooks/session-start-context.md`: tarefa de engenharia não trivial entra por `pstack:poteto-mode`; a skill completa só carrega quando invocada; subagents despachados ignoram o bloco; `CLAUDE.md`, `AGENTS.md` e pedidos diretos têm precedência. Para desligar o auto-fire, apague `hooks/hooks.json` da cópia instalada em `~/.claude/plugins/cache/pstack-vic/pstack/<versão>/`; a próxima atualização o restaura.

### Codex

```shell
codex plugin marketplace add byvict/pstack-vic --ref v0.1.4
codex plugin add pstack@pstack-vic
```

O Codex descobre as skills sob o namespace `pstack` (`pstack:poteto-mode`, `pstack:tdd`…), que vem de `.codex-plugin/plugin.json`; os `principle-*` também aparecem, porque `user-invocable: false` é do Claude Code. Não há hook no Codex: entre com `pstack:poteto-mode` pelo nome ou coloque uma instrução fixa em `~/.codex/AGENTS.md`. Para as skills que fazem fan-out (`interrogate`, `arena`, `how`, `why`, `reflect`, `architect`, `swarm`), ligue subagents em `~/.codex/config.toml`; sem isso a lane nativa do Codex vira dropout nomeado e as lanes externas seguem:

```toml
[features]
multi_agent = true

[sandbox_workspace_write]
network_access = true
writable_roots = ["/Users/<você>/.grok"]
```

As duas linhas de `sandbox_workspace_write` são para as lanes externas: o runner roda dentro do seatbelt do Codex, e as CLIs `claude` e `grok` precisam de rede; o `grok` ainda grava a sessão em `~/.grok`, que o seatbelt bloqueia. Sem elas a lane Grok cai como dropout com receipt (`unavailable-model`, `FS_PERMISSION_DENIED`). Dentro do seatbelt o runner passa `--sandbox none` ao Grok, porque um seatbelt aninhado não inicializa; o sandbox do Codex continua valendo. Os valores também podem ir por sessão com `-c`.

### A partir do clone

Para desenvolver ou testar um checkout antes de publicar:

```shell
# Claude Code: carrega o clone como plugin da sessão (manifest, hook, agents e skills)
claude --plugin-dir ~/Dev/Skills/pstack-vic
```

```shell
# Codex: marketplace local, sem tag; desfaz com plugin remove + marketplace remove
codex plugin marketplace add ~/Dev/Skills/pstack-vic
codex plugin add pstack@pstack-vic
```

Rode `/setup-pstack` uma vez em cada pai para escrever o sheet de modelos (`~/.claude/pstack-models.md` e `~/.codex/pstack-models.md`). Depois, `/poteto-mode` é o ponto de entrada para qualquer tarefa que peça rigor.

### Publicar uma versão

A versão do pstack-vic é independente das versões dos upstreams ([`UPSTREAM.md`](../UPSTREAM.md)). Ela vive em quatro lugares que `npm test` obriga a concordar: `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json` (`version` e `ref: vX.Y.Z`) e `package.json`. Publicar é subir a versão nos quatro, `npm test`, commit, `git tag vX.Y.Z` e `git push origin main vX.Y.Z`. Nunca `git push --tags`: os remotes `cursor` e `open` são só leitura (`tagOpt --no-tags`) e este repo não reexporta tags deles.

## Layout

```text
.
├── .claude-plugin/                   # plugin.json (manifest do Claude Code) e marketplace.json (um plugin, fonte fixada na tag)
├── .codex-plugin/plugin.json         # manifest do Codex (skills: ./skills/, interface com logo)
├── .agents/plugins/marketplace.json  # marketplace do Codex (fonte local ./)
├── hooks/                            # SessionStart do Claude Code: hooks.json, run-hook.cmd (polyglot), session-start, session-start-context.md
├── model-matrix.json                 # famílias, efforts, pais, rota por pai, papéis (dado canônico)
├── scripts/                          # loader/validação da matriz, render dos blocos gerados, gerador de agents, digest semanal dos upstreams, testes (inclui manifests.test.ts)
├── skills/                           # 54 skills compartilhadas por Claude Code e Codex
│   ├── poteto-mode/references/       # provider-dispatch.md (rota e papéis), codex-tools.md (mapa de tools), bugbot-triage.md
│   ├── poteto-mode/scripts/          # runner externo (Node 24), watch-pr, orch, check-plan.mjs, worktree-audit.sh
│   └── setup-pstack/scripts/         # setup-pstack.ts: estado, plano, probe, atestado e escrita do sheet (Node 24)
├── agents/                           # poteto-agent, comment-sicko e as lanes nativas pstack-<família>-<effort> geradas da matriz
├── assets/                           # logo
├── docs/reference.md                 # esta referência
├── tests/skill-collision-repro.sh    # invariantes do pacote de skills (estático) e prova de invocação no Claude Code (opcional)
├── LICENSE                           # pstack (Lauren Tan), MIT
├── LICENSE-open-pstack               # open-pstack (Eric Litman), MIT
├── LICENSE-cursor-team-kit           # cursor-team-kit (Cursor), MIT
├── LICENSE-superpowers               # superpowers (Jesse Vincent), MIT: hooks/run-hook.cmd
├── NOTICE.md · UPSTREAM.md · CHANGES.md
└── package.json                      # versão do plugin; npm test, matrix:check, agents:check, collision:check, upstream:digest, setup-pstack
```

## Rodar no Codex

Nada é gerado nem bifurcado por pai. Duas referências fazem a tradução em tempo de execução: [`codex-tools.md`](../skills/poteto-mode/references/codex-tools.md) mapeia tools e built-ins do Claude Code (`Agent` → `spawn_agent`, `AskUserQuestion`, `run`, `verify`, `loop`, `skill-creator`) e [`provider-dispatch.md`](../skills/poteto-mode/references/provider-dispatch.md) mapeia famílias de modelo para a rota certa em cada pai. As skills que citam um primitivo do Claude Code carregam uma nota de plataforma de uma linha apontando para o mapa.

- **Invocação.** O Codex carrega `SKILL.md` nativamente; não há tool `Skill`. Peça a skill pelo nome.
- **Rota de modelos.** Quem é pai escolhe a rota. No Claude Code, Fable e Opus rodam em agents nativos e Sol, Astra e Grok no runner externo. No Codex, Sol e Astra rodam em `spawn_agent` e Fable, Opus e Grok no runner. Um filho nunca escolhe provider nem troca de rota por conta própria; lane indisponível vira dropout nomeado, nunca substituição silenciosa.
- **Papéis.** As skills citam papéis (`arena runners`, `bug-fix`, `how explainer`…), não descritores. O default de cada papel, por pai, está na seção *Role defaults* de `provider-dispatch.md` e é o que `/setup-pstack` escreve no sheet.
- **Auto-fire.** O hook SessionStart (`hooks/`) é só do Claude Code. No Codex, entre com `pstack:poteto-mode` pelo nome ou coloque uma instrução fixa em `~/.codex/AGENTS.md`.

## Dependências

Nada é declarado em manifest. O que as skills usam:

- **Node 24** — runner externo, scripts da matriz, `check-plan.mjs` e a suíte de testes rodam TypeScript direto, sem build e sem Bun.
- **CLIs `claude`, `codex` e `grok`** — autenticados, só os que o sheet de modelos usa. O runner recusa provider igual ao do pai (essa lane é nativa).
- **`CURSOR_API_KEY`** — só para o provider `cursor` (lanes http na API de cloud agents da Cursor; famílias da tabela gerada em `provider-dispatch.md`). Sem a variável a lane cai como dropout `unavailable-cli` (exit 69). Lanes http exigem `--repo` e `--pr`; veja a seção *HTTP lanes* de `provider-dispatch.md`.
- **`gh`** — forge padrão dos playbooks de PR e da skill `babysit`; `origin` é usado quando resolve o repositório; `gt` só no playbook Orchestrate.
- **`bun`** — só para `watch-pr` e `orch`, que vieram da Cursor como estão.
- **`jq` e `rg`** — só para `worktree-audit.sh` (playbook Worktree cleanup); sem eles o audit avisa e deixa colunas em branco.
- **`run`, `verify`, `loop`** — built-ins do Claude Code; **`skill-creator`** — skill oficial da Anthropic para autoria de SKILL.md. Os quatro têm substituto em `codex-tools.md`.

## Probes HTTP

Quando o plano de setup contém um par HTTP, `probe` recebe o PR autorizado em `--repo <owner/name> --pr <number>`. Os dois argumentos são obrigatórios nesse caso. Um plano sem pares HTTP recusa esses argumentos. O destino vale para essa execução e não fica salvo no plano nem no sheet. Em um plano misto, somente os filhos HTTP recebem o destino.

```shell
npm run setup-pstack -- probe --dir <dir> --repo <owner/name> --pr <number>
```

O provider Cursor requer `CURSOR_API_KEY` e acesso de leitura ao remoto Git. O recibo registra `remote.heads` como `not-taken`, `unverified` com motivo ou `observed` com `changedBranches`. A comparação observa branches adicionadas, movidas ou removidas durante a execução. Ela não identifica quem fez essas alterações. Uma lane read-only falha se houver alteração observada ou se a comparação não puder ser concluída. A seção [HTTP lanes](../skills/poteto-mode/references/provider-dispatch.md#http-lanes) define o contrato completo do recibo.

## Converge

O [playbook Converge](../skills/poteto-mode/playbooks/converge.md) conduz um PR pronto até o merge, com veredito independente. Babysit continua até merge-ready e Shipping cuida das stacks. O [contrato Converge](../skills/poteto-mode/references/converge-contract.md) define evidências, prompts, publicação e recuperação.

```shell
node skills/poteto-mode/scripts/converge/converge-reconcile --repo Clinextapp/clinext --pr <n> --config .cursor/converge.json --output <relatorio-unico.json>
node skills/poteto-mode/scripts/converge/converge-arm --repo Clinextapp/clinext --pr <n> --head <sha-completo> --verdict VERIFIED --dry-run
```

Os comandos usam Node 24, `gh` e `git`, sem checkout local do repositório alvo. O reconciliador lê o contrato fixado no trunk e preserva uma identidade nova por execução. O dry-run faz as leituras reais e falha quando falta algum requisito. `prepare-lane.ts` prepara prompts completos e manifests exclusivos; `publish.ts` admite recibos e bytes de artefatos antes de calcular o veredito. Veja os argumentos e formatos no contrato. O modo `verdict-only` publica status de erro mesmo quando a prova passa, sem autorização de merge.

O harness de prova D é `converge-proof`. Ele planta PRs descartáveis a partir de um catálogo pai, chama C em `verdict-only` e pontua papéis cegos no corpus histórico. Não há um segundo redutor: o publicador de C continua sendo o único autor do comentário e do status.

```shell
node skills/poteto-mode/scripts/converge/converge-proof run --repo Clinextapp/clinext --work-root <checkout-isolado> --evidence <privado> --pool-observation <auditoria-root> --repository-epoch <epoch-root> --parent codex --verifier cursor:composer-2.5@high --reviewer cursor:grok-4.7@high
# exit 20; JSON kind=end-turn com continuation e publicação ou uncertain
node skills/poteto-mode/scripts/converge/converge-proof run --resume <run.json> --after-turn <observacao-do-host> --pool-observation <auditoria-root>
node skills/poteto-mode/scripts/converge/converge-proof judge --repo Clinextapp/clinext --work-root <patient-work> --evidence <privado> --pool-observation <auditoria-root> --carrier-pr <numero> --carrier-head <sha> --parent codex --verifier cursor:composer-2.5@high --reviewer cursor:grok-4.7@high
```

`run` avança um caso até a publicação e devolve `end-turn`. O dono da publicação envia a mensagem final naquele turno. O host raiz retém o handle nativo, observa o evento terminal real, grava owner + turno + fronteira + identidade da publicação, e só então dispara o turno seguinte com `--after-turn`. Reinício de processo, UUID, atraso ou o próprio dono atestando o turno anterior não fecham o turno. Estados `preparing`, `collecting` e `publication-uncertain` retomam sem essa observação. Se a recuperação chama o publicador de C e ele devolve `mustEndTurn`, aquele turno também termina. Uma closure não autoriza uma publicação nova nem a limpeza que viria depois.

A retomada final, depois da última limpeza, imprime dez linhas `entry <id>: expected <veredito>, got <veredito>, ok, complete-pass yes|no` e os totais de custo. Exit 0 exige `complete-pass yes` em cada entrada, as lanes selecionadas, a limpeza das refs próprias e custos mensuráveis. `CI-only` é o `displayResult` de docs; o veredito de máquina segue `VERIFIED`. O bump de dependência autorado por humano permanece humano e em modo full.

A limpeza confirma repo/PR/ref/head, checkout/origin, o hold, auto-merge desligado, leitores remotos terminais e o epoch exclusivo emitido pelo root. Ela fecha o PR, lê de volta o estado `CLOSED` e executa `git -C <work-root> push origin --delete <ref>` depois de uma leitura imediata do head remoto. Head que se moveu, PR `MERGED`, dono ambíguo ou recusa do guard mantêm a branch e relatam limpeza bloqueada. O hook de force não é alterado.

`judge` pontua os 15 records do corpus por papel, sem deduplicar PRs repetidos. Admissão histórica exige recibo original, ferramenta de checkout/readback, artefato baixado e envelope final em que `observedCarrierHead`, `observedHead` e `observedBase` batem com a tupla esperada. Um envelope que repete o head histórico no campo do carrier é rejeitado, mesmo com evidência de checkout correta; o custo da tentativa conta e o papel não marca ponto. Corpo histórico permanece indisponível.

Uso suplementar vem de `GET https://api.cursor.com/v1/agents/{agentId}/usage?runId={runId}` ao lado do recibo original, que permanece com `usage` nulo. Cache-write diferente de zero sem tabela autorizada torna o custo indisponível. O pool é uma observação de dashboard do root, válida por 30 minutos, com percentuais entre 0 e 100 e limite fixo de 80%. Cada leitura é copiada para evidência imutável. Expiração ou 80% interrompe lançamentos novos, mas permite recuperar publicação, drenar leitores e limpar recursos já criados. Testes de fixture não substituem prova ao vivo.

## Skills

Nomes curtos; no Claude Code cada uma aparece com o prefixo do plugin (`/pstack:poteto-mode`) e no Codex como `pstack:poteto-mode`.

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
| `setup-pstack` | escolher modelo e effort por papel (a mesma família pode rodar em efforts diferentes em papéis diferentes); probe de cada par família+effort e escrita do sheet pelo `scripts/setup-pstack.ts` (rerun byte-idêntico, nada escrito se um probe falha) |
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
npm test               # matriz, gerador de agents, runner, setup-pstack, referência de skills, manifests e hook, digest dos upstreams, invariantes do pacote
npm run matrix:check   # blocos gerados de provider-dispatch.md e setup-pstack em dia
npm run agents:check   # agents/pstack-*.md em dia com a matriz
npm run collision:check
npm run upstream:digest -- --no-fetch   # digest dos dois upstreams desde o ponto de sync (UPSTREAM.md, seção Digest semanal)
npm run setup-pstack -- --help   # subcomandos do setup: state, plan, probe, attest, write
claude plugin validate --strict .   # manifest do plugin e do marketplace pelo validador do Claude Code
```

`tests/skill-collision-repro.sh` verifica os invariantes estáticos do pacote (sem camada `commands/`, `principle-*` ocultos e legíveis pelo modelo, skills de fluxo sem `disable-model-invocation`, nome do diretório igual ao `name`, versão única entre manifests, tag do marketplace e `package.json`, logo do Codex resolvendo, aliases móveis de Fable e Opus, vínculo do Bugbot entre a skill `babysit` e o playbook, playbooks sem comandos Graphite, conteúdo Cursor-only ausente). Com `PSTACK_BEHAVIORAL=1` ele também monta um plugin de uma skill e prova, com `claude -p`, que a invocação pela tool `Skill` e pelo `/comando` chegam à skill.

## O que ficou de fora

- **`skills/make-bot-ui`** — construída sobre rotinas, webhooks e UI da Cursor; não há mapeamento comum Claude Code / Codex.
- **`automations/benny/`** — pacote dormente de automações Slack sobre o runtime de eventos da Cursor. Não registrava skills nem no original.
- **`docs/guide/`** — tutorial de dez capítulos que ensina pstack pela UI da Cursor, sticky mode e cloud agents (2,3 MB de imagens). Leia no original em [cursor/plugins/pstack/docs/guide](https://github.com/cursor/plugins/tree/main/pstack/docs/guide); os conceitos mapeiam pela tabela de substituições de `CHANGES.md`.
- **Sticky mode** — frontmatter `mode`/`icon`/`color`/`reminder` só da Cursor. O análogo é o hook SessionStart em `hooks/`.
- **Resto do `cursor-team-kit`** — `control-cli`/`control-ui` viraram `run`/`verify`; `verify-this` e `check-compiler-errors` duplicam built-ins; `loop-on-ci`, `review-and-ship`, `weekly-review` sobrepõem `babysit`, `fix-ci`, `make-pr-easy-to-review` e `what-did-i-get-done`; `pr-review-canvas` é UI da Cursor.
- **`README.md` da Cursor** — substituído por um README do port; o original está no histórico (`git show 91e5b82:README.md`) e no upstream.

## Licença

MIT. Quatro arquivos de licença preservados: [`LICENSE`](../LICENSE) (pstack, Lauren Tan), [`LICENSE-open-pstack`](../LICENSE-open-pstack) (open-pstack, Eric Litman), [`LICENSE-cursor-team-kit`](../LICENSE-cursor-team-kit) (Cursor; cobre `deslop`, `thermo-nuclear-code-quality-review`, `make-pr-easy-to-review`, `fix-ci`, `fix-merge-conflicts`, `get-pr-comments` e `what-did-i-get-done`) e [`LICENSE-superpowers`](../LICENSE-superpowers) (Jesse Vincent; cobre `hooks/run-hook.cmd`).

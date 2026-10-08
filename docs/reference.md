# pstack-vic — referência técnica

pstack-vic é um port autoral do [pstack](https://github.com/cursor/plugins/tree/main/pstack) de Lauren Tan ([@poteto](https://x.com/poteto)) para Claude Code, Codex e Grok Build. Uma única árvore de skills serve os três pais. Os modelos de cada papel vêm de uma matriz como dado (`model-matrix.json`), não de constantes espalhadas pelas skills.

Esta referência concentra configuração, ferramentas e contratos. O [guia de uso](guide/README.md) ensina os fluxos com exemplos; o [README](../README.md) apresenta o projeto e o início rápido.

Skills e playbooks sincronizados com Cursor pstack **0.15.10** (`4e5b1cf`) e com open-pstack **1.4.1** (`de67e6b`). O guia tem [origem e atualização próprias](../UPSTREAM.md#guia-de-uso). O contrato de sync está em [`UPSTREAM.md`](../UPSTREAM.md), a proveniência de cada arquivo em [`NOTICE.md`](../NOTICE.md) e o veredito de cada mudança em [`CHANGES.md`](../CHANGES.md).

> if you want to go fast, go deep first.

## Instalação

O plugin é a raiz deste repositório. Ele se instala por marketplace a partir de uma tag (`vX.Y.Z`), nunca de `main`: no Claude Code a entrada do marketplace fixa a tag (`ref`); no Codex o `--ref` fixa o snapshot inteiro.

### Claude Code

```text
/plugin marketplace add byvict/pstack-vic
/plugin install pstack@pstack-vic
```

No shell, `claude plugin marketplace add byvict/pstack-vic` e `claude plugin install pstack@pstack-vic`. As skills aparecem com o prefixo do plugin (`/pstack:poteto-mode`).

`poteto-mode` é um modo que você liga com `/pstack:poteto-mode`. A skill tem `disable-model-invocation: true`, como no original da Cursor, então o modelo não entra nela sozinho, nem num bug fix. O plugin não registra hook. Até a 0.1.4, um hook SessionStart copiado do open-pstack mandava toda tarefa de engenharia não trivial entrar por `poteto-mode`; saiu na 0.1.5 ([`CHANGES.md`](../CHANGES.md)).

As outras skills de fluxo entram quando você as nomeia ou quando um fluxo pstack ativo as chama. As descrições expressam esse limite; elas continuam disponíveis para a ferramenta `Skill` do Claude Code. `setup-pstack` e `poteto-help` podem carregar por pedidos comuns.

### Codex

```shell
codex plugin marketplace add byvict/pstack-vic --ref v0.5.26
codex plugin add pstack@pstack-vic
```

O Codex descobre as skills sob o namespace `pstack` (`pstack:poteto-mode`, `pstack:tdd`…), que vem de `.codex-plugin/plugin.json`; os `principle-*` também aparecem, porque `user-invocable: false` é do Claude Code. As skills de fluxo entram por nome ou quando um fluxo pstack ativo as chama. Seus arquivos `agents/openai.yaml` desligam a descoberta implícita (`allow_implicit_invocation: false`); o roteador lê o arquivo da skill chamada. `setup-pstack` e `poteto-help` continuam disponíveis por pedidos comuns. Para as skills que fazem fan-out (`interrogate`, `arena`, `how`, `why`, `reflect`, `architect`, `swarm`), ligue subagents em `~/.codex/config.toml`. Quando faltam ferramentas nativas ou vagas, o coordenador pode usar uma sessão nova do mesmo provedor pelo runner, preservando modelo e esforço. A alternativa precisa atender às ferramentas e ao isolamento da tarefa; siga [Provider dispatch](../skills/poteto-mode/references/provider-dispatch.md#when-native-dispatch-is-unavailable). Uma tarefa sem rota válida fica como lacuna:

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

No Claude Code, este comando carrega o clone como plugin da sessão (manifest, agents e skills):

```shell
claude --plugin-dir ~/Dev/Skills/pstack-vic
```

No Codex, estes dois comandos instalam o clone por um marketplace local, sem tag:

```shell
codex plugin marketplace add ~/Dev/Skills/pstack-vic
codex plugin add pstack@pstack-vic
```

Para desfazer no Codex, rode `codex plugin remove pstack@pstack-vic` e depois `codex plugin marketplace remove pstack-vic`.

Rode `/setup-pstack` uma vez em cada pai para escrever o sheet de modelos (`~/.claude/pstack-models.md` e `~/.codex/pstack-models.md`). Com `CLAUDE_CONFIG_DIR` ou `CODEX_HOME` definido, o sheet, o ledger de probes e a integração vão para esse diretório (um `CODEX_HOME` vazio conta como não definido; um `CLAUDE_CONFIG_DIR` vazio para o script, porque o Claude Code 2.1.289 então lê o `settings.json` e o `CLAUDE.md` da pasta onde abriu), e `authorize.ts` confere o `settings.json` ou o `config.toml` de lá ([Harness config homes](../skills/poteto-mode/references/codex-tools.md#harness-config-homes)). O último passo dele confere a [autorização permanente](#autorização-permanente), que o autopilot e o playbook Shipping exigem para mergear sem aprovação humana. Depois, `/poteto-mode` é o ponto de entrada para qualquer tarefa que peça rigor.

### Publicar uma versão

A versão do pstack-vic é independente das versões dos upstreams ([`UPSTREAM.md`](../UPSTREAM.md)). Ela vive em quatro lugares que `npm test` obriga a concordar: `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json` (`version` e `ref: vX.Y.Z`) e `package.json`. O `--ref vX.Y.Z` do README e desta página acompanha. Publicar é subir a versão nos quatro, rodar `npm test` e mergear o PR. Depois do merge faltam dois passos: a tag, que o CI cria, e a troca do plugin nos dois pais, que é um comando no Mac.

A tag sai pelo CI. Em cada push na `main`, depois que o job `test` passa, o job `tag` de [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) lê a versão do `package.json`, cria a tag `vX.Y.Z` no commit do merge e empurra só ela. Se a tag já existe no GitHub, ele não faz nada, então um merge que não sobe a versão não muda tag nenhuma. Se o job falhar, rode-o de novo (`gh run rerun <id do run> --failed`) ou crie a tag à mão com `git tag vX.Y.Z <commit do merge>` e `git push origin refs/tags/vX.Y.Z`. Nunca use `git push --tags`. Os remotes `cursor` e `open` são só leitura (`tagOpt --no-tags`), e este repo não reexporta as tags deles.

Trocar o plugin nos dois pais é um comando. Nenhum CI alcança `~/.claude` e `~/.codex`, então esse passo roda no Mac, no checkout principal:

```shell
git pull --ff-only
node scripts/release.ts
```

O script confere antes de mexer. Ele roda `git fetch origin` e recusa se o `HEAD` não for a ponta da `origin/main`. Depois procura a tag `vX.Y.Z` no GitHub. Se o CI ainda não a criou, o script sai com erro e manda olhar `gh run list -R byvict/pstack-vic --branch main --limit 1`. Nas duas recusas ele não toca em nada. Com a tag no lugar, ele atualiza o Claude Code (`claude plugin marketplace update pstack-vic` e `claude plugin update pstack@pstack-vic`) e lê de volta a versão instalada. Só então troca o Codex, que fixa o marketplace numa tag e por isso precisa de quatro comandos: `plugin remove`, `marketplace remove`, `marketplace add byvict/pstack-vic --ref vX.Y.Z` e `plugin add`. Antes da troca ele copia `~/.codex/config.toml` para `config.toml.pre-X.Y.Z`.

Cada passo confere o que já foi feito, então rodar o script duas vezes não estraga nada. Ele pula um pai que já está na versão, continua de onde parou uma troca do Codex interrompida e deixa como está a primeira cópia do `config.toml`. Em qualquer falha, o script sai com código 1. Se a troca do Codex parar no meio, o Codex pode ficar sem o plugin. Rode o script de novo para terminar, ou volte ao que havia antes com a linha que ele imprime: `cp ~/.codex/config.toml.pre-X.Y.Z ~/.codex/config.toml && codex plugin add pstack@pstack-vic`.

## Layout

```text
.
├── .claude-plugin/                   # plugin.json (manifest do Claude Code) e marketplace.json (um plugin, fonte fixada na tag)
├── .codex-plugin/plugin.json         # manifest do Codex (skills: ./skills/, interface com logo)
├── .agents/plugins/marketplace.json  # marketplace do Codex (fonte local ./)
├── .github/workflows/ci.yml          # CI de cada PR e de cada push na main: o job test é o check obrigatório; depois dele, na main, o job tag cria a tag vX.Y.Z do package.json se ela ainda não existe
├── .github/dependabot.yml            # Dependabot: sobe as actions fixadas por SHA num PR semanal agrupado (prefixo ci), só com versões publicadas há 7 dias ou mais
├── model-matrix.json                 # famílias, efforts, pais, rota por pai, papéis (dado canônico)
├── scripts/                          # loader/validação da matriz, render dos blocos gerados, gerador de agents, digest semanal dos upstreams, upstream-parity.ts (a paridade dos playbooks do autopilot e do Why), release.ts (troca o plugin nos dois pais depois do merge), testes (inclui manifests.test.ts)
├── skills/                           # 59 skills compartilhadas por Claude Code e Codex
│   ├── poteto-mode/agents/           # openai.yaml: no Codex, poteto-mode só por invocação explícita
│   ├── poteto-mode/references/       # provider-dispatch.md (rota e papéis), codex-tools.md (mapa de tools), bugbot-triage.md, upstream-substitutions.json (as adaptações de plataforma dos playbooks e do Why)
│   ├── poteto-mode/scripts/          # runner externo (Node 24, com probe-lane.ts, a sonda de uma lane), watch-pr, orch, check-plan.mjs, worktree-audit.sh
│   ├── setup-pstack/scripts/         # setup-pstack.ts: estado, plano, probe, atestado e escrita do sheet, e a escolha de uma lane de um papel de pool (Node 24); authorize.ts: a autorização permanente (autopilot e Shipping)
│   └── update-clis/                  # scripts/update-clis.ts (check, notes, install, probe) e references/cli-touchpoints.json
├── agents/                           # poteto-agent, comment-sicko e, gerados da matriz, as lanes nativas pstack-<família>-<effort> e os Donos pstack-owner-<família>-<effort>
├── hooks/                            # hooks.json e agent-guard.mjs: a trava que recusa os agentes embutidos do Claude Code quando um agente do pstack os chama
├── assets/                           # logo
├── docs/guide/                       # guia de uso adaptado, dez capítulos e ilustrações
├── docs/reference.md                 # esta referência técnica
├── docs/adr/                         # decisões registradas (ADRs); o 0005 aposenta o fluxo antigo
├── docs/arquivo/                     # documentos do fluxo antigo, só história
├── CONTEXT.md                        # glossário do autopilot (Raiz, Dono, Enxame, Veredito, Rodada, Tick)
├── tests/skill-collision-repro.sh    # invariantes do pacote de skills (estático) e prova de invocação no Claude Code (opcional)
├── LICENSE                           # pstack (Lauren Tan), MIT
├── LICENSE-open-pstack               # open-pstack (Eric Litman), MIT
├── LICENSE-cursor-team-kit           # cursor-team-kit (Cursor), MIT
├── NOTICE.md · UPSTREAM.md · CHANGES.md
└── package.json                      # versão do plugin; npm test, test:bun, matrix:check, agents:check, collision:check, upstream:digest, setup-pstack, update-clis
```

## Rodar no Codex

Nada é gerado nem bifurcado por pai. As referências fazem a tradução em tempo de execução: [`codex-tools.md`](../skills/poteto-mode/references/codex-tools.md) mapeia tools e built-ins do Claude Code (`Agent` → `spawn_agent`, `AskUserQuestion`, `run`, `verify`, `loop`, `skill-creator`) e [`provider-dispatch.md`](../skills/poteto-mode/references/provider-dispatch.md) mapeia famílias de modelo para a rota certa em cada pai. As skills que citam um primitivo do Claude Code carregam uma nota de plataforma de uma linha apontando para o mapa.

- **Invocação.** O Codex carrega `SKILL.md` nativamente; não há tool `Skill`. Peça a skill pelo nome.
- **Rota de modelos.** Quem é pai escolhe a rota. No Claude Code, Fable e Opus rodam em agents nativos e Sol, Astra e Grok no runner externo. No Codex, Sol e Astra rodam em `spawn_agent` e Fable, Opus e Grok no runner. Um filho nunca escolhe provider nem troca de rota por conta própria; lane indisponível vira dropout nomeado, nunca substituição silenciosa.
- **Papéis.** As skills citam papéis (`arena runners`, `bug-fix`, `how explainer`…), não descritores. O default de cada papel, por pai, está na seção *Role defaults* de `provider-dispatch.md` e é o que `/setup-pstack` escreve no sheet.
- **Revisão cruzada.** Dois papéis são pools: listas das quais roda uma lane só, na ordem do operador. O `trail reviewer pool` revisa a trilha de decisões com uma Família diferente da raiz; outros provedores autores continuam elegíveis, em um contexto novo de revisão. Família é o fornecedor (Claude, Codex, Grok); trocar Sol por Astra ou trocar de aplicativo não muda a Família. A seleção vem de `setup-pstack.ts pick`. Se a lane falha, tenta-se a próxima elegível com o modelo e esforço configurados. Sem revisão concluída, a entrega informa revisão pendente, não uma dispensa. A regra da trilha pertence a `show-me-your-work`, conforme o [ADR 0007](adr/0007-revisor-da-trilha-de-outra-familia-da-raiz.md). O `arena cross-judge pool` conserva suas exclusões de autores e os fallbacks próprios de Arena, descritos em `provider-dispatch.md` e na skill Arena.
- **Entrada.** `poteto-mode` não dispara sozinho em nenhum pai: `disable-model-invocation: true` no Claude Code, `allow_implicit_invocation: false` no Codex. Entre com `/pstack:poteto-mode` ou `pstack:poteto-mode` pelo nome.

## Grok como raiz no T3 Code

Grok Build é o terceiro pai. O [mapa de ferramentas Grok](../skills/poteto-mode/references/grok-tools.md) cobre filhos nativos, owners, esperas, cancelamento, permissões e a retomada do autopilot. Claude e Codex vão pelo runner com `--parent grok`. O setup guarda sheet e probes em `~/.grok`, com um bloco em `~/.grok/AGENTS.md`. Os agents gerados fixam modelo e esforço; o frontmatter das skills não faz essa seleção.

O fluxo raiz → owner → helper exige `[subagents] max_depth = 2` ou maior no `~/.grok/config.toml` e uma sessão reiniciada. O setup exige os IDs dos dois níveis e o marcador observado antes de gravar a configuração.

Numa raiz Grok o autopilot usa um monitor (`grok-audit-ticker.ts`) para emitir o Tick de auditoria a cada hora. O scheduler do Grok executa filhos destacados e não substitui a auditoria da raiz. Uma sessão encerrada precisa ser retomada pelo operador, com os handles reconciliados.

## Dependências

Nada é declarado em manifest. O que as skills usam:

- **Git** — branches, worktrees, diffs e rebases dos playbooks.
- **Node 24** — o runner externo, os scripts da matriz, o `check-plan.mjs` e o `npm test` rodam TypeScript direto, sem build e sem Bun.
- **CLIs `claude`, `codex` e `grok`** — autenticados, só os que o sheet de modelos usa. O pai prefere lanes nativas e pode usar o runner do mesmo provedor quando a rota nativa não atende à tarefa. A versão delas muda só pela skill `update-clis` (seção [Versões das CLIs](#versões-das-clis)).
- **`gh`** — forge padrão dos playbooks; quando Origin está disponível e resolve o repositório, os playbooks seguem essa rota. `gt` só no playbook Orchestrate. A skill `update-clis` também usa `gh` para ler as releases do codex.
- **`lsof`** — só para `update-clis`, que o usa para saber se alguém está rodando a CLI que ela trocaria.
- **`bun`** — para `watch-pr` e `orch`, originados na Cursor, e para os testes deles e o typecheck do `watch-pr` (`npm run test:bun`). O watcher conserva observações adicionais de admissão, sem acrescentar gates: single/stack retornam readiness upstream; `--queued-stack` espera o merge efetivo. `LANDING` pode informar unknown, falha ou remoção mesmo com `READY`. A decisão e os limites estão no [ADR 0006](adr/0006-watcher-observa-admissao-sem-gates-extras.md).
- **`jq` e `rg`** — só para `worktree-audit.sh` (playbook Worktree cleanup); sem eles o audit avisa e deixa colunas em branco.
- **`run`, `verify`, `loop`** — built-ins do Claude Code; **`skill-creator`** — skill oficial da Anthropic para autoria de SKILL.md. Os quatro têm substituto em `codex-tools.md`. O `verify` nem sempre fica ao alcance do agente, e a seção [Autopilot](#autopilot) diz o que a lane de tela usa nesse caso.

## Versões das CLIs

O runner chama três CLIs: `claude` (npm, Node 24.21.0), `codex` (npm, Node 24.19.0, pelo link do Homebrew) e `grok` (`~/.grok/downloads`). Nenhuma delas se atualiza sozinha: o `grok` tem `[cli] auto_update = false` em `~/.grok/config.toml` e o `claude` do npm tem `"env": {"DISABLE_AUTOUPDATER": "1"}` em `~/.claude/settings.json`. O `codex` só avisa no TUI. A skill `update-clis` é o único caminho de atualização. Medido em 2026-10-02: mesmo assim o binário do `grok` passou de 1.0.41 para 1.0.44 (2026-09-29 21:24) e para 1.0.46 (2026-10-02 16:14) fora da skill, cuja última execução foi em 2026-09-28, com `auto_update = false` mantido e `grok update --check` respondendo `autoUpdate: false`; as duas horas coincidem com reinícios do T3 Code, e o mecanismo não foi identificado. Até isso fechar, rode `npm run update-clis -- check` antes de confiar no `measuredOn` dos pontos de contato.

Para cada CLI, na ordem codex → grok → claude, a skill lê as notas de versão contra `skills/update-clis/references/cli-touchpoints.json`, instala a versão nova e roda a sonda. A sonda roda as lanes `read` e `write` de cada par família@esforço que as fichas dos três pais mandam para aquela CLI pelo runner. Roda também `seatbelt` (grok e claude dentro do `codex sandbox`), `sandbox` (o codex, sem modelo) e `manifest` (o claude, com `claude plugin validate`, sem modelo). Uma lane que falha faz a CLI voltar para a versão anterior e rodar a mesma sonda de novo: se a anterior passa, a versão nova fica segurada numa issue `CLI <nome> <versão> segurada`; se a anterior também falha, o problema é do ambiente e ninguém é segurado. Uma mudança de contrato num ponto sem cobertura segura a versão sem instalar. Os binários que os apps desktop trazem ficam de fora e só aparecem no relatório.

```shell
npm run update-clis -- check
npm run update-clis -- notes --cli grok --from 1.0.5 --to 1.0.41
npm run update-clis -- --help
```

O `check` mostra, para cada CLI, a versão instalada, a última do canal, as duplicatas e os processos em uso. O `--help` lista os subcomandos: `start`, `check`, `notes`, `install`, `probe` e `finish`.

Cada execução guarda notas, prompts, saídas, recibos e o resumo em `~/Library/Caches/pstack-vic/update-clis/<data-hora>/`, e a skill mantém as 10 mais recentes. Uma trava na mesma pasta impede duas execuções ao mesmo tempo.

A rotina é a tarefa agendada do app Claude Code `pstack-vic-cli-updates`, toda segunda às 07:00. Ela usa a skill do plugin instalado e posta no projeto pstack-vic do Linear: um comentário quando nada foi segurado, ou uma issue por versão segurada. O prompt da tarefa é este:

```markdown
---
name: pstack-vic-cli-updates
description: Atualiza as CLIs claude, codex e grok que o runner do pstack-vic chama, pela skill pstack:update-clis, e posta o resultado no projeto pstack-vic do Linear
---

Faça a execução semanal da skill `pstack:update-clis` (plugin pstack instalado). Leia o `SKILL.md` dela inteiro antes de começar e siga-o do começo ao fim, para as três CLIs, na ordem codex → grok → claude.

- Não edite arquivos do plugin nem de nenhum repositório e não faça commit. Uma versão que pede ajuste no plugin fica segurada.
- Rode o subcomando `probe` sempre em segundo plano e espere a notificação de fim.
- Poste o resultado no projeto pstack-vic do Linear como a skill manda: comentário no projeto quando nada foi segurado, uma issue por versão segurada, e uma issue urgente se uma volta de versão falhar.
- Termine com uma linha por CLI: em dia, atualizada A → B, adiada, segurada, sem verificação ou sonda inconclusiva.
```

## Autopilot

O autopilot leva uma fila de PRs até o merge dentro de uma sessão sua. Uma execução dessas se chama programa. Você abre a sessão, pede o programa e dá o "go". Essa sessão é a Raiz. Ela cria um Dono para cada PR. O Dono é um subagente, ou seja, um agente que a sessão cria e que trabalha em segundo plano. Ele cuida daquele PR do começo ao fim. A Raiz confere o trabalho de cada Dono com verificadores independentes e só então libera o merge. A coordenação precisa dessa sessão. Um pedido que o GitHub já aceitou pode terminar depois que ela fecha. Fechar o chat não retira um PR da fila nem cancela auto-merge; a retirada exige comando explícito e leitura dos dois estados como ausentes.

O autopilot tem dois playbooks, e os dois vêm do pstack da Cursor. Um playbook é o roteiro que o agente segue. No [Autopilot-full](../skills/poteto-mode/playbooks/autopilot-full.md), cada Dono mergeia o próprio PR depois do Veredito limpo da Raiz. O Veredito é o resultado da conferência dela. No [Autopilot-stack](../skills/poteto-mode/playbooks/autopilot-stack.md), nenhum agente mergeia. A Raiz monta uma pilha de PRs verificados, em que cada PR se apoia no anterior, e você revisa e mergeia. Use o Autopilot-full quando os PRs são independentes e você deu a autoridade de merge. Use o Autopilot-stack quando você quer revisar antes do merge, quando o trabalho é encadeado ou quando você não deu a autoridade de merge. As palavras Raiz, Dono, Enxame, Veredito, Rodada e Tick estão definidas no [`CONTEXT.md`](../CONTEXT.md).

### Como um programa começa

A Raiz não começa por conta própria. A execução só começa com o seu "go" explícito.

1. Abra uma sessão no repositório e entre com `/poteto-mode`.
2. Peça o programa e diga a fila, por exemplo `autopilot this queue` seguido dos itens. Para a pilha, peça `autopilot-stack`.
3. Se algum item da fila for seu, diga qual ("esse PR fica comigo").
4. Peça o protocolo, que é a descrição de como a Raiz vai conduzir o programa. Ela entrega o protocolo e para. O playbook chama isso de *state-then-wait*, que quer dizer declarar e esperar. Pedir o protocolo, ou um plano, não é dar o "go".
5. Confira a [autorização permanente](#autorização-permanente). Rode este comando num terminal. Ele tem de sair com código 0:

   ```shell
   (
   case "${CLAUDE_CONFIG_DIR-$HOME/.claude}" in
     ""|[!/]*) printf '%s\n' 'error: CLAUDE_CONFIG_DIR precisa ser um caminho absoluto não vazio.' >&2; exit 1 ;;
   esac
   AUTHORIZE="${CLAUDE_CONFIG_DIR-$HOME/.claude}/plugins/cache/pstack-vic/pstack/<versão>/skills/setup-pstack/scripts/authorize.ts"
   node "$AUTHORIZE" check --parent claude
   )
   echo $?
   ```

   Troque `<versão>` pela versão instalada, que `claude plugin list` mostra. A segunda linha mostra o código de saída da primeira: 0 é autorizado, 1 não. Com 1, o JSON que o comando imprime diz o motivo e traz o comando que concede a autorização. Sem ela, o modo automático do Claude Code nega o merge quando o Dono chega nele. Nenhum playbook roda essa conferência. Ela existe aqui e no passo 10 do `/setup-pstack`. Você também pode pedir à Raiz que rode o `check` e mostre o resultado junto com o protocolo.
6. Dê o "go". A Raiz arma o Tick (no Claude Code, um `/loop 1h` numa raiz de terminal ou um comando em segundo plano de uma hora numa Raiz do app desktop; no Codex e na raiz Grok, ver abaixo) e cria um Dono por PR.

Para um trabalho de várias fases, resolva o desenho com protótipos antes de pedir o plano, como ensina o [guia de design](guide/04-design.md#escreva-o-plano-depois-de-estabelecer-o-desenho). O playbook [Multi-phase plan](../skills/poteto-mode/playbooks/multi-phase-plan.md) escreve o plano como uma lista de itens com caixas de marcar, com uma seção por PR, e o plano diz qual playbook vai executá-lo. A sessão roda o verificador do plano (`check-plan.mjs`), entrega o caminho do arquivo e para. A execução também só começa com o seu "go".

### O que o Dono faz

O Dono leva um PR do build ao merge. Cada Dono trabalha num worktree próprio, que é uma cópia de trabalho separada do repositório. Vários Donos trabalham ao mesmo tempo quando os PRs não dependem um do outro.

- **Abre o PR cedo.** Em cerca de 15 minutos ele começa uma trilha de decisões (`decisions.tsv`), empurra a primeira versão da branch e abre o PR pronto, nunca como rascunho. O PR abre antes da prova, para que o endereço, as decisões e os checks fiquem registrados desde o começo. A trilha não entra no commit. Ela volta para a Raiz junto com os avisos.
- **Constrói, prova e limpa.** Ele prova a mudança no artefato real. Avalia com ceticismo cada comentário do Bugbot, o robô da Cursor que revisa PRs no GitHub, limpa o diff com `/deslop` e tira os comentários do código com `/no-comments`.
- **Rebaseia na hora certa, no Autopilot-full.** Rebasear é reaplicar os commits da branch sobre a trunk atual, e a trunk é a `main`. O primeiro rebase vem antes do aviso de Code-ready. Nos consertos que a Raiz pede, a base não muda. Ele só rebaseia de novo no preparo do merge, num conflito com a trunk ou numa falha de CI causada por uma mudança na trunk. Para publicar um rebase, ele valida o URL de escrita, captura o head remoto antes da reescrita, exige igualdade com o head local e usa o lease explícito `--force-with-lease=refs/heads/<branch>:<SHA-capturado>`. Um fetch posterior não altera esse SHA. Uma branch compartilhada ele nunca força.
- **Avisa a Raiz em dois momentos.** No Code-ready, o código a entregar está final, e o aviso leva o head, que é o último commit da branch. No Merge-ready, terminaram a prova dele, o CI (os testes automáticos do GitHub) e o babysit, que é acompanhar o PR até o CI ficar verde. Entre um aviso e outro, essas três coisas correm em paralelo com a verificação da Raiz. Ele também avisa o head de cada push posterior que muda o patch, que é o conteúdo da mudança.
- **Acompanha o próprio PR sem `/loop`, no Claude Code.** O playbook do Babysit manda acompanhar o PR dentro de um `/loop`. No Claude Code 2.1.285, e de novo na 2.1.293 (medido em 2026-10-08), um subagente em segundo plano não tem as ferramentas que o `/loop` usa (`ScheduleWakeup` e `CronCreate`), nem `ListAgents`; um Dono tem `Agent`, `TaskStop` e `SendMessage`, e recebe o resultado de cada ajudante como notificação num turno posterior, mesmo quando pede o ajudante em primeiro plano. Por isso o Dono roda o vigia do PR, `scripts/watch-pr/watch-pr`, que espera sozinho até o PR chegar a um resultado final, e o roda de novo depois de cada push e de cada resultado em que ele age.
- **Segue o playbook do tipo da tarefa.** O pedido que a Raiz entrega ao Dono (o brief) tem os campos do brief do Orchestrate e diz qual playbook rege o build: Bug fix, Feature, Refactoring ou Perf issue. O Dono copia os passos desse playbook para a lista de tarefas dele. O playbook do autopilot cuida do resto do ciclo do PR.
- **Despacha os próprios ajudantes pela planilha de modelos.** Para os ajudantes que ele cria, o Dono faz o papel de pai: lê `provider-dispatch.md` e manda cada papel configurado pela rota dele. Uma exploração dividida em partes, por exemplo, vai pela skill `swarm`, no modelo da linha `swarm workers`. No Claude Code, uma trava recusa os agentes embutidos `Explore`, `Plan` e `general-purpose` quando um agente do pstack os chama, porque eles rodam sem a skill e fora da planilha ([Subagents](#subagents)).
- **Anota os subagentes que cria.** O arquivo `children.tsv` guarda o ID, o tempo esperado e o estado de cada um. O tempo esperado é, no mínimo, o da execução mais longa já vista daquele tipo.
- **Mergeia, no Autopilot-full.** Com o Veredito limpo da Raiz, o Dono prepara o merge, rebaseia na trunk e espera o CI no head atual. A Raiz confere se o Veredito ainda descreve o patch, seguindo o critério de Shipping. O Dono mergeia conforme o playbook e os holds do operador. Um Dono novo pega o próximo item independente da fila.
- **Não mergeia nem mexe na pilha, no Autopilot-stack.** Ele empurra só a própria branch e avisa STACK-READY quando o loop de babysit dele fica verde. Com o Veredito limpo, a Raiz põe o PR na pilha. Só a Raiz rebaseia e ordena a pilha.

### Como publicar e reaproveitar verificações

Os playbooks seguem o fluxo da Cursor para criar, publicar, rebasear, acompanhar e mergear PRs. Shipping registra o head, a base e o patch-id do Veredito e confere se ele ainda descreve o patch antes de entregar. Quando só testes, documentação ou configuração de lint mudam, aplica a exceção upstream de comparação dos builds. Checks e mergeabilidade são conferidos no head atual. Os detalhes ficam no [playbook Shipping](../skills/poteto-mode/playbooks/shipping.md).

### O que a Raiz confere antes do merge

A Raiz é dona dos Vereditos, nunca dos PRs. Ela verifica cada Rodada. Uma Rodada começa no head Code-ready do Dono e em cada push posterior que muda o patch do PR. Em cada Rodada a Raiz lança o Enxame pela skill `swarm`. O Enxame é um grupo de verificadores independentes que rodam em paralelo. Cada um é uma lane, isto é, uma execução de modelo com uma tarefa só. As lanes fazem quatro coisas:

- Rodam de novo os gates, que são as checagens do repositório, naquele head.
- Provam ao vivo o comportamento principal da mudança, usando de verdade o programa que ela muda. Para isso usam a skill que opera esse tipo de programa, como `run` em CLIs e `verify` em telas.
- Auditam o diff sem confiar no texto do PR. São duas ou mais lanes de revisão, cada uma com um foco.
- Rodam o mesmo cenário na trunk, para comparar. É a lane de regressão.

Ao configurar Grok 4.7 como worker de swarm no Codex ou no Claude Code, a Raiz preserva o modelo e o esforço e seleciona a rota conforme a tarefa, seguindo a [regra de seleção de transporte](../skills/poteto-mode/references/provider-dispatch.md#explicit-grok-acp-tasks). Quando a tarefa exige recursos bloqueados pela rota CLI, a Raiz usa a rota ACP com acesso completo, conforme a autorização e os requisitos de confinamento existentes. O usuário não precisa pedir ACP nem escolher o transporte. O pai Grok continua em `spawn_subagent` nativo.

O Enxame aceita um substituto nativo opcional na mesma folha de modelos, pela linha `swarm fallback: <provedor>:<modelo>@<esforço>`. Configure pelo `/setup-pstack`, que usa `plan --swarm-fallback <descritor>` para ativar e `plan --swarm-fallback off` para remover. Sem a linha, o comportamento atual permanece. O setup exige um único modelo do provedor nativo e verifica uma família nova antes de gravar. Salvar a opção autoriza uma substituição por lane quando uma capacidade obrigatória está indisponível ou uma falha de execução é comprovada. Resultado com defeito, teste reprovado e pedido de parada não disparam a troca. Comparações de modelos e revisões que exigem outra Família mantêm a lacuna. A [política de fallback](../skills/swarm/references/native-fallback.md) define isolamento, limites e o registro do modelo que executou cada parte.

Uma lane externa não tem os drivers embutidos `run` nem `verify`; para verificar o app, recebe o driver do projeto quando aplicável e uma rota com as ferramentas necessárias. Os bloqueios de PTY, Chromium e commit em worktree linkado no macOS foram medidos nos sandboxes Grok `read-only` e `workspace`, em 2026-10-02 na 1.0.46. A referência de despacho delimita esses perfis e as rotas disponíveis.

A [rota ACP](../skills/poteto-mode/references/provider-dispatch.md#explicit-grok-acp-tasks) usa sandbox Grok `off`, always-approve e exige cinco ferramentas internas do host. Com `--mcp-config`, exige também `search_tool` e `use_tool` e aceita ferramentas MCP `server__tool` carregadas durante a sessão. O arquivo tem `schemaVersion: 1`, referências `urlEnv` e `bearerTokenEnv`, e `previewTabId` atribuído pelo pai. O endpoint HTTP(S) é loopback, sem porta padrão. Cada verificador recebe aba, worktree e outputs próprios. O runner injeta a aba no prompt e grava a atribuição no recibo. Full access admite integrações MCP e hooks confiáveis da configuração Grok, além do T3 encaminhado. Não confina escrita ao worktree. O sandbox do pai continua valendo.

O ACP exige resposta final após as ferramentas, `end_turn` e prova do modelo servido. O recibo registra uso acumulado, custo nulo enquanto a unidade de ticks não for comprovada, catálogo e encerramento. Um turno bem-sucedido pode ter exit `143` do servidor e sinal `SIGTERM`. Cancelamento e deadline explícito continuam valendo durante a limpeza. As sondas automáticas de setup e update ainda cobrem a rota CLI padrão. Mudança de contrato ACP sem cobertura segura a atualização. A Raiz guarda provas do runner de produção para host e preview.

Na rota CLI, o runner guarda os bytes crus de stdout e stderr do filho do modelo em dois arquivos ao lado do receipt, `<receipt>.stdout` e `<receipt>.stderr`, com modo `0600` e também quando a lane cai; o receipt aponta para eles em `stdoutPath` e `stderrPath`. Na rota ACP, esses campos são `null` e não há sidecars crus.

Mesmo numa lane nativa do Claude Code, o `verify` pode faltar. Você sempre pode digitar `/verify`. O agente só consegue chamá-lo quando ele aparece na lista de skills da sessão, e na versão 2.1.285 isso depende de um recurso que a Anthropic ainda libera aos poucos. Neste Mac ele não aparece: em 2026-10-01 a lista de skills de uma sessão trazia o `run` e não trazia o `verify`. Sem o `verify`, a lane de tela usa o `run`, que também opera apps Electron e apps de navegador, ou o driver que o repositório nomeia. Os seus dois repositórios não dependem do `verify`: o pstack-vic não tem tela e o Clinext tem o driver próprio, `verify-clinext`. O `run` e o `verify` são embutidos no Claude Code e não têm arquivo. Por isso, num plano, a caixa `<driver skill path>` leva o nome da skill, e a Raiz a lê carregando a skill. Um driver do repositório ela lê pelo caminho dele.

A Raiz junta os resultados num Veredito. Sem a lane ao vivo, o Veredito não é limpo. Sem Veredito limpo, não há merge. Os achados provados voltam ao Dono num só pedido de conserto. Para cada achado de comportamento, a Raiz pede um teste vermelho, isto é, um teste que falha enquanto o defeito existe. Onde nenhum teste mostra o defeito, ela pede um recibo de reprodução. O head novo ganha Enxame e Veredito novos. A exceção são os resultados que continuam válidos pela regra de evidência por lane do playbook [Shipping](../skills/poteto-mode/playbooks/shipping.md).

### O que a Raiz faz a cada hora

A cada hora a Raiz audita todos os Donos. Essa auditoria se chama Tick. Em cada Tick ela faz isto:

1. Relê o playbook, direto do plugin instalado. Confere a operação contra ele e corrige o desvio no próprio Tick.
2. Sonda cada Dono, para saber se ele está vivo e em que estado está, e recolhe as trilhas de decisão.
3. Conta como progresso só o que deixou efeito: commits, pushes, mudanças no PR ou nos checks e relatórios gravados.
4. Trata como travada a lane que dá erro, ou que passa do tempo esperado sem deixar efeito. Ela derruba essa lane e põe outra no lugar na hora, sem esperar resposta.
5. Aplica o mesmo teste à lista de agentes do programa, onde o pai tem uma, e ao `children.tsv` de cada Dono. No Claude Code essa lista são os subagentes que a sessão criou. O Dono registra o subagente travado e o substitui, se o trabalho ainda faz falta. Quando o Dono não consegue, a Raiz faz as duas coisas. Uma lane travada não prova o trabalho nem o cancela.
6. Quando vários merges saem juntos, faz uma retrospectiva e uma varredura dos comentários que os robôs deixaram depois do merge.

O Tick só termina quando não sobra trabalho delegado, mesmo depois do último merge.

Numa raiz de terminal do Claude Code (o comando `claude` aberto num terminal), a Raiz arma o Tick como `/loop 1h`, um `/loop` de intervalo fixo. O `/loop` é o comando que chama a sessão de novo, a cada hora, com o prompt do Tick. A cadência nunca fica por conta da memória da sessão. Um `/loop` de intervalo fixo volta quando a sessão é retomada com `--resume` ou `--continue` (medido em 2026-10-05 no Claude Code 2.1.289; um `/loop` sem intervalo não volta). O Claude Code encerra qualquer `/loop` depois de 7 dias. Um programa mais longo que isso precisa de um Tick armado de novo. Numa raiz de terminal o relógio dispara na hora mesmo com tarefas em segundo plano vivas: em 2026-10-08, no 2.1.293, um cron de uma só vez marcado para 13:39 chegou às 13:39:09 com um `sleep` de dez minutos ainda rodando em segundo plano. Na raiz Grok, o Tick vem do monitor ([Grok como raiz](#grok-como-raiz-no-t3-code)).

Numa Raiz aberta no app desktop do Claude, o `/loop 1h` não serve para o Tick. Nesse host, um prompt agendado (um cron de uma só vez, um `/loop` ou um `ScheduleWakeup`) só é entregue no primeiro fim de turno em que nenhuma tarefa em segundo plano está viva. Um shell em segundo plano retém o prompt, e um subagente em segundo plano também, mesmo um que a lista de agentes já mostra como concluído enquanto o shell dele ainda roda. Foi medido em 2026-10-08 no Claude Code 2.1.293 dentro do app (versão 2.26454.2), com o mesmo binário da raiz de terminal: com um `sleep` de dez minutos em segundo plano, um cron das 13:39 chegou às 13:46:36, meio minuto depois do turno que encerrou sem tarefa viva; com um subagente em segundo plano, um cron das 13:53 chegou às 13:57:00, logo depois do retorno dele; sem nada em segundo plano, um cron das 13:49 chegou às 13:49:04. Na véspera, um cron e um `ScheduleWakeup` tinham esperado 76 e 73 minutos pela mesma condição ([relatório](research/2026-10-08-claude-coordinator.md#despertar-da-raiz)). Um programa tem Donos em segundo plano o tempo todo, então um Tick por `/loop 1h` só chegaria depois do último Dono terminar. A Raiz sabe que está no app quando `CLAUDE_CODE_ENTRYPOINT` vale `claude-desktop` no ambiente da sessão (numa raiz de terminal vale `cli`). Nesse caso ela arma o Tick como um comando `Bash` em segundo plano que dorme uma hora e imprime o prompt do Tick, com `timeout` acima de uma hora (sem ele o host encerra o comando em trinta minutos; o máximo é duas horas). O fim do comando abre um turno na hora, e o primeiro passo desse Tick é armar o comando de novo, para a cadência não depender de o Tick terminar bem. O fim de um comando em segundo plano acordou a Raiz do app 9 a 12 segundos depois da saída, em dois ciclos curtos re-armados um a partir do outro, e um `sleep 3600` em segundo plano a acordou uma hora depois ([relatório](research/2026-10-08-raiz-clock-tick.md)). Esse comando não volta com `--resume`: uma Raiz retomada arma o Tick de novo. Quando o programa termina, a Raiz para o comando com `TaskStop`. O `Monitor` não serve para a hora inteira: ele expira em trinta minutos. O prompt do Tick e a cadência de uma hora são os mesmos do `/loop 1h`; só muda quem chama a sessão de volta ([ADR 0010](adr/0010-tick-em-segundo-plano-na-raiz-do-app-desktop.md)).

Num programa que roda a partir de um plano, o Tick é silencioso. A Raiz só escreve no chat quando a auditoria achou uma mudança que nenhuma mensagem anterior relatou: um PR aberto, um head Code-ready, uma Rodada aberta ou fechada, um Veredito, um merge, um agente travado e o que foi feito, um bloqueio que entrou ou saiu, ou uma decisão que só você pode tomar. Sem novidade, o Tick termina sem texto. Nos dois casos a Raiz registra o Tick na trilha de decisões dela.

### O que você faz

Sua parte num programa é esta:

- **Dá o "go".** Depois deixa a sessão aberta até o último merge e a resposta final da Raiz.
- **Manda o Tick, no Codex.** Onde nenhuma tarefa agendada do Codex chama a sessão de volta, você manda o prompt do Tick a cada hora ([Limites no Codex](#limites-no-codex)).
- **Clica no merge dos seus itens.** O Dono leva um item seu até o Merge-ready e para ali. Quem revisa e clica no merge é você, e nenhum Dono mergeia um item seu. Num programa com plano, um PR que muda uma interação também espera você. As capturas de tela e um vídeo vão para o chat, e você revisa antes do merge.
- **Aprova o que a sua autorização não cobre.** Alguns limites o CI só deixa apertar, como um gate ou um orçamento fixado. Subir um limite desses pede o aval da Raiz (*countersign*), que ela só dá depois da prova de um verificador. Quando a sua autorização ou as suas ordens permanentes, que são as instruções que você deu para o programa todo, cobrem aprovações, o aval da Raiz é a aprovação, e o Dono a registra apontando para ele. Quando não cobrem, a aprovação continua sendo sua. A Raiz também nunca dá nem contorna uma aprovação que o GitHub exige. Absorver um valor que já entrou na `main` não conta como subir limite.
- **Manda parar quando quiser.** Um "para" seu chega na hora a todos os Donos como ordem de não escrever mais nada. Eles seguram o trabalho até você liberar.
- **Revisa e mergeia a pilha, no Autopilot-stack.** A entrega é uma cadeia de PRs verificados, cada um com o Veredito no corpo do PR ou num comentário. Você revisa de baixo para cima e mergeia com os seus cliques. Para *merge-when-ready* assistido por agente, o Shipping espera os requisitos atuais passarem, relê identidade e base e submete o head esperado, respeitando toda reserva do operador.
- **Lê a resposta final.** No Autopilot-full ela traz a fila com o Dono, o estado e o head de cada PR, e cada Veredito com o Enxame que o produziu. Traz também o que foi mergeado, o que cada Dono pegou em seguida, os avais dados com o motivo de cada um, o que ainda espera você e onde estão as trilhas de decisão. No Autopilot-stack ela traz os links da base e da ponta da pilha, um resumo do Veredito de cada PR e o que ficou de fora, com o motivo.

O resto é da Raiz e dos Donos: build, PR, CI, verificação e, no Autopilot-full, o merge.

### PR aberto fora de um programa

Um PR do Dependabot, ou um que você abriu à mão, não tem Dono. Ninguém mexe nele até você decidir. Há dois caminhos:

- **Você mergeia.** Sua revisão e seu clique não dependem de um Veredito da Raiz quando o PR está fora de um programa. Confira os checks atuais, revise o PR e clique no merge. Se pedir que um agente faça o merge pelo Shipping, ele segue o playbook e precisa do veredito do verificador independente daquele PR.
- **Um programa adota o PR.** Ao pedir o programa, cite o PR como um item da fila. A Raiz cria um Dono para ele, como para qualquer item, e valem as mesmas regras: Rodada do Enxame, Veredito limpo e, no Autopilot-full, merge pelo Dono. Os playbooks não têm um passo separado de adoção. Adotar é pôr o PR na fila. Se você quer clicar no merge, diga que o item é seu.

### O que mudou em relação ao fluxo antigo

Até a 0.4.19 o plugin tinha um fluxo próprio, em que um robô no Mac conferia e mergeava PRs sozinho, mesmo com todas as sessões fechadas. A 0.5.0 aposentou esse fluxo. A decisão está no ADR 0005, em [`docs/adr/`](adr/). Os documentos antigos estão em [`docs/arquivo/`](arquivo/), só como história. Para você, mudou isto:

- **Não existe mais o daemon local.** A coordenação roda numa sessão sua. Um pedido de merge ou fila que o GitHub já aceitou pode terminar depois que essa sessão fecha.
- **Fechar a sessão não retira pedidos.** Antes de uma mudança autorizada na branch ou no Veredito, o responsável retira explicitamente fila e auto-merge e relê ambos como ausentes. Ao retomar, a Raiz relê o estado real do servidor.
- **PR aberto fora de um programa espera.** Ou você mergeia, ou um programa o adota como item da fila ([PR aberto fora de um programa](#pr-aberto-fora-de-um-programa)).
- **O GitHub só exige o CI.** Os checks `verdict` e `hold` saíram das regras, e um rótulo no PR não trava mais nada. O que segura um merge é o Veredito da Raiz, dentro da sessão. Para ficar com um PR, diga isso na sessão.
- **A versão sai em dois passos.** O CI cria a tag. Trocar o plugin nos dois pais é um comando seu no Mac ([Publicar uma versão](#publicar-uma-versão)).
- **No Codex não há relógio interno.** Você mesmo pede o Tick a cada hora. O Codex também precisa de `multi_agent` ligado para ter Donos ([Limites no Codex](#limites-no-codex)).

### Limites no Codex

No Codex o programa segue os mesmos playbooks. Mudam quatro coisas, que estão em [`codex-tools.md`](../skills/poteto-mode/references/codex-tools.md):

- **Não há `/loop`.** O Codex não tem um `/loop` que chame a sessão de volta. Onde nenhuma tarefa agendada do Codex faz isso, quem dá a cadência do Tick é você. A Raiz avisa isso quando declara o protocolo. Você manda o prompt do Tick a cada hora, e ela roda um Tick inteiro a cada envio.
- **Os Donos precisam de `multi_agent`.** No Codex o Dono é um `spawn_agent`, que é a ferramenta de criar subagentes. Ela só funciona com `multi_agent = true` em `~/.codex/config.toml` ([Instalação, Codex](#codex)). Sem isso não há Donos.
- **A Raiz cria o worktree antes.** O `spawn_agent` não cria worktree. A Raiz cria um com `git worktree add` e passa o caminho ao Dono.
- **Não há `run` nem `verify`.** A lane ao vivo roda o app pelo shell. Para uma tela, ela usa a automação que tiver ou entrega a você uma checagem manual concreta.

A conferência antes do "go" usa o mesmo script com `--parent codex`. Ela sai com 0 quando `approval_policy = "never"` está no topo do `<config-home>/config.toml` do Codex, que é `CODEX_HOME` ou `~/.codex` ([Harness config homes](../skills/poteto-mode/references/codex-tools.md#harness-config-homes)). Com outro valor, o Codex interrompe o programa e pede aprovação.

### Autorização permanente

A autorização permanente é uma entrada que você grava uma vez em `autoMode.allow`, no `<config-home>/settings.json` do Claude Code, que é `CLAUDE_CONFIG_DIR` ou `~/.claude` ([Harness config homes](../skills/poteto-mode/references/codex-tools.md#harness-config-homes)). Sem ela, o modo automático do Claude Code nega o merge quando o Dono ou a sessão do Shipping chega nele.

Nos playbooks do pstack, um agente mergeia um PR que nenhum humano aprovou em dois casos:

- O Dono de um PR num programa de autopilot mergeia depois do Veredito limpo do Enxame da Raiz. Quem dá esse Veredito são verificadores que não escreveram o código.
- A sessão que roda o playbook Shipping mergeia depois do veredito do verificador independente daquele PR.

O modo automático do Claude Code bloqueia esses merges de fábrica, pelas regras "Merge Without Review" e "Self-Approval". O classificador dele lê as mensagens do usuário e os comandos, e não lê as perguntas do agente. Por isso um "ok" a uma pergunta não autoriza nada, e o modo automático nega o merge. O Claude Code não lê `autoMode.allow` de nenhum repositório nem de plugin, então o plugin não entrega a entrada.

```shell
(
case "${CLAUDE_CONFIG_DIR-$HOME/.claude}" in
  ""|[!/]*) printf '%s\n' 'error: CLAUDE_CONFIG_DIR precisa ser um caminho absoluto não vazio.' >&2; exit 1 ;;
esac
AUTHORIZE="${CLAUDE_CONFIG_DIR-$HOME/.claude}/plugins/cache/pstack-vic/pstack/<versão>/skills/setup-pstack/scripts/authorize.ts"
node "$AUTHORIZE" check --parent claude
node "$AUTHORIZE" check --parent codex
)
```

Troque `<versão>` pela versão instalada. O primeiro comando confere o Claude Code. Ele sai com 0 quando a autorização está gravada e com 1 quando não está, e o JSON que ele imprime traz o arquivo, o motivo, a entrada e, no campo `grant`, o comando que grava a autorização. Esse comando fixa `CLAUDE_CONFIG_DIR` na pasta do arquivo que o `check` leu e só roda num terminal. Ele mostra a entrada, pede um "yes" digitado e grava. O segundo comando confere o Codex. Ele sai com 0 quando `approval_policy = "never"` está no topo do `<config-home>/config.toml` do Codex.

A entrada vale em qualquer repositório. Ela cobre três coisas:

- O merge nesses dois casos, conforme as verificações e os comandos do playbook, incluindo squash e auto-merge quando pedidos. Itens reservados pelo operador continuam à espera do clique dele.
- A criação de Donos e verificadores, a publicação das branches próprias pela Raiz ou pelo Dono conforme o playbook e a publicação dos Vereditos como comentários no PR.
- O lançamento, pelo `pstack-runner`, das lanes que os playbooks nomeiam (Dono, verificador, revisor, juiz ou worker em claude, codex ou grok).

Continuam bloqueados:

- `--admin` e qualquer outro desvio de um check obrigatório.
- Mudança em proteção de branch, em rulesets ou em checks obrigatórios.
- Tudo o que as outras regras protegem: arquivos, branches e histórico destruídos, produção, segredos e dados enviados para fora.

Fora de um terminal, o `apply` recusa, porque a autorização é um ato seu e não do agente. Ele mantém as regras de fábrica (`"$defaults"`) e todas as outras configurações, e copia o arquivo anterior para `settings.json.before-pstack-authorization`. Para retirar a autorização, apague a entrada.

A entrada traz a versão no nome (`pstack standing authorization v3`). O `check` exige exatamente uma entrada com o corpo atual e distingue ausência, texto antigo e múltiplos grants, sem escrever configurações. Um grant anterior precisa da revisão e do `apply` do operador, com confirmação no terminal e backup. A instalação não faz essa migração. O passo 10 do `/setup-pstack` confere a autorização, assim como a preparação do programa antes do "go".

### De onde vem o texto dos playbooks

Os seis playbooks do autopilot e o fluxo Why são o texto da Cursor no pin de `UPSTREAM.md` mais as adaptações de ambiente em [`upstream-substitutions.json`](../skills/poteto-mode/references/upstream-substitutions.json). A tabela aceita somente linhas `platform`, cada uma com seu motivo. Edite a tabela e rode `node scripts/upstream-parity.ts --write` para regenerar os arquivos. O `npm test` confere a paridade e recusa acréscimos de política. A correção de Attack the Premise do PR 94 mantém sua proveniência separada no open-pstack.

## Skills

Nomes curtos; no Claude Code cada uma aparece com o prefixo do plugin (`/pstack:poteto-mode`) e no Codex como `pstack:poteto-mode`.

| skill | quando usar |
| --- | --- |
| `poteto-mode` | ponto de entrada de qualquer tarefa não trivial: escolhe um playbook e roteia para as outras skills |
| `poteto-help` | guia de uso: como instalar, configurar e usar o pstack, qual skill, playbook ou princípio serve para uma situação e o que fazer quando uma execução dá errado; entrega um prompt pronto e o link do arquivo, sem começar o trabalho |
| `how` | entender como um subsistema funciona |
| `why` | evidência de por que algo foi construído assim, em paralelo pelos MCPs disponíveis |
| `architect` | assentar tipos e forma de módulo antes de código que cruza fronteira de função |
| `arena` | N tentativas paralelas da mesma coisa, depois enxertar as melhores partes |
| `swarm` | N workers paralelos em fatias ou corridas, um relatório agregado |
| `interrogate` | vários modelos tentando quebrar um design ou diff, com lente de qualidade de código |
| `automate-me` | rascunhar sua própria skill `-mode` a partir dos seus transcripts |
| `reflect` | capturar as lições de uma tarefa longa como edição de skill |
| `correct` | achar os erros que os agentes repetem no repo e travar cada um no nível mais alto que funciona: arquitetura, depois tipos, lint e CI, depois testes, docs por último |
| `tdd` | corrigir bug escrevendo o teste que falha antes da correção |
| `benchmark-checklist` | conferir um número de performance (limitador, ajuste, erros, repetição, relevância) antes de reportar ou agir sobre ele |
| `typescript-best-practices` | aterrar a disciplina de tipos em sintaxe TypeScript |
| `teach` | entender de verdade uma mudança ou subsistema: `how` + `why` numa explicação só |
| `technical-writing` | docs, RFCs, readmes, descrições de PR e commits num padrão em camadas |
| `bro` | reafirmar a última mensagem em linguagem simples |
| `figure-it-out` | desenhar um playbook rigoroso quando nenhum embutido serve |
| `show-me-your-work` | trilha de decisões revisável em tsv; no fim, uma lane do papel `trail reviewer pool`, de uma Família diferente da raiz, revisa a trilha |
| `blast-radius` | o que uma mudança pequena pode quebrar fora do diff, provado rodando código |
| `recall` | reconstruir o contexto recente de um tema a partir do histórico e do registro compartilhado |
| `update-clis` | atualizar `claude`, `codex` e `grok` só quando o plugin continua funcionando na versão nova: notas contra os pontos de contato, instalação, sonda real, volta e contraprova; o que não passa fica segurado numa issue do Linear |
| `setup-pstack` | escolher modelo e effort por papel (a mesma família pode rodar em efforts diferentes em papéis diferentes); probe de cada par família+effort e escrita do sheet pelo `scripts/setup-pstack.ts` (rerun byte-idêntico, nada escrito se um probe falha); o subcomando `pick` escolhe a lane de um papel de pool pela regra de revisão cruzada; o passo 10 confere, pelo `scripts/authorize.ts`, a autorização permanente que o autopilot e o playbook Shipping exigem |
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

Vinte e quatro skills de um princípio cada. `poteto-mode` indexa todas inline e lê a folha completa de cada princípio que aplica. Carregam `user-invocable: false`: ficam fora do menu `/`, o modelo continua podendo lê-las.

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
| `principle-explain-the-number` | verification | antes de confiar num número medido, achar o que o limita e descartar que mediu outra coisa |
| `principle-guard-the-context-window` | delegation | volume vai para subagents; só resumos na thread principal |
| `principle-never-block-on-the-human` | delegation | agir, apresentar, deixar corrigir depois; confirmação só para o irreversível |
| `principle-encode-lessons-in-structure` | meta | codificar a regra como lint, flag, check ou script, não como mais texto |

## Subagents

- **`poteto-agent`**. É o ajudante de quem trabalha em `poteto-mode`, para tudo que não é um papel configurado.
  Lê `poteto-mode` por completo antes de trabalhar.
- **`pstack-owner-<família>-<effort>`**. É o Dono de cada PR em um programa de [autopilot](#autopilot): o `poteto-agent` no modelo e no effort da linha de autoria do PR.
  A ferramenta `Agent` do Claude Code não recebe effort, então é a definição do agente que leva os dois.
  A Raiz o cria com `Agent`, `subagent_type: "pstack-owner-opus-xhigh"` (para uma linha `claude:claude-opus-5-5@xhigh`) e `isolation: "worktree"`.
  Diferente de uma lane, ele pode criar subagentes.
  São gerados da matriz junto com as lanes.
  No Codex não há arquivo: a Raiz usa `spawn_agent` com o modelo, o effort e uma worktree própria.
- **`comment-sicko`** — revisor de comentários, só leitura, que `no-comments` dispara. Renomeado de `Comment Sicko` para valer como `subagent_type`.
- **`pstack-<família>-<effort>`** — lanes nativas do Claude Code para cada família com `agentStem` na matriz (hoje `fable` e `opus`) em cada effort selecionável, geradas por `npm run agents:generate` e verificadas por `agents:check`. Não são fluxos de usuário; `provider-dispatch.md` as despacha a partir do papel configurado. No Codex não há arquivo: `spawn_agent` recebe `model` e `reasoning_effort`.

**A trava dos agentes embutidos.** O plugin registra um hook do Claude Code, `hooks/agent-guard.mjs`, que roda antes de cada chamada da ferramenta `Agent`. Ele recusa `Explore`, `Plan` e `general-purpose` quando quem chama é um agente do pstack (um Dono ou um `poteto-agent`), e a recusa diz o caminho certo. Esses três agentes rodam sem a skill `poteto-mode`, e o `Explore` e o `Plan` nem carregam a planilha de modelos. A sessão principal não é afetada: você continua podendo usar qualquer agente. O hook não injeta nada no início da sessão, então `poteto-mode` continua entrando só por comando. No Codex o hook não existe.

## Verificação

```shell
npm test
npm run test:bun
npm run matrix:check
npm run agents:check
npm run collision:check
npm run upstream:digest -- --no-fetch
node scripts/upstream-parity.ts check
npm run setup-pstack -- --help
npm run update-clis -- --help
claude plugin validate --strict .
```

O `npm test` roda os testes da matriz, do gerador de agents, do runner, do setup-pstack, do update-clis, da referência de skills, dos manifests e do hook, do digest dos upstreams, da paridade dos playbooks do autopilot e do Why com a Cursor, do verificador de planos (`check-plan.mjs`) contra o molde do `multi-phase-plan.md` gerado, do release e dos invariantes do pacote. O `node scripts/upstream-parity.ts check` roda só a paridade: confere que os seis playbooks e os cinco arquivos de Why são o texto da Cursor mais as adaptações de `upstream-substitutions.json`.

O `npm run test:bun` roda no Bun os testes do `orch` e do `watch-pr`: `bun install --frozen-lockfile`, `bun test` e o typecheck do `watch-pr`. Ele precisa do `bun` no PATH. O `npm run matrix:check` confere que os blocos gerados de `provider-dispatch.md` e do `setup-pstack` estão em dia, e o `npm run agents:check` confere que os `agents/pstack-*.md` estão em dia com a matriz. O `npm run upstream:digest -- --no-fetch` monta o digest dos dois upstreams desde o ponto de sync (`UPSTREAM.md`, seção *Digest semanal*). Os dois `--help` listam os subcomandos do setup (`state`, `plan`, `probe`, `attest` e `write`) e os da atualização das CLIs (`start`, `check`, `notes`, `install`, `probe` e `finish`). O `claude plugin validate --strict .` passa o manifest do plugin e o do marketplace pelo validador do Claude Code.

`tests/skill-collision-repro.sh` verifica os invariantes estáticos do pacote (sem camada `commands/`, `principle-*` ocultos e legíveis pelo modelo, skills de fluxo sem `disable-model-invocation`, nome do diretório igual ao `name`, versão única entre manifests, tag do marketplace e `package.json`, logo do Codex resolvendo, aliases móveis de Fable e Opus, vínculo do Bugbot entre a skill `babysit` e o playbook, playbooks sem comandos Graphite, conteúdo Cursor-only ausente). Com `PSTACK_BEHAVIORAL=1` ele também monta um plugin de uma skill e prova, com `claude -p`, que a invocação pela tool `Skill` e pelo `/comando` chegam à skill.

O teste de paridade lê o commit da Cursor anotado em `UPSTREAM.md`, e esse commit precisa estar no clone. O CI busca o remote `cursor` antes do `npm test`. Num clone sem o commit, o teste falha com a mensagem `fetch the cursor remote first: git fetch --no-tags cursor main`. Ele falha em vez de pular, porque um teste pulado esconderia uma frase fora da tabela. Para resolver, registre o remote uma vez com `git remote add cursor https://github.com/cursor/plugins.git` e rode `git fetch --no-tags cursor main`. A seção *Checar mudanças* do `UPSTREAM.md` tem os quatro comandos que registram os dois remotes.

## O que ficou de fora

- **`skills/make-bot-ui`** — construída sobre rotinas, webhooks e UI da Cursor; não há mapeamento comum Claude Code / Codex.
- **`automations/benny/`** — pacote dormente de automações Slack sobre o runtime de eventos da Cursor. Não registrava skills nem no original.
- **Sticky mode** — frontmatter `mode`/`icon`/`color`/`reminder` só da Cursor. Fica o opt-in: `poteto-mode` só entra por comando do usuário, como no original.
- **Resto do `cursor-team-kit`** — `control-cli`/`control-ui` viraram `run`/`verify`; `verify-this` e `check-compiler-errors` duplicam built-ins; `loop-on-ci`, `review-and-ship`, `weekly-review` sobrepõem `babysit`, `fix-ci`, `make-pr-easy-to-review` e `what-did-i-get-done`; `pr-review-canvas` é UI da Cursor.
- **`README.md` da Cursor** — substituído por um README do port; o original está no histórico (`git show 91e5b82:README.md`) e no upstream.

## Licença

MIT. Três arquivos de licença preservados: [`LICENSE`](../LICENSE) (pstack, Lauren Tan), [`LICENSE-open-pstack`](../LICENSE-open-pstack) (open-pstack, Eric Litman) e [`LICENSE-cursor-team-kit`](../LICENSE-cursor-team-kit) (Cursor; cobre `deslop`, `thermo-nuclear-code-quality-review`, `make-pr-easy-to-review`, `fix-ci`, `fix-merge-conflicts`, `get-pr-comments` e `what-did-i-get-done`).

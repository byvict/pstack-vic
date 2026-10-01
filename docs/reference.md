# pstack-vic — referência técnica

pstack-vic é um port autoral do [pstack](https://github.com/cursor/plugins/tree/main/pstack) de Lauren Tan ([@poteto](https://x.com/poteto)) para Claude Code e Codex. Uma única árvore de skills serve os dois pais. Os modelos de cada papel vêm de uma matriz como dado (`model-matrix.json`), não de constantes espalhadas pelas skills.

Conteúdo sincronizado com Cursor pstack **0.15.5** (`12d587d`) e com open-pstack **1.4.1** (`de67e6b`). O contrato de sync está em [`UPSTREAM.md`](../UPSTREAM.md), a proveniência de cada arquivo em [`NOTICE.md`](../NOTICE.md) e o veredito de cada mudança em [`CHANGES.md`](../CHANGES.md).

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

### Codex

```shell
codex plugin marketplace add byvict/pstack-vic --ref v0.5.1
codex plugin add pstack@pstack-vic
```

O Codex descobre as skills sob o namespace `pstack` (`pstack:poteto-mode`, `pstack:tdd`…), que vem de `.codex-plugin/plugin.json`; os `principle-*` também aparecem, porque `user-invocable: false` é do Claude Code. `poteto-mode` só entra quando você o pede pelo nome: `skills/poteto-mode/agents/openai.yaml` desliga a invocação implícita (`allow_implicit_invocation: false`). Para as skills que fazem fan-out (`interrogate`, `arena`, `how`, `why`, `reflect`, `architect`, `swarm`), ligue subagents em `~/.codex/config.toml`; sem isso a lane nativa do Codex vira dropout nomeado e as lanes externas seguem:

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

Rode `/setup-pstack` uma vez em cada pai para escrever o sheet de modelos (`~/.claude/pstack-models.md` e `~/.codex/pstack-models.md`). O último passo dele confere a [autorização permanente](#autorização-permanente), que o autopilot e o playbook Shipping exigem para mergear sem aprovação humana. Depois, `/poteto-mode` é o ponto de entrada para qualquer tarefa que peça rigor.

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
├── model-matrix.json                 # famílias, efforts, pais, rota por pai, papéis (dado canônico)
├── scripts/                          # loader/validação da matriz, render dos blocos gerados, gerador de agents, digest semanal dos upstreams, upstream-parity.ts (a guarda dos seis playbooks do autopilot), release.ts (troca o plugin nos dois pais depois do merge), testes (inclui manifests.test.ts)
├── skills/                           # 55 skills compartilhadas por Claude Code e Codex
│   ├── poteto-mode/agents/           # openai.yaml: no Codex, poteto-mode só por invocação explícita
│   ├── poteto-mode/references/       # provider-dispatch.md (rota e papéis), codex-tools.md (mapa de tools), bugbot-triage.md, upstream-substitutions.json (as trocas de harness dos seis playbooks do autopilot)
│   ├── poteto-mode/scripts/          # runner externo (Node 24, com probe-lane.ts, a sonda de uma lane), watch-pr, orch, check-plan.mjs, worktree-audit.sh
│   ├── setup-pstack/scripts/         # setup-pstack.ts: estado, plano, probe, atestado e escrita do sheet (Node 24); authorize.ts: a autorização permanente (autopilot e Shipping)
│   └── update-clis/                  # scripts/update-clis.ts (check, notes, install, probe) e references/cli-touchpoints.json
├── agents/                           # poteto-agent, comment-sicko e as lanes nativas pstack-<família>-<effort> geradas da matriz
├── assets/                           # logo
├── docs/reference.md                 # esta referência
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

Nada é gerado nem bifurcado por pai. Duas referências fazem a tradução em tempo de execução: [`codex-tools.md`](../skills/poteto-mode/references/codex-tools.md) mapeia tools e built-ins do Claude Code (`Agent` → `spawn_agent`, `AskUserQuestion`, `run`, `verify`, `loop`, `skill-creator`) e [`provider-dispatch.md`](../skills/poteto-mode/references/provider-dispatch.md) mapeia famílias de modelo para a rota certa em cada pai. As skills que citam um primitivo do Claude Code carregam uma nota de plataforma de uma linha apontando para o mapa.

- **Invocação.** O Codex carrega `SKILL.md` nativamente; não há tool `Skill`. Peça a skill pelo nome.
- **Rota de modelos.** Quem é pai escolhe a rota. No Claude Code, Fable e Opus rodam em agents nativos e Sol, Astra e Grok no runner externo. No Codex, Sol e Astra rodam em `spawn_agent` e Fable, Opus e Grok no runner. Um filho nunca escolhe provider nem troca de rota por conta própria; lane indisponível vira dropout nomeado, nunca substituição silenciosa.
- **Papéis.** As skills citam papéis (`arena runners`, `bug-fix`, `how explainer`…), não descritores. O default de cada papel, por pai, está na seção *Role defaults* de `provider-dispatch.md` e é o que `/setup-pstack` escreve no sheet.
- **Entrada.** `poteto-mode` não dispara sozinho em nenhum pai: `disable-model-invocation: true` no Claude Code, `allow_implicit_invocation: false` no Codex. Entre com `/pstack:poteto-mode` ou `pstack:poteto-mode` pelo nome.

## Dependências

Nada é declarado em manifest. O que as skills usam:

- **Node 24** — o runner externo, os scripts da matriz, o `check-plan.mjs` e o `npm test` rodam TypeScript direto, sem build e sem Bun.
- **CLIs `claude`, `codex` e `grok`** — autenticados, só os que o sheet de modelos usa. O runner recusa provider igual ao do pai (essa lane é nativa). A versão delas muda só pela skill `update-clis` (seção [Versões das CLIs](#versões-das-clis)).
- **`gh`** — forge padrão dos playbooks de PR e da skill `babysit`; `origin` é usado quando resolve o repositório; `gt` só no playbook Orchestrate. A skill `update-clis` também o usa para ler as releases do codex.
- **`lsof`** — só para `update-clis`, que o usa para saber se alguém está rodando a CLI que ela trocaria.
- **`bun`** — só para `watch-pr` e `orch`, que vieram da Cursor sem mudança, e para os testes deles e o typecheck do `watch-pr` (`npm run test:bun`).
- **`jq` e `rg`** — só para `worktree-audit.sh` (playbook Worktree cleanup); sem eles o audit avisa e deixa colunas em branco.
- **`run`, `verify`, `loop`** — built-ins do Claude Code; **`skill-creator`** — skill oficial da Anthropic para autoria de SKILL.md. Os quatro têm substituto em `codex-tools.md`. O `verify` nem sempre fica ao alcance do agente, e a seção [Autopilot](#autopilot) diz o que a lane de tela usa nesse caso.

## Versões das CLIs

O runner chama três CLIs: `claude` (npm, Node 24.21.0), `codex` (npm, Node 24.19.0, pelo link do Homebrew) e `grok` (`~/.grok/downloads`). Nenhuma delas se atualiza sozinha: o `grok` tem `[cli] auto_update = false` em `~/.grok/config.toml` e o `claude` do npm tem `"env": {"DISABLE_AUTOUPDATER": "1"}` em `~/.claude/settings.json`. O `codex` só avisa no TUI. A skill `update-clis` é o único caminho de atualização.

Para cada CLI, na ordem codex → grok → claude, a skill lê as notas de versão contra `skills/update-clis/references/cli-touchpoints.json`, instala a versão nova e roda a sonda. A sonda roda as lanes `read` e `write` de cada par família@esforço que as duas fichas mandam para aquela CLI pelo runner. Roda também `seatbelt` (grok e claude dentro do `codex sandbox`), `sandbox` (o codex, sem modelo) e `manifest` (o claude, com `claude plugin validate`, sem modelo). Uma lane que falha faz a CLI voltar para a versão anterior e rodar a mesma sonda de novo: se a anterior passa, a versão nova fica segurada numa issue `CLI <nome> <versão> segurada`; se a anterior também falha, o problema é do ambiente e ninguém é segurado. Uma mudança de contrato num ponto sem cobertura segura a versão sem instalar. Os binários que os apps desktop trazem ficam de fora e só aparecem no relatório.

```shell
npm run update-clis -- check                  # versão instalada, última do canal, duplicatas e processos em uso, por CLI
npm run update-clis -- notes --cli grok --from 1.0.5 --to 1.0.41
npm run update-clis -- --help                 # start, check, notes, install, probe, finish
```

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

O autopilot leva uma fila de PRs até o merge dentro de uma sessão sua. Uma execução dessas se chama programa. Você abre a sessão, pede o programa e dá o "go". Essa sessão é a Raiz. Ela cria um Dono para cada PR. O Dono é um subagente, ou seja, um agente que a sessão cria e que trabalha em segundo plano. Ele cuida daquele PR do começo ao fim. A Raiz confere o trabalho de cada Dono com verificadores independentes e só então libera o merge. Nada roda fora dessa sessão. Se ela fecha, o programa para.

O autopilot tem dois playbooks, e os dois vêm do pstack da Cursor. Um playbook é o roteiro que o agente segue. No [Autopilot-full](../skills/poteto-mode/playbooks/autopilot-full.md), cada Dono mergeia o próprio PR depois do Veredito limpo da Raiz. O Veredito é o resultado da conferência dela. No [Autopilot-stack](../skills/poteto-mode/playbooks/autopilot-stack.md), nenhum agente mergeia. A Raiz monta uma pilha de PRs verificados, em que cada PR se apoia no anterior, e você revisa e mergeia. Use o Autopilot-full quando os PRs são independentes e você deu a autoridade de merge. Use o Autopilot-stack quando você quer revisar antes do merge, quando o trabalho é encadeado ou quando você não deu a autoridade de merge. As palavras Raiz, Dono, Enxame, Veredito, Rodada e Tick estão definidas no [`CONTEXT.md`](../CONTEXT.md).

### Como um programa começa

A Raiz não começa por conta própria. A execução só começa com o seu "go" explícito.

1. Abra uma sessão no repositório e entre com `/poteto-mode`.
2. Peça o programa e diga a fila, por exemplo `autopilot this queue` seguido dos itens. Para a pilha, peça `autopilot-stack`.
3. Se algum item da fila for seu, diga qual ("esse PR fica comigo").
4. Peça o protocolo, que é a descrição de como a Raiz vai conduzir o programa. Ela entrega o protocolo e para. O playbook chama isso de *state-then-wait*, que quer dizer declarar e esperar. Pedir o protocolo, ou um plano, não é dar o "go".
5. Confira a [autorização permanente](#autorização-permanente). Rode este comando num terminal. Ele tem de sair com código 0:

   ```shell
   node ~/.claude/plugins/cache/pstack-vic/pstack/<versão>/skills/setup-pstack/scripts/authorize.ts check --parent claude
   echo $?
   ```

   Troque `<versão>` pela versão instalada, que `claude plugin list` mostra. A segunda linha mostra o código de saída da primeira: 0 é autorizado, 1 não. Com 1, o JSON que o comando imprime diz o motivo e traz o comando que concede a autorização. Sem ela, o modo automático do Claude Code nega o merge quando o Dono chega nele. Nenhum playbook roda essa conferência. Ela existe aqui e no passo 10 do `/setup-pstack`. Você também pode pedir à Raiz que rode o `check` e mostre o resultado junto com o protocolo.
6. Dê o "go". A Raiz arma um `/goal` com o objetivo completo do programa. O `/goal` é o objetivo da sessão e vale de um turno para o outro até a fila acabar. No Claude Code a Raiz o propõe pela ferramenta `ProposeGoal`, e o Claude Code pode pedir a sua aprovação com uma tecla. Na versão 2.1.285 essa ferramenta depende de um recurso que a Anthropic ainda libera aos poucos, só existe numa sessão interativa no seu Mac e aceita um objetivo de até 500 caracteres. Neste Mac, em 2026-10-01, esse recurso estava desligado. Quando a ferramenta falta, ou o objetivo é mais longo, a Raiz escreve a linha `/goal <objetivo>` exata para você digitar. Um `/goal` digitado aceita até 4000 caracteres. Depois ela cria um Dono por PR.

Para um trabalho de várias fases, peça antes um plano. O playbook [Multi-phase plan](../skills/poteto-mode/playbooks/multi-phase-plan.md) escreve o plano como uma lista de itens com caixas de marcar, com uma seção por PR, e o plano diz qual playbook vai executá-lo. A sessão roda o verificador do plano (`check-plan.mjs`), entrega o caminho do arquivo e para. A execução também só começa com o seu "go".

### O que o Dono faz

O Dono leva um PR do build ao merge. Cada Dono trabalha num worktree próprio, que é uma cópia de trabalho separada do repositório. Vários Donos trabalham ao mesmo tempo quando os PRs não dependem um do outro.

- **Abre o PR cedo.** Em cerca de 15 minutos ele começa uma trilha de decisões (`decisions.tsv`), empurra a primeira versão da branch e abre o PR pronto, nunca como rascunho. O PR abre antes da prova, para que o endereço, as decisões e os checks fiquem registrados desde o começo. A trilha não entra no commit. Ela volta para a Raiz junto com os avisos.
- **Constrói, prova e limpa.** Ele prova a mudança no artefato real. Avalia com ceticismo cada comentário do Bugbot, o robô da Cursor que revisa PRs no GitHub, limpa o diff com `/deslop` e tira os comentários do código com `/no-comments`.
- **Rebaseia na hora certa, no Autopilot-full.** Rebasear é reaplicar os commits da branch sobre a trunk atual, e a trunk é a `main`. O primeiro rebase vem antes do aviso de Code-ready. Nos consertos que a Raiz pede, a base não muda. Ele só rebaseia de novo no preparo do merge, num conflito com a trunk ou numa falha de CI causada por uma mudança na trunk. Para publicar um rebase, ele empurra a própria branch com `git push --force-with-lease`. Uma branch compartilhada ele nunca força.
- **Avisa a Raiz em dois momentos.** No Code-ready, o código a entregar está final, e o aviso leva o head, que é o último commit da branch. No Merge-ready, terminaram a prova dele, o CI (os testes automáticos do GitHub) e o babysit, que é acompanhar o PR até o CI ficar verde. Entre um aviso e outro, essas três coisas correm em paralelo com a verificação da Raiz. Ele também avisa o head de cada push posterior que muda o patch, que é o conteúdo da mudança.
- **Acompanha o próprio PR sem `/loop`, no Claude Code.** O playbook do Babysit manda acompanhar o PR dentro de um `/loop`. No Claude Code 2.1.285, um subagente em segundo plano não tem as ferramentas que o `/loop` usa (`ScheduleWakeup` e `CronCreate`). Por isso o Dono roda o vigia do PR, `scripts/watch-pr/watch-pr`, que espera sozinho até o PR chegar a um resultado final, e o roda de novo depois de cada push e de cada resultado em que ele age.
- **Anota os subagentes que cria.** O arquivo `children.tsv` guarda o ID, o tempo esperado e o estado de cada um. O tempo esperado é, no mínimo, o da execução mais longa já vista daquele tipo.
- **Mergeia, no Autopilot-full.** O merge é o único passo que o Dono não dá sozinho. Com o Veredito limpo da Raiz, ele rebaseia na trunk atual, avisa o head novo e espera o CI passar nesse head. O head novo anula o Veredito, a não ser que o patch-id seja o mesmo. O patch-id é um identificador do conteúdo da mudança, que não muda quando o rebase só reescreve os commits. Aí o Dono faz o squash merge do próprio PR, que junta os commits num só, e pega o próximo item independente da fila.
- **Não mergeia nem mexe na pilha, no Autopilot-stack.** Ele empurra só a própria branch e avisa STACK-READY quando o loop de babysit dele fica verde. Com o Veredito limpo, a Raiz põe o PR na pilha. Só a Raiz rebaseia e ordena a pilha.

### O que a Raiz confere antes do merge

A Raiz é dona dos Vereditos, nunca dos PRs. Ela verifica cada Rodada. Uma Rodada começa no head Code-ready do Dono e em cada push posterior que muda o patch do PR. Em cada Rodada a Raiz lança o Enxame pela skill `swarm`. O Enxame é um grupo de verificadores independentes que rodam em paralelo. Cada um é uma lane, isto é, uma execução de modelo com uma tarefa só. As lanes fazem quatro coisas:

- Rodam de novo os gates, que são as checagens do repositório, naquele head.
- Provam ao vivo o comportamento principal da mudança, usando de verdade o programa que ela muda. Para isso usam a skill que opera esse tipo de programa, como `run` em CLIs e `verify` em telas.
- Auditam o diff sem confiar no texto do PR. São duas ou mais lanes de revisão, cada uma com um foco.
- Rodam o mesmo cenário na trunk, para comparar. É a lane de regressão.

Uma lane externa não tem `run` nem `verify`. Lane externa é a que roda no runner, numa CLI que não é a do pai: o grok nos dois pais, o Codex no Claude Code e o Claude no Codex. O runner abre essa CLI com as skills desligadas e uma lista curta de ferramentas, e o grok ainda corta cada comando em 300 segundos. Por isso as lanes de gates, ao vivo e de regressão pedem, na sua folha de modelos, uma linha `swarm workers` nativa do pai. O padrão do plugin para essa linha é o grok. As suas folhas a trocam por um modelo nativo, Opus no Claude Code e Sol no Codex. Para ter o grok na auditoria (decisão D15), peça isso à Raiz quando der a fila. Ela põe o grok (`grok:grok-4.7@xhigh`) como braço de corrida nomeado numa das lanes que auditam o diff, como a skill `swarm` permite. Nenhum playbook nem a sua folha põem o grok lá sozinhos.

Mesmo numa lane nativa do Claude Code, o `verify` pode faltar. Você sempre pode digitar `/verify`. O agente só consegue chamá-lo quando ele aparece na lista de skills da sessão, e na versão 2.1.285 isso depende de um recurso que a Anthropic ainda libera aos poucos. Neste Mac ele não aparece: em 2026-10-01 a lista de skills de uma sessão trazia o `run` e não trazia o `verify`. Sem o `verify`, a lane de tela usa o `run`, que também opera apps Electron e apps de navegador, ou o driver que o repositório nomeia. Os seus dois repositórios não dependem do `verify`: o pstack-vic não tem tela e o Clinext tem o driver próprio, `verify-clinext`. O `run` e o `verify` são embutidos no Claude Code e não têm arquivo. Por isso, num plano, a caixa `<driver skill path>` leva o nome da skill, e a Raiz a lê carregando a skill. Um driver do repositório ela lê pelo caminho dele.

A Raiz junta os resultados num Veredito. Sem a lane ao vivo, o Veredito não é limpo. Sem Veredito limpo, não há merge. Os achados provados voltam ao Dono num só pedido de conserto. Para cada achado de comportamento, a Raiz pede um teste vermelho, isto é, um teste que falha enquanto o defeito existe. Onde nenhum teste mostra o defeito, ela pede um recibo de reprodução. O head novo ganha Enxame e Veredito novos. A exceção são os resultados que continuam válidos pela regra do patch-id do playbook [Shipping](../skills/poteto-mode/playbooks/shipping.md).

### O que a Raiz faz a cada 30 minutos

A cada 30 minutos, mais ou menos, a Raiz audita todos os Donos. Essa auditoria se chama Tick. Em cada Tick ela faz isto:

1. Relê o playbook, direto do plugin instalado, e relê o `/goal` armado. Confere a operação contra os dois e corrige o desvio no próprio Tick.
2. Sonda cada Dono, para saber se ele está vivo e em que estado está, e recolhe as trilhas de decisão.
3. Conta como progresso só o que deixou efeito: commits, pushes, mudanças no PR ou nos checks e relatórios gravados.
4. Trata como travada a lane que dá erro, ou que passa do tempo esperado sem deixar efeito. Ela derruba essa lane e põe outra no lugar na hora, sem esperar resposta.
5. Aplica o mesmo teste à lista de agentes do programa, onde o pai tem uma, e ao `children.tsv` de cada Dono. No Claude Code essa lista são os subagentes que a sessão criou. O Dono registra o subagente travado e o substitui, se o trabalho ainda faz falta. Quando o Dono não consegue, a Raiz faz as duas coisas. Uma lane travada não prova o trabalho nem o cancela.
6. Quando vários merges saem juntos, faz uma retrospectiva e uma varredura dos comentários que os robôs deixaram depois do merge.

O Tick só termina quando não sobra trabalho delegado, mesmo depois do último merge.

No Claude Code a Raiz arma o Tick como um `/loop` de verdade, em modo dinâmico. O `/loop` é o comando que chama a sessão de novo, e no modo dinâmico a própria sessão marca a próxima chamada. A cadência nunca fica por conta da memória da sessão. O Claude Code encerra qualquer `/loop` depois de 7 dias. Um programa mais longo que isso precisa de um Tick armado de novo.

Num programa que roda a partir de um plano, o Tick é silencioso. A Raiz só escreve no chat quando a auditoria achou uma mudança que nenhuma mensagem anterior relatou: um PR aberto, um head Code-ready, uma Rodada aberta ou fechada, um Veredito, um merge, um agente travado e o que foi feito, um bloqueio que entrou ou saiu, ou uma decisão que só você pode tomar. Sem novidade, o Tick termina sem texto. Nos dois casos a Raiz registra o Tick na trilha de decisões dela.

### O que você faz

Sua parte num programa é esta:

- **Dá o "go".** Depois deixa a sessão aberta até o último merge e a resposta final da Raiz.
- **Digita o `/goal` quando a Raiz pede.** No Claude Code, quando a sessão não tem a ferramenta `ProposeGoal` (neste Mac, em 2026-10-01, não tinha) ou o objetivo passa de 500 caracteres, a Raiz escreve a linha `/goal <objetivo>` exata e você a digita ([Como um programa começa](#como-um-programa-começa), passo 6).
- **Manda o Tick, no Codex.** Onde nenhuma tarefa agendada do Codex chama a sessão de volta, você manda o prompt do Tick a cada 30 minutos ([Limites no Codex](#limites-no-codex)).
- **Clica no merge dos seus itens.** O Dono leva um item seu até o Merge-ready e para ali. Quem revisa e clica no merge é você, e nenhum Dono mergeia um item seu. Num programa com plano, um PR que muda uma interação também espera você. As capturas de tela e um vídeo vão para o chat, e você revisa antes do merge.
- **Aprova o que a sua autorização não cobre.** Alguns limites o CI só deixa apertar, como um gate ou um orçamento fixado. Subir um limite desses pede o aval da Raiz (*countersign*), que ela só dá depois da prova de um verificador. Quando a sua autorização ou as suas ordens permanentes, que são as instruções que você deu para o programa todo, cobrem aprovações, o aval da Raiz é a aprovação, e o Dono a registra apontando para ele. Quando não cobrem, a aprovação continua sendo sua. A Raiz também nunca dá nem contorna uma aprovação que o GitHub exige. Absorver um valor que já entrou na `main` não conta como subir limite.
- **Manda parar quando quiser.** Um "para" seu chega na hora a todos os Donos como ordem de não escrever mais nada. Eles seguram o trabalho até você liberar.
- **Revisa e mergeia a pilha, no Autopilot-stack.** A entrega é uma cadeia de PRs verificados, cada um com o Veredito no corpo do PR ou num comentário. Você revisa de baixo para cima e mergeia com os seus cliques, ou arma o *merge-when-ready*, que no GitHub é o auto-merge.
- **Lê a resposta final.** No Autopilot-full ela traz a fila com o Dono, o estado e o head de cada PR, e cada Veredito com o Enxame que o produziu. Traz também o que foi mergeado, o que cada Dono pegou em seguida, os avais dados com o motivo de cada um, o que ainda espera você e onde estão as trilhas de decisão. No Autopilot-stack ela traz os links da base e da ponta da pilha, um resumo do Veredito de cada PR e o que ficou de fora, com o motivo.

O resto é da Raiz e dos Donos: build, PR, CI, verificação e, no Autopilot-full, o merge.

### PR aberto fora de um programa

Um PR do Dependabot, ou um que você abriu à mão, não tem Dono. Ninguém mexe nele até você decidir. Há dois caminhos:

- **Você mergeia.** Espere o CI ficar verde e clique no merge, ou rode `gh pr merge <número> --squash`.
- **Um programa adota o PR.** Ao pedir o programa, cite o PR como um item da fila. A Raiz cria um Dono para ele, como para qualquer item, e valem as mesmas regras: Rodada do Enxame, Veredito limpo e, no Autopilot-full, merge pelo Dono. Os playbooks não têm um passo separado de adoção. Adotar é pôr o PR na fila. Se você quer clicar no merge, diga que o item é seu.

### O que mudou em relação ao fluxo antigo

Até a 0.4.19 o plugin tinha um fluxo próprio, em que um robô no Mac conferia e mergeava PRs sozinho, mesmo com todas as sessões fechadas. A 0.5.0 aposentou esse fluxo. A decisão está no ADR 0005, em [`docs/adr/`](adr/). Os documentos antigos estão em [`docs/arquivo/`](arquivo/), só como história. Para você, mudou isto:

- **Nada mergeia sozinho.** Não existe mais robô de madrugada. Um PR só anda enquanto uma sessão sua, a Raiz, está aberta rodando um programa.
- **A sessão da Raiz fica aberta até o fim do programa.** Se você fechar a sessão, os Donos param. Nada acontece até você abrir de novo e retomar.
- **PR aberto fora de um programa espera.** Ou você mergeia, ou um programa o adota como item da fila ([PR aberto fora de um programa](#pr-aberto-fora-de-um-programa)).
- **O GitHub só exige o CI.** Os checks `verdict` e `hold` saíram das regras, e um rótulo no PR não trava mais nada. O que segura um merge é o Veredito da Raiz, dentro da sessão. Para ficar com um PR, diga isso na sessão.
- **A versão sai em dois passos.** O CI cria a tag. Trocar o plugin nos dois pais é um comando seu no Mac ([Publicar uma versão](#publicar-uma-versão)).
- **No Codex não há relógio interno.** Você mesmo pede o Tick a cada 30 minutos. O Codex também precisa de `multi_agent` ligado para ter Donos e de `goals` ligado para armar o `/goal` ([Limites no Codex](#limites-no-codex)).

### Limites no Codex

No Codex o programa segue os mesmos playbooks. Mudam cinco coisas, que estão em [`codex-tools.md`](../skills/poteto-mode/references/codex-tools.md):

- **Não há `/loop`.** O Codex não tem um `/loop` que chame a sessão de volta. Onde nenhuma tarefa agendada do Codex faz isso, quem dá a cadência do Tick é você. A Raiz avisa isso quando declara o protocolo. Você manda o prompt do Tick a cada 30 minutos, e ela roda um Tick inteiro a cada envio.
- **Os Donos precisam de `multi_agent`.** No Codex o Dono é um `spawn_agent`, que é a ferramenta de criar subagentes. Ela só funciona com `multi_agent = true` em `~/.codex/config.toml` ([Instalação, Codex](#codex)). Sem isso não há Donos.
- **O `/goal` precisa do recurso `goals`.** No Codex a Raiz arma o `/goal` com a ferramenta `create_goal`. Ela só existe com `goals = true` em `[features]` no `~/.codex/config.toml` e numa sessão que o Codex guarda.
- **A Raiz cria o worktree antes.** O `spawn_agent` não cria worktree. A Raiz cria um com `git worktree add` e passa o caminho ao Dono.
- **Não há `run` nem `verify`.** A lane ao vivo roda o app pelo shell. Para uma tela, ela usa a automação que tiver ou entrega a você uma checagem manual concreta.

A conferência antes do "go" usa o mesmo script com `--parent codex`. Ela sai com 0 quando `approval_policy = "never"` está no topo do `~/.codex/config.toml`. Com outro valor, o Codex interrompe o programa e pede aprovação.

### Autorização permanente

A autorização permanente é uma entrada que você grava uma vez em `autoMode.allow`, no seu `~/.claude/settings.json`. Sem ela, o modo automático do Claude Code nega o merge quando o Dono ou a sessão do Shipping chega nele.

Nos playbooks do pstack, um agente mergeia um PR que nenhum humano aprovou em dois casos:

- O Dono de um PR num programa de autopilot mergeia depois do Veredito limpo do Enxame da Raiz. Quem dá esse Veredito são verificadores que não escreveram o código.
- A sessão que roda o playbook Shipping mergeia depois do veredito do verificador independente daquele PR.

O modo automático do Claude Code bloqueia esses merges de fábrica, pelas regras "Merge Without Review" e "Self-Approval". O classificador dele lê as mensagens do usuário e os comandos, e não lê as perguntas do agente. Por isso um "ok" a uma pergunta não autoriza nada, e o modo automático nega o merge. O Claude Code não lê `autoMode.allow` de nenhum repositório nem de plugin, então o plugin não entrega a entrada.

```shell
AUTHORIZE=~/.claude/plugins/cache/pstack-vic/pstack/<versão>/skills/setup-pstack/scripts/authorize.ts
node $AUTHORIZE check --parent claude
node $AUTHORIZE apply --parent claude
node $AUTHORIZE check --parent codex
```

Troque `<versão>` pela versão instalada. O primeiro comando confere o Claude Code. Ele sai com 0 quando a autorização está gravada e com 1 quando não está, e o JSON que ele imprime traz o motivo, a entrada e o comando. O segundo grava a autorização e só roda num terminal. Ele mostra a entrada, pede um "yes" digitado e grava. O terceiro confere o Codex. Ele sai com 0 quando `approval_policy = "never"` está no topo do `~/.codex/config.toml`.

A entrada vale em qualquer repositório. Ela cobre três coisas:

- O merge com `gh pr merge` nesses dois casos, por squash ou com `--auto` quando o playbook ou você pede.
- O trabalho da Raiz de criar subagentes Donos e verificadores, empurrar as branches dos Donos com `--force-with-lease` e publicar Vereditos como comentários no PR.
- O lançamento, pelo `pstack-runner`, das lanes que os playbooks nomeiam (Dono, verificador, revisor, juiz ou worker em claude, codex ou grok).

Continuam bloqueados:

- `--admin` e qualquer outro desvio de um check obrigatório.
- Mudança em proteção de branch, em rulesets ou em checks obrigatórios.
- Tudo o que as outras regras protegem: arquivos, branches e histórico destruídos, produção, segredos e dados enviados para fora.

Fora de um terminal, o `apply` recusa, porque a autorização é um ato seu e não do agente. Ele mantém as regras de fábrica (`"$defaults"`) e todas as outras configurações, e copia o arquivo anterior para `settings.json.before-pstack-authorization`. Para retirar a autorização, apague a entrada.

A entrada traz a versão no nome (`pstack standing authorization v2`). Se você tem a v1, do fluxo antigo, rode o `apply` de novo. Ele troca a entrada no lugar. Até lá, o `check` sai com 1. Nenhum playbook roda o `check`, então quem confere é você. O passo 10 do `/setup-pstack` roda o `check`. Rode-o também antes do "go" de um programa de autopilot, quando a Raiz declara o protocolo ([Como um programa começa](#como-um-programa-começa), passo 5).

### De onde vem o texto dos playbooks

Seis playbooks são o texto da Cursor mais uma tabela de trocas. São eles `autopilot-full`, `autopilot-stack`, `babysit`, `opening-a-pr`, `shipping` e `multi-phase-plan`. Cada troca tira um termo que só existe na Cursor e põe o equivalente do Claude Code ou do Codex. A tabela está em [`upstream-substitutions.json`](../skills/poteto-mode/references/upstream-substitutions.json), com o motivo de cada linha. Ninguém edita esses seis arquivos à mão. Para mudar uma frase, mude uma troca na tabela e rode `node scripts/upstream-parity.ts --write`, que gera os seis de novo. O `npm test` roda `node scripts/upstream-parity.ts check`. Esse comando refaz os seis a partir do commit da Cursor anotado em [`UPSTREAM.md`](../UPSTREAM.md) e compara com o que está no repositório. Ele falha quando um arquivo tem uma frase que não é da Cursor nem da tabela. Também falha quando uma troca da tabela não encontra mais o texto dela na Cursor.

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
| `update-clis` | atualizar `claude`, `codex` e `grok` só quando o plugin continua funcionando na versão nova: notas contra os pontos de contato, instalação, sonda real, volta e contraprova; o que não passa fica segurado numa issue do Linear |
| `setup-pstack` | escolher modelo e effort por papel (a mesma família pode rodar em efforts diferentes em papéis diferentes); probe de cada par família+effort e escrita do sheet pelo `scripts/setup-pstack.ts` (rerun byte-idêntico, nada escrito se um probe falha); o passo 10 confere, pelo `scripts/authorize.ts`, a autorização permanente que o autopilot e o playbook Shipping exigem |
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
npm test
npm run test:bun       # orch e watch-pr no Bun: bun install --frozen-lockfile, bun test e o typecheck do watch-pr (precisa do bun no PATH)
npm run matrix:check   # blocos gerados de provider-dispatch.md e setup-pstack em dia
npm run agents:check   # agents/pstack-*.md em dia com a matriz
npm run collision:check
npm run upstream:digest -- --no-fetch   # digest dos dois upstreams desde o ponto de sync (UPSTREAM.md, seção Digest semanal)
node scripts/upstream-parity.ts check
npm run setup-pstack -- --help   # subcomandos do setup: state, plan, probe, attest, write
npm run update-clis -- --help    # subcomandos da atualização das CLIs: start, check, notes, install, probe, finish
claude plugin validate --strict .   # manifest do plugin e do marketplace pelo validador do Claude Code
```

O `npm test` roda os testes da matriz, do gerador de agents, do runner, do setup-pstack, do update-clis, da referência de skills, dos manifests e do hook, do digest dos upstreams, da paridade dos playbooks do autopilot com a Cursor, do verificador de planos (`check-plan.mjs`) contra o molde do `multi-phase-plan.md` gerado, do release e dos invariantes do pacote. O `node scripts/upstream-parity.ts check` roda só a paridade: confere que os seis playbooks do autopilot são o texto da Cursor mais as trocas de `upstream-substitutions.json`.

`tests/skill-collision-repro.sh` verifica os invariantes estáticos do pacote (sem camada `commands/`, `principle-*` ocultos e legíveis pelo modelo, skills de fluxo sem `disable-model-invocation`, nome do diretório igual ao `name`, versão única entre manifests, tag do marketplace e `package.json`, logo do Codex resolvendo, aliases móveis de Fable e Opus, vínculo do Bugbot entre a skill `babysit` e o playbook, playbooks sem comandos Graphite, conteúdo Cursor-only ausente). Com `PSTACK_BEHAVIORAL=1` ele também monta um plugin de uma skill e prova, com `claude -p`, que a invocação pela tool `Skill` e pelo `/comando` chegam à skill.

O teste de paridade lê o commit da Cursor anotado em `UPSTREAM.md`, e esse commit precisa estar no clone. O CI busca o remote `cursor` antes do `npm test`. Num clone sem o commit, o teste falha com a mensagem `fetch the cursor remote first: git fetch --no-tags cursor main`. Ele falha em vez de pular, porque um teste pulado esconderia uma frase fora da tabela. Para resolver, registre o remote uma vez com `git remote add cursor https://github.com/cursor/plugins.git` e rode `git fetch --no-tags cursor main`. A seção *Checar mudanças* do `UPSTREAM.md` tem os quatro comandos que registram os dois remotes.

## O que ficou de fora

- **`skills/make-bot-ui`** — construída sobre rotinas, webhooks e UI da Cursor; não há mapeamento comum Claude Code / Codex.
- **`automations/benny/`** — pacote dormente de automações Slack sobre o runtime de eventos da Cursor. Não registrava skills nem no original.
- **`docs/guide/`** — tutorial de dez capítulos que ensina pstack pela UI da Cursor, sticky mode e cloud agents (2,3 MB de imagens). Leia no original em [cursor/plugins/pstack/docs/guide](https://github.com/cursor/plugins/tree/main/pstack/docs/guide); os conceitos mapeiam pela tabela de substituições de `CHANGES.md`.
- **Sticky mode** — frontmatter `mode`/`icon`/`color`/`reminder` só da Cursor. Fica o opt-in: `poteto-mode` só entra por comando do usuário, como no original.
- **Resto do `cursor-team-kit`** — `control-cli`/`control-ui` viraram `run`/`verify`; `verify-this` e `check-compiler-errors` duplicam built-ins; `loop-on-ci`, `review-and-ship`, `weekly-review` sobrepõem `babysit`, `fix-ci`, `make-pr-easy-to-review` e `what-did-i-get-done`; `pr-review-canvas` é UI da Cursor.
- **`README.md` da Cursor** — substituído por um README do port; o original está no histórico (`git show 91e5b82:README.md`) e no upstream.

## Licença

MIT. Três arquivos de licença preservados: [`LICENSE`](../LICENSE) (pstack, Lauren Tan), [`LICENSE-open-pstack`](../LICENSE-open-pstack) (open-pstack, Eric Litman) e [`LICENSE-cursor-team-kit`](../LICENSE-cursor-team-kit) (Cursor; cobre `deslop`, `thermo-nuclear-code-quality-review`, `make-pr-easy-to-review`, `fix-ci`, `fix-merge-conflicts`, `get-pr-comments` e `what-did-i-get-done`).

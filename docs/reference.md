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

`poteto-mode` é um modo que você liga com `/pstack:poteto-mode`. A skill tem `disable-model-invocation: true`, como no original da Cursor, então o modelo não entra nela sozinho, nem num bug fix. O plugin não registra hook. Até a 0.1.4, um hook SessionStart copiado do open-pstack mandava toda tarefa de engenharia não trivial entrar por `poteto-mode`; saiu na 0.1.5 ([`CHANGES.md`](../CHANGES.md)).

### Codex

```shell
codex plugin marketplace add byvict/pstack-vic --ref v0.4.14
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

Rode `/setup-pstack` uma vez em cada pai para escrever o sheet de modelos (`~/.claude/pstack-models.md` e `~/.codex/pstack-models.md`). O último passo dele confere a [autorização permanente](#autorização-permanente) do Pré-PR. Depois, `/poteto-mode` é o ponto de entrada para qualquer tarefa que peça rigor.

### Publicar uma versão

A versão do pstack-vic é independente das versões dos upstreams ([`UPSTREAM.md`](../UPSTREAM.md)). Ela vive em quatro lugares que `npm test` obriga a concordar: `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json` (`version` e `ref: vX.Y.Z`) e `package.json`. O `--ref vX.Y.Z` do README e desta página acompanha. Publicar é subir a versão nos quatro, `npm test` e levar o PR pelo Pré-PR até o arm. Depois do merge, a release roda sozinha pelo bloco `postMerge` do `.cursor/converge.json`: quando o CI de push do commit do merge fica verde, o Varredor roda `node scripts/after-merge.ts` num worktree descartável do commit (pelo `node` direto, não pelo `npm run`, que poria diretórios `node_modules/.bin` na frente do `PATH` que o `install` grava nos jobs). O script cria a tag `vX.Y.Z` nesse commit e empurra só ela (`git push origin refs/tags/vX.Y.Z`), atualiza o plugin no Claude Code e no Codex, com cópia do `~/.codex/config.toml` em `config.toml.pre-X.Y.Z`, e, sem Raiz rodando, lança `converge-local install --when-idle` a partir do cache novo, solto do tick, e sai 75. O tick seguinte, já na versão nova, confere os três jobs e grava a release como feita. Um commit que não é a ponta da `main` só ganha a tag, porque o marketplace do Claude Code segue a `main` e instalaria a versão mais nova; o commit seguinte da fila instala. Cada passo confere o que já foi feito antes de agir, então rodar duas vezes não estraga nada. Um comando que falha (sem rede, GitHub fora do ar) ou um plugin que aparece em outra versão faz o script sair 75, e o tick seguinte tenta de novo; só uma tag local apontando para outro commit é falha. Nunca `git push --tags`: os remotes `cursor` e `open` são só leitura (`tagOpt --no-tags`) e este repo não reexporta tags deles. Se o pós-merge falhar ou o Daemon estiver parado, o caminho manual faz o mesmo: `git tag vX.Y.Z <commit do merge>`, `git push origin refs/tags/vX.Y.Z`, `claude plugin marketplace update pstack-vic && claude plugin update pstack@pstack-vic`, no Codex `plugin remove`, `marketplace remove`, `marketplace add byvict/pstack-vic --ref vX.Y.Z` e `plugin add`, e `node ~/.claude/plugins/cache/pstack-vic/pstack/X.Y.Z/skills/poteto-mode/scripts/converge/converge-local install --when-idle`. Ou rode `converge-local post-merge --repo byvict/pstack-vic --commit <sha>`, que passa pelo mesmo caminho do Varredor.

## Layout

```text
.
├── .claude-plugin/                   # plugin.json (manifest do Claude Code) e marketplace.json (um plugin, fonte fixada na tag)
├── .codex-plugin/plugin.json         # manifest do Codex (skills: ./skills/, interface com logo)
├── .agents/plugins/marketplace.json  # marketplace do Codex (fonte local ./)
├── model-matrix.json                 # famílias, efforts, pais, rota por pai, papéis (dado canônico)
├── scripts/                          # loader/validação da matriz, render dos blocos gerados, gerador de agents, digest semanal dos upstreams, testes (inclui manifests.test.ts)
├── skills/                           # 55 skills compartilhadas por Claude Code e Codex
│   ├── poteto-mode/agents/           # openai.yaml: no Codex, poteto-mode só por invocação explícita
│   ├── poteto-mode/references/       # provider-dispatch.md (rota e papéis), codex-tools.md (mapa de tools), bugbot-triage.md
│   ├── poteto-mode/scripts/          # runner externo (Node 24, com probe-lane.ts, a sonda de uma lane), watch-pr, orch, check-plan.mjs, worktree-audit.sh
│   ├── setup-pstack/scripts/         # setup-pstack.ts: estado, plano, probe, atestado e escrita do sheet (Node 24); authorize.ts: a autorização permanente do Pré-PR
│   └── update-clis/                  # scripts/update-clis.ts (check, notes, install, probe) e references/cli-touchpoints.json
├── agents/                           # poteto-agent, comment-sicko e as lanes nativas pstack-<família>-<effort> geradas da matriz
├── assets/                           # logo
├── docs/reference.md                 # esta referência
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

- **Node 24** — the external runner, the matrix scripts, `check-plan.mjs`, and `npm test` run TypeScript directly, with no build step and no Bun.
- **CLIs `claude`, `codex` e `grok`** — autenticados, só os que o sheet de modelos usa. O runner recusa provider igual ao do pai (essa lane é nativa). A versão delas muda só pela skill `update-clis` (seção [Versões das CLIs](#versões-das-clis)).
- **`CURSOR_API_KEY`** — só para o provider `cursor` (lanes http na API de cloud agents da Cursor; famílias da tabela gerada em `provider-dispatch.md`). Sem a variável a lane cai como dropout `unavailable-cli` (exit 69). Lanes http exigem `--repo` e `--pr`; veja a seção *HTTP lanes* de `provider-dispatch.md`.
- **`gh`** — forge padrão dos playbooks de PR e da skill `babysit`; `origin` é usado quando resolve o repositório; `gt` só no playbook Orchestrate. A skill `update-clis` também o usa para ler as releases do codex.
- **`lsof`** — só para `update-clis`, que o usa para saber se alguém está rodando a CLI que ela trocaria.
- **`bun`** — only for `watch-pr` and `orch`, which came from Cursor unchanged, and for their tests and the `watch-pr` typecheck (`npm run test:bun`).
- **`jq` e `rg`** — só para `worktree-audit.sh` (playbook Worktree cleanup); sem eles o audit avisa e deixa colunas em branco.
- **`run`, `verify`, `loop`** — built-ins do Claude Code; **`skill-creator`** — skill oficial da Anthropic para autoria de SKILL.md. Os quatro têm substituto em `codex-tools.md`.

## Probes HTTP

Quando o plano de setup contém um par HTTP, `probe` recebe o PR autorizado em `--repo <owner/name> --pr <number>`. Os dois argumentos são obrigatórios nesse caso. Um plano sem pares HTTP recusa esses argumentos. O destino vale para essa execução e não fica salvo no plano nem no sheet. Em um plano misto, somente os filhos HTTP recebem o destino.

```shell
npm run setup-pstack -- probe --dir <dir> --repo <owner/name> --pr <number>
```

O provider Cursor requer `CURSOR_API_KEY` e acesso de leitura ao remoto Git. O recibo registra `remote.heads` como `not-taken`, `unverified` com motivo ou `observed` com `changedBranches`. A comparação observa branches adicionadas, movidas ou removidas durante a execução. Ela não identifica quem fez essas alterações. Uma lane read-only falha se houver alteração observada ou se a comparação não puder ser concluída. A seção [HTTP lanes](../skills/poteto-mode/references/provider-dispatch.md#http-lanes) define o contrato completo do recibo.

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

## Converge

A Raiz certifica o head antes de o PR existir, pelo [playbook Pré-PR](../skills/poteto-mode/playbooks/pre-pr.md): Corridas, Revisor pré-PR de uma Família fora da lista de Autores, voltas do Ajustador e, quando o contrato pede, o Certificador. Desde a 0.4.7, uma mudança cujos caminhos estão todos no `prePr.light` do contrato, ou que só sobe dependência, segue a Classe leve: Corridas e Revisor com prompt estreito, sem Certificador, Certificado `Light` ([ADR 0004](adr/0004-classe-leve-por-caminho.md)). A metade **Entregar** do mesmo playbook abre o PR, publica o Certificado e arma o auto-merge com `--pending`; quem mergeia é o GitHub, quando os checks obrigatórios passam. O que a Raiz não vê depois de encerrar fica com o Daemon, o `converge-local`, desde a 0.4.0: o Varredor arma o que está certificado e, depois do merge, roda o Pós-merge do repositório, e o job da Raiz lança uma Raiz sem supervisão que roda o [playbook Catch-up](../skills/poteto-mode/playbooks/catch-up.md) para reparar, recertificar ou certificar um PR aberto. O [playbook Converge](../skills/poteto-mode/playbooks/converge.md) descreve os três jobs, o [contrato Converge](../skills/poteto-mode/references/converge-contract.md) define Certificado, gate, publicação e varredura, e o [ADR 0003](adr/0003-converge-sem-nuvem.md) registra a saída da nuvem. O owner do Cursor na nuvem, o `start.ts` e as Automations estão aposentados; a 0.5.0 remove o código.

Configuração em `~/.config/pstack/converge-local.json`:

```json
{
  "parent": "claude",
  "repos": [
    { "repo": "byvict/pstack-vic", "checkout": "/Users/victorbaccega/Dev/Skills/pstack-vic" }
  ],
  "intervalMinutes": 10,
  "trustedAuthors": ["dependabot[bot]"]
}
```

`trustedAuthors` completa a lista de confiança do job da Raiz. A conta autenticada do `gh` é sempre confiável e não precisa estar nela. Liste, pelo login do GitHub (`[bot]` no fim para um app), os bots cujos PRs e comentários o Daemon pode entregar a uma Raiz, como o `dependabot[bot]`; a comparação ignora maiúsculas e minúsculas. Listar um bot é confiar no texto que ele repassa, como as release notes, o changelog e os assuntos de commit que o Dependabot põe no PR. O job da Raiz pula um PR cujo autor está fora da lista (`untrusted author: LOGIN`) e, quando haveria trabalho nele, um PR com comentário, comentário de review ou review de alguém de fora (`untrusted commenter: LOGIN`, `untrusted reviewer: LOGIN`). Esconder (minimizar) o comentário de alguém de fora não desfaz o pulo, porque a API do GitHub continua devolvendo o comentário; apagá-lo ou listar o login desfaz. O Daemon não confere quem empurra commits nem quem edita o corpo do PR, porque isso exige escrita no repositório, e a lista só limita quem põe texto na frente de uma Raiz sem escrita e sem um bot listado que o repasse.

```shell
CONVERGE_LOCAL=~/.claude/plugins/cache/pstack-vic/pstack/<versão>/skills/poteto-mode/scripts/converge/converge-local
node $CONVERGE_LOCAL install
node $CONVERGE_LOCAL install --when-idle
node $CONVERGE_LOCAL status
node $CONVERGE_LOCAL tick --job raiz --dry-run
node $CONVERGE_LOCAL tick --job watch --dry-run
node $CONVERGE_LOCAL run --repo byvict/pstack-vic --pr <n> --dry-run
node $CONVERGE_LOCAL post-merge --repo byvict/pstack-vic --commit <sha> --dry-run
node $CONVERGE_LOCAL nudge
node $CONVERGE_LOCAL uninstall
```

`install` grava e carrega três jobs em `~/Library/LaunchAgents`, todos rodando o `converge-local` do `pluginDir` da configuração (por padrão, o plugin de onde você rodou o `install`): `com.pstack.converge-sweep` e `com.pstack.converge-raiz`, a cada `intervalMinutes` e sempre que `~/Library/Application Support/pstack/converge-local/wake/<job>/` tiver um arquivo, e `com.pstack.converge-watch`, o Vigia, a cada 60 segundos. Esse arquivo é a campainha: `converge-local nudge` deixa um para cada job (`--job sweep` ou `--job raiz` para um só), os playbooks Pré-PR, Babysit e Shipping tocam logo depois de liberar a Posse, e um tick que lançou uma Raiz toca para os dois jobs ao terminar, para o próximo PR e para o Varredor armar o que ficou certificado. O tick apaga os arquivos do próprio job antes de qualquer leitura e grava quantos eram em `wakes` do `last-tick-<job>.json`. O Vigia toca a campainha pelo que muda no GitHub sem ninguém no Mac: PR do Dependabot, check que termina ou fica vermelho, `main` que fica verde, Hold tirado no GitHub. A cada minuto ele pergunta ao GitHub, só com GET condicional (`If-None-Match`), se mudaram a lista de PRs abertos de cada repositório, os checks da ponta da `main` e os checks do head de cada PR aberto. A lista mudou (PR aberto ou fechado, head novo, rótulo, draft, comentário): acorda os dois jobs. Os checks da `main` mudaram: acorda o Varredor. Os checks de um head mudaram: acorda o job da Raiz. Um 304 não gasta o limite de chamadas do GitHub, então, enquanto nada muda, um repositório sem PR aberto custa uma chamada do `gh` por minuto, e um com N PRs abertos custa 2 + N, sem gastar limite. O Vigia nunca lança modelo nem escreve no GitHub; guarda as ETags em `~/Library/Application Support/pstack/converge-local/watch/<owner>-<repo>.json`, e o primeiro tick depois do `install` só guarda, sem acordar ninguém. Um tick do Vigia que não mudou nada nem falhou não escreve no log (seriam 1.440 por dia); o `last-tick-watch.json` mostra `reads`, `changed` e `woken` do último. O intervalo de 10 minutos fica como rede de segurança para o que o Vigia não vê, como um `verdict` publicado sem campainha, e para um minuto em que o Vigia falhou. Rode o `install` do plugin instalado, como nos comandos acima, com `<versão>` trocada pela versão instalada, e deixe `pluginDir` fora da configuração. Assim os jobs e o `--plugin-dir` da Raiz rodam código publicado, nunca um checkout que pode estar em outra branch. Com `parent` `codex`, o caminho é o mesmo sob `~/.codex/plugins/cache/`. Rode o `install` de novo depois de cada atualização do plugin, para levar os jobs à versão nova. O Claude Code guarda o diretório da versão anterior, então a versão velha segue rodando até lá. O cache do Codex guarda só a versão atual, então, com `parent` `codex`, os jobs saem 1 em todo tick, sem tocar nenhum PR, até o `install` rodar de novo. Antes do `install`, rode o `/setup-pstack` para pôr a linha `converge raiz` no sheet do `parent`: sem uma linha válida, o `install` recusa. Ele só instala a partir do arquivo padrão acima e recusa outro `--config`, porque os comandos `converge-local lease` dos playbooks leem a configuração padrão. `lease` e `release` funcionam sem esse arquivo, no diretório de estado padrão, então uma sessão interativa toma a Posse com ou sem Daemon configurado. Todo caminho da configuração é absoluto: o JSON não expande `~`, e um caminho relativo é recusado. O launchd começa um job com um `PATH` mínimo, e o zsh não interativo não lê o `~/.zshrc`, onde o nvm põe `node` e `claude`. Por isso cada job grava o `PATH` do shell que rodou o `install` e o caminho absoluto do `node` desse shell, e roda por `/bin/zsh -c`. Esse zsh lê o `~/.zshenv`, que exporta o token das lanes, e, como não é shell de login, não passa pelo `path_helper` do `/etc/zprofile`, que poria os diretórios do sistema na frente do `PATH` gravado. O `install` recusa quando o `gh` ou a CLI do `parent` não está nesse `PATH`. Rode o `install` de novo depois que o `node` ou uma CLI mudar de lugar, como numa versão nova do nvm. O Varredor roda o `converge-sweep` por script. O job da Raiz classifica os PRs abertos e lança uma Raiz por tick pela linha `converge raiz` do sheet do `parent`, com permissão total, para rodar o playbook Catch-up. Um PR sem Certificado e sem Posse entra na fila quando o check de testes do head (`tests.job` do contrato) terminou, com qualquer conclusão, ou quando o PR completa 30 minutos; a Posse, não a idade, é o que mantém o Daemon longe de uma branch que uma sessão está certificando. Depois do arm, o PR é do Daemon, nunca do Auto-fix do app de desktop: check obrigatório vermelho é `repair`; conflito com a `main` e toda recusa do portão que um Certificado novo cura (política da `main` que mudou, comentário do veredito apagado ou superado) são `recertify`; comentário ou revisão postado depois do veredito faz o Varredor desarmar e vira `respond`, uma Resposta: a Raiz tria cada texto contra o código, conserta com prova red-first ou responde com a refutação, e certifica de novo. Os comentários do próprio fluxo pela conta de Victor começam com `<!-- converge:note -->` e não contam como texto novo; qualquer outro texto dessa conta é de Victor e conta. Três tetos seguram um head com o Hold, um comentário e uma notificação do macOS (`Held <owner>/<repo>#<pr>: <motivo>`): duas tentativas falhas no head, três tentativas adiadas (`deferred`) no head, ou seis horas desde a primeira tentativa sem nenhuma certificada; tirar o rótulo deixa o Daemon tentar de novo. O mesmo Hold vem na hora quando alguém fora da lista confiável comentou ou revisou um PR com trabalho (o comentário diz para apagar o texto ou pôr o login em `trustedAuthors`), e numa Trava: PR armado que não mergeou em 2 horas (o motivo diz o que o GitHub espera, como um check `hold` que nunca rodou) ou a mesma recusa do portão por 1 hora. O relógio de cada Trava fica em `~/Library/Application Support/pstack/converge-local/waiting/<owner>-<repo>/<pr>.json`, recomeça num head novo e some quando o PR anda; o `status` mostra os relógios em `waiting`. Depois de uma tentativa adiada, o Daemon espera 30 minutos antes de lançar outra no mesmo head. Uma Raiz que não sobe, ou que termina sem resultado em menos de dois minutos, não conta como tentativa: o tick sai 1 e não toca o PR, porque isso é problema da máquina (login, cota, CLI que mudou de lugar). O ledger do head guarda essas falhas de lançamento; a partir da terceira desde a última tentativa registrada, o Daemon espera uma hora depois da última antes de lançar de novo nesse head, cada tick que chega ao PR nesse meio-tempo reporta a espera como erro, e os outros PRs seguem recebendo os ticks. Para lançar antes da hora, depois de consertar a máquina, apague o ledger do PR, `~/Library/Application Support/pstack/converge-local/ledger/<owner>-<repo>/<pr>.json`: o tick seguinte começa um ledger novo, que também esquece as tentativas do head, e os tetos recomeçam do zero. Senão, espere a hora passar; o `run` também respeita a espera. Cada erro do tick sai também no stderr, uma linha por erro, e cada tick real grava como terminou em `last-tick-<job>.json`, que o `status` mostra. Logs em `~/Library/Logs/pstack-converge-*.log`; posses e ledgers em `~/Library/Application Support/pstack/converge-local/`; diretório de corrida de cada tentativa sob `$TMPDIR/converge-local/`. `converge-local tick --job raiz --dry-run` mostra a classificação até o primeiro PR com trabalho, sem gravar nem lançar nada. Os comandos `converge-certify`, `converge-reconcile`, `publish.ts`, `converge-arm --pending` e `converge-sweep` continuam como o contrato descreve.

O Varredor também roda o Pós-merge. Quando o `.cursor/converge.json` da `main` tem o bloco `postMerge` (`{ "runs": [{ "name", "command" }], "after": "tests" }`), depois da varredura de cada repositório ele roda esses comandos uma vez por commit novo da `main`, do mais antigo para o mais novo, cada commit num worktree descartável (`$TMPDIR/converge-local/post-merge/`), nunca no checkout primário. Com `after: "tests"`, o padrão, um commit espera o CI de push dele ficar verde; o Vigia continua lendo os checks da `main` mesmo sem PR aberto, então o Varredor acorda em até um minuto depois disso. O primeiro tick depois de o bloco aparecer só anota a ponta da `main`, sem rodar o passado. O comando recebe `PSTACK_REPO`, `PSTACK_COMMIT`, `PSTACK_PR`, `PSTACK_CHECKOUT` e `PSTACK_PLUGIN_DIR` e tem 20 minutos. Saída 0 é feito; 75 é "ainda não", e o próximo tick tenta de novo, por até 24 horas; qualquer outra saída é falha. Numa falha, a fila daquele repositório para naquele commit, o Daemon comenta uma vez no PR mergeado com os caminhos dos logs, e o erro aparece em todo tick e no `status` até você apagar o registro do commit (`~/Library/Application Support/pstack/converge-local/post-merge/<owner>-<repo>/<sha>.json`) ou rodar `converge-local post-merge --repo R --commit SHA`, que roda o mesmo caminho à mão. O comando pode rodar duas vezes depois de uma queda, então precisa aguentar isso. O comentário sai pela conta do `gh`, que costuma ser a autora do PR, e o GitHub não avisa ninguém do próprio comentário; por isso, logo depois do comentário, o Daemon mostra uma notificação do macOS: `Post-merge stopped on commit <8 primeiros do sha>: <motivo> (PR #N)`, sem o PR quando o commit não veio de um. Tirar o bloco do contrato faz o Varredor esquecer a ponta anotada, então recolocá-lo depois começa de novo pela primeira volta, sem repetir o passado. O Daemon roda esses comandos com permissão total no Mac, como já roda o `prePr.runs`: quem escreve na `main` já tem esse poder. O que roda no GitHub (deploy, pacote, a tag de outro projeto) fica num workflow de push na `main`. `install --when-idle` espera o Varredor e o job da Raiz pararem antes de recarregar os jobs, para o `bootout` não matar um tick nem uma Raiz; é assim que o pós-merge do pstack-vic reinstala o Daemon, e serve também para a reinstalação à mão.

As notificações do Daemon aparecem na Central de Notificações deste Mac, com o título `Converge local` e o repositório embaixo, pelo `osascript`, que já vem no macOS. Saem uma vez por falha registrada do Pós-merge, uma vez por Hold e uma vez por commit vermelho da `main` (`Trunk red at <8 do sha>: <motivo> (PR #N)`), depois do registro e do comentário, e cada uma tem no máximo 10 segundos, então nunca atrasa o tick. O commit vermelho é o que a fila do Pós-merge espera, num repositório com bloco `postMerge`, ou a ponta da `main`, num repositório sem ele, como o Clinext; o registro fica em `~/Library/Application Support/pstack/converge-local/red-trunk/<owner>-<repo>/<sha>.json`, gravado antes da notificação. O erro que se repete a cada tick não notifica de novo. Um commit adiado (saída 75) só notifica quando vira falha, depois de 24 horas. Os erros que se repetem sem registro de falha (checkout que falha, mais de 50 commits acumulados, ponta que não descende, arquivo ilegível) ficam só no stderr, no `status` e no log, porque não há registro onde marcar que já avisaram. O macOS mostra o remetente como Script Editor, o app dono do `osascript`. Para desligar, ou para escolher o estilo Alertas, que fica na tela até você fechar, use Ajustes do Sistema > Notificações > Script Editor; a configuração do Daemon não tem campo para isso. Se a notificação falhar (`osascript` fora do `PATH`, erro, 10 segundos estourados), o tick reporta `notification failed` e segue; a falha ou o Hold continuam registrados do mesmo jeito. Fora do Mac, a notificação espera na Central; um Foco a segura até acabar.

### Autorização permanente

O pstack mergeia um PR que outra Família de modelo revisou e que nenhum humano aprovou. O modo automático do Claude Code bloqueia isso de fábrica (regras "Merge Without Review" e "Self-Approval"), e o verificador dele lê as mensagens do usuário e os comandos, não as perguntas do agente: um "ok" a uma pergunta não autoriza nada, e o Pré-PR parava no meio. O operador grava a decisão uma vez, numa entrada de `autoMode.allow` no `~/.claude/settings.json` dele. O Claude Code não lê essa lista de nenhum repositório nem de plugin, então o plugin não a entrega.

```shell
AUTHORIZE=~/.claude/plugins/cache/pstack-vic/pstack/<versão>/skills/setup-pstack/scripts/authorize.ts
node $AUTHORIZE check --parent claude   # 0 autorizado, 1 não; o JSON traz o motivo, a entrada e o comando
node $AUTHORIZE apply --parent claude   # num terminal: mostra a entrada, pede um "yes" digitado e grava
node $AUTHORIZE check --parent codex    # 0 quando approval_policy = "never" no topo do ~/.codex/config.toml
```

A entrada vale em qualquer repositório: certificar a branch, publicar o `verdict`, armar e mergear um PR sem aprovação humana, lançar as lanes do pstack. Continuam bloqueados `--admin` e qualquer outro desvio de check obrigatório, mudança em proteção de branch e tudo o que as outras regras protegem (arquivos e branches destruídos, produção, segredos, dado que sai). O `apply` recusa sem terminal, porque a autorização é um ato do operador e não do agente. Ele mantém as regras de fábrica (`"$defaults"`) e todas as outras configurações, e copia o arquivo anterior para `settings.json.before-pstack-authorization`. Para retirar a autorização, apague a entrada. O Pré-PR roda o `check` antes da Posse; sem a autorização, para ali e pede uma vez. O Daemon não precisa dela: lança a Raiz sem etapa de aprovação.

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
| `setup-pstack` | escolher modelo e effort por papel (a mesma família pode rodar em efforts diferentes em papéis diferentes); probe de cada par família+effort e escrita do sheet pelo `scripts/setup-pstack.ts` (rerun byte-idêntico, nada escrito se um probe falha); o passo 10 confere a autorização permanente do Pré-PR pelo `scripts/authorize.ts` |
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
npm test               # matriz, gerador de agents, runner, setup-pstack, update-clis, referência de skills, manifests e hook, digest dos upstreams, invariantes do pacote
npm run test:bun       # orch and watch-pr under Bun: bun install --frozen-lockfile, bun test, then the watch-pr typecheck (needs bun on PATH)
npm run matrix:check   # blocos gerados de provider-dispatch.md e setup-pstack em dia
npm run agents:check   # agents/pstack-*.md em dia com a matriz
npm run collision:check
npm run upstream:digest -- --no-fetch   # digest dos dois upstreams desde o ponto de sync (UPSTREAM.md, seção Digest semanal)
npm run setup-pstack -- --help   # subcomandos do setup: state, plan, probe, attest, write
npm run update-clis -- --help    # subcomandos da atualização das CLIs: start, check, notes, install, probe, finish
claude plugin validate --strict .   # manifest do plugin e do marketplace pelo validador do Claude Code
```

`tests/skill-collision-repro.sh` verifica os invariantes estáticos do pacote (sem camada `commands/`, `principle-*` ocultos e legíveis pelo modelo, skills de fluxo sem `disable-model-invocation`, nome do diretório igual ao `name`, versão única entre manifests, tag do marketplace e `package.json`, logo do Codex resolvendo, aliases móveis de Fable e Opus, vínculo do Bugbot entre a skill `babysit` e o playbook, playbooks sem comandos Graphite, conteúdo Cursor-only ausente). Com `PSTACK_BEHAVIORAL=1` ele também monta um plugin de uma skill e prova, com `claude -p`, que a invocação pela tool `Skill` e pelo `/comando` chegam à skill.

## O que ficou de fora

- **`skills/make-bot-ui`** — construída sobre rotinas, webhooks e UI da Cursor; não há mapeamento comum Claude Code / Codex.
- **`automations/benny/`** — pacote dormente de automações Slack sobre o runtime de eventos da Cursor. Não registrava skills nem no original.
- **`docs/guide/`** — tutorial de dez capítulos que ensina pstack pela UI da Cursor, sticky mode e cloud agents (2,3 MB de imagens). Leia no original em [cursor/plugins/pstack/docs/guide](https://github.com/cursor/plugins/tree/main/pstack/docs/guide); os conceitos mapeiam pela tabela de substituições de `CHANGES.md`.
- **Sticky mode** — frontmatter `mode`/`icon`/`color`/`reminder` só da Cursor. Fica o opt-in: `poteto-mode` só entra por comando do usuário, como no original.
- **Resto do `cursor-team-kit`** — `control-cli`/`control-ui` viraram `run`/`verify`; `verify-this` e `check-compiler-errors` duplicam built-ins; `loop-on-ci`, `review-and-ship`, `weekly-review` sobrepõem `babysit`, `fix-ci`, `make-pr-easy-to-review` e `what-did-i-get-done`; `pr-review-canvas` é UI da Cursor.
- **`README.md` da Cursor** — substituído por um README do port; o original está no histórico (`git show 91e5b82:README.md`) e no upstream.

## Licença

MIT. Três arquivos de licença preservados: [`LICENSE`](../LICENSE) (pstack, Lauren Tan), [`LICENSE-open-pstack`](../LICENSE-open-pstack) (open-pstack, Eric Litman) e [`LICENSE-cursor-team-kit`](../LICENSE-cursor-team-kit) (Cursor; cobre `deslop`, `thermo-nuclear-code-quality-review`, `make-pr-easy-to-review`, `fix-ci`, `fix-merge-conflicts`, `get-pr-comments` e `what-did-i-get-done`).

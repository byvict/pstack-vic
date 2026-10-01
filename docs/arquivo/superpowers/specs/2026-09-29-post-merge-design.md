> Arquivo histórico. Este documento descreve o converge, que saiu do plugin na versão 0.5.0. A decisão, de 2026-09-30, está no [ADR 0005](../../../adr/0005-autopilot-substitui-converge.md). Nada aqui vale mais, e parte dos links não abre.

# Pós-merge: o Varredor roda o que vem depois do merge (desenho, 2026-09-29)

Desenho aprovado por Victor em 2026-09-29 ("ok, gera o chip que vai implantar"), a partir do relatório `~/Dev/Skills/pstack-vic-runs/2026-09-29-pos-merge/relatorio.md` e das evidências ao lado dele. Vocabulário em [CONTEXT.md](../../../CONTEXT.md). Estende o daemon de [2026-09-28-converge-local-design.md](2026-09-28-converge-local-design.md) e o [ADR 0003](../../adr/0003-converge-sem-nuvem.md); a referência normativa continua sendo a seção **Local daemon** de [`converge-contract.md`](../../../skills/poteto-mode/references/converge-contract.md). O [plano](../plans/2026-09-29-post-merge-0.4.10.md) registra na seção Rulings cada ajuste que o código obrigou.

## Objetivo

Dar dono ao trabalho que vem depois do merge. Hoje a sessão que abre o PR termina no recibo do arm (Pré-PR, passo 8), quem mergeia é o GitHub e o app de desktop não acorda sessão nenhuma no merge. O trabalho pós-merge do pstack-vic (tag, plugin nos dois pais, reinstalar os jobs) ficou sem dono, e a sessão da 0.4.6 ficou esperando o merge por costume. O Daemon já vê o merge em até um minuto (o Vigia) e já roda um job sem modelo a cada tick (o Varredor). O desenho junta as duas coisas: um bloco opcional no contrato diz o que rodar depois do merge, e o Varredor roda, uma vez por commit novo da `main`, no Mac.

## Decisões de Victor (2026-09-29)

| Tema | Escolha |
|---|---|
| Sessão depois do arm | **Termina no recibo do arm e nunca espera nem consulta o merge.** Uma frase no Pré-PR (passo 8) e no Converge (Handoff). |
| Dono do trabalho pós-merge no Mac | **O Varredor**, no tick que já existe, sem modelo. |
| Onde se declara | **Bloco opcional `postMerge` no `.cursor/converge.json` da `main`**, com a gramática de comando do `prePr.runs`. |
| Trabalho que roda no GitHub | Continua em workflow de push na `main`; não passa pelo pstack. |
| Primeiro caso | O script de release do pstack-vic, no mesmo PR (0.4.7 no pedido; sai como 0.4.10, ver Entrega). |
| Prova real | Na release seguinte a esta. Esta ainda é tagueada e instalada à mão depois do merge. |
| Descartado | Deixar como está; Raiz com modelo a cada merge (20 a 40 min de modelo para três comandos); runner self-hosted do GitHub no Mac (desaconselhado em repositório público, e seria um segundo daemon). |

## Fatos (2026-09-29)

| Fato | Valor |
|---|---|
| PR #50 (0.4.6) | arm pelo passo 8 às 21:29:41Z, merge pelo GitHub às 21:35:41Z (84903ba); nenhuma sessão participou do merge |
| Aviso de merge no app de desktop | não existe: o monitor de PR acorda a sessão só em CI vermelho, conflito e comentário de review; merge só arquiva a sessão e notifica a pessoa |
| O que o Vigia lê hoje | lista de PRs abertos; checks da ponta da `main` e de cada head **só enquanto há PR aberto**; esquece o nome da `main` quando a lista esvazia |
| O que o `tickSweep` faz hoje | roda `converge-sweep` por repositório e mais nada |
| Tipos de trabalho pós-merge | nada (a maioria); roda no GitHub (tag, deploy do Clinext na janela das 04:00); só roda no Mac (pstack-vic: plugin nos dois pais, jobs launchd); espera condição (CI verde na `main`, nenhuma Raiz rodando) |
| Receita de atualização dos pais | Claude Code: `claude plugin marketplace update pstack-vic && claude plugin update pstack@pstack-vic`; Codex: `plugin remove`, `marketplace remove`, `marketplace add byvict/pstack-vic --ref vX.Y.Z`, `plugin add`, com cópia do `~/.codex/config.toml` antes |
| Armadilha do `install` | o `bootout` mata o processo do job, inclusive o tick que roda o `install`, e uma Raiz em execução |
| Leitura da versão instalada | `claude plugin list --json` (`version`, `installPath`); `codex plugin list --json -m pstack-vic` (`installed[].version`) |
| Job em execução | `launchctl list <label>` mostra `"PID" = N;` só enquanto o job roda |

## O que não muda

O Certificado, o gate, o arm com `--pending`, o Hold, a Posse e os três jobs continuam como estão. O Varredor continua sem modelo. Um contrato sem `postMerge` não custa nada: o Varredor não lê nada a mais para ele. O Daemon 0.4.6 ignora a chave nova, então a `main` pode ganhar o bloco antes de esta versão estar instalada.

## Regra: a sessão termina no arm

O passo 8 do Pré-PR e a seção Handoff do Converge ganham uma frase: a sessão que abriu o PR termina no recibo do arm e nunca espera nem consulta o merge; o que vem depois do merge é do `postMerge` do repositório. A frase velha do owner de nuvem na seção **Merge and progress** do contrato ("After merge it watches the resulting main Tests run") sai; o owner está aposentado e a 0.5.0 remove o código dele.

## Contrato: bloco `postMerge`

```json
"postMerge": { "runs": [{ "name": "release", "command": "npm run after-merge" }], "after": "tests" }
```

- `runs`: a mesma gramática do `prePr.runs`. Nome `^[a-z][a-z0-9-]{0,39}$`, comando partido em espaços simples, sem metacaractere de shell, nomes únicos. Rodam em sequência.
- `after`: `"tests"` (padrão) ou `"none"`. Com `"tests"`, um commit só roda depois que a corrida de push do workflow `tests.workflow` naquele commit concluiu `success` e o job `tests.job` dela concluiu `success` no mesmo commit, lidos como o arm lê uma `main` verde (`workflowRun(t, sha, 'push')`).
- Um bloco inválido invalida o contrato inteiro, como já acontece com um `prePr` inválido: o Varredor falha em segurança e desarma os PRs armados do repositório.
- O contrato vale pela ponta: o bloco lido na ponta da `main` governa todos os commits pendentes daquele repositório.

## Varredor: a passada pós-merge

Depois do `converge-sweep` de cada repositório cujo contrato na ponta tem `postMerge`, no mesmo tick:

1. **Ponta.** A ponta é o commit em que o `converge-sweep` leu o contrato (ajuste da implementação: o `sweep()` passa a devolver esse contrato, então a passada não faz leitura própria enquanto a `main` não anda).
2. **Estado.** `<stateDirectory>/post-merge/<owner>-<repo>.json` guarda `schemaVersion` 1, `repo` e `tip`, a última ponta tratada. O primeiro tick de um repositório grava a ponta e não roda nada: sem replay do passado, como o primeiro tick do Vigia. Ponta igual à guardada: nada a fazer, nenhuma leitura. Um contrato que carrega sem o bloco apaga esse arquivo, para um bloco recolocado depois começar pela primeira volta (ajustado na implementação, R97).
3. **Commits novos.** Uma leitura do compare (`repos/X/compare/<guardada>...<ponta>`). Os commits entram pela ordem do primeiro pai, do mais antigo para o mais novo. Uma ponta que não descende da guardada (force-push), um compare que não lista todos os commits, ou mais de 50 commits são erro do repositório, e nada é gravado; apagar o arquivo de estado ancora de novo na ponta atual (ajuste: o teto vira erro, porque replay de 50 releases sem ninguém olhando é pior do que perguntar).
4. **Ordem e parada.** Os commits rodam em ordem. A fila para no primeiro commit que não está pronto (`after: tests` ainda sem conclusão, ou adiado), e os seguintes esperam. A ponta guardada avança commit a commit, só depois de um commit terminar `done`.
5. **Prontidão.** Com `after: tests`, corrida ausente ou em andamento é espera silenciosa. Corrida concluída sem `success`, ou job de testes sem `success`, também é espera, porque um rerun que fica verde retoma a fila, mas o tick reporta como erro (`waits on COMMIT`), para uma `main` vermelha não parar a release em silêncio (ajuste). Nenhuma tentativa é gravada e a janela de 24 horas não começa.
6. **Execução.** Por commit: `git -C <checkout primário> fetch origin <sha>` e `git -C <checkout primário> worktree add --detach RUN/checkout <sha>`, com `RUN = <tmp>/converge-local/post-merge/<owner>-<repo>-<sha8>-<n>-<segundos unix>/` (`n` = tentativas gravadas + 1; ajuste para nunca repetir um RUN). Nunca escreve no checkout primário e nunca cria nem move branch lá. Os comandos rodam em sequência, com cwd no worktree, stdout e stderr em `RUN/<name>.log`, ambiente do tick mais `PSTACK_REPO`, `PSTACK_COMMIT`, `PSTACK_PR` (o número de `commits/<sha>/pulls`, vazio quando não há PR mergeado com base na `main`), `PSTACK_CHECKOUT` (o checkout primário) e `PSTACK_PLUGIN_DIR`. Teto de 20 minutos de parede por comando: `SIGTERM`, `SIGKILL` dez segundos depois, e a tentativa termina `failed` com razão `timeout`. O worktree sai com `git worktree remove --force` ao fim de toda tentativa, `done`, `deferred` ou `failed`; uma nova tentativa recria o seu. O primeiro comando que não sai 0 encerra a tentativa.
7. **Protocolo de saída.** 0 em todos: `done`. 75 (`EX_TEMPFAIL`): `deferred`, tentado de novo no tick seguinte, por no máximo 24 horas desde a primeira tentativa no commit; a primeira saída 75 depois disso vira `failed`. Qualquer outro código, um comando que não sobe ou o teto de 20 minutos: `failed`.
8. **Ledger por commit.** `<stateDirectory>/post-merge/<owner>-<repo>/<sha>.json`: `schemaVersion` 1, `repo`, `commit`, `pr`, `firstAttemptAt`, `attempts` (`n`, `startedAt`, `endedAt`, `runs: [{ name, exitCode, logFile }]`, `outcome` `done`, `deferred` ou `failed`, `reason`, `runDirectory`). Gravado por arquivo temporário e rename, modo 0600, como o `ledger.ts`. Um commit cujo ledger já termina em `done` (queda entre a gravação do ledger e a do estado) só avança a ponta.
9. **Falha.** A fila do repositório para naquele commit, e a ponta guardada não passa dele. O tick posta um comentário no PR mergeado, quando existe (`repos/X/issues/N/comments`, no estilo do comentário de Hold: commit, comandos, códigos de saída, caminhos dos logs e "apague `<ledger>` para tentar de novo"), uma vez, quando grava a falha. O erro sai no stderr e em `errors` do relatório, e o tick sai 1, em todo tick enquanto o ledger continuar lá. O comentário vai para um PR já mergeado, então não mexe no texto de nenhum verdict que o Varredor ainda julga (ajuste: a frase do contrato que proíbe o job do Varredor de comentar passa a valer para PR aberto). Victor destrava apagando o ledger do commit, ou com `converge-local post-merge`. Limite conhecido: o comentário sai pela conta do `gh`, que costuma ser a autora do PR, e o GitHub não avisa ninguém do próprio comentário; um aviso fica para depois (R98).
10. **Idempotência.** É obrigação do projeto: um comando pode rodar duas vezes depois de uma queda entre a execução e a gravação do ledger. O contrato diz isso.
11. **`--dry-run`.** O tick com `--dry-run` imprime o que a passada rodaria (a ponta que gravaria no primeiro tick, ou o primeiro commit pronto com seus comandos) e não grava nada: nem estado, nem ledger, nem worktree, nem comentário.
12. **Posse da passada.** O tick e o comando manual tomam a mesma Posse por repositório, `<stateDirectory>/leases/post-merge--<owner>-<repo>.json`, presa ao pid. Com a Posse de outro, o tick pula a passada do repositório (sem erro) e o comando manual recusa (ajuste: o comando manual cria a concorrência que o tick sozinho não tinha).

## `converge-local post-merge --repo R --commit SHA [--dry-run]`

O caminho manual pelo mesmo código, e a costura de teste numa máquina real. Recusa um repositório fora da configuração, um contrato sem `postMerge` e um commit do qual a ponta não descende. Confere a prontidão como o tick. Roda uma tentativa, qualquer que seja o ledger (um commit `failed` ou `done` inclusive), grava o ledger e comenta no PR se falhar. Nunca move a ponta guardada: o tick seguinte lê o ledger, e um `done` destrava a fila. Sai 0 em `done` e `deferred`, 1 em `failed`, commit não pronto ou erro. Com `--dry-run`, imprime o que rodaria e não grava nada.

## `status`

Ganha `postMerge`: por repositório, a ponta guardada e os commits cujo ledger termina `deferred` ou `failed`, com PR, razão, número de tentativas e arquivo. Um arquivo ilegível aparece como seu erro. A Posse da passada aparece com as outras.

## Vigia

Para o Varredor acordar em até um minuto depois de o CI de push da `main` ficar verde depois de um merge, o Vigia guarda o nome da `main` mesmo quando a lista de PRs abertos esvazia (o nome guardado; sem nome guardado, uma leitura de `repos/<repo>`) e continua fazendo o GET condicional de `commits/<trunk>/check-runs` sem PR aberto. Vale para todo repositório, com ou sem `postMerge`: um 304 não gasta limite, e o custo é um processo `gh` a mais por minuto por repositório sem PR aberto. O teste que dizia "sem PR aberto o tick lê só a lista" muda com a regra.

## `install --when-idle`

O `install` faz `bootout` dos três jobs, inclusive do Varredor, que é quem roda o `postMerge`. `converge-local install --when-idle` toma uma Posse de instalação (`<stateDirectory>/leases/install.json`, presa ao pid), espera, consultando `launchctl list` a cada dois segundos, até nem o Varredor nem o job da Raiz terem PID, por no máximo três horas, e só então instala. Um segundo instalador em espera recusa pela Posse. Serve ao script do pstack-vic e à reinstalação à mão depois de uma atualização do plugin (ajuste da implementação).

## pstack-vic: primeiro caso

`.cursor/converge.json` ganha `"postMerge": { "runs": [{ "name": "release", "command": "node scripts/after-merge.ts" }], "after": "tests" }` (ajustado na implementação, 2026-09-29: `node` direto em vez de `npm run after-merge`, porque o `npm run` põe diretórios `node_modules/.bin` na frente do `PATH` que o `install --when-idle` grava nos plists; R95). O script roda no commit do merge. Um comando que falha ou um plugin em outra versão sai 75 (R96). Cada passo pode rodar duas vezes:

1. Lê a versão do `package.json` e o commit (`git rev-parse HEAD`).
2. **Tag.** Se `v<versão>` falta no `origin` (`git ls-remote --tags`), cria a tag leve nesse commit (quando a tag local já existe, confere que aponta para ele) e empurra só ela (`git push origin refs/tags/v<versão>`), nunca `--tags`.
3. **Só na ponta.** Se o commit não é a ponta da `main` (`git ls-remote origin refs/heads/main`), para aí e sai 0: o marketplace do Claude Code segue a branch padrão e instalaria a versão mais nova, e o commit seguinte da fila instala (ajuste).
4. **Claude Code.** Se `claude plugin list --json` não mostra `pstack@pstack-vic` na versão, roda `claude plugin marketplace update pstack-vic` e `claude plugin update pstack@pstack-vic` e confere de novo.
5. **Codex.** Se `codex plugin list --json -m pstack-vic` não mostra a versão, copia `~/.codex/config.toml` para `config.toml.pre-<versão>` (só se a cópia ainda não existe), roda `plugin remove`, `marketplace remove`, `marketplace add byvict/pstack-vic --ref v<versão>` e `plugin add`, pulando o que já não existe, e confere de novo.
6. **Jobs launchd.** Sem job instalado (`launchctl list com.pstack.converge-sweep` falha): sai 0. Com os três jobs carregados a partir do `installPath` da versão no cache do Claude Code: sai 0. Com PID em `com.pstack.converge-raiz`: sai 75. Senão, lança `node <installPath>/skills/poteto-mode/scripts/converge/converge-local install --when-idle` solto do tick (`detached`, sessão própria, log em `~/Library/Logs/pstack-after-merge.log`) e sai 75. O tick seguinte, que já é o do Varredor recarregado, roda o script de novo, acha os jobs na versão e sai 0 (ajuste: sair 0 no lançamento gravaria `done` antes de o `install` acontecer, e um `install` que falhasse nunca teria nova tentativa; o `bootout` também mataria o tick que chamou).

Os testes do script põem `git`, `claude`, `codex` e `launchctl` falsos no `PATH`; nenhum teste roda os de verdade.

## Segurança

O Daemon roda no Mac, com permissão total, os comandos que o contrato da `main` manda. Isso já vale para o `prePr.runs`, e quem escreve na `main` já tem esse poder. Os comandos rodam num worktree descartável do commit, nunca no checkout primário. O comentário de falha só cita commit, nome de comando, código de saída e caminho de log, nunca a saída do comando.

## Custo

- GitHub: nenhuma chamada a mais por tick enquanto a `main` não anda; por merge, um compare, a leitura do PR do commit e duas da prontidão (corrida e jobs), repetidas a cada tick enquanto o CI roda. O Vigia: um GET condicional a mais por minuto por repositório sem PR aberto, sem gastar limite.
- Máquina: um worktree por tentativa; o script do pstack-vic leva segundos quando não há nada a fazer.
- Nenhum modelo.

## Testes

- `contract.test.ts`: o bloco `postMerge`, a gramática compartilhada e o padrão `after: tests`.
- `post-merge.test.ts`, contra o GitHub falso da fixture e um `origin` git descartável: primeiro tick grava a ponta; ponta igual não lê nada; commits em ordem com a ponta avançando; espera por CI pendente e por CI vermelho (erro); `deferred`, janela de 24 horas; `failed` com comentário único e erro repetido; ledger `done` só avança; ponta que não descende, compare truncado e mais de 50 commits; teto de 20 minutos; dry run; Posse; comando manual; `status`.
- `watch.test.ts`: o Vigia sem PR aberto continua lendo os checks da `main`, guarda o nome e acorda o Varredor quando eles mudam.
- `launchd`/`local.test.ts`: `install --when-idle` espera o PID sumir, desiste no teto e recusa com outro instalador.
- `scripts/after-merge.test.ts`: as decisões do script com CLIs falsas.
- A prova real é o merge da release seguinte a esta.

## Entrega

Um PR, certificado pelo Pré-PR com o plugin instalado. O pedido dizia 0.4.7, mas o #52 saiu como 0.4.7 e o #53 como 0.4.9 enquanto este PR era feito, e a 0.4.8 fica reservada para o script `converge-certify certify`; as sessões combinaram que quem mergeia depois refaz o rebase e renumera, então este PR sai como 0.4.10 (R94 no plano). Depois do merge, esta versão ainda é tagueada, instalada nos dois pais e recarregada no launchd à mão, uma vez; o primeiro tick dela grava a ponta da `main` e não roda nada. A release seguinte é a primeira que o Varredor faz sozinho. A 0.4.7 (#52) foi mergeada sem tag.

## Fora de escopo

- Reverts e `main` vermelha depois do merge como trabalho próprio (o `orchestrate.md` cita um "retro watcher"); a passada só espera a `main` verde.
- O que roda no GitHub: continua em workflow de push na `main`.
- Rotação de log (R76) e remoção da nuvem (0.5.0).

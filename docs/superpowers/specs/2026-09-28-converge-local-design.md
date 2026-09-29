# Converge local: o daemon no Mac substitui a nuvem (desenho, 2026-09-28)

Desenho fechado com Victor em 2026-09-28. Vocabulário em [CONTEXT.md](../../../CONTEXT.md). Supera a metade "nuvem" de [docs/pre-pr.md](../../pre-pr.md) e o [ADR 0001](../../adr/0001-verificacao-pesada-antes-do-pr.md), que ganha um ADR 0003 no primeiro PR de documentação. A metade Pré-PR, Partes 1 a 4a do [plano](../plans/2026-09-24-pre-pr.md), não muda.

## Objetivo

Tirar o Cursor Cloud do ciclo de entrega. O Mac de Victor nunca desliga, então tudo o que a nuvem fazia depois que a Raiz encerra passa a rodar na máquina local: armar o merge do que está certificado, reparar PR certificado com CI vermelho e certificar PR que nasceu sem Certificado. O pool de modelos do Cursor fica livre para outros projetos.

Junto, os papéis pré e pós-PR deixam de estar pinados no código e passam a ser escolhidos no `/setup-pstack` como qualquer outro papel do poteto-mode.

## Decisões de Victor (2026-09-28)

| Tema | Escolha |
|---|---|
| Nuvem no fluxo | **Cortar.** O Mac nunca desliga; a única vantagem da nuvem era reagir com a máquina desligada. |
| Gatilho local | **Daemon completo.** Dois jobs launchd: um varre por script, o outro lança uma Raiz sem supervisão para reparar e certificar. |
| Código da nuvem | **Remover tudo, em PR próprio, depois da prova no Clinext.** |
| Papéis pré e pós-PR | **Configuráveis no `/setup-pstack`**, modelo e esforço, como os demais. |
| Certificador nesta versão | **Só Grok**, já pronto e rodando; abrir para Claude e Codex depois de validar o fluxo inteiro. |
| Ajustador | Pode ser alias, inclusive subagente do próprio harness. |
| Regra cruzada | Continua: o Revisor pré-PR nunca é da família de nenhum Autor declarado. |

## Fatos medidos (2026-09-28)

| Fato | Valor |
|---|---|
| Clinext, 14 a 28 de setembro: PRs mergeados | 76, sendo 9 do Dependabot, todos por byvict |
| Clinext: corridas de `Tests` em branch de PR | 224, 33 vermelhas |
| Clinext: corridas de `Tests` na `main` | 76, 3 vermelhas e 1 cancelada |
| Clinext: proteção da `main` | `Run test suite`, `Secrets scan`, `verdict`; sem `hold` |
| Clinext: `.cursor/converge.json` | sem `prePr`, sem `tests`, sem `hold` |
| Clinext: AGENTS.md e PR_OPENING.md | ainda descrevem o v1: sessão encerra no link, Automation "PR opened" lança o owner completo |
| pstack-vic: Partes 4 e 5 do plano Pré-PR | não feitas; no Cursor só existe a Automation "PR opened" do v1, que lança o owner completo; Reparo e Varredor nunca foram criados |
| Onde os papéis estão pinados | `roleProviders` em `skills/poteto-mode/scripts/converge/contract.ts`; `singleLaneRows` em `skills/setup-pstack/scripts/setup-pstack.ts`; `admitLane` em `evidence.ts` |
| Modos do runner por provider | `read-only` e `isolated-write` em claude, codex e grok; `unsandboxed` só em grok |
| Padrão de job local na máquina | `~/Library/LaunchAgents/com.clinext.*.plist`: `/bin/zsh -c 'source nvm.sh && cd ... && node ...'`, log em `~/Library/Logs/` |
| Conta do `gh` no Mac | byvict, a mesma que publica o `verdict`; o gate recusa verdict de outra conta |
| Janela de deploy do Clinext | `04:00 America/Sao_Paulo` |

## O que não muda

A fronteira continua sendo o Certificado: comentário JSON versionado mais status `verdict` no head exato, publicado pelo `publish.ts`, e o gate (`gate.ts`) continua sendo quem decide se um verdict autoriza merge. A Raiz interativa continua encerrando no recibo do arm. O `hold` continua sendo o freio de Victor. A regra "todo escritor desarma antes de empurrar num PR armado" continua.

## Daemon `converge-local`

Um comando novo, `skills/poteto-mode/scripts/converge/converge-local`, Node 24 sem dependências, com dois jobs launchd que ele mesmo instala.

### Job 1: `com.pstack.converge-sweep`

A cada 10 minutos (`StartInterval` 600), sem modelo. Roda o `converge-sweep` existente em cada repositório configurado, na ordem da configuração. Cobre filho de stack retargetado para a `main` e PR certificado que ficou sem arm numa `main` vermelha. Pode rodar ao mesmo tempo que o job 2: o sweep só julga o head atual, e uma Raiz que empurrou commit deixa o head sem verdict, que o sweep pula.

### Job 2: `com.pstack.converge-raiz`

A cada 10 minutos, uma Raiz por vez. O launchd não sobrepõe duas instâncias do mesmo label; a serialização vem daí (ajustado na implementação, 2026-09-29, 0.4.5: os dois jobs também acordam quando `<estado>/wake/<job>/` recebe um arquivo, por `QueueDirectories`; `converge-local nudge`, os playbooks depois de liberar a posse e o próprio tick depois de lançar uma Raiz deixam esse arquivo, e o tick apaga os do seu job antes de ler qualquer coisa). Cada tick:

1. **Lista** os PRs abertos de cada repositório, qualquer base, do menor número para o maior.
2. **Pula**: draft; PR com rótulo de hold; PR cujo head está em fork; branch com posse viva (abaixo); PR cujo verdict no head foi publicado por outra conta (registra e não toca); PR cujo verdict é da execução `converge`, da nuvem antiga, até o PR de remoção (ajustado na implementação, 2026-09-29: pula também PR de autor fora de `trustedAuthors` mais a conta autenticada e, quando haveria trabalho, PR com comentário, comentário de review ou review de alguém fora dessa lista, R63).
3. **Classifica** o que sobrou, com as mesmas funções que o sweep e o arm usam (`verdictStatus`, `verdictGate`, `checks`, proteção efetiva):
   - `repair`: verdict confiável no head, gate certifica, e o último run de um check obrigatório, exceto `hold`, terminou com conclusão diferente de `success` (ajustado na implementação, 2026-09-29: diferente de `success`, `neutral` e `skipped`, que o GitHub conta como aprovados, R65).
   - `recertify`: verdict confiável no head e gate recusa pela condição 7 do contrato, patch ou política diferentes na ponta da `main`, ou decisão re-derivada que não é VERIFIED.
   - `certify`: sem verdict confiável no head, e o PR foi criado há mais de 30 minutos. Um PR mais novo espera, para a sessão que acabou de abri-lo publicar o Certificado em paz (ajustado na implementação, 2026-09-29, 0.4.5: a posse, que o Pré-PR toma antes do push e solta depois do arm, é o que protege a sessão autora; um PR mais novo só espera até o check de testes do head terminar, com qualquer conclusão, e os 30 minutos ficam como teto para repositório cujo PR não recebe check).
   - Nada a fazer: verdict confiável e checks verdes ou pendentes (o arm já está armado, ou o sweep arma), ou gate recusado por `PR head moved` e outras razões que o próximo tick reavalia.
4. **Lança** uma Raiz para o primeiro PR com trabalho, espera, grava o resultado no ledger e encerra o tick.

### Posse por branch

`converge-local lease --repo OWNER/REPO --branch B [--pid N] [--ttl H]` grava `<estado>/leases/<owner>-<repo>-<branch>.json` com `by`, `startedAt`, `expiresAt` (padrão 3 horas) e `pid` opcional (ajustado na implementação, 2026-09-28: `lease` e `leases/` no lugar de `claim` e `claims/`). Uma posse vale enquanto não expirou e, quando tem `pid`, enquanto o processo existe. `converge-local release` apaga. O daemon nunca lança Raiz numa branch com posse válida, e sobrescreve posse expirada ou de pid morto. A Raiz do daemon roda sob a posse do tick, com o pid do tick e TTL de 3 horas.

Os playbooks interativos tomam a posse sem pid, só com TTL, porque os processos que o harness lança para cada comando são curtos: o Pré-PR no passo 1, antes do push; babysit e shipping antes de escrever numa branch; e renovam antes de cada lane e de cada push. A posse é um arquivo local porque as duas partes rodam na mesma máquina, e porque um rótulo no GitHub dispararia o `hold` e poluiria o PR.

### Tetos e ledger

`<estado>/ledger/<owner>-<repo>/<pr>.json` guarda `head`, `firstAttemptAt`, `heldAt` e a lista de tentativas (`n`, `kind`, `startedAt`, `endedAt`, `outcome`, `reason`, `runDirectory`). Regras:

- Duas tentativas com `outcome: failed` no mesmo head, ou seis horas desde `firstAttemptAt` sem `certified`, e o daemon aplica o rótulo de hold do contrato, comenta no PR a causa, as tentativas e os diretórios de rastro, e grava `heldAt`. Um comentário é seguro num verdict `pre-pr`, que re-deriva sobre o texto; o daemon nunca toca PR com verdict `converge`.
- Head novo zera o ledger do PR. Rótulo de hold ausente depois de `heldAt` também zera: Victor tirou o rótulo, e o daemon tenta de novo.
- `deferred` não conta como tentativa falha. `skipped` não entra no ledger (ajustado na implementação, 2026-09-28: a não ser que o PR relido não explique o pulo, e aí entra como `failed`, R56; 2026-09-29: falha de lançamento não é tentativa e fica à parte no ledger do head; a partir da terceira desde a última tentativa registrada, o daemon espera uma hora depois da última antes de lançar de novo no head, R64).
- Cada tentativa tem teto de parede de 2 horas; ao estourar, o daemon mata o processo da Raiz e registra `failed` com razão `timeout`.

### Lançamento da Raiz

O daemon lê a linha `converge raiz` do sheet do parent configurado, `~/.claude/pstack-models.md` ou `~/.codex/pstack-models.md`. O provider da lane tem de ser o do parent; qualquer outra coisa faz o tick falhar com erro claro e não lançar nada.

- `claude:<modelo>@<esforço>` vira `claude -p --model <modelo> --effort <esforço> --permission-mode bypassPermissions --output-format json`, com o plugin instalado do parent (ou `--plugin-dir` da configuração, para desenvolvimento), diretório de trabalho no checkout primário do repositório.
- `codex:<modelo>@<esforço>` vira `codex exec --model <modelo> -c model_reasoning_effort="<esforço>" --sandbox danger-full-access -C <checkout>` (ajustado na implementação, 2026-09-28: o `codex exec` 0.158.0 recusa `--ask-for-approval`, que só o comando `codex` de topo aceita, e já roda sem pedir aprovação).

O prompt é um template fixo: repositório, PR, tipo de trabalho, checkout primário, diretório de corrida sob `TMPDIR`, e a instrução de ler e seguir `skills/poteto-mode/playbooks/catch-up.md` do plugin instalado. A Raiz grava `outcome.json` no diretório de corrida; o daemon lê. Saída sem `outcome.json` válido é `failed` com razão `no outcome` (ajustado na implementação, 2026-09-28: uma Raiz que não sobe, ou que sai sem `outcome.json` aceito em menos de dois minutos, é falha de lançamento, não tentativa, R55).

### Configuração, estado e rastro

- `~/.config/pstack/converge-local.json`: `parent` (`claude` ou `codex`), `repos` (lista de `{ repo, checkout }`), `intervalMinutes` (padrão 10), `pluginDir` opcional, `stateDirectory` opcional.
- Estado em `~/Library/Application Support/pstack/converge-local/`: `leases/` (ajustado na implementação, 2026-09-28), `ledger/`, `last-tick.json` por job.
- Logs em `~/Library/Logs/pstack-converge-sweep.log` e `pstack-converge-raiz.log`.
- Diretório de corrida de cada Raiz sob `${TMPDIR:-/tmp}/converge-local/<owner>-<repo>-<pr>-<head8>-<n>/`, como o Pré-PR exige (nota N6).
- Subcomandos: `install` (escreve e carrega os dois plists), `uninstall`, `tick --job sweep|raiz [--dry-run]`, `status` (configuração, sheet, autenticação de `gh` e do parent, posses e ledger; serve de doctor), `lease` (ajustado na implementação, 2026-09-28), `release`, `run --repo R --pr N [--kind K]` (o mesmo caminho do daemon, disparado à mão).

## Raiz de catch-up e playbooks

### `pre-pr.md` em duas metades

O playbook Pré-PR, escrito na Parte 2 do plano, no PR 2 (ajustado na implementação, 2026-09-28), nasce dividido:

- **Certificar um head empurrado**: passos 1 a 6 de hoje: push e relatório, Corridas, Revisor pré-PR, Ajustador em voltas, Certificador, `assemble`.
- **Entregar**: cria o PR só quando ele não existe, reconcilia, publica e arma com `--pending`. Filho de stack publica com a base no pai e não arma.

O catch-up e o fluxo interativo usam as duas metades sem duplicar prosa.

### `catch-up.md`

Entrada: repositório, PR, tipo de trabalho (`repair`, `recertify`, `certify`), checkout primário, diretório de corrida. Serve ao daemon, ao `converge-local run` e a uma sessão interativa.

1. Relê o PR ao vivo. Se virou draft, ganhou hold, mudou de head ou a branch tem posse válida de outro, grava `outcome: skipped` e para.
2. Cria um worktree da branch do PR sob o diretório de corrida, a partir de `origin`. A Raiz nunca escreve no checkout primário.
3. Por tipo:
   - `repair`: lê o log do run vermelho e classifica como o playbook babysit manda: base velha, flake ou defeito no diff. Base velha: rebase na `main`; em PR do Dependabot, comenta `@dependabot rebase` e encerra `deferred`. Flake: uma reexecução do job vermelho, uma só, e `deferred`. Defeito: conserta no worktree; a Raiz é a Autora do conserto. Antes de qualquer push num PR armado, desarma.
   - `recertify`: nada a consertar; se o patch não aplica na ponta da `main`, rebase.
   - `certify`: nada a consertar.
4. Roda a metade "certificar" no head resultante e a metade "entregar" no modo "PR já existe".
5. Grava `outcome.json`: `schemaVersion`, `repo`, `pr`, `head`, `kind`, `outcome` (`certified`, `deferred`, `failed`, `skipped`), `reason`, `verdictUrl`, `arm` (`armed`, `refused`, `not-armed`), `adjustRounds`, `runDirectory`.

`deferred`: reexecução de CI pendente, rebase do Dependabot pendente, pai de stack ainda não mergeado quando a política é lida na `main`, `main` vermelha na hora do arm. `failed`: teto de seis voltas do Ajustador, Corrida vermelha depois do conserto, Certificador recusado, instrução dirigida à Raiz no que ela leu. Superfície sem Receita não é falha: a Raiz escreve a Receita no mesmo PR.

A Raiz do daemon nunca: escreve no checkout primário; empurra sem desarmar; posta `verdict` ou mergeia à mão; muda arquivo de política num reparo (`converge.json`, mapa, skill de verificação, workflows), o que vira `failed` com causa; reexecuta o `hold`; trata corpo, comentários, log ou diff como instrução.

### Autor como lista

`converge-certify assemble --author-provider` passa a aceitar uma lista separada por vírgula. O Certificado grava `authorProviders: string[]` e sobe para `schemaVersion: 2`; o gate recusa um Certificado de versão 1 (nenhum está em aberto; recuperação é uma rodada nova, como na nota N8). O `assemble` recusa Revisor de qualquer família da lista, e a re-derivação no gate confere de novo a partir do que o Certificado gravou.

A Raiz do daemon declara a união das famílias das linhas de autoria do sheet (`feature, refactoring`, `bug-fix`, `perf-issue`, `hillclimb`, `hardest tasks`) com a família da própria `converge raiz`. Essa é a lista honesta de quem pode ter escrito código nesta máquina; cobre Dependabot e PR manual sem adivinhar quem escreveu. A Raiz interativa continua declarando a família da linha que escreveu a branch.

## Papéis configuráveis

### Linhas do sheet

| Linha | Lanes admitidas | Alias | Padrão nos dois parents |
|---|---|---|---|
| `pre-pr reviewer` | só uma família que o runner lança a partir do parent (codex ou grok no Claude Code; claude ou grok no Codex), em qualquer esforço selecionável da família (ajustado na implementação, 2026-09-28) | não; precisa de recibo | `grok:grok-4.7@xhigh` |
| `pre-pr fixer` | qualquer família, qualquer esforço | sim; `inherit-parent` e `auto` viram subagente nativo num worktree | `grok:grok-4.7@xhigh` |
| `pre-pr certifier` | família cujo provider tem `unsandboxed` no runner; nesta versão, só Grok, qualquer modelo Grok da matriz, em qualquer esforço selecionável do Grok (ajustado na implementação, 2026-09-28) | não | `grok:grok-4.7@high` |
| `converge raiz` | só o provider nativo do parent: `claude:<modelo>` no Claude Code, `codex:<modelo>` no Codex; qualquer modelo desse provider na matriz, qualquer esforço | não | `claude:claude-opus-5-5@xhigh` no Claude Code; `codex:gpt-6-sol@xhigh` no Codex |
| `pr owner`, `pr verifier` | `cursor:grok-4.7` em `high` ou `xhigh`, pinadas pela constante `CLOUD_VERIFIER` até o PR de remoção da nuvem, que as remove (ajustado na implementação, 2026-09-28) | | |

O Ajustador pode ser alias porque só a contagem de voltas dele entra no Certificado; o diff passa pela revisão da Raiz e entra por fast-forward. A `converge raiz` é sessão do parent, não lane do runner, por isso só o provider nativo.

A matriz ganha, por provider, o campo `unsandboxed: true|false` (hoje só `grok`). O `setup-pstack` e a admissão leem esse campo para a linha do Certificador; o runner continua recusando o modo nos demais providers.

### Admissão

`roleProviders` sai do `contract.ts`. `admitLane` passa a exigir: recibo igual ao manifesto da lane (já checado); família presente na matriz; modo do papel (`read-only` para o Revisor, `unsandboxed` para o Certificador, que pelo campo da matriz implica Grok nesta versão). A independência deixa de ser "o signatário é Grok" e vira "o Revisor não é de nenhuma família de `authorProviders`", conferida no `assemble` e na re-derivação do gate. Editar o sheet depois não muda um Certificado publicado. A lane `pr verifier` continua presa a `cursor:grok-4.7` em `high` ou `xhigh` pela constante `CLOUD_VERIFIER` até o PR de remoção da nuvem (ajustado na implementação, 2026-09-28).

Só um Revisor Grok grava artefatos de prova de risco numa lane `read-only` nesta versão: o modo plano do Claude e o `read-only` do Codex não escrevem arquivo, e o runner grava o `output.json` a partir da resposta final da lane. Uma rodada com obrigação `requires-proof` e Revisor de outra família sai `INCONCLUSIVE` no `assemble`; é a nota N35 (ajustado na implementação, 2026-09-28).

### `setup-pstack`

As quatro linhas entram no fluxo genérico de duas perguntas, modelo e esforço. O parágrafo dos pisos de `pr owner` e `pr verifier` e a validação especial dessas linhas em `plan` ficam até o PR de remoção da nuvem, presos à constante `CLOUD_VERIFIER` (ajustado na implementação, 2026-09-28). O aviso de família igual continua e compara o `pre-pr reviewer` só com as linhas de autoria; um Revisor da família nativa do parent é recusado, não avisado, e a `converge raiz` é sempre dessa família, então compará-la não avisaria nada (ajustado na implementação, 2026-09-28). Família nova numa dessas linhas passa pelo probe do ledger como hoje; `unsandboxed` não é sondado, porque o probe é somente leitura. `singleLaneRows` deriva as lanes da matriz, não de uma tabela em `contract.ts`.

Migração: sheet sem `converge raiz` ganha o padrão ao materializar, como qualquer papel documentado que falte. No PR de remoção, o normalizador descarta `pr owner` e `pr verifier` com aviso.

### Adiado para a próxima versão

- `unsandboxed` para claude (`--permission-mode bypassPermissions`, tools de leitura mais Bash) e codex (`--sandbox danger-full-access`, sem restrição de tools; confinamento só pelo worktree descartável e pelo registro de HEAD e status).
- Higiene de ambiente em toda lane: ambiente explícito por provider, só com a credencial do próprio provider, e um `PSTACK_LANE=1` que o `~/.zshenv` honra no lugar de `GROK_AGENT`.

## Certificado compacto (nota N9)

O Certificado grava só os artefatos que a cobertura e as provas de risco referenciam: por funcionalidade, o primeiro PNG e o primeiro texto ou JSON admitidos; por obrigação de risco, os artefatos que a prova cita. Os demais ficam em disco, sem referência. Com 57 funcionalidades, isso são no máximo 114 entradas de cerca de 250 bytes mais 3 KB de base, dentro do limite de 65.536 caracteres de um comentário do GitHub. Tudo o que a re-derivação lê continua no Certificado.

## Entrega

### Quatro PRs no pstack-vic, nesta ordem, cada um certificado pelo próprio Pré-PR

1. **Papéis.** `converge raiz` nasce; Revisor e Ajustador abrem; `roleProviders` sai; campo `unsandboxed` na matriz; `assemble` com lista de Autores e Certificado versão 2; Certificado compacto; `setup-pstack` genérico para as quatro linhas. Primeiro porque o daemon precisa da linha da Raiz.
2. **Playbooks e decisão.** `pre-pr.md` em duas metades, `catch-up.md`, parágrafo de entrega do `opening-a-pr.md`, reescrita de `docs/pre-pr.md`, glossário do `CONTEXT.md` (Converge, Reparo e Varredor viram locais; entram Daemon, Posse e Catch-up), ADR 0003 superando o 0001, `converge-contract.md` com daemon, posse, lista de Autores e Certificado compacto. Só documentação, mas o diff toca `skills/` e os manifestos: passa pelas três Corridas do contrato e pelo Revisor, sem Certificador (ajustado na implementação, 2026-09-28).
3. **Daemon.** `converge-local` com os dois jobs, posse, ledger, tetos, lançador e `install`. No merge, Victor instala para o pstack-vic (sem Certificador). O próximo PR real do plugin é a primeira prova: nasce certificado, o daemon varre, e se ficar vermelho o daemon repara.
4. **Remoção da nuvem.** Só depois da prova no Clinext. Abaixo.

Versões sugeridas: 0.3.0, 0.3.2, 0.4.0, 0.5.0 (ajustado na implementação, 2026-09-28: a 0.3.1 foi o hotfix N39); o plano confirma. As decisões da tabela acima entram como sub-issue de CLI-192 no PR 2.

### A virada no Clinext

Um PR no Clinext: `.cursor/converge.json` ganha `tests` (`Tests`, `Run test suite`) e `prePr` (preflight, suíte do servidor, suíte do cliente, `certifier: true`), e `hold` em `requiredChecks`; `.github/workflows/hold.yml` copiado do pstack-vic; `AGENTS.md` e `.github/PR_OPENING.md` passam a dizer que a sessão certifica, arma e encerra, e que o daemon local repara, certifica o que sobrou e varre; só o `publish.ts` posta `verdict`.

Ações de Victor, nesta ordem, com os comandos prontos no plano:

1. Apagar a Automation "PR opened" e os segredos `PSTACK_GITHUB_TOKEN` e `PSTACK_AGENT_TOKEN` no Cursor, **antes** de ligar o daemon para o Clinext; senão um owner de nuvem disputa os PRs do Dependabot com o daemon.
2. Exigir `hold` (app 15368) na proteção clássica da `main`.
3. Acrescentar o Clinext em `converge-local.json` e rodar `converge-local install`.

Prova: o próximo PR real do Clinext pelo fluxo inteiro, e o primeiro PR do Dependabot que o daemon certificar sozinho. Relatório no corpo do PR e no CLI-192.

### Pendências antigas que a virada resolve ou absorve

- **N16**, corrida entre a Automation e a Raiz: some com a Automation; a carência de 30 minutos cobre o daemon (ajustado na implementação, 2026-09-29, 0.4.5: a posse cobre o daemon, e a carência virou a espera pelo check de testes do head, com teto de 30 minutos).
- **N9**, Certificado maior que o comentário: resolvido pelo Certificado compacto.
- **N18**, política muda e invalida Certificados: deixa de travar; o daemon classifica `recertify` e refaz. Estreitar o digest de política fica como otimização futura.
- **N21**, token da Automation: sem objeto; o `gh` local é byvict.
- **N15**, comentários e verdicts `converge`: sem objeto depois do PR de remoção; até lá o daemon não toca PR com verdict `converge`.

### Volta atrás

`converge-local uninstall` para os dois jobs. O Pré-PR interativo continua funcionando e o auto-merge do GitHub não depende do daemon.

## Remoção da nuvem (PR 4)

Sai tudo o que só servia ao Cursor: `start.ts` e seu prompt de owner, `progress.ts`, a lane HTTP do runner e o probe HTTP do `setup-pstack` (`--repo`/`--pr`), o provider `cursor` da matriz, as linhas `pr owner` e `pr verifier`, a execução `converge` no gate (só `pre-pr` autoriza merge; `verdict-only` continua para provas), `CURSOR_API_KEY` de toda documentação. O playbook `converge.md` passa a descrever o Converge local. `docs/converge-v1.md` e `docs/converge-plan.md` ficam no repositório marcados como superados. Os testes das peças removidas saem com elas.

## Testes

Mesmas costuras dos testes existentes.

- **Daemon contra o GitHub falso da fixture.** Classificação: certificado e vermelho vira `repair`; gate recusa pela condição 7 vira `recertify`; sem verdict vira `certify`; draft, hold, fork, verdict de outra conta e verdict `converge` são pulados; PR com menos de 30 minutos espera; posse válida é respeitada; posse expirada ou de pid morto é ignorada. Ledger: duas falhas ou seis horas aplicam hold e comentam; head novo e remoção do rótulo zeram; `deferred` não gasta tentativa; teto de 2 horas mata e registra `timeout`. Uma Raiz por tick, o menor PR primeiro, repositórios na ordem da configuração.
- **Lançador com CLIs falsas.** A linha `converge raiz` vira o argv certo de `claude -p` ou `codex exec`, com modelo e esforço; provider diferente do parent é recusado; `outcome.json` ausente ou inválido é `failed`.
- **`setup-pstack`.** Famílias novas aceitas nas linhas abertas; alias recusado onde precisa de recibo; Certificador só onde a matriz diz `unsandboxed`; `converge raiz` só no provider do parent; aviso de família igual com Autor, e recusa de Revisor da família nativa do parent (ajustado na implementação, 2026-09-28); materialização do padrão; descarte das linhas de nuvem no PR 4.
- **Certificado.** Admissão sem tabela pinada; Revisor de família igual a qualquer Autor da lista recusado no `assemble` e no gate; versão 1 recusada; só dois artefatos por funcionalidade; re-derivação idêntica com o Certificado compacto.
- **Sem teste automático:** playbooks, prompt da Raiz e plists. A prova é o próximo PR do pstack-vic, depois o do Clinext, e o primeiro Dependabot certificado pelo daemon.

## Fora de escopo

- `unsandboxed` para claude e codex, e a higiene de ambiente por lane (adiados, acima).
- Estreitar o digest de política (nota N18, CLI-193).
- Grok Build como parent do pstack.
- Subir evidências do Certificador para o GitHub.
- Agrupar PRs do Dependabot.
- Notificações do daemon fora do GitHub e dos logs.
- Mais de uma máquina rodando o daemon para o mesmo repositório.

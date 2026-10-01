> Arquivo histórico. Este documento descreve o converge, que saiu do plugin na versão 0.5.0. A decisão, de 2026-09-30, está no [ADR 0005](../../../adr/0005-autopilot-substitui-converge.md). Nada aqui vale mais, e parte dos links não abre.

# Troca automática do Revisor pré-PR (desenho, 2026-09-29)

Desenho da "correção 2" que Victor pediu em 2026-09-29: quando a família do `pre-pr reviewer` escreveu parte do código da branch, o Pré-PR troca o revisor sozinho por outra família, sem parar para avisar. Vocabulário em [CONTEXT.md](../../../CONTEXT.md). Complementa o [desenho do Converge local](2026-09-28-converge-local-design.md), cuja "Regra cruzada" este documento aperta. As decisões abertas foram delegadas a esta sessão; cada uma está registrada abaixo com o porquê.

## Objetivo

Garantir a regra "nada mergeia sem revisão de outra família" também quando o código veio de uma lane que não é linha de autoria do sheet: uma candidata de arena, um worker de swarm, um runner de architect. Hoje o Pré-PR só conta as linhas de autoria (`feature, refactoring`, `bug-fix`, `perf-issue`, `hillclimb`, `hardest tasks`) e, no catch-up, a `converge raiz`. Uma candidata Grok de arena que vira a base entra na branch sem contar como Autor, e o revisor Grok revisa código Grok.

## Decisões de Victor (2026-09-29)

| Tema | Escolha |
|---|---|
| Forma da correção | **Versão completa**: troca automática do revisor, mesmo sendo caso raro. |
| Correção 1 (`grok:grok-4.7@xhigh` no `arena cross-judge pool` dos dois pais) | **Fora deste desenho.** Victor faz depois pelo `/setup-pstack`. |
| Implementação | **Só com o ok de Victor** depois do plano. |

## O furo, verificado em 2026-09-29

| Onde | O que faz hoje |
|---|---|
| `skills/poteto-mode/playbooks/pre-pr.md`, passo 0 | `AUTHORS` = providers das linhas de autoria que escreveram a branch. Arena, swarm e architect não entram. |
| `skills/poteto-mode/playbooks/catch-up.md`, passo 4 | `AUTHORS` = união das linhas de autoria do sheet mais `converge raiz`. O daemon não sabe o que uma sessão interativa anterior fez. |
| `skills/poteto-mode/scripts/converge/certify.ts` | Recusa lane `pre-pr reviewer` cujo provider está em `authorProviders` (parse do certificado, `assemble`, readmissão do publisher). `authorProviders` é declaração da Raiz (`--author-provider`). |
| `skills/setup-pstack/scripts/setup-pstack.ts`, `singleLaneRows` | `pre-pr reviewer` é linha de uma lane só; aceita qualquer família de CLI que o runner lança a partir do pai. `crossFamilyWarnings` avisa quando uma linha de autoria tem a família do revisor. |
| Sheets de Victor | Nos dois pais: `pre-pr reviewer: grok:grok-4.7@xhigh`, `arena runners` com Grok. Autoria: `claude:opus` no pai Claude, `codex:sol` no pai Codex. |
| `skills/poteto-mode/scripts/converge/github.ts`, `compared()` | O compare do GitHub (`contract...head`) já é a fonte dos arquivos e do diff das duas rodadas `pre-pr`; devolve também os commits da branch com mensagem, hoje descartados. |

## Decisões desta sessão

### 1. A autoria fica gravada num trailer de commit

**Escolha.** Todo commit da branch que carrega código escrito por uma lane leva, no bloco de trailers da mensagem, uma linha `Pstack-Author: <descritor>` por lane distinta (`grok:grok-4.7@xhigh`), e o que a Raiz escreveu à mão leva `Pstack-Author: <provider>` na forma nua (`claude`). A ferramenta lê os trailers do compare do GitHub, grava as famílias no `report.json` (`authors`) e as une às que a Raiz declara. O catch-up continua declarando a união conservadora do sheet (linhas de autoria mais `converge raiz`), que agora é um piso, não o teto.

**Por quê.**
- A união conservadora (incluir `arena runners`, `swarm workers`, `architect runners`) poria Grok em `AUTHORS` em todo catch-up dos dois pais, trocando o revisor sempre; no pai Claude, com Grok, Codex e Claude nas três listas, não sobraria família nenhuma para revisar. Foi rejeitada.
- Só a sessão interativa saber deixa o furo aberto exatamente onde ele mora: o daemon certificando ou recertificando uma branch que uma sessão anterior montou com arena.
- O trailer fica no head certificado. O head é imutável, o compare o entrega em toda rodada (branch e PR), e a mesma leitura vale para a sessão interativa, para o daemon e para o publisher. Um marcador no corpo do PR não existe antes do PR e pode ser editado depois; um arquivo no repositório sujaria o diff e as superfícies.
- A gramática é estrita (descritor da matriz ou nome de provider), então nenhum texto livre entra no relatório por essa via.

**Quem escreve o trailer.** Quem faz o commit: a lane delegada com `isolated-write`, porque o brief manda `git commit --trailer 'Pstack-Author: <descritor>'`; a Raiz, no commit que grava o artefato de um arena ou architect (um trailer para a candidata base e um para cada candidata enxertada), de um swarm (um por worker cujo código entrou) e do que ela mesma escreveu à mão (provider nu do pai). Uma lane por alias (`inherit-parent`, `auto`) é o modelo nativo do pai: provider nu. O rebase de **Opening a PR** preserva os trailers. Commits humanos e do Dependabot não levam trailer e não contam.

**Quem não escreve.** O Ajustador (decisão 3) e o Certificador (não escreve código).

### 2. O revisor reserva vem da própria linha `pre-pr reviewer`, em ordem de preferência

**Escolha.** A linha passa a aceitar uma ou mais lanes, de famílias distintas, na ordem em que o operador as prefere: `pre-pr reviewer: grok:grok-4.7@xhigh, codex:gpt-6-sol@xhigh`. Roda uma lane por rodada: a primeira cuja família não está em `AUTHORS`. A escolha é feita por um subcomando novo, `converge-certify reviewer`, que grava `RUN/reviewer.json`; o `assemble` só aceita a lane que esse arquivo nomeou.

**Por quê.**
- É o precedente do `arena cross-judge pool`: uma lista da qual a skill escolhe por família, sem resolver nada em tempo de execução além de uma regra explícita sobre uma lista que o operador digitou e sondou. Não é "runtime resolver" nem "weaker-model fallback" no sentido que o `setup-pstack/SKILL.md` proíbe: o operador escolhe as famílias e os efforts, e o probe cobre cada uma.
- Uma linha nova (`pre-pr reviewer, reserva`) duplicaria as regras da linha do revisor, exigiria um 24º papel e uma segunda leitura de aviso cruzado.
- Derivar da matriz (a "outra família de CLI do pai") teria de escolher modelo e effort por regra, ou seja, um resolver; e a família derivada pode não estar sondada neste pai.
- A escolha por ferramenta, gravada em arquivo, torna a troca determinística e testável, e fecha a porta para a Raiz lançar outra lane sem que o `assemble` note.

**Default da matriz.** `pre-pr reviewer` ganha default por pai: `claude: [grok-4-7@xhigh, sol@xhigh]`, `codex: [grok-4-7@xhigh, opus@xhigh]`. A reserva é a família de código nativa do outro pai, no effort do revisor: no pai Claude, Codex Sol; no pai Codex, Claude Opus. Coincide com o que os sheets de Victor já usam para Codex e Claude. Consequência: no primeiro uso, Sol entra no mapa do pai Claude pela linha do revisor e é sondado uma vez; a frase do `setup-pstack/SKILL.md` que diz o contrário muda.

**Como o `/setup-pstack` pergunta, valida e sonda.** A linha é perguntada como uma lista, não como painel: a opção "(keep)" com as lanes atuais, o default da matriz para este pai quando difere, e "Other" para uma lista digitada, uma lane por entrada, na ordem de preferência. A pergunta diz que roda uma lane por rodada, a primeira cuja família não escreveu nada da branch, e que a lista leva no máximo uma lane por família. `plan` recusa alias, família nativa do pai, família fora da rota `runner` ou fora do transporte `cli`, duas lanes da mesma família, e lista vazia: `role "pre-pr reviewer" takes one or more lanes of distinct families, each one of <lanes permitidas>; got ...`. O probe não muda: `buildPlan` já sonda cada família do mapa final que falta no ledger do pai, então a reserva é sondada uma vez ao entrar. O aviso cruzado passa a disparar quando **todas** as lanes da linha são da família de uma linha de autoria (texto mantido: `<linha> and pre-pr reviewer are both <família>; certification will refuse until one of them changes family`).

### 3. O Ajustador não conta como Autor

**Escolha.** Mantida a regra atual: os commits do Ajustador não levam trailer e sua família não entra em `AUTHORS`.

**Por quê.** O Ajustador escreve só em resposta a Achados nomeados por outra família; a Raiz revisa o diff dele antes do fast-forward; as Corridas rodam de novo no head consertado; e o Revisor pré-PR revê o diff inteiro na rodada seguinte. Contar o Ajustador trocaria o revisor no meio da tentativa em toda rodada com Achados (o Ajustador é Grok nos dois sheets, como o revisor), e a parada por "duas revisões seguidas com os mesmos Achados" compara revisões de famílias diferentes, o que a esvazia. O rastro do Ajustador continua sendo `adjustRounds` no Certificado.

### 4. Sem lane elegível: interativo para e nomeia; catch-up falha e o daemon segura

**Escolha.** `converge-certify reviewer` recusa com `No pre-pr reviewer lane is outside the author families (<famílias>): the row lists <lanes>; add a lane of another family with /setup-pstack`, sem escrever nada. A sessão interativa para ali, lança nada e repete a mensagem a Victor. O catch-up encerra `failed` com esse texto em `reason`; na segunda falha no mesmo head o daemon aplica o hold e comenta a causa no PR, que é como Victor fica sabendo.

**Por quê.** Nada muda sem Victor mexer no sheet, então `deferred` só adiaria. A família do pai nunca é elegível por construção (a linha só aceita famílias que o runner lança a partir do pai), então no pai Claude sobram Codex e Grok, e no pai Codex, Claude e Grok: um arena cuja base e enxertos cobrem as duas famílias externas deixa a branch sem revisor. É o limite honesto de "nada mergeia sem outra família".

### 5. Certificado, publisher, gate e daemon

**Escolha.**
- `report.json` ganha `authors`: providers únicos, ordenados, lidos dos trailers; vazio fora de `pre-pr`. Um trailer com valor que não é provider da matriz nem descritor resolvível vira gap `Unreadable Pstack-Author trailer in commit <sha7>`, e a rodada fica INCONCLUSIVE até o commit ser reescrito. Um compare com mais commits do que lista (`total_commits` maior que os 250 devolvidos) recusa como os 300 arquivos: `Branch compare truncated`.
- `certificate.authorProviders` passa a ser a união ordenada do declarado com `authors`. O schema do certificado continua 2: a forma não muda, só o conteúdo fica mais completo.
- `assemble` exige `RUN/reviewer.json` do mesmo round, confere que a união bate com o que o arquivo gravou, que a lane `pre-pr reviewer` admitida tem o descritor escolhido, e mantém a recusa por família de Autor.
- O publisher (`admitCertificate`) confere, além do que já confere, que toda família de `authors` do relatório do PR está em `certificate.authorProviders`. O parse do certificado mantém a invariante "revisor fora dos autores".
- O gate não muda: ele re-deriva no mesmo head da publicação, e os trailers são do head.
- O daemon passa `SHEET=<sheetPath da configuração>` no prompt da Raiz, e o catch-up usa esse caminho na escolha do revisor, para a Raiz ler o mesmo sheet que o daemon leu para a linha `converge raiz`.

**Por quê.** A ferramenta verifica as declarações da Raiz onde consegue: o trailer é a parte verificável da autoria, e a escolha gravada é a parte verificável da troca. O gate já compara head, patch e política; o head fixa os commits, então repetir a leitura ali não acrescenta nada.

## O que não muda

A fronteira continua sendo o Certificado. A linha `pre-pr reviewer` continua aceitando só famílias que o runner lança a partir do pai, sem alias. O Ajustador e o Certificador continuam como estão. O `hold` continua sendo o freio de Victor. A regra N35 (só um revisor Grok escreve prova de risco em lane `read-only` nesta versão) continua; ver **Limites**.

## Trailer de autoria

Chave `Pstack-Author`, comparada sem distinguir maiúsculas, como o git faz com trailers. Valor: `<provider>` ou `<provider>:<model>@<effort>`, com `provider` da matriz e, na forma longa, um descritor que `resolveDescriptor` aceita. Uma linha por lane distinta; repetições contam uma vez. O bloco de trailers é o último parágrafo da mensagem, com todas as linhas na forma `Chave: valor`.

Regra enunciada uma vez, em `provider-dispatch.md` (seção nova, prosa fora dos blocos gerados), e citada de: `opening-a-pr.md` (**Commits**: o rebase preserva os trailers e nenhum commit com código de lane sai sem o seu), `pre-pr.md` (passo 1: `authors` do relatório tem de nomear toda família que a sessão sabe que escreveu a branch, a própria inclusive; falta é commit sem trailer: reword, push de novo com `--force-with-lease`, `RUN` novo), `feature.md`, `bug-fix.md`, `perf-issue.md`, `hillclimb.md` (o brief da lane delegada manda commitar com `--trailer`; `refactoring.md` não delega por papel e não muda), `arena/SKILL.md` (Outputs: o commit que grava o artefato leva um trailer por candidata base e enxertada) e `swarm/SKILL.md` (Phase D: um por worker cujo código entrou).

Filho de stack: o compare `contract...head` inclui os commits do pai, então os autores do pai entram em `AUTHORS` do filho. É o esperado: o revisor do filho lê o diff do pai também.

## `converge-certify reviewer`

```
node <plugin>/skills/poteto-mode/scripts/converge/converge-certify reviewer \
  --directory RUN --parent <claude|codex> [--sheet PATH] --author-provider PROVIDER[,PROVIDER...]
```

Lê `RUN/report.json` (`round`, `authors`). Lê a linha `pre-pr reviewer` do sheet (`--sheet`, ou `~/.claude/pstack-models.md` e `~/.codex/pstack-models.md` pelo pai) com a mesma validação do `/setup-pstack`; uma linha inválida recusa nomeando o defeito e `change the model sheet with /setup-pstack`. `AUTHORS` = `--author-provider` ∪ `authors`, ordenado. Escolhe a primeira lane cuja família não está em `AUTHORS`, grava `RUN/reviewer.json` uma vez só (`wx`, como `report.json`) e imprime:

```json
{ "schemaVersion": 1, "round": "<round.id>", "descriptor": "codex:gpt-6-sol@xhigh", "provider": "codex", "model": "gpt-6-sol", "effort": "xhigh",
  "authorProviders": ["claude", "grok"], "skipped": [{ "descriptor": "grok:grok-4.7@xhigh", "provider": "grok" }] }
```

Sem lane elegível: exit 1 com a mensagem da decisão 4, nada escrito. Uma relaunch da lane (nota N29) no mesmo `RUN` reusa o arquivo; um `RUN` novo escolhe de novo.

O código da linha do sheet mora num módulo novo, `skills/poteto-mode/scripts/converge/sheet.ts`: `sheetRow(text, role)` (as lanes de uma linha; recusa linha ausente ou duplicada), `reviewerLanes(matrix, parent)` (o universo permitido: famílias de CLI com rota `runner` no pai, todo effort selecionável) e `checkReviewerRow(lanes, matrix, parent)` (a validação da decisão 2). `raiz.ts` passa a usar `sheetRow`; `setup-pstack.ts` usa os outros dois, e `singleLaneRows` deixa de listar o revisor.

## `assemble` e publicação

`assemble` lê `RUN/reviewer.json`, recusa quando falta (`Reviewer choice missing: run converge-certify reviewer`) ou é de outro round, calcula a união e recusa quando difere da gravada (`Author families differ from the reviewer choice`). Ao admitir a lane `pre-pr reviewer`, recusa descritor diferente do escolhido (`Reviewer lane differs from the chosen lane (<manifest>, chose <descriptor>)`) e mantém `Reviewer lane is the same family as an author (<provider>); launch the lane converge-certify reviewer chose`. O certificado grava a união em `authorProviders`.

`admitCertificate` acrescenta `Certificate author families miss a Pstack-Author family (<provider>)` quando `authors` do relatório do PR traz uma família fora de `authorProviders`.

## Sheet, matriz e `/setup-pstack`

- `model-matrix.json`: `pre-pr reviewer` com default por pai (acima) e descrição: "Reviews the pushed branch read-only before the PR exists: diff, risk classes and recorded runs. Lanes in order of preference; Pré-PR runs the first whose family wrote none of the branch."
- Rodapé da tabela de papéis em `provider-dispatch.md` (gerado por `model-matrix.ts`): a lista de `pre-pr reviewer` é ordem de preferência, uma lane roda; as outras listas continuam painéis.
- `setup-pstack.ts`: validação nova da linha; `crossFamilyWarnings` como na decisão 2; `singleLaneRows` sem o revisor.
- `setup-pstack/SKILL.md`: passo 2 (Sol entra no mapa do pai Claude pela linha do revisor), passo 3 (a pergunta e o parágrafo da linha), passo 7 (uma frase: a lista do revisor não é painel). Blocos gerados re-renderizados.

## Playbooks

- `pre-pr.md`: o passo 0 sai. O passo 1 ("Lease, push, report, reviewer") ganha, depois do `report`: a conferência de `authors`; o comando `reviewer` com `--parent` = o pai desta sessão e `--author-provider` = as famílias que a sessão sabe que escreveram a branch, a própria inclusive; a parada quando ele recusa; e a antecipação de N35: quando `hardList` do relatório tem entrada `requires-proof` e a lane escolhida não é Grok, parar aqui (interativo) ou encerrar `failed` com `Reviewer risk proof unavailable` (catch-up), sem lançar nada, porque o head não certifica nesta versão. O passo 3 escreve o `descriptor` de `reviewer.json` no manifesto e lança por ele. O passo 4 diz que o Ajustador commita sem trailer. O passo 6 passa o mesmo `--author-provider`. O parágrafo de N35 no passo 3 deixa de mandar trocar a linha pelo `/setup-pstack`, o que não resolve quando Grok é Autor.
- `catch-up.md`: `SHEET` no **Input**; passo 4: `--author-provider` = união das linhas de autoria do sheet mais `converge raiz`, `--sheet SHEET`; passo 6: a recusa do `reviewer` é `failed` com o texto em `reason`.
- `opening-a-pr.md`, `feature.md`, `bug-fix.md`, `perf-issue.md`, `hillclimb.md`, `arena/SKILL.md`, `swarm/SKILL.md`: as frases da seção **Trailer de autoria**.

## Daemon

`raizPrompt` ganha a linha `SHEET=<sheetPath>`; `RaizInput` ganha `sheetPath`, preenchido de `config.sheetPath` em `local.ts`. Nada mais muda no daemon: classificação, tetos, posse e ledger seguem iguais.

## Documentação

`converge-contract.md` (Commands: o subcomando; Certificado: `authors`, `reviewer.json`, a união, as recusas novas; publisher: a conferência nova). `CONTEXT.md`: Revisor pré-PR ("a primeira lane da linha cuja família não escreveu nada da branch") e Autor ("toda família que escreveu código da branch, declarada pela Raiz ou gravada em trailer de commit"). `docs/pre-pr.md`: história 5 e "Regra cruzada". ADR 0003: uma frase na consequência sobre a independência. `CHANGES.md`: entrada `0.4.4`. Versão em `package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json` (`version` e `ref`), `README.md` e `docs/reference.md` (`--ref v0.4.4`). A 0.5.0 continua reservada para a remoção da nuvem.

## Testes

- `certify.test.ts`, pelo comando `report`: o compare devolve os commits e `total_commits` maior que a lista recusa; `report` lê trailer longo e nu, deduplica e ordena; commit sem trailer não contribui; valor inválido vira o gap; execução `converge` tem `authors` vazio.
- `certify.test.ts`: `reviewer` escolhe a primeira elegível; pula família declarada e família de trailer; recusa sem elegível com a mensagem; recusa linha inválida (alias, família nativa do pai, família repetida, família desconhecida, linha ausente); recusa segunda chamada no mesmo `RUN`; `assemble` recusa sem `reviewer.json`, com round diferente, com união diferente, com lane de descritor diferente; grava a união ordenada.
- `publish.test.ts`: o publisher recusa certificado cujo `authorProviders` não tem uma família de trailer do PR.
- `setup-pstack.test.ts`: lista aceita; família repetida, alias, família nativa e lista vazia recusadas; aviso só quando todas as lanes colidem; sheets de primeiro uso por pai com a reserva; a reserva gera probe quando falta no ledger.
- `model-matrix.test.ts`: default por pai do revisor; 23 papéis; rodapé da tabela.
- `raiz.test.ts`: linha `SHEET`.
- Fixture `gh.mjs`/`setup.ts`: o compare passa a servir `commits` e `total_commits` de `state.commits` (padrão: um commit `head` sem trailer).

## Entrega

Um PR, `0.4.4`, certificado pelo plugin instalado (`0.4.3`), com a linha atual `pre-pr reviewer: grok:grok-4.7@xhigh` e `AUTHORS=claude`: o código do PR é escrito só pela linha `feature, refactoring`, sem arena, para que o revisor Grok seja cruzado sob a regra antiga. Os commits já levam `Pstack-Author: claude:claude-opus-5-5@xhigh`; a 0.4.3 os ignora.

Depois do merge: tag `v0.4.4`, instalação nos dois pais e nos jobs launchd; Victor roda `/setup-pstack` nos dois pais para acrescentar a lane reserva à linha do revisor (`codex:gpt-6-sol@xhigh` no Claude, `claude:claude-opus-5-5@xhigh` no Codex; a correção 1 pode ir na mesma passada). Até lá, a 0.4.4 com uma lane só se comporta como hoje, mais uma recusa clara quando um trailer nomeia Grok.

## Limites conhecidos

- **N35 continua.** Quando a troca cai numa família que não escreve prova de risco em lane `read-only` (Claude, Codex) e o relatório exige prova, o head não certifica nesta versão. O playbook para antes de lançar a lane e nomeia a causa; no catch-up vira `failed` e, na segunda, hold. Abrir prova de risco para as outras famílias fica para a mudança do runner que N35 já prevê.
- **Trailer esquecido.** A ferramenta só sabe o que o trailer diz. Na sessão interativa, a conferência de `authors` no passo 1 pega a falta; no daemon, o piso é a união conservadora do sheet. Um arena Grok commitado sem trailer por uma sessão que ignorou o playbook continua invisível ao daemon.
- **Todas as famílias externas como Autoras.** Sem revisor; decisão 4.
- **Mensagens de commit** não passam pela varredura de injeção, como hoje; o trailer é a única parte lida, e com gramática fechada.

## Fora de escopo

- Correção 1 (`arena cross-judge pool`).
- Prova de risco por revisor Claude ou Codex (N35).
- Conferência inversa no `assemble` (declarado ⊆ trailers): o catch-up declara por piso, então a conferência não pode ser exata.
- Trailers retroativos em branches abertas antes da 0.4.4.
- Contar o Ajustador ou o Certificador como Autor.

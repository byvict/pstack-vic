# Pré-PR proporcional à mudança (desenho, 2026-09-29)

Desenho fechado com Victor em 2026-09-29, opção B da investigação. Vocabulário em [CONTEXT.md](../../../CONTEXT.md). Parte da 0.4.5 ([#49](https://github.com/byvict/pstack-vic/pull/49)), que já tirou a espera fixa de 30 minutos do daemon: este desenho cuida de quanto trabalho o Pré-PR faz depois que a Raiz acorda, não de quando ela acorda. Complementa o [desenho do Converge local](2026-09-28-converge-local-design.md); a referência de código continua sendo a seção **Certificado** de [`converge-contract.md`](../../../skills/poteto-mode/references/converge-contract.md).

Numeração: o vigia de 60 s saiu como 0.4.6 ([#50](https://github.com/byvict/pstack-vic/pull/50)) a troca automática do Revisor como 0.4.9 ([#53](https://github.com/byvict/pstack-vic/pull/53)) e o Pós-merge e seu aviso como 0.4.10 e 0.4.11, então as duas releases daqui são 0.4.7 e 0.4.12; o texto abaixo ainda diz 0.4.8 para o script.

## Objetivo

Um PR pequeno de configuração, documentação, teste ou versão, como o [#48](https://github.com/byvict/pstack-vic/pull/48) (10 arquivos, +39/-8), deve certificar em minutos, sem abrir mão da regra do [ADR 0001](../../adr/0001-verificacao-pesada-antes-do-pr.md): nada mergeia sem revisão de outra Família. Código que o Converge executa (runner, scripts do Converge, playbooks, referências) continua na trilha cheia.

## Decisões de Victor (2026-09-29)

| Tema | Escolha |
|---|---|
| Trilha leve | **Opção B: classe leve por caminho, com revisor de prompt estreito e sem Certificador.** A opção C (sem revisor) fica disponível como uma palavra no contrato, `reviewer: "none"`, e não é o padrão. |
| Conteúdo da classe leve no pstack-vic | Docs comuns, testes, arquivos de versão, `CHANGES.md`, **`model-matrix.json` e o `provider-dispatch.md` renderizado**. |
| Esforço do revisor | Sem mudança e sem linha nova no sheet: medido, `high` e `xhigh` diferem 30 s. |
| Esforço da Raiz | Sem mudança, `xhigh`: o modelo custa 5 a 7 min por tentativa e é onde mora o julgamento (pin do jsdom, rebase com lockfile). |
| Entrega | Duas releases: **0.4.7** com a classe leve, o prompt estreito, o paralelismo nos playbooks e a releitura do PR; **0.4.8** com o script `converge-certify certify`. |

## Fatos medidos (2026-09-29)

Onde vão os minutos de uma tentativa da Raiz, em minutos, dos RUNs reais:

| Etapa | Clinext #2974 (19,3) | Clinext #2971 (16,4) | pstack-vic #48 pelo daemon (morta aos 9,1) |
|---|---|---|---|
| Preparação: playbook, `gh`, posse, fetch, worktree, deps | 1,5 | 5,2, com rebase e lockfile | 1,3 |
| Corridas | 3,4 + 3,2 (duas rodadas) | 2,5, em série | 3,1 (`test-bun` depois de `test`) |
| Diagnóstico e conserto pela Raiz | 2,4 | incluído acima | 0 |
| Preparar a lane à mão (a Raiz escreveu um `prep-lane.mjs` próprio) | 0,6 | 0,4 | 0,4 |
| Revisor `grok:grok-4.7@xhigh` | 5,4 | 6,4 | 4,4 de ~5,5 quando foi morta |
| Certificador `grok:grok-4.7@high`, nada a dirigir | 0,7 | 0,5 | não existe no pstack-vic (`certifier: false`) |
| Assemble, reconcile, publish, arm, outcome | 2,0 | 2,0 | faltou |
| Tempo de modelo da Raiz (`duration_api_ms`) | 5,4 | 6,6 | sem log |

Serial por necessidade: corridas antes do revisor, que lê os logs; Ajustador depois do revisor; rodada nova depois do conserto. Serial só por hábito: Certificador depois do revisor, `test-bun` depois de `test`, preparação de lane turno a turno. O #46 levou 35,6 min porque uma rodada de Ajustador repete corridas e revisor. No #47 a Raiz passou o comando inteiro como uma palavra ao `converge-certify run`, as três corridas voltaram `ENOENT` e ela refez tudo num RUN novo.

Revisores somente-leitura sobre o diff do #48, todos com 0 achados, rastro em `~/Dev/Skills/pstack-vic-runs/2026-09-29-pre-pr-proporcional/`:

| Revisor | Tempo | Entrada / cache / saída (tokens) |
|---|---|---|
| `grok:grok-4.7@xhigh`, prompt de hoje | 338 s | 133 k / 1,17 M / 24 k |
| `grok:grok-4.7@high`, prompt de hoje | 309 s | 113 k / 1,05 M / 23 k |
| `grok:grok-4.7@high`, prompt estreito | 207 s | 177 k / 285 k / 15 k |
| `codex:gpt-6.1-sol@high`, prompt de hoje | 182 s | 669 k / 591 k / 4,6 k |

O piso de 5 min do revisor Grok vem do número de turnos de leitura do repositório, não da profundidade de raciocínio. O prompt estreito corta um terço. Em diffs grandes o revisor chega a 16,9 min (#44, +1631) e 18,7 min (PR 2 da 0.3.x, 316 KB).

A Raiz do #48 recebeu `SIGTERM` externo aos 9,1 min, coincidindo com o merge por admin, e já trabalhava havia 8 min num PR mergeado; o playbook relê o PR só no passo 1 do Catch-up.

## O que não muda

O Certificado continua sendo a fronteira, publicado pelo `publish.ts` e julgado pelo gate. Schema 2 fica. A regra cruzada fica: o Revisor pré-PR não é de nenhuma Família de `authorProviders`. As linhas do sheet ficam as mesmas: sem linha nova, sem regra por tamanho de diff. `ci-only` continua sendo a classe de docs-only que pula as corridas. O Certificador continua só Grok, `unsandboxed`, em worktree descartável.

## Classe leve

### Contrato

O bloco `prePr` de `.cursor/converge.json` ganha `light`, opcional:

```json
"prePr": {
  "runs": [...],
  "certifier": false,
  "light": {
    "paths": ["README.md", "CHANGES.md", "NOTICE.md", "docs/**", "package.json", ".claude-plugin/**", ".codex-plugin/**", "model-matrix.json", "skills/poteto-mode/references/provider-dispatch.md", "**/*.test.ts"],
    "reviewer": "narrow"
  }
}
```

`paths` é uma lista de padrões, validados como `surfaces` (`relativePath`, `matches`); pode ser vazia, e então só a mudança só de dependência (abaixo) é leve. `reviewer` é `narrow` (padrão quando ausente) ou `none` (a opção C). `parseContract` recusa `light` sem `prePr` e `reviewer` fora do enum.

No pstack-vic, `riskClasses.contained` passa a listar também `skills/poteto-mode/playbooks/**`, `skills/poteto-mode/references/converge-contract.md` e `skills/poteto-mode/references/pre-pr-prompts.md`, além do runner e dos scripts do Converge que já lista: um caminho de risco nunca é leve. `provider-dispatch.md` fica de fora de `contained` por decisão de Victor; a parte renderizada é guardada por `matrix:check`, e uma edição à mão da prosa dele também viaja na classe leve. `skills/setup-pstack/SKILL.md`, que carrega os mapas renderizados, fica fora da lista inicial; Victor ajusta a lista no contrato quando quiser.

### Classificação

`analyze` em `reconcile.ts` decide o `mode` nesta ordem, com `ci-only` primeiro, como hoje:

1. `ci-only`: todo caminho é doc comum, ou, fora de `pre-pr`, a mudança é só de dependência; e nada casa com `surfaces`, `riskClasses` ou a hardList.
2. `light`: o contrato tem `prePr.light`; todo caminho mudado casa com `light.paths`, ou a mudança é só de dependência; nenhum caminho casa com `surfaces` ou `riskClasses`; e a hardList está vazia.
3. `full`: o resto.

Em `pre-pr`, a mudança só de dependência é `light`, não `ci-only`, para manter as corridas: foi a corrida que pegou o jsdom 30.1.1 no #2974. Fora de `pre-pr` a regra de hoje fica.

`Report.mode` ganha o valor `light`. As lanes de uma rodada `pre-pr`: `full` mantém `pre-pr reviewer` mais `pre-pr certifier` quando o contrato tem `certifier`; `ci-only` mantém `pre-pr reviewer`; `light` é `pre-pr reviewer`, ou nenhuma lane quando `light.reviewer` é `none`. A política de corridas de `light` é a de `full`: toda corrida do contrato registrada, no head, em checkout limpo. Só `ci-only` pula corrida.

### Certificado e decisão

`Decision.displayResult` ganha `Light`, que `decide` devolve para um relatório `light` VERIFIED, ao lado de `CI-only` e `VERIFIED`. `parseCertificate` e `parseDossier` aceitam o valor novo; a regra "corrida pulada só em certificado `CI-only`" fica. Um Certificado `light` com `reviewer: none` tem `lanes: []`: `assemble` admite zero manifestos, `decide` não exige lane que o relatório não pediu, e `authorProviders` continua declarado, mesmo que a regra cruzada fique vazia. Nenhum campo novo: `reconcileDigest` já cobre o `mode` do relatório de branch.

### Gate e classificador do daemon

Hoje `retainedLanes` em `publish.ts` fabrica, na re-derivação, uma lane por papel que o relatório recalculado exige, com a cobertura do dossiê. Um Certificado leve re-derivado sob uma política que voltou a exigir revisor passaria sem revisor. `rederivePrePr` em `gate.ts` passa a recusar quando algum papel de `report.lanes` recalculado não está em `dossier.certificate.lanes`: `Certificate lacks a lane the policy now requires at trunk tip SHA`. `classify.ts` inclui esse prefixo no regex `stale`, então a recusa vira trabalho `recertify` e o Varredor desarma o PR até a nova rodada. A publicação não precisa de mudança: o relatório de PR é analisado no mesmo commit de contrato do Certificado, e as lanes admitidas vêm do próprio Certificado.

### Prompt do revisor

`pre-pr-prompts.md` ganha o bloco **Reviewer (light)**: o bloco **Reviewer** com uma frase a mais depois de "Review the diff for defects and risks.": o diff é pequeno, leia o diff e os logs das corridas uma vez, abra um arquivo do repositório só onde uma linha mudada precisa do contexto em volta para ser julgada, e não varra o resto do repositório. Mesmos placeholders, mesmo JSON final. A Raiz usa esse bloco quando `report.mode` não é `full`, ou seja, em `light` e em `ci-only`. O manifesto continua gravando o digest do prompt, e a admissão continua conferindo os bytes.

### Playbooks (0.4.7)

- `pre-pr.md`, passo 1: `mode: ci-only` pula os passos 2 e 5; `mode: light` pula o passo 5 e, com `reviewer: none` no contrato, pula o passo 3, e o passo 6 monta o Certificado sem lane.
- Passo 2: lançar todas as corridas do contrato de uma vez, cada uma em background, e esperar todas; hoje o texto diz "em background" por corrida e a Raiz as encadeou.
- Passo 3: o bloco **Reviewer (light)** quando `mode` não é `full`.
- Passo 5: lançar o Certificador logo depois do relatório do passo 1, em paralelo com os passos 2 e 3, porque ele não lê corridas nem revisão; preparar o worktree dele antes; drenar junto com o revisor. Um reinício no passo 4 descarta o resultado do Certificador com o resto do RUN. Continua valendo: só quando `report.json` lista `pre-pr certifier`.
- `catch-up.md`, passo 4: reler o PR ao vivo antes de cada lançamento de lane; uma condição do passo 1 que passou a valer encerra a tentativa `skipped`, que o tick não registra quando o PR relido a explica.
- `converge-contract.md`, seção **Certificado**: a regra de `light`, `Light` no `displayResult`, a lane opcional e a recusa nova do gate. `docs/pre-pr.md` e `docs/reference.md` ganham a mesma regra em uma frase cada.

A lane Grok continua limitada a 300 s por comando e o runner continua uma lane por invocação: o paralelismo é a Raiz em `claude -p` lançar cada runner com `run_in_background` e bloquear em cada handle antes de julgar, como `provider-dispatch.md` já manda para pai não interativo.

### Clinext: bump de dependência como classe leve

`branchSnapshot` em `github.ts` fixa `dependencyOnly: false`, então um PR do Dependabot nunca sai leve numa rodada `pre-pr`. A rodada de branch passa a calcular `dependencyOnly` como a rodada de PR faz, sem a checagem de autor, que o daemon já faz na lista de confiança: só `package.json` e `package-lock.json`, na raiz ou em `client/`, todos `modified`, e `dependencies.ts` aprovando cada par de blobs no commit de contrato e no head. Um bump assim cai em `light` quando nada casa com risco: corridas, revisor estreito, sem Certificador, que no #2974 e no #2971 não teve funcionalidade a dirigir. O contrato do Clinext ganha `light: { "paths": [] }`; a classe leve dele é só esse caso.

## Script `converge-certify certify` (0.4.8)

Um subcomando que executa a metade "Certificar um head empurrado" inteira, de forma determinística:

```sh
node <plugin>/skills/poteto-mode/scripts/converge/converge-certify certify --repo OWNER/REPO --head SHA --directory RUN --worktree W --parent claude [--sheet PATH] --author-provider A[,B] --adjust-rounds N [--certifier-worktree RUN/certify] [--lease-by NAME --lease-pid N --branch B]
```

O que ele faz: `report` (recusa `unmappedSurfaces` de volta ao passo 1); todas as corridas do contrato em paralelo, com o mesmo registro de `run`; prompt e manifesto de cada lane que o relatório pede, com o bloco por `mode`; renovação da posse antes de cada lançamento quando `--lease-by` vem; um `pstack-runner` por lane, em paralelo, com prompt, output e recibo próprios; uma relançada por lane num recibo que não é `complete`, movendo a anterior para `RUN/attempts/`; drenagem; `assemble`. Na saída, o Certificado, ou `{ "refused": { "step": "report|runs|reviewer|certifier|assemble", "reason": "..." } }` com exit 1 e o RUN intacto. As linhas `pre-pr reviewer` e `pre-pr certifier` vêm do sheet do pai, como `raiz.ts` lê `converge raiz`. O worktree do Certificador é preparado pela Raiz, com as dependências que o repositório documenta, e passado em `--certifier-worktree`; o script confere que está no head e limpo antes de lançar.

O que fica com a Raiz: posse e push, o julgamento do Ajustador, o reparo, a metade **Entregar**, o `outcome.json`. A Raiz lança o script com `run_in_background` e bloqueia no handle, pela mesma regra dos runners. Os playbooks trocam os passos 1 a 6 por essa chamada e mantêm a prosa dos passos como referência do que o script faz. `prepare-lane.ts` continua só para o `pr verifier` da nuvem até a 0.5.0.

## Testes

`node --test`, com `npm test` verde em cada release:

- `contract.test.ts`: parse de `light`, os padrões validados como `surfaces`, `reviewer` com padrão `narrow`, recusas de `light` sem `prePr`, de `paths` vazio e de `reviewer` fora do enum.
- `reconcile.test.ts`: `light` quando todos os caminhos casam; `full` quando um caminho fica fora, casa com `surfaces` ou `riskClasses`, ou a hardList não está vazia; docs-only continua `ci-only`; dependência só é `light` em `pre-pr` e `ci-only` fora; lanes por `mode`, com `reviewer: none` dando `[]`; Certificador nunca em `light`; a rodada de branch com `dependencyOnly` verdadeiro e falso, inclusive um bump maior que minor, que fica `full`.
- `certify.test.ts`: Certificado `light` com a lane do revisor e `displayResult` `Light`; com `reviewer: none`, sem lane; recusa de lane de Certificador em `light` (`Unexpected independent lane`); corrida faltando recusa em `light` como em `full`.
- `publish.test.ts`, `arm.test.ts`, `sweep.test.ts`: o Certificado `light` publica e arma; um contrato que tira um caminho de `light.paths` faz o gate recusar com a mensagem nova e o Varredor desarmar.
- `local.test.ts`: a recusa nova classifica como `recertify`.
- Um teste de docs: o bloco **Reviewer (light)** existe, tem os mesmos placeholders do bloco **Reviewer** e o JSON final igual.
- 0.4.8, `certify.test.ts` com `fixtures/gh.mjs` e um runner falso: corridas em paralelo, lanes em paralelo, relançada única, cada recusa com o passo certo, a posse renovada antes de cada lançamento, e o Certificador recusado quando o worktree não está no head ou não está limpo.

`test:bun` não muda: o runner não muda. `matrix:check` e `agents:check` não mudam: a matriz não muda.

## Entrega

Duas releases pelo padrão do repositório: versão em `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.codex-plugin/plugin.json` e nas linhas `--ref` de `README.md` e `docs/reference.md`; entrada em `CHANGES.md`; tag; instalação nos dois pais; `converge-local install` de novo em cada uma, porque os jobs launchd apontam para o cache da versão.

- **0.4.7**: contrato, classificação, `Light`, gate e classificador, bloco do revisor, playbooks, `dependencyOnly` na rodada de branch, o contrato do pstack-vic com `light` e o `contained` ampliado, e um ADR 0004 de um parágrafo: trilha leve por caminho, com a regra cruzada mantida e código executado sempre na trilha cheia. O contrato do Clinext ganha `light` numa mudança à parte, feita por Victor no repositório dele. O PR da 0.4.7 muda playbooks e scripts do Converge, então é trilha cheia; ele mesmo prova que o `contained` ampliado funciona. O primeiro PR leve real depois dele é a prova da classe.
- **0.4.8**: o script `certify` e os playbooks apontando para ele.

Estimativa de tempo da Raiz, depois da espera, para um PR como o #48: hoje ~12,5 min; 0.4.7 ~10 min; 0.4.8 ~9 min. Para um Dependabot como o #2974, com uma rodada de conserto: hoje 19,3; 0.4.7 ~17; 0.4.8 ~16. Um PR como o #47, que muda `tests/*.sh` e `scripts/*.test.ts`, fica na trilha cheia em qualquer versão.

## Fora de escopo

- Opção C como padrão. O contrato aceita `reviewer: "none"` desde a 0.4.7 e o padrão é `narrow`.
- Trocar o revisor para `codex:gpt-6.1-sol` no pai Claude: 3,0 min medidos, sem código, via `/setup-pstack`, mas com a nota N35: só lane Grok grava prova de risco em `read-only`, e um PR do Clinext com caminho de dinheiro sairia `INCONCLUSIVE`. Depende de uma mudança do runner para lanes Codex e Claude devolverem artefatos de prova.
- Esforço da Raiz e do revisor por tamanho de diff: medido, não compensa.
- Uma Raiz morta por sinal externo conta como tentativa `failed` no ledger; duas seguram o PR. Fica para o daemon.
- Ordem entre corridas do Clinext (`preflight` antes das suítes): sem dado; o script lança todas de uma vez e o contrato pode ganhar uma ordem depois, se uma corrida provar que depende de outra.

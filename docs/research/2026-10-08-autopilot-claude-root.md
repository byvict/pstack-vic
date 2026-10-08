# Autopilot-full com Claude na Raiz do app desktop

Execução de 2026-10-08, com poteto-mode como workflow, porque o objeto da prova é o próprio playbook. Uma sessão do Claude Code no app desktop foi a Raiz de um programa Autopilot-full no repositório descartável [byvict/pstack-lab](https://github.com/byvict/pstack-lab). A fila tinha dois itens independentes: `clamp` e `slugify`, cada um com uma função e os testes dela. O programa foi do "go" do Victor aos dois merges, com Donos nativos, Rodadas de Enxame, Vereditos publicados nos PRs, merge pelo Dono, Ticks reais e revisão das trilhas por outra família. Nenhum modelo, esforço, fallback de swarm, política de Arena ou de trilha mudou.

Evidência privada em `~/Dev/Skills/pstack-vic-runs/2026-10-08-autopilot-claude-root/`:
- `identity.txt`, `capture.sh`, `events.log`, `inventory.tsv`, `decisions.tsv` e `todo.md`, todos da Raiz;
- `owners/<item>/`, com brief, `decisions.tsv`, `children.tsv`, `reports.log` e provas;
- `rounds/<item>-r<N>/`, com os briefs e os resultados das lanes e o Veredito;
- `ticks/`, `02-cross-judge/`, `03-trail-review/` e `04-host-facts/`.

Os transcripts ficam em `~/.claude/projects/-Users-victorbaccega-Dev-Skills-pstack-vic--claude-worktrees-recursing-poincare-6c3e18/f6f34d58-2fa4-4be5-a086-4c37e866dd42.jsonl` e `…/subagents/agent-<id>.jsonl`.

## Identidade e base

| Item | Valor |
| --- | --- |
| Raiz | sessão `f6f34d58-2fa4-4be5-a086-4c37e866dd42`, Claude Code 2.1.293 dentro do app 2.26454.2, `CLAUDE_CODE_ENTRYPOINT=claude-desktop`, `--effort xhigh`, modelo `claude-opus-5-5`; o `claude` no PATH é 2.1.292 |
| Plugin | `pstack@pstack-vic` 0.5.25, instalado no SHA `617ea1a1`, igual à `origin/main` (merges #99 a #113, mais a #112) |
| Autorização | `authorize.ts check --parent claude` da cópia instalada: saída 0, `authorized: true`, entrada v3 |
| Modo de permissão | `bypassPermissions` (lido em `get_session`) a partir da entrada no poteto-mode; o Victor manteve o modo no "go" |
| Laboratório | `byvict/pstack-lab` público, Node 24, `npm test` = `node --test`, ruleset `24744380` exigindo o check `test` na `main`, `main` em `59c49c53` |
| Forja | `gh` (o comando `origin` não existe nesta máquina) |
| Planilha | `feature, refactoring` e `swarm workers` = `claude:claude-opus-5-5@xhigh`; `swarm fallback` igual; `trail reviewer pool` e `arena cross-judge pool` com Codex e Grok elegíveis |

O poteto-mode tem `disable-model-invocation`. O host recusou `Skill(pstack:poteto-mode)` com "Ask the user to run /pstack:poteto-mode themselves". O Victor digitou o comando com a fila, que é o passo 1 de "Como um programa começa". A Raiz entregou o protocolo e parou (state-then-wait). Antes disso, um `cd ~/Dev/pstack-lab` num comando composto da Raiz moveu a pasta da sessão, que é o fato 6 já conhecido. A Raiz manteve a pasta lá, porque o `isolation: "worktree"` cria o worktree no repositório da pasta da sessão. Assim os Donos ganharam worktrees do pstack-lab.

## Linha do tempo (UTC)

| Hora | Evento |
| --- | --- |
| 19:59:39 | "go" do Victor, sem item reservado |
| 19:59:43 | Tick 1 armado (`Bash` em segundo plano, `sleep 3600`, `timeout` 3 900 000 ms, tarefa `buyrvdrju`) |
| 20:00:53 a 20:02:10 | dois Donos `pstack:pstack-owner-opus-xhigh`, `isolation: "worktree"`, `run_in_background: true`, sem `model` |
| 20:03:16 / 20:05:08 | PR 1 (`clamp`) e PR 2 (`slugify`) abertos prontos, cerca de 3 min depois de cada Dono nascer |
| 20:13:33 | `clamp` Code-ready `0dea3fe2`; Rodada 1 às 20:14:15 |
| 20:19:14 | Veredito `clamp` r1 não limpo (F1); correção pedida às 20:19:30 |
| 20:25:07 | `clamp` push `bf97c67d`; Rodada 2 às 20:25:40 |
| 20:27:08 | `slugify` Code-ready `ebae8c70`; Rodada 1 às 20:27:41 |
| 20:28:38 | Raiz lança o juiz do Arena do `slugify` (Codex), que o Dono não podia lançar |
| 20:31:35 | Veredito `clamp` r2 limpo; merge liberado às 20:31:47 |
| 20:32:15 | PR 1 mergeado (`694b5f8e`) pelo Dono |
| 20:34:52 | Veredito `slugify` r1 não limpo (I1); correção pedida às 20:35:11 |
| 20:39:44 | `slugify` push `fd722262`; Rodada 2 às 20:40:20 |
| 20:47:28 | Veredito `slugify` r2 limpo; preparo do merge liberado às 20:47:40 |
| 20:48:18 | rebase de preparo `8dc24d01` sobre `694b5f8e`; patch-id igual; CI verde às 20:48:25; merge liberado às 20:48:45 |
| 20:49:03 | PR 2 mergeado (`67fafb33`) pelo Dono |
| 20:51 a 20:56 | trilhas dos dois Donos revisadas por `codex:gpt-6.1-sol@xhigh` |
| 20:59:43 | Tick 1 disparou; Tick 2 re-armado às 20:59:47 (tarefa `bsj3uy8lf`) |
| 21:26:55 a 21:27:00 | outra sessão do operador tira o pstack do escopo de usuário e o instala no escopo de projeto de dois worktrees |
| 21:59:47 | Tick 2 disparou; Tick 3 re-armado na mesma volta (tarefa `bmcw82zhr`); o host anunciou que os agentes e as skills do pstack saíram da sessão |

## O que o programa fez contra o que os playbooks pedem

| Pedido do playbook | O que aconteceu | Leitura |
| --- | --- | --- |
| Passo 1, state-then-wait | protocolo entregue e parada até o "go" | cumprido |
| Passo 2, forja resolvida uma vez | `gh`, com o fallback registrado | cumprido |
| Passo 2, um Dono em segundo plano por PR, worktree próprio | dois `Agent` com `pstack-owner-opus-xhigh` e `isolation: "worktree"`; a notificação trouxe `worktreePath` de cada um | cumprido |
| Passo 2, trilha e PR pronto em cerca de 15 min | primeira linha do `decisions.tsv` às 20:02:49 e 20:03:50; PRs prontos em cerca de 3 min | cumprido |
| Passo 2, `children.tsv` | 3 filhos no `clamp`, 7 no `slugify`, todos terminais no fim | cumprido |
| Passo 2, rebase antes do Code-ready e publicação com lease | `clamp` refez a branch sobre `origin/main` e publicou com `--force-with-lease`; o do `slugify` foi nulo | cumprido |
| Passo 2, checagem antes do push que abre a Rodada | o `slugify` empurrou `ebae8c7` às 20:25:06 e rodou `npm test` nele às 20:25:57, antes do Code-ready | desvio de ordem, sem efeito no merge |
| Passo 2, avisos de Code-ready, push que muda o patch e Merge-ready | todos por `SendMessage` para `main`; a Raiz respondeu por `SendMessage` ao ID do Dono | cumprido; o mecanismo não estava documentado |
| Passo 3, paralelo de verdade | os dois Donos e até 10 lanes de Enxame ao mesmo tempo, sem recusa de capacidade | cumprido |
| Passo 4, Rodada no head Code-ready e em cada push que muda o patch | quatro Rodadas, cada uma com cinco lanes novas (gates, ao vivo, duas revisões, regressão) | cumprido |
| Passo 4, lane ao vivo como piso | ao vivo em toda Rodada; nas duas primeiras foi ela que provou o defeito | cumprido |
| Passo 4, nota de lane conta como achado | F1 e I1 vieram também como notas em três lanes; a Raiz os tratou como achados | cumprido |
| Passo 4, um só pedido de correção com teste vermelho e defeito no brief seguinte | um pedido por Rodada; testes vermelhos provados (2 de 21 e 3 de 14 falhando no código antigo); o defeito entrou no campo `KNOWN` das lanes da Rodada seguinte | cumprido |
| Passo 4, auditar os recibos do Merge-ready antes do Veredito | a Raiz releu CI e recalculou o patch-id antes de cada Veredito, mas só abriu os arquivos de prova dos Donos no Tick 1, depois dos dois merges | desvio; a leitura tardia confirmou os números, mas não repõe o portão que vinha antes do Veredito |
| Passo 5, merge a partir de head rebaseado, CI e patch-id | `clamp`: a Raiz liberou o merge dizendo que, sem trunk nova, não precisava rebasear, e o head `bf97c67d` já estava sobre a ponta `59c49c53`, então um rebase não mudaria nada; `slugify` rebaseado sobre `694b5f8e`, patch-id `fa621de6` recalculado pela Raiz, CI verde, nova liberação para o head exato | cumprido no efeito; o texto da liberação do `clamp` dispensou o rebase em vez de pedir um rebase nulo |
| Passo 5, `merge-tree` e caminhos de desvio logo antes do merge | feitos pelos dois Donos; `gh pr merge --squash --match-head-commit` | cumprido |
| Passo 5, Dono novo para o próximo item | fila vazia | não se aplicou |
| Passo 6, Tick a cada hora com a cadência do host | `Bash` em segundo plano, re-armado como primeiro passo; ver [Tick](#tick) | cumprido; lacuna de cobertura |
| Passo 6, retro e varredura de comentários de robôs | feitas no Tick 1; nenhum robô comentou | cumprido |
| Feature, passos 1, 2 e 7 | `how` pulado nos dois (repositório de seis arquivos); `architect` pulado no `clamp` e rodado no `slugify` com Opus, Sol e Grok; `interrogate` pulado; cada pulo com motivo | cumprido pela regra de `skip:` |
| Arena, fase C | o Dono do `slugify` julgou sozinho; a Raiz lançou o juiz Codex depois | lacuna corrigida nesta PR |
| show-me-your-work, auditoria da trilha contra o transcript | os revisores Codex dizem que nenhum Dono leu o conteúdo do próprio transcript; a primeira auditoria da Raiz também só listou ponteiros, e a de verdade (contagem das ações no transcript) veio depois da revisão | lacuna dos Donos; corrigida na Raiz |
| show-me-your-work, revisão por outra família | uma lane Codex por trilha de Dono e uma para a trilha da Raiz | cumprido |

## Rodadas e Vereditos

| Item | Rodada | Head | Patch-id | Lanes | Veredito |
| --- | --- | --- | --- | --- | --- |
| clamp | 1 | `0dea3fe2` | `9e6df6ee` | gates, regressão e testes PASS+NOTES; ao vivo e correção ISSUES | [não limpo](https://github.com/byvict/pstack-lab/pull/1#issuecomment-6068300933): F1 |
| clamp | 2 | `bf97c67d` | `9e98d8ab` | gates e regressão PASS; ao vivo, correção e testes PASS+NOTES | [limpo](https://github.com/byvict/pstack-lab/pull/1#issuecomment-6068503917) |
| slugify | 1 | `ebae8c70` | `b96b81fe` | gates PASS; ao vivo ISSUES; correção, testes e regressão PASS+NOTES | [não limpo](https://github.com/byvict/pstack-lab/pull/2#issuecomment-6068556499): I1 |
| slugify | 2 | `fd722262` | `fa621de6` | ao vivo PASS; gates, correção, testes e regressão PASS+NOTES | [limpo](https://github.com/byvict/pstack-lab/pull/2#issuecomment-6068756013); vale para `8dc24d01` pelo patch-id |

**F1.** O `clamp` checava tipos antes das regras de RangeError do item. Por isso `clamp(NaN, 0, undefined)` lançava TypeError.

**I1.** O `slugify` dobrava caracteres de compatibilidade (NFKD), então `™` virava `tm` e `²` virava `2`. Ele também soletrava letras como `ß` em ASCII.

Nos dois casos a Raiz decidiu pelo texto do item, que é a especificação do operador. No I1, parte do erro era da própria Raiz, cujo brief tinha aberto `ß` e `ø` como escolha do Dono.

Duas regras ficaram como padrão que o Victor pode trocar:
- o `slugify` segue o item ao pé da letra (`Straße` vira `stra-e`);
- ele apaga todas as marcas combinantes (`\p{M}`), e não só as sem espaço.

Do Code-ready ou do push de correção até o Veredito, cada Rodada levou de 5,7 a 7,7 minutos (`events.log`), ditados pela lane mais lenta. Nas duas Rodadas não limpas, a lane ao vivo sozinha já marcava ISSUES. As notas das outras lanes confirmaram o achado, mas não foram elas que impediram o merge. As 20 lanes, mais o juiz e as duas revisões de trilha, terminaram sem travar e sem dropout.

## Tick

O Tick 1 foi armado às 19:59:43 e disparou às 20:59:43. A notificação abriu o turno, e o comando foi re-armado às 20:59:47, então em até 4 s. A saída trouxe o prompt do Tick palavra por palavra (`ticks/tick-1.output`).

A auditoria do Tick 1 (`ticks/tick-1/audit.md`) fez estas coisas:
- releu o playbook instalado;
- chamou `ListAgents`, que não listou nenhum subagente vivo;
- conferiu os `children.tsv`;
- abriu os recibos dos Donos, que era o desvio do passo 4;
- fez a retrospectiva dos dois merges e a varredura de comentários de robôs.

Ela não escreveu no chat, porque tudo já tinha sido relatado.

O Tick 2 disparou às 21:59:47, uma hora depois do re-arme. A auditoria dele (`ticks/tick-2/audit.md`) achou uma mudança: o pstack tinha saído do escopo desta sessão.
- No mesmo turno, o host anunciou que todos os tipos de agente `pstack:*` estavam "no longer available", e as skills do pstack sumiram da lista.
- O `installed_plugins.json` perdeu a entrada de usuário e ganhou duas de projeto, criadas às 21:26:55 e às 21:27:00 por outra sessão do operador ("Desinstalar pstack vic do usuário").
- O playbook auditado foi o do cache 0.5.25, com o mesmo sha256 do início do programa.

O Tick 2 relatou essa mudança no chat e re-armou o Tick 3. A revisão da trilha da Raiz mostrou duas falhas nesse Tick:
- ele comparou o sha256 do playbook em vez de reler o texto;
- ele repetiu o estado dos `children.tsv` e da trunk do laboratório sem nova leitura.

As duas estão registradas como linhas que substituem a auditoria. Depois da última lane delegada, a revisão da trilha da Raiz, o Tick 3 foi parado por `TaskStop` ("Successfully stopped task"), sem ter disparado.

**Lacuna de cobertura.** Os dois merges saíram 50 minutos depois do "go". Por isso nenhum Tick disparou com um Dono vivo, e o que este programa prova é o relógio, não a auditoria de Donos em andamento.

Há duas evidências parciais de que o despertar em segundo plano chega com subagentes vivos:
- o fim de um `Bash` em segundo plano (a espera do CI do `slugify`, tarefa `bnx44urra`) acordou a Raiz às 20:48:25 enquanto o Dono do `slugify` rodava;
- os avisos dos Donos por `SendMessage` chegaram como turnos novos durante toda a execução.

## Trilha de decisão e revisão por outra família

A trilha da Raiz (`decisions.tsv`) tem uma linha por decisão: protocolo, Rodadas, Vereditos, liberações, desvio corrigido e Ticks.

As duas trilhas de Donos foram revisadas por `codex:gpt-6.1-sol@xhigh`, escolhido pelo `setup-pstack.ts pick --parent claude --role "trail reviewer pool"`. Os dois recibos são `complete`, com `pinned-argv`, então o modelo não foi confirmado pelo provedor. O revisor do `slugify` levantou cinco pontos e o do `clamp`, quatro. Eles estão na seção Atenção abaixo.

A trilha da Raiz foi revisada do mesmo jeito, com recibo `complete` e sete apontamentos, também listados na seção Atenção.

A Raiz aceitou seis deles e corrigiu este relatório e as auditorias com linhas novas, sem apagar as antigas. Depois ela auditou a própria trilha contra o conteúdo do transcript (`05-verify/root-transcript-actions.tsv`), e as ações batem com a trilha:
- 22 `Agent`;
- 6 `SendMessage`;
- 4 Vereditos publicados;
- 4 lanes pelo runner;
- 3 armações de Tick;
- 1 `TaskStop`.

O juiz do Arena do `slugify`, `codex:gpt-6.1-sol@max`, também tem recibo `complete`. Ele preferiu outro candidato como base por causa de uma tabela mutável, e a correção do I1 eliminou essa tabela.

## Lacunas para Claude como raiz

1. **Canal entre Dono e Raiz.** Nenhum texto dizia como um Dono avisa a Raiz no Claude Code. `SendMessage` para `main` funcionou em todos os avisos. A resposta da Raiz por `SendMessage` ao ID retomou um Dono parado ("Resuming agent") e entrou na fila de um Dono em execução ("queued for delivery … at its next tool round"). As duas entregas foram confirmadas pelos efeitos: correção, merge e merge do head certo. Corrigido nesta PR.
2. **Lane de pool pedida por um Dono.** A regra "a subagent does not launch a pool lane" não dizia o que um Dono faz quando precisa do resultado antes de seguir. O Dono do `slugify` julgou o Arena sozinho. Corrigido nesta PR: o Dono pede a lane à Raiz pelo mesmo canal e espera.
3. **Sem ferramenta de lista de tarefas.** A Raiz e os dois Donos não tinham `TodoWrite` nem `TaskCreate` (`ToolSearch` respondeu "No matching deferred tools found"). Os três guardaram a lista do playbook em `todo.md`. Corrigido nesta PR como regra da adaptação de plataforma.
4. **Trava de worktree.** Houve 45 recusas em 18 dos 30 subagentes (`04-host-facts/guard-refusals.tsv`):
   - git dentro de substituição de comando, pipe ou variável;
   - `git -C` apontado para o checkout compartilhado;
   - texto de argumento que cita comandos git;
   - `sed`, `node`, `npm` e `find` com argumento calculado na hora.

   Um ajudante lançado sem `isolation` por um Dono isolado roda no worktree do Dono sob a mesma trava. Documentado nesta PR em `native-lifecycle.md`.
5. **Notificação sem worktree.** Uma lane que deixou o worktree limpo na branch em que nasceu teve o worktree removido, e a notificação veio sem `worktreePath`. Foi uma observação só. Documentado nesta PR.
6. **Tick com Dono vivo.** Ainda não foi medido num programa: ver [Tick](#tick). Um programa com itens maiores, de mais de uma hora, cobre isso.
7. **Plugin retirado no meio do programa.** O escopo do plugin mudou por outra sessão e a Raiz perdeu os agentes e as skills do pstack no turno seguinte. Neste programa nada vivo dependia deles. Um Dono ou uma lane em andamento teria perdido os papéis nativos, e uma Raiz que ainda precisasse lançar Donos não teria o `pstack-owner-*`. O runner continuou utilizável pelo caminho do cache. Não há correção de harness para isso. A regra operacional é não mexer no escopo do plugin enquanto um programa roda.
8. **Modo automático.** Com `bypassPermissions`, o classificador do modo automático não rodou, e a autorização permanente v3 não foi exercida nos merges. Os merges ficaram presos só às regras do playbook. Um programa em modo automático cobre isso.
9. **Auditoria da trilha pelos Donos.** Os revisores dizem que nenhum Dono leu o conteúdo do próprio transcript, e o brief não lembrava esse passo. Fica como lição de brief, sem mudança de texto do upstream.
10. **Limpeza.** Ficaram no pstack-lab as branches remotas `autopilot/clamp` e `autopilot/slugify`, as branches locais `impl/*` e cerca de 23 worktrees de agentes. O playbook não manda limpar, e a skill `faxina` cobre isso.

## Correção de harness desta PR

Só adaptação de harness, sem fluxo paralelo e sem tocar nos playbooks gerados do upstream:

- `skills/poteto-mode/SKILL.md`, Platform Adaptation: a lista de tarefas vai para `todo.md` quando a sessão não tem a ferramenta.
- `skills/poteto-mode/SKILL.md`, Autopilot owners: no Claude Code, o Dono avisa por `SendMessage` para `main`, a Raiz responde ao ID, e o Dono pede pela Raiz uma lane de pool de que precisa.
- `skills/poteto-mode/references/provider-dispatch.md`, Cross-family selection: o Dono que precisa do resultado de uma lane de pool pede à Raiz e espera, sem julgar no lugar dela.
- `skills/poteto-mode/references/native-lifecycle.md`: as recusas medidas da trava de worktree, o ajudante sem `isolation` dentro do worktree do Dono e a notificação sem worktree.
- `docs/reference.md`, "O que o Dono faz": o canal de avisos e a lane de pool, em português.

## Atenção

As três revisões vieram de `codex:gpt-6.1-sol@xhigh`, pelo runner, em modo leitura. Os recibos são `complete` com `pinned-argv`, então o modelo é o pedido e o provedor não o confirmou. Os textos completos estão em `03-trail-review/<trilha>/output.md`.

**Trilha do Dono do `clamp`** (sessão `01a11d48-a567-…`, quatro pontos).
- A auditoria final da trilha contra o transcript não tem prova, porque o Dono não leu o conteúdo do transcript.
- O Dono pulou o Arena dizendo que só havia uma forma válida. Essa forma vinha de uma restrição que ele mesmo pôs no brief do ajudante: TypeError antes de tudo. É exatamente a ordem que virou o F1.
- A linha que cita `proof/mutant-mathminmax` aponta para entradas, não para o resultado da execução.
- O teste com a string `"NaN"` ficou de fora com base num experimento do ajudante que não foi guardado.

**Trilha do Dono do `slugify`** (sessão `01a11d48-aec2-…`, cinco pontos).
- O Dono pulou o juiz do Arena e exagerou o consenso: os candidatos divergiam em `ı`, `ð` e `ŋ`.
- O censo das 190 letras não pegava separadores no meio da palavra.
- O `npm test` do head `ebae8c7` rodou depois do push.
- A auditoria da trilha contra o transcript não foi feita.
- Um horário inventado (`20:52:00Z`) foi corrigido no lugar, sem linha nova.

**Trilha da Raiz** (sessão `01a11d88-e134-…`, sete pontos). Seis foram aceitos e corrigidos acima:
- a conferência tardia dos recibos;
- o Tick 2 sem releitura do texto;
- a auditoria da trilha que não lia o transcript, mais a falta da linha do rebase;
- a retrospectiva com tempos e raciocínio errados;
- as afirmações do rascunho que vinham antes da evidência.

Um ponto foi mantido com explicação: o `clamp` não precisou de rebase de preparo, porque o head já estava sobre a ponta da trunk. O revisor também marca como interpretação da Raiz, e não do item, apagar todas as marcas combinantes. Essa é uma das duas regras padrão que o Victor pode trocar.

**Padrões que dependem do Victor.**
- `Straße` vira `stra-e`, e não `strasse`.
- Apagar todas as marcas combinantes (`\p{M}`), e não só as sem espaço.

Para mudar qualquer uma, basta dizer. Um item novo na fila do pstack-lab cobre a mudança.

## Verificação

- `npm test` completo no rascunho, antes do rebase sobre `03be9545`, com a correção de harness e este relatório na árvore: 1531 testes, 1531 passaram (`05-verify/npm-test-draft/`).
- As receitas da skill `verify-pstack-vic` no commit exato desta PR (`classify` e `run`) estão no corpo da PR, com o diretório de saída e o recibo de cada uma.
- O programa em si não passou por receita do verificador. As provas dele são as sessões reais acima:
  - os Vereditos publicados nos PRs 1 e 2 do pstack-lab;
  - o CI `test` verde nos dois merges (`694b5f8e` e `67fafb33`);
  - os recibos do runner;
  - as capturas privadas.

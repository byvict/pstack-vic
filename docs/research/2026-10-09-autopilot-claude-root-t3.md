# Autopilot-full com uma Raiz Claude no T3 Code

Execução de 2026-10-09 e 2026-10-10. O terceiro programa Autopilot-full com uma Raiz Claude rodou no repositório descartável [byvict/pstack-lab](https://github.com/byvict/pstack-lab). A Raiz foi uma sessão do Claude Code aberta pelo T3 Code. Os dois programas anteriores rodaram com a Raiz no app desktop do Claude: [D](2026-10-08-autopilot-claude-root.md) e [E](2026-10-09-autopilot-claude-root-auto.md).

Até aqui o pstack-vic só sabia armar o Tick do autopilot em dois hosts do Claude Code:
- `CLAUDE_CODE_ENTRYPOINT=claude-desktop`, o app, com um `Bash` em segundo plano que dorme uma hora ([ADR 0010](../adr/0010-tick-em-segundo-plano-na-raiz-do-app-desktop.md));
- `cli`, o terminal, com `/loop 1h`, como no upstream ([frente A](2026-10-08-raiz-clock-tick.md)).

O T3 Code só estava documentado como host da raiz Grok. Esta frente perguntou três coisas:
- em qual dos dois casos cai uma Raiz Claude no T3;
- qual o mínimo de harness para ela;
- se o host aguenta um programa completo.

As respostas:
- o host tem um terceiro valor de entrypoint, `sdk-ts`;
- o relógio dele se comporta como o do app;
- um programa de três itens rodou do "go" ao último merge, de 20:11 a 04:42 UTC, com o Tick do ADR 0010.

Nenhum modelo, esforço, fallback de swarm, política de Arena ou política de trilha mudou.

Evidência privada em `~/Dev/Skills/pstack-vic-runs/2026-10-09-autopilot-claude-root-t3/`:
- da Raiz: `identity.txt`, `01-host/`, `02-restart/`, `00-preflight/`, `protocol.md`, `tick-prompt.txt`, `todo.md`, `events.log`, `inventory.tsv` e `decisions.tsv`;
- `owners/<item>/`: brief, prompt, `decisions.tsv`, `children.tsv`, `reports.log`, provas, alavancas de mutantes e relatório final;
- `rounds/<item>-r<N>/`: o brief e o resultado de cada lane, a auditoria dos recibos e o Veredito;
- `items/<item>.known.txt`: a lista KNOWN de cada item, com os espaços declarados;
- `ticks/tick-<N>/`: a auditoria, o `ListAgents`, a cópia do plugin, as trilhas dos Donos e o censo do classificador;
- `03-trail-review/`, `04-root-audit/`, `pool/`, `classifier/`, `messages/` e `corrections/`;
- os scripts `mkround.mjs`, `lane-done.sh`, `add-lanes.sh`, `save-handback.mjs`, `classifier-decisions.mjs`, `cite-check.mjs` e `audit-trail.mjs`.

O transcript da Raiz é `~/.claude/projects/-Users-victorbaccega--t3-worktrees-pstack-lab-t3code-fad7d9a6/3c59fc9c-52de-4214-b1b3-7b6570c107c2.jsonl`. Os dos subagentes ficam em `…/3c59fc9c-52de-4214-b1b3-7b6570c107c2/subagents/agent-<id>.jsonl`.

## O host

| Item | Valor |
| --- | --- |
| Raiz | sessão `3c59fc9c-52de-4214-b1b3-7b6570c107c2`, thread do T3 `95921093-f69c-44f2-869b-78ae5397e763`, modelo `claude-opus-5-5`, esforço `xhigh` |
| Processo | `claude` 2.1.295, o mesmo binário do `PATH`, filho do servidor do T3 Code (Alpha) 0.0.45. Roda sem TTY, com `--input-format stream-json --output-format stream-json --permission-prompt-tool stdio` |
| Ambiente | `CLAUDE_CODE_ENTRYPOINT=sdk-ts`, `CLAUDE_AGENT_SDK_VERSION=0.3.276`, `CLAUDE_CODE_SESSION_ATTENDED=0`. Os tokens existem no ambiente e não foram gravados |
| Modo de permissão | `bypassPermissions` ("Full access" do T3) na abertura. `auto` a partir de 20:04:05 UTC, quando o Victor trocou a thread para "Auto" |
| Modos do T3 | Supervised (`default`), Auto-accept edits (`acceptEdits`), Auto (`auto`) e Full access (`bypassPermissions`) |
| Pasta | worktree do T3 em `~/.t3/worktrees/pstack-lab/t3code-fad7d9a6`, ligado a `~/Dev/pstack-lab`. A branch nasceu `t3code/fad7d9a6`, e o T3 a renomeou para `t3code/autopilot-claude-root-t3` |
| Plugin | `pstack@pstack-vic` 0.5.29, carregado do cache. O host criou um registro `local` para o worktree do T3 1 s depois do processo |
| Catálogo | `Agent` com `isolation` e `run_in_background`, `SendMessage`, `ListAgents`, `TaskStop`, `Monitor`, `CronCreate`, `CronList`, `CronDelete`, `ScheduleWakeup` e `Skill` estão presentes. `TodoWrite` e `TaskCreate` não estão. O `init` lista `pstack:poteto-mode` e 19 agentes `pstack:pstack-owner-*` |
| Autorização | `authorize.ts check --parent claude`: saída 0 |
| Laboratório | `byvict/pstack-lab`, `main` em `67512db3` no começo, ruleset `24744380` exigindo o check `test` |
| Forja | `gh` 2.102.0. O comando `origin` não existe, e o fallback foi registrado |

Trocar o modo da thread reinicia o processo. Às 20:04:05 o pid 57645 deu lugar ao pid 10260, com `--resume=3c59fc9c-…` e `--permission-mode auto`. A sessão é a mesma, o plugin é o mesmo, e o `installed_plugins.json` não mudou. O código do servidor do T3 (`ensureSessionForThread`) faz o mesmo quando muda a pasta, a instância do provedor ou o modelo da thread. A troca de modo aconteceu antes do "go", com nada em segundo plano. O que acontece com Donos e com o Tick numa troca no meio de um programa não foi medido.

## O relógio do T3 é o do app

A frente A mediu os dois hosts de 2026-10-08. Esta frente repetiu o exercício na Raiz do T3, com nonces próprios e encerrando o turno logo depois de armar.

| Caso | Armado (UTC) | Devido | Chegou | Em segundo plano no momento devido |
| --- | --- | --- | --- | --- |
| a | 19:12:03 | 19:14 | 19:22:13.936, 8 min depois | um `sleep 600`. O fim dele abriu um turno às 19:21:57, e o cron chegou logo depois desse turno terminar |
| b | 19:23:27 | 19:26 | 19:26:00.152 | nada |
| c | 19:26:58 | 19:30 | 19:33:48.555, 3 min 48 s depois | um subagente que o `ListAgents` já mostrava como concluído, com o `sleep 420` dele ainda vivo até 19:33:47 |

A primeira tentativa do caso c foi anulada. O 2.1.295 recusou o `sleep 420` em primeiro plano no subagente, que terminou sem dormir, e o cron dela foi apagado antes da hora.

Depois vieram dois ciclos curtos do Tick por `Bash` em segundo plano, o segundo re-armado a partir do primeiro:
- s1 saiu às 19:36:16, e a notificação entrou na fila às 19:36:16.039;
- s2 saiu às 19:38:18, e entrou na fila às 19:38:18.984.

Um subagente rodou `date` às 19:38:57 e mandou `SendMessage` para `main`. A mensagem entrou na fila da Raiz às 19:39:00.517 e abriu um turno. O `SendMessage` da Raiz de volta retomou o subagente, que viu a resposta às 19:39:07.

A regra observada é a mesma do app. Um cron só é entregue no primeiro fim de turno sem tarefa em segundo plano viva, contando o shell de um subagente já listado como concluído. O fim de um `Bash` em segundo plano e um `SendMessage` acordam a Raiz na hora. Um programa sempre tem Donos em segundo plano. Por isso o Tick desta Raiz foi o do ADR 0010, e não o `/loop 1h`.

| | T3 Code (esta frente) | App desktop (D, E e frente A) | Terminal (frente A) |
| --- | --- | --- | --- |
| `CLAUDE_CODE_ENTRYPOINT` | `sdk-ts` | `claude-desktop` | `cli` |
| Binário | 2.1.295 pelo Agent SDK 0.3.276, sem TTY | 2.1.293 dentro do app | 2.1.293, REPL com TTY |
| Cron com tarefa em segundo plano viva | retido até o fim de turno sem tarefa viva (casos a e c) | retido: um cron das 13:39 chegou às 13:46:36 | na hora: um cron das 13:39 chegou às 13:39:09 |
| Cron sem nada em segundo plano | na hora (caso b) | na hora | na hora |
| Fim de um `Bash` em segundo plano | acorda no mesmo segundo | acorda de 9 a 12 s depois | não foi o mecanismo medido |
| Tick | `Bash` em segundo plano, `sleep 3600`, re-armado a cada Tick | o mesmo (ADR 0010) | `/loop 1h` |
| `TodoWrite` e `TaskCreate` | ausentes | ausentes no 2.1.293 | não medido |
| Troca de modo | reinicia o processo com `--resume` | não se aplica | não se aplica |

## Fila e linha do tempo (UTC)

| Item | Pedido | Dono | PR | Rodadas | Merge |
| --- | --- | --- | --- | --- | --- |
| 1 `duration-bigint` | correção pelo playbook Bug fix da lacuna 5 de E: `parseDuration` perto do limite de `BigInt` | `a0274efa` | [#8](https://github.com/byvict/pstack-lab/pull/8) | 1 | `16b2c4e1` às 20:57:38 |
| 2 `semver-satisfies` | `satisfiesSemver(version, range)` em `src/semver.mjs` | `a0480874` | [#7](https://github.com/byvict/pstack-lab/pull/7) | 7 | `deb8aac5` às 00:03:04 |
| 3 `lab-satisfies` | o comando `lab semver satisfies <versão> <faixa>`, depois do merge do item 2 | `abb3d166` | [#9](https://github.com/byvict/pstack-lab/pull/9) | 6 | `37941d7b` às 04:42:34 |

O item 1 provou o defeito antes de corrigir. Em `67512db3`, um segmento de 318.767.105 dígitos ou mais fazia o `BigInt` lançar o `SyntaxError` do V8 ("Cannot convert … to a BigInt"). Uma entrada perto do tamanho máximo de string fazia escapar `RangeError: Invalid string length`. As duas mensagens saíam sem o prefixo `parseDuration: `, e era isso que E chamava de lacuna 5. O defeito era real e pior que a hipótese.

| Hora | Evento |
| --- | --- |
| 19:03 a 19:39 | fase 1: host, catálogo, relógio, dois ciclos do Tick, aviso de Dono |
| 20:04:05 | o Victor troca a thread para "Auto"; o processo reinicia com `--resume` |
| 20:11:16 | "go" do Victor, sem item reservado; Tick 1 armado às 20:11:27 |
| 20:12:39 | Donos dos itens 1 e 2 (`pstack:pstack-owner-opus-xhigh`, `isolation: "worktree"`, `run_in_background: true`) |
| 20:17:10 / 20:26:55 | PRs 7 e 8 abertos prontos |
| 20:44:24 | Rodada 1 do item 1; Veredito limpo às 20:55:00; merge pelo Dono às 20:57:38 |
| 21:11:21 | Tick 1 dispara; nenhum Dono rodando |
| 21:46 a 23:40 | Rodadas 1 a 6 do item 2, todas não limpas |
| 00:02:42 | Veredito limpo da Rodada 7 do item 2; merge às 00:03:04 |
| 00:04:32 | Dono do item 3, a partir de `deb8aac5`; PR 9 às 00:07:03 |
| 00:11:36 | Tick 4 dispara com o Dono do item 3 rodando |
| 01:40 a 04:05 | Rodadas 1 a 5 do item 3, todas não limpas, só por lacunas de teste |
| 04:41:54 | Veredito limpo da Rodada 6 do item 3 |
| 04:42:34 | merge do PR 9 pelo Dono |

## Ticks

O Tick foi um `Bash` em segundo plano com `sleep 3600 && cat tick-prompt.txt` e `timeout` de 3.900.000 ms. O primeiro passo de cada Tick re-armava o seguinte. Cada auditoria julgou os sete passos do playbook instalado, copiou o `installed_plugins.json`, salvou o `ListAgents` e as trilhas dos Donos, e contou as decisões do classificador. Tudo isso está em `ticks/tick-<N>/audit.md`. Os Ticks 1 a 4 releram o texto inteiro do playbook. Os Ticks 5 a 8 só compararam byte a byte uma cópia nova com a cópia lida antes, e o revisor apontou que as auditorias desses Ticks dizem mais do que isso. Nos Ticks 2 e 6, o re-arme não foi o primeiro passo. O Tick 2 montou mutantes antes, e o Tick 6 leu o prompt e o relógio antes.

| Tick | Notificação na fila | Quem estava vivo |
| --- | --- | --- |
| 1 | 21:11:21.406 | nenhum subagente; o Dono do item 2 esperava o juiz do Arena, lançado pela Raiz no runner |
| 2 | 22:11:25.683 | duas lanes da Rodada 2 do item 2 |
| 3 | 23:11:32.329 | uma lane da Rodada 5 do item 2 |
| 4 | 00:11:36.128 | o Dono do item 3 rodando, com um ajudante |
| 5 | 01:11:39.781 | o Dono do item 3 parado, esperando o revisor Grok do painel interrogate |
| 6 | 02:11:43.903 | o Dono do item 3 rodando o fix-forward da Rodada 2 |
| 7 | 03:11:51.794 | três lanes da Rodada 4 do item 3 |
| 8 | 04:11:55.347 | o Dono do item 3 parado, com trabalho próprio em segundo plano |

O intervalo entre dois disparos ficou entre 3.603,6 e 3.607,9 s, ou seja, a hora do `sleep` mais os segundos que o Tick levou até re-armar. Nenhum Tick foi perdido, e nenhum foi entregue atrasado por tarefa viva. O Tick 9 foi armado às 04:12:15 e parado com `TaskStop` às 04:53:23, quando o `ListAgents` já não mostrava nenhum subagente e as duas revisões de trilha tinham terminado.

## Metas de cobertura

### Meta 1: Tick com Dono vivo

Cumprida nos Ticks 4 e 6, com o Dono do item 3 `running` no `ListAgents`. No Tick 6 o Dono acabava de ser retomado pelo fix-forward da Rodada 2. O protocolo pedia isso já no Tick 1, uma hora depois do "go". No Tick 1 nenhum Dono rodava, e o do item 2 esperava o juiz do Arena. Os outros Ticks pegaram lanes vivas ou um Dono parado com trabalho próprio em segundo plano.

### Meta 2: cada Dono audita a própria trilha pelo transcript

| Dono | Linhas `audit` | Conferência da Raiz (`cite-check.mjs`) |
| --- | --- | --- |
| `duration-bigint` | 31 | linhas 564, 822, 1035 e 1372 existem e mostram o que a trilha diz |
| `semver-satisfies` | 68, com 135 citações distintas | linhas 75, 318, 679 e 1016 conferem |
| `lab-satisfies` | 45, com 55 citações distintas | linhas 296, 775, 761 e 1426 conferem |

As linhas citadas existem e mostram a chamada que a trilha nomeia. O revisor de outra família diz que as auditorias dos Donos dos itens 2 e 3 superestimam o que conferiram. Os scripts deles marcam uma linha como verificada quando a chamada de registro existe, e não pelo que o evento prova. Algumas linhas citam um trecho do transcript que fala de outro Dono (seção Atenção).

### Meta 3: escopo do plugin

O `installed_plugins.json` foi copiado no começo, em cada Tick e no fechamento. O registro desta sessão (`local`, 0.5.29, no worktree do T3) não mudou. Antes do Tick 1, outra sessão publicou a 0.5.30, e quatro registros de outros projetos passaram de 0.5.29 para 0.5.30 com o mesmo escopo. Isso foi relatado no Tick 1. Do Tick 1 ao fechamento, nenhum outro registro mudou (`06-close/plugin-diff-vs-start.txt`). Os Ticks 6 a 8 compararam com o Tick anterior, e não com a cópia do começo. O fechamento fez a comparação com o começo. Nenhum plugin foi instalado, removido ou atualizado por esta frente. A meta como E a definiu (zero mudanças) não foi cumprida: houve uma mudança de versão vinda de fora, e nenhuma de escopo.

### Meta 4: modo automático e o classificador

O modo `auto` valeu do "go" ao fim. O script `classifier-decisions.mjs` lê a decisão gravada em cada resultado de ferramenta, no transcript da Raiz e no de cada subagente. Contagem no fechamento, sobre 6.443 chamadas:

| Decisão | Chamadas |
| --- | --- |
| `accept`, classificador | 5.087 |
| `accept`, regra permanente do usuário | 879 |
| `accept`, modo | 415 |
| `accept`, sem tipo | 59 |
| sem decisão | 3 |

As três chamadas sem decisão são recusas do próprio host, dois `sleep` em primeiro plano bloqueados pela trava e um `Edit` sem mudança. Não houve nenhuma negação do classificador. As 112 chamadas que tocam um merge, um Veredito publicado, um spawn ou uma lane do runner foram todas `accept`. O merge do item 3, por exemplo, está em `agent-abb3d1665ff12b442.jsonl:2529` (`accept`, classificador).

As lanes encontraram várias vezes a trava de worktree, que recusa comandos compostos, `for`, `source`, pipes para `od` e `/usr/bin/time` com redirecionamento. Todas separaram o comando como a recusa pedia. Nenhuma recusa da trava virou negação.

## Comparação com D e E, meta por meta

| Meta | D (app, 2026-10-08) | E (app, 2026-10-09) | Este programa (T3) |
| --- | --- | --- | --- |
| Host do Tick | app, `claude-desktop` | app, `claude-desktop` | T3, `sdk-ts`, com o mesmo mecanismo |
| Modo automático | `bypassPermissions` | `auto` do começo ao fim, uma negação | `auto` desde 20:04, nenhuma negação |
| Tick com Dono vivo | nenhum | Ticks 1 e 3 | Ticks 4 e 6 |
| Auditoria do Dono pelo transcript | nenhuma | os quatro Donos | os três Donos; o revisor aponta auditorias rasas nos itens 2 e 3 |
| Escopo do plugin | outra sessão tirou o pstack do escopo | zero mudanças | uma mudança de versão vinda de outra sessão, nenhuma de escopo |
| Duração e dependências | 50 min, dois itens independentes | 4 h 3 min, item 4 depois dos itens 2 e 3 | 8 h 31 min do "go" ao último merge; item 3 depois do item 2 |
| Rodadas | 4 | 11 | 14 (1 + 7 + 6) |
| Lanes de Enxame | 20 | 55 | 70 |

## O que o programa fez contra o playbook

| Pedido do playbook | O que aconteceu | Leitura |
| --- | --- | --- |
| Passo 1, state-then-wait | protocolo e texto exato do comando entregues; parada até o "go" | cumprido |
| Passo 2, um Dono por PR, PR pronto cedo | três `Agent` com `pstack-owner-opus-xhigh`; PRs prontos de 2,5 a 14 min depois do spawn | cumprido |
| Passo 2, `children.tsv` e trilha | todos os filhos terminais no fim; trilhas de 43 a 126 linhas | cumprido |
| Passo 3, merge-then-branch | item 3 cortado de `deb8aac5`, o merge do item 2 | cumprido |
| Passo 4, Enxame a cada Rodada, lane ao vivo como piso | 14 Rodadas de 5 lanes `pstack-opus-xhigh`; a lane ao vivo carregou a skill `run` | cumprido |
| Passo 4, recibos antes do Veredito | abertos antes de 13 dos 14 Vereditos. A Rodada 1 do item 2 rodou no Code-ready, antes de existir um Merge-ready, e o Veredito dela saiu sem auditoria de recibos | desvio de uma Rodada, apontado pelo revisor |
| Passo 4, um fix-forward por Rodada, achado no `KNOWN` seguinte | um pedido por Rodada; cada achado entrou no `KNOWN` | cumprido |
| Passo 5, merge pelo Dono depois do Veredito limpo | três merges squash com `--match-head-commit`; a árvore de cada merge é a do head liberado | cumprido |
| Passo 6, Tick a cada hora | oito Ticks. Seis re-armaram como primeiro passo. Quatro releram o texto do playbook, e os outros quatro só o compararam byte a byte | cumprido, com os dois desvios apontados pelo revisor |
| show-me-your-work, revisão por outra família | uma lane `codex:gpt-6.1-sol@xhigh` por trilha de Dono e uma para a da Raiz | cumprido |

## O custo do critério de censo

E deixou como lacuna 7 o custo do critério que a Raiz usa para decidir o que é achado: todo mutante que viola o item, trata errado uma classe inteira de entrada e passa em todos os testes é achado. Este programa mediu esse custo em dois itens.

O item 2 levou sete Rodadas. Três achados da Rodada 1 eram defeitos de código de verdade:
- um regex que estoura a pilha a partir de 2,1 milhões de identificadores;
- um `split(" ")` que derruba o processo a partir de 2^27 partes;
- uma lista de comparadores que esgota o heap.

Os achados das Rodadas 2 a 6 foram lacunas de teste para esses mesmos limites, uma forma de cada vez. Na Rodada 2, a Raiz aplicou Attack the Premise e pediu um teste de heap limitado num processo filho, em vez de mais casos escolhidos à mão.

O item 3 mostrou o limite do critério. O `bin/lab.mjs` da Rodada 1 é o que foi mergeado, byte a byte. As seis Rodadas acharam só lacunas de teste, e cada correção estrutural fechou o espaço que nomeava. A Rodada seguinte achava uma classe logo fora dele:
- Rodada 1: `||` e faixa com hífen reescritos antes da biblioteca;
- Rodada 2: `\r`, aspas, `N.N.x` e `V` removidos;
- Rodada 3: zeros à esquerda, formas válidas de faixa reescritas, classes Unicode, escapes, corte em 128 KiB, pontuação depois da palavra do comando;
- Rodada 4: formas de ajuda, busca do comando e escape no lugar do caractere;
- Rodada 5: ajuda com leitor fechado.

A premissa falsa era da Raiz. Nenhum arquivo de teste finito prova que um operando passa intacto. Para qualquer conjunto finito de entradas existe uma transformação que é a identidade em todas elas. Na Rodada 3 a Raiz passou a declarar, antes de cada Rodada, o espaço que os testes precisam cobrir:
- (a) a (g) para os operandos;
- (h) a (j) para a busca do comando e a ajuda;
- (k) para os leitores fechados.

Um mutante disparado só fora do espaço declarado conta como amarrado a valor. Os achados já provados continuaram achados. Na Rodada 4 a Raiz também separou o que é do PR do que é da trunk. Os mutantes nos leitores próprios de `compare` e `parse` ficam como dívida de teste da trunk, porque o diff não toca neles. O arquivo de testes do CLI passou de 217 testes e 9 s para 2.116 testes e 51 s.

As duas decisões estão no `decisions.tsv` da Raiz e foram relatadas no chat ao Victor, com a alternativa de revertê-las. As duas entraram no meio do programa, que é o tipo de mudança que o revisor de E criticou. Os espaços de (a) a (k) foram declarados antes da Rodada que governaram. A leitura da posição dos escapes em (d) e a isenção de m21 a m23 vieram depois dos resultados da Rodada 4 (seção Atenção). Nenhuma decisão anulou um achado já provado.

## Fatos de host medidos

Claude Code 2.1.295 sob o Agent SDK 0.3.276, dentro do T3 Code 0.0.45, modo automático:

1. **Entrypoint.** `CLAUDE_CODE_ENTRYPOINT` vale `sdk-ts`. Qualquer host do Agent SDK em TypeScript tem esse valor. Só o T3 foi medido.
2. **Relógio.** Um cron fica retido enquanto há tarefa em segundo plano viva, como no app (tabela acima). O fim de um `Bash` em segundo plano acorda a Raiz no mesmo segundo. Um `SendMessage` de subagente a acorda em cerca de 3,5 s.
3. **Reinício.** Trocar o modo da thread reinicia o processo `claude` com `--resume` e o mesmo id.
4. **Ciclo de execução dos subagentes.** Os fatos 1 a 5 de E valeram no T3, sem diferença observada:
   - o hand-back é obrigatório;
   - uma execução entrega um relatório só;
   - o relatório de um ajudante vai para a Raiz depois que o pai entregou;
   - trabalho em segundo plano continua depois do hand-back;
   - um subagente não pode gravar um arquivo de relatório.

   A Raiz repassou um relatório de candidato do Arena que caiu nela depois do hand-back do Dono do item 2 (`messages/relay-a03d60593275772ff.md`).
5. **Trava de worktree no 2.1.295.** Ela recusa `sleep` longo em primeiro plano num subagente. Também recusa formas compostas de comando (`for`, `source`, pipes, `/usr/bin/time` com redirecionamento). As lanes separaram cada uma em comandos literais.
6. **Limite de argv no Linux.** O CI do pstack-lab roda em `ubuntu-latest`, onde uma string de argv tem no máximo 131.072 bytes (`MAX_ARG_STRLEN`). O Dono do item 3 trocou a linha de 900 mil caracteres pedida pela Raiz por um operando de 130.000 × U+0001, que o JSON transforma numa linha de 780.074 caracteres. A Raiz aceitou o desvio antes da Rodada que o verificou.

## Lacunas

1. **Troca de modo no meio de um programa.** O T3 reinicia o processo `claude` quando o modo, o modelo ou a pasta da thread mudam. A troca medida aconteceu sem nada em segundo plano. O destino dos Donos e do Tick numa troca com o programa rodando não foi medido. A regra desta PR manda re-armar o Tick depois de qualquer retomada, mas não diz o que fazer com Donos que morram junto.
2. **`sdk-ts` não identifica o T3.** A regra reconhece o valor medido do entrypoint, que qualquer host do Agent SDK em TypeScript tem. Um host desses que entregasse o cron na hora ainda teria o Tick em segundo plano, que funciona nos dois hosts medidos.
3. **Custo do critério de censo.** O item 3 levou seis Rodadas com o código certo desde a primeira. O espaço declarado fecha o ciclo, mas é uma decisão da Raiz tomada no meio do programa. O playbook não diz como limitar um censo sobre um domínio sem fim.
4. **Dívida de teste da trunk do pstack-lab.** Nenhum teste fixa os leitores próprios de `compare` e `parse` (m21 a m23 da Rodada 4). Nenhum teste cobre a ajuda com espaços em volta (m40 da Rodada 6) ou a troca da palavra de grupo (`semver parse`, m39). Um item novo na fila do pstack-lab cobriria isso.
5. **Horários digitados à mão.** O revisor encontrou horários digitados à mão nas trilhas dos três Donos e na da Raiz, apesar do script `owners/report-line.sh` que grava a hora real. A Raiz corrigiu os seus pela trilha com relógio (`corrections/root-times.md`).

## Correção de harness desta PR

Só adaptação de harness, sem fluxo paralelo:

- `skills/poteto-mode/SKILL.md`, *Platform Adaptation*: uma Raiz Claude dentro do T3 Code (`sdk-ts`) cai no mesmo caso do app e arma o Tick como um `Bash` em segundo plano. A Raiz retomada re-arma o Tick, e o T3 retoma a sessão num processo novo quando o modo, o modelo ou a pasta da thread mudam.
- `skills/poteto-mode/references/upstream-substitutions.json`, linha T13: os dois playbooks gerados passam a mandar uma Raiz Claude "inside the desktop app or T3 Code" para a *Platform Adaptation*. A tabela muda e os dois arquivos gerados mudam por `node scripts/upstream-parity.ts --write`.
- `docs/reference.md`, "O que a Raiz faz a cada hora": um parágrafo com as medições do T3 e a regra.
- [ADR 0010](../adr/0010-tick-em-segundo-plano-na-raiz-do-app-desktop.md): um parágrafo de 2026-10-09 estende a mesma decisão ao `sdk-ts`. O mecanismo não muda, só cresce a lista de hosts.
- `CONTEXT.md` e `docs/guide/07-overnight.md`: o Tick em segundo plano vale para a Raiz do app desktop ou do T3 Code.
- `skills/update-clis/references/cli-touchpoints.json`: os contratos de `claude.desktop-scheduler` e `claude.desktop-tick` citam a medição do T3, e a âncora do segundo segue a frase reescrita do `SKILL.md`.
- `CHANGES.md`: uma entrada de 2026-10-09, no padrão da entrada do Tick do app.

## Atenção

As quatro revisões vieram de `codex:gpt-6.1-sol@xhigh`, escolhido pelo `setup-pstack.ts pick --parent claude --role "trail reviewer pool"`, pelo runner e em modo leitura. Os recibos são `complete` com `pinned-argv`. Os textos completos estão em `03-trail-review/<trilha>/output.md`.

**Trilha do Dono do `duration-bigint`** (seis pontos).
- A implementação foi direta, sem o delegado isolado que o passo 3 do Bug fix pede, e o `architect` foi pulado para a nova função `quote()`. Os dois desvios aparecem só no transcript, sem linha na trilha.
- Duas horas de relatório foram digitadas à mão e sobreviveram à auditoria (CODE-READY e MERGE-READY).
- O limite de 1.000.000 caracteres do texto citado se apoia num raciocínio sobre argv que nenhuma medição de CLI sustenta.
- O verificador de prova pode dar sucesso para a falha de pilha conhecida.
- O teste de 318.767.105 caracteres tem risco de portabilidade e memória, dispensado como detalhe.
- A frase de alcance publicada no PR contradizia a prova. A Raiz pediu a correção, e o Dono reescreveu o corpo do PR depois do merge.

**Trilha do Dono do `semver-satisfies`** (sete pontos).
- A auditoria pelo transcript superestima o que conferiu e cita linhas de outro programa.
- O `npm test` do pré-push rodou antes do commit, e o MERGE-READY diz "committed head".
- Arena e interrogate só rodaram depois de correções de rumo da Raiz; `how` e `architect` foram pulados.
- O Dono escreveu a implementação final ele mesmo, contra o "Delegate implementation" do Feature.
- O painel interrogate não revisou um artefato estável.
- Há horários inventados e correções incompletas na trilha.
- Os testes finais custam cerca de 18 s e 3,4 GB de RSS no pico.

**Trilha do Dono do `lab-satisfies`** (seis pontos).
- A autoauditoria marca "verified" quando a chamada de registro existe, sem conferir a prova. Quatro linhas citam a linha 243, que lista artefatos e filhos do Dono anterior.
- O Dono montou, enxertou e empurrou a base opus antes da resposta do juiz do Arena. O desvio está registrado, mas a comparação avaliou uma escolha já construída.
- `arena/synthesis.md` ainda apresenta a premissa falsa sobre mutantes que só falham com `satisfies` no argv, sem aviso de que a linha 31 da trilha a corrigiu.
- O Dono escreveu ele mesmo os geradores e o oráculo dos fix-forwards, contra o "Delegate implementation" do Feature. Isso não está na lista de desvios do relatório final.
- O Veredito limpo vale dentro dos espaços declarados. Os sobreviventes da Rodada 6 (troca da palavra de grupo, espaços em volta da palavra de ajuda) ficaram fora, e o arquivo de testes passou de 217 testes e 9 s para 2.116 testes e 51 s com o código igual desde a Rodada 1.
- A auditoria de recibos da Rodada 6 dava horas digitadas à mão (cerca de 04:13 e 04:15). As horas certas são 04:26:18 e 04:27:05. A Raiz corrigiu essa e as das Rodadas 2 a 5 (`corrections/root-times.md`).

**Trilha da Raiz** (oito pontos), todos aceitos. As respostas estão em `corrections/root-review-flags.md`.
- Tratar tudo o que fica fora do espaço declarado como amarrado a valor estreita o que o Veredito limpo do item 3 prova.
- A leitura da posição dos escapes em (d) e a isenção de m21 a m23 como dívida da trunk vieram depois dos resultados da Rodada 4, e não antes. Só os espaços de (a) a (k) foram declarados antes da Rodada que governaram.
- As auditorias dos Ticks 5 a 8 dizem que releram o playbook, mas só o compararam byte a byte.
- O re-arme não foi o primeiro passo nos Ticks 2 e 6. O Tick 2 não tinha linha no `decisions.tsv`, e a linha foi acrescentada no fechamento.
- As auditorias de recibos do item 3 tinham horas digitadas à mão. Foram corrigidas pela trilha com relógio.
- A Rodada 1 do item 2 saiu sem Merge-ready e sem auditoria de recibos, e a auditoria do Tick 4 dizia o contrário.
- O alvo do protocolo de Tick com Dono vivo uma hora depois do "go" não foi cumprido no Tick 1, só nos Ticks 4 e 6.
- Os dois desvios anteriores ao "go" (`cd /tmp && true` num comando composto e `git fetch --prune`) já estavam registrados. O `--prune` não removeu nada.

Depois da revisão, a Raiz cometeu mais um desvio da mesma regra. Ela lançou a primeira verificação desta PR com `cd /tmp/pstack-vic-t3-preview && npm run verify …`, um `cd` num comando composto. O desvio está registrado no `events.log` e no `decisions.tsv`.

## Verificação

A `verify-pstack-vic` rodou `classify` e `run` numa cópia descartável deste branch com `node scripts/upstream-parity.ts --write` aplicado (`/tmp/pstack-vic-t3-preview`, recibos em `05-verify/` da evidência):
- `classify` contra `origin/main` (`728d1a5a`): área `agent-instructions`, receita `repository-contracts`.
- `run --feature repository-contracts`, primeira tentativa: 272 de 273. O ponto de contato `claude.desktop-tick` apontava para a frase "A resumed desktop root re-arms it.", que esta PR reescreve. A âncora e o contrato do ponto de contato foram corrigidos nesta PR.
- Segunda tentativa, em diretório novo: 273 de 273, `complete`.

As receitas no commit exato desta PR, depois do `--write`, ficam no corpo da PR, com o diretório de saída e o recibo de cada uma.

O programa em si não passou por receita do verificador. As provas dele são as sessões reais:
- os Vereditos publicados nos PRs 7, 8 e 9 do pstack-lab;
- o CI `test` verde nos três merges (`16b2c4e1`, `deb8aac5` e `37941d7b`);
- os recibos do runner;
- o censo do classificador e as capturas privadas.

## O que sobrou

Sem faxina, como pedido. A linha de base de antes da frente está em `00-preflight/` da evidência. Nada dela foi removido.

Criado por esta frente e deixado:
- no `pstack-lab`, 76 worktrees `agent-*` em `.claude/worktrees/`, dos Donos, dos ajudantes e das 70 lanes (`06-close/created-worktrees.txt`);
- no `pstack-lab`, 80 branches locais: as 76 `worktree-agent-*` desses worktrees, `impl/semver-satisfies` e as três `autopilot/*` dos itens (`06-close/created-local-branches.txt`);
- as branches remotas `autopilot/duration-bigint-limit`, `autopilot/semver-satisfies` e `autopilot/lab-semver-satisfies`;
- no `pstack-vic`, o worktree `.claude/worktrees/autopilot-claude-root-t3-report` e a branch `claude/autopilot-claude-root-t3-report`;
- a cópia descartável `/tmp/pstack-vic-t3-preview`, usada na verificação;
- a pasta de evidência `~/Dev/Skills/pstack-vic-runs/2026-10-09-autopilot-claude-root-t3/`.

Criados pelo host, não pela Raiz: o worktree do T3 `~/.t3/worktrees/pstack-lab/t3code-fad7d9a6` (branch `t3code/autopilot-claude-root-t3`) e o registro `local` do plugin para ele.

Sobras anteriores, intactas: os 71 worktrees, as 79 branches locais e as 5 branches remotas da linha de base do `pstack-lab`.

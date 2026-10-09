# Autopilot-full com Claude na Raiz, em modo automático

Execução de 2026-10-09, segundo programa Autopilot-full com uma sessão do Claude Code no app desktop como Raiz, no repositório descartável [byvict/pstack-lab](https://github.com/byvict/pstack-lab). O [primeiro programa](2026-10-08-autopilot-claude-root.md), chamado aqui de D, deixou quatro lacunas que só um programa novo podia fechar:
- o modo automático, porque D rodou em `bypassPermissions`;
- um Tick com Dono vivo, porque os merges de D saíram antes do primeiro Tick;
- a auditoria que cada Dono faz da própria trilha lendo o próprio transcript;
- o escopo do plugin durante o programa.

Este programa tinha uma meta para cada uma. A fila tinha quatro itens do tamanho de um Feature, um deles dependente de outros dois merges, e o programa durou 4 h 3 min entre o "go" e o último merge. Nenhum modelo, esforço, fallback de swarm, política de Arena ou de trilha mudou.

Evidência privada em `~/Dev/Skills/pstack-vic-runs/2026-10-09-autopilot-claude-root-auto/`:
- `identity.txt`, `00-preflight/`, `protocol.md`, `tick-prompt.txt`, `todo.md`, `events.log`, `inventory.tsv` e `decisions.tsv`, todos da Raiz;
- `owners/<item>/`, com brief, prompt, `decisions.tsv`, `children.tsv`, `reports.log`, provas e o relatório final;
- `rounds/<item>-r<N>/`, com o brief e o resultado de cada lane, a auditoria dos recibos e o Veredito;
- `ticks/tick-<N>/`, com a auditoria, o `ListAgents`, o diff do plugin, o forge e o censo do classificador;
- `03-trail-review/`, `04-root-audit/`, `denials/`, `corrections/` e `messages/`;
- os scripts `classifier-decisions.mjs`, `save-handback.mjs`, `lane-done.sh`, `cite-check.mjs` e `audit-trail.mjs`.

O transcript da Raiz é `~/.claude/projects/-Users-victorbaccega-Dev-pstack-lab--claude-worktrees-autopilot-full-coverage-second-3b9ba3/6b1a3428-ee2c-4fc0-9e50-0d4931e9a16c.jsonl`. Os dos subagentes ficam em `…/6b1a3428-ee2c-4fc0-9e50-0d4931e9a16c/subagents/agent-<id>.jsonl`.

## Identidade e base

| Item | Valor |
| --- | --- |
| Raiz | sessão `6b1a3428-ee2c-4fc0-9e50-0d4931e9a16c`, Claude Code 2.1.293 dentro do app 2.31226.0, `CLAUDE_CODE_ENTRYPOINT=claude-desktop`, modelo `claude-opus-5-5`, esforço `xhigh`; o `claude` no PATH é 2.1.295 |
| Modo de permissão | `auto` desde a criação da sessão (transcript, linha 4) e em `get_session`; nenhum registro de saída do modo automático |
| Plugin | `pstack@pstack-vic` 0.5.28 (`4ccd627a`); as skills e os agentes instalados batem com a `origin/main` |
| Autorização | `authorize.ts check --parent claude`: saída 0, `authorized: true`, entrada v3 |
| Laboratório | `byvict/pstack-lab` público, Node 24, `npm test` = `node --test`, ruleset `24744380` exigindo o check `test` na `main`, `main` em `67fafb33` |
| Forja | `gh` 2.102.0 (o comando `origin` não existe nesta máquina) |
| Planilha | Donos `claude:claude-opus-5-5@xhigh`, lanes de Enxame iguais, `trail reviewer pool` e `arena cross-judge pool` com Codex e Grok elegíveis |

## Fila e linha do tempo (UTC)

| Item | Pedido | Dono | PR | Rodadas | Merge |
| --- | --- | --- | --- | --- | --- |
| 1 `duration-parse` | `parseDuration` em `src/duration.mjs` | `af4acf72` | [#3](https://github.com/byvict/pstack-lab/pull/3) | 1 | `0ab81b5c` às 14:08:43 |
| 2 `semver-compare` | `compareSemver` em `src/semver.mjs` | `abb58234` | [#4](https://github.com/byvict/pstack-lab/pull/4) | 3 | `8235d967` às 15:10:14, depois de um rebase de preparo publicado com lease |
| 3 `duration-format` | `formatDuration`, depois do item 1 | `a217fdfe` | [#5](https://github.com/byvict/pstack-lab/pull/5) | 3 | `04244469` às 15:04:07 |
| 4 `lab-cli` | o CLI `lab` com os três comandos, depois dos itens 2 e 3 | `ae7113b7` | [#6](https://github.com/byvict/pstack-lab/pull/6) | 4 | `67512db3` às 17:40:39 |

| Hora | Evento |
| --- | --- |
| 13:37:48 | "go" do Victor, sem item reservado |
| 13:38:07 | Tick 1 armado (`Bash` em segundo plano, `sleep 3600`, `timeout` 3 900 000 ms) |
| 13:38:55 / 13:39:40 | Donos dos itens 1 e 2 (`pstack:pstack-owner-opus-xhigh`, `isolation: "worktree"`, `run_in_background: true`) |
| 13:42:25 / 13:42:42 | PRs 3 e 4 abertos prontos |
| 14:00:07 | Rodada 1 do item 1; Veredito limpo às 14:07:37; merge pelo Dono às 14:08:43 |
| 14:10:24 | Dono do item 3, a partir de `0ab81b5c`; PR 5 às 14:13:32 |
| 14:37:56 | Tick 1 dispara com os Donos dos itens 2 e 3 rodando |
| 14:54:49 | censo de mutantes do item 2 (Attack the Premise) e Rodada 3 |
| 15:03:42 / 15:04:07 | Veredito limpo e merge do item 3 |
| 15:09:05 a 15:10:14 | Veredito limpo do item 2, rebase de preparo sobre `04244469` com o mesmo patch-id, nova liberação no head exato e merge |
| 15:11:26 | Dono do item 4, a partir de `8235d967`; PR 6 às 15:14:20 |
| 15:33 a 16:23 | Arena de arquitetura do item 4: três candidatos, juiz Codex lançado pela Raiz |
| 15:38:05 | Tick 2 dispara com o Dono do item 4 "completed" e um ajudante dele rodando |
| 16:38:10 | Tick 3 dispara com o Dono do item 4 rodando; o Code-ready chega durante o Tick |
| 16:46 / 17:01 / 17:20 | Vereditos não limpos das Rodadas 1, 2 e 3 do item 4, só por lacunas de teste |
| 17:38:15 | Tick 4 dispara com uma lane da Rodada 4 rodando |
| 17:39:59 | Veredito limpo da Rodada 4 do item 4 |
| 17:40:39 | merge do PR 6 pelo Dono |

## Metas de cobertura

### Meta 1: modo automático do começo ao fim

O modo automático grava a decisão do classificador em cada resultado de ferramenta do transcript (`permissionDecision`, com `decision`, `source` e `reasonType`). O script `classifier-decisions.mjs` lê esse campo em todos os transcripts. O censo de fechamento (`05-close/classifier-rows.tsv`) achou 153 chamadas que tocam um merge, um push com lease, um Veredito publicado, um spawn ou uma lane do runner, em todos os transcripts. Todas foram `accept`: 139 pelo classificador e 14 por regra. Nas cerca de 4 100 chamadas de ferramenta do programa inteiro, 3 282 foram aceitas pelo classificador, 610 por regra permanente do usuário e 183 pelo modo.

| Ação | Onde | Decisão |
| --- | --- | --- |
| Merge do Dono, item 1 | `agent-af4acf72fa052bc87.jsonl:795` | `accept`, classifier |
| Merge do Dono, item 3 | `agent-a217fdfe5729f3db0.jsonl:1488` | `accept`, classifier |
| `git push --force-with-lease=refs/heads/autopilot/semver-compare:<sha>` | `agent-abb5823407dc9c1b8.jsonl:1408` | `accept`, classifier |
| Merge do Dono, item 2 | `agent-abb5823407dc9c1b8.jsonl:1496` | `accept`, classifier |
| Merge do Dono, item 4 | `agent-ae7113b7a510dbc21.jsonl:2243` | `accept`, classifier |
| Vereditos publicados pela Raiz (`gh pr comment`) | transcript da Raiz, de 1509 a 5491 | todos `accept`, classifier |
| Juiz do Arena pelo runner (`codex:gpt-6.1-sol@max`) | transcript da Raiz, 4048 | `accept`, classifier |
| Revisores de trilha pelo runner | transcript da Raiz, 1741, 3198, 3420, 5601 e 5715 | `accept`, classifier |
| Lanes do runner lançadas por um Dono (arquitetura e interrogate) | `agent-ae7113b7a510dbc21.jsonl:434, 437, 930, 933` | `accept`, classifier |
| 4 Donos e 55 lanes de Enxame (`Agent`) | transcript da Raiz | `accept`, classifier |

Houve uma negação, já relatada no chat. O Dono do item 2 tentou gravar na trilha uma linha que citava o próprio texto da recusa de hand-back, e o classificador respondeu "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Auto-Mode Bypass]." (`agent-abb5823407dc9c1b8.jsonl:325` e `327`, `denials/01-semver-owner-log-row.txt`). O Dono não repetiu a chamada. As outras três chamadas fora de `accept` não têm decisão do classificador: são recusas do próprio host (dois `Write` de `report.md` e um `Edit` sem mudança).

### Meta 2: Tick com Dono vivo

Os quatro Ticks dispararam uma hora depois de cada re-arme, e cada um re-armou o seguinte como primeiro passo.

| Tick | Disparo | `ListAgents` | Leitura |
| --- | --- | --- | --- |
| 1 | 14:37:56 | Donos dos itens 2 e 3 `running` | meta cumprida: auditoria com dois Donos vivos, um deles empurrando `d21b4b4b` durante o Tick |
| 2 | 15:38:05 | Dono do item 4 `completed`, ajudante opus `running` | o Dono tinha entregue o hand-back com trabalho próprio vivo |
| 3 | 16:38:10 | Dono do item 4 `running` | o Code-ready chegou durante o Tick, e a Rodada 1 saiu dele |
| 4 | 17:38:15 | uma lane da Rodada 4 `running` | o Dono esperava o Veredito |

Cada auditoria (`ticks/tick-<N>/audit.md`) releu o texto inteiro do playbook instalado, e não o hash. Ela também julgou os sete passos e fez o teste de travamento sobre o `ListAgents` e os `children.tsv`. As cópias de `children.tsv`, `decisions.tsv` e `reports.log` de cada Dono ficaram no Tick, junto com o forge, o diff do plugin e o censo do classificador. O Tick 5 foi armado às 17:38:20 e parado com `TaskStop` depois da última lane delegada.

### Meta 3: cada Dono audita a própria trilha pelo transcript

O brief de cada Dono nomeou a pasta `subagents/` da Raiz e pôs a auditoria pelo transcript como passo 12 do ciclo. Os quatro Donos acrescentaram linhas `audit` que citam linhas do próprio transcript. A Raiz conferiu uma amostra com `cite-check.mjs`, e todas as linhas citadas existem e mostram o que a trilha diz.

| Dono | Linhas `audit` | Linhas do transcript conferidas pela Raiz |
| --- | --- | --- |
| `duration-parse` | 30 | amostra no relatório final (events.log, 14:13:18) |
| `semver-compare` | 28 | 327, 421, 1408, 1455 |
| `duration-format` | 37 | 150, 167, 205 e outras (events.log, 15:09:05) |
| `lab-cli` | 41 | 211, 522, 1060, 1110, 1547, 1650 |

Os revisores de outra família confirmam que os Donos leram o conteúdo, e não só listaram ponteiros. Eles apontam auditorias rasas ou com ponteiros errados em alguns pontos (seção Atenção).

### Meta 4: escopo do plugin

O `~/.claude/plugins/installed_plugins.json` foi copiado no começo e em cada Tick, e o script comparou os registros com a cópia inicial: zero mudanças no começo, no Tick 1, no Tick 2, no Tick 3, no Tick 4 e no fechamento (`05-close/plugin-diff.txt`). O único registro novo do programa é o da própria sessão, criado pelo host 0,94 s depois da sessão nascer, como era esperado. Nenhum plugin foi instalado, removido ou atualizado.

## Comparação com D, meta por meta

| Meta | D (2026-10-08) | Este programa |
| --- | --- | --- |
| Modo automático | `bypassPermissions`; o classificador não rodou e a autorização v3 não foi exercida (lacuna 8 de D) | `auto` do começo ao fim; merges, push com lease, Vereditos, juiz do Arena e revisores pelo runner decididos pelo classificador, todos `accept`; uma negação real, registrada |
| Tick com Dono vivo | nenhum Tick disparou com Dono vivo (lacuna 6 de D) | o Tick 1 auditou dois Donos vivos; o Tick 3 auditou o Dono do item 4 rodando |
| Auditoria do Dono pelo transcript | os revisores disseram que nenhum Dono leu o próprio transcript (lacuna 9 de D) | o brief nomeou a pasta `subagents/`; os quatro Donos citaram linhas que existem e mostram o que dizem |
| Escopo do plugin | outra sessão tirou o pstack do escopo no meio do programa (lacuna 7 de D) | zero mudanças em todos os snapshots |
| Recibos antes do Veredito | aberto só no Tick 1, depois dos merges (desvio de D) | aberto antes de cada Veredito (`rounds/*/receipts-audit/audit.md`) |
| Releitura do playbook no Tick | o Tick 2 comparou o hash (desvio de D) | texto inteiro relido em todos os Ticks |
| Programa acima de 1 hora, item dependente | 50 min, dois itens independentes | 4 h 3 min, item 3 depois do item 1 e item 4 depois dos itens 2 e 3 |
| Juiz do Arena | o Dono julgou sozinho; a Raiz lançou o juiz depois | o Dono pediu o juiz à Raiz por `SendMessage`; a Raiz esperou os três candidatos, como manda a fase C, e lançou o juiz |

## O que o programa fez contra o playbook

| Pedido do playbook | O que aconteceu | Leitura |
| --- | --- | --- |
| Passo 1, state-then-wait | protocolo entregue às 13:34 e parada até o "go" | cumprido |
| Passo 2, um Dono por PR, worktree próprio, PR pronto cedo | quatro `Agent` com `pstack-owner-opus-xhigh`; PRs prontos de 2,2 a 3,5 min depois do spawn | cumprido |
| Passo 2, `children.tsv` e trilha | todos os filhos terminais no fim; trilhas de 65 a 80 linhas | cumprido |
| Passo 2, rebase antes do Code-ready, lease no preparo | rebases nulos antes do Code-ready; o item 2 publicou o rebase de preparo com `--force-with-lease` | cumprido |
| Passo 3, merge-then-branch | item 3 a partir de `0ab81b5c`, item 4 a partir de `8235d967` | cumprido |
| Passo 4, Enxame a cada Rodada, lane ao vivo como piso | 11 Rodadas, 55 lanes `pstack-opus-xhigh`; a lane ao vivo do item 4 carregou a skill `run`, que estava na lista dela | cumprido |
| Passo 4, recibos do Merge-ready antes do Veredito | abertos antes de cada Veredito | cumprido |
| Passo 4, um fix-forward com teste vermelho por achado | um pedido por Rodada; cada achado entrou no `KNOWN` da Rodada seguinte; censos de mutantes substituíram listas feitas à mão nos itens 2 e 4 | cumprido |
| Passo 5, merge pelo Dono depois do Veredito limpo | quatro merges com `--match-head-commit`; o item 2 rebaseou e a Raiz liberou de novo o head exato pelo patch-id | cumprido |
| Passo 6, Tick a cada hora | quatro Ticks, re-arme como primeiro passo, playbook relido em texto | cumprido |
| Passo 6, retro e varredura de comentários de robôs | feitas no Tick 2, depois dos merges agrupados dos itens 3 e 2; nenhum robô comentou | cumprido |
| show-me-your-work, revisão por outra família | uma lane `codex:gpt-6.1-sol@xhigh` por trilha de Dono e uma para a da Raiz | cumprido |

## Rodadas e Vereditos

| Item | Rodada | Head | Patch-id | Veredito |
| --- | --- | --- | --- | --- |
| duration-parse | 1 | `d7c75621` | `200315b8` | [limpo](https://github.com/byvict/pstack-lab/pull/3#issuecomment-6082563658) |
| semver-compare | 1 | `6f4657f9` | `31c6b9dc` | [não limpo](https://github.com/byvict/pstack-lab/pull/4#issuecomment-6082637072): F1 a F3 |
| semver-compare | 2 | `d7a1527a` | `b28ee02b` | [não limpo](https://github.com/byvict/pstack-lab/pull/4#issuecomment-6083054555): F3b a F6 |
| semver-compare | 3 | `15f1e8d5` | `f318a4f9` | [limpo](https://github.com/byvict/pstack-lab/pull/4#issuecomment-6083625335); vale para `bd1b0d3c` pelo patch-id |
| duration-format | 1 | `5005ff03` | `277c583e` | [não limpo](https://github.com/byvict/pstack-lab/pull/5#issuecomment-6083061095): G1 |
| duration-format | 2 | `d21b4b4b` | `9c4d8dc3` | [não limpo](https://github.com/byvict/pstack-lab/pull/5#issuecomment-6083330369): G2 |
| duration-format | 3 | `e2f851a2` | `aa16677e` | [limpo](https://github.com/byvict/pstack-lab/pull/5#issuecomment-6083543437) |
| lab-cli | 1 | `9d5e1a1a` | `938b601d` | [não limpo](https://github.com/byvict/pstack-lab/pull/6#issuecomment-6085252479): H1, T1 a T3 |
| lab-cli | 2 | `4ff8a008` | `416f49dd` | [não limpo](https://github.com/byvict/pstack-lab/pull/6#issuecomment-6085487149): V1 a V5 |
| lab-cli | 3 | `c7674bbd` | `35bd51e7` | [não limpo](https://github.com/byvict/pstack-lab/pull/6#issuecomment-6085778747): W1 a W3 |
| lab-cli | 4 | `db948083` | `1b0b7cbc` | [limpo](https://github.com/byvict/pstack-lab/pull/6#issuecomment-6086083839) |

Só um achado de Rodada foi defeito de código: o F6 do item 2. O `compareSemver` usava `BigInt` nos números da versão, e um número com mais de cerca de 323 milhões de dígitos lançava o erro do motor em vez do `SyntaxError` do item. O Dono trocou por comparação de strings de dígitos. Todos os outros achados foram lacunas de teste, provadas por mutantes que violavam o item e passavam em todos os testes.

No item 4, interrogate e Enxame acharam coisas diferentes:
- o painel interrogate do Dono achou dois defeitos reais de EPIPE antes do Code-ready: um leitor fechado mudava o código de saída de 2 para 1;
- as Rodadas 1 a 3 acharam só lacunas de teste, cada vez em outro comando ou em outra posição de argumento.

Na Rodada 2, a Raiz aplicou Attack the Premise. Duas correções seguidas com casos escolhidos à mão, comando por comando, tinham falhado no mesmo ponto. Por isso o fix-forward pediu uma tabela gerada de comando × posição × token, e o foco das auditorias passou de amostra a censo.

Na Rodada 4, o censo matou 121 de 128 mutantes. Os sete sobreviventes eram equivalentes ou ficavam fora do que o item define. A Raiz registrou como nota, não como achado, um mutante que reescreve três caracteres de quebra de linha Unicode nas mensagens, por dois motivos:
- o mutante depende de valores específicos;
- o item não decide entre "uma linha" e "<mensagem>" para esses caracteres.

As regras da Raiz para o que conta como achado ficaram escritas nos `KNOWN` de cada item e no `decisions.tsv`:
- mutante que trata errado um tipo ou uma classe inteira de entrada, ou um comando inteiro, é achado;
- mutante amarrado a valores específicos não é achado;
- mutante equivalente não é achado;
- recusa da trava de worktree pela forma do comando não é negação.

## Fatos de host medidos

Claude Code 2.1.293 no app desktop, modo automático:

1. **Hand-back obrigatório.** Um subagente que termina o turno sem `SubagentHandback` recebe "[handback-send-enforce] Your report has not been delivered. Call SubagentHandback({message: <your full report>}) now; the call ends your run." Isso vale mesmo com um ajudante nativo dele rodando. Com um comando de shell próprio rodando em segundo plano, o Dono parou sem relatório, e a notificação disse que ele esperava o próprio trabalho.
2. **Um relatório por execução.** Uma segunda chamada na mesma execução é recusada com "Nothing was sent: your report was already delivered (SubagentHandback delivers one report). Use SendMessage for anything further, then stop." (`agent-ae7113b7a510dbc21.jsonl:697`). Um `SendMessage` abre execução nova, e os Donos retomados assim entregaram de novo em todas elas (6 de 6 e 5 de 5). Um Dono retomado pelo fim de um comando próprio continua na mesma execução.
3. **Para onde vai o relatório de um ajudante.** Ele vai para o pai enquanto a execução do pai está aberta, e isso retoma um pai parado sem relatório (`agent-ae7113b7a510dbc21.jsonl:1035`). Depois que o pai entregou, o relatório vai para a Raiz e não retoma o pai. A Raiz repassou cada um por `SendMessage`. A notificação da Raiz sobre um ajudante do Dono diz "delivered to you" mesmo quando o Dono recebeu.
4. **Trabalho em segundo plano depois do hand-back.** Comandos em segundo plano de um Dono que entregou continuam rodando, e o fim deles retoma o Dono (`agent-ae7113b7a510dbc21.jsonl:475`). O `ListAgents` mostra esse Dono como `completed` enquanto os filhos dele rodam.
5. **Arquivos de relatório.** Dois `Write` de `report.md` por subagentes foram recusados com "Subagents should return findings as text, not write report files. Include this content in your final response instead." Um `Write` de `result.md` foi aceito. As lanes passaram a devolver o resultado como texto final, e a Raiz o grava.
6. **Mensagem na fila de um Dono que entrega em seguida.** Ela é entregue e retoma esse Dono (`agent-abb5823407dc9c1b8.jsonl:1460`).
7. **A skill `run` numa lane nativa.** Ela estava na lista de skills das lanes `pstack-opus-xhigh` e foi carregada nas quatro Rodadas do item 4.

## Lacunas

1. **Ciclo de hand-back sem documentação.** Os fatos 1 a 4 não estavam escritos. A Raiz descobriu o enforcement no primeiro Dono que esperou um ajudante e passou a repassar os relatórios que caíam nela. Corrigido nesta PR.
2. **Recusa da trava contra negação.** O ciclo dos Donos dizia para parar em BLOCKED numa negação, mas não separava a recusa de forma da trava de worktree. Dois Donos contornaram recusas da trava, e as duas revisões de trilha marcaram isso. A Raiz corrigiu o modelo das lanes no meio do programa. A regra geral entra nesta PR.
3. **Tensão do interrogate no playbook.** "Opening a PR" (linha 36) manda rodar o interrogate sempre. O passo 7 do Feature só pede quando o desenho é contestado. Os Donos dos itens 1 e 3 o dispensaram, e o do item 4 rodou depois do aviso da Raiz. O texto é gerado do upstream e esta PR não o toca. Fica registrado.
4. **Hipótese não provada do `Edit`.** O Dono do item 4 e uma lane de auditoria relataram que o `Edit` transformou escapes `\u` em caracteres crus. O revisor de outra família mostra que o transcript não separa isso de o modelo ter escrito os caracteres crus. Fica como observação, sem correção.
5. **Limite do `BigInt` no `parseDuration`.** O item 1, já mergeado, provavelmente tem o mesmo limite do F6: um `SyntaxError` em vez de `RangeError` acima de cerca de 323 milhões de dígitos. Não foi medido. Um item novo na fila do pstack-lab cobre isso.
6. **Tempos digitados à mão na trilha da Raiz.** Seis horas estimadas e uma conta inventada de tempo até o PR (3,5 min para os três Donos) entraram no `events.log` e na auditoria do Tick 1. Todas foram corrigidas pelo transcript (`corrections/`) e registradas como linhas novas.
7. **Custo do critério de censo.** O item 4 levou quatro Rodadas, todas por lacunas de teste, com o código certo desde a Rodada 1. A regra está escrita e foi aplicada igual nos quatro itens. Ela fecha classes inteiras, mas multiplica Rodadas quando o item tem muitas posições de entrada.

## Correção de harness desta PR

Só adaptação de harness, sem fluxo paralelo e sem tocar nos playbooks gerados do upstream:

- `skills/poteto-mode/references/native-lifecycle.md`: os limites de execução de um subagente em segundo plano (fatos 1 a 5) e a diferença entre recusa da trava e negação do classificador.
- `skills/poteto-mode/SKILL.md`, Autopilot owners: o resultado de um ajudante chega ao Dono só enquanto a execução dele está aberta; depois do hand-back, a Raiz repassa.
- `docs/reference.md`, "O que o Dono faz": a mesma regra, em português.

## Atenção

reviewed by gpt-6.1-sol

As cinco revisões vieram de `codex:gpt-6.1-sol@xhigh`, escolhido pelo `setup-pstack.ts pick --parent claude --role "trail reviewer pool"`, pelo runner e em modo leitura. Os recibos são `complete` com `pinned-argv`, então o modelo é o pedido e o provedor não o confirmou. Os textos completos estão em `03-trail-review/<trilha>/output.md`.

**Trilha do Dono do `duration-parse`** (cinco pontos).
- Depois da recusa do `report.md`, o Dono pediu à Raiz para gravar o caminho recusado e seguiu editando e commitando antes de a Raiz responder.
- A auditoria pelo transcript leu um índice de trechos curtos, e não registros inteiros.
- A dispensa do Arena tem base fraca: o contrato público fixo ainda admitia desenhos diferentes de parser.
- O vigia do PR não foi re-armado depois do MERGE-CLEARED.
- O verificador de mutantes contou 15 testes de erro, não os 16 que a trilha diz.

**Trilha do Dono do `semver-compare`** (quatro pontos).
- Recusas da trava foram contornadas sem a pausa que o ciclo pedia. Esse texto do ciclo era ambíguo, e a correção desta PR separa os dois casos.
- O formato da implementação foi fixado antes, e isso justificou pular o Arena.
- O censo de mutantes não incluiu os da auditoria de testes da Rodada 1.
- Os rótulos "verified" da auditoria dizem mais do que ela conferiu.

**Trilha do Dono do `duration-format`** (seis pontos).
- Recusas da trava foram contornadas, pelo mesmo motivo do item 2.
- A auditoria pelo transcript foi rasa, e dois ponteiros estão errados.
- Uma linha de auditoria diz que os testes cobriam a precedência de tipo, e o G1 da Rodada 1 prova o contrário.
- O push da Rodada 1 veio antes do `npm test` no head commitado.
- O vigia do PR não foi re-armado depois do MERGE-CLEARED.
- O interrogate foi dispensado, contra a linha 36 de "Opening a PR".

**Trilha do Dono do `lab-cli`** (oito pontos).
- O build começou antes do juiz do Arena, e o candidato que ficou de fora venceu.
- O painel interrogate revisou heads diferentes, e nenhum revisou `9d5e1a1a`.
- O no-comments rodou junto com o interrogate, e comentários escritos depois não passaram por ele.
- O Dono escreveu a implementação a partir da remodelagem, contra o "Delegate implementation" do Feature.
- A lacuna do campo `bin` (A4) foi dispensada cedo e só fechou na Rodada 1.
- O resumo da prova ao vivo diz mais do que o driver cobre no modo PATH.
- A falha do `Edit` com escapes `\u` não está provada.
- A auditoria leu o transcript, mas a linha 79 rotula errado a linha 545 e ignora as retomadas automáticas.

**Trilha da Raiz** (sete pontos), todos aceitos e registrados como linhas novas no `decisions.tsv`.
- O teste de travamento ficou mais fraco: a Raiz julgou a lane opus de arquitetura "atrasada, não travada" pelas chamadas de ferramenta recentes. O playbook só conta efeitos colaterais, e uma lane só de leitura com 31 min contra 20 esperados estava travada por esse critério.
- A Raiz gravou o hand-back de um ajudante no `report.md` que o host tinha recusado a ele (transcript da Raiz, linha 912). Cinco minutos depois, recusou o pedido análogo de um Dono. A linha nova separa os dois casos: no primeiro, o pai grava o texto devolvido, que é o fluxo que a recusa pede; no segundo, um agente pede à Raiz a ação que lhe foi recusada.
- A Raiz aceitou que o Dono do item 4 começasse o build antes do juiz e registrou isso só na auditoria do Tick 3.
- A exceção para mutantes amarrados a valores entrou no meio do programa (M24, item 3, Rodada 2), depois de lacunas de teste do item 2 já terem barrado merges. O D1 do item 4 se apoiou nela.
- O Veredito do item 1 afirmou que nenhuma entrada separa a aritmética com `Number` da implementação com `BigInt`. O F6 do item 2 desmente isso para entradas enormes, e a medição fica como lacuna 5.
- A lane de regressão da Rodada 2 do item 2 comparou com `67fafb33`, quando a `main` já estava em `0ab81b5c`.
- Duas horas digitadas sobreviveram à correção: uma no `inventory.tsv` e uma na auditoria de recibos da Rodada 1 do item 4.

**Padrão que depende do Victor.** A leitura do D1: o CLI imprime a mensagem da função como ela vem, mesmo com U+2028 dentro, numa linha terminada em `\n`. Se a regra deve ser escapar esses caracteres, basta dizer. Um item novo na fila do pstack-lab cobre a mudança.

## Verificação

- As receitas da skill `verify-pstack-vic` no commit exato desta PR (`classify` e `run`) estão no corpo da PR, com o diretório de saída e o recibo de cada uma.
- O programa em si não passou por receita do verificador. As provas dele são as sessões reais acima:
  - os Vereditos publicados nos PRs 3 a 6 do pstack-lab;
  - o CI `test` verde nos quatro merges (`0ab81b5c`, `04244469`, `8235d967` e `67512db3`);
  - os recibos do runner;
  - o censo do classificador e as capturas privadas.

## O que sobrou

Sem faxina, como pedido:
- no `pstack-lab`, 67 worktrees `agent-*` em `.claude/worktrees/`, as 67 branches locais `worktree-agent-*` e as branches locais que os Donos criaram (`impl/duration-parse`, `impl/semver-compare`, `nc/semver-compare`, `sicko/duration-parse` e três `autopilot/*`);
- as branches remotas `autopilot/duration-parse`, `autopilot/semver-compare`, `autopilot/duration-format` e `autopilot/lab-cli`;
- o worktree do app desta sessão no `pstack-lab`;
- o worktree e a branch `claude/autopilot-claude-root-auto-report` no `pstack-vic`.

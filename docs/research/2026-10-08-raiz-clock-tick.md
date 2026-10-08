# O relógio da Raiz numa raiz Claude

Frente de 2026-10-08 sobre o Tick do autopilot (o `/loop 1h` do upstream) numa Raiz Claude, a partir da `main` com #106 e #107. A pergunta: por que o cron do app desktop chegou 76 minutos atrasado na véspera, e qual a adaptação mínima de harness que preserva o prompt e a cadência do Tick. Evidência privada em `~/Dev/Skills/pstack-vic-runs/2026-10-08-raiz-clock-tick/` (`plan.md`, `events.log`, `nonces.txt`, `identity.txt`, as saídas de cada tarefa e `terminal-root/`). Cada evento levou um nonce próprio e a Raiz encerrou o turno logo depois de armar; cada turno posterior está atribuído ao evento que o abriu.

## Identidades

| Raiz | Sessão | Binário | Host |
| --- | --- | --- | --- |
| app desktop | `518f4bbc-a905-4b68-94bc-40fdcbac4091` | Claude Code 2.1.293 (`CLAUDE_CODE_EXECPATH` dentro do app 2.26454.2), `--input-format stream-json`, `CLAUDE_CODE_ENTRYPOINT=claude-desktop`, `CLAUDE_CODE_SESSION_ATTENDED=1` | app desktop do Claude |
| terminal | `5054519e-5b81-42f0-ba11-1123791170c9` | o mesmo binário 2.1.293, aberto pelo caminho absoluto no painel de terminal do app, REPL interativo com TTY, `--permission-mode auto`, `CLAUDE_CODE_ENTRYPOINT=cli` | terminal |

A raiz de terminal foi aberta pela raiz do app com `run_in_terminal` e um prompt inicial que descrevia o exercício (`terminal-root/prompt.txt`); ela gravou `terminal-root/events.log` sozinha. O `claude --version` que ela registrou é o do binário no PATH (2.1.292); o processo em execução, lido com `ps`, é o 2.1.293 (`terminal-root/process.txt`).

## Regra de entrega do scheduler

Documentação oficial de `scheduled-tasks`: "Tasks only fire while Claude Code is running and idle" e "If Claude is busy when a task comes due, the prompt waits until the current turn ends". Ela não diz o que vale como ocupado quando há uma tarefa em segundo plano. Medido:

| Caso | Raiz | Armado (UTC) | Devido | Entregue | Em segundo plano no momento devido |
| --- | --- | --- | --- | --- | --- |
| a | app desktop | 16:36:04, job `937056d1` | 16:39 | 16:46:36, como prompt de turno, 7,5 min depois | `sleep 600` (tarefa `b3md9oo6g`) até 16:45:56; o fim dele abriu um turno às 16:46:05 com o cron ainda listado; o cron chegou meio minuto depois desse turno encerrar sem nada vivo |
| a | terminal | 16:36:17, job `e9a92ed9` | 16:39 | 16:39:09, "Running scheduled task" | `sleep 600` ainda rodando ("1 shell still running") |
| b | app desktop | 16:46:48, job `9be5bd35` | 16:49 | 16:49:04 | nada |
| b | terminal | 16:46:25, job `d58d8f5c` | 16:49 | 16:49:03 | nada |
| c | app desktop | 16:49:28, job `056e6171` | 16:53 | 16:57:00, 4 min depois | um subagente `claude` em segundo plano (modelo haiku) rodando `sleep 420`; o host o listou como `completed` desde 16:49:54, com o shell dele vivo; o retorno dele abriu um turno às 16:56:47 com o cron ainda listado; o cron chegou 13 s depois desse turno encerrar |

`CronList` ficou vazio depois de cada entrega; nenhum job disparou duas vezes. A regra que fecha com todas as observações, as de hoje e as da véspera: no app desktop, um prompt agendado é entregue no primeiro fim de turno em que nenhuma tarefa em segundo plano está viva, contando shells e subagentes, mesmo um subagente já listado como concluído enquanto o shell dele roda. Numa raiz de terminal, o mesmo binário entrega na hora com a tarefa em segundo plano viva. A diferença é do host, não da versão.

## O Tick candidato

Um comando `Bash` em segundo plano que dorme e imprime o prompt do Tick, re-armado a cada despertar, na raiz do app desktop:

| Ciclo | Armado (UTC) | Comando | Saída | Turno aberto | Latência |
| --- | --- | --- | --- | --- | --- |
| s1 | 16:57:21, tarefa `bn1dwchcu` | `sleep 120; echo TICK_S1 …` (timeout 180 000 ms) | 16:59:16 | 16:59:25 | 9 s |
| s2 | 16:59:29, re-armado no turno do s1 | `sleep 120; echo TICK_S2 …` | 17:01:25 | 17:01:37 | 12 s |
| h1 | 17:03:26, re-armado no turno do s2, tarefa `bf0mzge5b` | `sleep 3600; echo TICK_H1 …; cat tick-prompt.txt` (timeout 3 660 000 ms) | pendente | pendente | pendente |

O `tick-prompt.txt` é o prompt do Tick, palavra por palavra, do `multi-phase-plan.md`. O timeout acima de uma hora é necessário: a documentação de `tools-reference` dá trinta minutos a um comando em segundo plano sem `timeout`, e no máximo duas horas. Na véspera, um `sleep 3600` em segundo plano já tinha acordado a raiz do app uma hora depois (tarefa `bs7ftkxh8`, relatório anterior).

## Decisão

Mantém-se o `/loop 1h` onde ele funciona, a raiz de terminal, exatamente como o upstream escreve. Só a Raiz do app desktop, reconhecida por `CLAUDE_CODE_ENTRYPOINT=claude-desktop`, arma o Tick como o comando em segundo plano acima, com o re-arme como primeiro passo de cada Tick e `TaskStop` no fim do programa. O prompt do Tick e a cadência de uma hora não mudam. Não entra daemon, serviço, mudança de modelo, de esforço, de fallback de swarm nem de política de Arena ou de trilha. A decisão está no [ADR 0010](../adr/0010-tick-em-segundo-plano-na-raiz-do-app-desktop.md); os chamadores são `docs/reference.md`, `CONTEXT.md`, a seção *Platform Adaptation* de `skills/poteto-mode/SKILL.md`, o guia de trabalho noturno e a troca T13 de `upstream-substitutions.json`, que passa a apontar a Raiz do app desktop para o `SKILL.md`, como já aponta Codex e Grok para os mapas deles. O marcador `/loop 1h` do `check-plan.mjs` continua válido, porque o texto gerado do plano continua a nomeá-lo.

## Lacunas

- Um programa inteiro com Donos reais ainda não rodou com esse Tick; os ciclos acima provam o mecanismo, não o playbook de ponta a ponta.
- A raiz de terminal foi medida uma vez, com um cron de uma só vez; o `/loop 1h` recorrente usa o mesmo scheduler e não foi medido separadamente.
- O motivo pelo qual o host do app segura o scheduler com tarefas em segundo plano vivas não está documentado; a regra aqui é a observada em 2.1.293, em dois dias.

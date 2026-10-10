---
status: accepted
---

# Tick em segundo plano na Raiz do app desktop

## Contexto

O pstack da Cursor arma o Tick do autopilot como `/loop 1h`, um cron recorrente da sessão. No Claude Code o comando existe e, numa raiz de terminal, dispara na hora mesmo com tarefas em segundo plano vivas (2.1.293, medido em 2026-10-08). Numa Raiz aberta no app desktop do Claude, o mesmo binário só entrega um prompt agendado no primeiro fim de turno em que nenhuma tarefa em segundo plano está viva. Um shell ou um subagente em segundo plano retém o cron, mesmo um subagente que a lista de agentes já mostra como concluído enquanto o shell dele ainda roda. Um programa de autopilot tem Donos em segundo plano o tempo todo, então um Tick por `/loop 1h` só chegaria depois do último Dono terminar. O fim de um comando `Bash` em segundo plano e um evento do `Monitor` acordam essa Raiz na hora; o `Monitor` expira em trinta minutos.

## Decisão

Manter o `/loop 1h` onde ele funciona, a raiz de terminal. Só na Raiz do app desktop, que se reconhece por `CLAUDE_CODE_ENTRYPOINT=claude-desktop` no ambiente da sessão, armar o Tick como um comando `Bash` em segundo plano que dorme uma hora e imprime o prompt do Tick, com `timeout` acima de uma hora. O fim do comando abre o turno do Tick. O primeiro passo desse Tick é armar o comando de novo, e o fim do programa o para pelo handle. O prompt do Tick e a cadência de uma hora são os do upstream; muda só o mecanismo que chama a sessão de volta, como no adaptador de despertar do Codex ([ADR 0008](0008-despertar-local-por-fila-do-codex.md)) e no monitor da raiz Grok. Não há daemon, serviço nem recorrência escondida: cada ciclo é um evento finito, armado explicitamente, com identidade (o id da tarefa) e evidência própria (a saída do comando).

Em 2026-10-09 a mesma decisão passou a valer para uma Raiz Claude aberta no T3 Code. O T3 Code inicia o `claude` pelo Agent SDK, e `CLAUDE_CODE_ENTRYPOINT` vale `sdk-ts` no ambiente da sessão. No Claude Code 2.1.295, sob o Agent SDK 0.3.276, o host reteve um cron enquanto havia tarefa em segundo plano viva, exatamente como o app. O fim de um `Bash` em segundo plano acordou a Raiz na hora. Um programa Autopilot-full inteiro rodou nesse host com o Tick deste ADR ([relatório](../research/2026-10-09-autopilot-claude-root-t3.md)). A Raiz que vê `sdk-ts` arma o mesmo comando. O mecanismo, o prompt e a cadência não mudam; só cresce a lista de hosts que o usam. `sdk-ts` não identifica o T3 Code sozinho: qualquer host do Agent SDK em TypeScript tem esse valor, e só o T3 Code foi medido.

## Consequências

Os playbooks gerados continuam dizendo `/loop 1h`. A troca T13 passa a apontar a Raiz do app desktop para a seção *Platform Adaptation* de `SKILL.md`, como já aponta o Codex e o Grok para os mapas deles. O comando não volta com `--resume`: ele termina com a sessão, e a sessão retomada pelo mesmo id recebe só um aviso de tarefa parada, nunca o fim dele (medido em 2026-10-08 no binário 2.1.293 numa raiz de terminal; [relatório](../research/2026-10-08-claude-root-harness.md)). Uma Raiz retomada arma o Tick de novo. No T3 Code, uma troca de modo, de modelo ou de pasta na thread também retoma a sessão num processo novo, com `--resume` e o mesmo id; a troca de modo foi medida em 2026-10-09. Um Tick que começa e não re-arma deixa o programa sem relógio até o operador mandar um Tick; por isso o re-arme é o primeiro passo. As [medições](../research/2026-10-08-raiz-clock-tick.md) delimitam o que foi observado: dois hosts, uma versão, um dia.

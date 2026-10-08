---
status: accepted
---

# Tick em segundo plano na Raiz do app desktop

## Contexto

O pstack da Cursor arma o Tick do autopilot como `/loop 1h`, um cron recorrente da sessão. No Claude Code o comando existe e, numa raiz de terminal, dispara na hora mesmo com tarefas em segundo plano vivas (2.1.293, medido em 2026-10-08). Numa Raiz aberta no app desktop do Claude, o mesmo binário só entrega um prompt agendado no primeiro fim de turno em que nenhuma tarefa em segundo plano está viva. Um shell ou um subagente em segundo plano retém o cron, mesmo um subagente que a lista de agentes já mostra como concluído enquanto o shell dele ainda roda. Um programa de autopilot tem Donos em segundo plano o tempo todo, então um Tick por `/loop 1h` só chegaria depois do último Dono terminar. O fim de um comando `Bash` em segundo plano e um evento do `Monitor` acordam essa Raiz na hora; o `Monitor` expira em trinta minutos.

## Decisão

Manter o `/loop 1h` onde ele funciona, a raiz de terminal. Só na Raiz do app desktop, que se reconhece por `CLAUDE_CODE_ENTRYPOINT=claude-desktop` no ambiente da sessão, armar o Tick como um comando `Bash` em segundo plano que dorme uma hora e imprime o prompt do Tick, com `timeout` acima de uma hora. O fim do comando abre o turno do Tick. O primeiro passo desse Tick é armar o comando de novo, e o fim do programa o para pelo handle. O prompt do Tick e a cadência de uma hora são os do upstream; muda só o mecanismo que chama a sessão de volta, como no adaptador de despertar do Codex ([ADR 0008](0008-despertar-local-por-fila-do-codex.md)) e no monitor da raiz Grok. Não há daemon, serviço nem recorrência escondida: cada ciclo é um evento finito, armado explicitamente, com identidade (o id da tarefa) e evidência própria (a saída do comando).

## Consequências

Os playbooks gerados continuam dizendo `/loop 1h`. A troca T13 passa a apontar a Raiz do app desktop para a seção *Platform Adaptation* de `SKILL.md`, como já aponta o Codex e o Grok para os mapas deles. O comando não volta com `--resume`: ele termina com a sessão, e a sessão retomada pelo mesmo id recebe só um aviso de tarefa parada, nunca o fim dele (medido em 2026-10-08 no binário 2.1.293 numa raiz de terminal; [relatório](../research/2026-10-08-claude-root-harness.md)). Uma Raiz retomada arma o Tick de novo. Um Tick que começa e não re-arma deixa o programa sem relógio até o operador mandar um Tick; por isso o re-arme é o primeiro passo. As [medições](../research/2026-10-08-raiz-clock-tick.md) delimitam o que foi observado: dois hosts, uma versão, um dia.

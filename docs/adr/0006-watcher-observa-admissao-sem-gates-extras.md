---
status: accepted
---

# Watcher observa admissão sem gates extras

Em 2026-10-07, a reavaliação autorizada pelo operador aplica ao watcher a política de fidelidade do [ADR 0005](0005-autopilot-substitui-converge.md). A leitura de admissão continua útil para diagnosticar a fila, mas deixa de decidir se o PR está pronto ou bloqueado. O pin continua em `4e5b1cf2ccb0ea3716f08c8ee0a5856b5ab93536` (pstack 0.15.10).

## Evidência e limites

A comparação usa objetos Git, não o `cursor/main` atual: base local `c3299a004e3b256ded366522b2696a58cd5084c2`, [policy local](https://github.com/byvict/pstack-vic/blob/c3299a004e3b256ded366522b2696a58cd5084c2/skills/poteto-mode/scripts/watch-pr/policy.ts), [policy upstream](https://github.com/cursor/plugins/blob/4e5b1cf2ccb0ea3716f08c8ee0a5856b5ab93536/pstack/skills/poteto-mode/scripts/watch-pr/policy.ts) e [leitor upstream](https://github.com/cursor/plugins/blob/4e5b1cf2ccb0ea3716f08c8ee0a5856b5ab93536/pstack/skills/poteto-mode/scripts/watch-pr/github.ts). Para reproduzir: `git diff 4e5b1cf:pstack/skills/poteto-mode/scripts/watch-pr/policy.ts c3299a0:skills/poteto-mode/scripts/watch-pr/policy.ts`.

Os relatórios `docs/research/2026-10-07-pstack-codex-fidelity-audit.md` e `docs/research/2026-10-07-cursor-exercise-audit.md` foram lidos pelos caminhos absolutos sob `/Users/victorbaccega/.codex/worktrees/1a40/pstack-vic/`, onde estavam untracked. Serviram como pistas. Os fatos abaixo foram conferidos nas fontes versionadas. O exercício Cursor não testou o watcher; não prova incidência destes bloqueios em um PR real nem equivalência entre executores.

## Decisões

| Tema | Comportamento na base local | Upstream no pin | Decisão, consequência e diferença mantida |
| --- | --- | --- | --- |
| Readiness | `requirementsReady` exige base conhecida e todos os required checks do head `passed`, além do CI já lido. Ausência de check pode manter espera apesar do CI verde. | `readyContribution` usa CI, conflitos, threads e gates de draft/review/closed. Não lê rulesets para admitir readiness. | Retirar `requirementsReady`. `READY` tem o significado upstream; não certifica a política completa do GitHub nem que o merge ocorrerá. O GitHub continua aplicando suas regras ao merge. |
| Bloqueio nativo | `nativeBlocker` precede conflitos, threads e CI em `classifyPr` e `selectTierMajorStackDecision`; unknown, falha do candidato e remoção vinculada ao head podem gerar exit 8. | Não há esse tier nem esse exit. | Retirar o tier, o tipo e o renderer de bloqueio nativo. Os mesmos fatos upstream voltam a produzir os mesmos bloqueios e sua prioridade. Falha/remoção continuam em `LANDING`, JSON e texto; o operador pode diagnosticá-las sem um novo gate local. |
| PR admitido | Auto-merge/fila suprimem os bloqueios de CI e conflito. Modos single e stack podem esperar o merge em vez de retornar `READY`. | Esses bloqueios continuam valendo. Single/stack retornam readiness; `--queued-stack` espera todos os PRs mergearem. | Retirar a decisão `admitted` e suas esperas em single/stack, inclusive o ramo redundante de stack clear. Manter `--queued-stack`, timeout, fronteira e avanço após merge real. Habilitar auto-merge não torna um CI falho obsoleto por si só. |
| Leitura adicional | `readRequirements` conserva unknown quando rules/checks não podem ser lidos, mas a política bloqueia. A consulta GraphQL que acrescenta admissão é obrigatória para ler o PR. | `gh pr view` lê os fatos básicos sem os campos adicionais. Falhar nessa leitura continua sendo erro de status. | Conservar unknown sem veto; se a consulta ampliada falhar, usar a leitura básica upstream e registrar o erro em `native.reason`. Se ambas falharem, permanece `status-query`, exit 7. Falha de observação opcional não vira pré-requisito de API. |
| Diagnóstico da fila | Identidade do PR/head/base, candidato, produtor/tentativa dos checks, auto-merge, estado e remoção da fila enriquecem snapshots. | Esses campos não existem no pin. | Manter os dados, `observeLanding`, `LANDING` e motivos detalhados de espera no modo queued. Essa diferença deliberada melhora diagnóstico; não autoriza merge, reentrada automática nem reclassifica readiness. `landing.kind=unknown/failed/removed` pode coexistir com `READY`. |

`ready-unadmitted` continua sendo uma observação mais restrita baseada nos dados adicionais; consumidores de decisão devem usar o veredito `READY`/`BLOCKER`, e não promovê-la a outro gate. Os consumidores internos são o classificador single, a seleção por tier de stack, `runSimple`, `evaluateQueue`/`runQueued`, os tipos de veredito e o renderer. Todos foram conferidos nesta mudança.

## Verificação e escopo

`watch-pr/native.test.ts` testa os mesmos resultados single/stack com admissão desconhecida, base desconhecida, requirements desconhecidos, auto-merge, fila e candidato não mergeável; testa prioridade de conflito/CI, draft e changes requested, além de candidato falho, remoção vinculada ao head e check obrigatório ausente. Exercita `runSimple` até `READY` sem dormir e `runQueued` até o merge observado. `native-cli.test.ts` executa o CLI público com um `gh` isolado: falhas de observação e de rules preservam exit 0/unknown; indisponibilidade dos fatos básicos preserva exit 7. São testes de comportamento com fixtures, não um merge real.

A receita `repository-contracts` da skill de verificação cobre os contratos gerais do repositório; `npm run test:bun` cobre watcher/orch e o typecheck que não estão nessa receita. Os recibos de cada commit e as saídas Bun ficam vinculados no PR. Não há dependência de alteração no runner ou em provider-dispatch.

Cloud, VMs e execução remota permanecem fora do produto por escolha explícita do operador. Worktrees locais, modelos pessoais, fallback de swarm e Attack the Premise permanecem. Esta decisão não reintroduz Converge, Guarded operations, nem um workflow adicional.

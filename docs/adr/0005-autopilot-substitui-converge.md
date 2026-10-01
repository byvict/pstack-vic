---
status: accepted
---

# Autopilot substitui converge

Supera os ADRs [0001](0001-verificacao-pesada-antes-do-pr.md), [0002](0002-receita-obrigatoria-no-pr-que-cria-a-pagina.md), [0003](0003-converge-sem-nuvem.md) e [0004](0004-classe-leve-por-caminho.md).

## Decisão

Em 2026-09-30 Victor decidiu aposentar o converge inteiro e adotar o autopilot do pstack da Cursor como o fluxo do plugin. O converge sai na 0.5.0. Os playbooks do autopilot voltam ao texto do upstream (commit `12d587d` da Cursor) na 0.5.1, com as trocas de harness e nada mais: Claude Code e Codex no lugar do harness da Cursor, subagentes em worktrees no lugar dos agentes na nuvem, e os modelos vindos da matriz daqui.

## Por quê

A regra do port é que o pstack-vic só difere do upstream onde o harness obriga. O converge quebrava essa regra: era um fluxo paralelo ao autopilot, que o upstream já tem e que faz o mesmo trabalho, levar uma fila de PRs até o merge com verificação independente.

O custo de manter os dois aparecia em três lugares:

- **Tamanho.** Na 0.4.19 o converge tinha 77 arquivos de script, e 769 dos 1118 testes do plugin eram dele.
- **Sync com a Cursor.** Cada mudança do upstream no autopilot precisava ser comparada com o converge antes de entrar. Na 0.4.18 os hunks de autopilot de dois commits da Cursor ficaram pendentes por isso.
- **Peças fora do plugin.** O fluxo dependia de três jobs launchd no Mac, de dois checks obrigatórios no GitHub (`verdict` e `hold`) e de uma fila de merge no Clinext, todos mantidos aqui.

## O que sai

- Os scripts do converge (`skills/poteto-mode/scripts/converge/`), o Daemon com os três jobs launchd e o `converge-local`.
- Os playbooks Pré-PR, Converge e Catch-up e as referências deles (contrato, fila de merge, entrega paralela, prompts do Pré-PR).
- O Certificado: os checks `verdict` e `hold`, a action da fila de merge e o contrato `.cursor/converge.json`.
- Seis papéis da matriz: `pre-pr reviewer`, `pre-pr fixer`, `pre-pr certifier`, `converge raiz`, `pr owner` e `pr verifier`.
- Duas capacidades do runner que só o converge usava: o modo `unsandboxed` e as lanes na nuvem da Cursor (o provider `cursor`, por HTTP).
- Os trailers de commit `Pstack-Author` e `Pstack-Linear`, que só o converge lia.
- O Pós-merge do Daemon, que criava a tag da versão e trocava o plugin nos dois pais.

O código fica nas tags `archive/converge-0.4.18` e `archive/converge-0.4.19`, os documentos em [`docs/arquivo/`](../arquivo/) e a história de cada versão em [`CHANGES.md`](../../CHANGES.md).

## O que entra no lugar

- **O autopilot.** A sessão que Victor abre é a Raiz do programa. Ela cria um Dono por PR, cada um num worktree próprio, e o Dono leva o PR do build ao merge. A Raiz verifica cada PR com um Enxame de lanes que não escreveram o código e audita os Donos a cada 30 minutos. Nada mergeia sem o Veredito limpo da Raiz. O vocabulário está em [`CONTEXT.md`](../../CONTEXT.md).
- **A versão do plugin.** O CI cria a tag a cada merge na `main`. Trocar o plugin nos dois pais é um comando no Mac, `node scripts/release.ts`.
- **A autorização permanente, versão 2.** A entrada no modo automático do Claude Code passa a cobrir o merge do Dono depois do Veredito da Raiz e o merge do playbook Shipping.

## Consequências

- **Não existe mais daemon.** Nada mergeia sozinho, nem de madrugada. Um PR só anda enquanto uma sessão está aberta rodando um programa.
- **A sessão da Raiz fica aberta até o último merge.** Se Victor fechar, os Donos param, e nada acontece até ele abrir de novo e retomar.
- **Dependabot à mão.** Ninguém mergeia sozinho os PRs do Dependabot. Ou Victor clica, ou um programa de autopilot adota a fila.
- **O GitHub exige só o CI.** A garantia de que ninguém mergeia sem verificação independente sai dos checks obrigatórios e passa para o playbook (o Veredito da Raiz) e para a autorização permanente.
- **No Codex não há relógio.** Victor pede o Tick a cada 30 minutos, e o Codex precisa de `multi_agent` ligado para ter Donos.
- **O texto do autopilot é o do upstream.** Uma frase que não é do upstream nem troca de harness é defeito. A partir da 0.5.1 um teste regenera do upstream os seis playbooks ligados ao autopilot (Autopilot-full, Autopilot-stack, Babysit, Opening a PR, Shipping e Multi-phase plan) e falha se sobrar diferença.

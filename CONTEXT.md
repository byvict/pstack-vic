# pstack-vic

Plugin de skills e playbooks que Victor usa no Claude Code e no Codex para autorar e mergear PRs por programas de autopilot. Um programa é uma execução do autopilot sobre uma fila de PRs. Este glossário cobre o vocabulário de um programa: quem faz o quê e como um PR chega ao merge.

## Language

### Sessões e lanes

**Raiz** (root):
A sessão Claude Code ou Codex que conduz um programa de autopilot. É dona dos Vereditos, nunca de um PR. Ela cria um Dono por PR, verifica cada Rodada com o Enxame, dá o Veredito e audita os Donos a cada Tick.
_Avoid_: parent, coordenador, sessão autora

**Dono** (owner):
O subagente em segundo plano, num worktree próprio, que leva um PR do build ao merge. Ele faz o primeiro push, abre o PR já pronto, prova a mudança no artefato real e acompanha o PR até o CI ficar verde (babysit). No Autopilot-full ele faz o próprio merge, e só depois do Veredito limpo da Raiz. No Autopilot-stack ele não mergeia: avisa STACK-READY, e a Raiz põe o PR na pilha.
_Avoid_: autor, implementer, worker

**Lane**:
Uma execução de modelo lançada pela Raiz ou por um Dono, com papel, modo de acesso e recibo próprios.
_Avoid_: subagente, worker, child

**Família**:
O fornecedor de um modelo (Claude, Codex, Grok); duas lanes são cruzadas quando suas famílias diferem. Na matriz de modelos é a coluna Provider. A coluna Family da matriz é a linha do modelo, e trocar Sol por Astra, ou Opus por Fable, não muda a Família.
_Avoid_: provider, vendor, modelo

**Executor**:
Uma Família que escreveu o trabalho de uma execução: a da sessão que o fez, sempre, e a de cada Lane de escrita cujo resultado entrou na entrega. Uma Lane só de leitura não é Executor.
_Avoid_: autor, pai, escritor

### O programa

**Enxame** (swarm):
As lanes verificadoras que a Raiz lança em paralelo no head (o último commit) de uma Rodada, pela skill `swarm`, e que não escreveram o código. Elas rodam de novo os gates (as checagens do repositório), provam ao vivo o comportamento que a mudança traz, auditam o diff sem confiar no corpo do PR e rodam o mesmo cenário na trunk (a `main`).
_Avoid_: revisores, painel, verifier

**Veredito** (verdict):
O resultado único que a Raiz agrega das lanes do Enxame para o patch de uma Rodada. Só um Veredito limpo libera o merge, e sem a lane ao vivo ele não é limpo. Depois de um rebase, a Raiz confere se o Veredito ainda descreve o patch pelo SHA, pela base e pelo patch-id, com a exceção de comparação de builds e as novas verificações do playbook Shipping.
_Avoid_: aprovação, review, status

**Rodada** (round):
Uma passada do Enxame num head. Começa no head Code-ready do Dono e em cada push posterior que muda o patch do PR. Os achados provados voltam ao Dono num só pedido de correção, e o head novo ganha Enxame e Veredito novos.
_Avoid_: ciclo, iteração, retry

**Code-ready**:
O relato do Dono, com o SHA do head, de que o código a entregar está final, depois do `/deslop` e do `/no-comments`. É onde a primeira Rodada começa. A prova do Dono, o CI e o babysit seguem em paralelo com o Enxame.
_Avoid_: pronto, done, draft

**Merge-ready**:
O relato do Dono, com o SHA do head, de que a prova dele, o CI e o babysit terminaram. O merge exige o Veredito limpo da Rodada cujo patch é o desse head. No Autopilot-stack o relato se chama STACK-READY, e o Veredito limpo põe o PR na pilha em vez de liberar um merge.
_Avoid_: aprovado, verde, mergeável

**Itens do operador**:
Os itens da fila que o operador (Victor) nomeia como dele ("esse PR fica comigo"). O Dono leva cada um até Merge-ready e para ali. Quem revisa e clica no merge é o operador, e nenhum Dono mergeia um deles.
_Avoid_: hold, bloqueio, rótulo

**Tick**:
A auditoria que a Raiz faz sobre todos os Donos a cada hora. Ela relê o playbook, confere a operação contra ele, sonda cada Dono e recolhe as trilhas de decisão. No Claude Code, a Raiz arma o Tick como `/loop 1h` numa raiz de terminal e como um comando em segundo plano de uma hora, re-armado a cada Tick, numa Raiz do app desktop; no Codex, o [contrato de despertar](skills/poteto-mode/references/codex-local-wake.md) seleciona o mecanismo do host ou, na falta de um mecanismo válido, o prompt do operador; na raiz Grok, um monitor o emite. A cadência nunca fica por conta da memória.
_Avoid_: cron, heartbeat, polling

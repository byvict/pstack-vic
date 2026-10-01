# pstack-vic

Plugin de skills e playbooks que Victor usa no Claude Code e no Codex para autorar e mergear PRs por programas de autopilot. Este glossário cobre o vocabulário de um programa: quem faz o quê e como um PR chega ao merge.

## Language

### Sessões e lanes

**Raiz** (root):
A sessão Claude Code ou Codex que conduz um programa de autopilot. É dona dos vereditos, nunca de um PR: cria um Dono por PR, verifica cada Rodada com o Enxame, dá o Veredito e audita os Donos a cada Tick.
_Avoid_: parent, coordenador, sessão autora

**Dono** (owner):
O subagente em segundo plano, num worktree próprio, que leva um PR do build ao merge: primeiro push, PR aberto pronto, prova no artefato real, babysit até o CI verde e o próprio merge, que só acontece depois do Veredito limpo da Raiz.
_Avoid_: autor, implementer, worker

**Lane**:
Uma execução de modelo lançada pela Raiz ou por um Dono, com papel, modo de acesso e recibo próprios.
_Avoid_: subagente, worker, child

**Família**:
O fornecedor de um modelo (Claude, Codex, Grok); duas lanes são cruzadas quando suas famílias diferem.
_Avoid_: provider, vendor, modelo

### O programa

**Enxame** (swarm):
As lanes verificadoras que a Raiz lança em paralelo no head de uma Rodada, pela skill `swarm`, e que não escreveram o código. Rodam os gates de novo, provam ao vivo o comportamento que a mudança carrega, auditam o diff sem confiar no corpo do PR e rodam o mesmo cenário na trunk.
_Avoid_: revisores, painel, verifier

**Veredito** (verdict):
O resultado único que a Raiz agrega das lanes do Enxame para um head exato. Só um Veredito limpo libera o merge, e sem a lane ao vivo ele não é limpo. Um head novo anula o Veredito, salvo quando o patch-id não mudou (regra do playbook Shipping).
_Avoid_: aprovação, review, status

**Rodada** (round):
Uma passada do Enxame num head. Começa no head Code-ready do Dono e em cada push posterior que muda o patch do PR. Os achados provados voltam ao Dono num só pedido de correção, e o head novo ganha Enxame e Veredito novos.
_Avoid_: ciclo, iteração, retry

**Code-ready**:
O relato do Dono, com o SHA do head, de que o código a entregar está final, depois do `/deslop` e do `/no-comments`. É onde a primeira Rodada começa; a prova do Dono, o CI e o babysit seguem em paralelo com o Enxame.
_Avoid_: pronto, done, draft

**Merge-ready**:
O relato do Dono, com o SHA do head, de que a prova dele, o CI e o babysit terminaram. O merge exige o Veredito limpo da Rodada cujo patch é o desse head.
_Avoid_: aprovado, verde, mergeável

**Itens do operador**:
Os itens da fila que o operador (Victor) nomeia como dele ("esse PR fica comigo"). O Dono os leva até Merge-ready e para; quem revisa e clica no merge é o operador, e nenhum Dono mergeia um deles.
_Avoid_: hold, bloqueio, rótulo

**Tick**:
A auditoria que a Raiz faz sobre todos os Donos a cada 30 minutos, mais ou menos: relê o playbook e o objetivo do programa, confere a operação contra os dois, sonda cada Dono e recolhe as trilhas de decisão. No Claude Code é armado como um `/loop` de verdade; a cadência nunca fica por conta da memória.
_Avoid_: cron, heartbeat, polling

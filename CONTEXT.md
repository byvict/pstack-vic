# pstack-vic

Plugin de skills e playbooks que Victor usa no Claude Code e no Codex para autorar, certificar e mergear PRs sem intervenção humana. Este glossário cobre o vocabulário do ciclo de entrega de um PR.

## Language

### Sessões e lanes

**Raiz**:
A sessão Claude Code ou Codex que conduz um PR do início ao fim e é dona de todo diff que suas lanes produzem.
_Avoid_: parent, sessão autora, agente local, owner

**Lane**:
Uma execução de modelo lançada pela Raiz com papel, modo de acesso e recibo próprios.
_Avoid_: subagente, worker, child

**Autor**:
A lane que escreve o código de um PR, sempre de família diferente da do Revisor pré-PR.
_Avoid_: implementer, delegate

**Revisor pré-PR**:
A lane Grok somente-leitura que revisa diff, risco e resultado das corridas antes de o PR existir.
_Avoid_: verifier, reviewer local, bugbot

**Certificador**:
A lane Grok que dirige o aplicativo nas funcionalidades afetadas e grava as evidências do Certificado.
_Avoid_: verifier, driver

**Ajustador**:
A lane Grok com escrita isolada que conserta os achados do Revisor pré-PR em worktree próprio; a Raiz revisa seu diff.
_Avoid_: fixer, repair lane, owner

### Artefatos e fases

**Pré-PR**:
A fase entre o fim da autoria e a criação do PR, em que o diff é revisado, verificado e ajustado até sair certificado.
_Avoid_: certificação local, converge local

**Certificado**:
O dossiê preso ao head exato do PR, publicado como status `verdict` e comentário JSON, com corridas, evidências e recibos das lanes.
_Avoid_: verdict, dossiê, certificação

**Corrida**:
Uma execução registrada de preflight, suíte ou verificação, com comando, código de saída e digest da saída.
_Avoid_: run, check, job

**Achado**:
Um defeito ou risco nomeado pelo Revisor pré-PR que impede o Certificado até ser ajustado ou refutado com evidência.
_Avoid_: finding, issue, comentário

**Receita**:
A descrição, no mapa de funcionalidades do repositório, de como dirigir uma funcionalidade no aplicativo para produzir evidência; uma superfície sem Receita não pode ser certificada.
_Avoid_: feature, recipe, roteiro

**Família**:
O fornecedor de um modelo (Claude, Codex, Grok); duas lanes são cruzadas quando suas famílias diferem.
_Avoid_: provider, vendor, modelo

### Nuvem

**Converge**:
A metade do ciclo que roda no Cursor Cloud depois que o PR existe: verifica PR sem Certificado, repara CI vermelho e arma o merge do que está certificado.
_Avoid_: pós-PR, cloud loop, owner loop

**Reparo**:
A corrida de Converge disparada por um workflow vermelho num PR certificado; conserta o head, obtém Certificado novo e arma o merge.
_Avoid_: fix, retry, hotfix

**Varredor**:
A corrida de Converge disparada por um `Tests` concluído na `main`, que arma o merge de todo PR certificado com base na `main` e sem hold.
_Avoid_: sweeper, cron, scheduler

**Hold**:
O rótulo `needs-victor` que para qualquer merge automático até Victor retirá-lo; o check obrigatório `hold` falha enquanto o rótulo está no PR, e assim segura até um auto-merge já armado.
_Avoid_: bloqueio humano, pause

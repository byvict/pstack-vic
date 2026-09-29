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
A lane somente-leitura, de qualquer família que o runner lança a partir da Raiz, que revisa diff, risco e resultado das corridas antes de o PR existir.
_Avoid_: verifier, reviewer local, bugbot

**Certificador**:
A lane de uma família com modo `unsandboxed` (hoje só Grok) que dirige o aplicativo nas funcionalidades afetadas e grava as evidências do Certificado.
_Avoid_: verifier, driver

**Ajustador**:
A lane com escrita isolada, de qualquer família de CLI ou por alias (subagente nativo), que conserta os achados do Revisor pré-PR em worktree próprio; a Raiz revisa seu diff.
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

### Depois do PR

**Converge**:
O que acontece com um PR certificado depois que a Raiz encerra: jobs launchd na máquina de Victor vigiam o GitHub, varrem, reparam e certificam o que sobrou.
_Avoid_: pós-PR, cloud loop, owner loop, nuvem

**Daemon**:
O `converge-local` e seus três jobs launchd: `com.pstack.converge-sweep` e `com.pstack.converge-raiz`, a cada dez minutos e quando alguém toca a campainha, e `com.pstack.converge-watch`, o Vigia, a cada minuto.
_Avoid_: automation, cron, scheduler, watcher

**Vigia**:
O job que, a cada minuto, pergunta ao GitHub só com GET condicional se a lista de PRs abertos, os checks da ponta da `main` ou os checks do head de um PR aberto mudaram, e toca a campainha do Varredor e do job da Raiz; nunca lança modelo nem escreve no GitHub.
_Avoid_: watcher, poller, webhook

**Varredor**:
O job que roda o `converge-sweep` por script e arma o merge de todo PR certificado com base na `main` e sem hold.
_Avoid_: sweeper, cron

**Catch-up**:
Uma tentativa de uma Raiz sem supervisão sobre um PR que já existe: reparo, recertificação ou certificação, seguida de entrega, com `outcome.json` no fim.
_Avoid_: repair job, owner run

**Reparo**:
O catch-up de tipo `repair`: um PR certificado cujo check obrigatório ficou vermelho; conserta o head, obtém Certificado novo e arma.
_Avoid_: fix, retry, hotfix

**Posse**:
O arquivo local que diz quem pode escrever numa branch por três horas, com pid opcional; o daemon nunca lança Raiz numa branch com posse viva de outro.
_Avoid_: lock, claim, mutex

**Hold**:
O rótulo `needs-victor` que para qualquer merge automático até Victor retirá-lo; o check obrigatório `hold` falha enquanto o rótulo está no PR, e assim segura até um auto-merge já armado. O daemon o aplica quando esgota os tetos de um head.
_Avoid_: bloqueio humano, pause

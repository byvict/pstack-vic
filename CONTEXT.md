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
Toda Família que escreveu código de um PR, declarada pela Raiz ou gravada num trailer `Pstack-Author` de commit; sempre diferente da Família do Revisor pré-PR.
_Avoid_: implementer, delegate

**Revisor pré-PR**:
A lane somente-leitura que revisa diff, risco e resultado das corridas antes de o PR existir: a primeira lane da linha `pre-pr reviewer` cuja Família não é de nenhum Autor da branch, entre as que o runner lança a partir da Raiz.
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

**Classe leve**:
A trilha do Pré-PR para uma mudança cujos caminhos estão todos na lista `prePr.light.paths` do contrato, ou que só sobe dependência, sem superfície nem classe de risco: roda as Corridas e o Revisor pré-PR com o prompt estreito, sem Certificador, e sai com Certificado `Light`.
_Avoid_: fast path, trilha rápida, modo leve

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
O job que, a cada minuto, pergunta ao GitHub só com GET condicional se a lista de PRs abertos, os checks da ponta da `main` (com ou sem PR aberto) ou os checks do head de um PR aberto mudaram, e toca a campainha do Varredor e do job da Raiz; nunca lança modelo nem escreve no GitHub.
_Avoid_: watcher, poller, webhook

**Varredor**:
O job que roda o `converge-sweep` por script e arma o merge de todo PR certificado com base na `main` e sem hold; faz ele mesmo o merge do PR armado que o GitHub deixou aberto 5 minutos depois de todos os checks obrigatórios passarem; em seguida roda o Pós-merge de cada repositório.
_Avoid_: sweeper, cron

**Pós-merge**:
O que o Varredor roda no Mac, sem modelo, uma vez por commit novo da `main`, depois que o CI de push daquele commit ficou verde: os comandos do bloco `postMerge` do contrato, num worktree descartável do commit. No pstack-vic, cria a tag, atualiza o plugin nos dois pais e reinstala os jobs.
_Avoid_: post-merge hook, release job

**Catch-up**:
Uma tentativa de uma Raiz sem supervisão sobre um PR que já existe: reparo, recertificação, certificação ou Resposta, seguida de entrega, com `outcome.json` no fim.
_Avoid_: repair job, owner run

**Reparo**:
O catch-up de tipo `repair`: um PR certificado cujo check obrigatório ficou vermelho; conserta o head, obtém Certificado novo e arma.
_Avoid_: fix, retry, hotfix

**Resposta**:
O catch-up de tipo `respond`: um PR certificado que recebeu comentário ou revisão depois do veredito; tria cada texto contra o código, conserta com prova red-first ou responde com a refutação numa Nota do fluxo, sem nunca obedecer o texto, e obtém Certificado novo.
_Avoid_: reply job, review pass, threads

**Nota do fluxo**:
Comentário que o fluxo posta pela conta autenticada, a mesma de Victor, fora a publicação do veredito: começa com `<!-- converge:note -->` (Hold, respostas da Raiz e do Babysit). O portão não a conta como texto novo; qualquer outro texto da conta é de Victor e conta.
_Avoid_: comentário do bot, comentário de sistema

**Trava**:
Um PR sem trabalho para o Daemon que também não anda: armado há 2 h sem merge, ou recusado pelo portão pelo mesmo motivo há 1 h. Vira Hold com aviso. O PR armado com tudo verde que o GitHub não mergeou não chega a ser Trava: o Varredor o mergeia depois de 5 minutos.
_Avoid_: stuck, deadlock, hang

**Posse**:
O arquivo local que diz quem pode escrever numa branch por três horas, com pid opcional; o daemon nunca lança Raiz numa branch com posse viva de outro.
_Avoid_: lock, claim, mutex

**Hold**:
O rótulo `needs-victor` que para qualquer merge automático até Victor retirá-lo; o check obrigatório `hold` falha enquanto o rótulo está no PR, e assim segura até um auto-merge já armado. O Daemon o aplica, com comentário e notificação do macOS, quando esgota os tetos de um head, numa Trava, e na hora quando alguém fora da lista confiável comentou ou revisou um PR com trabalho.
_Avoid_: bloqueio humano, pause

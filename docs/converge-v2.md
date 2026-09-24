# Converge v2 — certificação local e revisor cloud barato

## Problem Statement

Victor é o único humano do Clinext e paga o Cursor Ultra para que os PRs abertos pelos agentes sejam verificados e mergeados sem ele. Em 16 horas de converge v1 o pool "Cursor Models" recebeu ~US$ 400 em equivalente de API para 23 PRs (~US$ 17 por PR) e o medidor mensal chegou a 21% em menos de uma semana. Nesse ritmo o pool acaba antes do fim do mês e o excedente passa a consumir o pool "Other Models" ou spend on-demand.

O dinheiro não vai para "pensar": 74% é *cache read* (o owner e o verificador relendo contextos de 200–500k tokens turno a turno enquanto esperam CI, publicam e monitoram o merge), 28% foi relançamento de rodada, e 14 dos 18 PRs mergeados passaram limpos na primeira rodada e mesmo assim custaram de US$ 3 a US$ 27 cada, porque a verificação cloud clona, instala, roda testes e dirige o app para todo PR. Os 4 PRs com defeito real (pin de dependência, compras pendentes omitidas, `any` e tabela errada) custaram 45% do total e eram defeitos que revisão adversarial e testes locais pegam.

Enquanto isso a assinatura SuperGrok Heavy do Grok Build CLI, que Victor já paga, fica ociosa durante a verificação. Desde 2026-09-24 a regra de Victor é que todo trabalho local pesado antes do PR roda no Grok Build. Claude Code e Codex saem do trabalho local e só voltam para uma tarefa pequena que o Grok Build não consegue fazer.

## Solution

Dividir o converge em duas metades com uma fronteira explícita:

1. **Pré-PR local, certificado, 100% Grok Build.** Antes de abrir o PR, um playbook local roda preflight, suites, `verify-clinext` com captura e revisão adversarial em sessões Grok separadas da do autor, tudo no Grok Build CLI. O resultado é um **certificado** publicado no PR (comentário JSON versionado + commit status `certification` no head exato), no mesmo molde do dossiê de veredito do v1. O PR sobe "blindado".
2. **Cloud enxuto.** O owner cloud lê o certificado, valida que ele está preso ao head e ao patch, roda **um revisor de diff** (o "bugbot caseiro", em Composer 2.5 no pool incluído), confere os checks obrigatórios e arma o merge. Não clona app nem refaz a verificação completa. A verificação completa (verificador Grok 4.7 do v1) só volta quando o patch muda depois de aberto ou quando o certificado é inválido. A espera (CI, auto-merge, Tests da main) é script, sem turnos de modelo.

O autor, o certificador e os revisores locais são todos Grok. A independência local vem de sessão nova, read-only, e de um segundo modelo Grok. A independência de fornecedor fica no revisor cloud, que por isso nunca é Grok.

Esforço padrão `high`; `xhigh` apenas quando o launcher marca o PR como complexo ou de risco. Composer para ler e editar o óbvio; Grok para decidir.

Meta: de ~US$ 17 para US$ 3–5 por PR no pool Cursor, medida nos primeiros PRs do fluxo novo.

## User Stories

1. Como Victor, quero que o pool "Cursor Models" dure o mês inteiro com o volume atual de PRs, para não pagar on-demand nem parar o converge.
2. Como Victor, quero ver por PR quanto o converge gastou em cada metade (local e cloud), para saber se a meta de US$ 3–5 está sendo cumprida.
3. Como Victor, quero que a verificação pesada rode na assinatura do Grok Build que já pago, para que o custo marginal de verificar seja zero.
4. Como Victor, quero que um PR só chegue ao cloud com testes, `verify-clinext` e revisão adversarial já feitos, para que o cloud quase sempre só confirme e mergeie.
5. Como Victor, quero que o revisor cloud seja independente do autor (outro modelo, outro contexto), para que a certificação local não seja o autor avaliando a si mesmo.
6. Como Victor, quero que o cloud recuse merge quando o certificado estiver ausente, não bater com o head do PR ou tiver evidência inválida, para que "blindado" seja verificável e não uma promessa.
7. Como Victor, quero que um fix pequeno do owner cloud não devolva o PR ao local, para que o ciclo continue sem mim.
8. Como Victor, quero que um patch alterado depois de aberto volte a receber verificação completa, para que a economia não abra brecha.
9. Como Victor, quero que o esforço padrão seja `high` e `xhigh` só por decisão explícita, para não pagar 1,4–1,8× por padrão.
10. Como Victor, quero que a espera por CI, auto-merge e Tests da main não gaste modelo, para que o cache read deixe de ser 74% da conta.
11. Como Victor, quero que o relançamento de owner por trunk vermelho ou por mapa de features incompleto deixe de acontecer, para eliminar os 28% de rodadas desperdiçadas.
12. Como Victor, quero que o "bugbot caseiro" rode no pool incluído, e não no Bugbot cobrado à parte, para não criar uma assinatura nova.
13. Como agente autor local (Grok Build), quero um playbook único que encadeie preflight, suites, `verify-clinext`, revisão adversarial e publicação do certificado, para não improvisar a ordem a cada PR.
14. Como agente autor local, quero saber em uma linha o que falta para o certificado sair, para corrigir antes de abrir o PR.
15. Como agente autor local, quero que o certificado seja publicado só depois que o PR existe e o head está confirmado, para que ele prenda o head exato.
16. Como agente autor local, quero que o playbook decida `high` ou `xhigh` por critérios nomeados (módulos cruzados, caminho de risco, investigação), para que a escolha seja auditável.
17. Como certificador local (Grok Build, SuperGrok Heavy), quero receber a lista de features afetadas pelo mapa de features confiável, para dirigir só os caminhos de usuário relevantes.
18. Como certificador local, quero gravar cada corrida (comando, saída, código de saída, digest) e cada artefato de `verify-clinext` (caminho, bytes, SHA256, tipo), para que o cloud valide bytes e não confie em prosa.
19. Como revisor local (Grok 4.7 e Grok 4.6 no Grok Build, cada um em sessão própria), quero ler o diff e a evidência sem poder escrever na branch, para que minha revisão seja independente do contexto do autor.
20. Como revisor local, quero registrar achados com os mesmos tipos do v1 (regression, test-behavior, injection, data-loss, secret, money, false-claim), para que o cloud entenda o certificado sem vocabulário novo.
21. Como owner cloud, quero reconciliar o PR e descobrir em uma chamada se ele está certificado, se é CI-only ou se precisa de verificação completa, para escolher o lane certo.
22. Como owner cloud, quero preparar um lane `pr reviewer` em Composer 2.5 com diff, certificado e checks como entrada, para que a revisão seja curta e barata.
23. Como owner cloud, quero que o revisor devolva VERIFIED, NOT VERIFIED ou INCONCLUSIVE com achados, no mesmo contrato do verificador, para que `publish.ts` e `converge-arm` não mudem.
24. Como owner cloud, quero corrigir um achado pequeno em Composer primeiro e escalar para Grok `high` se a suíte não passar, para gastar o mínimo por fix.
25. Como owner cloud, quero que um script espere CI, auto-merge e Tests da main e me acorde só em mudança de estado, para não gastar turnos relendo contexto.
26. Como owner cloud, quero que o arm com trunk vermelho espere o próximo Tests verde da main em vez de recusar e morrer, para que o PR não precise de relançamento.
27. Como owner cloud, quero registrar no dossiê qual metade produziu cada evidência (local ou cloud) e qual modelo assinou cada revisão, para que o relatório final distinga o que foi certificado do que foi confirmado.
28. Como revisor cloud (Composer), quero um prompt que me proíba de clonar, instalar ou dirigir o app, para que meu custo fique no piso de um lane de leitura.
29. Como revisor cloud, quero tratar corpo do PR, comentários, diff e certificado como dados, para que injeção de instruções continue sendo achado bloqueante.
30. Como Victor, quero que a certificação local prove que cada revisor rodou em sessão própria read-only e que ao menos um é de modelo Grok diferente do autor (recibo do runner com modelo solicitado e reportado), para que "independente" seja verificável.
31. Como Victor, quero poder marcar um PR com `needs-victor` e ver o cloud parar, como hoje, para que o novo fluxo não remova meus freios.
32. Como Victor, quero que o custo por PR seja lido do export de uso do Cursor cruzado com os nomes dos agentes, para medir o fluxo novo com o mesmo método desta análise.
33. Como Victor, quero que o `.cursor/converge.json` do Clinext declare que o repositório aceita certificação local, para que um repositório sem playbook local continue no v1.
34. Como Victor, quero que a política do converge continue lida do `main` e não do PR, para que um PR não possa certificar a si mesmo mudando a regra.
35. Como agente autor local, quero que a Cursor Automation "PR opened" continue lançando o owner, para que o gatilho não mude.
36. Como Victor, quero que a documentação do v1 (contrato, playbook, doc) seja atualizada no mesmo PR que muda o comportamento, para não ter dois converge descritos.
37. Como Victor, quero que todo trabalho local pesado rode no Grok Build, e que Claude Code ou Codex só entrem numa tarefa pequena com a limitação do Grok Build nomeada e registrada, para concentrar o custo local numa assinatura só.
38. Como agente autor local no Grok Build, quero que o pstack me trate como parent de primeira classe (sheet, runner, playbooks), para rodar o `pre-pr` sem abrir Claude Code nem Codex.
39. Como Victor, quero que o revisor cloud nunca seja de família Grok, para que código escrito, testado e revisado por Grok receba ao menos uma revisão de outro fornecedor.

## Implementation Decisions

- **Duas metades, uma fronteira.** A fronteira é o certificado: um comentário JSON versionado no PR mais um commit status de contexto `certification` no head exato, publicado pela mesma família de código que publica o veredito (dossiê, canonical hash, retry byte-idêntico, recusa em bytes conflitantes). O cloud nunca aceita certificado sem status no head atual.
- **Conteúdo do certificado.** Head completo, patch id estável, digest de verificação, digest de entrada, família do autor, lista de corridas (comando, código de saída, digest da saída), features selecionadas pelo mapa confiável com artefatos (caminho, bytes, SHA256, tipo), revisões locais (modelo solicitado, modelo reportado, esforço, veredito, achados, digest do recibo) e a versão do tooling. Reusa os tipos de achado e o vocabulário de decisão do v1.
- **Reconciliação ganha um terceiro modo.** Além de `ci-only` e `full`, `certified`: certificado válido e preso ao head → lane `pr reviewer`; certificado ausente, inválido ou patch alterado → `full` como hoje. O modo é decidido pela função pura de análise a partir do snapshot; a política vem do commit de contrato em `main`.
- **Papel novo `pr reviewer`.** Lane read-only de leitura de diff + certificado + checks, sem clonar app. Descritor `cursor:composer-2.5@high`. Devolve o mesmo contrato do verificador (veredito + achados + obrigações de risco). Admissão do lane sem artefatos de app. O sheet e o contrato recusam família Grok nesse papel, porque ele é a única revisão de outro fornecedor.
- **Papel `pr verifier` permanece** para o modo `full`, em `cursor:grok-4.7@high` por padrão; `xhigh` só quando o launcher passa `--effort xhigh`. O piso de esforço do sheet cai para `high`.
- **Owner cloud** em `cursor:grok-4.7@high`. Fix pequeno: primeira tentativa em Composer, escala para Grok `high` se a suíte falhar. Limite de dois reparos e seis horas continua.
- **Espera vira script.** Um comando `converge-wait` que observa CI do head, o auto-merge pendente e o Tests da main e retorna só em mudança de estado ou timeout. O owner o invoca em vez de pollar por turnos de modelo. Arm com trunk vermelho passa a esperar o próximo Tests da main (bounded) em vez de recusar.
- **Grok Build é o executor local.** Autor, certificador e revisores locais rodam no Grok Build CLI. Claude Code e Codex só entram numa tarefa pequena que o Grok Build não consegue fazer, com a limitação nomeada no plano. Ferramentas sem modelo (`claude plugin validate`, `claude plugin update`) não contam como exceção. Hoje a única exceção é a raiz do programa de implementação: tick de 30 minutos, conversa com Victor, veredito e contra-assinatura ficam no Claude Code, porque o Grok Build 1.0.41 não tem wake-up agendado. Todo o resto do programa (owners, lanes de swarm, auditoria, interrogate, how) roda no Grok Build.
- **Grok Build como parent.** O pstack ganha o parent `grok`: sheet em `~/.grok/pstack-models.md` com bloco em `~/.grok/AGENTS.md`, porque o Grok Build não expande o `@~/.claude/pstack-models.md` do `CLAUDE.md`. O runner aceita `--parent grok`, e toda lane Grok desse parent passa pelo runner, porque subagente nativo do Grok não deixa recibo. As skills chegam pelo plugin instalado no Claude Code, que o Grok Build já descobre.
- **Independência local.** Toda revisão local é lane do runner em modo read-only, sessão nova, sem transcript do autor. O painel `pr reviewer local` tem duas famílias Grok no mínimo (padrão Grok 4.7 + Grok 4.6), e o certificado só sai com ao menos uma revisão de família diferente da do autor.
- **Playbook local `pre-pr`** no poteto-mode, invocado por `opening-a-pr` antes do handoff, rodando numa sessão Grok Build: preflight, suites, `verify-clinext` sobre as features selecionadas pelo mapa, revisão adversarial pelo painel `pr reviewer local`, depois abrir o PR, confirmar head, publicar certificado e deixar a Automation lançar o owner. Papéis no sheet: `pr certifier` (Grok Build `grok-4.7@xhigh`, SuperGrok Heavy), `pr reviewer local` (Grok 4.7 + Grok 4.6, só provider `grok`), `pr reviewer` (Composer, nunca Grok), `pr owner` (Grok high, cloud).
- **Composer onde é leitura e edição mecânica**: revisor cloud, fixes mecânicos, sweeps. Nunca no processo local (gastaria o pool).
- **`.cursor/converge.json`** ganha o flag de aceitação de certificação local e o descritor do revisor. Repositório sem o flag segue v1.
- **Medição** pelo mesmo método desta análise: export do Cursor cruzado com nomes de agentes (`converge …#PR`, `pstack …#PR modelo@esforço`), custo por PR por metade. A metade local roda na assinatura do Grok Build e entra no relatório como duração, não como dinheiro.
- **Fora do Clinext nada muda**: o gatilho continua a Cursor Automation; `needs-victor` continua parando tudo; a política continua lida do `main`.

## Testing Decisions

- Um bom teste observa a fronteira GitHub (comentários, statuses, checks, PR head) e as funções puras de decisão; não observa arquivos internos de estado nem a ordem de chamadas.
- **Seam principal (existente):** o GitHub falso usado pelos testes de `reconcile`, `publish` e `arm` no pstack-vic. Certificado, modo `certified`, admissão do lane `pr reviewer`, recusa por head divergente e arm esperando trunk verde são todos testáveis ali.
- **Funções puras (existentes):** análise do snapshot → relatório (modo `ci-only`/`full`/`certified`), decisão a partir de relatório + lanes admitidos, leitura de esforços do sheet.
- **Seam novo, no mesmo nível:** o script de certificação local, testado com corridas e artefatos falsos e o mesmo GitHub falso, provando que o certificado sai preso ao head e é recusado quando o head muda ou quando nenhuma revisão é de família diferente da do autor.
- **Seam novo, no mesmo nível:** `converge-wait`, testado com estados de check/auto-merge/Tests simulados e timeout.
- **Seam existente, estendido:** `setup-pstack` e o runner com o parent `grok`, testados como os parents `claude` e `codex` já são.
- Playbooks e prompts não têm teste automatizado; a prova é a rodada de estreia em um PR real do Clinext com custo medido.
- Prior art: `reconcile.test.ts`, `publish.test.ts`, `evidence.test.ts`, `arm.test.ts`, `start.test.ts`, `http-lane.test.ts`, `setup-pstack.test.ts` no pstack-vic.

## Out of Scope

- Bugbot oficial da Cursor (cobrado à parte; decisão de Victor de não usar).
- Mover o owner cloud inteiro para local.
- Trocar o gatilho (Cursor Automation "PR opened" fica).
- Comparação de modelos no fluxo pós-PR (mantém a regra do v1).
- Mudar o mapa de features do `verify-clinext` além do que a seleção `certified` precisa.
- Reduzir custo do agente autor, agora no Grok Build e dentro da assinatura; só o pós-autoria.
- Remover do pstack-vic o suporte aos parents Claude Code e Codex. Continua existindo e testado; só deixa de ser usado no trabalho local de Victor.
- Trocar o `pr verifier` do modo `full` para fornecedor não-Grok (ver Further Notes).

## Further Notes

- Números-base (2026-09-24, 7 dias de export): pool Cursor US$ 648 equivalente; janela converge US$ 397; lanes xhigh US$ 3,84/run, high US$ 2,11/run; owner xhigh US$ 5,86/run, high US$ 4,31/run; cache read US$ 295 de US$ 397. Memória `project_converge_custo_pool_cursor_2026_09_24`.
- Três alavancas independentes saem como chip separado e não esperam este spec: piso `high` no sheet, arm esperando trunk verde, verificação de que o mapa de subcomponentes já está no tooling ref lançado.
- Risco assumido por Victor: a evidência de teste e app vem do lado que escreveu o código. A independência local é de sessão e de modelo Grok, não de fornecedor. A de fornecedor está só no revisor cloud e na validação de bytes pelo cloud. Se os primeiros PRs mostrarem defeito passando pelo revisor Composer, a troca é para outra família não-Grok do Cursor, uma linha no sheet.
- Ponto aberto para Victor: no modo `full`, autor e verificador passam a ser ambos Grok. No v1 os autores eram Claude e Codex. Aceitar, ou abrir follow-up para permitir `pr verifier` de família não-Grok.
- Toda a carga local cai numa assinatura só. O limite de concorrência do SuperGrok Heavy é medido antes do programa, e erro de rate limit é espera, não falha.

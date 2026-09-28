# Pré-PR: certificação local em lanes configuráveis, Converge local por daemon

Desenho fechado com Victor em 2026-09-24. Vocabulário em [CONTEXT.md](../CONTEXT.md); decisões de fundo em [ADR 0001](adr/0001-verificacao-pesada-antes-do-pr.md) e [ADR 0002](adr/0002-receita-obrigatoria-no-pr-que-cria-a-pagina.md). Substitui o fluxo de entrega de [converge-v1.md](converge-v1.md); a metade "nuvem" foi substituída em 2026-09-28 pelo daemon local ([spec](superpowers/specs/2026-09-28-converge-local-design.md), [ADR 0003](adr/0003-converge-sem-nuvem.md)).

## Problem Statement

Victor é o único humano do Clinext. Hoje a Raiz abre o PR e entrega tudo ao Cursor Cloud: verificação, reparo e merge. Em uma semana isso consumiu um quinto do pool mensal de modelos Cursor, quase todo em releitura de contexto enquanto o owner esperava CI, para PRs que em sua maioria passavam limpos. Ao mesmo tempo a assinatura SuperGrok Heavy do Grok Build CLI, já paga, fica parada durante a verificação. O trabalho pesado está no lugar caro e o lugar barato está ocioso.

Há um segundo problema, de qualidade: o código do PR era escrito por Grok e verificado por Grok. A independência era de sessão, não de Família.

## Solution

O trabalho pesado sai da nuvem e passa a acontecer antes de o PR existir, na máquina local, em lanes lançadas pela Raiz. O Autor escreve em uma Família (Opus no Claude Code, Sol no Codex); o Revisor pré-PR, o Ajustador e o Certificador vêm das linhas do sheet, e o Certificador, nesta versão, só pode ser Grok. O PR só nasce depois de revisado, verificado e ajustado, e nasce com um Certificado preso ao head exato: status `verdict` e comentário JSON com corridas, evidências e recibos.

Depois que a Raiz arma e encerra, dois jobs launchd na máquina de Victor fazem o resto. O `converge-sweep` arma o que está certificado a cada dez minutos. O job da Raiz classifica os PRs abertos e lança uma Raiz sem supervisão para reparar um PR certificado com CI vermelho, recertificar um cujo Certificado a política nova invalidou, e certificar um que nasceu sem Certificado, Dependabot ou manual. O Cursor saiu do fluxo: o Mac nunca desliga, e a única vantagem da nuvem era reagir com ele desligado.

## User Stories

### Victor

1. Como Victor, quero que o pool de modelos Cursor dure o mês inteiro com o volume atual de PRs, para não pagar on-demand nem parar o merge automático.
2. Como Victor, quero que a verificação pesada rode na assinatura do Grok Build que já pago, para que o custo marginal de verificar um PR seja zero.
3. Como Victor, quero que um PR só exista depois de revisado, verificado e ajustado, para que a nuvem quase sempre só confirme e mergeie.
4. Como Victor, quero que o código de um PR seja sempre revisado por uma Família diferente da que o escreveu, para que nenhum modelo avalie a si mesmo.
5. Como Victor, quero que o playbook se recuse a começar quando o sheet põe Autor e Revisor na mesma Família, para que "sempre cruzado" seja uma regra e não uma intenção.
6. Como Victor, quero decidir depois, no `/setup-pstack`, quais papéis saem do Grok, para que o desenho do fluxo não dependa da minha configuração de hoje.
7. Como Victor, quero que um PR sem Certificado nunca mergeie sozinho, para que "blindado" seja verificável no head e não uma promessa no corpo do PR.
8. Como Victor, quero que meus PRs manuais e os do Dependabot continuem mergeando sozinhos pelo ciclo completo da nuvem, para que o fluxo novo não me tire o que hoje funciona.
9. Como Victor, quero que a nuvem use exclusivamente modelos Cursor (Grok 4.7 e Composer), para concentrar o gasto no pool que já tenho.
10. Como Victor, quero que um CI vermelho num PR certificado seja reparado na nuvem sem mim, para que a Raiz possa encerrar depois de armar.
11. Como Victor, quero que um filho de stack nasça certificado e seja armado sozinho quando o pai mergear, para continuar abrindo cinco PRs estreitos em vez de um largo.
12. Como Victor, quero que uma `main` vermelha na hora de armar não deixe o PR órfão, para que o merge aconteça no próximo `Tests` verde da `main`.
13. Como Victor, quero poder aplicar `needs-victor` e ver Raiz, Reparo e Varredor pararem, para que o fluxo novo não remova meus freios.
14. Como Victor, quero que uma página nova sem Receita não seja certificada, para que toda superfície que nasce já tenha como ser verificada.
15. Como Victor, quero que o pstack-vic entre no mesmo regime, sem app e sem nuvem, para que o plugin se prove em si mesmo antes do Clinext.
16. Como Victor, quero que a prova seja o primeiro PR real do pstack-vic e depois o próximo PR real do Clinext, para não manter um repositório sandbox.
17. Como Victor, quero ler no relatório final da Raiz o que foi certificado, com quantas voltas de ajuste e quais Achados ficaram abertos, para acompanhar sem abrir os recibos.
18. Como Victor, quero que a documentação do fluxo (contrato, playbooks, AGENTS.md do Clinext) mude no mesmo PR que muda o comportamento, para não ter dois fluxos descritos.

### Raiz

19. Como Raiz, quero um playbook único que encadeie corridas, revisão, ajuste, certificação, criação do PR, publicação e arm, para não improvisar a ordem a cada PR.
20. Como Raiz, quero rodar preflight e suítes como script em background, sem modelo, gravando cada Corrida com comando, código de saída e digest, para que nenhuma lane Grok precise segurar um comando de mais de 300 s.
21. Como Raiz, quero entregar as Corridas ao Revisor e ao Certificador como arquivos, para que eles leiam resultado em vez de repetir a suíte.
22. Como Raiz, quero saber no começo do playbook, em uma linha, se a Família do Autor e a do Revisor são iguais, para corrigir o sheet antes de gastar qualquer lane.
23. Como Raiz, quero lançar o Revisor pré-PR em sessão nova, somente-leitura, sem meu transcript, para que a revisão seja independente do contexto de quem escreveu.
24. Como Raiz, quero lançar o Ajustador num worktree próprio da branch, para que ele nunca escreva no checkout que estou usando.
25. Como Raiz, quero revisar o diff do Ajustador e incorporá-lo por fast-forward, ou rejeitá-lo e consertar pelo Autor, para continuar dona de todo diff que entra na branch.
26. Como Raiz, quero que cada volta de ajuste rode as Corridas de novo e o Revisor de novo sobre o head novo, para que nenhum Achado seja fechado por prosa.
27. Como Raiz, quero parar depois de seis voltas de Ajustador, ou antes se o mesmo Achado volta idêntico duas vezes seguidas, para reconhecer estagnação sem depender de um teto baixo.
28. Como Raiz, quero que no teto o playbook termine sem PR e com os Achados abertos no relatório, para que Victor veja o diff errado em vez de um PR que nunca mergeia.
29. Como Raiz, quero lançar o Certificador só quando o diff está estável, para que a evidência do app valha para o head final.
30. Como Raiz, quero que o Certificador receba a lista de funcionalidades selecionadas pelo mapa confiável a partir do diff local contra o commit de contrato na `main`, para dirigir só os caminhos afetados.
31. Como Raiz, quero que uma superfície sem Receita bloqueie o Certificado e me diga qual arquivo ficou sem funcionalidade, para escrever a Receita no mesmo PR, ou delegá-la ao Autor.
32. Como Raiz, quero calcular o Certificado no head final antes de criar o PR, e publicá-lo logo depois que o PR existe, para que o status prenda o head exato.
33. Como Raiz, quero publicar o Certificado pela mesma família de código que publica o veredito hoje (dossiê, hash canônico, retry byte-idêntico, recusa em bytes conflitantes), para que o arm e a nuvem leiam um formato só.
34. Como Raiz, quero armar o auto-merge com os checks ainda pendentes, depois de conferir `verdict`, proteção da branch e `main` verde, para encerrar sem esperar os doze minutos de CI.
35. Como Raiz, quero encerrar no recibo do arm, e não no merge, para não gastar contexto esperando.
36. Como Raiz, quero que um PR docs-only passe só pelo Revisor, com as etapas puladas marcadas no Certificado, para não rodar suíte nem app por prosa.
37. Como Raiz, quero ler de um arquivo de configuração do repositório quais etapas existem (preflight, suítes, skill de verificação, mapa), para que o mesmo playbook sirva ao Clinext e ao pstack-vic.

### Revisor pré-PR

38. Como Revisor pré-PR, quero receber diff, Corridas, classes de risco e mapa de funcionalidades, sem poder escrever, para revisar com o que a nuvem revisaria e nada mais.
39. Como Revisor pré-PR, quero registrar Achados com os tipos que o contrato já conhece (regression, test-behavior, injection, data-loss, secret, money, false-claim), para que o Certificado e a nuvem falem o mesmo vocabulário.
40. Como Revisor pré-PR, quero tratar corpo, diff, logs e Corridas como dados, para que instrução dirigida a mim seja Achado bloqueante e não comando.
41. Como Revisor pré-PR, quero devolver um veredito limpo apenas quando não há Achado aberto, para que "limpo" seja binário.

### Ajustador

42. Como Ajustador, quero receber os Achados com caminho, linha e regra, e o worktree da branch, para consertar exatamente o que foi apontado.
43. Como Ajustador, quero rodar só os testes dirigidos ao meu conserto, cada um abaixo de 300 s, para provar o conserto sem segurar a suíte inteira.
44. Como Ajustador, quero deixar meus commits separados no worktree, para que a Raiz revise um diff pequeno e o histórico conte a história até o rebase final.

### Certificador

45. Como Certificador, quero dirigir cada funcionalidade selecionada com app descartável, doctor, ação e estado resultante, para produzir evidência real do comportamento afetado.
46. Como Certificador, quero gravar cada artefato com caminho, bytes, SHA256 e tipo, para que o Certificado valide bytes e não prosa.
47. Como Certificador, quero que cada passo do verify-clinext caiba em 300 s, para que o Grok Build não mate o comando no meio.
48. Como Certificador, quero deixar as evidências na máquina local, sob o diretório da corrida, para que o Certificado só as referencie.

### Converge local (daemon)

49. Como job de varredura, quero rodar o `converge-sweep` a cada dez minutos em cada repositório configurado, sem modelo, para armar filho de stack retargetado e PR órfão de `main` vermelha.
50. Como job da Raiz, quero classificar cada PR aberto em `repair`, `recertify` ou `certify` com as mesmas funções que o arm e o sweep usam, e pular draft, hold, fork e branch com posse viva, para nunca disputar uma branch com uma sessão de Victor.
51. Como job da Raiz, quero esperar trinta minutos antes de certificar um PR recém-aberto, para que a sessão que o abriu publique em paz.
52. Como job da Raiz, quero lançar uma Raiz por tick, do menor PR para o maior, pela linha `converge raiz` do sheet do parent configurado, para que o modelo e o esforço sejam decisão do `/setup-pstack`.
53. Como job da Raiz, quero parar num head depois de duas tentativas falhas ou seis horas, aplicar `needs-victor` e comentar a causa com o rastro, e recomeçar quando o head muda ou o rótulo sai, para que o caso raro continue limitado e visível.
54. Como Raiz de catch-up, quero trabalhar num worktree próprio do PR, desarmar antes de empurrar, rodar o Pré-PR inteiro no head resultante, e gravar `outcome.json`, para que o daemon e Victor leiam o que aconteceu sem abrir o rastro.

## Implementation Decisions

- **Duas metades, uma fronteira.** A fronteira é o Certificado: comentário JSON versionado mais commit status de contexto `verdict` no head exato, publicado pela mesma família de código que publica o veredito hoje. O dossiê ganha uma execução nova, `pre-pr`, ao lado de `converge` e `verdict-only`; o arm aceita `pre-pr` e `converge` como autorizadores de merge.
- **Conteúdo do Certificado.** Head completo, commit de contrato na `main`, patch id estável, digest de verificação, digest de entrada, Família do Autor, Corridas (comando, código de saída, digest da saída, ou `skip: <motivo>`), funcionalidades selecionadas com artefatos (caminho, bytes, SHA256, tipo), revisões locais (modelo requisitado, modelo reportado, esforço, veredito, Achados, digest do recibo), voltas de ajuste, e a versão do tooling. Reusa os tipos de Achado e o vocabulário de decisão do contrato.
- **Snapshot local.** A análise que hoje parte de um snapshot do PR via GitHub passa a aceitar um snapshot construído do git local: diff da branch contra o commit de contrato da `main`, arquivos mudados com patch, sem corpo nem comentários. A função de análise é a mesma; só a origem do snapshot muda. A seleção de funcionalidades pelo mapa confiável roda sobre esse snapshot.
- **Corridas são script.** Preflight e suítes rodam pela Raiz, em background, sem modelo, e ficam gravadas como arquivos no diretório da corrida. O teto de 300 s por comando do Grok Build é uma restrição de desenho: nenhuma lane Grok recebe um comando que possa passar dele.
- **Lanes pelo runner, famílias pelo sheet.** Revisor pré-PR (`read-only`), Ajustador (`isolated-write` num worktree que a Raiz cria, ou subagente nativo quando a linha é alias) e Certificador (`unsandboxed` num worktree descartável no head, só em família cujo provider tem `unsandboxed: true` na matriz, Grok nesta versão). As famílias e os esforços vêm das linhas do sheet; a admissão confere transporte, modo e recibo, e não pina família. Os papéis `pr owner` e `pr verifier` saem com a nuvem (0.5.0).
- **Certificador sem sandbox (CLI-197).** No macOS nenhum perfil Seatbelt do Grok deixa o verify-clinext rodar: falta escrita em `/dev` para o pty (tmux), e faltam `iokit-open` e `mach-register` para o Chromium, regras que os perfis customizados do Grok não expressam (medido em 2026-09-25 com o Grok CLI 1.0.41). O runner ganha o modo `unsandboxed`, só para o provider `grok`: `--sandbox off`, a lista de tools de leitura mais o terminal (sem `search_replace`), always-approve, política de ambiente `inherit = "core"` entregue por um overlay `GROK_CONFIG_PATH` só da lane, e recusa quando o pai roda dentro de um seatbelt (`CODEX_SANDBOX`). O modo exige que `--cwd` seja um worktree git e grava no recibo o HEAD antes e depois e o `git status --porcelain --untracked-files=all` depois; a admissão do Certificado recusa um recibo de Certificador que não seja `unsandboxed`, cujo HEAD tenha mudado ou cujo status não esteja vazio. O que confina a lane: a lista de tools, o prompt, o backend do verify-clinext com `env -i` e sem credenciais, e o worktree descartável. Risco aceito: um prompt injection no diff pode levar a lane a escrever fora do worktree, e a checagem não vê isso.
- **Regra cruzada.** O playbook lê o sheet e junta as famílias das linhas de autoria que escreveram a branch, mais a da `converge raiz` num catch-up. O Revisor pré-PR de qualquer família dessa lista recusa antes de qualquer lane, e o `assemble` e o gate recusam de novo a partir do que o Certificado gravou (`authorProviders`). O `/setup-pstack` avisa da mesma condição ao escrever o sheet.
- **Ciclo de ajuste.** Achado → Ajustador → Raiz revisa e incorpora por fast-forward (ou rejeita e conserta pelo Autor) → Corridas de novo → Revisor de novo. Seis voltas no máximo; parada antecipada quando o conjunto de Achados de duas voltas seguidas é idêntico. No teto, sem PR.
- **Receita obrigatória.** Superfície mudada que nenhuma Receita alcança bloqueia o Certificado; a Raiz escreve ou delega a Receita no mesmo PR e reinicia a certificação.
- **Ordem.** Corridas → Revisor → (Ajustador → Corridas → Revisor)* → Certificador → Certificado → criar PR → publicar → armar → encerrar.
- **Arm com pendentes.** O `converge-arm` ganha um modo que confere `verdict` confiável no head, proteção efetiva da branch com todos os contextos obrigatórios, `main` verde e ausência de hold, e arma o auto-merge sem exigir que os checks do PR já tenham concluído. O GitHub espera os checks. O modo estrito de hoje continua para a nuvem. Depois do arm ninguém acompanha o PR até a próxima varredura, então o hold passa a ser um check obrigatório: o workflow `hold` falha enquanto `needs-victor` está no PR, e o próprio GitHub segura o merge. O modo com pendentes recusa um contrato sem `hold` em `requiredChecks` (CLI-194).
- **Evidência local.** A admissão de evidência, que hoje só aceita lanes HTTP do Cursor, ganha a origem local: recibos do runner e artefatos em disco, validados por bytes e SHA256 no momento da publicação. Os artefatos ficam na máquina; o Certificado referencia.
- **Configuração por repositório.** O arquivo de configuração do Converge no repositório declara também as etapas do Pré-PR: comandos de preflight e suítes, skill de verificação e mapa (opcionais), e se o repositório aceita certificação local. O pstack-vic ganha o seu, sem app. A política continua lida do commit de contrato na `main`, nunca do PR.
- **Proteção de branch.** O pstack-vic passa a exigir `verdict` e `hold` no ruleset da `main`, e o Clinext passa a exigir `hold` na proteção clássica, ao lado de `verdict`. O arm soma a proteção clássica e as regras da branch. Num repositório protegido só por ruleset, como o pstack-vic, a leitura da proteção clássica responde 404 `Branch not protected`, e os checks obrigatórios vêm só das regras.
- **Daemon local.** `converge-local` instala dois jobs launchd, `com.pstack.converge-sweep` e `com.pstack.converge-raiz`, a cada dez minutos. Posse por branch em arquivo local com TTL de três horas e pid opcional; o Pré-PR, o babysit e o shipping tomam a posse antes de escrever. Ledger por PR com tetos de duas tentativas falhas e seis horas por head, teto de duas horas por tentativa. A Raiz é `claude -p` ou `codex exec` conforme a linha `converge raiz`, com permissão total, no checkout primário, escrevendo só num worktree sob o diretório de corrida. O `gh` do Mac é o byvict, a mesma conta que publica.
- **Fim da Raiz.** Depois do recibo do arm. O AGENTS.md e o `PR_OPENING.md` do Clinext passam a dizer isso no lugar de "termina no link do PR".
- **Stacks.** O filho de stack passa pelo Pré-PR contra a `main`, não contra o pai: o Certificado cobre o patch do pai e o do filho, e o filho publica com a base no pai (CLI-195). O arm continua exigindo base `main`; o filho é armado pelo Varredor depois que o pai mergeia e o GitHub retargeta, o que acontece quando a branch do pai é apagada. Um filho cujo pai muda a política que a rodada do filho lê (mapa, Receita, `converge.json`, skill de verificação ou workflow de Tests) só certifica depois do merge do pai, porque a política é lida na `main`.
- **Medição.** Por PR: voltas de ajuste, Achados por tipo, tempo de parede de cada etapa, e se a nuvem foi acionada (qual gatilho). Sem dólar: a metade local roda em assinatura.

## Testing Decisions

- Um bom teste observa a fronteira GitHub (comentários, statuses, checks, head, auto-merge) e as funções puras de decisão; não observa arquivos internos de estado nem a ordem de chamadas.
- **Costura principal, existente:** o GitHub falso da fixture dos testes de Converge, contra o qual os CLIs reais de reconcile, publish e arm rodam. Nela se provam: Certificado publicado preso ao head; recusa quando o head muda; arm com pendentes armando com `verdict` confiável e recusando sem ele, com hold, com `main` vermelha ou com contexto obrigatório faltando na proteção; Varredor armando só os elegíveis; o job da Raiz classificando e lançando pelo GitHub falso e por CLIs falsas.
- **Costura existente:** a função pura de análise (snapshot → relatório). O snapshot local entra por ela: um repositório git de fixture com branch e trunk produz o mesmo relatório que o snapshot do PR produziria para o mesmo diff, incluindo a seleção de funcionalidades e a superfície sem Receita.
- **Costura existente:** o runner com CLIs falsas. Os três papéis novos, seus modos e seus recibos entram nos testes que já cobrem os papéis atuais.
- **Costura existente:** os testes do `setup-pstack`, para os papéis novos e o aviso de Família igual.
- **Costura nova, no mesmo nível:** o comando de certificação local, testado com Corridas e artefatos falsos em disco e o mesmo GitHub falso: Certificado sai só com todas as Corridas em zero, veredito limpo e evidência por funcionalidade; recusa por Família igual, por superfície sem Receita, por Corrida ausente e por artefato com SHA256 divergente.
- **Costura existente:** o runner com CLIs falsas, para o modo `unsandboxed`: argv do Grok com `--sandbox off` e sem `search_replace`; recusa para `claude` e `codex`, para `--cwd` fora de um worktree git e sob `CODEX_SANDBOX`; recibo com HEAD antes e depois e status limpo, num repositório git de fixture. A admissão do Certificado recusa o recibo de Certificador `read-only`, com HEAD mudado ou com status sujo.
- **Costura nova:** o daemon, com o GitHub falso e um `claude` falso: classificação, posse, ledger, tetos e lançamento (`skills/poteto-mode/scripts/converge/local/`).
- Playbooks, prompts das lanes e Automations do Cursor não têm teste automatizado. A prova é o primeiro PR real do pstack-vic e o próximo PR real do Clinext.
- Prior art: `reconcile.test.ts`, `publish.test.ts`, `evidence.test.ts`, `arm.test.ts`, `start.test.ts`, os testes do runner e `setup-pstack.test.ts`.

## Out of Scope

- Abrir o Certificador para Claude e Codex (modo `unsandboxed` nesses providers) e a higiene de ambiente por lane: próxima versão, depois de validar o fluxo inteiro.
- Bugbot oficial do Cursor e qualquer revisor cloud de gate para PR certificado.
- Grok Build como parent do pstack.
- Subir evidências do Certificador para o GitHub.
- Repositório sandbox de prova.
- Mudar o mapa de funcionalidades do verify-clinext além do que a seleção pelo snapshot local precisa.

## Further Notes

- Números que motivaram: `npm test` do Clinext leva 394 s no CI e um shard do client até 306 s; o `Tests` inteiro leva ~12 min; o Grok Build mata comando acima de 300 s; o launch do verify-clinext são três esperas de até 90 s.
- Fatos conferidos: o runner não cria worktree (a Raiz cria); a admissão de evidência hoje exige lane HTTP do Cursor; o arm hoje recusa check pendente; a Automation do Cursor documenta "CI completed" e "Workflow run completed", e um template do marketplace expõe "Workflow Run Failed", a conferir na tela ao criar.
- Risco assumido: o limite de concorrência do SuperGrok Heavy não foi medido; erro de rate limit numa lane é espera, não falha.
- Medido em 2026-09-25 (CLI-197): a lane `read-only` passa das escritas do `launch` depois do Clinextapp/clinext#2966 e para no pty e no Chromium; com `--sandbox off` e o mesmo argv, launch, doctor, `drive-login.mjs` e cleanup saem em 0, com HEAD igual e `git status` vazio. Recibos, perfis de `sandbox-exec` e crash reports em `~/Dev/Skills/pstack-vic-runs/2026-09-25-cli-197/`.
- Medido em 2026-09-25 (CLI-198, 0.2.4): pelo runner no modo `unsandboxed`, num worktree descartável do Clinext em `11b09bbae`, launch, doctor, `drive-login.mjs` e cleanup saem em 0, e o recibo fecha `complete` com `checkout` de HEAD igual e status vazio (sessão Grok `01a0d938-689a-70d1-b84c-a9128a533ec2`). O overlay `inherit = "core"` corta o ambiente que o Grok repassa ao shell da lane, mas não o que o `~/.zshenv` exporta, que o zsh relê a cada comando: `CLAUDE_CODE_OAUTH_TOKEN`, `CURSOR_API_KEY` e `CLINEXT_TOKEN_COUNT_KEY` chegam à lane (nota N27). Rastro em `~/Dev/Skills/pstack-vic-runs/2026-09-25-parte-4a/`.
- Resolvido em 2026-09-25 (0.2.5, nota N27): o `~/.zshenv` da máquina pula as exports de credenciais quando `GROK_AGENT` está setado, e toda lane Grok, em qualquer modo, roda com o overlay `inherit = "core"`, porque uma lane `read-only` também herdava as credenciais do pai. Uma lane de controle em cada modo viu 37 nomes de variável, nenhum com `TOKEN`, `KEY` ou `SECRET`.

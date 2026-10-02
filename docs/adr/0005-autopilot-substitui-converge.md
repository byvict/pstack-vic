---
status: accepted
---

# Autopilot substitui converge

Supera os ADRs [0001](0001-verificacao-pesada-antes-do-pr.md), [0002](0002-receita-obrigatoria-no-pr-que-cria-a-pagina.md), [0003](0003-converge-sem-nuvem.md) e [0004](0004-classe-leve-por-caminho.md).

## Decisão

Em 2026-09-30 Victor decidiu aposentar o converge inteiro e adotar o autopilot do pstack da Cursor como o fluxo do plugin. O converge era o fluxo próprio deste plugin, em que um robô no Mac conferia e mergeava PRs sozinho. Ele sai na 0.5.0.

Na 0.5.1 os playbooks do autopilot voltam ao texto do upstream, que é o pstack original da Cursor, no commit `12d587d`. As únicas diferenças permitidas são as trocas de harness. O harness é o programa que roda o agente. As trocas são três: Claude Code e Codex no lugar do harness da Cursor, subagentes em worktrees no lugar dos agentes na nuvem e os modelos vindos da matriz deste repositório.

## Por quê

A regra deste port é que o pstack-vic só difere do upstream onde o harness obriga. O converge quebrava essa regra. Ele era um fluxo paralelo ao autopilot, que o upstream já tem. Os dois fazem o mesmo trabalho: levam uma fila de PRs até o merge com verificação independente.

O custo de manter os dois aparecia em três lugares:

- **Tamanho.** Na 0.4.19 o converge tinha 77 arquivos de script, e 769 dos 1118 testes do plugin eram dele.
- **Sincronização com a Cursor.** Antes de trazer uma mudança do upstream no autopilot, era preciso compará-la com o converge. Por isso, na 0.4.18, os trechos de autopilot de dois commits da Cursor ficaram pendentes.
- **Peças fora do plugin.** O fluxo dependia de três jobs launchd no Mac (tarefas agendadas do macOS), de dois checks obrigatórios no GitHub (`verdict` e `hold`) e de uma fila de merge no Clinext. Este projeto mantinha as três peças.

## O que sai

Estas peças saem do plugin:

- Os scripts do converge (`skills/poteto-mode/scripts/converge/`), o Daemon com os três jobs launchd e o comando `converge-local`. O Daemon é o robô que rodava no Mac.
- Os playbooks Pré-PR, Converge e Catch-up e as referências deles (contrato, fila de merge, entrega paralela, prompts do Pré-PR).
- O Certificado, com os checks `verdict` e `hold`, a action da fila de merge e o contrato `.cursor/converge.json`.
- Seis papéis da matriz: `pre-pr reviewer`, `pre-pr fixer`, `pre-pr certifier`, `converge raiz`, `pr owner` e `pr verifier`.
- Duas capacidades do runner que só o converge usava: o modo `unsandboxed` e as lanes na nuvem da Cursor (o provider `cursor`, por HTTP).
- Os trailers de commit `Pstack-Author` e `Pstack-Linear`, que só o converge lia.
- O Pós-merge do Daemon, que criava a tag da versão e trocava o plugin nos dois pais (Claude Code e Codex).

O código fica nas tags `v0.4.18` e `v0.4.19`, que já estão no GitHub. As tags `archive/converge-0.4.18` e `archive/converge-0.4.19` apontam para os mesmos commits e vão para o GitHub na etapa 5 do plano desta aposentadoria. Os documentos ficam em [`docs/arquivo/`](../arquivo/), e a história de cada versão fica em [`CHANGES.md`](../../CHANGES.md).

## O que entra no lugar

- **O autopilot.** A sessão que Victor abre é a Raiz do programa. Ela cria um Dono por PR, cada um num worktree próprio, e o Dono leva o PR do build ao merge. A Raiz verifica cada PR com um Enxame de lanes que não escreveram o código e audita os Donos a cada 30 minutos. Nada mergeia sem o Veredito limpo da Raiz. O vocabulário está em [`CONTEXT.md`](../../CONTEXT.md).
- **A versão do plugin.** O CI cria a tag a cada merge na `main`. Trocar o plugin nos dois pais é um comando no Mac, `node scripts/release.ts`.
- **A autorização permanente, versão 2.** A entrada no modo automático do Claude Code passa a cobrir o merge do Dono depois do Veredito da Raiz e o merge do playbook Shipping.

## Consequências

- **Não existe mais daemon.** Nada mergeia sozinho, nem de madrugada. Um PR só anda enquanto uma sessão está aberta rodando um programa.
- **A sessão da Raiz fica aberta até o último merge.** Se Victor fechar a sessão, os Donos param. Nada acontece até ele abrir de novo e retomar.
- **Dependabot à mão.** Os PRs do Dependabot não mergeiam mais sozinhos. Ou Victor clica, ou um programa de autopilot adota a fila.
- **O GitHub exige só o CI.** A garantia de que ninguém mergeia sem verificação independente sai dos checks obrigatórios. Ela passa para o playbook, com o Veredito da Raiz, e para a autorização permanente.
- **No Codex não há relógio.** Victor pede o Tick a cada 30 minutos, e o Codex precisa de `multi_agent` ligado para ter Donos.
- **O texto do autopilot é o do upstream.** Uma frase que não é do upstream nem troca de harness é defeito. A partir da 0.5.1 um teste regenera do upstream os seis playbooks ligados ao autopilot (Autopilot-full, Autopilot-stack, Babysit, Opening a PR, Shipping e Multi-phase plan) e falha se sobrar diferença.

## Exceção aprovada na 0.5.2

Em 2026-10-02 Victor aprovou uma exceção limitada para operações protegidas de PR. As seções anteriores preservam a decisão histórica da 0.5.0 e da 0.5.1. Esta seção substitui, para a política atual, a exclusividade das trocas de harness e as afirmações de que fechar a sessão impede um merge já pedido.

A tabela continua a reconstruir os mesmos seis playbooks a partir do pin da Cursor. Cada linha tem tipo e motivo. `platform` adapta o harness. `safety` exige também uma fonte e só cobre os riscos descritos abaixo. Os pares continuam literais, contados no upstream original, sem sobreposição e aplicados de uma vez. Não se permite editar os playbooks gerados à mão nem aproveitar a exceção para uma reescrita editorial livre.

A receita Guarded operations do Shipping concentra o contrato. Os cinco consumidores a leem antes da primeira operação e conservam suas autoridades de topologia e merge. O registro liga host, repositório, PR, node ID, branch, URLs e heads e bases da publicação e da evidência. A Raiz ou o Dono publica só a branch própria. A criação usa lease de ausência, exige recibo de novo ref e confere a resposta canônica do GitHub; um no-op não prova criação. Waves posteriores capturam o ref remoto exato antes dos commits, igual ao tip local, e conferem a publicação pelo GitHub. Captura esquecida ou readback falho interrompe o fluxo e exige reconciliação; não autoriza ampliar o lease nem desfaz uma escrita.

A validação dos blocos de transporte cobre resolução de URLs e recusa reescritas e remotes cujo nome é um URL. Git, autenticação SSH/TLS, programas de transporte e hooks habilitados continuam sendo inputs confiáveis. Flags explícitas suprimem tags, pushes de submódulos e atualização de outras branches pelo rebase; Git 2.38 é o mínimo. Leituras de objetos e grafos ignoram replacements e grafts legados, recusam histórico raso e exigem endpoints completos. O fetch confere `FETCH_HEAD` contra o SHA selecionado. O rebase independente recusa árvore suja ou contribuição não linear.

Antes de reescrever, retargetar ou invalidar o Veredito, o responsável retira fila e auto-merge do PR e dos descendentes dependentes, com leitura dos dois estados como ausentes. O bloco completo liga host, repositório, PR e node ID antes de qualquer mutação e remove só os modos observados. Dequeue precede o cancelamento GraphQL de auto-merge. Um merge concorrente interrompe a reescrita e exige reconciliação. Restack exige o checkout limpo que possui a branch do filho, conserva os tips antigos, recusa contribuição vazia ou não linear e reaplica só o filho com HEAD detached. Contagens e bytes exatos são conferidos antes de mover a branch própria com compare-and-swap. Uma contribuição legitimamente alterada tem conclusão separada, autorizada pela Raiz após revisão do head, contribuições brutas e inputs exatos, com nova verificação. Essa conclusão mantém o CAS do tip antigo e exige uma rodada completa nova.

Patch-id estável é diagnóstico. Reutilizar evidência exige bytes exatos e auditoria de base, dependências, configuração e runtime por lane. O patch inclui as identidades dos blobs-base tocados; drift pode exigir nova prova mesmo com contribuição semanticamente igual. Os recibos ligam também atributos efetivos dos caminhos alterados e configuração de diff, porque esses inputs afetam a representação do patch. Inputs relevantes alterados ou impacto incerto exigem nova execução. Checks atuais sempre rodam e evidência anterior conserva sua identidade.

Toda criação passa pelo bloco Create. Retarget, Ready e Reply também usam blocos completos e o destino explícito validado. O watcher só desperta o fluxo; a consulta canônica após o wake confere a identidade registrada e observa head, base e estados pendentes. Cada readback conserva tuplas esperada e observada, horários, status e operação. A submissão de merge exige Veredito e checks atuais, leitura canônica no mesmo bloco, head esperado e corpo real por arquivo. O readback distingue merge real, fila autorizada e pedido inesperado, que exige retirada e reconciliação. O squash direto admite só normalização de LF final na comparação; a fila nativa segue a política do GitHub. Uma mutação pelo Origin fica recusada até haver adaptador equivalente provado.

Fila e auto-merge são estados diferentes. `--match-head-commit` é uma precondição na submissão, não uma trava permanente nem uma precondição atômica da base. Um pedido aceito pelo GitHub pode terminar depois que as sessões fecham. Fechar o chat não o retira; a retirada exige ação explícita e readback. A política de checks e fila de produção não muda. O GitHub exige CI, mas não publica nem impõe o Veredito independente da Raiz. Não volta um publicador de veredito no servidor.

A autorização conserva a versão 2 e exige exatamente um grant com o corpo atual. Ela nomeia a Raiz ou o Dono da branch e as formas literais de criação e lease capturado. O diagnóstico distingue ausência, texto diferente e multiplicidade, sem alterar settings. Substituição, confirmação digitada, backup e holds do operador permanecem.

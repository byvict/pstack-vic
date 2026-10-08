# Despertar de uma raiz Codex: lifecycle, confirmação e cancelamento

Data: 2026-10-08. Escopo: pendências **5 e 6** do [acompanhamento Linear](https://linear.app/clinextapp/document/pendencias-de-raiz-codex-apos-os-prs-99-105-2026-10-08-668a922674a8). Raiz desta investigação: `gpt-6-astra`, esforço `xhigh`, registrado no contexto local da sessão `01a11c56-6934-72c3-8759-37ddda37fead`. Isso identifica configuração, não atesta o backend.

## Decisão

**Preferir o heartbeat nativo do desktop, vinculado à thread exata, quando disponível e capaz de expressar a cadência do programa.** A prova real retomou uma sessão persistida cujo `codex exec` já havia terminado, executou o payload e repetiu o disparo. Não foi necessário dar acesso ao socket ao worker. Conservar o ID do agendamento e removê-lo ao encerrar o programa.

**Manter a fila local como alternativa executável para outros hosts.** Ela precisa de um app-server residente com a raiz carregada e de um controlador que consiga acessar o socket. Acrescentamos `codex-wake observe`, que identifica a entrega na fila ou o consumo no histórico pelo UUID nativo, sem replay. Um erro encontrado no timer também foi corrigido: desconexão do host antes do disparo era registrada como cancelamento; agora é falha.

O [contrato operacional](../../skills/poteto-mode/references/codex-local-wake.md) concentra seleção, armação, confirmação, rearmação, cancelamento e encerramento. O [ADR 0008](../adr/0008-despertar-local-por-fila-do-codex.md) registra o refinamento. O contrato mantém separados: agendamento salvo; timer armado; mensagem aceita; mensagem consumida; turno concluído; efeito da auditoria verificado.

## Base e preservação

- Repositório solicitado: `/Users/victorbaccega/Dev/Skills/pstack-vic`. `git fetch origin main` produziu SHA inicial `75d0228be7699bd2f2e70e5961d7c74c97b6ee4f`.
- Worktree exclusivo: `/Users/victorbaccega/.codex/worktrees/codex-wake-lifecycle/pstack-vic`, branch `codex/wake-lifecycle`. O checkout principal tinha alterações alheias e permaneceu intocado.
- Pin Cursor mantido em `4e5b1cf2ccb0ea3716f08c8ee0a5856b5ab93536`, conforme `UPSTREAM.md`. Model matrix, configuração pessoal e os documentos compartilhados `provider-dispatch.md` e `codex-tools.md` não foram editados.
- Lidos AGENTS.md, UPSTREAM.md, ADRs 0005/0008, implementação/testes do wake e do transporte WebSocket, contrato de wake e [investigação anterior](2026-10-07-local-executor-contracts.md). O app-server exercitado é Codex CLI **0.161.0**, Node **24.21.0**, macOS arm64.
- Evidências privadas nesta máquina: `/Users/victorbaccega/.codex/artifacts/codex-wake-20261008/`. Não contêm uma prova pública de todos os programas ou integrações da raiz. O driver versionado permite repetir a prova com credenciais locais próprias.

## Comparação com upstream e com os hosts reais

| Aspecto | Upstream no pin / Cursor observado | Desktop Codex exercitado | Fila Codex exercitada |
| --- | --- | --- | --- |
| Lifecycle | Raiz mantém o programa aberto; shell observado devolve follow-up depois de encerrar o turno | Heartbeat retoma a thread persistida pelo próprio app | App-server precisa manter a thread carregada; enfileirar em thread descarregada não inicia o turno |
| Tick Autopilot | `autopilot-full.md` passo 6 e `autopilot-stack.md` passo 2 pedem `/loop 1h` | Intervalo nativo, mesmo contexto, um ID enquanto ativo | Um evento finito; próxima armação é explícita |
| Payload | Relê playbook do trunk, audita owners, trilhas e children; substitui trabalho travado; termina só sem delegação pendente | O prompt salvo precisa conservar esse trabalho | Conteúdo do arquivo é enviado intacto depois de um envelope com UUID |
| Acesso | Host fornece o despertar | Scheduler do app fora do sandbox do modelo | Controlador local com socket acessível; teste anterior mostrou recusa no sandbox macOS |
| Confirmação | Follow-up e seus efeitos observados | Histórico de turnos e efeito no arquivo | Aceitação `queued`, correlação UUID/turno, status e efeito separados |
| Stop | Programa atende à ordem do operador | Remover o agendamento impede futuros disparos | Cancelar timer ou deletar só sua entrada pendente; não interromper turno consumido |

A leitura de `git show <pin>:pstack/skills/poteto-mode/playbooks/autopilot-full.md` confirmou **uma hora**. Os 30 minutos no ADR 0005 descrevem uma fase anterior. O sleep de 60,247 segundos do experimento Cursor e nossos intervalos de 30 segundos/um minuto são testes acelerados, não mudanças da cadência de produção. Cadência solicitada também não é garantia de latência rígida: trabalho ativo, disponibilidade do host e tempo de inferência afetam o início/fim da auditoria.

A [documentação oficial de agendamentos](https://learn.chatgpt.com/docs/automations?surface=app) descreve recorrência no mesmo chat e exige máquina/app ativos para trabalho local. A [documentação do app-server](https://learn.chatgpt.com/docs/app-server) distingue leitura da thread de sua retomada e expõe o lifecycle dos turnos. As provas locais abaixo estabelecem o que funcionou nesta instalação; a documentação não substitui execução.

## Prova nativa do desktop

O script retido `native-setup.mjs` criou um diretório Git descartável e executou `codex exec --model gpt-6-astra`, esforço `xhigh`, sandbox `workspace-write`, `--ignore-user-config`, plugins/hooks/memórias/multi-agent desativados. Pediu somente leitura do seed e resposta READY. O processo terminou antes de armar o heartbeat.

Pela ferramenta anunciada `automation_update`, foi criado um heartbeat para `01a11c60-eea9-7e41-8f2e-7499f6ae77ef`, com intervalo de **um minuto de teste** e payload de leitura de `seed.txt`/criação idempotente de `native-effect.txt`. Captura da chamada e resposta em `native-1/create.json`; a configuração salva confirma o alvo em `automation-before-delete.toml`.

| Turno na mesma sessão | Início UTC | Conclusão UTC |
| --- | --- | --- |
| Inicial, CLI, `01a11c60-ef1c-72d1-bda4-47afd061352e` | 16:37:57.179 | 16:38:09.451 |
| Heartbeat 1, `01a11c62-6454-7e63-af71-52a56a99a6c9` | 16:39:32.701 | 16:39:56.072 |
| Heartbeat 2, `01a11c63-544f-7790-8bb4-9fabab2043a8` | 16:40:34.137 | 16:40:47.767 |
| Heartbeat 3, `01a11c64-3927-7142-afad-f53a92ddcb6d` | 16:41:32.726 | 16:41:45.325 |

O efeito é `NATIVE_WAKE_20261008\n`, SHA-256 `aeaf970c335aba2d7979493f1f2e96e781e5d73122ec121d9bf16f86e931354a`. Os quatro contextos conservam Astra/xhigh. O agendamento foi deletado pela ferramenta às 16:41:47 UTC. A captura às 16:43:41 UTC confirmou ausência do arquivo do agendamento e de novos turnos por 114,9 segundos após a remoção, abrangendo o próximo prazo. Não foi parado nenhum processo compartilhado do desktop.

`native-1/result.json`, `rollout.jsonl`, `delete.json`, os recibos/streams de `commands/` e `native-capture.py` conservam as asserções e a extração. Essa prova não executa código do adaptador e não deve ser atribuída a um SHA dele. O payload usa arquivos de teste; a integração com owners reais continua condicionada à seção final.

Para reproduzir no desktop: criar uma sessão CLI descartável persistida com o seed, aguardar seu turno/processo terminar, criar o heartbeat nativo indicando exatamente esse UUID, conferir alvo/prompt/cadência salvos, aguardar o efeito e turnos recorrentes, deletar o ID retornado e observar pelo menos o próximo prazo. Nunca apontar o teste para uma sessão de trabalho alheia.

## Prova da alternativa por socket

O driver [prove-codex-wake.mjs](../../scripts/prove-codex-wake.mjs) importa o transporte do checkout candidato, executa seu comando público `codex-wake.ts`, inicia um app-server próprio em socket Unix curto e mantém os handles. Captura a fonte antes da primeira sessão. Todos os comandos gravam argv/cwd/PID/stdout/stderr antes de serem interpretados. A fila é a real do Codex; somente uma resposta é descartada pelo proxy local para provocar entrega incerta.

O payload faz uma auditoria pequena e concreta sobre `program.json`, `decisions.tsv`, `children.tsv`, o playbook copiado do candidato e o efeito `seed.txt` de um owner de fixture. Produz uma linha JSON com UUID, seed, owner, estado ativo e número de children. Não despacha owners reais nem faz merge. O controlador rearma explicitamente uma segunda vez porque o programa de fixture continua ativo; ao mudar para inativo, cancela o próximo timer.

Primeira tentativa real: `live-development-1/`, desenvolvimento explicitamente identificado, base `75d0228...` e hashes em `source.json`; handle do comando supervisor **46958**. Terminou com sucesso. Sessão `01a11c60-021a-73f0-8dc9-54334d8e4841`. Dois eventos produziram exatamente duas linhas:

- `a2e43a28-4a33-453c-91b2-42cdf504cc6a`: turno de armação concluído às 16:37:13.487 UTC; disparo às 16:37:37.713; turno de auditoria `01a11c60-a338-7f01-a34a-8b5504bb396c`, concluído. `observe` correlacionou o consumo.
- `b9908caf-bf6f-4653-bae7-98700045b165`: resposta real de `thread/queue/add` descartada às 16:38:24; recibo `delivery-unknown`. O histórico confirmou o turno `01a11c61-5987-71c0-9671-5aa9e05e09a3`, concluído, e o segundo efeito. O recibo original continuou incerto; não houve reenvio.

Também comprovados: repetir `arm` não cria evento; cancelar uma entrada real enquanto outro turno executa um comando de 15 segundos remove-a antes do consumo; cancelar timer impede a submissão; cancelar evento consumido retorna `not-pending` sem interromper trabalho; perda do host antes do disparo resulta em `failed`; fila final vazia. Os cinco PIDs de timer terminaram, assim como o app-server próprio. Os frames recebidos pelo host conservam o payload byte a byte, exceto o envelope declarado.

Rodadas posteriores de commit, fonte e verificações são registradas abaixo. Uma alteração posterior na limpeza do driver fecha primeiro o host próprio para liberar RPCs pendentes antes de conferir os PIDs; a rodada de commit também observa a armação sob `codex sandbox` no macOS.

## Tentativas e verificação

- `observe-development-1.txt`: teste novo encontrou `cancelled` onde desconexão exigia `failed`. A causa foi `cancel()` resolver a espera antes de a rejeição vencer `Promise.race`.
- `observe-development-2.txt`: **13 testes passaram**, incluindo correlação paginada, falha/interrupção, UUID apenas citado, histórico incompleto, host desconectado e alvo descarregado. A limpeza da espera foi movida para `finally`.
- Typecheck do wake e transporte passou com o comando existente `bun run typecheck`.
- `verify-pstack-vic` foi usado a partir de `doctor`; a seleção para este diff é **repository-contracts** (comando/testes de wake e tooling de prova) mais typecheck. Não há mudança de runner, setup ou do próprio verificador que justifique suas receitas. A prova real específica acima complementa os contratos; runner-smoke não prova wake.

## Limites legítimos e lacunas resolvidas

**Item 5:** exigir controlador com socket acessível é limite da alternativa CLI, não do desktop com heartbeat. Exigir host disponível durante o programa é compatível com upstream e ADR 0005. Uma invocação efêmera encerrada não fornece o host residente da alternativa. A raiz do desktop pode ser retomada pelo próprio scheduler, como demonstrado. Não foi implementado daemon persistente, recuperação de reboot ou serviço que continua um programa fechado.

**Item 6:** aceitar não é executar; agora há inspeção reproduzível da fila e do histórico para reconciliar confirmação perdida. Turno concluído não basta sem efeito real. Ausência de item não distingue consumo, remoção por outro cliente ou observação incompleta; `unobserved` conserva essa incerteza. Cancelamento não pode desfazer consumo nem efeitos já produzidos. Deduplicação é por estado/evento e não promete exatamente uma execução através de crashes, troca manual de diretório ou outros emissores.

Esses limites não impedem o audit tick local enquanto o host está disponível. Persistência após reboot e exatamente uma execução através de crashes acrescentariam outro contrato sem fundamento no lifecycle upstream ou necessidade concreta apresentada. Perda de cobertura é explicitada para retomada consciente; não escondida por replay automático.

## Reconciliação da frente A e validação integrada

Sem editar os arquivos de A, registrar na integração:

1. Em `codex-tools.md`, a linha `loop` deve preferir heartbeat nativo no mesmo UUID quando anunciado; linkar este contrato para a alternativa CLI e `observe`. Distinguir sua recorrência da rearmação de eventos finitos. Não sugerir cron que cria nova conversa nem adicionar sleep ao watcher de Babysit.
2. Em `provider-dispatch.md`, acesso ao socket é condição do controlador da alternativa, não capacidade geral de todo owner Codex. Configuração do modelo não é atestação servida. Não aplicar essa limitação CLI ao heartbeat do desktop.
3. Na validação integrada, registrar root UUID, modelo/configuração, host escolhido, ID de agenda/eventos e SHA do plugin candidato. Testar as instruções instaladas, além do comando do checkout.
4. Usar o payload integral do playbook ativo, referenciando o trunk correto do port, e **uma hora** de cadência de Autopilot. Se acelerar o ensaio, registrar explicitamente o intervalo e conservar o payload. O tick precisa verificar owners e `children.tsv`, trilhas, efeitos, substituição de travados e o encerramento após toda delegação.
5. Demonstrar ferramentas/permissões/conectores necessários no turno despertado e as rotas de owners da frente A. As fixtures aqui não são atestação de um Autopilot completo nem de todas as integrações.
6. Observar pelo menos uma recorrência/rearmação, um stop, um efeito real, confirmação/entrega incerta quando aplicável e ausência de recursos próprios ao finalizar. Host indisponível ou payload falho deve aparecer como cobertura interrompida, não sucesso do audit tick.

# Contratos locais do executor

Investigação e implementação iniciadas em 2026-10-07. Base das ferramentas: main `06745ce82e4b2d86b21a1881dfd27dbf2dfc2226`, após os PRs #99 e #100. O #100 foi reconciliado em `4111267af90f2982deb016ab29294ca2be16b8fd`, validado pelo CI 37696175948 e integrado em 2026-10-07 às 22:39:24 UTC, com autorização explícita do operador. O pin textual permanece pstack 0.15.10 em `4e5b1cf2ccb0ea3716f08c8ee0a5856b5ab93536`. O exercício Cursor usa 0.15.15 e fornece evidência de runtime, sem atualizar esse pin.

Todos os processos e worktrees são locais. As chamadas de modelos usam os CLIs autenticados já instalados. Cloud, VMs, workers remotos, Converge e Guarded operations estão fora desta mudança, por escolha do operador. Esta execução não ativa poteto-mode nem usa seus playbooks como workflow.

## Matriz inicial

| Contrato upstream / Cursor observado | Capacidade atual do port | Lacuna | Adaptação a investigar | Prova exigida |
| --- | --- | --- | --- | --- |
| Modelo e esforço escolhidos por papel; contexto novo | Matriz, argv e receipts por lane; nativos quando compatíveis | Mesmo modelo não implica mesmas ferramentas | Preservar descritor e escolher rota com as capacidades necessárias | Chamada real, output e recibo; modelo solicitado separado do confirmado |
| Leitura, shell e escrita por agentes de famílias distintas | CLIs externos têm essas ferramentas; writer recebe worktree próprio | As listas atuais também retiram web, skills e MCPs úteis | Capacidades explícitas por tarefa, conservando sandbox e diretório atribuídos | Efeito em arquivo próprio e consulta efetiva à fonte atribuída |
| Owner delega a helpers locais | Nativo admite composição; runners externos bloqueiam delegação | Owner externo não equivale a lane comum | Distinguir owner de lane e provar owner → helper no transporte escolhido | Dois contextos, descritores e resultado do helper coletado |
| Background, conclusão, resume e interrupt anunciados em Task | Handles do host e recibos de invocação; Codex externo é efêmero | Recibo não é uma sessão retomável nem um evento de wake | Priorizar persistência e comandos de retomada existentes dos CLIs | Contexto preservado no mesmo ID, interrupção e término observáveis |
| Raiz encerra turno e desperta com shell monitorado | Mapeamento Codex admite tick manual sem agenda do host | Ajuda de `codex queue` ainda não exercitada | Ponte local que enfileira evento na sessão exata, com identidade e cancelamento | Turno concluído antes do evento, novo turno executando payload, ausência de repetição |
| Revisão da trilha em outra família | PR #100 exclui somente a raiz e exige contexto novo | Divergência documental da primeira frente | Reconciliação concluída no #100, independente dos adaptadores | 209 testes de setup e 226 gerais; não são prova de execução de modelos |

## Fontes e limites iniciais

- [Provider dispatch](../../skills/poteto-mode/references/provider-dispatch.md), [lifecycle nativo](../../skills/poteto-mode/references/native-lifecycle.md), [ADR 0005](../adr/0005-autopilot-substitui-converge.md) e [ADR 0007](../adr/0007-revisor-da-trilha-de-outra-familia-da-raiz.md).
- Auditorias lidas por caminho absoluto em `/Users/victorbaccega/.codex/worktrees/1a40/pstack-vic/docs/research/`: `2026-10-07-pstack-codex-fidelity-audit.md` e `2026-10-07-cursor-exercise-audit.md`, ainda untracked naquele checkout. As conclusões foram confrontadas com `commands.ts`, o seletor e o pin Git. O laboratório `/Users/victorbaccega/Dev/poteto test` é somente fonte de leitura.
- O catálogo `audit/raw/cursor.json` do laboratório anuncia modelo, tipo, background, resume, interrupt e anexos em Task. Os transcripts observados solicitam leitura e shell em Grok e Claude, mas não provam herança geral de MCP nem modelo confirmado pelo backend.
- O terminal Cursor `775102.txt` conserva saída original, PID, exit 0 e duração de 60.247 ms; isso mede o shell temporizado, não a latência do despertar. A sequência de turnos da auditoria demonstra follow-up do host após a conclusão. Não há payload bruto da notificação no JSONL.
- Capturas desta execução: `/Users/victorbaccega/.codex/artifacts/local-executor-20261007/`. Cada diretório de comando contém `command.json`, `stdout` e `stderr`; nenhum resultado é reconstruído como captura. `codex-version` confirma CLI 0.161.0; `codex-queue-help` anuncia `queue --thread --message`. Isso ainda não demonstra reativação.

Nenhuma capacidade não exercitada é tratada como equivalente ao Cursor.


## Despertar local: resultado observado

Implementação: [comando](../../skills/poteto-mode/scripts/codex-wake.ts), [transporte local](../../skills/poteto-mode/scripts/codex-local-socket.ts), [contrato de uso](../../skills/poteto-mode/references/codex-local-wake.md) e [ADR 0008](../adr/0008-despertar-local-por-fila-do-codex.md). Foram usados Node 24.21.0 e Codex CLI 0.161.0, com app-server local dedicado em socket Unix. O app Desktop não fez o despertar.

A sequência completa está em `wake-live-3/rpc.jsonl`, com prompts, comandos e streams em `wake-live-3/`; o comando supervisor e seu exit 0 estão em `wake-live-command-3/`, dentro da raiz privada de evidência acima. O script original `wake-live-driver-3.mjs` permanece ao lado das capturas. A sessão nasceu por `codex exec --json`, foi retomada pelo protocolo nativo no mesmo ID e permaneceu carregada. O controlador externo armou o timer; o worker continuou em sandbox `workspace-write` e worktree separado.

- Sessão: `01a1188f-ddef-7e60-8343-3f46d200a7eb`.
- Turno que confirmou a armação: `01a11890-1494-7170-99fa-e9d1b0c60115`, concluído antes de `dispatchAt`.
- Evento: `a14ff36b-f452-490f-a883-94ba7189d178`, submetido às `22:51:27.996Z`.
- Turno provocado pela fila: `01a11890-8982-71f2-9608-b5f733b2fd10`, concluído; leu o seed e produziu exatamente uma linha `a14ff36b-f452-490f-a883-94ba7189d178 PSTACK_LOCAL_QUEUE_20261007` no arquivo `wake-observed.txt`.
- Repetir `arm` com a mesma identidade retornou duplicata sem outro evento. Um segundo timer de cinco segundos foi cancelado antes do disparo; a observação posterior não recebeu terceiro turno. A fila nativa estava vazia e ambos os PIDs de timer haviam encerrado. `result.json` conserva as asserções e eventos originais referenciados.

O modelo solicitado foi `gpt-6.1-sol`, esforço `xhigh`, correspondente ao descritor de teste configurado. O host confirmou a configuração; essa rota não forneceu atestação do modelo servido pelo backend. Isso não altera a matriz nem o modelo Astra da sessão de trabalho.

### Tentativas preservadas e alcance da prova

`queue-initial`, a primeira submissão por `codex queue` e `queue-stdio-probe` mostraram uma sessão descarregada com item aceito, sem efeito. `queue-start-probe` mostrou que retomar essa sessão em um host carregado consumiu o item; pedir `queue/start` depois falhou porque ele já havia sido consumido. Por isso o adaptador exige sessão carregada e nunca faz resume implicitamente.

`wake-live-command` falhou no transporte: o proxy copia bytes e não converte JSONL em WebSocket. `wake-live-command-2` chegou ao turno real, mas a armação dentro do sandbox retornou “Cannot connect to the local Codex socket”. A terceira tentativa moveu somente a armação para o controlador local já autorizado; não ampliou as permissões do worker. Essas tentativas não foram apagadas nem reclassificadas como sucesso.

Os seis testes em `scripts/codex-wake.test.ts` passaram com fixture de socket Unix que realiza o handshake e troca frames WebSocket (`wake-tests-development-3`). Cobrem identidade, um único evento, cancelamento, sessão descarregada, resposta perdida e recusa de identidade divergente. O exercício real acima é a prova de reativação; a fixture não a substitui.

Comparação com Cursor: ambos encerraram um turno e executaram um payload posterior na mesma sessão sem polling da raiz. Cursor usou `Shell.notify_on_output`; Codex usou a fila de um app-server local carregado. A instalação Cursor preservou 60,247 segundos do shell; o teste Codex usou timer de 30 segundos. Nenhuma dessas durações é apresentada como latência de retomada. Permanecem diferentes a necessidade de controlador com acesso ao socket e a ausência de agendamento durável após fechar o host ou reiniciar a máquina.

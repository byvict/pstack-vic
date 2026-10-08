# Claude como raiz coordenadora do pstack

Execução de 2026-10-08, sem poteto-mode. Uma sessão interativa do Claude Code no app desktop coordenou helpers nativos, despachou Codex e Grok pelo runner público, foi interrompida e retomada, e exercitou os mecanismos nativos de despertar. Não houve merge, troca de modelo, worker remoto, VM ou backend cloud; os modelos e esforços foram os da planilha do operador.

## Base, versões e fonte de cada prova

`origin/main` e o checkout inicial estavam em `f7b3f976a3975f724dd127dc60759de52b65e5a8`, que contém os merges #101 a #105 e a reconciliação P2 das instruções de owners (`c652c9e7`). O plugin instalado era 0.5.24 em `c3299a004e3b256ded366522b2696a58cd5084c2` (merge #97), 68 arquivos atrás do candidato: provider-dispatch, runner-capabilities, codex-wake, `capabilities.ts`, touchpoints e os relatórios de 2026-10-07 e 2026-10-08. As definições de agentes (`agents/pstack-*.md`) e o hook `agent-guard.mjs` são idênticos nos dois SHAs. Por isso cada prova nomeia a fonte: os agentes nativos (`pstack:pstack-opus-xhigh`, `pstack:pstack-opus-max`, `pstack:poteto-agent`) vêm do plugin instalado; toda invocação de `pstack-runner`, do verificador e dos scripts veio do checkout candidato.

Versões capturadas antes das sessões (`00-versions/`): raiz Claude Code **2.1.293**, binário do app desktop 2.26454.2, SDK 0.3.293; `claude` no PATH **2.1.292** (é o que as lanes headless e a retomada usaram); Codex 0.161.0; Grok 1.0.46 (`2765805b9442`); Node 24.21.0. O pin upstream segue pstack 0.15.10 em `4e5b1cf2ccb0ea3716f08c8ee0a5856b5ab93536`.

## Inventário da raiz

A raiz é a sessão `9afb4e9c-686b-4802-b6d6-8a72b804d584` (host `local_f4b00c11-…`), lançada pelo app com `--effort xhigh --permission-mode auto --input-format stream-json`, `--model` apontando a revisão `claude-fable-5-1` do alias `fable`, e `CLAUDE_CODE_SESSION_ATTENDED=1`. O catálogo efetivo foi medido com `ToolSearch select:` sobre quinze nomes: existem `Agent`, `ListAgents`, `TaskStop`, `SendMessage`, `Monitor`, `CronCreate`, `CronList`, `CronDelete`, `ScheduleWakeup`, `ReadNotifications`, `PushNotification`, `EnterWorktree`, `ExitWorktree`, `WebFetch` e `WebSearch`; **não existem `TaskOutput`, `Task` nem `TaskList`**. O CHANGELOG oficial registra a remoção de `TaskOutput` em 2.1.277 ("Claude reads a background task's output file with Read instead"); o fixture `claude-CHANGELOG.md` do update-clis já trazia a mesma linha.

| Forma de execução | Criação | Handle | Coleta | Continuidade | Interrupção ou cancelamento |
| --- | --- | --- | --- | --- | --- |
| Raiz interativa | app desktop | ID de sessão (UUID) | não se aplica | `claude --resume <id>` | interrupção do operador |
| Claude headless (`claude -p`, lane ou owner pelo runner) | `pstack-runner` em `Bash run_in_background` | ID da tarefa shell (`b…`), PID do runner, `sessionId` do recibo | notificação da tarefa, `output.md`, recibo | `--resume <sessionId>` só no perfil owner (lanes são `--no-session-persistence`) | `TaskStop` no ID shell → SIGTERM no grupo → recibo `cancelled` |
| Agente nativo (`Agent`) | `Agent(subagent_type, isolation, background)` | ID de agente (`a…`, 17 hex) | notificação com o worktree + relatório `SubagentHandback`; transcript em `subagents/agent-<id>.jsonl`; arquivos escritos | `SendMessage(to: <id>)` retoma no mesmo contexto | `TaskStop(<id>)` (`local_agent`) |
| Lane ou owner externo (Codex, Grok) | `pstack-runner --parent claude` | ID shell + recibo (`sessionId` = thread do provedor) | recibo e output | `codex exec resume` só para owners | `TaskStop` no ID shell |

`agentKind: owner` é um perfil do runner aplicado a invocações headless; não descreve esta raiz interativa, cujo catálogo foi medido diretamente. Uma lane headless `claude -p` com `--tools "ListAgents,Read"` chamou `ListAgents` e viu esta raiz como par ("Claude coordenador do pstack … Claude Desktop session"), sessão `02c00b36-…` (`01-root-catalog/headless-listagents/`).

## Matriz dos contratos Claude como raiz

Classificação: **nativo** (basta mapear a operação certa), **configuração** (depende de configuração explícita), **adaptador** (depende de componente local do port), **indisponível** (nas condições observadas). "Comprovado" se limita ao host, versão e tarefa exercitados.

| Contrato | Classe | Resultado observado | Limite |
| --- | --- | --- | --- |
| Despacho nativo com modelo e esforço da planilha | nativo | `pstack:pstack-opus-xhigh` e `pstack:pstack-opus-max`; transcripts com `claude-opus-5-5` nas mensagens assistant, `resolvedModel` no lançamento e `effort: xhigh` / `max` nos campos de hook | esforço sem atestação independente do backend |
| Worktree próprio por escritor | nativo | `isolation: "worktree"` criou `fixture/.claude/worktrees/agent-<id>`, branch `worktree-agent-<id>`; a notificação de conclusão devolve `worktreePath` e `worktreeBranch`; A e B escreveram arquivos distintos sem efeito um no outro nem no checkout principal | o worktree é do repositório do cwd da raiz; não há `cwd` arbitrário |
| Contexto independente | nativo | nonce privado da raiz reportado `ABSENT` por A e B | definições de projeto, não forks |
| Coleta dos resultados | nativo | notificação de tarefa + relatório `SubagentHandback` + arquivos; `TaskOutput` ausente (removido em 2.1.277) | o transcript JSONL do helper é evidência, não entrada de contexto |
| Follow-up no mesmo helper | nativo | `SendMessage` ao ID exato de A: segundo turno no mesmo worktree, seed recordado sem reler o arquivo | |
| Inventário de handles | nativo, parcial | `ListAgents` na raiz lista os subagentes em execução (`a0d28fdb832ab1efd · pstack:pstack-opus-xhigh · running`) e as sessões pares, não os concluídos; chamado também em `claude -p`; ausente nos helpers em background | o inventário dos concluídos fica nas notas da raiz |
| Interromper helper ativo | nativo | `TaskStop` (`local_agent`) em C parou o helper e matou o `sleep 420` que ele deixara em background (`[killed]`); worktree e arquivo intactos | |
| Retomar helper parado | nativo | `SendMessage` ao helper parado foi aceito ("Resuming agent") e ele escreveu `phase=resumed-after-stop` | a documentação de subagentes diz que seria recusado; medido ao contrário na 2.1.293 |
| Recuperar a tarefa em contexto novo | nativo | helper D leu o arquivo de C por caminho absoluto e escreveu o registro de recuperação no próprio worktree | leitura dentro do mesmo repositório |
| Shell longo observável dentro do helper | indisponível em foreground | `bash -c 'exec -a … sleep 420'` recusado pelo guard de isolamento de worktree; `sleep 420` em foreground bloqueado pelo Bash; só `run_in_background` foi aceito | regra do host, não do plugin |
| Capacidade nativa | configuração | documentação: 20 subagentes simultâneos por padrão (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`), profundidade 3; observado: três helpers e duas lanes externas simultâneos sem rejeição | liberação de slot não comprovada; nenhuma rejeição concreta observada |
| Claude despacha Codex | adaptador (runner) | `--parent claude --provider codex --model gpt-6.1-sol --effort xhigh`, capacidades `web`, `skills`, `mcpSources`; skill de projeto, `search_openai_docs` e `web_search` com resultado; recibo `complete`, `pinned-argv` | modelo não atestado pelo Codex, como antes |
| Claude despacha Grok | adaptador (runner) | `--provider grok --model grok-4.7 --effort xhigh`, `web: true`; `web_search` real; recibo `complete`, `grok-4.7-build` por `provider-report` | skills e MCP continuam fora da rota CLI do Grok |
| Cancelar lane externa | nativo + adaptador | `TaskStop` no handle Bash matou o grupo (capture, runner, codex, `sleep 600`); o runner recebeu SIGTERM e escreveu `cancelled` | a captura externa (`capture.sh`) não chegou a gravar o exit |
| Despertar por Monitor | nativo | linha de stdout abriu um turno novo na mesma sessão | expira em 30 min no máximo; re-armar |
| Despertar por Bash em background | nativo | fim de `sleep 420` abriu um turno novo; repetido duas vezes | tick de 1 h: ver [Despertar](#despertar-da-raiz) |
| Despertar por cron (`/loop` de intervalo fixo) | indisponível nas condições observadas | one-shot `40 11 8 10 *` não disparou em 8,5 min de sessão ociosa no app desktop | ver [Despertar](#despertar-da-raiz) |
| `ScheduleWakeup` | indisponível nas condições observadas | aceito fora de `/loop`; vira entrada one-shot em `CronList`; não disparou | idem |
| Cancelamento de evento armado | nativo | `CronDelete` removeu o job de controle, que nunca disparou | |
| Retomada da raiz pelo ID exato | nativo | `claude -p --resume 9afb4e9c-… --no-session-persistence --tools ""` devolveu `session_id` igual e recuperou IDs, worktrees, recibos e eventos | leitura paralela sem reiniciar a raiz |
| Owner nativo em background com `Agent` | nativo | ver [Owner em background](#owner-em-background) | `run_in_background: false` não é honrado dentro do owner |
| Owner headless pelo runner com `ListAgents` | adaptador (runner) + nativo | ver [Owner headless](#owner-headless-pelo-runner-com-o-novo-mapeamento) | drenagem de tarefas Bash em background num `claude -p` não re-medida |
| Worktree irmão precriado fora do repositório | não comprovado | não re-exercitado nesta frente | continua lacuna |

## Coordenação nativa

Laboratório descartável em `~/Dev/Skills/pstack-vic-runs/2026-10-08-claude-coordinator/lab/fixture` (git init, seeds com nonces privados). O `cd` da raiz para o fixture tornou-o o diretório primário da sessão, decisão registrada em `02-native-lab/cwd-decision.md`: assim o isolamento nativo criou worktrees do fixture, não do pstack-vic.

Helpers A (`pstack:pstack-opus-xhigh`, linha `feature, refactoring`) e B (`pstack:pstack-opus-max`, linha `hardest tasks`) foram lançados juntos, em background, com `isolation: "worktree"`, sem `model` nem `effort` na chamada. Cada um relatou `pwd` igual ao `worktreePath` da notificação, leu só o seu seed e escreveu `lab-proof-A.txt` ou `lab-proof-B.txt` com brief, seed, cwd e branch; nenhum arquivo apareceu no worktree do outro nem no checkout principal. A terminou em 33,0 s e B em 425,6 s. Os dois catálogos coincidem: `Agent`, `Task`, `TaskOutput`, `ListAgents`, `ScheduleWakeup` e `CronCreate` ausentes; `TaskStop`, `SendMessage`, `Monitor`, `WebSearch` presentes como deferidos. O follow-up a A por `SendMessage` acrescentou `seed_recalled` e `brief_recalled` sem reler arquivos. O inventário vivo está em `02-native-lab/inventory.tsv`.

## Interrupção, recuperação e capacidade

O helper C precisou de três turnos para ter um shell observável: o guard recusou `bash -c`, o Bash bloqueou `sleep 420` em foreground e só `run_in_background: true` passou (tarefa `b2vrt78og`, processos 3194 e 3197 filhos do PID da raiz). A notificação do host disse que o agente parou "with background work of its own still running"; o sleep sobreviveu ao fim do turno de C. `TaskStop(C)` encerrou os dois processos e marcou `[killed]` na saída da tarefa; `lab-proof-C.txt` ficou intacto. Em seguida `SendMessage` ao mesmo ID foi aceito e C acrescentou `phase=resumed-after-stop`. O helper D, em contexto e worktree novos, leu o arquivo de C e gravou `lab-proof-C-recovery.txt`.

A lane Codex de controle (`cancel-1`, read-only, `sleep 600`) foi cancelada por `TaskStop` no handle Bash `b1aeufxw9`: o host matou o grupo de processos inteiro (capture, runner 413, `codex exec` 421/422, `sleep 600`); o runner recebeu SIGTERM, repassou ao filho e escreveu o recibo `cancelled` com `signal: SIGTERM` e `error.message` "launcher received SIGTERM; signal was sent to child". O `capture.sh` externo morreu antes do `wait`, então o exit do runner não ficou gravado fora do recibo.

Capacidade: três helpers nativos e até três lanes externas correram ao mesmo tempo sem rejeição. A documentação anuncia 20 subagentes simultâneos por padrão e profundidade 3; nenhum limite foi inferido do observado, e nenhum `completed` ou `stopped` foi contado como slot liberado.

## Claude despachando Codex e Grok

Rotas públicas do runner candidato, cwd nos worktrees `fixture-wt-codex` e `fixture-wt-grok`, `--parent claude` gravado no recibo:

- `codex-1`: `gpt-6.1-sol@xhigh`, `isolated-write`, capacidades `lane` com `web`, `skills` e a fonte `pstack_docs` (`https://developers.openai.com/mcp`). O stream traz `mcp_tool_call` concluído para `search_openai_docs`, `web_search` concluído, leitura da skill de projeto `.agents/skills/lab-proof-skill` e `file_change`. `lane-proof-codex.txt` e `skill-proof.txt` apareceram só nesse worktree, com os nonces esperados. Sessão `01a11be6-a307-7bb2-8064-988bb14efb66`, 57,0 s, exit 0.
- `grok-1`: `grok-4.7@xhigh`, `isolated-write`, `web: true`. `web_search` com a consulta pedida, `lane-proof-grok.txt` com seed e URL, `reportedModel: grok-4.7-build`, sessão `01a11be6-a8a6-73b0-9f9e-41bba61d8c24`, 16,5 s, exit 0.
- `cancel-1`: a lane cancelada acima.

As provas de Claude recebido pelo runner (relatório de 2026-10-08) não cobriam estas saídas; elas agora estão medidas na direção raiz Claude → Codex/Grok, preservando os descritores configurados.

## Despertar da raiz

Mecanismos nativos confrontados com `claude --help`, o catálogo efetivo e as páginas oficiais `tools-reference`, `sub-agents` e `scheduled-tasks` (cópias em `05-wake/docs/`). Exercício finito armado às 14:35:12 UTC (`05-wake/plan.md`, `armed.md`, `events.log`, `notes.md`), cada evento com nonce próprio, e a raiz encerrou o turno em seguida:

| Mecanismo | Identidade | Resultado |
| --- | --- | --- |
| `Monitor` (`sleep 150; echo …`) | `da398056f5829f2a`, tarefa `boo073y1d` | linha às 14:37:42 UTC abriu um turno novo às 14:38:07 UTC |
| `CronCreate` one-shot `40 11 8 10 *` (11:40 local) | `6354fac34bf49046`, job `e5073c18` | não disparou; ainda listado às 11:48:41 local, com a sessão ociosa de 14:38:10 a 14:42:54 e de 14:43:30 a 14:48:41 UTC |
| `CronCreate` one-shot cancelado antes de 11:43 | `5a73977e26a8a1c8`, job `4bd90f13` | `CronDelete` confirmou; nunca disparou; não listado |
| `Bash run_in_background` (`sleep 420; echo …`) | `684cf9d319281daa`, tarefa `bouufavi5` | saída às 14:42:12 UTC abriu um turno novo às 14:42:54 UTC |
| `ScheduleWakeup` 540 s | nonce `wake_schedule`, entrada `0916f2a4` em `CronList` | aceito fora de `/loop` ("Next wakeup scheduled for 11:45:00"); não disparou até 11:48:41 local |

Cada evento entregue abriu exatamente um turno na sessão `9afb4e9c-…` (um Monitor, três fins de Bash contando a rede de segurança), sem duplicata e sem disparo residual. O `/loop` de intervalo fixo que o Tick do autopilot usa é um `CronCreate` recorrente; nas condições desta raiz (app desktop, `stream-json`, atendida) o scheduler não entregou os jobs enquanto a sessão esteve ociosa, embora a documentação prometa disparo "between your turns". Os dois jobs ficaram armados para observar um disparo tardio no próximo turno enviado pelo operador. Um `sleep 3600; echo HOUR_TICK …` em background (tarefa `bs7ftkxh8`, nonce `4c90c18f6cb6cf2f`) foi armado às 14:49 UTC como candidato a substituto do Tick de uma hora: a saída às 2026-10-08T15:50:49Z abriu um turno novo na mesma sessão às 2026-10-08T15:51:20Z, com os dois crons ainda listados e não entregues, mesmo depois de dois turnos enviados pelo operador (12:22 e 12:40 locais). Um comando em segundo plano que dorme uma hora é, portanto, um Tick comprovado numa raiz do app desktop; ele precisa ser re-armado a cada disparo.

## Owner em background

O desenho do Autopilot na raiz Claude cria cada Dono como um `Agent` em background. A documentação de subagentes lista o conjunto de ferramentas embutidas de um subagente em background sem `Agent`, então a nidificação precisava de prova. Um `pstack:poteto-agent` em background (handle `aa68a5d4e7f168c14`, sem `model` na definição, logo herdou `claude-fable-5-1` da raiz) tinha `Agent` presente e criou um `pstack:pstack-opus-xhigh` (`a33cf0fb2eb0a6763`), que respondeu `NESTING_CHILD_OK 7d1f09ab` com o `pwd` do checkout. Três fatos para o playbook: dentro do owner, `run_in_background: false` não é honrado, o filho é lançado assíncrono e seu resultado volta como hand-back num turno posterior do owner; o owner não tem `ListAgents`, `CronCreate` nem `ScheduleWakeup` (tem `TaskStop`, `SendMessage` e `Monitor`); e o host forçou o primeiro relatório do owner antes da resposta do filho, de modo que a raiz recebeu duas notificações de conclusão do mesmo owner. Um owner nativo precisa, portanto, registrar os filhos no `children.tsv` e tratar cada notificação como parcial até o último filho responder.

## Owner headless pelo runner com o novo mapeamento

A adaptação da rota de lifecycle foi exercitada no chamador real: `pstack-runner --parent claude --provider claude --model claude-opus-5-5 --effort xhigh --mode isolated-write --capabilities {agentKind: owner}` a partir do commit `461abb68`, cwd `lab/fixture-wt-owner` com a definição de projeto `.claude/agents/pstack-opus-xhigh.md`. O argv gerado traz `--tools Read,Write,Edit,Grep,Glob,Bash,Agent,ListAgents,TaskStop,SendMessage` e `--allowedTools Agent,ListAgents,TaskStop,SendMessage`; o evento `init` do `claude -p` 2.1.292 lista `Task`, `ListAgents`, `SendMessage` e `TaskStop` (o `Agent` aparece como `Task` nessa listagem). O owner chamou `ListAgents` antes (só a raiz interativa como par), criou o helper com `isolation: "worktree"`, viu `ac9e01e926d511046 · pstack-opus-xhigh · running` e, após a conclusão, `completed`; o helper escreveu `helper-proof.txt` no próprio worktree e o owner escreveu `owner-proof.txt` no seu. Recibo `complete`, `claude-opus-5-5` por `provider-report`, sessão `8a6a4fe3-e372-4db5-a915-21e2c5bac26f`, 36,2 s.

O stdout contém dois eventos `result`: o primeiro turno do owner terminou com o helper ainda em execução, e a conclusão do helper iniciou um novo turno no mesmo processo. Isso corrige, para helpers nativos na 2.1.292, a medição de 2026-09-18 (2.1.281) segundo a qual um `claude -p` nunca é acordado por um filho em background; o caso de tarefas Bash em background num `claude -p` não foi medido de novo. O runner conservou o último `result` no recibo e no output.

## Adaptações integradas

1. [PR #106](https://github.com/byvict/pstack-vic/pull/106), a rota de lifecycle em [`capabilities.ts`](../../skills/poteto-mode/scripts/runner/capabilities.ts): o perfil owner do runner seleciona `Agent`, `ListAgents`, `TaskStop` e `SendMessage`; `TaskOutput` e `Task` saem do mapeamento e dos testes. [runner-capabilities](../../skills/poteto-mode/references/runner-capabilities.md), [provider-dispatch](../../skills/poteto-mode/references/provider-dispatch.md), [grok-tools](../../skills/poteto-mode/references/grok-tools.md) e os touchpoints `claude.owner-lifecycle` e `claude.background-drain` passam a descrever a coleta como notificação de conclusão mais os arquivos escritos pelo helper. Prova nativa antes do substituto: `ListAgents` chamado em `claude -p` e na raiz; `TaskOutput` ausente nas duas.
2. Este relatório, com as medições de 2026-10-08 levadas a [`docs/reference.md`](../reference.md), ao [`SKILL.md`](../../skills/poteto-mode/SKILL.md) e a [native-lifecycle](../../skills/poteto-mode/references/native-lifecycle.md): o que acorda uma raiz no app desktop, o que um helper em background não tem, o que `TaskStop` encerra e a conferência do `/loop` antes do "go".

Nenhum modelo, esforço, fallback de swarm, política de Arena ou de trilha, pin upstream ou playbook gerado mudou.

## Comparativo Cursor, Codex e Claude

| Contrato | Cursor (exercício de 2026-10-07, 0.15.15) | Codex CLI 0.161.0 (frentes de 2026-10-07 e 2026-10-08) | Claude Code 2.1.293 como raiz (esta frente) |
| --- | --- | --- | --- |
| Despacho com modelo e esforço | `Task` com `model` e `subagent_type`; sem atestação do backend | `spawn_agent` com `model` e `reasoning_effort`; `pinned-argv` | agente definido por família e esforço; `resolvedModel` e `effort` nos hooks; sem atestação do esforço |
| Isolamento do escritor | worktree criado pelo pai por shell | `git worktree add` antes do `spawn_agent` | `isolation: "worktree"` nativo, caminho devolvido na notificação |
| Conclusão e coleta | follow-up do host | `wait_agent`; `followup_task`; `list_agents` | notificação + relatório + arquivos; `ListAgents`; sem `TaskOutput` |
| Continuidade | `resume` em `Task` | `followup_task`; `codex exec resume <thread>` | `SendMessage` ao ID; `claude -p --resume <id>` para a raiz |
| Interrupção | `interrupt` em `Task` | `interrupt_agent` quando anunciado | `TaskStop` (`local_agent`) mata o helper e seus shells em background; helper parado continua retomável |
| Cancelar processo externo | não exercitado | handle da sessão exec persistente | `TaskStop` no handle Bash mata o grupo; recibo `cancelled` do runner |
| Despertar da raiz | `Shell.notify_on_output` acordou a sessão após o fim do turno | fila do app-server local (`codex-wake.ts`), com controlador fora do sandbox | Monitor e fim de Bash em background acordam a raiz; cron e `ScheduleWakeup` não dispararam no app desktop |
| Fechamento de handle | não medido | `close_agent` não anunciado | nenhuma operação de fechamento; slot não comprovado |
| Ferramentas do filho | leitura, shell, MCP conforme tipo | plugins, web e MCP por invocação (`--capabilities`) | background: `Read`, `Bash`, `Edit`, `Write`, `Skill`, `WebSearch`, `Monitor`, `TaskStop`, `SendMessage`, MCPs; sem `Agent` por definição, sem agendamento |

## Evidências

Raiz privada: `~/Dev/Skills/pstack-vic-runs/2026-10-08-claude-coordinator/` (modo 700). `capture.sh` grava argv, cwd, início, PID, stdout, stderr e exit antes de qualquer interpretação. Diretórios: `00-versions/`, `01-root-catalog/` (sonda do catálogo, inventário, `headless-listagents/`), `02-native-lab/` (inventário TSV, decisão de cwd, transcripts e arquivos de A, B, C e D), `03-root-resume/`, `04-external-lanes/` (`codex-1`, `grok-1`, `cancel-1` com recibos, sidecars e árvore de processos antes e depois do `TaskStop`), `05-wake/` (plano, armação, `events.log`, notas, páginas oficiais), `06-verify/` (classificação e corridas do verificador). O transcript da raiz e os `subagents/agent-<id>.jsonl` ficam em `~/.claude/projects/…/9afb4e9c-…`. Nenhum token, prompt completo ou dump de ambiente entra no repositório; os nonces ficam em `lab/nonces.json`.

## Verificação

A adaptação 1 foi classificada pelo verificador (`classify --base origin/main`: áreas `agent-instructions` e `runner`, `noRuntime: false`) e verificada com `run --feature runner-contracts --feature repository-contracts` no commit exato `461abb68` (digest `487205e609c01bf246b25147adda2806c417aeab2ea43e35d1427655fa8ef514`): recibo `complete` às 15:12:21 UTC, as duas receitas com "at least one passing test, zero failures, exit code zero" (runner-contracts 1.059/1.059 em 836,6 s; repository-contracts 234/234 em 56,5 s). Os testes com CLIs falsos não substituem as sessões reais acima; a corrida do owner headless é a prova do chamador. As receitas da PR deste relatório estão no corpo da própria PR. Nenhuma receita ao vivo do verificador (`runner-smoke`, `inner-timeout`, `concurrency`) foi rodada nesta frente: as sessões reais foram lançadas diretamente pelo runner candidato e estão descritas acima.

## Lacunas e próximos passos

- Disparo do cron e do `ScheduleWakeup` no app desktop: observar o próximo turno do operador com os jobs `e5073c18` e `0916f2a4` ainda armados; repetir o exercício numa raiz de terminal (`claude` interativo) para separar host e versão.
- Liberação de slots e capacidade máxima continuam não comprovadas; a documentação anuncia 20 por padrão.
- Concessão a worktree irmão fora do repositório da raiz não foi re-exercitada.
- Um programa Autopilot completo com Claude na raiz ainda não rodou; esta frente prova os contratos de coordenação, não o playbook de ponta a ponta.

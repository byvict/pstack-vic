# Claude pelo runner local: P3, capacidades e lifecycle

Execução de 2026-10-08, sem poteto-mode. Os dois P3 foram implementados e Claude Code real comprovou skill, MCP, web, owner com helper escritor em worktree própria, follow-up, persistência e interrupção. O exercício também reproduziu e corrigiu a retirada das ferramentas de lifecycle dos owners. Não houve merge, troca de modelo, worker remoto, VM ou backend de execução cloud.

## Base e unidades de entrega

`origin/main` e o checkout inicial estavam em `71453f5e3cdd31ba06cc220eb444d41a3cd49e8f`. Contêm o merge #101 (`8942793e`), o merge #102 (`71453f5e`) e a reconciliação P2 das instruções de owners (`c652c9e7`). As verificações de ancestralidade estão em `final-bindings/`. O pin upstream continua pstack 0.15.10, `4e5b1cf2ccb0ea3716f08c8ee0a5856b5ab93536`. Matriz, modelos, esforços, fallback de swarm e políticas reconciliadas não mudaram.

| Unidade | Entrega | Fonte verificada |
| --- | --- | --- |
| P3 despertar | [PR #103](https://github.com/byvict/pstack-vic/pull/103): recibos discriminados, validação na leitura, transições e cancelamento tipados | `ffa8d6c5095a6f89ce13f198d035f85fd5155541` |
| P3 Claude e defeito encontrado | [PR #104](https://github.com/byvict/pstack-vic/pull/104), dependente de #103: mapeamento compartilhado e ferramentas de lifecycle para owners | Provas em `3196216969fe9d68f38e0be83a4b715a0e58abbf` e `2da72a0f8c69a70a31407b728cbbf7b2c73dd4c7`; head empilhado `acfb607a21f42b83c92de3f70fdced13f7f75e88` |
| Relatório | Este documento, dependente de #104 | Capturas originais privadas e asserções abaixo |

O rebase do #104 incorporou a correção legada de wake. `final-bindings/` comprova, por `git diff --exit-code`, que os arquivos do runner, seu contrato de capacidades e os touchpoints em `acfb607` são idênticos aos de `2da72a0`. As provas reais não são reatribuídas silenciosamente a outro SHA. O classificador final registra a árvore completa em `final-code-classification/`.

Versões capturadas antes das sessões: Node 24.21.0, Bun 1.4.0, Claude Code 2.1.292, Codex CLI 0.161.0 e Grok CLI 1.0.46 (`2765805b9442`). Nenhum CLI foi atualizado. As versões Codex/Grok identificam o ambiente; não servem como evidência de capacidades Claude. O provider-dispatch instalado em 0.5.24 ainda precedia a reconciliação; foram lidas ambas as referências e o exercício executou o runner candidato do repositório.

## Implementação dos P3

[WakeReceipt e WakeStatus](../../skills/poteto-mode/scripts/codex-wake.ts) distinguem starting, armed, dispatching, queued, cancelled, failed e delivery-unknown. `queued` exige `queuedSubmissionId`; os recibos de remoção distinguem cancelled/already-consumed com ID de not-pending com nota. A fronteira de leitura valida os campos correspondentes. As transições usam contexto tipado em memória, e cancelWake faz uma seleção exaustiva sobre estados validados.

O formato persistido, a reserva exclusiva, a identidade do evento, a deduplicação e a ausência de replay permanecem. A revisão independente identificou um caso histórico: o worker antigo podia falhar ao salvar dispatching e depois escrever delivery-unknown sem dispatchAt. Esse campo continua opcional somente nesse estado; erros de texto vazio também permanecem legíveis. O teste legado demonstra inspeção e remoção da fila sem repetir o evento. Não foi adotada a sugestão de voltar a decidir por status bruto.

[claudeCapabilityTools](../../skills/poteto-mode/scripts/runner/capabilities.ts) reúne o mapeamento owner, web e skills. Os consumidores continuam distinguindo ferramentas disponíveis, preaprovação, negação, acesso read-only e nomes MCP. Skill não entra indiscriminadamente na lista inversa de negações. MCP permanece configuração explícita de servidor e permissões por ferramenta, sem alegação de que allowedTools filtra todo o catálogo.

O exercício real levou a uma correção adicional: owners solicitam Agent/Task, SendMessage, TaskStop e TaskOutput. Lanes comuns mantêm esses recursos de delegação/lifecycle fora de sua lista disponível e negados. O perfil não concede acesso a diretórios irmãos nem altera o descritor. O contrato e o touchpoint `claude.owner-lifecycle` foram reconciliados. Uma anotação de tipo na tabela de modelos de testes corrigiu dois erros preexistentes do typecheck do runner.

## Matriz de evidências Claude

“Comprovado” abaixo se limita ao CLI, tarefa e acesso exercitados.

| Capacidade | Resultado | Evidência e limite |
| --- | --- | --- |
| Ler/escrever no cwd atribuído | **Comprovado** | Read, Write e releitura; bytes exatos da skill e do owner |
| Invocar skill nativa | **Comprovado** | Skill com `success: true`; efeito contém nonce da skill e seed lido, ausentes do prompt da lane |
| Consultar MCP atribuído | **Comprovado** | `mcp__pstack_docs__search_openai_docs` e `fetch_openai_doc`, com resultados; HTTP MCP público da OpenAI |
| Buscar na web nativamente | **Comprovado** | WebSearch com consulta e lista de URLs oficiais no resultado |
| Lançar helper nativo independente | **Comprovado** | Agent customizado, não fork; transcript próprio sem nonce exclusivo da raiz |
| Selecionar modelo/esforço do helper | **Comprovado nos níveis observados** | Definição Opus 5.5/xhigh; resolvedModel e mensagens do helper; hooks registram esforço. Esforço não recebe atestação independente do backend |
| Helper escritor em worktree própria | **Comprovado** | Agent `isolation: worktree`; cwd real separado; dois arquivos escritos pelo helper, nenhum deles no worktree do owner |
| Coletar e continuar o mesmo helper | **Comprovado** | Notificações de conclusão, SendMessage ao mesmo ID, segundo resultado; seed lido uma única vez |
| TaskOutput | **Indisponível no catálogo observado** | O runner solicita o nome, mas Claude 2.1.292 não o anuncia. Coleta ocorreu por notificações nativas |
| Retomar owner pelo ID exato | **Comprovado** | `--resume` do ID do receipt; nonce exato retornado sem ferramentas |
| Contexto novo de revisão | **Comprovado** | Outra sessão pelo runner, token ABSENT, leitura apenas do patch; a revisão detectou o caso legado de wake |
| Interromper helper ativo | **Comprovado** | TaskStop com `task_type: local_agent`; evento nativo terminal `status: stopped`. Não houve shell desse helper nessa tentativa |
| Interromper geração do owner | **Comprovado** | Controle nativo interrupt durante message_start; resposta de sucesso para o mesmo request ID; resultado interrompido e saída do CLI |
| Cancelar runner e terminar processos observados | **Comprovado** | SIGTERM no PID do runner, receipt cancelled, Claude 143, wrapper 130; sleep real e árvore observada desapareceram |
| Fechar handle / liberar slot | **Não comprovado** | Nenhuma operação de fechamento ou relatório de capacidade demonstra liberação; conclusão e interrupção não foram contadas como release |
| Acesso a um worktree irmão precriado por settings não confiados | **Indisponível nessa fixture** | Read e listagem negados; a linha additionalDirectories não se tornou concessão efetiva |
| Herança geral de MCP, todos os plugins ou equivalência com Cursor | **Não comprovado** | Escopo foi uma skill e uma fonte explicitamente atribuídas, não herança entre provedores |

### Lane: skill, MCP e web

`lane-command-1/` terminou com exit 0 no candidato `3196216`. Sessão `ec8873dd-b255-460a-879c-6a2e06f80efa`, perfil lane com web, skills e duas ferramentas do MCP `pstack_docs` em `https://developers.openai.com/mcp`.

Os hooks de projeto gravaram o JSON original de PreToolUse/PostToolUse antes da interpretação. Há Skill, Read, Write, releitura, busca e fetch MCP e WebSearch com resultado. A busca MCP retornou 120.039 caracteres; o CLI armazenou esse resultado em arquivo e apresentou uma mensagem de limite de tamanho. A captura inclui esse arquivo original. A lane localizou uma URL nele por Grep e recebeu conteúdo real de `fetch_openai_doc` para a seção API overview. Isso é resposta grande com leitura posterior, não falha de acesso à fonte. A prova não afirma que a documentação retornada tinha um método queue.

O efeito da skill foi comparado byte a byte pelo supervisor. A lane comum conserva `--no-session-persistence`; por isso os hooks e arquivos de resultado, além do stdout/receipt, são a trilha de ferramentas. Não se afirma que uma sessão efêmera deixou um transcript retomável.

### Owners: falha preservada e rota corrigida

`owner-command-1/` terminou com exit 0 e receipt complete, mas **a tarefa de lifecycle ficou parcial**. Receipt complete prova a conclusão da invocação, não todos os efeitos pedidos. Sessão `b3d16e13-9ea7-41ec-874e-fd79cf3142e0`; helper `a935019f4e10eaa42`.

O owner lançou o helper, recebeu sua conclusão e escreveu a falha no próprio diretório. Faltavam SendMessage e TaskStop no catálogo. O helper permaneceu com cwd do owner e teve a leitura do diretório irmão negada. A fixture tinha `permissions.additionalDirectories`, mas esse grant não entrou em vigor. Não houve tentativa de ler por outra ferramenta para contornar a recusa. A documentação oficial descreve a restrição de grants de projeto ainda não confiado em headless.

A correção foi feita no worktree isolado `/Users/victorbaccega/.codex/worktrees/claude-owner-lifecycle/pstack-vic`. `owner-command-2/`, em `2da72a0`, terminou com exit 0. Sessão `491c00f6-c69c-44dd-8e88-798ffd9fb2c8`; helper `af988b55ebf579e85`, definição de projeto copiada de `agents/pstack-opus-xhigh.md`, sem override de modelo/esforço.

Diretórios efetivamente usados, sob a raiz privada de capturas:

- Owner: `owner-2/worktree`, branch `owner-2`.
- Helper: `fixture-repo/.claude/worktrees/agent-af988b55ebf579e85`, branch `worktree-agent-af988b55ebf579e85`, criado por Agent com isolamento nativo.
- O cwd observado por pwd e os caminhos de Write confirmam a separação. O helper escreveu `helper-proof.txt` e `followup-proof.txt`; o owner escreveu somente `owner-proof.txt`. As comparações incluem a ausência dos arquivos do helper no owner e vice-versa.

O nonce exclusivo da raiz não aparece no brief nem no transcript do helper. O helper relatou ABSENT, usou seu próprio seed, e o follow-up reutilizou esse valor sem reler seed.txt. SendMessage recebeu o ID exato coletado. O driver conservou as árvores de processos em `processes.jsonl`; o fim do owner deixou a árvore observada vazia. Isso não demonstra liberação de slots nativos.

### Persistência, revisão e três formas de parar

A retomada nativa manteve o mesmo cwd, modelo, esforço, listas de ferramentas e ID do receipt. `native-resume-1/` contém stdin JSONL, stdout/stderr, argv e três fases na mesma invocação CLI:

1. **Memória da mesma tarefa:** o nonce exclusivo da raiz foi devolvido exatamente, sem chamadas de ferramenta. Não foi incluído no prompt de retomada.
2. **TaskStop:** o mesmo helper foi retomado por SendMessage e parado enquanto estava ativo. PostToolUse registra sucesso com seu task ID; o stream registra `task_notification` com `status: stopped`. Ele ainda não tinha iniciado um shell. Não há alegação de kill de processo separado de helper: esse trabalho nativo pertence ao processo Claude.
3. **Interrupt do owner:** após observar message_start da raiz durante uma nova resposta, o controlador enviou `control_request` com `subtype: interrupt`. O mesmo request ID recebeu `subtype: success`. O turno resultou em `error_during_execution`, `is_error: true`, e o CLI encerrou com exit **1**, sem sinal POSIX. O supervisor terminou com exit 0 por ter concluído o exercício; não se confunde esse código com o do Claude.

A primeira tentativa de parar o helper, ainda em `owner-2`, não comprovou interrupção: o CLI bloqueou `sleep 127` em foreground e TaskStop encontrou o helper já completed. Também rejeitou duas sondagens shell do owner. Esses resultados foram mantidos. A retomada usou a modalidade background indicada pelo próprio erro e parou o helper antes de iniciar o shell; não contornou o bloqueio.

Separadamente, `runner-cancel-command-1/` executou uma **lane nova pelo runner público**. Bash iniciou `sleep 127` com `run_in_background: true` e retornou o task ID `baxu0yyl1`. O controlador só enviou SIGTERM ao PID do runner depois de observar o processo sleep descendente. O receipt final é cancelled, com signal SIGTERM e child exit 143; o runner retorna 130 e remove a reserva de output vazia. As amostras e a checagem posterior por PID mostram ausência do runner, Claude e descendentes observados. O receipt dessa invocação interrompida não tem sessionId; a identidade está no hook SessionStart. Não se inventou um ID no receipt.

`review-command-1/` abriu uma sessão independente, `2ee28c0b-8f06-47d6-99fe-1139935d2eb5`, com read-only e perfil lane, e recebeu somente o patch. Ela respondeu ABSENT ao controle de contexto e revisou o patch. Seu achado sobre delivery-unknown foi confrontado com o código completo e corrigido. A hipótese adicional de UUID não validado não se confirmou: manifest já valida a identidade. O autor retomado nunca contou como revisor independente.

## Modelo, esforço e limites da atestação

Todas as invocações principais pediram `--parent codex --provider claude --model claude-opus-5-5 --effort xhigh`; nenhuma usou fallback. Para lanes concluídas, o receipt usa o relatório do provedor. Para owners, mensagens assistant da raiz com `parent_tool_use_id: null` reportaram `claude-opus-5-5`; a contabilidade agregada de helpers não foi usada para atestar a raiz.

O helper tem `resolvedModel: claude-opus-5-5` no evento de lançamento e mensagens assistant próprias com esse modelo no transcript. CLI argv e definição de agente solicitam xhigh; hooks registram `effort.level: xhigh` na raiz e no helper. Isso distingue solicitação, configuração observada e modelo reportado, sem inventar atestação independente do esforço pelo backend. A sessão cancelada antes do resultado não ganha atestação por analogia com as anteriores.

## Capturas, comandos e verificações

Raiz privada: `/Users/victorbaccega/.codex/artifacts/claude-runner-20261008/`. Diretórios e streams foram criados com acesso privado; o código do repositório contém apenas esta síntese, não os transcripts, prompts completos, tokens de autenticação ou dumps de ambiente.

`capture.py` registra argv/cwd, início, PID, stdout, stderr e exit code. `process-driver.py` registra a árvore observada; `cancel-driver.py` adiciona o gatilho explícito de cancelamento. `hook.cjs` salva o JSON original antes de analisá-lo. `collect.py` conserva transcripts e resultados MCP da sessão correspondente. `assertions.py` verifica as chamadas e efeitos acima, produzindo `assertions.json` e `assertions-1/`. Os scripts originais de preparação estão ao lado das capturas; cada tentativa tem diretório próprio.

Padrão das chamadas principais (argv exato de cada uma em `<exercício>/runner-argv.json` e no receipt):

```sh
<checkout-candidato>/skills/poteto-mode/scripts/runner/pstack-runner \
  --parent codex --provider claude --model claude-opus-5-5 --effort xhigh \
  --mode isolated-write --cwd <worktree> --prompt <prompt.txt> \
  --capabilities <capabilities.json> --output <output.md> --receipt <receipt.json>
```

A revisão usa read-only. A retomada parte do argv Claude do receipt, acrescenta `--resume 491c00f6-c69c-44dd-8e88-798ffd9fb2c8 --input-format stream-json --include-partial-messages` e troca somente o formato de saída para stream-json. Essa é a continuidade nativa prevista pelo contrato; as sessões principais passam pelo runner. O protocolo de controle foi conferido na implementação pública do SDK, sem instalar ou trocar o CLI.

| Captura | Resultado e vínculo |
| --- | --- |
| `versions/`, `prepare-fixtures/`, `prepare-owner-2/` | Versões, comandos Git, fixtures e nonces; candidate.json registra SHA e estado limpo antes das sessões |
| `wake-classification/` | Classificação inicial do P3 wake |
| `wake-contracts/` | Testes passaram, mas prova **recusada** na revalidação porque a árvore mudou durante o check; preservada e não contabilizada como passe |
| `p3-contracts/` | `3196216`: repository-contracts **233/233**, runner-contracts **1.059/1.059**; digest `36dbc849b9aeb40f97451b3d84af5cc8eaba6be30190fc1a4268c06d72975a23` |
| `owner-fix-contracts/` | `2da72a0`: repository-contracts **233/233**, runner-contracts **1.059/1.059**; digest `020cd3527e86961ba3365ee5b93867f269980b30efcc94734adf388faa641a6d` |
| `wake-final-contracts/` | `ffa8d6c`: repository-contracts **234/234**, incluindo oito testes de wake; digest `b4e4e736b67b554a792e7ccd0343111cf8d818d84908fc30dad7d843c25d7e9e` |
| `wake-typecheck-3/`, `runner-typecheck-3/` | Typechecks estritos passaram. Tentativas anteriores conservam dependências inicialmente ausentes e os dois erros na tabela de testes, depois corrigidos |
| `bun-contracts/` | **79 testes**, typecheck de watch-pr e wake passaram |
| `lane-command-1/`, `lane-1/` | Lane real, hooks e resposta MCP grande preservada |
| `owner-command-1/`, `owner-1/` | Reprodução da falta de lifecycle e da negação do diretório irmão |
| `owner-command-2/`, `owner-2/` | Escrita isolada, follow-up e primeira interrupção não comprovada |
| `native-resume-command-1/`, `native-resume-1/` | Retomada, TaskStop ativo e interrupt nativo, com capturas originais e asserções por fase |
| `review-command-1/`, `review-1/` | Revisão independente do patch e controle ABSENT |
| `runner-cancel-command-1/`, `runner-cancel-1/` | Cancelamento do runner com processo background real e árvore final vazia |
| `final-bindings/`, `final-code-classification/` | Correspondência das fontes após empilhar os PRs e preservação de pin/matriz/instruções |

Receitas escolhidas: repository-contracts cobre wake e os touchpoints; runner-contracts cobre mapeamento, argv, parsing, permissões e cancelamento. Não houve alteração do verificador que exigisse verifier-contracts, nem mudança de setup que exigisse setup-contracts. Os testes com CLIs falsos não substituem as sessões Claude descritas acima. Tempos dos checks não são métricas de throughput, concorrência ou capacidade nativa.

## Próxima frente: Claude como coordenador

1. Começar da pilha #103 → #104, sem instalar sobre a configuração pessoal durante a investigação. Registrar novamente versão, SHA e catálogo efetivo. Manter o descritor configurado de cada papel.
2. Usar o perfil owner, fornecer explicitamente o harness Claude e um inventário de helper ID, descritor, worktree, tarefa e estado. Para o escritor, repetir primeiro Agent com isolamento nativo e conferir o cwd retornado. Um worktree irmão precriado exige uma concessão efetiva demonstrada; não basta citar o caminho ou editar settings de projeto não confiado.
3. Coletar pelas notificações efetivamente expostas. Se TaskOutput reaparecer em outra versão, provar sua chamada antes de depender dele. Para continuidade justificada da mesma tarefa, usar SendMessage no ID coletado; para revisão, abrir contexto novo com o descritor da política apropriada.
4. Exercitar então a coordenação de dois helpers pequenos, com resultados separados e um follow-up após coleta. Registrar capacidade reportada ou rejeição concreta, sem inferir um limite fixo, sem contabilizar completed/stopped como slots livres e sem medir concorrência com a saída resumida Claude.
5. Antes de usar owners em um programa maior, provar recuperação de um helper interrompido, inventário após resume do owner e drenagem de todos os filhos. Usar TaskStop para o helper, interrupt para o turno e o handle do runner para cancelar o processo; conferir efeitos e liveness de cada camada.
6. Preservar as limitações deste relatório: ele prova um owner Claude despachado por Codex em execução local. Ainda não prova Claude como raiz de um programa Autopilot inteiro, fechamento de handles, herança geral de MCP ou concessões de diretório independentes do host.

## Referências

Contratos do repositório: [provider-dispatch](../../skills/poteto-mode/references/provider-dispatch.md), [runner-capabilities](../../skills/poteto-mode/references/runner-capabilities.md), [native-lifecycle](../../skills/poteto-mode/references/native-lifecycle.md), [capacidades em 2026-10-07](2026-10-07-runner-capabilities.md) e [executor local em 2026-10-07](2026-10-07-local-executor-contracts.md).

Fontes primárias consultadas para interpretar o host: [hooks Claude](https://code.claude.com/docs/en/hooks), [subagents e continuidade](https://code.claude.com/docs/en/sub-agents), [ferramentas e TaskOutput/TaskStop](https://code.claude.com/docs/en/tools-reference), [permissões e confiança de projeto](https://code.claude.com/docs/en/permissions), [protocolo de controle no SDK Python](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py). A documentação orienta o exercício; as capturas locais estabelecem o que este CLI fez.

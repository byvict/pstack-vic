# Capacidades locais dos runners

Base: main `06745ce82e4b2d86b21a1881dfd27dbf2dfc2226`, após os PRs #99 e #100. Esta etapa é independente do [PR #101](https://github.com/byvict/pstack-vic/pull/101), que contém o despertar local e a matriz inicial da investigação. O pin permanece pstack 0.15.10, `4e5b1cf2ccb0ea3716f08c8ee0a5856b5ab93536`. As evidências Cursor 0.15.15 são comparação de runtime, não nova base textual. Nenhuma configuração pessoal de modelo foi alterada; Astra continua sendo a escolha desta sessão de trabalho.

## Contratos e decisões

| Contrato | Capacidade anterior / lacuna | Adaptação | Prova e limite |
| --- | --- | --- | --- |
| Lane produz uma opinião independente | CLI nova, frequentemente efêmera, sem delegação nativa | Conservar o padrão, descritor, contexto novo e worktree atribuído | Testes do runner e sessão Codex real; uma opinião não vira várias por delegação |
| Owner delega e coleta helpers | Bloqueio de recursão também atingia owners | Perfil explícito `agentKind: owner` habilita ferramentas nativas e persistência em Codex/Claude | Codex: spawn independente, descritor explícito, wait, follow-up e resultado real; Claude não exercitado por cota |
| Owner retoma estado da mesma tarefa | Não persistir impedia resume por ID | Owner inicia novo, conserva ID; retoma pelo CLI nativo | `codex exec resume` retornou o nonce da tarefa anterior sem leitura ou outras ferramentas; não é contexto de revisão independente |
| Pesquisa consulta web | Claude/Grok bloqueados em toda lane; Codex dependia da configuração | `web: true` seleciona a ferramenta nativa nos três CLIs | Chamadas e resultados reais em Codex e Grok |
| Tarefa usa uma skill requerida | Claude desabilitava todas as skills; Codex desabilitava plugins | `skills: true` remove esses bloqueios para a tarefa, conservando outros controles | Skill local Codex foi lida pelo mecanismo nativo e produziu bytes exatos; não prova toda skill ou plugin instalado |
| Why/Reflect/investigação consulta fonte MCP | Não havia attachment geral explícito no CLI; listar o catálogo não bastava | Fontes HTTP nomeadas por invocação em Codex/Claude | Codex chamou busca e leitura no MCP público da OpenAI; conteúdo retornado conservado |
| Grok owner/skills/fontes gerais | CLI tem contrato distinto de ferramentas; ACP atual é tarefa T3/host com grant próprio | Conservar seleção nativa para essas necessidades e o attachment T3 existente; novo perfil CLI suporta web | Não alegar equivalência geral com Codex/Claude nem ampliar ACP full-access implicitamente |

A interface está em [runner-capabilities.md](../../skills/poteto-mode/references/runner-capabilities.md), a implementação em [capabilities.ts](../../skills/poteto-mode/scripts/runner/capabilities.ts), e a decisão em [ADR 0009](../adr/0009-capacidades-por-tarefa-no-runner.md).

### Integração das instruções de owners

A revisão do PR #102 identificou que habilitar o perfil no runner ainda deixava as entradas do Autopilot presas aos caminhos antigos. Após a integração do #101 em main `8942793ebf878b49948d9d1aeb72bfa547a6193d`, `SKILL.md`, `codex-tools.md` e `grok-tools.md` passam a selecionar owners pela [mesma regra de provider-dispatch](../../skills/poteto-mode/references/provider-dispatch.md#autopilot-owners). O owner recebe o descritor da linha de autoria; uma linha externa ou uma rota nativa incapaz seleciona o perfil `agentKind: owner` quando suportado. A raiz Grok pode lançar um owner Codex com `--parent grok`; esse owner recebe explicitamente Codex como seu harness para despachar helpers.

Aliases herdados continuam escolhas explícitas da configuração. A ausência de delegação Grok ou de escrita no worktree atribuído permanece uma lacuna quando nenhuma rota autorizada atende ao requisito. O perfil não concede escrita a helpers em worktrees irmãos. O código do runner e as provas reais anteriores permanecem inalterados; um exercício de leitura destas instruções avalia seleção de rota, sem substituir a prova de despacho nem executar os playbooks.

### Por que cada restrição muda ou permanece

- **Delegação:** o bloqueio continua sendo adequado para uma lane comum, cuja cobertura e opinião são contabilizadas pelo parent. Não é adequado para o owner que tem o dever explícito de coordenar helpers. O perfil distingue os dois e não muda modelo/effort nem acrescenta um workflow. Worktrees, capacidade e coleta continuam no contrato de lifecycle. Desabilitar uma ferramenta nativa não é uma barreira de segurança contra todo programa que um shell possa executar.
- **Web:** o bloqueio padrão limita o escopo da tarefa; mantê-lo universalmente impediria pesquisa exigida. O parent seleciona web antes do despacho, e a prova verifica a ferramenta efetiva. Não altera permissões do filesystem.
- **Skills/plugins:** desabilitar dispatch ambiente ajuda a manter uma lane estreita, mas não justifica impedir a skill atribuída. A seleção usa os mecanismos nativos do CLI e as instalações/configurações já confiadas pelo operador. Não copia o histórico do parent nem promete inventário idêntico de skills em outros provedores. `plugins=false` do Codex, sozinho, nunca foi uma prova de que toda skill de projeto estava indisponível.
- **MCP:** não há herança automática de conectores da conversa. A nova configuração nomeia endpoint e ferramentas por tarefa; não altera arquivos globais nem encaminha tokens em prompts. Fontes privadas continuam dependentes da autenticação nativa apropriada. A rota HTTP não substitui o contrato de bearer/token/tab do T3. Só uma chamada bem-sucedida à fonte exigida prova acesso.
- **Hooks e memórias Codex:** ficam desligados para evitar execução implícita e contexto de outras tarefas. Esta é uma escolha explícita de independência, não uma suposta obrigação upstream nem uma medição de que todo hook é nocivo. Nenhuma capacidade implementada precisou deles.
- **Persistência:** continua desligada nas lanes comuns. Owners podem precisar de estado caro de transferir; conservam sessão nova e ID retomável. Resume não autoriza reutilizar autoria como revisão independente e não mantém arbitrariamente filhos vivos depois do fim do processo headless.
- **Sandbox, permissões e ambiente Grok:** conservam-se as correções medidas já documentadas em provider-dispatch: nested Seatbelt, limitações de PTY/Chromium/commit, cancelamento de prompts de permissão headless e `inherit = "core"` para não exportar credenciais ao shell. Web não exige retirar esses controles. O grant full-access ACP continua separado e explícito.
- **`ultra`:** permanece fora do universo configurado. Corrigimos a justificativa textual “um filho nunca delega”, falsa para owners; não adicionamos esforço nem modificamos descritores.

## Evidências originais

Raiz privada: `/Users/victorbaccega/.codex/artifacts/local-executor-20261007/`. `capture.py` conserva argv/cwd, stdout, stderr, início, término e exit code antes de interpretar resultados. Os exercícios guardam também prompts, perfis, comandos de criação dos worktrees, receipts e efeitos. Nada abaixo foi reconstruído como captura nem publicado integralmente no PR.

Versões medidas: Codex 0.161.0 (`codex-version`), Claude Code 2.1.292 (`capability-claude-version`) e Grok 1.0.46 (`capability-grok-version`). Workers locais em worktrees do repositório descartável `probe-repo`; apenas os serviços de modelos dos CLIs e fontes web/MCP recebem requisições. Não há VM, backend cloud nem worker remoto.

### Codex: skill, MCP e web

`capability-codex-command` terminou com exit 0. `capability-codex-1/receipt.json` registra sessão `01a1189b-a0ac-78b1-bbbc-dbff504d6458`, `gpt-6.1-sol@xhigh`, `modelEvidence: pinned-argv`, `modelVerified: false` e SHA-256 do perfil `478a89b88729d2c3b82e2f9b394087dfcf0f685cf782bbb3c655680970fa5e66`.

O stream original contém leitura de `.agents/skills/pstack-capability-proof/SKILL.md`, leitura do seed, alteração de arquivo e verificação dos bytes `CAPABILITY_SKILL_CODEX\n`. Há dois eventos `mcp_tool_call` concluídos para `pstack_docs`: `search_openai_docs` e `fetch_openai_doc`, ambos com resultado não vazio e `error: null`. A fonte é o [MCP público oficial de documentação](https://developers.openai.com/resources/docs-mcp), endpoint `https://developers.openai.com/mcp`. A página retornada foi [Codex App Server](https://learn.chatgpt.com/docs/app-server). Um evento separado `web_search` registra a consulta web nativa. Isso demonstra chamada efetiva, não apenas descoberta de nomes.

### Codex: owner, helper e retomada

O primeiro exercício (`owner-codex-1`, exit 0) produziu o nonce correto por helper, mas o JSON resumido do CLI não conservou todos os eventos de despacho. Ele permanece como evidência parcial. A implementação passou a persistir owners, requisito de lifecycle; a nova prova `owner-codex-command-2` verificou esse comportamento e terminou com exit 0.

A sessão persistida `01a1189f-6a5e-7301-92ec-a730da585ec3` conserva `root-rollout.jsonl`. Nele há `spawn_agent` com `fork_turns: none`, modelo `gpt-6.1-sol`, esforço `xhigh`, retorno `/root/helper`, espera, `followup_task`, nova espera e `list_agents` mostrando o helper concluído. O nonce aleatório só estava no worktree de leitura atribuído ao helper. O owner escreveu o mesmo nonce em seu próprio worktree, confirmado por comparação byte a byte do supervisor. Partes dos briefs foram cifradas pelo host no rollout; os originais foram preservados assim, sem inventar um transcript em texto aberto.

`owner-resume-command` usa `codex exec resume` com esse ID exato e os mesmos modelo/effort. O novo turno recordou o nonce do histórico sem usar ferramentas. `owner-codex-2/resume/assertions.json` e os streams confirmam mesmo thread, valor exato e nenhuma nova leitura. Isso prova persistência e retomada da mesma tarefa; não prova que o backend atestou o modelo. A ferramenta de fechamento não foi anunciada nesse host. O estado observado do helper foi completed; não inferimos liberação de slot a partir disso.

### Grok: web

`capability-grok-web-command` terminou com exit 0. A sessão `01a1189d-a642-71e3-9e42-775a0fe205c2` leu o seed e emitiu `server_tool_use` de `web_search`, seguido de `web_search_tool_result` com URLs oficiais. O resultado terminal registra uma requisição web. O modelo solicitado foi `grok-4.7@xhigh`; o provedor reportou `grok-4.7-build`, aceito pelo padrão da matriz (`modelEvidence: provider-report`). Não tratamos isso como prova de skills, MCP geral ou owners Grok externos.

### Claude: limite concreto

`capability-claude-command` terminou com exit 70 do runner. O CLI autenticou e aceitou a invocação, mas respondeu `429 usage_limit_reached`, “weekly limit”, antes de executar ferramentas ou servir tokens. A sessão do erro aparece no stdout original como `97067c6f-1fb1-4cff-8d7d-f7c2c38c5d3e`. Não houve troca silenciosa de modelo nem nova tentativa para recuperar essa cota.

O mapeamento Claude e a separação de modelo do owner versus modelos dos helpers têm testes determinísticos. A execução real de suas novas capacidades permanece **não comprovada** nesta sessão. Quando a cota permitir, a prova pendente é executar o perfil e observar Skill, MCP e owner → helper reais. Não se pode promover o resultado Codex a evidência do Claude.

### Verificação e comparação com Cursor

`capability-effect-assertions.json` agrega asserções derivadas dos artefatos, sem substituir os streams originais. Testes determinísticos exercitam parsing público, propagação do perfil até argv/receipt, opções de sandbox/descritor, combinação suportada, rejeições na fronteira e a impossibilidade de usar apenas a contabilidade de um helper para atestar o modelo do owner Claude.

Em relação ao Cursor observado, foram demonstrados leitura/shell local, seleção solicitada de modelo/effort, contexto novo de helper, conclusão e follow-up no mesmo contexto, skill com efeito e MCP com conteúdo. O despertar CLI é a entrega separada do #101. Não há conclusão de herança geral de MCP entre provedores, de igualdade de todos os catálogos, de backend/modelo Codex confirmado nem de closure/capacidade liberada. Configuração pedida, fato observado e limitação permanecem separados.

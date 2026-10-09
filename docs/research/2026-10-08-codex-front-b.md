# Frente B: capacidades e atestação dos ajudantes da raiz Codex

Recorte: itens **7, 8 e atestação Codex do 9** do [documento de pendências](https://linear.app/clinextapp/document/pendencias-de-raiz-codex-apos-os-prs-99-105-2026-10-08-668a922674a8), lido pelo conector Linear nesta sessão. Despertar, liberação de vagas nativas, exercício Autopilot integrado e questões específicas do harness Claude Code ficam nas frentes correspondentes.

## Base e configuração

- `origin/main` atualizado: **`75d0228be7699bd2f2e70e5961d7c74c97b6ee4f`**. O checkout principal tinha alterações alheias e foi preservado. Worktree próprio: `/Users/victorbaccega/.codex/worktrees/codex-capabilities-front-b/pstack-vic`, branch `codex/capabilities-front-b`.
- Raiz: `gpt-6-astra@xhigh`, conforme `turn_context` local de `01a11c56-1a7f-7081-bfde-8b6f768285ce`. Isso comprova configuração do host, não identidade independente do backend.
- CLIs encontrados: Codex **0.161.0**, Grok **1.0.46** (`2765805b9442`), Claude **2.1.292**. O host dos subagentes nativos reporta **Codex Desktop 0.162.0-alpha.2**; suas provas não são atribuídas ao executável 0.161.0.
- A sheet vigente mantém `swarm workers: codex:gpt-6.1-sol@high`, fallback `codex:gpt-6.1-sol@xhigh`, exploração/autoria Sol `xhigh`, julgamento Sol `max` e Grok `grok-4.7@xhigh` nas lanes de painéis/pools. Nenhuma escolha pessoal foi alterada. As provas Grok exercitam essa entrada de painel; Grok não foi tratado como worker padrão.
- Pin Cursor preservado: **`4e5b1cf2ccb0ea3716f08c8ee0a5856b5ab93536`**, pstack 0.15.10. `UPSTREAM.md`, matriz e playbooks não foram alterados.
- Implementação do runner: **`e58e85deb3b7e0fe9b7c8c658bf22a16806c538a`**, cherry-pick de `469be3eb5f83924a75e4d22b193237eb1c0f1494` do worktree do implementador Sol `xhigh`. A raiz reviu o diff e executou as provas reais.

O provider-dispatch instalado, em `~/.codex/plugins/cache/pstack-vic/pstack/0.5.24/`, foi lido antes dos despachos e comparado ao checkout. Apesar do mesmo número de versão no package, a instalação não contém o perfil de capacidades, a seleção recente de owners nem a política corrigida da trilha. Os exercícios chamam o **runner do candidato**, sem instalar o plugin ou mudar configuração global. A diferença foi conservada em `installed-vs-base-provider-dispatch.diff`.

## Comportamento a preservar

O Why no pin exige investigadores com os MCPs da sua categoria, contexto independente e conferência de citações pelo sintetizador. Seu alerta sobre Ask/read-only trata da perda de ferramentas naquele harness; não exige retirar um sandbox que conserva as ferramentas necessárias. Reflect também exige consultas e conferência de fontes. Feature exige autoria delegada e prova do efeito; Autopilot exige owners capazes de delegar e coletar. O [ADR 0005](../adr/0005-autopilot-substitui-converge.md) permite adaptações de plataforma e rejeita novos gates locais sem necessidade do ambiente.

Aplicação nesta frente: fornecer o descritor, instruções e dependências ao executor, manter contexto novo e escopo atribuído, e observar chamadas/efeitos. Não substituir uma consulta exigida por um catálogo, nem transformar ausência de telemetria de backend em reprovação da tarefa. O owner vigente é Codex; ampliar owners Grok externos não é necessário para esta configuração.

## Solução recomendada e decisões

| Pendência | Decisão e mecanismo | Resultado sustentado |
| --- | --- | --- |
| **7 — ajudantes Grok** | Reaproveitar skills acessíveis pelo CLI e o `session/new.mcpServers` do ACP já existente. O runner aceita perfil de tarefa no ACP e conserva `read-only`/`isolated-write`; full access permanece escolha explícita. | Skill com efeito nas duas rotas, fonte HTTP chamada pelo ACP e escrita local negada no modo read-only. O bloqueio genérico de skills/MCP deixa de impedir essas tarefas. |
| **8 — integrações da raiz Codex** | Preferir o helper nativo configurado. No CLI Codex, usar as próprias integrações autenticadas ou fontes HTTP explicitamente atribuídas. Nomear skill, plugin/dependências, fonte/operação e destino no brief. | Linear privado e GitHub no helper nativo; Linear privado, MCP HTTP e skill com efeito no CLI externo. Não foi necessário construir relay nem copiar credenciais. |
| **9 — atestação Codex** | Conservar `pinned-argv`, `reportedModel: null`, `modelVerified: false`. Rotular configuração e telemetria separadamente. | O mecanismo existente já registra honestamente a evidência disponível; item de atestação encerrado como limite documentado, sem gate novo. Não encerra o exercício Autopilot integrado. |

O `--capabilities` Grok permite `skills: true` nas lanes CLI e ACP. A skill é lida e executada pelas ferramentas disponíveis; isso não emula hooks, comandos ou serviços de outro plugin. Fontes HTTP explícitas usam ACP. O perfil seleciona os builtins web quando solicitado, impede delegação nativa e registra o SHA-256 do YAML efetivo. A fonte de capacidades conserva seu próprio SHA-256 no recibo. O attachment T3 continua separado, com seu contrato de token/tab, e exige full access; misturá-lo ao perfil geral é rejeitado.

### Alternativas confrontadas

| Alternativa | Evidência | Escolha |
| --- | --- | --- |
| Integrações nativas Codex e do próprio CLI | Chamadas privadas reais nas duas rotas; `app/installed` isolado também reportou Linear callable, mas não foi usado como prova da chamada | Preferida para os papéis Codex vigentes. |
| CLI Grok com skill acessível | Execução real e efeito exato; MCP geral era rejeitado pelo adaptador antes da inferência | Conservar esta rota quando suas ferramentas bastam. |
| Ampliar o attachment ACP existente para HTTP e sandbox por tarefa | Antes: mesma solicitação rejeitada com exit 64. Depois: operações MCP e efeitos reais, inclusive controle negativo de escrita | Menor adaptação escolhida. Usa a mesma sessão nova, parser, catálogo, cancelamento e coleta do T3. |
| Injetar fontes pelo overlay `GROK_CONFIG` ou criar relay dos conectores da conversa | A documentação local de Grok 1.0.46 restringe o overlay a configurações suaves e impede novas fontes. Nenhuma chamada Codex exigiu relay | Overlay não é rota de attachment. Relay/OAuth próprio não foi implementado sem necessidade concreta. |

Não surgiu uma arquitetura nova: a extensão usa o transporte e o attachment já exercitados pelo port. As alternativas executadas foram o CLI existente e o ACP estendido, com o mesmo Grok configurado; a preferência não foi decidida apenas por descrição de ferramentas.

## Provas retidas

Raiz privada: **`/Users/victorbaccega/.codex/artifacts/codex-capabilities-front-b-20261008/`**. Contém prompts, perfis, streams, recibos, comandos, hashes e resultados originais. `baseline.json` registra base, contratos lidos, configuração da raiz e hash da sheet. Dados privados de conectores não foram publicados no repositório.

| Exercício | Sessão | Operação observada |
| --- | --- | --- |
| `native/` | `01a11c58-0fa9-70f0-828b-33e397bd4767` | Spawn fresco Sol `xhigh`; `linear_get_document(668a922674a8)` retornou o documento; `github_fetch_file` leu `AGENTS.md` no SHA inicial, conferido contra `git show`; leitura da skill de verificação e `npm run verify -- doctor`, exit 0. |
| `external-codex/` | `01a11c5a-7bb5-7931-b112-8025663b293a` | CLI Sol `xhigh`: `codex_apps.linear.get_document` (`item_6`), `front_b_docs.search_openai_docs` e `fetch_openai_doc` (`item_8`), todos completed/error null e conteúdo não vazio; skill produziu exatamente SHA-256 do seed mais newline. |
| `grok-cli-skill/` | `01a11c63-9627-70c2-b3d8-456af3267209` | CLI Grok `4.7@xhigh`: leitura do SKILL.md, cálculo e arquivo com hash exato. Updates do ID correto foram copiados antes de serem interpretados. |
| `grok-acp-write/` | `01a11c63-7ed9-7a90-a077-68c4ebe77fa3` | ACP sandbox `workspace`: skill com hash exato; `pstack_docs.search_openai_docs` e `fetch_openai_doc`, ambos `MCP/OkayOutput` não vazio. |
| `grok-acp-read/` | `01a11c63-9669-7a62-b1bb-cbf330bc7d28` | ACP sandbox `read-only`: as duas consultas MCP retornaram `OkayOutput`; hash calculado por ferramenta; tentativa de criar `forbidden.txt` recebeu PermissionError/exit 1; arquivo continuou ausente. |
| `final-codex/` | `01a11c69-e790-7650-9b7c-ebdbd241cda4` | Candidato limpo: skill com efeito exato, MCP search/fetch e Linear privado (`item_4`, argumento `id: 668a922674a8`, identidade retornada conferida). |
| `final-grok-web-mcp/` | `01a11c69-ebc2-7251-8acb-a1d64b36c28d` | Candidato limpo: skill com efeito exato, MCP search/fetch e WebFetch nativo completed com conteúdo da documentação oficial. `web-assertions.json` conserva a inspeção do resultado, não apenas o nome da ferramenta. |
| `final-grok-readonly/` | `01a11c73-be8b-7e30-a659-acb63cae0d42` | Após a revisão: skill lida com sucesso, MCP search/fetch e execução exata de `python3 readonly-probe.py`; o mesmo resultado terminal contém digest e PermissionError/exit 1. `forbidden.txt` permanece ausente; `denied-write.json` preserva a chamada. |

As provas Codex iniciais exercitaram a base limpa `75d0228`. Os três exercícios Grok acima são provas de **working tree**, com HEAD `e58e85de` e digest **`e4eaaced808aefbc74bb7663e2480cf8ed8e7b360d3bd002c8038cf91532bd61`**. Seus manifests `source.json` identificam todos os bytes exercitados; não se apresentam como prova só do commit. O runner nesses manifests corresponde ao commit de implementação. O script de reprodução recebeu depois asserções explícitas dos resultados MCP além dos localizadores de chamadas; as respostas originais foram inspecionadas pela raiz.

Os perfis ACP usados têm hashes `c62a16ac5140cac6328458757ccd79a53f439f75cb72cccab9145c3e73433f60` (workspace) e `7fa88caf8f98be94159c18541bfe72160e0fecbaf92f78431a38201a2805e3e3` (read-only). Esses hashes comprovam o perfil gerado, não todos os plugins ou instruções ambientais. Os recibos Grok reportam `grok-4.7-build`, `modelEvidence: provider-report`, `modelVerified: true`; não há atestação equivalente de esforço servido.

`final-codex/` e `final-grok-web-mcp/` vinculam-se ao commit limpo **`73d61fda700f75774c18115b49d640d4816ab153`**, digest **`f8d10e6c1306c9b132af05ef80425e720f848e4c0986169dbdd53acecfbb91ec`**. A prova Grok após a revisão vincula-se a **`5dc92767730a6ee6934b964bd8e72f49d693570d`**, digest **`2ac71594b5329d356b8d7e0b6c42774c21186b0c1694c7a5fa315626cc112cc1`**. Os manifests descrevem o candidato inteiro; os bytes do runner são iguais nos dois commits.

Uma prova adicional **não passou**: `final-codex-readonly/`, sessão `01a11c73-ba4e-74e0-8609-ed2cc6eabda7`, no mesmo `5dc9276`. A sessão concluiu e as chamadas MCP/Linear tiveram resultados, mas o stream não contém uma execução terminal correspondente à negação narrada pelo agente. `assertions.json` corretamente rejeita essa ausência; `receipt.status: complete` não a transforma em prova completa. A causa da ausência no stream não foi estabelecida. Esse exercício não sustenta uma afirmação de negação de escrita no Codex; a prova Codex de skill com efeito continua sendo `final-codex/`. Não houve repetição para substituir esse resultado.

## O que os CLIs atestam

| Camada | Codex 0.161.0 / nativo | Grok 1.0.46 |
| --- | --- | --- |
| Pedido | Argv `--model` e `model_reasoning_effort`; spawn explícito com modelo/effort | CLI flags ou ACP `session/set_model` com `modelId`/`reasoningEffort` |
| Configuração | `Thread.model`/`reasoningEffort`, config/read e turn_context. Schema diz expressamente que Thread não é telemetria de execução por turno | Resposta de seleção aceita o modelo; o esforço enviado permanece pedido quando não há confirmação específica |
| Relato de execução | Stream JSON do exec tem thread, ferramentas, conclusão e uso, sem modelo/esforço servido | Uso terminal `modelUsage` reporta `grok-4.7-build`, conferido contra a matriz |
| Limite | Metadados locais e resumo do agente não atestam o backend | Modelo reportado não atesta esforço; tokens não permitem inferi-lo |

`attestation/` conserva schema gerado pelo executável instalado, captura somente leitura do app-server e metadados locais selecionados. `ModelVerificationNotification` é verificação de conta para acesso cyber, não identidade de modelo. `ModelReroutedNotification` cobre reroutes específicos; não confirma o caminho normal nem seu esforço. A sessão externa efêmera não deixou configuração persistida: o capturador não preencheu a ausência com metadados de outra sessão. `app/list` atingiu seu limite explícito de 25 segundos; o resultado parcial permanece e não foi refeito. `app/installed` respondeu, e a chamada real do runner confirmou acesso ao Linear.

## Reprodução

Com CLIs autenticados e Node 24, em um checkout do candidato, execute a [prova de fontes](../../scripts/prove-runner-sources.ts). Ela reutiliza captura e vínculo de fonte do verificador, reserva diretório novo, gera skill/seed privados, lança uma sessão e conserva as saídas antes de interpretar. Sem `--working-tree`, exige candidato limpo. Use diretório pai existente e um destino novo para cada tentativa; execute pelo handle persistente do host, sem timeout arbitrário.

```sh
node scripts/prove-runner-sources.ts --route codex-cli \
  --model gpt-6.1-sol --effort xhigh --linear-document 668a922674a8 \
  --output "$HOME/front-b-codex-proof"
node scripts/prove-runner-sources.ts --route grok-cli \
  --model grok-4.7 --effort xhigh --output "$HOME/front-b-grok-skill"
node scripts/prove-runner-sources.ts --route grok-acp \
  --model grok-4.7 --effort xhigh --output "$HOME/front-b-grok-mcp"
node scripts/prove-runner-sources.ts --route grok-acp \
  --model grok-4.7 --effort xhigh --mode read-only \
  --output "$HOME/front-b-grok-readonly"
```

Para read-only, o destino deve ficar fora de `/tmp`, `/var/tmp`, do temporário do sistema e de `~/.grok`, que o sandbox Grok mantém graváveis. O script rejeita essas localizações, incluindo aliases por symlink, antes de lançar o modelo. A prova exige a execução exata de um script controlado pelo parent e seu resultado terminal de negação; texto do agente não conta.

O documento privado só é consultado quando `--linear-document` é fornecido; requer a conexão autenticada do próprio Codex CLI. O MCP público usado é `https://developers.openai.com/mcp`. Consulte `source-calls.json` e os resultados originais para conferir conteúdo e alvo, além de `assertions.json`. `--web` acrescenta uma chamada web nativa cuja conclusão deve ser inspecionada no stream. O comando não instala plugins, provisiona OAuth nem muda a sheet.

### Validação do tooling de prova

A ferramenta atual valida o JSON externo nos campos que consome. Receipt, eventos, argumentos e resultados inválidos produzem erro com o campo ou a linha, sem coerção de texto, booleanos ou objetos. Depois de reservar o diretório, falhas de preparação, parsing e validação também gravam `assertions.json` com `status: failed`. Receipt e streams originais permanecem na pasta; o CLI Grok conserva a cópia dos updates da própria sessão. Um destino indisponível não permite gravar esse diagnóstico.

`source-calls.json` conserva os argumentos e o resultado junto da fonte, ferramenta e ID da chamada. No Grok, os argumentos vêm dos updates anteriores com o mesmo `toolCallId`; o nome pedido deve corresponder à fonte/ferramenta retornada. A ausência desses argumentos não é preenchida com os de outra chamada.

A busca pública exige uma query sobre Codex/MCP e hits com URLs HTTPS nos hosts documentais OpenAI conhecidos (`developers.openai.com`, `platform.openai.com`, `learn.chatgpt.com`). O fetch deve pedir uma página desses hits de uma busca anterior e retornar Markdown com título e corpo, sem erro. Quando há resposta estruturada com `url` e `content`, a URL retornada também deve corresponder; texto JSON e `structuredContent` não podem contradizer a identidade. Fragmentos de URL são ignorados na comparação da página.

O Markdown simples de `fetch_openai_doc` não identifica a página retornada. Nesse formato, `docsEvidence.identity` registra `unavailable-in-markdown`: a prova confirma a chamada correlacionada e o corpo documental, mas não atesta a identidade da resposta. Não infere essa identidade de links no corpo. Formatos fora dessas formas conhecidas exigem adaptação e fixtures; conteúdo não vazio, sozinho, não estabelece sucesso.

O documento privado exige `content` não vazio e identidade retornada correspondente ao alvo pedido: `id`, `slugId` ou URL completa. Um ID curto precisa do `slugId` retornado; apenas aparecer nos argumentos ou em texto livre não basta. `privateDocument` registra a identidade conferida. Esta validação cobre somente as operações atribuídas pela ferramenta, não audita transcripts arbitrários nem comprova isolamento de MCP.

Essas regras são melhoria opcional N3 identificada independentemente na auditoria. Não revalidam as provas históricas nem convertem a prova Codex readonly incompleta em sucesso. A verificação do tooling usa fixtures locais, sem repetir chamadas autenticadas.

Para repetir a prova nativa, despache um helper fresco `gpt-6.1-sol`, esforço `xhigh`, sem histórico herdado, forneça os caminhos absolutos da skill e do checkout, e peça as operações Linear/GitHub da tabela. Conserve o resultado das ferramentas e seu rollout; a resposta final do helper não basta. Na sheet vigente esse é um explorador, não um swarm worker.

## Contratos disponíveis e lacunas restantes

- Disponíveis: [provider-dispatch](../../skills/poteto-mode/references/provider-dispatch.md), [codex-tools](../../skills/poteto-mode/references/codex-tools.md), [runner-capabilities](../../skills/poteto-mode/references/runner-capabilities.md), perfis HTTP por tarefa e reprodução acima. Contratos de CLI alterados estão em `cli-touchpoints.json`.
- O Grok local não tinha fontes MCP configuradas (`grok mcp list --json` retornou `[]`). Esta frente comprovou seu attachment HTTP público, não OAuth privado Grok nem herança das conexões Codex. Quando a tarefa exigir uma fonte privada no Grok, prove a autenticação desse caminho. Grounding obtido pelo parent serve para análise de evidência fornecida, mas não substitui consultas diretas ou conferência de citações exigidas pelo papel.
- `source.tools` no Grok é escopo solicitado no brief, não allowlist imposta. MCPs ambientais continuam confiados; sandbox de filesystem não limita mutações remotas. Um requisito de isolamento imposto por ferramenta/fonte precisa de um runtime/servidor que o forneça.
- Com `CODEX_SANDBOX` presente, Grok usa `none` e herda a contenção externa. Esse marcador não informa se o parent é read-only ou workspace-write. A prova de negação acima usa o sandbox Grok read-only próprio. Não autoriza alegar confinamento read-only sob qualquer parent.
- Owners Grok externos continuam sem suporte. A configuração atual usa owners Codex; não se altera modelo para contornar essa lacuna. Plugins com dependências não exercitadas, closure nativo e Autopilot integrado continuam fora da cobertura desta prova.

## Verificação do candidato

A skill indicada por AGENTS.md foi lida e `verify doctor` executado. Checks afetados: `runner-contracts` para as rotas e recibos; `repository-contracts` para contratos de instruções, touchpoints, paridade upstream e o parser da prova. As provas reais acima complementam esses checks; fixtures não substituem chamadas a fontes.

- **`runner-contracts`: 1.065 passaram, zero falhas**, no commit limpo `469be3eb5f83924a75e4d22b193237eb1c0f1494` do implementador. Recibo terminal e revalidação em `runner-contracts/receipt.json`, copiados de `/tmp/front-b-runner-contracts-20261008-02/`; `commands/0009-contracts/` conserva stdout/stderr/comando. `git diff 469be3e 5dc9276 -- skills/poteto-mode/scripts/runner` é vazio: a prova cobre os bytes entregues do runner. O tempo inclui retries de autenticação das fixtures, não mede desempenho de inferência.
- **`repository-contracts`: 237 passaram, zero falhas**, no commit limpo `5dc9276`, com revalidação de fonte em `final-repository-contracts/receipt.json`. Inclui três regressões novas: prosa não substitui execução/negação correlacionadas; resultados não podem ser misturados entre chamadas; localização read-only rejeita exceções graváveis e symlinks. A rodada anterior em `73d61fd` passou 234 testes e permanece em `repository-contracts/`.
- A revisão independente usou uma sessão nova `gpt-6.1-sol@max`, `01a11c6a-b14b-7b01-a45e-ca1a641c0e7c`, sobre `75d0228..73d61fd`. `review/` retém brief, diff examinado, stream, recibo e os dois P2: falso positivo de negação por texto e exemplo read-only em `/tmp`. Ambos foram corrigidos em `5dc9276`, cobertos pelas regressões e pela prova real Grok posterior. A raiz reviu a correção; não se atribui uma segunda aprovação ao revisor.
- Classificação final em `delivery-classify/` registra todos os caminhos da entrega. `git diff --check` e TypeScript strict do runner e do script de prova passaram. `AGENTS.md`, `UPSTREAM.md`, `model-matrix.json` e a sheet pessoal permanecem inalterados. O commit final do relatório apenas registra estes resultados; não altera os bytes exercitados.

A tentativa de desenvolvimento `/tmp/front-b-runner-contracts-20261008-01/` foi mantida e copiada para `runner-contracts-development-failed/`: dois testes expuseram a leitura tardia do marcador de sandbox externo, corrigida antes da prova limpa. A execução supersedida foi cancelada explicitamente pelo seu dono; não é um resultado de aprovação. As tentativas parciais de inspeção app-server e de prova read-only Codex também foram conservadas, com seus limites descritos acima.

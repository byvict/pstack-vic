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

As provas Codex iniciais exercitaram a base limpa `75d0228`. Os três exercícios Grok acima são provas de **working tree**, com HEAD `e58e85de` e digest **`e4eaaced808aefbc74bb7663e2480cf8ed8e7b360d3bd002c8038cf91532bd61`**. Seus manifests `source.json` identificam todos os bytes exercitados; não se apresentam como prova só do commit. O runner nesses manifests corresponde ao commit de implementação. O script de reprodução recebeu depois asserções explícitas dos resultados MCP além dos localizadores de chamadas; as respostas originais foram inspecionadas pela raiz.

Os perfis ACP usados têm hashes `c62a16ac5140cac6328458757ccd79a53f439f75cb72cccab9145c3e73433f60` (workspace) e `7fa88caf8f98be94159c18541bfe72160e0fecbaf92f78431a38201a2805e3e3` (read-only). Esses hashes comprovam o perfil gerado, não todos os plugins ou instruções ambientais. Os recibos Grok reportam `grok-4.7-build`, `modelEvidence: provider-report`, `modelVerified: true`; não há atestação equivalente de esforço servido.

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

Para repetir a prova nativa, despache um helper fresco `gpt-6.1-sol`, esforço `xhigh`, sem histórico herdado, forneça os caminhos absolutos da skill e do checkout, e peça as operações Linear/GitHub da tabela. Conserve o resultado das ferramentas e seu rollout; a resposta final do helper não basta. Na sheet vigente esse é um explorador, não um swarm worker.

## Contratos disponíveis e lacunas restantes

- Disponíveis: [provider-dispatch](../../skills/poteto-mode/references/provider-dispatch.md), [codex-tools](../../skills/poteto-mode/references/codex-tools.md), [runner-capabilities](../../skills/poteto-mode/references/runner-capabilities.md), perfis HTTP por tarefa e reprodução acima. Contratos de CLI alterados estão em `cli-touchpoints.json`.
- O Grok local não tinha fontes MCP configuradas (`grok mcp list --json` retornou `[]`). Esta frente comprovou seu attachment HTTP público, não OAuth privado Grok nem herança das conexões Codex. Quando a tarefa exigir uma fonte privada no Grok, prove a autenticação desse caminho. Grounding obtido pelo parent serve para análise de evidência fornecida, mas não substitui consultas diretas ou conferência de citações exigidas pelo papel.
- `source.tools` no Grok é escopo solicitado no brief, não allowlist imposta. MCPs ambientais continuam confiados; sandbox de filesystem não limita mutações remotas. Um requisito de isolamento imposto por ferramenta/fonte precisa de um runtime/servidor que o forneça.
- Com `CODEX_SANDBOX` presente, Grok usa `none` e herda a contenção externa. Esse marcador não informa se o parent é read-only ou workspace-write. A prova de negação acima usa o sandbox Grok read-only próprio. Não autoriza alegar confinamento read-only sob qualquer parent.
- Owners Grok externos continuam sem suporte. A configuração atual usa owners Codex; não se altera modelo para contornar essa lacuna. Plugins com dependências não exercitadas, closure nativo e Autopilot integrado continuam fora da cobertura desta prova.

## Verificação do candidato

A skill indicada por AGENTS.md foi lida e `verify doctor` executado. Checks afetados: `runner-contracts` para as rotas e recibos; `repository-contracts` para contratos de instruções, touchpoints e paridade upstream. Classificação, recibos terminais e prova final são registrados nesta seção ao concluir a verificação. As provas reais acima complementam esses checks; fixtures não substituem chamadas a fontes.

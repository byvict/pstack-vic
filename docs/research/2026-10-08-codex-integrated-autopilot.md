# Execução integrada do Autopilot com raiz Codex

Data do programa, 2026-10-08. Esta frente D combina as provas de A, B e C num programa real de Autopilot-stack. A referência é o [documento de pendências da raiz Codex](https://linear.app/clinextapp/document/pendencias-de-raiz-codex-apos-os-prs-99-105-2026-10-08-668a922674a8), itens 1, 5, 6, 7, 8 e 9.

Este relatório separa fatos já observados das condições conferidas pela raiz na entrega. O programa continua ativo neste snapshot. As revisões finais e o encerramento são condições explícitas. Um recibo de invocação completa não encerra a tarefa.

## Base e instruções exercitadas

O SHA inicial é `617ea1a10dc7bd994fdccc3f69bc1258793a41a3`. Essa base contém A, PR #110, C, PR #108, e B, PR #112. O [relatório de A](2026-10-08-codex-front-b.md) mantém seu nome histórico. Os [relatórios de B](2026-10-08-codex-capacity-renewal.md) e [C](2026-10-08-codex-wake-lifecycle.md) permanecem entradas distintas.

A raiz exata é `01a11cfe-4162-7f70-9bc3-dbbed8be4e27`. `baseline/root-metadata.json` registra `gpt-6-astra`, esforço `xhigh`, no Codex Desktop `0.162.0-alpha.2`. Os executáveis capturados em `baseline/` são Codex CLI `0.161.0`, Claude Code `2.1.292`, Grok `1.0.46` e Node `24.21.0`. São fatos de configuração e versão. Não atestam o modelo ou esforço servido pelo backend.

A evidência privada do programa fica em `/Users/victorbaccega/.codex/artifacts/codex-integration-d-20261008/`. Os caminhos relativos desta página apontam para essa raiz quando nomeiam capturas privadas. Eles permitem reprodução local pelo operador e não publicam conteúdo de conectores.

A instalação comparada é `/Users/victorbaccega/.codex/plugins/cache/pstack-vic/pstack/0.5.25`. A raiz lê os playbooks instalados nas auditorias. Owners leem e seguem os arquivos do candidato pelo mapeamento Codex suportado. Esse mecanismo não instala o candidato nem recria hooks ou comandos de outra plataforma. `baseline/source.json` identifica hashes antes do programa. Cada owner conserva seus próprios hashes.

O pin Cursor permanece `4e5b1cf2ccb0ea3716f08c8ee0a5856b5ab93536`, pstack `0.15.10`. Os originais comparados estão em `baseline/upstream/`. O [ADR 0005](../adr/0005-autopilot-substitui-converge.md) permite adaptações de plataforma. Sua cadência histórica de 30 minutos não substitui a hora exigida pelo playbook vigente. A configuração conserva `swarm workers: codex:gpt-6.1-sol@high`.

## Programa real e sequência observada

D1 é o owner nativo `/root/owner_contracts`, descritor `codex:gpt-6.1-sol@xhigh`, em worktree próprio. Seu filho `/root/owner_contracts/source_contracts` usa `codex:gpt-6.1-sol@high`. `native/owner-contracts/children.tsv` e as capturas de auditoria registram o filho e sua coleta. A correção inicial está em `4a94af54ca033cfe85f421e3cc92245d4daf45f5`, [PR #114](https://github.com/byvict/pstack-vic/pull/114). A rodada recebeu ISSUES. A correção agrupada produziu `b14b6cfd61b51de48ed8865a1fcd38f39aac273e`. Ela separa watcher dinâmico e auditoria fixa, explicita lifecycle do heartbeat e delimita socket e ponte loopback ao controlador CLI. A revisão da nova rodada continua distinta do resultado anterior.

D2 é um contexto novo, `/root/owner_report`, com `codex:gpt-6.1-sol@xhigh`, worktree `/Users/victorbaccega/.codex/worktrees/codex-d-report/pstack-vic`, branch `codex/d-integrated-report`. O parent inicial foi `4a94af54ca033cfe85f421e3cc92245d4daf45f5`. O primeiro snapshot `504cd1c7c6e53b8e1e75fe8fba27b42f423979ea` abriu o [PR #115](https://github.com/byvict/pstack-vic/pull/115) ready antes da prova própria. Somente a raiz altera a topologia. Ela reaplicou o snapshot em `b14b6cfd61b51de48ed8865a1fcd38f39aac273e`, produzindo `e142ff3918ffed95caacdd13c9a6bf5e7a0f1e79`, com diff do relatório byte a byte igual. `topology-d2-rebase1/` conserva inspeção remota e push com lease. Esse preparo não é um veredito de append. O helper Sol `high` permaneceu enfileirado até a raiz coletar `d1_gates`. Seu spawn fresco posterior está em `native/owner-report/helper/spawn.json`. A espera não foi uma rejeição de spawn e não mudou o descritor.

A janela anunciada tem quatro slots, incluindo a raiz e descendentes. `handles.json` conserva o inventário histórico. `list_agents` é reconciliado com esse inventário, os processos persistentes e cada `children.tsv`. Nenhum `close_agent` é anunciado. Um resultado coletado conserva seu handle sem alegar fechamento administrativo.

O programa usa Autopilot-stack. Owners abrem PRs ready, executam suas verificações e reportam os SHAs. A raiz reúne revisões independentes e decide se cada rodada entra na cadeia. Nenhum owner mergeia, fecha PR ou arma auto-merge.

O helper D2 `/root/owner_report/source_reconciliation` retornou e foi coletado. Seu contexto novo Sol `high` chamou Linear diretamente e recebeu o UUID esperado. A consulta GitHub retornou o blob `eab2771f4410e0436d4bf6f861ad71a80b6d5bbe`; os bytes conferem com `AGENTS.md` no SHA inicial. O owner inspecionou os resultados originais e os 19 hashes do manifesto, além da matriz completa. `native/owner-report/helper-collection.json` registra a coleta e zero processos ou descendentes pendentes do helper. O handle nativo permanece retido.

## Dois turnos de auditoria após o término da raiz

O heartbeat `d-autopilot-integration-audit` aponta para o UUID exato da raiz. O payload salvo difere do arquivo somente pela remoção do newline final. `audits/native-payload-assertions.json` conserva os dois hashes e confirma conteúdo equivalente após esse whitespace final. O ensaio usa intervalo acelerado de um minuto. A cadência de produção continua sendo uma hora. `audit-payload.md` conserva o payload integral, incluindo owners, children, trilhas, efeitos, lanes travadas e condição de encerramento.

O turno inicial terminou às `19:34:45.107Z`. A primeira auditoria começou às `19:35:33.198Z`, turno `01a11d03-883f-7f70-bd95-1b8221021192`, e terminou às `19:36:57.170Z`. A recorrência começou às `19:37:03.197Z`, turno `01a11d04-e7d0-73c3-a1b0-d8c0538bccaf`. `audits/after-second-turn-events.json` conserva essa sequência. O arquivo ainda não registra o término do segundo turno naquele snapshot. A captura posterior `audits/after-third-start-events.json` confirma seu término às `19:47:43.191Z` e o início da terceira auditoria às `19:48:03.225Z`. A duração do segundo turno adiou a recorrência seguinte. O intervalo acelerado não significa turnos sobrepostos nem uma hora de produção exercitada.

`audits/001-audit.json` e `002-audit.json` registram efeitos sobre owners reais. Ambos conferem trilhas e children. A primeira observa arquivos de instrução sujos. A segunda observa o head `4a94af54ca033cfe85f421e3cc92245d4daf45f5`, checkout limpo e PR #114 real. A terceira, `003-audit.json`, também registra Linear, GitHub, doctor e os dois owners em andamento. Cada turno chamou Linear para `668a922674a8`, retornou a identidade esperada e leu `AGENTS.md` no GitHub no SHA inicial. O conteúdo GitHub confere com o checkout. Os resultados originais ficam em `001-source-0.json`, `001-source-1.json`, `002-source-0.json` e `002-source-1.json`.

As duas execuções de `verify doctor`, `001-source-2.json` e `002-source-2.json`, retornaram exit 0 no candidato D1. Doctor prova disponibilidade das receitas. Não substitui a suíte nem a revisão. O tick decidiu continuar porque havia delegação e entrega pendentes. Nenhuma lane ficou travada nesse snapshot. A substituição de uma lane travada continua não executada.

A quarta auditoria, `004-audit.json`, registra o turno `01a11d16-5206-7f81-98c7-b568542089c0`, observado às `20:00:13.068Z`, após o yield da terceira. Ela conferiu o candidato D1 `b14b6cfd61b51de48ed8865a1fcd38f39aac273e`, checkout limpo, CI test SUCCESS e PR #114 OPEN. Os originais `004-source-0/1/2.json` confirmam Linear, bytes GitHub do SHA inicial e doctor exit 0. Esse snapshot comprova execução no turno despertado com o candidato novo. Não antecipa seu evento de término.

## Disposição por pendência neste snapshot

| Item | Disposição | Alcance e limite |
| --- | --- | --- |
| 1 | Resolvida por prova para continuidade neste host. | B prova rejeição controlada e nova admissão após uma conclusão. D continua com owners e revisores frescos em ondas. Closure administrativo, quota global e retenção longa continuam abertos. |
| 5 | Resolvida por prova para despertar no desktop. | D observa o primeiro turno após o término da raiz e a recorrência no mesmo UUID, com chamadas e efeitos. Stop final ainda depende do recibo terminal. |
| 6 | Alternativa comprovada por C. | A fila local conserva aceitação, consumo, conclusão, efeito, cancelamento e reconciliação sem replay. D escolhe heartbeat e não repete os cenários CLI. |
| 7 | Resolvida por mudança e prova no alcance de A. | Grok externo lê skills e chama HTTP MCP pelo ACP. D usa essa rota no painel. OAuth privado, herança geral de conectores e owner Grok externo continuam sem comprovação ou suporte. |
| 8 | Resolvida por prova para as fontes Codex atribuídas. | A e B provaram Linear e GitHub em contextos frescos. D conserva consultas diretas dos owners e dos turnos despertados. Outras fontes exigem suas próprias chamadas. |
| 9 | Ainda aberta até a entrega final integrada. | O programa real, auditorias e coleta dos helpers têm evidência. Verificação final, painel completo, cadeia e encerramento continuam condições de entrega. Ausência de atestação backend continua um limite documentado, sem novo gate. |

## Verificação e limites de cobertura

O recibo D1 `native/owner-contracts/verify-1/receipt.json` registra 242 testes de `repository-contracts` que passaram. `native/owner-contracts/verify-2/receipt.json` também registra 242 testes que passaram no commit limpo `b14b6cfd61b51de48ed8865a1fcd38f39aac273e`, digest `47cbe3436ca23a5ec4d3a1fcfc346983f74a8ff0cc927544fe9ab0d6709b88bf`. A revisão e os gates independentes permanecem separados dessa prova própria. D2 executa sua receita sobre o relatório final. Os recibos de entrega vinculam o resultado ao SHA efetivamente conferido, sem promover esta frase a um resultado antecipado.

A configuração do painel Interrogate é Sol `xhigh`, Claude `xhigh` e Grok `4.7@xhigh`. A raiz conserva os recibos externos e usa fonte HTTP explicitamente atribuída. Uma lane concluída precisa ter seus resultados e efeitos inspecionados. A declaração do helper ou o catálogo de ferramentas não são prova de acesso. A revisão de uma fonte requer seu resultado original ou uma operação diretamente conferida no stream.

Owners externos não foram necessários nem executados. A prova do reviewer externo de B não prova delegação de owner headless. O cenário de interrupção por ordem do operador também não foi executado. Os controles de B e as fixtures de C mantêm suas atribuições originais.

O encerramento é uma condição explícita de entrega. A raiz deve produzir `closure/final-receipt.json` após coletar toda delegação, parar a agenda exata, observar o próximo intervalo sem outro tick e confirmar zero processos próprios pendentes. O relatório não afirma que esse recibo já existe ou passou. O veredito final da raiz deve conferir esse recibo, os SHAs da cadeia, os checks e as revisões antes de encerrar o item 9.

## Matriz da solicitação completa

Cada linha delimita o que o programa demonstra. Uma condição de entrega é conferida pela raiz no recibo terminal e não é antecipada como fato deste snapshot.

| Requisito | Resultado observado ou condição | Evidência |
| --- | --- | --- |
| Astra como raiz Codex. | Configuração local `gpt-6-astra@xhigh`, Desktop `0.162.0-alpha.2`. | `baseline/root-metadata.json`. |
| Atualizar main e confirmar A, B e C antes dos worktrees. | Base inicial `617ea1a10dc7bd994fdccc3f69bc1258793a41a3`, com PRs #110, #108 e #112. | `baseline/status.json`, histórico e relatórios de entrada. |
| Worktrees próprios para autoria. | D1 e D2 têm diretórios e branches próprios. O cwd herdado do host é distinto. Os comandos escolhem explicitamente o worktree atribuído. | `program.json`, `handles.json`, metadados dos owners. |
| Ler AGENTS.md, UPSTREAM.md, ADR 0005 e os cinco contratos. | Caminhos e hashes atribuídos a cada executor. | `baseline/source.json`, `native/owner-report/instruction-hashes.json`, manifests D1 e helper. |
| Ler A, B e C sem alterar os relatórios. | Provas anteriores são entradas, com nomes e bases preservados. | Relatórios versionados, hashes de proteção e comparação final. |
| Comparar o pstack original e preservar o pin. | Originais no pin `4e5b1cf2ccb0ea3716f08c8ee0a5856b5ab93536`. | `baseline/upstream/`, `UPSTREAM.md`, recibos de paridade. |
| Preservar configuração, incluindo workers Sol high. | Descritores conservados. Sem uso de fallback de modelo. | `baseline/source.json`, briefs e argv dos runners. |
| Ler dispatch instalado antes de papéis configurados. | Instalação `0.5.25` identificada e comparada. | Capturas de leitura e hashes por executor. |
| Identificar versões, caminhos e hashes antes do exercício. | Desktop e executáveis separados. Cada live attempt conserva fonte, prompt e perfil. | `baseline/`, manifests de owners, `review-d1/manifest.json`. |
| Exercitar instruções candidatas pelo mecanismo suportado. | Leitura e execução explícitas dos arquivos no Codex. Nenhuma instalação do candidato alegada. | Transcripts nativos, manifests e efeitos de PR. |
| Preferir heartbeat exato e distinguir evento CLI finito. | D1 corrige a documentação e o programa usa um heartbeat no UUID da raiz. | PR #114, `baseline/heartbeat-create.json`, `audit-payload.md`. |
| Socket como condição do controlador CLI. | A condição não impede o owner nativo nem o heartbeat. A ponte loopback continua condição do caminho CLI. | Diff D1 e contrato `codex-local-wake.md`. |
| Conservar arquivos gerados pela paridade. | D1 muda referências de runtime. D2 acrescenta somente este relatório. | Diffs e `upstream-parity` real. |
| Escolher e executar o Autopilot adequado. | Autopilot-stack conserva landing pelo operador e topologia pela raiz. | `program.json`, briefs, PRs #114 e #115. |
| Autoria em mais de uma rodada. | D1 tem um primeiro head e uma correção agrupada após findings independentes. D2 tem snapshot inicial e revisão final do relatório. | Commits, pushes, trail e verdicts por rodada. |
| Contextos novos para trabalhos e opiniões independentes. | Owners, helpers e revisores recebem novos contextos. Retomar um autor não produz um voto independente. | Inventário, manifests e metadados dos transcripts. |
| Chamadas bem-sucedidas às fontes atribuídas. | Linear e GitHub nos turnos despertados e no helper D2. HTTP MCP no Grok ACP tem resultados originais. | `audits/*-source-0/1.json`, helper `source-results`, `grok-source-inspection.json`. |
| Owners delegarem e coletarem seus filhos. | D1 e D2 coletaram seus helpers e conservaram inspeções dos resultados e efeitos. | Cada `children.tsv`, resultados e `native/owner-report/helper-collection.json`. |
| Continuidade após a conclusão dos primeiros agentes. | D2 e seu helper entram em uma onda posterior. A admissão B não é tratada como limite universal. | Metadados, slot grant e inventário retido. |
| Término da raiz, despertar e execução da auditoria. | Turno inicial terminado, duas auditorias posteriores concluídas com ferramentas e efeitos. | `audits/after-third-start-events.json`, `native-payload-assertions.json`, auditorias 001/002. |
| Planejar capacidade com operações anunciadas. | Quatro slots anunciados incluem raiz e descendentes. Fechamento não disponível. | Schemas, `handles.json`, listagens e children. |
| Preservar papel e capacidades ao usar rota externa. | Painéis Claude e Grok e worker live Sol mantêm modelo e esforço atribuídos. | Perfis, prompts e receipts externos. |
| Owner transferido provar delegação e coleta headless. | Nenhum owner externo foi necessário ou executado. Essa rota continua sem prova integrada D. | Inventário e ausência de invocação de owner runner. |
| Preservar payload integral e cadência. | Ensaio de um minuto, produção de uma hora. Agenda remove apenas o newline final do arquivo. | `audit-payload.md`, `native-payload-assertions.json`. |
| Auditoria de owners, children, trilhas, efeitos, travados e término. | Payload completo e snapshots reais conferidos. A raiz interveio no gate externo bloqueado e despachou substituto do mesmo descritor. Nenhum owner ultrapassou sua janela sem efeito. | Auditorias, trails e `swarm-d1-round2/gates/root-stop-receipt.json`. Resultado do substituto é condição de entrega. |
| Recorrência ou rearmação após turno terminado. | Recorrência do mesmo heartbeat, com segunda auditoria concluída. | IDs e eventos 001/002. |
| Ferramentas e fontes no turno despertado. | Cada auditoria consultou Linear/GitHub e executou doctor com exit 0. | `native/owner-report/audit-source-inspection.json`, resultados originais. |
| Aceitação, consumo, conclusão, efeito e incerteza CLI. | D usa heartbeat. A prova CLI de C permanece entrada anterior, sem rerun em D. | Relatório C e seus recibos originais. |
| Finalizar agenda e observar stop. | Condição de entrega. Exige delete do ID exato, readback e observação do próximo intervalo sem novo tick. | `closure/final-receipt.json`. |
| Coletar delegações e confirmar processos próprios. | Condição de entrega. Cada child e runner deve estar coletado. Handles nativos continuam retidos. | Inventário final, child collection e closure. |
| Reproduzir falha de integração e corrigir causa mínima. | Review D1 reproduz contradição entre watcher dinâmico e tick fixo. O owner corrige referências de runtime. | Findings agrupados, diff e rodada nova. |
| Preservar configurações e processos de outras sessões. | Somente recursos próprios são encerrados. Hashes finais devem conferir com o baseline. | Snapshots protegidos e closure. |
| Usar verify-pstack-vic para o diff real. | Receita escolhida pelo registry e executada sobre commit limpo. Fixtures não substituem live program. | Recibos de classificação e `repository-contracts`. |
| Conservar tentativas, streams e vínculo de SHA. | Falhas, cancelamentos e PR connector403 permanecem registrados. | Diretórios de cada tentativa, comandos e manifests. |
| Separar pedido, observação e backend. | Codex tem configuração local e pinned argv. Grok/Claude reportam modelo. Esforço servido continua não atestado. | Metadados e receipts, sem novo gate. |
| Relatório D, PRs e resultado por requisito. | Relatório próprio em PR #115, contrato em PR #114, disposição por item e condição terminal explícita. | Página versionada e cadeia final da raiz. |
| Identificar simulação e caminhos não executados. | Fixtures do verificador, controles de B e queue C não viram prova de D. A substituição do gate bloqueado foi exercitada. Owner travado por prazo, operator stop e owner externo não foram exercitados. | Seção de limites e matrizes anteriores. |

## Tentativas preservadas e prova de fonte

A primeira rodada D1 em `4a94af54ca033cfe85f421e3cc92245d4daf45f5` recebeu ISSUES da raiz. Claude e Grok apontaram a ambiguidade que atribuía heartbeat fixo ao watcher dinâmico de Babysit e Shipping. Também apontaram ciclo de vida da agenda incompleto e orientação CLI que podia sugerir armação após o término do turno. Sol não encontrou esses defeitos. O acordo dos outros dois levou a uma correção agrupada. O veredito está em `review-d1/verdict-round1.md`.

As invocações Claude e Grok terminaram, mas uma invocação completa não é aprovação nem prova de cada efeito narrado. Os resultados HTTP MCP do Grok ACP foram inspecionados no próprio stream. O catálogo efetivo inclui outras ferramentas do servidor e pode conservar integrações ambientais. `sources.tools` expressa atribuição. Não impõe uma allowlist universal de conectores. O sandbox read-only de arquivos é uma propriedade separada.

O stream padrão Claude dessa rodada conserva o resumo final. Ele não conserva as chamadas narradas com os resultados originais, por isso D não o usa como prova independente de acesso HTTP MCP. A raiz reproduziu os findings no diff. A limitação de observação não cria um gate de backend.

A primeira execução independente de `repository-contracts` usou TMPDIR dentro de um caminho longo de evidência. Uma fixture produziu um caminho de socket Unix de 119 caracteres. O comando falhou e seu recibo terminou `cancelled`. A tentativa permanece em `swarm-d1/gates/repository-contracts/`. Uma nova tentativa com TMPDIR curto foi autorizada e passou 242 testes, zero falhas, em `repository-contracts-short-temp/`. Essa correção de ambiente não alterou o candidato e não apaga a tentativa anterior.

Na segunda rodada, o gate externo Sol `high` ficou BLOCKED por outra causa: seu sandbox recusou o bind do socket curto com EPERM. O prefixo TAP conserva somente 17 testes que passaram, sem footer final; o recibo do verificador ficou incompleto. A lane não conseguiu sinalizar o próprio grupo de testes `63070`, também por EPERM. A raiz enviou SIGTERM ao grupo exato às `20:03:21.767Z` pelo desktop supervisor. O recibo imediato ainda via o processo e não prova sua saída. `swarm-d1-round2/gates/report.md`, `observed-tool-errors.json` e `root-stop-receipt.json` preservam a tentativa. A raiz despachou um contexto nativo novo `/root/d1_gates_r2_replacement`, com o mesmo Sol `high` e saída separada `swarm-d1-round2/native-gates/`. A saída do grupo antigo e o resultado do substituto precisam ser conferidos na entrega. Essa intervenção não encerrou o host compartilhado.

O worker live Sol da segunda rodada terminou com ISSUES de independência: a extração de transcript expôs resumos de outros agentes em resultados de `list_agents`. `swarm-d1-round2/live-result.md` não encontrou defeito no diff, mas não conta como voto cego limpo. Suas fontes e observações de lifecycle continuam evidência atribuída. A raiz pediu outro reviewer novo restrito ao diff. O veredito final continua pendente neste snapshot.

O criador nativo de PR retornou403 `Resource not accessible by integration` para D2. O resultado está em `native/owner-report/pr-create-connector-1.json`. O owner abriu o PR ready pelo forge gh autorizado e conferiu `isDraft: false`, antes da prova própria. D1 também conserva o403 do conector de atualização. Não se atribui sucesso a esses conectores.

O primeiro teste de igualdade exata do payload salvo falhou. O host removeu o newline final. A comparação posterior confirmou todos os caracteres restantes e os dois turnos pós-yield concluídos. Os hashes do arquivo e do payload salvo continuam distintos em `native-payload-assertions.json`. Essa normalização não muda o payload de auditoria.

A primeira execução do script privado de inspeção do helper falhou porque o Python do sistema não tinha `tomllib`. `helper/inspection-attempt-1.json` conserva essa tentativa. O helper substituiu o parse por uma leitura sem dependência, sem repetir chamadas de fonte ou o programa live. O utilitário da raiz `capture-audit.py` recebeu seu hash isolado antes da auditoria posterior em b14. Esse registro não prova que o utilitário foi hashado antes das auditorias iniciais. A base e a ancestralidade A/B/C foram conferidas; o helper não reconstruiu independentemente a cronologia inicial de fetch e criação de worktrees.

O requisito de revisão da trilha permanece com a raiz. As trilhas não são incorporadas ao Git deste PR. O transcript D2 é `/Users/victorbaccega/.codex/sessions/2026/10/08/rollout-2026-10-08T16-44-49-01a11d0c-04c2-7c72-a4ff-2e50ddae8322.jsonl`. Seus metadados confirmam a configuração local Sol `xhigh`. O helper tem transcript e metadados próprios. Cada owner retorna sua trilha e seu transcript. Uma opinião Sol sobre uma raiz Astra é do mesmo provider. Somente uma lane nova de outro provider, escolhida pelo pool, satisfaz a revisão cruzada. Os verdicts finais e seus receipts são conferidos no encerramento.

## Caminhos que esta execução deixa abertos

Não houve transferência de owner para runner, prova de owner Grok externo, OAuth privado Grok ou herança geral de todos os plugins e conectores. D comprova operações nomeadas em rotas nomeadas. O reviewer externo de B prova revisão e fontes daquele papel.

A falha EPERM do gate externo exigiu intervenção da raiz e substituição por uma lane nativa do mesmo descritor. O ramo de owner sem efeito após seu prazo não foi acionado. Nenhuma ordem de stop do operador foi emitida. O programa conserva esses ramos no payload e os distingue da intervenção realmente executada. O fechamento administrativo de handles, quota global e dezenas de ondas continuam não medidos.

`CONTEXT.md` e o campo histórico `reason` de uma substituição ainda têm referência ao tick manual Codex. Esse texto anterior ao patch permanece fora do recorte de dois contratos. A orientação runtime corrigida e o contrato de wake concentram o mecanismo vigente. O pin e os playbooks gerados não avançam para ocultar a inconsistência.

O heartbeat exige o host disponível. D não prova continuação após fechar o app ou reiniciar o computador. O ensaio não mede desempenho, capacidade universal ou execução exatamente uma vez através de crashes. A deduplicação e entrega incerta da alternativa CLI pertencem à prova C.

## Hashes das instruções e comandos exercitados

Os hashes abaixo identificam os bytes no parent D1 `b14b6cfd61b51de48ed8865a1fcd38f39aac273e` recebido por D2. O manifesto inicial de D2 conserva os bytes da rodada anterior. `baseline/source.json` conserva os equivalentes da instalação. Os caminhos são relativos ao checkout, salvo indicação contrária.

| Arquivo | SHA-256 no candidato |
| --- | --- |
| `skills/poteto-mode/SKILL.md` | `4a1c2defab74e1f6420cbc470d2d9b4757618309d9cf857bca901dc65b2c7ed2` |
| `skills/poteto-mode/playbooks/autopilot-stack.md` | `8247ed9b949407d5567223e934bf0c5f1c0b5ace856f701f53bee8c5eb7a0002` |
| `skills/poteto-mode/playbooks/autopilot-full.md` | `98e760a4c375bf606727601beacec9edfa9d75bf82990fe104b7243d058657ed` |
| `skills/poteto-mode/references/provider-dispatch.md` | `b4a7f0004b48397362f9635b382c1936732ec214dddc31b43bec5e53bf066212` |
| `skills/poteto-mode/references/codex-tools.md` | `d7a89fff8827d00f6b54314b1f7bdda7c418dc098b7e8693f8f49d8b6b0dd7d4` |
| `skills/poteto-mode/references/codex-local-wake.md` | `8be464cba53a2f593b42ce0a0bdb278a4283c67ae61319ef0feaf45300a40a05` |
| `skills/poteto-mode/references/native-lifecycle.md` | `e250085276bf042fbeaf046fea6f3d0b31185b8ab1b518729a7d31e8e1c9344c` |
| `skills/poteto-mode/references/runner-capabilities.md` | `79f7ddae127538a972c4817ae57fb89107a9e16ff895936aa30bc8dc4590f646` |
| `.claude/skills/verify-pstack-vic/SKILL.md` | `4d79052dc7409cd1c2fd8297dd78e5f770aa13728e15e57d62888c5677370e9c` |
| `skills/poteto-mode/scripts/watch-pr/watch-pr` | `d955603be6cc0e8b8ffcec722f635192b2261410b1f2929abea94480e47eb5d4` |
| `scripts/verify/recipes.ts` | `ceab704546e580934cf88dd0b0f8d64613db86fe6900603a6a96c08b46a468b1` |
| `scripts/verify/registry.json` | `f6d93365c0bbcf3c3f0d6e409a2feabec5c9d621dcdf98502d0c986503fbe949` |

`native/owner-report/instruction-hashes.json` e `instruction-hashes-after-parent.json` conservam o conjunto completo, incluindo as folhas de escrita e o script de trilha. D1 e o helper têm manifests próprios. Root e externos conservam hashes do runner, prompts, perfis e instruções em seus respectivos diretórios. Cada prova continua atribuída aos bytes capturados no seu momento.

## Comandos exigidos e resultados conferidos

| Executor e fonte | Comando exigido | Resultado observado | Recibo ou stream |
| --- | --- | --- | --- |
| Raiz nos turnos de auditoria 001, 002, 003 e 004. | `npm run verify -- doctor`. | Exit 0 nos quatro turnos. Não é uma suíte de contratos. | `audits/*-source-2.json`. |
| Owner D1 em `4a94af54ca033cfe85f421e3cc92245d4daf45f5`. | `npm run verify -- run --base 617ea1a10dc7bd994fdccc3f69bc1258793a41a3 --feature repository-contracts`. | Complete, 242 pass, zero fail, candidato limpo. | `native/owner-contracts/verify-1/receipt.json` e `commands/0009-contracts/stdout`. |
| Gate independente D1 no mesmo head. | `repository-contracts`, classificação e paridade. | Primeira tentativa de fixture com socket longo falhou e ficou cancelled. Nova tentativa em TMPDIR curto passou 242 testes. Paridade passou. | `swarm-d1/gates/gate-results.json`, `repository-contracts-short-temp/receipt.json`. |
| Owner D1 em `b14b6cfd61b51de48ed8865a1fcd38f39aac273e`. | `repository-contracts` sobre commit limpo. | Complete, 242 pass, zero fail. | `native/owner-contracts/verify-2/receipt.json` e seu stdout de contratos. |
| Live worker Sol high na primeira rodada. | Doctor, paridade e operações Linear/GitHub próprias. | Receipts complete. Doctor e paridade exit 0. O resultado ISSUES não aprova o head posterior. | `swarm-d1/live-receipt.json`, seu stdout e `live-result.md`. |
| Owner D2 no head final do relatório. | Doctor, classify e `repository-contracts` com base D1, antes da revisão do head publicado. | Condição de entrega, conferida pelo receipt real do head. A classificação runtime de `docs/**` prevalece sobre a exceção documental. | `native/owner-report/verify-final/receipt.json` e `delivery-receipt.json`. |
| PR #115 no head final. | CI e `watch-pr --status-only`, modo check para prosa. | Condição de STACK-READY. Exige check real e READY calculado pelo watcher, além do estado OPEN ready. | `native/owner-report/delivery-receipt.json`, watcher e view do PR. |

A classificação de D2 seleciona `repository-contracts` porque `docs/**` também pertence a `agent-instructions` no registry. Runtime prevalece sobre `docs/research/**` em `nonRuntime`. Nenhum runner, setup ou verificador é alterado por este PR. Seus testes separados não são acrescentados como substituto de fontes ou auditorias. Os testes internos usam fixtures. A prova integrada vem dos owners, fontes, turnos e PRs reais. O worker live da primeira rodada consultou Linear e GitHub por sua própria integração CLI e executou doctor e paridade. Ele comparou o contrato base, que já suportava heartbeat, com a referência ambígua corrigida. Não produziu uma prova falsa de heartbeat quebrado na base. Sua captura de transcript mostrou uma frase de uma fonte helper, por isso ele não conta como revisão cega do diff.

A revisão de comentários foi inaplicável ao diff exclusivamente de prosa de D2. Ele não acrescenta código, comentários de código ou supressões. Deslop, technical-writing e unslop foram aplicados ao relatório e à descrição. A prova própria e a revisão independente continuam requisitos separados.

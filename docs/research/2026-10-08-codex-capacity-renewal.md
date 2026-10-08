# Frente B: capacidade e renovação da raiz Codex

Data: 2026-10-08. Escopo: **item 1** do [acompanhamento Linear](https://linear.app/clinextapp/document/pendencias-de-raiz-codex-apos-os-prs-99-105-2026-10-08-668a922674a8). O relatório `2026-10-08-codex-front-b.md` é a entrega de **A**, apesar do nome. Ele e o relatório de C foram conservados sem alterações.

## Decisão

**Usar o mecanismo existente: contextos nativos novos em ondas; runner com o mesmo descritor quando a capacidade ou as ferramentas não atendem ao contexto necessário.** Neste host, handles concluídos não impediram várias rodadas. Uma saturação controlada rejeitou a criação de um revisor; uma conclusão posterior permitiu nova criação. Durante esse limite, uma revisão independente pelo runner conservou `codex:gpt-6.1-sol@high`, sandbox read-only e acesso direto às fontes exigidas.

Não foi necessária correção de runtime, aumento de limite, troca de modelo ou rotina própria de fechamento. A mudança de instrução registra a observação do host e aponta para esta prova. O item 1 fica atendido **para a continuidade e o host exercitados**, com os limites abaixo; não se declara fechamento administrativo, liberação universal de handles nem validação do Autopilot completo.

| Resultado separado | Evidência e alcance |
| --- | --- |
| **Liberação nativa comprovada** | Renovação **efetiva da capacidade de admissão**: rejeição com raiz + três filhos ativos; somente um concluiu; nova criação aceita enquanto os outros dois permaneciam ativos. Não há operação `close_agent` nem relatório de vaga por handle. Fechamento administrativo continua não comprovado. |
| **Continuidade comprovada por alternativa válida** | Revisor novo pelo runner, mesmo provider/modelo/esforço da tentativa recusada, acesso read-only, consultas próprias bem-sucedidas ao Linear e ao GitHub, resultado `PASS+NOTES`. Uma opinião independente, sem contar a rejeição como voto. |
| **Limites restantes e papéis afetados** | Outros hosts, retenção por dezenas de rodadas, limites globais de conta e fechamento definitivo não foram medidos. Owners externos não foram transferidos neste exercício; a prova nova de owner é nativa. Fontes não exercitadas e owners Grok externos mantêm seus limites. Autopilot completo e despertar integrado pertencem a D. |

## Base, configuração e fontes

`git fetch origin main` foi executado no repositório solicitado, `/Users/victorbaccega/Dev/Skills/pstack-vic`, antes da criação do worktree. O tip atualizado permaneceu **`79e67d050b573f5a41bb356224927428e4b423bb`**, SHA inicial desta frente. GitHub confirmou #110 MERGED em `de9cb303790f68d861c9552be37eeb4b02d8ac77` e #108 MERGED em `79e67d05`; ambos estão na base. O checkout principal estava sujo e foi preservado.

Worktree de B: `/Users/victorbaccega/.codex/worktrees/codex-capacity-renewal/pstack-vic`, branch `codex/capacity-renewal`. Raiz exata: **`01a11cb3-525f-7b11-acdd-caa6369b3f8d`**, configuração local **`gpt-6-astra@xhigh`**. Host nativo: **Codex Desktop 0.162.0-alpha.2**; runner: **Codex CLI 0.161.0**, Node **24.21.0**. Metadados locais/argv identificam configuração, não o modelo ou esforço efetivamente servido pelo backend.

Foram lidos AGENTS.md, UPSTREAM.md, ADR 0005, native-lifecycle, provider-dispatch, runner-capabilities, o [relatório de A](2026-10-08-codex-front-b.md), o [relatório de C](2026-10-08-codex-wake-lifecycle.md) e o contrato codex-local-wake. Antes dos despachos foi lido também o provider-dispatch instalado em `~/.codex/plugins/cache/pstack-vic/pstack/0.5.24/`. Apesar do mesmo número de versão, ele antecede os perfis de capacidades, a seleção recente de owners, a política corrigida da trilha e o contrato atualizado de coleta headless. A prova externa chama **o runner do checkout**, sem instalar o candidato.

Pin preservado: **Cursor `4e5b1cf2ccb0ea3716f08c8ee0a5856b5ab93536`**, pstack 0.15.10. A sheet pessoal conserva `swarm workers: codex:gpt-6.1-sol@high`, autoria/exploração Sol `xhigh`, julgamento Sol `max` e fallback Sol `xhigh`. O fallback de modelo não foi usado. AGENTS.md, UPSTREAM.md, matriz, playbooks gerados e configurações pessoais não são alterados por esta entrega.

Raiz privada da evidência: **`/Users/victorbaccega/.codex/artifacts/codex-capacity-b-20261008/`**. `baseline/source.json` conserva SHA, hashes dos contratos, relatórios de entrada e configurações; `baseline/installed-vs-candidate.diff` conserva a comparação; `baseline/initial-tools.json` conserva leitura Linear e confirmação dos PRs. Capturas privadas não são publicadas no Git. Partes de prompts nativos são cifradas pelo host; os rollouts são conservados assim, e o manifesto declara seus resumos sem inventar uma recuperação em texto aberto.

## Comportamento original a preservar

A comparação usou `git show <pin>:pstack/...`, com 35 comandos, originais e diffs em `native/wave1-upstream/`:

- `skills/poteto-mode/SKILL.md:99` do original exige contexto novo para fix rounds, retries, follow-ups e próximo item; a exceção é estado local caro de transferir. O papel de owner pode durar mais que seu agente.
- Autopilot-full, passos 4–6, exige verificação independente por rodada, owner novo no próximo item, auditoria de `children.tsv` e término somente sem delegação pendente. Shipping exige um verificador que não escreveu o código.
- Swarm distingue N solicitado do limite de simultaneidade. Orchestrate já usa uma janela de trabalho em voo. Ondas preservam cobertura, mas não substituem execução simultânea quando ela é a propriedade testada.
- O port adapta ferramentas, worktrees, capacidade e transportes conforme ADR 0005. O contexto retido de um autor não vira revisão independente. O runner é uma rota existente, sem novo workflow ou gate.

O orçamento inicial reservou três contextos de trabalho, revisão posterior nova e a prova de owner/filho. Todos os workers usam `high`; exploração e owner usam suas linhas `xhigh`. O controle de saturação reaproveitou contextos já coletados somente para testar lifecycle; esses follow-ups não contam como ondas de autoria nem opiniões independentes.

## Operações anunciadas e contabilização

Os schemas completos estão em `native/wave1-sources/advertised-collaboration-schemas.md` e `baseline/native-contract.json`. Esta é a superfície observada, não uma API universal de Codex:

| Operação | Schema relevante | Efeito observado |
| --- | --- | --- |
| Criação | `spawn_agent({task_name, message, fork_turns?, model?, reasoning_effort?})` | `fork_turns: "none"` permite fixar cada descritor e criar contexto novo. Retorna nome canônico. |
| Listagem | `list_agents({path_prefix?})` | Lista a árvore nativa visível, incluindo descendentes; omitiu handles concluídos que ainda eram retomáveis. Não substitui o inventário do programa. |
| Coleta | `wait_agent({timeout_ms?})`, 10.000–3.600.000 ms, padrão 30.000 | Espera notificação; resultado chega na mensagem final. Foram conservados resultados e efeitos, além dos estados. |
| Mensagem | `send_message({target,message})` | Entrega durante trabalho ativo; não inicia um turno ocioso. Liberou as barreiras controladas. |
| Follow-up | `followup_task({target,message})` | Retomou o mesmo handle/contexto, inclusive depois de interrupção; não muda descritor. |
| Interrupção | `interrupt_agent({target})` | Retornou `previous_status: running`; a listagem mostrou `interrupted`. O handle depois retomou. |
| Fechamento | Ausente | Nenhum fechamento explícito executado ou alegado. |
| Capacidade | Declaração de quatro slots incluindo a raiz; sem query dinâmica | Rejeição observada na árvore com raiz + três filhos ativos. Não se mediu quota de conta, outra sessão ou todo o desktop. |

O filho do owner aparece como `/root/capacity_owner/seed_helper`, sob a mesma raiz, e no inventário retido. A enumeração mostra o escopo da árvore; não houve saturação separada de uma combinação com descendente ativo para provar aritmética de nesting. A revisão externa criou outra sessão CLI e terminou mesmo tendo começado durante a saturação nativa. Isso não determina quotas globais do serviço.

O schema nativo não oferece `cwd` ou sandbox por spawn. O cwd do host permaneceu o checkout original da conversa (`.../worktrees/6809/pstack-vic`); os briefs e comandos apontaram explicitamente para o candidato ou para o worktree do owner. O helper comprovou esse último com `pwd`. A restrição nativa read-only é de instrução; não se afirma isolamento imposto por SO. O runner pediu `--sandbox read-only`, conforme recibo.

## Exercício e rejeição concreta

Horários abaixo são UTC dos eventos. A trilha exata está em `native/lifecycle-events-final.json`, com call IDs e respostas, e nos rollouts de `native/after-controls/`.

1. **Onda 1:** `wave1_upstream` (`xhigh`) comparou original e port; `wave1_sources` (`high`) chamou Linear, GitHub e `verify doctor`. Ambos concluíram e foram coletados. Linear retornou documento `5fc079d9-bab3-468e-9bd5-e4fd48bbd46c`; GitHub retornou AGENTS.md no SHA inicial, blob `eab2771f4410e0436d4bf6f861ad71a80b6d5bbe`.
2. **Onda 2:** às `18:14:46.364Z`, `wave2_scenarios` (`high`, contexto novo) recebeu os resultados coletados e produziu a matriz de cenários para D. É trabalho de planejamento, não revisão.
3. **Owner novo:** às `18:16:18.647Z`, `capacity_owner` (`xhigh`) foi aceito após os três handles anteriores. Criou e coletou `seed_helper` (`high`, contexto novo). O filho calculou por shell o hash de um seed do supervisor; owner gravou o mesmo valor em `owner-proof.json`. A raiz e o revisor conferiram os bytes. Owner consultou Linear e documentação oficial por web. `children.tsv` termina com filho coletado e zero filhos próprios ativos.
4. **Addressabilidade:** um `wave1_sources` omitido da listagem retomou por `followup_task`, no mesmo UUID e esforço, com suas respostas anteriores. Ausência na lista não significou fechamento.
5. **Controle de saturação:** depois de coletar as tarefas, os três handles de trabalho retomaram para esperas deliberadas por mensagem, sem subprocessos ou escrita. A listagem de `18:20:47.137Z` mostrou raiz + três `running`. Às **`18:21:20.872Z`**, o spawn fresco `independent_review`, Sol `high`, foi recusado: **`collab spawn failed: agent thread limit reached`**. A tentativa não criou um resultado de lane.
6. **Alternativa:** o runner iniciou o mesmo papel às `18:22:31.105Z`, enquanto a janela nativa permanecia ocupada. O descritor, independência e fontes foram conservados. Seu resultado é detalhado abaixo.
7. **Controle de conclusão:** somente `wave1_sources` recebeu `RELEASE_BARRIER` e concluiu. A listagem imediatamente anterior à nova criação mostrou esse handle `completed`, os outros dois ainda `running`. Às **`18:22:56.306Z`**, `post_completion_probe`, contexto novo Sol `high`, foi aceito; sua ferramenta leu AGENTS.md e retornou o hash esperado. A interrupção seguinte só ocorreu às `18:23:10.813Z`. Essa sequência comprova que a admissão voltou após a conclusão, sem supor que `completed` por si só demonstrasse liberação.
8. **Controle de interrupção:** `interrupt_agent(wave2_scenarios)` interrompeu exclusivamente sua espera diagnóstica; listagem mostrou `interrupted`. `followup_task` retomou o mesmo handle e ele concluiu. O outro diagnóstico recebeu RELEASE e concluiu. Não se atribui ao stop uma prova separada de liberação de vaga, nem se confunde sua retomada com nova opinião.

A saturação foi **ativa e controlada**, não uma falha provocada por acúmulo de handles concluídos. Não surgiu uma rejeição persistente após todas as conclusões. A causa interna da seleção dos handles exibidos na lista não foi estabelecida. O resultado evita tanto declarar vazamento quanto declarar resolvido um limite de retenção de longa duração que não foi atingido.

## Rota alternativa: revisão real com as fontes do papel

Sessão **`01a11cc0-acca-7ce0-b3ab-cfa2736fdbc3`**, `runner/review-1/`, processo supervisor **65790**, PID do runner **47469**. Invocação pelo launcher público do candidato, `--parent codex --provider codex --model gpt-6.1-sol --effort high --mode read-only`. Perfil `{"schemaVersion":1,"skills":true}`; fontes vieram das integrações autenticadas do próprio CLI. Não foram copiados tokens, endpoints privados nem configurações globais.

O reviewer recebeu brief completo, SHA inicial e evidências delimitadas, sem conversa do autor ou conclusões de outros revisores. Fez suas próprias consultas:

| Evento completed do stream | Resultado conferido pela raiz |
| --- | --- |
| `item_3`, `codex_apps.linear.get_document({id:"668a922674a8"})` | `error:null`, documento correto e conteúdo do item 1. |
| `item_4`, `codex_apps.github.fetch_file` | Repo `byvict/pstack-vic`, path `AGENTS.md`, ref inicial; blob correto e conteúdo igual ao checkout. |

`source-assertions.json` verifica argumentos, resultados e identidades; `receipt.json.stdout`/`.stderr` conservam os streams. O recibo terminou **complete, exit 0**, às `18:25:38.770Z`, com saída **PASS+NOTES**. O revisor confirmou as duas ondas, delegação/coleta nativa e a validade da revisão alternativa; pediu que a prova posterior à liberação da barreira fosse registrada separadamente. Seu snapshot precedia o controle de conclusão/interrupção. Esta opinião não aprova por antecipação o relatório final nem o Autopilot completo.

Vínculo com a fonte: SHA limpo **`79e67d05...`**, digest do manifesto **`04a4043b98cb12492880ebce2de011b384b78466aa2fa0b7b1c3545e47d2b214`**. O recibo conserva `modelEvidence: pinned-argv`, `modelVerified: false`, `reportedModel: null`, esforço solicitado `high`. O processo terminou, o handle foi drenado e a ausência do PID foi conferida em `process-cleanup.json`.

Não foi transferido um owner para o runner nesta entrega. O `owner-spec.json` privado foi preparado como contingência e **não executado**; não é prova. A prova nova de owner/filho é nativa. Para uma transferência de owner em D, exigir `agentKind: owner`, capacidades da tarefa e demonstração própria de delegação e coleta antes do término headless, conforme [runner-capabilities](../../skills/poteto-mode/references/runner-capabilities.md). O sucesso deste reviewer não estabelece essas capacidades de owner.

## Inventário dos handles exercitados

Todos os nomes abaixo são relativos à raiz nativa, salvo a sessão CLI. Os resultados originais continuam nos diretórios indicados. Os contextos diagnósticos retomados mantiveram os UUIDs; não criaram votos. Não há declaração de `closed` para nenhum handle nativo.

| Handle / UUID | Descritor e tarefa | Worktree/escopo atribuído | Estado terminal observado e resultado |
| --- | --- | --- | --- |
| Raiz `01a11cb3-525f-7b11-acdd-caa6369b3f8d` | Astra `xhigh`, coordenação B | Worktree de B | Responsável pela entrega e inventário. |
| `wave1_upstream`, `01a11cb5-5ddb-7490-aeef-82700ed79723` | Sol `xhigh`, comparação upstream | Candidato read-only; saída privada própria | Completed/coletado; `native/wave1-upstream/comparison.md`; diagnóstico final concluído. |
| `wave1_sources`, `01a11cb5-94ba-7ac2-afe6-1fe8da053dff` | Sol `high`, fontes/inventário | Candidato read-only; saída privada própria | Completed/coletado, retomável; `native/wave1-sources/findings.md`; barreira concluída. |
| `wave2_scenarios`, `01a11cb9-9373-7562-bee0-b501b78985e0` | Sol `high`, cenários D | Candidato read-only; saída privada própria | Completed/coletado; `native/wave2-scenarios/report.md`; diagnóstico interrupted → retomado → completed. |
| `capacity_owner`, `01a11cba-fbf0-77f0-8e75-154b5b3f0ebc` | Sol `xhigh`, owner nativo | Worktree separado `.../codex-capacity-b-20261008/owner-worktree` | Completed/coletado; `owner-proof.json`, `children.tsv`, arquivos de chamadas. |
| `capacity_owner/seed_helper`, `01a11cbc-0f10-7fc0-9b7f-05ddf3f1f6c4` | Sol `high`, hash/AGENTS | Mesmo worktree do owner, somente leitura | Completed, coletado pelo owner; `helper-evidence.json`. |
| `post_completion_probe`, `01a11cc1-0c84-7973-bb0e-3b21faa09784` | Sol `high`, admissão após conclusão | Candidato somente leitura | Completed/coletado; ferramenta exit 0, hash `dc803c2a2afc9c8fc5353939798d5bf2b1a9b3f0145724510aa582044b6b1cc9`. |
| `independent_review` | Sol `high`, revisão fresca solicitada | Candidato somente leitura | **Rejeitado**, sem novo handle/result; erro conservado. |
| CLI `01a11cc0-acca-7ce0-b3ab-cfa2736fdbc3` | Sol `high`, revisão substituta fresca | Candidato, sandbox read-only | Complete/exit 0, processo encerrado; `runner/review-1/`. |

A coleta final deve conservar a listagem anunciada **e** este inventário histórico: a primeira pode omitir handles retomáveis. Nenhum processo de outra sessão foi encerrado. As barreiras usaram apenas espera nativa; nenhum timer/heartbeat foi criado nesta frente.

## Reprodução e handoff para D

Reproduzir a partir de `79e67d050b573f5a41bb356224927428e4b423bb` mais o commit deste relatório. A e C já estão nessa base, respectivamente #110/`de9cb303...` e #108/`79e67d05...`. A instalação pessoal 0.5.24 não contém todos esses contratos: D deve identificar se está exercitando o checkout ou uma instalação atualizada antes de atribuir a prova.

1. Capturar schemas, capacidade anunciada, descritores vigentes e UUID da raiz. Ler os três contratos de lifecycle/dispatch/capabilities e comparar instalação/candidato. Não supor que o limite deste host vale no seguinte.
2. Criar dois contextos novos, coletá-los, criar e coletar uma segunda onda. Dar aos futuros autores/revisores seus próprios briefs e saídas. Conservar comandos e chamadas reais, não só mensagens finais. Para owner, atribuir worktree próprio e filho `Sol@high`, conferir artefato produzido pelo filho e `children.tsv` antes de encerrar.
3. Para repetir o controle, retomar três handles coletados como diagnósticos de espera por mensagem (sem processos/escrita); confirmar raiz + três ativos; tentar um contexto fresco. Preservar erro ou sucesso como ocorreu. Se rejeitar, concluir **um** diagnóstico, confirmar os outros ativos e tentar uma nova criação uma vez. Se não rejeitar, relatar somente a capacidade alcançada. Interromper somente uma espera diagnóstica, registrar estado e retomada; terminar todas as esperas.
4. A revisão independente deve ser nova. Para reproduzir a alternativa durante indisponibilidade nativa, gravar um brief com SHA/evidências/operações exatas e um perfil `{"schemaVersion":1,"skills":true}`. Executar pelo handle persistente do host, com caminhos novos:

```sh
skills/poteto-mode/scripts/runner/pstack-runner \
  --parent codex --provider codex --model gpt-6.1-sol --effort high \
  --mode read-only --cwd /absolute/candidate \
  --prompt /absolute/new-attempt/prompt.md \
  --capabilities /absolute/new-attempt/capabilities.json \
  --output /absolute/new-attempt/result.md \
  --receipt /absolute/new-attempt/receipt.json
```

O brief pede auditoria dos contratos/evidências e consultas diretas `linear.get_document(668a922674a8)` e `github.fetch_file` do AGENTS.md no SHA atribuído. Conservar schemas descobertos e resultados completed/error null, confirmar identidades e comparar conteúdo, ler o veredito e drenar o processo. `run-lane.mjs`, `review-spec.json`, `assert-review.py`, prompts e comandos desta tentativa permanecem na raiz privada para reprodução local; os caminhos precisam ser adaptados em outra máquina. Eles são tooling de evidência, não uma nova API do plugin.

5. Quando o programa exigir tick, seguir o [contrato de C](../../skills/poteto-mode/references/codex-local-wake.md): heartbeat nativo no UUID exato, payload integral e **uma hora** no Autopilot; alternativa por socket somente com thread persistida e carregada. `queued`/`consumed` não substituem turno concluído e efeito. Esta frente ficou ativa até coletar tudo e não precisou armar despertar. D ainda precisa demonstrar o tick sobre owners reais, fontes, recorrência, stop e cleanup; a matriz `native/wave2-scenarios/report.md` detalha os cenários.
6. Encerrar somente processos próprios e reconciliar todos os children, inclusive handles omitidos pela lista. Conservar desconhecidos como desconhecidos. Um owner headless deve coletar os filhos antes de sair; reviewer externo não comprova esse lifecycle. Não substituir métricas de concorrência externa por prova de slots nativos.

## Verificação e revisão da entrega

Seleção pelo diff: relatório de pesquisa e uma observação no contrato de instruções. `verify-pstack-vic` foi aplicado a partir de `doctor`; a receita pertinente é **repository-contracts**, além da prova real acima. Sem alteração de runner, setup ou verificador, suas suítes não são selecionadas como substituto de lifecycle. Os resultados do commit e a revisão final são registrados na conclusão desta seção.

# Execução integrada do Autopilot com raiz Codex

Data do programa, 2026-10-08. Esta frente D combina as provas de A, B e C num programa real de Autopilot-stack. A referência é o [documento de pendências da raiz Codex](https://linear.app/clinextapp/document/pendencias-de-raiz-codex-apos-os-prs-99-105-2026-10-08-668a922674a8), itens 1, 5, 6, 7, 8 e 9.

Este primeiro snapshot abre a entrega revisável antes da prova própria do owner. O programa continua ativo. Revisões, coleta do helper de D2, verificação final e encerramento ainda precisam terminar. Um recibo de invocação completa não encerra a tarefa.

## Base e instruções exercitadas

O SHA inicial é `617ea1a10dc7bd994fdccc3f69bc1258793a41a3`. Essa base contém A, PR #110, C, PR #108, e B, PR #112. O [relatório de A](2026-10-08-codex-front-b.md) mantém seu nome histórico. Os [relatórios de B](2026-10-08-codex-capacity-renewal.md) e [C](2026-10-08-codex-wake-lifecycle.md) permanecem entradas distintas.

A raiz exata é `01a11cfe-4162-7f70-9bc3-dbbed8be4e27`. `baseline/root-metadata.json` registra `gpt-6-astra`, esforço `xhigh`, no Codex Desktop `0.162.0-alpha.2`. Os executáveis capturados em `baseline/` são Codex CLI `0.161.0`, Claude Code `2.1.292`, Grok `1.0.46` e Node `24.21.0`. São fatos de configuração e versão. Não atestam o modelo ou esforço servido pelo backend.

A evidência privada do programa fica em `/Users/victorbaccega/.codex/artifacts/codex-integration-d-20261008/`. Os caminhos relativos desta página apontam para essa raiz quando nomeiam capturas privadas. Eles permitem reprodução local pelo operador e não publicam conteúdo de conectores.

A instalação comparada é `/Users/victorbaccega/.codex/plugins/cache/pstack-vic/pstack/0.5.25`. A raiz lê os playbooks instalados nas auditorias. Owners leem e seguem os arquivos do candidato pelo mapeamento Codex suportado. Esse mecanismo não instala o candidato nem recria hooks ou comandos de outra plataforma. `baseline/source.json` identifica hashes antes do programa. Cada owner conserva seus próprios hashes.

O pin Cursor permanece `4e5b1cf2ccb0ea3716f08c8ee0a5856b5ab93536`, pstack `0.15.10`. Os originais comparados estão em `baseline/upstream/`. O [ADR 0005](../adr/0005-autopilot-substitui-converge.md) permite adaptações de plataforma. Sua cadência histórica de 30 minutos não substitui a hora exigida pelo playbook vigente. A configuração conserva `swarm workers: codex:gpt-6.1-sol@high`.

## Programa real e sequência observada

D1 é o owner nativo `/root/owner_contracts`, descritor `codex:gpt-6.1-sol@xhigh`, em worktree próprio. Seu filho `/root/owner_contracts/source_contracts` usa `codex:gpt-6.1-sol@high`. `native/owner-contracts/children.tsv` e as capturas de auditoria registram o filho e sua coleta. A correção inicial está em `4a94af54ca033cfe85f421e3cc92245d4daf45f5`, [PR #114](https://github.com/byvict/pstack-vic/pull/114). A raiz ainda revisa essa rodada. O SHA inicial não é apresentado como veredito final.

D2 é um contexto novo, `/root/owner_report`, com `codex:gpt-6.1-sol@xhigh`, worktree `/Users/victorbaccega/.codex/worktrees/codex-d-report/pstack-vic`, branch `codex/d-integrated-report`. O parent atribuído é `4a94af54ca033cfe85f421e3cc92245d4daf45f5`. Somente a raiz altera a topologia. O helper de fontes Sol `high` está enfileirado até a liberação de capacidade confirmada pela raiz. Essa espera não é uma rejeição de spawn nem autoriza trocar o descritor.

A janela anunciada tem quatro slots, incluindo a raiz e descendentes. `handles.json` conserva o inventário histórico. `list_agents` é reconciliado com esse inventário, os processos persistentes e cada `children.tsv`. Nenhum `close_agent` é anunciado. Um resultado coletado conserva seu handle sem alegar fechamento administrativo.

O programa usa Autopilot-stack. Owners abrem PRs ready, executam suas verificações e reportam os SHAs. A raiz reúne revisões independentes e decide se cada rodada entra na cadeia. Nenhum owner mergeia, fecha PR ou arma auto-merge.

## Dois turnos de auditoria após o término da raiz

O heartbeat `d-autopilot-integration-audit` aponta para o UUID exato da raiz. O ensaio usa intervalo acelerado de um minuto. A cadência de produção continua sendo uma hora. `audit-payload.md` conserva o payload integral, incluindo owners, children, trilhas, efeitos, lanes travadas e condição de encerramento.

O turno inicial terminou às `19:34:45.107Z`. A primeira auditoria começou às `19:35:33.198Z`, turno `01a11d03-883f-7f70-bd95-1b8221021192`, e terminou às `19:36:57.170Z`. A recorrência começou às `19:37:03.197Z`, turno `01a11d04-e7d0-73c3-a1b0-d8c0538bccaf`. `audits/after-second-turn-events.json` conserva essa sequência. O arquivo ainda não registra o término do segundo turno naquele snapshot.

`audits/001-audit.json` e `002-audit.json` registram efeitos sobre owners reais. Ambos conferem trilhas, children e mudanças locais de D1. Cada turno chamou Linear para `668a922674a8`, retornou a identidade esperada e leu `AGENTS.md` no GitHub no SHA inicial. O conteúdo GitHub confere com o checkout. Os resultados originais ficam em `001-source-0.json`, `001-source-1.json`, `002-source-0.json` e `002-source-1.json`.

As duas execuções de `verify doctor`, `001-source-2.json` e `002-source-2.json`, retornaram exit 0 no candidato D1. Doctor prova disponibilidade das receitas. Não substitui a suíte nem a revisão. O tick decidiu continuar porque havia delegação e entrega pendentes. Nenhuma lane ficou travada nesse snapshot. A substituição de uma lane travada continua não executada.

## Disposição por pendência neste snapshot

| Item | Disposição | Alcance e limite |
| --- | --- | --- |
| 1 | Resolvida por prova para continuidade neste host. | B prova rejeição controlada e nova admissão após uma conclusão. D continua com owners e revisores frescos em ondas. Closure administrativo, quota global e retenção longa continuam abertos. |
| 5 | Resolvida por prova para despertar no desktop. | D observa o primeiro turno após o término da raiz e a recorrência no mesmo UUID, com chamadas e efeitos. Stop final ainda depende do recibo terminal. |
| 6 | Alternativa comprovada por C. | A fila local conserva aceitação, consumo, conclusão, efeito, cancelamento e reconciliação sem replay. D escolhe heartbeat e não repete os cenários CLI. |
| 7 | Resolvida por mudança e prova no alcance de A. | Grok externo lê skills e chama HTTP MCP pelo ACP. D usa essa rota no painel. OAuth privado, herança geral de conectores e owner Grok externo continuam sem comprovação ou suporte. |
| 8 | Resolvida por prova para as fontes Codex atribuídas. | A e B provaram Linear e GitHub em contextos frescos. D conserva consultas diretas dos owners e dos turnos despertados. Outras fontes exigem suas próprias chamadas. |
| 9 | Ainda aberta até a entrega final integrada. | O programa real e suas duas auditorias têm evidência. Verificação, painel completo, coleta D2, cadeia e encerramento ainda não terminaram. Ausência de atestação backend continua um limite documentado, sem novo gate. |

## Verificação e limites de cobertura

O recibo D1 `native/owner-contracts/verify-1/receipt.json` registra 242 testes de `repository-contracts` que passaram. A revisão e os gates independentes da raiz permanecem separados dessa prova própria. D2 ainda não executou sua receita sobre o relatório final.

A configuração do painel Interrogate é Sol `xhigh`, Claude `xhigh` e Grok `4.7@xhigh`. A raiz conserva os receipts externos e usa HTTP MCP limitado pelo perfil da tarefa. Uma lane concluída precisa ter seus resultados e efeitos inspecionados. A declaração do helper ou o catálogo de ferramentas não são prova de acesso.

Owners externos não foram necessários nem executados. A prova do reviewer externo de B não prova delegação de owner headless. O cenário de interrupção por ordem do operador também não foi executado. Os controles de B e as fixtures de C mantêm suas atribuições originais.

O encerramento é uma condição explícita de entrega. A raiz deve produzir `closure/final-receipt.json` após coletar toda delegação, parar a agenda exata, observar o próximo intervalo sem outro tick e confirmar zero processos próprios pendentes. O relatório não afirma que esse recibo já existe ou passou. O veredito final da raiz deve conferir esse recibo, os SHAs da cadeia, os checks e as revisões antes de encerrar o item 9.

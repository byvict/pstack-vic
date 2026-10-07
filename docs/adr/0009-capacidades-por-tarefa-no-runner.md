---
status: accepted
---

# Capacidades por tarefa no runner local

Bloquear delegação, web, skills e MCP de toda sessão externa confundia uma lane comum com um owner e impedia tarefas de pesquisa de consultar suas fontes. Mantemos a lane limitada como padrão e adicionamos uma seleção explícita de capacidades por invocação, sem alterar o modelo, esforço ou configuração global do usuário.

Owners Codex/Claude habilitam delegação nativa e persistência; lanes continuam novas e independentes. Web é selecionável nos três CLIs. Skills e fontes HTTP MCP explícitas usam mecanismos existentes de Codex/Claude. O Grok mantém suas rotas nativas para owners/skills/fontes gerais e o attachment T3 específico no ACP; não ampliamos silenciosamente seu grant full-access. O motivo é o contrato diferente de catálogo, profundidade e autenticação dessas rotas, não uma proibição universal de ferramentas.

Cada fonte exigida precisa de chamada real no caminho escolhido. O recibo distingue a seleção pedida de um catálogo efetivo e de prova do modelo servido. Manter hooks/memórias Codex desabilitados é uma escolha de independência da tarefa; manter o overlay de ambiente Grok conserva a correção medida de exposição de credenciais ao shell. As [provas e limitações](../research/2026-10-07-runner-capabilities.md) documentam os efeitos observados e a falha de cota do Claude. O [ADR 0005](0005-autopilot-substitui-converge.md) continua regendo o workflow: não nasce outro processo de entrega.

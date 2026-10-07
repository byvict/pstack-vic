# Implementar e limpar a mudança

Descreva o que observou e o que precisa preservar. Os playbooks organizam reprodução, implementação e verificação. Ao final, deixe um diff que outra pessoa consiga revisar.

## Formule a tarefa pelo resultado

Para um bug:

```text
/poteto-mode este comando emite dois registros depois de uma nova tentativa. reproduza, corrija e verifique.
```

Para uma feature:

```text
/poteto-mode adicione --json. preserve a saída textual byte a byte e verifique as duas formas.
```

Para uma refatoração:

```text
/poteto-mode concentre o parser em um módulo, sem mudar comportamento. registre a saída atual e demonstre que continua igual.
```

Para performance:

```text
/poteto-mode a inicialização leva 1,8 segundo nesta fixture. meça a causa, corrija e mostre antes e depois.
```

Esses pedidos selecionam [Bug fix](../../skills/poteto-mode/playbooks/bug-fix.md), [Feature](../../skills/poteto-mode/playbooks/feature.md), [Refactoring](../../skills/poteto-mode/playbooks/refactoring.md) e [Perf issue](../../skills/poteto-mode/playbooks/perf-issue.md). O fluxo exige reproduzir antes de corrigir, definir os dados antes da lógica, registrar comportamento antes de reorganizar e medir antes de otimizar.

Para melhorar uma métrica continuamente, use [Hillclimb](../../skills/poteto-mode/playbooks/hillclimb.md). Defina a métrica, a meta e um mínimo de tentativas. Ele congela o método de medição, testa uma hipótese por vez, mantém ganhos e reverte tentativas sem ganho.

Os dois playbooks de performance usam [benchmark-checklist](../../skills/benchmark-checklist/SKILL.md) para conferir as medições.

## Separe diagnóstico de correção quando necessário

O [Runtime forensics](../../skills/poteto-mode/playbooks/runtime-forensics.md) instrumenta um processo em execução para investigar vazamentos, CPU ociosa ou problemas visuais. O [Trace forensics](../../skills/poteto-mode/playbooks/trace-forensics.md) examina um perfil já capturado e liga os pontos de maior custo ao código.

```text
/poteto-mode este cpuprofile veio de uma inicialização lenta. explique onde o tempo é gasto e quais linhas são responsáveis. não corrija ainda.
```

Ambos entregam diagnóstico. Você decide quando abrir a etapa de correção.

## Use tdd quando houver um teste direto

```text
/tdd implemente
```

Com o contexto estabelecido, o [tdd](../../skills/tdd/SKILL.md) escreve o menor teste que falha pelo motivo esperado, implementa e executa novamente. Quando o teste exigiria uma estrutura ampla ou mocks frágeis, a skill deve justificar e usar a verificação executável mais próxima.

## Peça as regras de TypeScript

O [typescript-best-practices](../../skills/typescript-best-practices/SKILL.md) detalha uniões discriminadas, `unknown` nas fronteiras, exaustividade e tipos derivados de schemas. Nomeie a skill quando quiser aplicá-la a uma tarefa com arquivos `.ts` ou `.tsx`; no Codex, use `pstack:typescript-best-practices`.

## Limpe antes do commit

O [Opening a PR](../../skills/poteto-mode/playbooks/opening-a-pr.md) aplica deslop ao código e unslop à descrição e aos commits. Neste port, [deslop](../../skills/deslop/SKILL.md) vem incluído. Ele remove comentários narrativos, guardas sem justificativa, compatibilidade morta e mudanças alheias à tarefa.

Para prosa:

```text
/unslop revise as mudanças do README. seja direto e evite travessões.
```

O [unslop](../../skills/unslop/SKILL.md) aceita o alvo e suas restrições de escrita.

## Revise os comentários separadamente

```text
/no-comments revise o diff.
```

O [no-comments](../../skills/no-comments/SKILL.md) encaminha a revisão ao [Comment Sicko](../../agents/comment-sicko.md), com a adaptação correspondente em cada ambiente. Ele preserva casos como licenças, documentação de API pública e restrições externas que o código não consegue expressar.

Um comentário que explica uma surpresa do nosso próprio código pode indicar uma refatoração. Um comentário que impõe uma regra pode virar tipo, teste ou lint. A skill apresenta os achados e corrige os que aceita na causa.

Deslop cuida do código, unslop da prosa e no-comments dos comentários. Faça essa limpeza antes de pedir revisão; assim o revisor consegue se concentrar na mudança.

Próximo: [Verificar e entregar](06-verify-and-ship.md).

# Orientar pelos princípios

Os princípios são regras focadas que poteto-mode consulta conforme a tarefa. Use seus nomes para corrigir o rumo de uma decisão e peça que o agente explique o que mudou ao aplicá-los.

## Redirecione uma decisão concreta

Quando a solução acumula adaptadores:

```text
aplique subtract before you add. remova os adaptadores obsoletos antes de desenhar o restante.
```

Quando o agente declara sucesso com base no build:

```text
aplique prove it works. execute a importação real e mostre os registros gravados.
```

Quando duas tentativas vão escrever na mesma branch:

```text
aplique separate before serializing shared state. dê a cada tentativa seu próprio worktree.
```

Uma citação de princípio precisa vir acompanhada da decisão que ele alterou.

## Escolha o que construir

- [Laziness Protocol](../../skills/principle-laziness-protocol/SKILL.md): preferir remoções e a menor mudança que resolve o problema.
- [Foundational Thinking](../../skills/principle-foundational-thinking/SKILL.md): escolher as estruturas de dados antes da lógica.
- [Redesign from First Principles](../../skills/principle-redesign-from-first-principles/SKILL.md): integrar um requisito como se existisse desde o início.
- [Attack the Premise](../../skills/principle-attack-the-premise/SKILL.md): questionar a premissa compartilhada por tentativas que falharam; em desequilíbrios, contar o estado por participante.
- [Subtract Before You Add](../../skills/principle-subtract-before-you-add/SKILL.md): retirar código morto e redundâncias antes de acrescentar.
- [Minimize Reader Load](../../skills/principle-minimize-reader-load/SKILL.md): reduzir camadas e estado que o leitor precisa guardar.
- [Outcome-Oriented Execution](../../skills/principle-outcome-oriented-execution/SKILL.md): conduzir migrações ao desenho final, evitando compatibilidade descartável.
- [Experience First](../../skills/principle-experience-first/SKILL.md): priorizar a experiência de uso nas decisões de escopo.
- [Exhaust the Design Space](../../skills/principle-exhaust-the-design-space/SKILL.md): comparar dois ou três protótipos quando não há precedente.
- [Build the Lever](../../skills/principle-build-the-lever/SKILL.md): construir a ferramenta que faz ou prova o trabalho. Se o agente repete scripts manuais, peça uma ferramenta reutilizável.

## Organize dados e responsabilidades

- [Model the Domain](../../skills/principle-model-the-domain/SKILL.md): representar regras repetidas em uma estrutura explícita.
- [Boundary Discipline](../../skills/principle-boundary-discipline/SKILL.md): validar nas fronteiras e confiar nos tipos internos.
- [Type System Discipline](../../skills/principle-type-system-discipline/SKILL.md): impedir estados inválidos com tipos.
- [Make Operations Idempotent](../../skills/principle-make-operations-idempotent/SKILL.md): fazer novas tentativas convergirem ao mesmo estado.
- [Migrate Callers Then Delete Legacy APIs](../../skills/principle-migrate-callers-then-delete-legacy-apis/SKILL.md): migrar chamadores e remover a API antiga na mesma mudança.
- [Separate Before Serializing Shared State](../../skills/principle-separate-before-serializing-shared-state/SKILL.md): eliminar compartilhamento antes de acrescentar coordenação.

## Exija provas úteis

- [Prove It Works](../../skills/principle-prove-it-works/SKILL.md): verificar o artefato real.
- [Fix Root Causes](../../skills/principle-fix-root-causes/SKILL.md): reproduzir e rastrear a causa antes de corrigir.
- [Sequence Work into Verifiable Units](../../skills/principle-sequence-verifiable-units/SKILL.md): concluir cada unidade com uma verificação.
- [Test Behavior, Not Implementation](../../skills/principle-test-behavior-not-implementation/SKILL.md): chamar o código como seus usuários e conferir um resultado esperado explícito.
- [Explain the Number](../../skills/principle-explain-the-number/SKILL.md): identificar o limitante e confirmar que a medição incluiu o trabalho pretendido. [Benchmark-checklist](../../skills/benchmark-checklist/SKILL.md) transforma isso em perguntas verificáveis.

## Coordene agentes e aprenda com erros

- [Guard the Context Window](../../skills/principle-guard-the-context-window/SKILL.md): distribuir leituras volumosas e trazer conclusões para a conversa principal.
- [Never Block on the Human](../../skills/principle-never-block-on-the-human/SKILL.md): avançar no trabalho reversível autorizado e apresentar o resultado.
- [Encode Lessons in Structure](../../skills/principle-encode-lessons-in-structure/SKILL.md): transformar correções recorrentes em ferramentas, tipos ou checks. [Correct](../../skills/correct/SKILL.md) aplica isso ao histórico de um repositório.

A [referência técnica](../reference.md#princípios) mantém o catálogo das skills instaladas. Volte a esta página quando precisar dar um nome ao problema que está observando.

Próximo: [Adaptar ao seu trabalho](09-make-it-yours.md).

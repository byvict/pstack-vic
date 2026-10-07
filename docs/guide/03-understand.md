# Entender o código antes de alterar

Antes de editar, confira se o agente entendeu o pedido e o comportamento existente. Uma interpretação errada produz a correção errada mesmo quando o código parece bom.

`/how` explica o funcionamento atual. `/why` procura os motivos das decisões. `/teach` constrói uma explicação. `/recall` recupera o contexto do seu trabalho recente.

![Uma investigadora examina o projeto de uma máquina enquanto agentes reúnem evidências.](images/understanding.jpg)

## Comece por uma investigação

```text
/poteto-mode investigue por que os jobs expiram a cada poucas horas. explique o que sabemos, as fontes e as hipóteses. não altere código ainda.
```

O [playbook Investigation](../../skills/poteto-mode/playbooks/investigation.md) usa `/how`, acrescenta `/why` quando a pergunta envolve motivações e retorna uma explicação com fontes. Em uma escolha entre opções, apresenta a recomendação e seus custos. Quando houver evidência suficiente para corrigir, peça a correção como uma nova tarefa.

## Rastreie o comportamento com how

```text
/how como evitamos notificações duplicadas? a consulta de assinantes faz N+1?
```

O [how](../../skills/how/SKILL.md) conecta fluxo de execução, tipos e pontos menos óbvios. Em subsistemas grandes, usa exploradores que só leem. Em perguntas pequenas, vai direto ao código.

## Recupere os motivos com why

```text
/why por que o limite de tentativas é cinco? o motivo ainda vale?
```

O [why](../../skills/why/SKILL.md) parte do histórico e consulta as fontes disponíveis, como issues, documentos, conversas e observabilidade. O relatório separa evidência direta de inferência e registra buscas que não encontraram resposta. Os conectores precisam estar acessíveis na sessão.

Você pode combinar as duas skills quando a história ajuda a entender o código:

```text
use /why primeiro e depois /how para explicar este mecanismo de recuperação.
```

## Peça uma explicação com teach

```text
/teach explique como este PR muda as tentativas. mostre por que resolve a causa do problema.
```

O [teach](../../skills/teach/SKILL.md) usa how e why conforme a pergunta e organiza a explicação progressivamente, com diagramas quando ajudam. Você também pode examinar uma decisão do próprio agente:

```text
/teach por que você implementou assim? o que ganhamos e perdemos em comparação com uma fila?
```

Uma explicação fundamentada permite questionar a decisão antes de aceitá-la.

## Retome o contexto com recall

```text
/recall me atualize sobre a exportação em que trabalhei na semana passada.
```

O [recall](../../skills/recall/SKILL.md) consulta conversas recentes acessíveis e registros compartilhados para reconstruir o estado do trabalho. Comece por ele ao voltar a um assunto antigo, depois forneça os novos dados.

```text
/recall recupere meu trabalho de ontem na lista virtualizada e depois leia este relato de bug.
```

## Assuma uma branch em andamento

```text
/poteto-mode assuma esta branch. leia a trilha de decisões, confira o que foi concluído e continue desse ponto.
```

O [playbook Session pickup](../../skills/poteto-mode/playbooks/session-pickup.md) reconstrói decisões e estado da branch, identifica o ponto de retomada e confere as provas herdadas contra o objetivo original.

Use recall para reconstruir contexto entre conversas. Use Session pickup para continuar um trabalho específico. Em ambos, confira as fontes citadas antes de tratar uma conclusão antiga como atual.

Próximo: [Desenhar a mudança](04-design.md).

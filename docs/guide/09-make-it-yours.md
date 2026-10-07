# Adaptar o pstack ao seu trabalho

Comece com poucas regras. Observe onde os agentes erram e acrescente uma skill ou verificação quando a mesma dificuldade reaparecer. Você pode personalizar a forma de trabalhar sem copiar todo o plugin.

## Crie um modo pessoal com automate-me

```text
/automate-me
```

O [automate-me](../../skills/automate-me/SKILL.md) procura preferências recorrentes nas suas conversas recentes do projeto, como escrita, delegação, verificação e processo. Confirma os padrões com você e prepara uma skill para revisão.

Neste port, os caminhos e a criação da skill seguem o ambiente ativo, com os mapas de [Codex](../../skills/poteto-mode/references/codex-tools.md) e [Grok](../../skills/poteto-mode/references/grok-tools.md). O resultado deve ficar em um local que o ambiente realmente descubra.

Para atualizar:

```text
/automate-me atualize meu modo com o que mudou desde a última edição.
```

A atualização consulta o histórico novo, preserva regras ainda válidas e altera as que novas evidências contradizem.

## Capture lições com reflect

```text
/reflect esta tarefa demorou demais. registre o que aprendemos para a próxima execução.
```

O [reflect](../../skills/reflect/SKILL.md) encaminha a sessão às lentes de revisão e sintetiza propostas como `Accepted`, `Rejected` e `Backlog`. Aguarda sua aprovação antes de alterar skills. Aceite uma proposta quando ela mudar uma decisão futura; um caso isolado ainda pode ser exceção.

## Corrija erros recorrentes com correct

Quando você repete a mesma correção em vários PRs, procure uma mudança no repositório que a torne desnecessária. A ordem de preferência é:

1. Uma arquitetura ou estrutura de dados que impeça o erro.
2. Um tipo, lint ou check de CI que o bloqueie e explique a correção.
3. Um teste que o detecte.
4. Uma regra escrita, quando as opções anteriores não servirem.

```text
/correct agentes continuam acessando o cliente do banco diretamente em vez de passar pela camada de repositório.
```

O [correct](../../skills/correct/SKILL.md) examina commits, reverts, reviews e soluções improvisadas, agrupa erros recorrentes e corrige as classes mais frequentes. Cada novo check precisa detectar uma ocorrência real do erro. A skill também relaciona regras às estruturas que as impõem.

Reflect melhora skills a partir de uma sessão. Correct muda o repositório a partir de erros repetidos. Combine correct com architect quando a solução exigir novos limites entre módulos.

## Escreva uma skill focada

```text
/poteto-mode escreva uma skill para verificar migrações de banco neste projeto.
```

O [playbook de autoria](../../skills/poteto-mode/playbooks/authoring-a-skill.md) usa a ferramenta de criação disponível, valida metadados e links e encaminha a entrega pelo fluxo de PR. Instruções para agentes precisam dizer quando agir, como conferir e onde parar.

Para skills que operam e verificam um aplicativo, use os geradores específicos [create-verification-skill](../../skills/create-verification-skill/SKILL.md) e [maintain-verification-skill](../../skills/maintain-verification-skill/SKILL.md), descritos no [capítulo de verificação](06-verify-and-ship.md#crie-uma-skill-de-verificação).

## Revise documentação com technical-writing

```text
/technical-writing revise as mudanças do README.
```

O [technical-writing](../../skills/technical-writing/SKILL.md) escolhe o formato adequado, como tutorial, how-to, referência ou explicação, e confere clareza, sequência e precisão. Use-o para revisar um texto ou cite-o ao pedir a redação.

## Avalie mudanças de skill

```text
/poteto-mode execute o playbook Eval nesta mudança de skill. use a mesma tarefa nas duas variantes e mantenha as candidatas sem saber da avaliação.
```

O [Eval](../../skills/poteto-mode/playbooks/eval.md) evita que o agente adapte o comportamento por saber que está sendo avaliado. As candidatas recebem tarefas normais em ambientes preparados, e o juiz vê saídas com rótulos neutros. A conferência inclui os arquivos realmente lidos.

Quando já souber o defeito:

```text
/poteto-mode atualize a skill de review para detectar migrações faltantes e avalie a mudança.
```

Leia as saídas antes de aceitar o veredito. Se o juiz premiar algo que não atende à tarefa, revise a rubrica.

## Confira o que depende de outra plataforma

A skill make-bot-ui e o pacote Benny do upstream dependem de recursos da Cursor e não fazem parte deste port. O [catálogo do que ficou de fora](../reference.md#o-que-ficou-de-fora) registra essas diferenças. Grok Build como ambiente de programação não implica suporte às rotinas de Grok Bot descritas pelo upstream.

Mantenha correções de skills em PRs próprios quando surgirem durante uma feature. Assim a mudança de processo pode ser revisada e avaliada separadamente.

Próximo: [Receitas e erros comuns](10-recipes-and-pitfalls.md).

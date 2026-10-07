# Guia do pstack-vic

Descreva o resultado que quer e como vai conferir se ele funciona. O `/poteto-mode` escolhe o playbook, chama as skills necessárias e apresenta as evidências. Este guia ensina esse jeito de trabalhar com exemplos para Claude Code, Codex e Grok Build.

Leia os capítulos em ordem na primeira vez. Depois, volte direto à tarefa que precisa fazer.

1. [Configurar o pstack-vic](01-setup.md). Instalar, escolher modelos e executar a primeira tarefa.
2. [Conduzir tarefas com poteto-mode](02-poteto-mode.md). Dar contexto e um critério de conclusão, acompanhar e redirecionar.
3. [Entender o código](03-understand.md). Investigar, explicar o comportamento, recuperar decisões e retomar trabalho.
4. [Desenhar a mudança](04-design.md). Comparar alternativas, testar protótipos e só então escrever o plano.
5. [Implementar e limpar a mudança](05-build-and-clean.md). Formular bugs, features, refatorações e melhorias de performance.
6. [Verificar e entregar](06-verify-and-ship.md). Produzir provas, conferir medições, abrir e acompanhar PRs.
7. [Deixar trabalho em execução](07-overnight.md). Definir autonomia, manter uma trilha e coordenar filas de PRs.
8. [Orientar pelos princípios](08-principles.md). Usar os nomes das regras para corrigir o rumo.
9. [Adaptar ao seu trabalho](09-make-it-yours.md). Criar um modo pessoal, corrigir erros recorrentes e avaliar skills.
10. [Receitas e erros comuns](10-recipes-and-pitfalls.md). Copiar prompts e reconhecer problemas.

Os exemplos usam nomes curtos, como `/poteto-mode`. No Claude Code, o plugin os apresenta com prefixo, como `/pstack:poteto-mode`. No Codex, peça a skill pelo nome `pstack:poteto-mode`. No Grok Build, use o nome que o plugin apresenta na sessão.

Se não souber qual fluxo escolher, peça ajuda:

```text
/poteto-help qual skill uso para revisar esta branch?
```

O [poteto-help](../../skills/poteto-help/SKILL.md) explica, oferece um prompt e aponta a fonte. A execução começa quando você pede o trabalho.

## Comece com uma tarefa verificável

```text
/poteto-mode a exportação duplica linhas quando há uma tentativa de recuperação no meio da execução. reproduza, corrija e verifique.
```

O sintoma e o resultado esperado dão ao agente informação suficiente para escolher Bug fix. Você acompanha os passos na lista de tarefas e confere as provas ao final.

O [README](../../README.md) apresenta o projeto. A [referência técnica](../reference.md) concentra instalação detalhada, configurações, ferramentas e contratos. Este guia ensina a usar esses recursos.

## Origem e atualização

Adaptação em português do [guia de Lauren Tan no pstack da Cursor](https://github.com/cursor/plugins/tree/df581122cde17e6e27686b5a448bde23e4ad4318/pstack/docs/guide), incluindo a revisão de 5 de outubro de 2026. Os dez capítulos e as seis ilustrações mantêm a origem sob licença MIT. As adaptações de ambiente e o procedimento de atualização estão em [UPSTREAM.md](../../UPSTREAM.md#guia-de-uso) e [NOTICE.md](../../NOTICE.md).

Próximo: [Configurar o pstack-vic](01-setup.md).

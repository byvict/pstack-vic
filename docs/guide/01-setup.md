# Configurar o pstack-vic

Instale o plugin no ambiente em que vai trabalhar, escolha os modelos e rode uma tarefa pequena. A configuração vale para novas sessões.

## Instale o plugin

Siga os comandos do [README](../../README.md#começar), que mantém a tag da versão publicada. A [referência de instalação](../reference.md#instalação) explica instalação por marketplace, uso de um clone e configuração dos subagentes.

Claude Code e Codex têm instalações próprias. No Grok Build, este port usa a compatibilidade que descobre o plugin instalado no Claude Code. Instalar o plugin não configura os modelos de todos os ambientes de uma vez.

## Escolha os modelos

```text
/setup-pstack
```

O [setup-pstack](../../skills/setup-pstack/SKILL.md) mostra os papéis, os modelos atribuídos e o esforço de raciocínio. Você pode manter o mapa ou mudar os papéis necessários. Ele verifica as novas famílias antes de gravar e preserva escolhas existentes numa nova execução.

Cada atribuição identifica provedor, modelo e esforço. Os valores aceitos e os padrões vêm da [matriz de papéis](../../skills/poteto-mode/references/provider-dispatch.md#role-defaults). Use o setup para mudar a configuração; não precisa decorar descritores nem editar os arquivos manualmente.

Um papel com `auto` ou `inherit-parent` usa o modelo da conversa principal. Em um painel, cada entrada representa uma participante. Encurtar a lista reduz o painel. O papel `swarm workers` escolhe o modelo dos trabalhadores de um swarm, salvo quando a tarefa define explicitamente modelos por tentativa.

Execute o setup uma vez em cada ambiente que usar. Os arquivos e a integração com `CLAUDE.md` ou `AGENTS.md` estão na [referência](../reference.md) e nas [regras dos diretórios de configuração](../../skills/poteto-mode/references/codex-tools.md#harness-config-homes). Abra uma nova sessão depois de gravar.

## Prepare a verificação do projeto

Confira se o projeto já tem uma skill `verify-*` ou uma ferramenta que permita ao agente operar o aplicativo e guardar provas. Se não tiver, peça:

```text
/create-verification-skill
```

O [gerador](../../skills/create-verification-skill/SKILL.md) investiga o repositório, escreve a skill e precisa demonstrá-la funcionando antes de entregar. O [capítulo de verificação](06-verify-and-ship.md#crie-uma-skill-de-verificação) explica como usar e manter esse recurso.

Este é um bom investimento inicial. Com uma forma de conferir o resultado, o agente consegue corrigir o próprio trabalho. Sem ela, você recebe mais verificações manuais para fazer.

## Controle o custo

Subagentes e painéis consomem sessões adicionais. Para reduzir o custo:

- Escolha modelos mais baratos ou menor esforço nos papéis apropriados pelo setup.
- Reduza o número de entradas dos painéis.
- Use `auto` ou `inherit-parent` quando quiser herdar um modelo mais barato da conversa.
- Reserve `/poteto-mode` para tarefas que precisam desse rigor.

O custo depende dos modelos e do trabalho executado. Herdar o modelo da conversa, por si só, não garante economia.

## Execute a primeira tarefa

```text
/poteto-mode adicione --json a este comando. preserve a saída textual byte a byte. verifique as duas formas.
```

A lista de tarefas deve começar pelos passos do playbook Feature. Se um passo não se aplicar, ele permanece na lista com `skip: <motivo>`.

O port ativa os fluxos quando você nomeia a skill ou quando um fluxo pstack já ativo a chama. `/setup-pstack` e `/poteto-help` também podem responder a pedidos comuns. Comece cada nova tarefa com `/poteto-mode` novamente. O port não oferece o Custom Mode da Cursor que reaplica a skill a cada turno; uma conversa longa pode resumir suas instruções.

Próximo: [Conduzir tarefas com poteto-mode](02-poteto-mode.md).

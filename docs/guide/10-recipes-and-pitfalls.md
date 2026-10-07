# Receitas e erros comuns

Copie o prompt que corresponde à tarefa e substitua arquivos, sintomas e critérios de conclusão. Os nomes curtos seguem a convenção explicada no [índice](README.md).

![Agentes seguem receitas enquanto a operadora confere o resultado.](images/recipes.jpg)

## Entender um subsistema

```text
use /how para entender esta inicialização e /why para descobrir por que ela mudou recentemente.
```

Confira as fontes de comportamento e de história antes de alterar o código.

## Confirmar o problema antes de editar

```text
/poteto-mode leia esta conversa e explique o problema com suas palavras. não altere código ainda.
```

Corrija a interpretação primeiro. Depois apresente sua hipótese sobre a causa.

## Comparar protótipos

```text
/poteto-mode faça alguns protótipos para a tela de configurações. permita alternar entre eles e mostre screenshots.
```

Compare alternativas em execução e use as provas para escolher.

## Transformar o desenho em plano

```text
/poteto-mode transforme este desenho em um plano. PRs pequenos e verificáveis, cada um com suas próprias provas.
```

Peça depois que as decisões centrais estiverem demonstradas. O plano identifica o fluxo de execução e aguarda seu go.

## Obter outras propostas

```text
use /arena para comparar nossa abordagem com outras propostas para este problema.
```

A abordagem atual vira uma candidata, e a síntese mostra o que cada alternativa acrescenta.

## Distribuir verificações independentes

```text
/swarm execute o check.sh de cada pacote em packages/. um trabalhador por pacote, com recursos isolados, e um relatório final.
```

Confira o resultado de cada fatia e as lacunas declaradas.

## Revisar uma branch

```text
/interrogate revise a branch inteira. não altere nada ainda. priorize bugs e regressões de comportamento.
```

A restrição mantém a tarefa como revisão. Examine também as justificativas dos achados descartados.

## Corrigir com um teste que falha

```text
/poteto-mode reproduza a gravação duplicada. se houver um teste local direto, use /tdd. depois corrija e execute novamente.
```

Evite uma estrutura de mocks que prove menos que executar o comando real.

## Reproduzir com a skill do projeto

```text
/poteto-mode reproduza com /verify-<app>. se ocorrer na main, corrija e mostre um vídeo.
```

Se o problema já tiver desaparecido na main, o agente pode apresentar essa evidência e encerrar a investigação.

## Conferir um ganho de performance

```text
/benchmark-checklist confira este ganho de 40% antes de incluí-lo na descrição do PR.
```

Exija execuções comparáveis, dispersão e explicação do fator limitante.

## Parar de repetir uma correção

```text
/correct agentes continuam adicionando opções de configuração sem registrá-las no schema.
```

A correção deve entrar como arquitetura, tipo, lint ou teste quando viável.

## Pedir ajuda sem iniciar uma execução

```text
/poteto-help como mantenho o poteto-mode orientando uma tarefa longa neste ambiente?
```

A resposta explica a situação, oferece um prompt e aponta a fonte.

## Continuar durante sua ausência

```text
vou me ausentar. continue até todas as fixtures passarem, dentro das permissões que combinamos. registre as decisões para eu revisar depois.
```

A forma curta funciona quando objetivo, isolamento e cadência já estão definidos. O [capítulo de autonomia](07-overnight.md) mostra o contrato completo.

## Corrigir o rumo

```text
o objetivo desta etapa é reproduzir. ainda não pedi uma correção.
```

```text
aplique prove it works. mostre a saída real.
```

```text
/unslop deixe a explicação mais direta.
```

Os [princípios](08-principles.md) dão nomes precisos às decisões que você quer mudar.

## Pedir uma explicação mais simples

```text
/bro
```

O [bro](../../skills/bro/SKILL.md) reescreve a última resposta de forma curta e direta.

## Reconhecer os erros comuns

- **Enumerar skills em vez de definir o objetivo.** Deixe o playbook organizar a sequência; nomeie uma skill para mudar uma escolha específica.
- **Usar um critério vago.** Troque “melhore isso” por um comando, artefato ou estado que possa ser conferido.
- **Começar pela sua teoria.** Peça primeiro uma interpretação independente do problema.
- **Aceitar o primeiro desenho.** Compare alternativas quando a decisão for difícil de reverter.
- **Revisar um plano abstrato indefinidamente.** Resolva as dúvidas com protótipos e revise o código produzido.
- **Compartilhar worktree entre escritores.** Separe branches, diretórios e recursos de execução.
- **Automatizar antes de verificar.** Demonstre o fluxo completo antes de deixá-lo rodando sozinho.
- **Confiar em um número sem conferir o método.** Cache, erros ou trabalho fora do cronômetro podem distorcer o resultado.
- **Repetir correções no chat.** Use correct para transformar a regra em algo que o repositório imponha.
- **Usar arena para dividir cobertura.** Arena compara candidatas completas; swarm distribui fatias ou corridas.
- **Aceitar todo comentário de review.** Confira tanto o achado quanto sua eventual rejeição.
- **Tratar auto como modelo específico.** Auto e inherit-parent herdam o modelo da conversa.
- **Declarar sucesso só porque compilou.** Confira o fluxo, o valor salvo ou a saída real.
- **Escrever uma skill sem validação.** Use o [playbook de autoria](../../skills/poteto-mode/playbooks/authoring-a-skill.md).

Volte à [configuração](01-setup.md) e experimente uma tarefa pequena, ou consulte o [índice do guia](README.md) para aprofundar um fluxo.

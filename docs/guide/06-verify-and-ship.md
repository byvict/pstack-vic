# Verificar o resultado e entregar o PR

Defina qual artefato demonstra que a mudança funciona. O princípio [Prove It Works](../../skills/principle-prove-it-works/SKILL.md) exige conferir o resultado real antes de declarar sucesso. Quanto mais dessa conferência o agente consegue executar, menos trabalho manual sobra para você.

![Um protótipo percorre um circuito enquanto agentes medem e registram a execução.](images/verification.jpg)

## Defina o critério de conclusão

```text
/poteto-mode adicione JSON a este comando. o texto deve continuar idêntico, o JSON deve ser válido e as duas formas devem rodar no projeto de exemplo. mostre as provas.
```

A entrega tem três verificações observáveis. Confira os comandos e resultados. Se uma verificação não puder rodar, o relatório precisa dizer o que ficou inconclusivo.

Escolha a prova conforme a mudança:

- CLI: executar o comando real.
- UI: percorrer o fluxo no aplicativo. Para equivalência visual, [Visual parity](../../skills/poteto-mode/playbooks/visual-parity.md) compara imagens com uma referência fixa.
- Parser ou migração: reproduzir uma entrada salva.
- Performance: comparar perfis e medidas antes e depois.
- Persistência: ler de volta o valor escrito.

Peça arquivos que consiga inspecionar, como teste antes e depois, vídeo, trace ou screenshot. Se a correção já estiver mergeada, a mesma verificação pode ser repetida na main.

Para um diff pequeno com efeitos fora dos arquivos alterados, [blast-radius](../../skills/blast-radius/SKILL.md) procura a hipótese que torna a mudança segura e a verifica executando código.

## Confira medições com benchmark-checklist

```text
/benchmark-checklist confira o ganho da exportação antes de colocarmos o número no PR.
```

O [benchmark-checklist](../../skills/benchmark-checklist/SKILL.md) pede evidências para sete perguntas:

1. O que limita o número e por que ele não é o dobro?
2. Os dois lados foram ajustados como seriam em produção?
3. O resultado viola algum limite físico, como banda de disco ou quantidade de núcleos?
4. Houve erro ou saída incorreta?
5. O resultado se repete em execuções alternadas, com mediana e dispersão?
6. A diferença importa no caminho completo que o usuário espera?
7. O trabalho aconteceu dentro do trecho cronometrado?

O resultado pode ser mais rápido, mais lento, sem diferença mensurável ou inconclusivo. Ele inclui quantidade de execuções, dispersão e fator limitante. Os playbooks Perf issue e Hillclimb já chamam a skill; use-a diretamente para medições feitas fora deles.

## Crie uma skill de verificação

```text
/create-verification-skill
```

O [gerador](../../skills/create-verification-skill/SKILL.md) investiga como o aplicativo inicia, o que o usuário opera, quais ferramentas podem controlá-lo e que evidências comprovam cada comportamento. Prefere ferramentas existentes e só pergunta o que o repositório não responde.

No Claude Code, ele escreve `.claude/skills/verify-<app>/`, com seções de inicialização, diagnóstico, operação, evidência e limpeza, além de um mapa de funcionalidades. No Codex ou Grok, o gerador deve usar o diretório de skills de projeto do ambiente ativo. O [exemplo de mapa](../../skills/create-verification-skill/references/feature-map-example/) mostra a estrutura.

Antes de entregar, o gerador precisa iniciar o aplicativo, conferir o ambiente, operar uma funcionalidade, registrar a prova e limpar os recursos. Uma geração que falha nessa demonstração ainda não está pronta.

Passe a nomear a skill nos pedidos:

```text
/poteto-mode implemente o arquivamento em lote. use /verify-<app> e mostre vídeo e screenshots.
```

```text
/poteto-mode reproduza com /verify-<app>. se ocorrer na main, corrija e mostre um vídeo da correção.
```

A skill precisa de ferramentas reais na sessão. Os mapas de [Codex](../../skills/poteto-mode/references/codex-tools.md) e [Grok](../../skills/poteto-mode/references/grok-tools.md) explicam as substituições. Uma sessão sem o driver necessário deve registrar a lacuna.

Com uma verificação confiável, [swarm](../../skills/swarm/SKILL.md) pode distribuir funcionalidades entre verificadores. Cada instância precisa dos seus próprios recursos e provas.

## Transforme verificações repetidas em ferramentas

Versione a skill para que pessoas e agentes executem o mesmo procedimento. Quando aparecerem scripts descartáveis repetidos para operar o aplicativo, construa uma pequena CLI que a skill possa chamar.

Uma interface útil para agentes tem comandos que fazem trabalho completo, ajuda clara, erros que indicam a correção e saída legível por máquina. Operações destrutivas devem oferecer uma forma de prévia quando aplicável.

Prepare também dados de exemplo, usuários de teste e uma inicialização reproduzível. O princípio [Build the Lever](../../skills/principle-build-the-lever/SKILL.md) explica essa escolha.

## Mantenha a verificação atualizada

```text
/maintain-verification-skill
```

O [mantenedor](../../skills/maintain-verification-skill/SKILL.md) compara o mapa com o código e executa uma passagem pelo aplicativo. `clean` significa cobertura íntegra; `changed`, correções comprovadas na skill; `blocked`, um impedimento identificado.

Ele não corrige produto para fazer a prova passar. Uma regressão encontrada no aplicativo é relatada como tal. Em projetos ativos, revise a skill diariamente, com agendamento explícito no ambiente se isso fizer sentido.

## Abra o PR

```text
/poteto-mode abra o PR com commits pequenos e ordenados. inclua as evidências na descrição.
```

O [Opening a PR](../../skills/poteto-mode/playbooks/opening-a-pr.md) organiza a branch, limpa o diff e retorna o link. Divida mudanças independentes em PRs que possam ser entendidos e verificados individualmente.

## Acompanhe até ficar pronto para merge

```text
/poteto-mode babysit este PR e resolva os bloqueios.
```

O [Babysit](../../skills/poteto-mode/playbooks/babysit.md) acompanha conflitos, comentários e CI, agrupa correções conhecidas e aplica as regras de triagem. Achados precisam de evidência; uma rejeição também precisa de justificativa.

Se quiser apenas o estado:

```text
/poteto-mode confira o PR 123. há algo pendente?
```

Babysit para em merge-ready. O merge exige uma instrução correspondente.

## Entregue com Shipping

```text
/poteto-mode faça o merge da pilha.
```

O [Shipping](../../skills/poteto-mode/playbooks/shipping.md) verifica cada PR de forma independente e entrega a sequência comprovada de baixo para cima. Uma mudança acima de outra ainda não verificada precisa esperar.

No port, merge autônomo também depende da [autorização permanente](../reference.md#autorização-permanente) ou da autorização do operador conforme o fluxo. O contrato de evidência, reaproveitamento por patch-id e checks atuais está em Shipping; a [referência de autopilot](../reference.md#autopilot) detalha a operação.

Próximo: [Deixar trabalho em execução](07-overnight.md).

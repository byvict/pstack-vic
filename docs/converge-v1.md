# Converge v1: verificar, corrigir e fazer merge no Cloud

Escopo revisado com Victor em 2026-09-23. Este é o plano vigente. Substitui a arquitetura, os papéis, o protocolo de execução e os critérios de entrega do [plano anterior](converge-plan.md). A execução foi autorizada em 2026-09-23.

## Objetivo e fluxo

Quando o agente local abre um PR pronto, ele entrega o trabalho ao Cursor Cloud Agents. O processo no Cloud verifica a mudança, executa os testes pertinentes, usa o aplicativo quando o comportamento é observável nele, corrige problemas e verifica novamente. Com aprovação e checks obrigatórios verdes, faz merge automático e acompanha os testes do commit resultante no `main`. O humano entra quando o processo não consegue avançar ou quando intervém explicitamente.

Todos os agentes desse fluxo usam exclusivamente Grok 4.7 no Cursor Cloud Agents. Tarefas simples usam `high`; tarefas complexas, análise de risco e problemas que exigem investigação mais profunda usam `xhigh`. A escolha de esforço não cria outro papel. As linhas `pr owner` e `pr verifier` do sheet de modelos são pisos: o `start.ts` lança o owner no esforço do sheet (ou `xhigh` quando `--effort xhigh` pede), e o prompt do owner obriga o verifier a não ficar abaixo do piso dele. Não usar Composer, Codex, Opus, Grok CLI ou comparação entre modelos no fluxo pós-PR.

O ciclo é:

1. **Entregar.** O agente local abre o PR, dispara o responsável Cloud e registra a identificação da execução. Sua entrega termina quando o lançamento está confirmado. Falha de lançamento fica explícita e não autoriza merge.
2. **Verificar.** O verificador independente lê a mudança e os checks, testa o comportamento afetado e entrega evidências. A análise de risco faz parte dessa verificação.
3. **Corrigir e repetir.** O responsável corrige os problemas encontrados e solicita nova verificação do resultado. Esperar CI ou recuperar uma falha de ambiente não conta como corrigir código. Publicar um veredito não exige encerrar o turno nem aguardar o agente local para continuar.
4. **Fazer merge.** O responsável confirma que o veredito e os checks correspondem ao commit atual, respeita as proteções e os bloqueios humanos, executa o merge automático e acompanha os testes do `main`.
5. **Devolver ao humano quando necessário.** Se não conseguir resolver, publica a causa, as tentativas e as evidências e aplica `needs-victor`. Falta de evidência nunca se transforma em aprovação.

## Duas responsabilidades

| Responsabilidade | Trabalho |
| --- | --- |
| Responsável pelo PR | Conduz o ciclo no Cloud, diagnostica e corrige, acompanha os checks, solicita nova verificação e conclui o merge. |
| Verificador independente | Inspeciona o código e o risco, executa a verificação pertinente e entrega o resultado com evidências. Não corrige a branch que está verificando. |

Eliminar o grupo de diagnóstico e os papéis separados de revisor de risco, corretor simples e corretor complexo. Preservar a independência entre quem corrige e quem verifica. As duas responsabilidades não exigem agentes adicionais para cada etapa.

O processo precisa registrar seu progresso para retomar sem duplicar escritores, perder tentativas ou repetir um lançamento de resultado desconhecido. Precisa também de um limite explícito de tentativas e duração para impedir repetição infinita. Esses limites são parâmetros operacionais do ciclo, não metas de uma campanha de avaliação. A implementação deve defini-los e documentá-los sem herdar automaticamente as ramificações e os limites do plano antigo.

## O que manter, simplificar e descartar

| Parte existente | Decisão |
| --- | --- |
| Cliente do Cursor Cloud e seleção de modelo/esforço | Manter. Reutilizar lançamento, acompanhamento e recibos. Corrigir a observação de branches para que um push de outro PR não invalide esta verificação. |
| `verify-clinext`, ferramentas de execução e mapa de funcionalidades | Manter. Usar o ambiente separado e evidências reais do comportamento afetado. |
| Publicação do veredito e checagens de merge | Manter o vínculo com o commit, os checks obrigatórios, a proteção de branch e o bloqueio humano. Adaptar ao ciclo simplificado. |
| Coordenação do Converge | Substituir a sequência fragmentada entre papéis e turnos pelo ciclo descrito acima, com início e continuação executáveis. |
| Seleção da verificação | Corrigir. Alterações em componentes compartilhados e rotas precisam ser relacionadas ao comportamento afetado; ausência de correspondência direta com uma página não é, por si só, impedimento definitivo. |
| Regras sobre texto e formato de evidências | Simplificar. Não tratar um comentário comum como ataque nem exigir alterações documentais sem relação com o comportamento. Manter a conferência das evidências e a separação entre dados do PR e instruções confiáveis. |
| Testes locais das peças mantidas | Preservar os que verificam comportamento relevante. Ajustar os afetados pela simplificação e retirar os que só fixam a estrutura descartada. |
| Infraestrutura de prova do PR-D #5 | Não incorporar à entrega. Preservar o histórico, conferir o diff atualizado e separar eventuais correções úteis de produção antes de encerrar o PR. |
| Corpus histórico, metas de acerto, painéis entre modelos e provas de encerramento nativo de turno | Retirar dos critérios de entrega. Não retomar a campanha. |
| Aprendizado automático a partir dos tropeços | Deixar para uma segunda fase, baseada nos PRs reais. |

## Pendências confirmadas na análise

As peças de verificação e merge existem, mas isso não demonstra que o ciclo completo esteja operacional.

- O Clinext instrui a sessão autora a encerrar no PR e diz que Converge assume. Nos arquivos examinados, não há um disparo implementado que complete essa passagem.
- O playbook manda encerrar o turno após publicar e retomar correção ou merge em outro turno. As ferramentas examinadas não fornecem a continuação automática correspondente.
- A configuração ainda contém Composer e o grupo de quatro modelos para diagnóstico.
- Um comentário comum como `Reviewer: Maria. Testes passaram.` foi classificado como injeção bloqueante em uma reprodução local.
- Uma alteração em `client/components/Button.jsx` ficou sem funcionalidade mapeada em uma reprodução local. A seleção atual depende de correspondência direta com o arquivo da página.
- O cliente compara todas as branches remotas ao verificar uma execução somente leitura, permitindo que atividade de outro PR invalide o resultado.
- Na consulta ao GitHub em 2026-09-23, a proteção de `main` exigia `Run test suite` e `Secrets scan`, mas ainda não exigia `verdict`. O comando de merge do Converge exige essa configuração.

Esses achados orientam correções focadas. Não autorizam reconstruir todo o plugin nem ampliar a investigação para todos os casos possíveis.

## Trabalho de implementação, quando solicitado

1. **Simplificar o fluxo existente.** Reduzir os papéis às duas responsabilidades, usar somente Grok 4.7 High/XHigh, incorporar risco à verificação e remover a pausa obrigatória entre publicação e próxima ação. Atualizar código, instruções, exemplos e configurações atingidos juntos. Concluir quando não houver caminho ativo que dependa dos papéis descartados.
2. **Ligar a entrega e a continuação.** Implementar o disparo a partir do PR pronto e garantir que o responsável Cloud tenha as instruções, ferramentas e acessos necessários para concluir o ciclo. Registrar a execução e o progresso. Concluir quando o agente local puder encerrar após o lançamento confirmado e o Cloud continuar sem sua supervisão.
3. **Corrigir os bloqueios concretos.** Ajustar a seleção do comportamento afetado, os falsos positivos de texto e a interferência entre branches. Preservar o vínculo das evidências com o commit e as proteções de merge. Rodar os checks pertinentes ao que mudou.
4. **Provar o ciclo e ativar.** Executar a prova descrita abaixo. Conferir autenticação e proteção de branch no Clinext, incluindo `verdict`, antes de ativar o merge do fluxo. Habilitar o contexto obrigatório somente quando sua publicação funcionar. Separar eventuais correções úteis do PR-D, preservar os registros e encerrar a campanha antiga.

Quem implementa decide os detalhes técnicos com base no código e nas falhas observadas. Não transferir a Victor a escolha de quais arquivos ou componentes reaproveitar. Pedir sua intervenção apenas quando faltar um acesso ou uma decisão que o agente realmente não possa obter ou executar dentro da autorização.

## Prova de entrega

Fazer uma prova curta que percorra o caminho real: entrega do PR ao Cloud, detecção de um defeito conhecido, correção, nova verificação, publicação do resultado no commit certo e merge automático. Usar um ambiente de prova isolado com autorização de merge, sem introduzir defeitos ou dados de teste na produção do Clinext. A prova deve usar os mesmos caminhos de execução destinados aos PRs reais.

Um PR sob `needs-victor` serve para confirmar que o bloqueio impede merge; ele não prova o caminho de merge. Os testes locais devem cobrir as recusas essenciais, como commit alterado após a verificação, check obrigatório vermelho e bloqueio humano.

Depois, acompanhar o primeiro PR real disponível do Clinext até o merge e os testes do `main`. Não fabricar uma mudança de produção só para completar essa etapa. Se não houver PR disponível, informar que a prova controlada terminou e que o acompanhamento real continua pendente.

Registrar o PR, as execuções Cloud, o modelo e esforço solicitados, as evidências, a correção realizada, o veredito e o resultado do merge. Recibo de seleção comprova o modelo solicitado; não afirmar confirmação do modelo servido sem evidência do provedor.

Falhas nessa prova geram correções pontuais e repetição apenas do trecho afetado. A v1 não depende de quinze casos históricos por papel, dez painéis, comparação entre modelos, placar de acerto ou nova rodada completa a cada commit.

## Resultado esperado

Victor trabalha no projeto, o agente local entrega o PR e o processo no Cloud cuida da verificação, das correções e do merge. O relatório de entrega deve distinguir o que foi implementado, o que foi observado funcionando e qualquer pendência de ativação ou acompanhamento real.

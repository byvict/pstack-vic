---
status: accepted
---

# Revisor da trilha de outra família da raiz

Em 2026-10-07, a reavaliação autorizada pelo operador troca a exclusão de todas as famílias autoras pela exclusão da família da raiz. A trilha continua exigindo revisão antes da conclusão. Um pool sem execução bem-sucedida deixa revisão pendente; não é uma dispensa de processo. Esta decisão complementa o [ADR 0005](0005-autopilot-substitui-converge.md), sem ativar poteto-mode para implementá-la.

## Evidência e interpretação

Base local: `c3299a004e3b256ded366522b2696a58cd5084c2`. Referência: pstack 0.15.10, `4e5b1cf2ccb0ea3716f08c8ee0a5856b5ab93536`, sem avançar `UPSTREAM.md`.

- Na [skill upstream](https://github.com/cursor/plugins/blob/4e5b1cf2ccb0ea3716f08c8ee0a5856b5ab93536/pstack/skills/show-me-your-work/SKILL.md), *Logging a row* define run como uma conversa de agente. *Cross-model review of the trail* exige, antes da devolução, um subagente de família diferente de quem fez o trabalho, e identificação do reviewer na resposta. Não há exclusão da união de provedores autores nem alternativa de entrega considerada concluída sem revisor.
- Na [skill local da base](https://github.com/byvict/pstack-vic/blob/c3299a004e3b256ded366522b2696a58cd5084c2/skills/show-me-your-work/SKILL.md), a união inclui a raiz e todas as lanes de escrita incorporadas. Pool vazio permite `not reviewed: no cross-family reviewer`. [setup-pstack.ts](https://github.com/byvict/pstack-vic/blob/c3299a004e3b256ded366522b2696a58cd5084c2/skills/setup-pstack/scripts/setup-pstack.ts), `pickLane`, repassa todos os executores ao [seletor compartilhado](https://github.com/byvict/pstack-vic/blob/c3299a004e3b256ded366522b2696a58cd5084c2/scripts/model-matrix.ts), `pickCrossFamily`. Os testes antigos esperam pool vazio quando os três provedores escreveram.
- O [contrato compartilhado da base](https://github.com/byvict/pstack-vic/blob/c3299a004e3b256ded366522b2696a58cd5084c2/skills/poteto-mode/references/provider-dispatch.md), *Cross-family selection*, aplica a mesma exclusão à trilha e à Arena. A [Arena local](https://github.com/byvict/pstack-vic/blob/c3299a004e3b256ded366522b2696a58cd5084c2/skills/arena/SKILL.md) tem fallbacks explícitos próprios. Não foram alterados nesta decisão.

O critério operacional adotado é outra família que a raiz responsável pela entrega, conforme o pedido do operador e o contexto da skill upstream. O texto upstream não detalha todas as árvores possíveis de coautoria; interpretar sua frase como exclusão de todo provedor autor era uma política adicional do port. Família continua significando provedor: Sol e Astra pertencem à mesma família Codex. Um contexto novo em outro provedor separa o reviewer do escritor concreto; não demonstra independência estatística entre modelos.

As auditorias `2026-10-07-pstack-codex-fidelity-audit.md` e `2026-10-07-cursor-exercise-audit.md` foram lidas pelos caminhos absolutos sob `/Users/victorbaccega/.codex/worktrees/1a40/pstack-vic/docs/research/`, onde estavam untracked. A primeira indicou o desvio, aqui conferido no código e no pin. A segunda declara que o exercício não testou este esgotamento do pool; não serve como prova desse comportamento, de modelo servido ou de equivalência de runtime.

## Decisões e consequências

| Tema | Base local | Upstream no pin | Decisão e razão |
| --- | --- | --- | --- |
| Elegibilidade | Excluir raiz e todos os provedores autores; três autores esgotam o pool. | Reviewer de outra família do agente responsável pelo trabalho; não enumera coautores. | `pickLane` exclui só a raiz para `trail reviewer pool`. Os três provedores podem participar da autoria sem eliminar a revisão. Um escritor concreto não é retomado como reviewer: a skill pede um contexto novo. |
| Escolha do modelo | Pool ordenado, selecionado por script, preservando descritor e esforço. | A skill exige outra família, sem este seletor ou papel configurável. | Manter a escolha pessoal de modelos e a ordem do pool, por decisão explícita do operador. Não trocar modelos silenciosamente. A mudança afeta elegibilidade, não a configuração. |
| Falha e dispensa | Próxima lane elegível após dropout; se esgotar, resposta sem revisor é admitida. | Revisão exigida antes da devolução; nenhuma dispensa descrita. | Manter recuperação pela próxima entrada configurada. Se nenhuma completar, comunicar `review pending`, artefatos disponíveis e obstáculo concreto como trabalho incompleto. Retomar quando houver uma rota elegível. Não inventar aprovação, repetir indefinidamente ou contornar recusa do host. |
| Validação do pool | Alias ou apenas família da raiz são recusados; um único outro provedor gera alerta de possível esgotamento por autoria. | Outra família é necessária. | Preservar a validação útil; retirar o alerta de coautoria, que deixou de ser verdadeiro. Outra família basta para elegibilidade, embora sua execução possa falhar. |
| Trilhas de filhos | Raiz lança um reviewer por trilha, evitando recursão em lanes. | Skill pede subagente; o executor controla a composição. | Manter a coordenação na raiz. Para a seleção, `--parent` identifica a raiz responsável, inclusive ao revisar trilha recebida de filho. É adaptação local de execução, não promessa de cloud. |
| Arena | Exclui raiz e candidato-base provável, com fallbacks próprios. | Há preferência de diversidade na Arena. | Preservar neste PR. Reusar um helper não deve estender a mudança da trilha a outro papel. |

## Contrato implementado e dependência com provider-dispatch

`setup-pstack.ts pick --parent <raiz> --role "trail reviewer pool"` retorna `chosen` e `eligible` na ordem do sheet. `--executor` continua validando nomes recebidos, mas não elimina coautores neste papel; o campo legado `executors` do resultado contém os provedores efetivamente excluídos, somente a raiz. Para Arena, argumentos e resultado conservam o significado anterior. A validação do input usa o helper existente; a seleção da trilha o chama com a raiz como única exclusão. Nenhum runner, transporte, helper compartilhado de matriz ou configuração pessoal foi modificado.

Por determinação do operador, `skills/poteto-mode/references/provider-dispatch.md` pertence à outra frente e não é editado simultaneamente. A skill da trilha é a autoridade de elegibilidade e conclusão deste papel; consulta provider-dispatch para transporte e evidência. Antes de publicar uma distribuição integrada, a frente proprietária precisa reconciliar estes pontos:

1. Em *Cross-family selection*, separar a regra da trilha (somente raiz) da regra/fallbacks de Arena; retirar a dispensa automática da trilha. Documentar a semântica de `--executor` e `executors` acima.
2. Atualizar a descrição de `trail reviewer pool` em `model-matrix.json` e regenerar a tabela de papéis em provider-dispatch. Preservar os descritores, esforços, ordem e defaults pessoais. Esse texto gerado ainda diz que o provedor não escreveu nenhuma parte; não é a regra da trilha após este PR.
3. Preservar a capacidade de iniciar um contexto novo, read-only, no descritor escolhido e com acesso aos caminhos da trilha e transcript. Uma execução conta com resultado e evidência de modelo conforme o contrato existente. Dropout ou recusa precisam permanecer distinguíveis de revisão concluída. Nenhuma mudança de runtime foi demonstrada necessária para a correção da seleção; qualquer lacuna real deve ser tratada pela outra frente.

Essa é uma dependência de integração documental, explicitamente pendente, não motivo para dispensar a revisão nem autorização para alterar runner/provider-dispatch nesta frente. A correção do watcher é independente deste PR.

## Provas e limites

`skills/setup-pstack/scripts/setup-pstack.test.ts` testa escolha para raízes Claude/Codex/Grok com todos os provedores autores, ordem e esforços pessoais, aliases, descritores legados, uma única família alternativa sem alerta, nomes inválidos e a manutenção da exclusão de autores na Arena. O CLI público também é executado: coautoria de três provedores sai 0 e escolhe outra família; sheet manual só com a raiz sai 1 e não produz revisor. Exit 1 não é um veredito de dispensa.

As receitas `setup-contracts` e `repository-contracts` da skill de verificação conservam recibos e streams vinculados ao commit. Testes de seleção não executam um modelo externo nem provam que uma skill será obedecida em toda conversa. A impossibilidade de concluir uma revisão real deve continuar explícita, sem converter a limitação em sucesso. Nenhum playbook pstack foi executado como workflow desta alteração.

Cloud, VMs e execução remota ficam fora do produto desejado. Worktrees locais, modelos pessoais, fallback de swarm e Attack the Premise são escolhas preservadas. O fallback de swarm continua fora dos pools. Converge e Guarded operations não retornam.

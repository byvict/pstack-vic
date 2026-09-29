---
status: accepted
---

# Classe leve por caminho, com a regra cruzada mantida

Um PR pequeno de configuração, documentação, teste ou versão, como o #48 (10 arquivos, +39/-8), levava no Pré-PR o mesmo caminho de um PR que muda o runner: todas as Corridas, o Revisor com um prompt que o faz varrer o repositório por cinco minutos e, no Clinext, o Certificador sem funcionalidade para dirigir. Em 2026-09-29 Victor escolheu a opção B da investigação: o contrato do repositório lista em `prePr.light` os caminhos que podem seguir uma trilha leve, e uma mudança que só toca esses caminhos, ou que só sobe dependência, roda as Corridas e um Revisor de outra Família com prompt estreito, sem Certificador, e sai com Certificado `Light`. A regra do [ADR 0001](0001-verificacao-pesada-antes-do-pr.md) fica: nada mergeia sem revisão de outra Família, e a opção sem revisor (`reviewer: "none"`) existe como uma palavra no contrato, não como padrão. Código que o Converge executa (runner, scripts do Converge, playbooks, as referências do contrato e dos prompts) fica sempre na trilha cheia, porque está em `riskClasses.contained`, e um caminho de risco nunca é leve; o gate recusa um Certificado leve quando a política do trunk passa a pedir uma lane que ele não tem.

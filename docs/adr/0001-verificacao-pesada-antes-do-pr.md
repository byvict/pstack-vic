---
status: accepted
---

# Verificação pesada antes do PR; a nuvem só reage

Até 2026-09-24 o Cursor Cloud verificava, reparava e mergeava todo PR que a Raiz abria, e em uma semana consumiu um quinto do pool mensal, a maior parte relendo contexto enquanto esperava CI. Decidimos que o Pré-PR roda na máquina local, em lanes Grok Build (assinatura SuperGrok Heavy, custo marginal zero), e que o PR só nasce certificado. Converge, na nuvem e só com modelos Cursor, passa a ser reativo: verifica PR sem Certificado, repara CI vermelho e arma o merge do que está certificado, por três gatilhos de Automation. O Cursor não foi removido porque cobre o que a máquina local não alcança depois que a Raiz encerra.

## Consequências

- O Autor e o Revisor pré-PR nunca são da mesma Família; o playbook recusa começar quando o sheet os iguala. A revisão cruzada é o que substitui o verifier independente da nuvem.
- Uma suíte que passa de 300 s não pode rodar dentro de uma lane Grok; a Raiz roda suítes por script e entrega as Corridas às lanes.
- A Raiz encerra depois de armar; o Varredor na nuvem arma o que ela não conseguiu (trunk vermelho na hora, filho de stack que virou base `main`).

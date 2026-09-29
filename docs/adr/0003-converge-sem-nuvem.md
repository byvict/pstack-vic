---
status: accepted
---

# Converge sem nuvem: o daemon no Mac faz o que a Raiz não vê

Até 2026-09-28 o desenho deixava três Automations do Cursor para depois que a Raiz encerra: verificar PR sem Certificado, reparar CI vermelho e armar o que está certificado. Nenhuma das três existia; só a Automation "PR opened" do v1 rodava, lançando o owner completo em todo PR do Clinext e consumindo o pool de modelos. A única vantagem da nuvem era reagir com o Mac desligado, e o Mac de Victor nunca desliga. Decidimos tirar o Cursor do fluxo: dois jobs launchd na máquina local, um que varre por script e outro que lança uma Raiz sem supervisão para reparar, recertificar e certificar, com posse por branch, tetos por head e `needs-victor` ao esgotar. O código da nuvem sai numa release própria depois da prova no Clinext.

## Consequências

- Reparo e certificação de PR sem Certificado só andam com o Mac ligado; PR já armado mergeia sem ele, porque quem mergeia é o GitHub.
- Uma Raiz com permissão total roda sem Victor por perto. O que a confina: o worktree próprio sob o diretório de corrida, a posse por branch, o desarme antes de empurrar, os tetos, e a regra de que tudo o que ela lê é dado.
- O pool do Cursor fica livre para outros projetos, e o plugin deixa de depender de segredos na nuvem.
- Os papéis pré e pós-PR são escolhidos no `/setup-pstack`; a independência do Certificado vira "o Revisor não é de nenhuma família da lista de Autores", conferida no próprio Certificado (desde a 0.4.9, a lista de Autores inclui os trailers `Pstack-Author` dos commits, e a linha do Revisor traz uma reserva de outra Família).

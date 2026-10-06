# pstack-vic

Port autoral do [pstack](https://github.com/cursor/plugins/tree/main/pstack) de Lauren Tan ([@poteto](https://x.com/poteto)) para Claude Code, Codex e Grok Build.

> if you want to go fast, go deep first.

pstack dá ao agente regras de engenharia, playbooks por tipo de tarefa, skills focadas e ferramentas locais pequenas. O ponto de entrada é `/poteto-mode`: ele lê a tarefa, escolhe um playbook e chama as outras skills conforme os passos pedem. O resultado é menos código, verificado no artefato real, com trilha que dá para inspecionar.

Este port mantém a prosa da Cursor onde ela não depende da Cursor e substitui só o que depende: tools, transcripts, subagents, cloud agents e seleção de modelo. Uma única árvore de skills serve os três pais. Os modelos de cada papel são dado (`model-matrix.json`), e `/setup-pstack` escreve o sheet que sobrescreve os defaults.

## Começar

1. Instale o plugin por marketplace, a partir de uma tag (detalhes na [referência](docs/reference.md#instalação)):

   ```text
   /plugin marketplace add byvict/pstack-vic
   /plugin install pstack@pstack-vic
   ```

   ```shell
   codex plugin marketplace add byvict/pstack-vic --ref v0.5.21
   codex plugin add pstack@pstack-vic
   ```

   No Grok Build, o plugin instalado no Claude Code também é descoberto pela compatibilidade do CLI. Uma sessão Grok no T3 Code usa as rotas do pai Grok. Configure `[subagents] max_depth = 2` no `~/.grok/config.toml` e reinicie a sessão para permitir owner → helper. A [adaptação](skills/poteto-mode/references/grok-tools.md) explica ferramentas, permissões e retomada do autopilot.

2. Rode `/setup-pstack` uma vez em cada pai para escolher os modelos por papel. No fim, ele confere a [autorização permanente](docs/reference.md#autorização-permanente), que o autopilot e o playbook Shipping exigem para mergear sem aprovação humana. No Claude Code, ele entrega o comando que você roda uma vez para concedê-la.
3. Use `/poteto-mode` sempre que a tarefa pedir rigor. O modo só entra por esse comando; o agente não o liga sozinho.

```text
/poteto-mode this pr has a subtle bug where the scroll drifts every 750ms even when idle. repro first, then fix and verify.
```

## Documentos

- [`docs/reference.md`](docs/reference.md) — instalação, layout, dependências, o [autopilot](docs/reference.md#autopilot), todas as skills, subagents, o que ficou de fora.
- [`CONTEXT.md`](CONTEXT.md) — o glossário do autopilot, com Raiz, Dono, Enxame, Veredito, Rodada, Tick e os outros termos de um programa.
- [`docs/adr/`](docs/adr/) — as decisões registradas. O [ADR 0005](docs/adr/0005-autopilot-substitui-converge.md) aposenta o converge, supera os ADRs 0001 a 0004 e registra o que entrou no lugar.
- [`UPSTREAM.md`](UPSTREAM.md) — os dois upstreams (Cursor, fonte de merge; open-pstack, só leitura) e o ponto de sync de cada um.
- [`NOTICE.md`](NOTICE.md) — proveniência de cada arquivo copiado e o que é escrita nova.
- [`CHANGES.md`](CHANGES.md) — veredito por hunk e por skill de cada fase do port.

## Licença

MIT. Ver [`LICENSE`](LICENSE), [`LICENSE-open-pstack`](LICENSE-open-pstack) e [`LICENSE-cursor-team-kit`](LICENSE-cursor-team-kit).

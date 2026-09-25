# pstack-vic

Port autoral do [pstack](https://github.com/cursor/plugins/tree/main/pstack) de Lauren Tan ([@poteto](https://x.com/poteto)) para Claude Code e Codex.

> if you want to go fast, go deep first.

pstack dá ao agente regras de engenharia, playbooks por tipo de tarefa, skills focadas e ferramentas locais pequenas. O ponto de entrada é `/poteto-mode`: ele lê a tarefa, escolhe um playbook e chama as outras skills conforme os passos pedem. O resultado é menos código, verificado no artefato real, com trilha que dá para inspecionar.

Este port mantém a prosa da Cursor onde ela não depende da Cursor e substitui só o que depende: tools, transcripts, subagents, cloud agents e seleção de modelo. Uma única árvore de skills serve os dois pais. Os modelos de cada papel são dado (`model-matrix.json`), e `/setup-pstack` escreve o sheet que sobrescreve os defaults.

## Começar

1. Instale o plugin por marketplace, a partir de uma tag (detalhes na [referência](docs/reference.md#instalação)):

   ```text
   /plugin marketplace add byvict/pstack-vic
   /plugin install pstack@pstack-vic
   ```

   ```shell
   codex plugin marketplace add byvict/pstack-vic --ref v0.2.3
   codex plugin add pstack@pstack-vic
   ```

2. Rode `/setup-pstack` uma vez em cada pai para escolher os modelos por papel.
3. Use `/poteto-mode` sempre que a tarefa pedir rigor. O modo só entra por esse comando; o agente não o liga sozinho.

```text
/poteto-mode this pr has a subtle bug where the scroll drifts every 750ms even when idle. repro first, then fix and verify.
```

## Documentos

- [`docs/reference.md`](docs/reference.md) — instalação, layout, dependências, todas as skills, subagents, o que ficou de fora.
- [`UPSTREAM.md`](UPSTREAM.md) — os dois upstreams (Cursor, fonte de merge; open-pstack, só leitura) e o ponto de sync de cada um.
- [`NOTICE.md`](NOTICE.md) — proveniência de cada arquivo copiado e o que é escrita nova.
- [`CHANGES.md`](CHANGES.md) — veredito por hunk e por skill de cada fase do port.

## Licença

MIT. Ver [`LICENSE`](LICENSE), [`LICENSE-open-pstack`](LICENSE-open-pstack) e [`LICENSE-cursor-team-kit`](LICENSE-cursor-team-kit).

# Upstreams

pstack-vic é um port autoral do [pstack da Cursor](https://github.com/cursor/plugins/tree/main/pstack) para Claude Code e Codex. Dois upstreams são acompanhados, com papéis diferentes:

| Remote | Repositório | Papel |
| --- | --- | --- |
| `cursor` | `https://github.com/cursor/plugins.git` (path `pstack/`) | Fonte de merge. O histórico deste repo é o `git subtree split --prefix=pstack` desse path. |
| `open` | `https://github.com/ericlitman/open-pstack.git` | Referência de leitura. Nunca é mergeado; o que for copiado dele entra por cópia auditada, com proveniência em `NOTICE.md`. |

Os dois remotes têm push desabilitado (`no_push`). Este repo só recebe.

## Ponto de sync atual

| | `cursor` | `open` |
| --- | --- | --- |
| Commit | `5bf2b1544db739998121a306340631963c2ff3de` | `de67e6b40511814171e5e4c8ad7af3b79f07c9ee` |
| Versão upstream | pstack `0.15.2` | open-pstack `1.4.1` (= Cursor pstack `0.15.1`, `f8abedd`) |
| Data do sync | 2026-09-17 | 2026-09-17 |
| Commit equivalente aqui | `91e5b82513c42d3713fe4741aa0dae29c8fa240b` (tip do split) | n/a (nada copiado ainda) |

O commit `5bf2b15` é o último de `cursor/main` que tocou `pstack/` na data do sync. A árvore do tip do split é idêntica a `5bf2b15:pstack` (verificado com `git rev-parse <tip>^{tree}` vs `git rev-parse 5bf2b15^{tree}:pstack`).

## Checar mudanças

Num clone novo, registrar os remotes uma vez:

```shell
git remote add cursor https://github.com/cursor/plugins.git
git remote add open https://github.com/ericlitman/open-pstack.git
git remote set-url --push cursor no_push
git remote set-url --push open no_push
```

Cursor (só commits que tocaram `pstack/` depois do ponto de sync):

```shell
git fetch cursor main
git log --oneline 5bf2b1544db739998121a306340631963c2ff3de..cursor/main -- pstack
git diff --stat 5bf2b1544db739998121a306340631963c2ff3de..cursor/main -- pstack
```

open-pstack (todos os commits depois do ponto de sync):

```shell
git fetch open main
git log --oneline de67e6b40511814171e5e4c8ad7af3b79f07c9ee..open/main
git diff --stat de67e6b40511814171e5e4c8ad7af3b79f07c9ee..open/main
```

Saída vazia = nada novo. Nos dois casos.

## Incorporar uma mudança

1. O digest semanal (fase 8) lista uma linha por commit do intervalo, com veredito vazio: `aplica` / `não aplica` / `adaptar`. A decisão é do Victor, por commit.
2. Aplicar é uma sessão normal com PR. Commits do `cursor` entram por merge do split (`git subtree` ou cherry-pick sobre a linha do split); commits do `open` entram por cópia auditada, arquivo a arquivo, nunca por merge.
3. O ponto de sync deste arquivo só avança quando todos os commits do intervalo têm veredito. Ao avançar, atualizar a linha de proveniência correspondente em `NOTICE.md`.
4. Versão da Cursor, versão do open e versão do pstack-vic são independentes. As duas primeiras identificam conteúdo importado; a terceira identifica a distribuição para Claude Code e Codex.

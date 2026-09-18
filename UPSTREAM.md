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
| Commit equivalente aqui | `91e5b82513c42d3713fe4741aa0dae29c8fa240b` (tip do split) | n/a (entra por cópia auditada; o que já foi copiado está em `NOTICE.md`) |

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

## Digest semanal

`scripts/upstream-digest.ts` automatiza a seção anterior: lê os dois pontos de sync da tabela acima (fonte única), faz `git fetch` dos dois remotes e imprime um digest em markdown com uma linha por commit novo em cada upstream e a coluna de veredito vazia.

```shell
npm run upstream:digest                      # fetch + digest em markdown
npm run upstream:digest -- --no-fetch        # só com o que o clone já tem
npm run upstream:digest -- --json            # mesma coisa em JSON
npm run upstream:digest -- --since cursor=<sha>   # reabre o intervalo a partir de <sha> (também open=<sha>)
```

- `cursor`: só commits que tocaram `pstack/`; caminhos aparecem como `pstack/X` → `X`.
- `open`: todos os commits; `plugins/pstack/X` → `X`, e o que fica fora de `plugins/pstack/` é marcado como "fora do plugin" (CI, scripts de sync, docs do open).
- Caminhos que a fase 5 tirou do port (`automations/benny/`, `docs/guide/`, `skills/make-bot-ui/`, `README.md`, `.cursor-plugin/`) aparecem como "excluído na fase 5"; um commit que só toca esses já vem com veredito `não aplica`. Arquivo novo no upstream que não existe aqui aparece como "ausente aqui".
- Intervalo vazio imprime "Sem novidades" e sai com 0; só falha de fetch, de parse da tabela ou de sync point inválido sai com 2.

Uma tarefa agendada do app Claude Code (segunda-feira, 09:00 local; roda com o app aberto e, fechado, dispara na próxima abertura) executa o digest e posta o resultado no projeto pstack-vic do Linear: uma issue por semana com novidades (o veredito por commit é preenchido nela), um comentário de uma linha no projeto quando não há nada. Aplicar é uma sessão normal com PR, a partir da issue.

## Incorporar uma mudança

1. O digest semanal lista uma linha por commit do intervalo, com veredito vazio: `aplica` / `não aplica` / `adaptar`. A decisão é do Victor, por commit, registrada na issue do digest.
2. Aplicar é uma sessão normal com PR. Commits do `cursor` entram por merge do split (`git subtree` ou cherry-pick sobre a linha do split); commits do `open` entram por cópia auditada, arquivo a arquivo, nunca por merge.
3. O ponto de sync deste arquivo só avança quando todos os commits do intervalo têm veredito. Ao avançar, atualizar a linha de proveniência correspondente em `NOTICE.md`.
4. Versão da Cursor, versão do open e versão do pstack-vic são independentes. As duas primeiras identificam conteúdo importado; a terceira identifica a distribuição para Claude Code e Codex.

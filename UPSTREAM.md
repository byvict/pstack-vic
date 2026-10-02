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
| Commit | `12d587dfb20741cafc376c42c696c5f6e2a64487` | `de67e6b40511814171e5e4c8ad7af3b79f07c9ee` |
| Versão upstream | pstack `0.15.5` | open-pstack `1.4.1` (= Cursor pstack `0.15.1`, `f8abedd`) |
| Data do sync | 2026-09-23, a data do commit. O ponto avançou para ele em 2026-10-01, na 0.5.1. | 2026-09-17 |
| Commit equivalente aqui | n/a (os seis arquivos do autopilot entram por reconstrução a partir do pin mais `skills/poteto-mode/references/upstream-substitutions.json`) | n/a (entra por cópia auditada; o que já foi copiado está em `NOTICE.md`) |

O commit `12d587d` (PR 422 de `cursor/plugins`) é o último de `cursor/main` que tocou `pstack/`. Em 2026-09-30 o tip `2eb7ed4` não tinha nada mais novo nesse path, e `git log 12d587d..cursor/main -- pstack` saía vazio.

O histórico git deste repo continua sendo o split feito em `5bf2b15` (pstack `0.15.2`, sync de 2026-09-17). O tip do split é `91e5b82513c42d3713fe4741aa0dae29c8fa240b`, e a árvore dele é idêntica a `5bf2b15:pstack` (verificado com `git rev-parse <tip>^{tree}` vs `git rev-parse 5bf2b15^{tree}:pstack`). Os quatro commits de `5bf2b15..12d587d` que tocaram `pstack/` (`70b2dc8`, `b42effe`, `b0b9c7a`, `12d587d`) não entraram por merge do split. As partes sem autopilot foram julgadas na 0.4.18, hunk a hunk (o `b42effe` ficou todo de fora, e os hunks que só mudam modelo padrão também). As partes de autopilot entraram na 0.5.1 por reconstrução. Seis playbooks (`autopilot-full`, `autopilot-stack`, `babysit`, `opening-a-pr`, `shipping` e `multi-phase-plan`) são o texto da Cursor em `12d587d` mais as trocas classificadas de `skills/poteto-mode/references/upstream-substitutions.json`. Na 0.5.2, além de `platform` para harness, a tabela admite `safety`, com motivo e fonte na exceção aprovada do ADR 0005. O veredito de cada hunk está em `CHANGES.md` (seções 0.4.18 e 0.5.1).

A célula Commit da coluna `cursor` é também o pin de `scripts/upstream-parity.ts`. O `check` dele, que roda no `npm test`, refaz os seis playbooks a partir desse commit e compara com o repositório.

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
git log --oneline 12d587dfb20741cafc376c42c696c5f6e2a64487..cursor/main -- pstack
git diff --stat 12d587dfb20741cafc376c42c696c5f6e2a64487..cursor/main -- pstack
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
2. Aplicar é uma sessão normal com PR. Commits do `cursor` entram por merge do split (`git subtree` ou cherry-pick sobre a linha do split); commits do `open` entram por cópia auditada, arquivo a arquivo, nunca por merge. Os seis playbooks do autopilot são a exceção. Ninguém aplica hunk neles à mão. Eles mudam quando o ponto de sync avança ou uma substituição aprovada muda, e `node scripts/upstream-parity.ts --write` os gera de novo. Uma linha `safety` exige motivo e fonte; a exceção da 0.5.2 não autoriza reescrita editorial livre.
3. O ponto de sync deste arquivo só avança quando todos os commits do intervalo têm veredito. Ao avançar, atualizar a linha de proveniência correspondente em `NOTICE.md`. Ao avançar o do `cursor`, rodar `node scripts/upstream-parity.ts --write` no mesmo PR. Se uma troca da tabela não encontrar mais o texto dela na Cursor, o comando para e diz qual. Nesse caso, consertar a troca em `upstream-substitutions.json` e rodar o comando de novo.
4. Versão da Cursor, versão do open e versão do pstack-vic são independentes. As duas primeiras identificam conteúdo importado; a terceira identifica a distribuição para Claude Code e Codex.

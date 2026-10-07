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
| Commit | `4e5b1cf2ccb0ea3716f08c8ee0a5856b5ab93536` | `de67e6b40511814171e5e4c8ad7af3b79f07c9ee` |
| Versão upstream | pstack `0.15.10` | open-pstack `1.4.1` (= Cursor pstack `0.15.1`, `f8abedd`) |
| Data do sync | 2026-10-04, a data do commit. O ponto avançou para ele em 2026-10-05, na 0.5.8. | 2026-09-17 |
| Commit equivalente aqui | n/a (os seis arquivos do autopilot entram por reconstrução a partir do pin mais `skills/poteto-mode/references/upstream-substitutions.json`) | n/a (entra por cópia auditada; o que já foi copiado está em `NOTICE.md`) |

Na conferência de 2026-10-05, antes das publicações daquele dia, `4e5b1cf` (PR 502 de `cursor/plugins`, pstack 0.15.10) era o último commit de `cursor/main` que tocava `pstack/`. O guia abaixo incorpora uma publicação posterior, sem avançar o pin geral.

O histórico git deste repo continua sendo o split feito em `5bf2b15` (pstack `0.15.2`, sync de 2026-09-17). O tip do split é `91e5b82513c42d3713fe4741aa0dae29c8fa240b`, e a árvore dele é idêntica a `5bf2b15:pstack` (verificado com `git rev-parse <tip>^{tree}` vs `git rev-parse 5bf2b15^{tree}:pstack`). Os quatro commits de `5bf2b15..12d587d` que tocaram `pstack/` (`70b2dc8`, `b42effe`, `b0b9c7a`, `12d587d`) não entraram por merge do split. As partes sem autopilot foram julgadas na 0.4.18, hunk a hunk (o `b42effe` ficou todo de fora, e os hunks que só mudam modelo padrão também). As partes de autopilot entraram na 0.5.1 por reconstrução. Os cinco commits de `12d587d..4e5b1cf` (pstack 0.15.6 a 0.15.10) foram julgados no digest de 2026-10-05. Quatro deles (`23e4138`, `9511e60`, `a586282`, `e43c7ee`) entraram na 0.5.8 por `git am -p2 --3way` sobre a linha do split, restritos aos arquivos do port, na branch do PR #79 (`78c3ef0a`, `5127dace`, `f948d1f5`, `f64437cd`, com a autoria da Cursor); quatro conflitos foram resolvidos à mão (`agents/poteto-agent.md`, `skills/poteto-mode/SKILL.md`, `playbooks/perf-issue.md`, `scripts/check-plan.mjs`). O PR #79 foi mergeado por squash: no `main` os quatro estão fundidos no commit `9c448293`, de autoria do Vic, e a autoria da Cursor sobrevive ali só como trailer `Co-authored-by`. Ela fica registrada na lista de commits do PR #79 e nos commits de origem em `cursor/plugins`. O quinto, `4e5b1cf` (`/poteto-help`), tem veredito adaptar e entrou na 0.5.9, também por `git am` restrito a `skills/poteto-help/SKILL.md`, seguido de um commit de adaptação; o PR #80 foi mergeado por merge commit (`0a0d425c`), e por isso ele está no log do `main` como `bb458805`, com a autoria da Cursor. Seis playbooks (`autopilot-full`, `autopilot-stack`, `babysit`, `opening-a-pr`, `shipping` e `multi-phase-plan`) são o texto da Cursor em `4e5b1cf` mais as trocas classificadas de `skills/poteto-mode/references/upstream-substitutions.json`. A exceção `safety` da 0.5.2 foi revogada na 0.5.21. A tabela volta a aceitar somente `platform` e também regenera o fluxo Why, conforme o ADR 0005. O veredito de cada hunk está em `CHANGES.md` (seções 0.4.18 e 0.5.1).

A célula Commit da coluna `cursor` é também o pin de `scripts/upstream-parity.ts`. O `check` dele, que roda no `npm test`, refaz os seis playbooks e os cinco arquivos de Why a partir desse commit e compara com o repositório.

## Guia de uso

O [guia do port](docs/guide/README.md) adapta os dez capítulos de `pstack/docs/guide/` da Cursor em português. Origem do guia: `df581122cde17e6e27686b5a448bde23e4ad4318`, PR [511](https://github.com/cursor/plugins/pull/511), pstack 0.15.15, publicado em 2026-10-05. A adaptação foi feita em 2026-10-07. As seis imagens são cópias byte a byte dessa árvore; a atribuição está em `NOTICE.md`.

O guia preserva a sequência de aprendizagem, os exemplos e os ensinamentos. Instalação, configuração de modelos, ativação do modo, isolamento, drivers, cadência e criação de skills seguem os mecanismos do port. Recursos exclusivos da Cursor são identificados como ausentes, com os conceitos aplicáveis preservados. O README apresenta o projeto; o guia ensina o uso; `docs/reference.md` concentra configuração e contratos.

Essa origem é específica do guia. A tabela de sync e o pin dos playbooks continuam em `4e5b1cf`; importar o guia não julga nem aplica os demais arquivos dos commits posteriores. Nos PRs 508 e 511, os trechos do guia têm veredito `adaptar`, já aplicado. O PR 508 fornece os novos ensinamentos de planejamento; no PR 511, configuração e painéis continuam seguindo a matriz local. As alterações de modelos nas skills da Cursor não entram por esta adaptação; os bumps do manifest upstream não se aplicam à versão independente do port.

O digest inclui mudanças no guia dos dois upstreams sem preencher o veredito. Revise o conteúdo antes de decidir, mesmo quando a mudança parecer específica da Cursor. Preserve ensinamentos gerais e adapte somente os recursos de ambiente. Para atualizar o guia, compare com a origem registrada aqui, confira as afirmações contra as skills locais e atualize este registro, `NOTICE.md` e `CHANGES.md` juntos:

```shell
git diff df581122cde17e6e27686b5a448bde23e4ad4318..cursor/main -- pstack/docs/guide
```

Enquanto o pin geral estiver atrás, o digest pode listar novamente commits cujo guia já foi adaptado. Use este registro para reconhecer essa parte como aplicada e julgue separadamente os outros arquivos. Não avance o pin geral apenas para retirar essas linhas do digest.

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
git log --oneline 4e5b1cf2ccb0ea3716f08c8ee0a5856b5ab93536..cursor/main -- pstack
git diff --stat 4e5b1cf2ccb0ea3716f08c8ee0a5856b5ab93536..cursor/main -- pstack
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
- Caminhos que continuam fora desde a fase 5 (`automations/benny/`, `skills/make-bot-ui/`, `README.md`, `.cursor-plugin/`) aparecem como "excluído na fase 5"; um commit que só toca esses já vem com veredito `não aplica`. O guia voltou ao port e suas mudanças aguardam julgamento. Arquivo novo no upstream que não existe aqui aparece como "ausente aqui".
- Intervalo vazio imprime "Sem novidades" e sai com 0; só falha de fetch, de parse da tabela ou de sync point inválido sai com 2.

Uma tarefa agendada do app Claude Code (segunda-feira, 09:00 local; roda com o app aberto e, fechado, dispara na próxima abertura) executa o digest e posta o resultado no projeto pstack-vic do Linear: uma issue por semana com novidades (o veredito por commit é preenchido nela), um comentário de uma linha no projeto quando não há nada. Aplicar é uma sessão normal com PR, a partir da issue.

## Incorporar uma mudança

1. O digest semanal lista uma linha por commit do intervalo, com veredito vazio: `aplica` / `não aplica` / `adaptar`. A decisão é do Victor, por commit, registrada na issue do digest.
2. Aplicar é uma sessão normal com PR. Commits do `cursor` entram por merge do split (`git subtree` ou cherry-pick sobre a linha do split); commits do `open` entram por cópia auditada, arquivo a arquivo, nunca por merge. Os arquivos listados em `upstream-substitutions.json`, os seis playbooks do autopilot e cinco arquivos de Why, são a exceção. Ninguém aplica hunk neles à mão. Eles mudam quando o ponto de sync avança ou uma substituição aprovada muda, e `node scripts/upstream-parity.ts --write` os gera de novo. A tabela aceita apenas adaptações `platform` com motivo. A exceção `safety` da 0.5.2 foi revogada na 0.5.21. Um PR que traz commits da Cursor por `git am` é mergeado por merge commit ou por rebase, nunca por squash: o squash funde os commits num só, de autoria de quem mergeou, e a autoria da Cursor vira só um trailer `Co-authored-by` (foi o que aconteceu no PR #79, 0.5.8; o PR #80, 0.5.9, entrou por merge commit e a autoria sobreviveu). O GitHub não impõe isso: em 2026-10-05 o repo aceita os três métodos (`allow_merge_commit`, `allow_rebase_merge` e `allow_squash_merge` ligados, com `delete_branch_on_merge` ligado) e o único ruleset da `main` (`main: require CI test`) só exige o check `test`. Quem mergeia escolhe o método, com `gh pr merge --merge` ou `--rebase`.
3. O ponto de sync deste arquivo só avança quando todos os commits do intervalo têm veredito. Ao avançar, atualizar a linha de proveniência correspondente em `NOTICE.md`. Ao avançar o do `cursor`, rodar `node scripts/upstream-parity.ts --write` no mesmo PR. Se uma troca da tabela não encontrar mais o texto dela na Cursor, o comando para e diz qual. Nesse caso, consertar a troca em `upstream-substitutions.json` e rodar o comando de novo.
4. Versão da Cursor, versão do open e versão do pstack-vic são independentes. As duas primeiras identificam conteúdo importado; a terceira identifica a distribuição para Claude Code e Codex.

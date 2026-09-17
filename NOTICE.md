# NOTICE

pstack-vic é um port autoral de trabalho sob licença MIT. Todos os avisos de copyright e termos de licença dos upstreams são preservados. O histórico git deste repo começa no `git subtree split` de `pstack/` em `cursor/plugins` (86 commits até `5bf2b15`, pstack 0.15.2), então cada arquivo herdado da Cursor carrega a autoria original no próprio log.

## Fontes upstream

| Componente | Upstream | Copyright | Licença | Arquivo de licença |
| --- | --- | --- | --- | --- |
| Tudo que veio no split: `skills/`, `agents/`, `docs/`, `automations/`, `assets/`, `README.md`, `.cursor-plugin/` | [cursor/plugins/pstack @ 5bf2b15](https://github.com/cursor/plugins/tree/5bf2b1544db739998121a306340631963c2ff3de/pstack) (0.15.2) | (c) 2026 Lauren Tan | MIT | [LICENSE](LICENSE) |
| `skills/poteto-mode/references/provider-dispatch.md` (prosa; a tabela da matriz e a de rota são geradas de `model-matrix.json`), copiado e adaptado na fase 1 (2026-09-17) | [ericlitman/open-pstack @ de67e6b](https://github.com/ericlitman/open-pstack/tree/de67e6b40511814171e5e4c8ad7af3b79f07c9ee) (1.4.1) | (c) 2026 Lauren Tan (port: Eric Litman) | MIT | [LICENSE-open-pstack](LICENSE-open-pstack) |
| Runner externo `skills/poteto-mode/scripts/runner/` (`cli.ts`, `commands.ts`, `parse-output.ts`, `run.ts`, `types.ts`, `pstack-runner`, `tsconfig.json` e os `*.test.ts`), copiado e adaptado na fase 2 (2026-09-17): Node 24 no lugar de Bun (`node:child_process` por `Bun.spawn`, busca no PATH por `Bun.which`, `node:test` por `bun:test`), `PROVIDERS`/`EFFORTS`/`model-aliases.ts` substituídos pela leitura de `model-matrix.json`; `model-matrix.test.ts` do open não copiado (coberto pela fase 1) | [ericlitman/open-pstack @ de67e6b](https://github.com/ericlitman/open-pstack/tree/de67e6b40511814171e5e4c8ad7af3b79f07c9ee) (1.4.1) | (c) 2026 Lauren Tan (port: Eric Litman) | MIT | [LICENSE-open-pstack](LICENSE-open-pstack) |

Linhas a acrescentar quando algo for copiado (fases 4, 5, 7 do plano). Nada abaixo está copiado ainda, exceto o que já subiu para a tabela acima:

| Componente previsto | Upstream | Copyright | Licença | Arquivo de licença |
| --- | --- | --- | --- | --- |
| `codex-tools.md`, hook SessionStart, manifests Claude/Codex, scripts de sync, `setup-pstack`, substituições Cursor→Claude/Codex | [ericlitman/open-pstack @ de67e6b](https://github.com/ericlitman/open-pstack/tree/de67e6b40511814171e5e4c8ad7af3b79f07c9ee) (1.4.1) | (c) 2026 Lauren Tan (port: Eric Litman) | MIT | [LICENSE-open-pstack](LICENSE-open-pstack) (já copiado na fase 1) |
| `hooks/run-hook.cmd` (via open-pstack, que o traz quase verbatim) | [anthropics/claude-plugins-official → superpowers](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/superpowers) (originalmente obra/superpowers) | (c) 2025 Jesse Vincent | MIT | `LICENSE-superpowers` (copiar junto com o hook) |
| Skills extras do `cursor-team-kit` que forem aprovadas na fase 5 (`deslop`, `fix-ci`, `fix-merge-conflicts`, `get-pr-comments`, `make-pr-easy-to-review`, `thermo-nuclear-code-quality-review`, `what-did-i-get-done`) | [cursor/plugins/cursor-team-kit](https://github.com/cursor/plugins/tree/main/cursor-team-kit) | (c) 2026 Cursor | MIT | `LICENSE-cursor-team-kit` (copiar junto com a primeira skill) |

## O que muda no port

O port é editorial, não mecânico. Regra: copiar onde seria igual ao open-pstack, escrever só onde o desenho muda. Cada cópia é auditada arquivo a arquivo; o veredito por hunk fica em `CHANGES.md` (fase 4).

Escrita nova, sem origem upstream (a preencher conforme as fases fecham):

- `UPSTREAM.md`, `NOTICE.md` (este arquivo)
- Matriz de modelos como dado: `model-matrix.json`, `scripts/model-matrix.ts` (loader, validação, descritores, render), `scripts/render-model-matrix.ts`, `scripts/model-matrix.test.ts` (fase 1, 2026-09-17); consumidores que leem dela nas fases 2, 3 e 6
- Consumo da matriz pelo runner (fase 2, 2026-09-17): `familyOf`/`cliFor` em `types.ts`, `pinnedFamily` e a validação por família e effort em `run.ts`, `findExecutable` (substituto de `Bun.which`), `match-object.test-helper.ts`
- Gerador de agents nativos (fase 3)
- Tracking semanal dos dois upstreams (`upstream-digest`, fase 8)

## Modificações

Conforme a licença MIT, modificações são permitidas. Avisos de copyright presentes nos arquivos de origem são preservados.

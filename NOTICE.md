# NOTICE

pstack-vic é um port autoral de trabalho sob licença MIT. Todos os avisos de copyright e termos de licença dos upstreams são preservados. O histórico git deste repo começa no `git subtree split` de `pstack/` em `cursor/plugins` (86 commits até `5bf2b15`, pstack 0.15.2), então cada arquivo herdado da Cursor carrega a autoria original no próprio log.

## Fontes upstream

| Componente | Upstream | Copyright | Licença | Arquivo de licença |
| --- | --- | --- | --- | --- |
| Tudo que veio no split: `skills/`, `agents/`, `docs/`, `automations/`, `assets/`, `README.md`, `.cursor-plugin/` | [cursor/plugins/pstack @ 5bf2b15](https://github.com/cursor/plugins/tree/5bf2b1544db739998121a306340631963c2ff3de/pstack) (0.15.2) | (c) 2026 Lauren Tan | MIT | [LICENSE](LICENSE) |

Linhas a acrescentar quando algo for copiado (fases 2, 4, 5, 7 do plano). Nada abaixo está copiado ainda:

| Componente previsto | Upstream | Copyright | Licença | Arquivo de licença |
| --- | --- | --- | --- | --- |
| Runner externo (`skills/poteto-mode/scripts/runner/`), `provider-dispatch.md`, `codex-tools.md`, hook SessionStart, manifests Claude/Codex, scripts de sync, `setup-pstack`, substituições Cursor→Claude/Codex | [ericlitman/open-pstack @ de67e6b](https://github.com/ericlitman/open-pstack/tree/de67e6b40511814171e5e4c8ad7af3b79f07c9ee) (1.4.1) | (c) 2026 Lauren Tan (port: Eric Litman) | MIT | `LICENSE-open-pstack` (copiar junto com o primeiro arquivo) |
| `hooks/run-hook.cmd` (via open-pstack, que o traz quase verbatim) | [anthropics/claude-plugins-official → superpowers](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/superpowers) (originalmente obra/superpowers) | (c) 2025 Jesse Vincent | MIT | `LICENSE-superpowers` (copiar junto com o hook) |
| Skills extras do `cursor-team-kit` que forem aprovadas na fase 5 (`deslop`, `fix-ci`, `fix-merge-conflicts`, `get-pr-comments`, `make-pr-easy-to-review`, `thermo-nuclear-code-quality-review`, `what-did-i-get-done`) | [cursor/plugins/cursor-team-kit](https://github.com/cursor/plugins/tree/main/cursor-team-kit) | (c) 2026 Cursor | MIT | `LICENSE-cursor-team-kit` (copiar junto com a primeira skill) |

## O que muda no port

O port é editorial, não mecânico. Regra: copiar onde seria igual ao open-pstack, escrever só onde o desenho muda. Cada cópia é auditada arquivo a arquivo; o veredito por hunk fica em `CHANGES.md` (fase 4).

Escrita nova, sem origem upstream (a preencher conforme as fases fecham):

- `UPSTREAM.md`, `NOTICE.md` (este arquivo)
- Matriz de modelos como dado (`model-matrix.json` ou equivalente) e os consumidores que leem dela (fases 1, 3, 6)
- Gerador de agents nativos (fase 3)
- Tracking semanal dos dois upstreams (`upstream-digest`, fase 8)

## Modificações

Conforme a licença MIT, modificações são permitidas. Avisos de copyright presentes nos arquivos de origem são preservados.

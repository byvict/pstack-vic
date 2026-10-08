# Lacunas de harness da Raiz Claude

Frente de 2026-10-08, aberta a partir da `main` em `2c59e013` (0.5.26), sem poteto-mode como workflow. Ela fecha as lacunas que a auditoria das frentes A, B e D deixou para adaptação de harness: o caminho do transcript de um Dono (T6 e D-sp1), o Tick depois de `--resume` (A6), a pasta da Raiz e o fato 6 (T5), o escopo do plugin com programa rodando (T2) e os touchpoints Claude da Raiz (T4). Nenhum modelo, esforço, fallback de swarm, política de Arena ou de trilha mudou.

Evidência privada em `~/Dev/Skills/pstack-vic-runs/2026-10-08-claude-root-harness/`: `identity.txt`, `capture.sh`, `events.log`, `inventory.tsv`, `01-owner-transcript/` e `02-tick-resume/`.

## Identidade

| Item | Valor |
| --- | --- |
| Raiz | sessão `c4ecb3fc-f3d5-4396-a368-1185125ed8b7` no app desktop, Claude Code 2.1.293 do app, `CLAUDE_CODE_ENTRYPOINT=claude-desktop`; o `claude` no PATH é 2.1.295 |
| Pasta principal da Raiz | o worktree `.claude/worktrees/poteto-t3-code-plugin-d01625` do pstack-vic |
| Plugin | `pstack@pstack-vic` 0.5.26 em todos os registros |
| Raiz de terminal | sessão `ebd1bc80-c3f3-4be2-b31a-9d552a7aa513`, o binário 2.1.293 do app pelo caminho absoluto, aberta por `run_in_terminal`, `--permission-mode auto`, `CLAUDE_CODE_ENTRYPOINT=cli` |

## Onde fica o transcript de um Dono

A Raiz criou um Dono `pstack:pstack-owner-opus-xhigh` com `isolation: "worktree"` e `run_in_background: true`, só de leitura, com um nonce no brief. Ele seguiu ao pé da letra a seção "Audit the log against the transcript" do show-me-your-work instalado e depois procurou o arquivo com o que conseguia ver. Terminou em 126 s.

| Fato | Medido |
| --- | --- |
| Pasta do Dono | `pstack-vic/.claude/worktrees/agent-a26f672a44791e9d1`, branch `worktree-agent-a26f672a44791e9d1`; o worktree saiu no checkout principal do repositório, embora a Raiz rode num worktree ligado |
| Caminho que o texto atual dá | `~/.claude/projects/<cwd do Dono codificado>/` = `-Users-victorbaccega-Dev-Skills-pstack-vic--claude-worktrees-agent-a26f672a44791e9d1`, que não existe (`ls` saiu com 1) |
| Onde o arquivo está | `~/.claude/projects/<cwd da Raiz codificado>/<sessão da Raiz>/subagents/agent-a26f672a44791e9d1.jsonl`, com um `agent-<id>.meta.json` ao lado (tipo do agente, `worktreePath`, `worktreeBranch`, descrição, profundidade) |
| O que a Raiz recebe | o resultado do `Agent` traz como `output_file` um link em `/private/tmp/claude-501/<cwd da Raiz>/<sessão>/tasks/<id>.output` que aponta para esse arquivo |
| O que o Dono vê no ambiente | `CLAUDE_CODE_SESSION_ID` com o id da sessão da Raiz; nenhum `CLAUDE_CODE_AGENT_ID` nem `CLAUDE_PROJECT_DIR` |
| O próprio id | não aparece escrito em lugar nenhum do contexto; só dentro do nome da pasta e da branch |
| A pasta da Raiz | só por acaso, dentro do caminho do scratchpad e de um `AGENTS.md` citado no prompt de sistema |
| Leitura do conteúdo | com o caminho certo, o Dono leu o arquivo: 108 linhas naquela hora, nonce 5 vezes, primeiro registro `type: user`, `isSidechain: true`, `agentId` dele, `sessionId` da Raiz, `cwd` do worktree, conteúdo igual ao brief |
| Limite de leitura | `Read` das três primeiras linhas falhou (75 504 tokens, acima de 25 000), porque os registros 2 e 3 são anexos grandes; `head` com `cut` e um parse em `node` funcionaram |
| Worktree no fim | o Dono deixou o worktree limpo na branch de origem; worktree e branch sumiram, e a notificação de conclusão veio sem `worktreePath` (segunda observação do D5) |

Conclusão: o texto atual não leva um subagente ao próprio transcript, o que explica o D-sp1. O mapeamento mínimo é o caminho acima. Como o Dono não sabe a pasta da Raiz, a Raiz põe a pasta `subagents/` no brief. O brief pediu só nomes de variáveis, e nenhum valor de credencial entrou no transcript.

## O Tick depois de `--resume`

A raiz de terminal armou um `sleep 120; echo <nonce>` em segundo plano (tarefa `b8at8o9dm`, 23:01:38Z). O rodapé mostrou `1 shell`.

| UTC | Evento |
| --- | --- |
| 23:01:5x | Ctrl-C duas vezes no prompt abriu o diálogo `Background work is running / The following will stop when you exit`, com `1. Exit and stop tasks`, `2. Move to background and exit` e `3. Stay`; ele só fecha com Enter |
| 23:02:1x | a aba foi fechada; não sobrou processo `claude`, `zsh` nem `sleep`, e a saída da tarefa ficou com 0 bytes |
| 23:02:27 | `claude --resume ebd1bc80-…` com o mesmo binário e a mesma pasta: mesma sessão; o host pôs na fila uma notificação da tarefa com `<status>stopped</status>` e `Background shell command didn't finish before the previous session ended` |
| 23:03:38 | hora devida do `sleep`: nada rodou, nenhuma notificação de conclusão, saída ainda vazia |
| 23:04:23 | nada ainda; aba fechada |

Conclusão: o comando em segundo plano termina com a sessão e não volta com `--resume`. A sessão retomada recebe um único aviso de tarefa parada e nunca o fim dela. O diálogo de saída diz que uma saída normal também para a tarefa. A opção "Move to background and exit" não foi medida.

No app, nenhuma ferramenta desta sessão encerra o processo de uma sessão e a reabre pelo mesmo id, e os processos do app recebem a sessão por `--await-initialize`, sem `--resume` no argv. A medida direta vale para o binário no terminal. Há corroboração no app: duas sessões do app (`claude-desktop`) foram retomadas pelo mesmo id depois de mais de uma hora sem registros e receberam o mesmo aviso `stopped` de uma tarefa em segundo plano. Foram a `99c62382` na 2.1.284, em 2026-09-29 às 18:46:11Z, e a `714f19b2` na 2.1.275, em 2026-09-18 às 16:20:40Z.

## A pasta da Raiz e o fato 6

- **Onde nasce o worktree.** O worktree do Dono acima nasceu em `pstack-vic/.claude/worktrees/`, no checkout principal do repositório da pasta da Raiz, e não dentro do worktree em que a Raiz roda. O `Agent` não aceita `cwd` ([coordenadora](2026-10-08-claude-coordinator.md), linha 31).
- **Como a pasta se move.** Um `cd` dentro de comando composto, com alvo sob um diretório adicional da sessão (`~/Dev`), move a pasta principal da sessão. Isso aconteceu no laboratório da coordenadora ([linha 56](2026-10-08-claude-coordinator.md)), duas vezes na Raiz da frente D ([relatório](2026-10-08-autopilot-claude-root.md), linha 25, e o `events.log` privado às 21:19:37Z) e uma vez na auditoria.
- **A forma segura.** Nesta frente, `( cd <evidência> && pwd )` imprimiu a pasta de evidência, e o `pwd` seguinte continuou no worktree da Raiz.

## O que mudou

- `skills/show-me-your-work/SKILL.md`: na auditoria contra o transcript, o caminho do transcript de um subagente nativo, o que ele tem no ambiente e a regra de a Raiz pôr a pasta `subagents/` no brief.
- `skills/poteto-mode/SKILL.md`: no Autopilot owners, o brief do Dono no Claude Code leva essa pasta. Na Platform Adaptation, a frase do `--resume` passa a dizer o que foi medido.
- `skills/poteto-mode/references/native-lifecycle.md`: a pasta da Raiz decide o repositório do worktree, o fato 6 e a forma segura, além da segunda observação da notificação sem worktree.
- `docs/reference.md`: a frase do `--resume` com a medida; no "O que o Dono faz", o transcript do Dono; no "O que você faz", não mexer no escopo do plugin com programa rodando.
- `docs/adr/0010-tick-em-segundo-plano-na-raiz-do-app-desktop.md`: a frase do `--resume` com a medida.
- `skills/update-clis/references/cli-touchpoints.json`: cinco touchpoints `harness` do Claude: `claude.desktop-scheduler`, `claude.desktop-tick`, `claude.owner-channel`, `claude.todolist-tools` e `claude.subagent-transcript`.

## Lacunas

- O `--resume` de uma sessão do app não foi exercitado nesta versão. A medida direta é do binário no terminal, com corroboração de duas sessões antigas do app.
- A opção "Move to background and exit" do diálogo de saída não foi medida.
- Nenhum programa rodou ainda com a pasta `subagents/` no brief dos Donos. O próximo programa confere se os Donos auditam a trilha contra o transcript (D9).

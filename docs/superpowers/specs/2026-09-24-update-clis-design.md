# `update-clis`: versão das CLIs com trava de impacto (desenho, 2026-09-24)

## Objetivo

Uma skill nova do pstack-vic, `update-clis`, cuida das três CLIs que o runner chama: `claude`, `codex` e `grok`. O Cursor fica de fora, porque entra por HTTP (`transport: http` em `model-matrix.json`) e não tem CLI.

Para cada CLI, a skill:

1. procura versão nova no canal que a CLI já usa;
2. lê o que mudou entre a versão instalada e a nova e avalia o impacto no plugin;
3. **sem impacto**, atualiza; **com impacto**, não atualiza e diz o que ajustar no plugin (arquivo e trecho).

A skill nunca edita o plugin. O ajuste é uma sessão normal com PR.

Dois disparos, com o mesmo fluxo: uma rotina semanal que atualiza sozinha e o disparo manual (`/pstack:update-clis`, ou um pedido como "atualiza o grok", com filtro opcional de uma CLI).

## Decisões de Victor (2026-09-24)

| Tema | Escolha |
|---|---|
| O que conta como "sem impacto" | **A com cobertura**: a leitura das notas marca só mudança de contrato; a mudança num ponto coberto pela sonda é decidida pela sonda; a mudança num ponto não coberto segura a atualização |
| Auto-update do `claude` do npm | **Desligar** (`"env": {"DISABLE_AUTOUPDATER": "1"}` em `~/.claude/settings.json`); a skill vira o único caminho de atualização, como o G-9 faz no grok |
| Alcance da sonda | **Completa**: pares em uso nas duas fichas, no esforço em uso, em leitura e escrita, com grok e claude também dentro do sandbox do Codex |
| Estrutura | **Skill nova com script determinístico**, lista de pontos de contato verificada por teste, execução de lane compartilhada com o `setup-pstack` |
| Canal do `claude` | Segue `autoUpdatesChannel` de `~/.claude/settings.json` (hoje `latest`) |

## Fatos medidos (2026-09-24)

| | claude | codex | grok |
|---|---|---|---|
| Instalada / última | 2.1.281 / 2.1.281 (`latest`; `stable` = 2.1.273) | 0.155.1 / 0.156.1 | 1.0.5 / 1.0.41 (stable) |
| Binário que os dois pais resolvem pelo PATH | `~/.nvm/versions/node/v24.21.0/bin/claude` | `/opt/homebrew/bin/codex` → `~/.nvm/versions/node/v24.19.0/bin/codex` | `~/.grok/bin/grok` → `~/.grok/downloads/grok-macos-aarch64` |
| Onde estão as notas | `https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`, uma seção `## X.Y.Z` por versão | releases `rust-vX.Y.Z` de `openai/codex` (`gh release view`), só as que não são pre-release | `https://x.ai/cli/changelogs/<versão>.external.{md,json}` (URL tirada do binário); não há índice; as 36 versões de 1.0.6 a 1.0.41 respondem; o JSON traz `category`, `description` e `breaking_change` por entrada |
| Instalar uma versão exata / voltar | `npm i -g @anthropic-ai/claude-code@X` com o `bin` do Node 24.21.0 à frente do PATH | `npm i -g @openai/codex@X` com o `bin` do Node 24.19.0 à frente do PATH | `grok update --version X` |
| Auto-update hoje | ligado: `~/.claude/.last-update-result.json` registra `npm-global` 2.1.280 → 2.1.281 em 2026-09-24T00:23Z | não se atualiza sozinho (só avisa no TUI) | desligado (`[cli] auto_update = false`, G-9) |

Outros fatos:

- Os apps desktop trazem binários próprios, que eles mesmos atualizam. Esta sessão roda em `~/Library/Application Support/Claude/claude-code/2.1.280/`, com `DISABLE_AUTOUPDATER=1`; o Codex roda dentro do ChatGPT.app. Atualizar o npm não afeta a sessão em curso. A skill não controla esses binários e só relata a versão deles.
- Há um segundo `claude` (2.1.280) em `~/.nvm/versions/node/v24.19.0/bin/`, que nenhum dos dois pais resolve.
- `codex sandbox -c sandbox_mode="workspace-write"` roda um comando sob o seatbelt do Codex sem turno de modelo: exporta `CODEX_SANDBOX*` e bloqueia escrita em `~/.grok` quando `writable_roots` não o inclui. Com `default_permissions = ":danger-full-access"` (config de Victor) e sem o `-c`, nada é bloqueado.
- As notas medidas contra os pontos de contato do runner:
  - grok de 1.0.6 a 1.0.41: 383 entradas únicas, 41 batem por palavra-chave, quase todas de interface. Duas importam: 1.0.14 ("models can declare a different identifier for each reasoning-effort level", pode mudar a chave do `modelUsage`) e 1.0.39 ("effort levels now come from the API", pode recusar esforços que a matriz aceita). Nenhuma das duas vem com `breaking_change`.
  - claude de 2.1.274 a 2.1.281: 583 entradas, 64 batem, quase todas correções.
- `~/.grok/version.json` é o cache de `grok update --check`, não a versão instalada.

## Rotina antiga

Não existe. Foram varridos:
- tarefas agendadas do app (3, nenhuma de CLI);
- rotinas na nuvem (2, nenhuma de CLI);
- automações do Orca (0) e do Codex (4, pausadas, nenhuma de CLI);
- crontab (vazio) e `~/Library/LaunchAgents` (backup, snapshot, limpeza de worktrees e ingest do Clinext; Fin Dash);
- scripts e histórico do Clinext, o resto de `~/Dev`, `~/.zshrc` e `~/.zsh_history`.

`pstack-vic-upstream-digest` compara commits de cursor e open com `UPSTREAM.md`, não versões de CLI.

O que se lembrava vem de duas fontes:
- **A pesquisa do G-9** (`docs/pesquisas/2026-08-25-context-engineering-02-grok-supergrok-heavy.md` no Clinext, apagada em `18d8e396c`, legível com `git show 18d8e396c^:<caminho>`). Ela pedia "`auto_update = false` + update controlado (`grok update`) entre Runs, registrando a versão no relatório do Run". Só a primeira metade foi feita.
- **O próprio atualizador do Claude Code.**

Não há rotina para cancelar. A skill cumpre a metade pendente do G-9, e o `auto_update = false` do grok continua necessário.

## Componentes

| Peça | Responsabilidade |
|---|---|
| `skills/update-clis/SKILL.md` | Julgamento. Roda o script, lê as notas contra a lista de pontos de contato, classifica cada entrada, decide por CLI, manda instalar, sondar ou voltar, e posta no Linear. Nunca edita o plugin. Só roda com pai Claude Code; num pai Codex, recusa e explica. |
| `skills/update-clis/scripts/update-clis.ts` | Parte mecânica (Node 24, sem dependências, JSON na saída), com os subcomandos da tabela abaixo. Não decide nada. |
| `skills/update-clis/references/cli-touchpoints.json` | Lista versionada dos pontos de contato. |
| `skills/update-clis/scripts/update-clis.test.ts` | Testes do script com CLIs falsas e testes da lista. |
| `skills/poteto-mode/scripts/runner/probe-lane.ts` | Sai de `setup-pstack.ts` (`runLane`, `judgeExternal`, prompt de sonda). Roda uma lane pelo runner e julga recibo e saída. Ganha o modo `isolated-write` com checagem de arquivo, um comando de embrulho opcional (o `codex sandbox`) e a limpeza de variáveis de identidade do pai simulado. O `setup-pstack` passa a importar daqui, sem mudar de comportamento. |
| Tarefa agendada `pstack-vic-cli-updates` | Toda semana, chama a skill do plugin instalado. |

Subcomandos do script:

| Subcomando | O que faz |
|---|---|
| `check [--cli <nome>]` | Por CLI: cópias instaladas (caminho e versão), a cópia que os pais resolvem, versão instalada, última do canal, duplicatas, se está em uso, versões dos binários embutidos nos apps. |
| `notes --cli <nome> --from <A> --to <B>` | Baixa e normaliza as notas do intervalo `(A, B]` em `[{ version, date, entries: [{ text, breaking? }] }]`. |
| `install --cli <nome> --version <V>` | Instala a versão exata na cópia que os pais resolvem e confere com `--version`. Serve também para voltar. No grok, guarda antes uma cópia do binário atual. |
| `probe --cli <nome> --dir <pasta>` | Monta e roda as lanes da sonda e devolve um resumo por lane. |

Uma trava de arquivo (`O_EXCL`) na pasta de cache faz uma segunda execução simultânea sair com "já em execução".

**Estado entre execuções:** nenhum arquivo local.
- A versão para onde voltar é a que o `check` leu no início da mesma execução.
- A versão segurada é uma issue aberta no Linear. Fechar a issue depois do PR de ajuste libera a próxima tentativa.

## Fluxo de uma execução

As CLIs são tratadas uma de cada vez, na ordem **codex → grok → claude**. O `codex sandbox` embrulha as lanes `seatbelt` das outras duas, então o codex é decidido antes delas.

Para cada CLI:

1. **`check`.** Se já está na última versão do canal: "em dia" e passa para a próxima.
2. **Versão segurada.** Se há issue aberta `CLI <nome> <versão> segurada` para a mesma versão-alvo, a skill pula e cita a issue. Se saiu uma versão mais nova que a segurada, avalia a mais nova.
3. **CLI em uso.** Se algum processo roda o binário que seria trocado, a CLI fica "adiada", sem mudança. Os binários embutidos nos apps têm outro caminho e não contam.
4. **`notes`.** Se as notas não puderem ser baixadas, a skill não atualiza e registra no comentário, sem abrir issue.
5. **Leitura.** Cada entrada das notas vira uma de três coisas: sem relação com o plugin; correção ou adição que mantém o contrato; mudança de contrato num ponto da lista (flag removida ou renomeada, padrão trocado, formato de saída diferente, comportamento diferente).
   - Se houver mudança de contrato num ponto `lane` **sem cobertura**: segura. Não instala e abre ou atualiza a issue.
   - Mudança de contrato num ponto `harness` nunca segura. Entra no relatório como "vai chegar no app", com o ponteiro.
6. **`install`** da versão nova.
7. **`probe`.**
   - **Tudo passa:** a versão nova fica. O relatório lista as mudanças de contrato que a sonda validou.
   - **Alguma lane falha:** volta para a versão anterior e roda a mesma sonda de novo (contraprova).
     - Anterior passa: a culpa é da versão nova. Issue "segurada" com o trecho do recibo que falhou, as notas ligadas àquele ponto e o ponteiro para o código.
     - Anterior também falha: o problema é do ambiente (login, cota, rede). Fica na anterior, sem issue de retenção, e o relatório diz "sonda inconclusiva". A próxima execução tenta de novo.

## Pontos de contato

Formato de uma entrada:

```json
{
  "id": "grok.events",
  "cli": "grok",
  "kind": "lane",
  "contract": "streaming-messages-json: evento type=result com subtype, is_error, result, modelUsage, session_id, usage, total_cost_usd",
  "pointers": [{ "file": "skills/poteto-mode/scripts/runner/parse-output.ts", "anchor": "function parseGrok" }],
  "coveredBy": ["read", "write", "seatbelt"],
  "measuredOn": "1.0.5"
}
```

- `kind: "lane"` é o que o runner usa da CLI. `kind: "harness"` é o que o plugin usa do Claude Code ou do Codex como pai.
- `coveredBy` lista as lanes da sonda da mesma CLI que exercitam o ponto. Uma lista vazia quer dizer "sem cobertura".
- `measuredOn` é a versão em que o comportamento foi medido.

Conteúdo inicial:

| id | kind | Contrato | Ponteiro principal | coveredBy |
|---|---|---|---|---|
| `codex.exec-argv` | lane | `exec --model --config model_reasoning_effort=… --sandbox read-only\|workspace-write --cd --skip-git-repo-check --ephemeral --disable plugins\|multi_agent\|hooks\|memories --json -` | `runner/commands.ts`, `case "codex":` do `invocationCommand` | read, write |
| `codex.events` | lane | `--json`: `thread.started.thread_id`, `item.completed` com `agent_message.text`, `turn.completed.usage`, `turn.failed.error.message` | `runner/parse-output.ts`, `function parseCodex` | read, write |
| `codex.preflight` | lane | `codex login status` contém "logged in" | `runner/commands.ts` `preflightCommand`; `runner/run.ts` `function preflightPassed` | read |
| `codex.served-model` | lane | o stream não reporta o modelo servido; recibo `pinned-argv` | `model-matrix.json`, `reportedModel: null` de sol e astra | read |
| `codex.efforts` | lane | `model_reasoning_effort` aceita os esforços em uso | `model-matrix.json`, `efforts` das famílias codex | read, write |
| `codex.sandbox` | lane | `codex sandbox -c sandbox_mode=… -c sandbox_workspace_write.*` exporta `CODEX_SANDBOX` e aplica `writable_roots` e `network_access` | `runner/probe-lane.ts`; `runner/commands.ts` `function insideCodexSandbox` | sandbox |
| `codex.plugin-manifest` | harness | campos de `.codex-plugin/plugin.json` | `.codex-plugin/plugin.json` | — |
| `codex.implicit-invocation` | harness | `policy.allow_implicit_invocation: false` | `skills/poteto-mode/agents/openai.yaml` | — |
| `codex.marketplace` | harness | `codex plugin marketplace add --ref`, `upgrade`, `codex plugin add` | `docs/reference.md`, instalação e publicação | — |
| `codex.multi-agent` | harness | `features.multi_agent`, `spawn_agent` no pai Codex | `skills/poteto-mode/references/provider-dispatch.md` | — |
| `grok.argv` | lane | `--prompt-file --model --reasoning-effort --permission-mode --sandbox --tools --disallowed-tools --output-format streaming-messages-json --cwd --no-subagents --disable-web-search --verbatim` | `runner/commands.ts`, `case "grok":` | read, write, seatbelt |
| `grok.tools` | lane | nomes `read_file`, `grep`, `list_dir`, `run_terminal_cmd`, `search_replace`; negados `Agent`, `search_tool`, `use_tool` | `runner/commands.ts`, `function grokTools` | write, seatbelt |
| `grok.permissions` | lane | um prompt de permissão cancela o turno headless; `bypassPermissions` evita o prompt | `runner/commands.ts`, `function grokPermissionMode` | write, seatbelt |
| `grok.events` | lane | evento `result` (ver exemplo acima) | `runner/parse-output.ts`, `function parseGrok` | read, write, seatbelt |
| `grok.reported-model` | lane | a chave do `modelUsage` é `grok-4.7-build` (sufixo `-build`) | `model-matrix.json`, `reportedModel` de `grok-4-7` e `grok` | read |
| `grok.preflight` | lane | `grok models` contém "logged in" e o id do modelo; uma nova tentativa depois de 5 s | `runner/run.ts`, `function preflightPassed` e `GROK_PREFLIGHT_RETRY_DELAY_MS` | read |
| `grok.efforts` | lane | `--reasoning-effort` aceita os esforços em uso | `model-matrix.json`, `efforts` das famílias grok | read, write |
| `grok.nested-seatbelt` | lane | dentro do seatbelt do Codex, o perfil próprio do grok falha; o runner usa `--sandbox none` | `runner/commands.ts`, `function grokSandbox` | seatbelt |
| `grok.state-dir` | lane | o grok escreve em `~/.grok`; sob o seatbelt ele precisa estar em `writable_roots` | `provider-dispatch.md`, parágrafo do pai Codex | seatbelt |
| `grok.readonly-temp` | lane | o perfil `read-only` deixa as pastas temporárias graváveis | `provider-dispatch.md`, parágrafo de read-only | — (sem cobertura) |
| `claude.print-argv` | lane | `-p --model --effort --permission-mode plan\|acceptEdits --setting-sources project --strict-mcp-config --tools --no-session-persistence --disable-slash-commands --disallowed-tools --output-format json` | `runner/commands.ts`, `case "claude":` | read, write, seatbelt |
| `claude.result-json` | lane | `result`, `is_error`, `modelUsage`, `session_id`, `usage`, `total_cost_usd` | `runner/parse-output.ts`, `function parseClaude` | read, write, seatbelt |
| `claude.reported-model` | lane | `modelUsage` reporta `claude-opus-5-5` | `model-matrix.json`, `reportedModel` de `opus` | read |
| `claude.preflight` | lane | `claude auth status --json` com `loggedIn: true` | `runner/run.ts`, `function preflightPassed` | read |
| `claude.identity-env` | lane | variáveis de identidade do pai (`CLAUDECODE`, `CLAUDE_CODE_*`) | `runner/run.ts`, `const CLAUDE_IDENTITY` | read |
| `claude.plugin-validate` | lane | `claude plugin validate --strict --json` aceita marketplace e plugin | `scripts/manifests.test.ts` | manifest |
| `claude.skill-frontmatter` | harness | `disable-model-invocation`, `user-invocable`, `name`, `description` | `skills/*/SKILL.md`; `tests/skill-collision-repro.sh` | — |
| `claude.agent-frontmatter` | harness | campos dos agents gerados | `scripts/generate-agents.ts` | — |
| `claude.plugin-commands` | harness | `claude plugin marketplace update`, `claude plugin update`, `--plugin-dir` | `docs/reference.md` | — |
| `claude.background-drain` | harness | `TaskOutput` com bloqueio num pai `claude -p` | `provider-dispatch.md`, parágrafo de drenagem | — |

Os ponteiros acima são o ponto de partida. A implementação escolhe âncoras que existem hoje em cada arquivo, e o teste as trava.

Testes da lista (`update-clis.test.ts`):
- o JSON segue o formato; os `id` são únicos; `cli` é uma CLI com `transport: cli` na matriz; `kind` é `lane` ou `harness`;
- cada ponteiro acha o arquivo e a âncora dentro dele;
- cada lane de `coveredBy` existe na sonda daquela CLI; um ponto `harness` tem `coveredBy` vazio;
- **toda flag** que `invocationCommand` e `preflightCommand` geram (todos os modos de acesso, e o grok com e sem `CODEX_SANDBOX`) aparece no `contract` de algum ponto da mesma CLI.

## Sonda

**Quais pares.** Os pares saem das duas fichas (`~/.claude/pstack-models.md` e `~/.codex/pstack-models.md`, lidas com `parseSheet` e `normalizeLane` do `setup-pstack`). Entram só as lanes que passam pelo runner naquele pai:
- claude, a partir do pai Codex;
- codex, a partir do pai Claude;
- grok, a partir dos dois.

Duplicatas `família@esforço` são removidas. Se uma ficha não existir, entram os padrões da matriz para aquele pai. Hoje o resultado é `grok-4.7@xhigh`, `opus@xhigh` e `sol@xhigh`.

**Lanes**, em série:

| Lane | CLIs | Como roda | Passa quando |
|---|---|---|---|
| `read` | todas | runner em `read-only`, com o pai simulado (`--parent claude` para codex e grok, `--parent codex` para claude); o prompt pede um marcador | recibo `complete`; modelo verificado pelo `reportedModel` ou `pinned-argv` quando a matriz diz `null`; o marcador está na saída |
| `write` | todas | runner em `isolated-write` numa pasta só da lane; o prompt pede para rodar `ls` e criar `probe.txt` com o marcador | tudo de `read`, mais `probe.txt` com o marcador exato |
| `seatbelt` | grok, claude | igual a `write`, embrulhado em `codex sandbox -C <pasta> -c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=true -c 'sandbox_workspace_write.writable_roots=["<home>/.grok"]' --`, com `--parent codex` | tudo de `write`; no grok, o `argv` do recibo também tem `--sandbox none` |
| `sandbox` | codex | `codex sandbox` com os mesmos `-c`, rodando um comando de shell, sem modelo | `CODEX_SANDBOX` exportado, escrita na pasta da lane aceita e escrita em `~/.grok` aceita |
| `manifest` | claude | `node --test scripts/manifests.test.ts` na raiz do plugin de onde a skill roda (o cache do plugin instalado, na rotina), sem modelo | o teste passa e o caso do `claude plugin validate` não foi pulado |

- **Pai Codex simulado:** antes de chamar o runner para uma lane com `--parent codex`, o `probe-lane.ts` tira do ambiente `CLAUDECODE` e as variáveis `CLAUDE_CODE_*`. O runner não muda.
- **Pasta das execuções:** `~/Library/Caches/pstack-vic/update-clis/<data-hora>/`, com notas, prompts, saídas, recibos e o resumo da execução. Fica fora de `/tmp` e do `TMPDIR` por causa da ressalva do perfil read-only do grok. A skill guarda as 10 execuções mais recentes.
- **Prazo:** `--timeout 600` por lane. Um estouro conta como falha, e a contraprova decide de quem é a culpa.
- **Tamanho no pior caso, hoje:** 10 lanes, 8 delas com turno de modelo (codex 3 com 2 de modelo, grok 3, claude 4 com 3 de modelo). Só rodam para as CLIs com versão nova e dobram só quando há contraprova. O custo em dólar que um recibo mostra é equivalente de preço de lista, não cobrança: as três CLIs rodam em assinatura.

## Falhas e volta

- **claude e codex:** `npm i -g <pacote>@<anterior>` com o `bin` do Node da cópia resolvida à frente do PATH, porque o npm instala no prefixo do primeiro `node` do PATH. Não depende da versão nova. Confere com `--version`.
- **grok:** antes de instalar, a skill copia `~/.grok/downloads/grok-macos-aarch64` (134 MB) para a pasta da execução. Para voltar, tenta `grok update --version <anterior>`; se o comando falhar ou a versão não bater, restaura a cópia. A cópia é apagada no fim da execução, depois de conferida a versão final.
- **A volta falha:** issue urgente `CLI <nome> quebrada: volta falhou`, com os comandos manuais exatos. A execução para, e as CLIs seguintes não são tocadas.

| Situação | Comportamento |
|---|---|
| `check` não lê a última versão (npm, gh, rede) | Aquela CLI aparece como "sem verificação"; as outras seguem |
| Notas indisponíveis | Não atualiza; registra no comentário; sem issue |
| Linear inacessível no começo | A execução só relata e não instala nada, porque não sabe quais versões estão seguradas |
| Execução simultânea | A trava de arquivo faz a segunda sair com "já em execução" |
| Pai Codex no disparo manual | A skill recusa e explica que roda só com pai Claude Code |

## Rotina e relatório

- Tarefa agendada do app `pstack-vic-cli-updates`, **segunda às 07:00**. O prompt manda usar a skill `pstack:update-clis` e postar no Linear. A tarefa usa a skill do plugin instalado. O texto do prompt fica registrado em `docs/reference.md`.
- O relatório vai para o projeto `pstack-vic` do Linear (id `03492344-5c99-4be2-adfe-abaebc7f82b9`, time Clinext/CLI), pelo conector MCP:
  - **Comentário no projeto** quando nada foi segurado. Uma linha por CLI (em dia, atualizada `A → B` com as lanes que passaram, adiada, sem verificação, sonda inconclusiva), mais as versões dos binários embutidos nos apps, as mudanças de contrato `harness` e as duplicatas encontradas.
  - **Uma issue por versão segurada**, título `CLI <nome> <versão> segurada`, com:
    - o motivo (mudança sem cobertura ou falha na sonda);
    - as linhas de nota em questão;
    - o `id` e os ponteiros do ponto de contato;
    - o trecho do recibo que falhou;
    - o caminho da pasta da execução.

    Antes de criar, a skill procura issue aberta com o mesmo título e atualiza a existente em vez de duplicar.
  - No disparo manual, o mesmo resumo aparece no chat. Se o `claude` de terminal acabou de ser atualizado, o relatório lembra de reiniciar a sessão.

## Implantação

Única vez. Cada passo que muda a máquina pede o ok de Victor na hora.

1. **Release 0.1.9 por PR:**
   - versão nos quatro arquivos do padrão de `docs/reference.md`;
   - `skills/update-clis/scripts/*.test.ts` no `npm test`;
   - `CHANGES.md`, `docs/reference.md` (skill, layout, prompt da rotina) e uma nota em `provider-dispatch.md` dizendo que a versão das CLIs passa pela skill.

   Victor faz o merge. Depois, atualizar o plugin nos dois pais.
2. **Desligar o auto-update do claude:** `"env": {"DISABLE_AUTOUPDATER": "1"}` em `~/.claude/settings.json`; conferir com `claude doctor`.
3. **Remover o claude duplicado:** `PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH" npm uninstall -g @anthropic-ai/claude-code`. Daí em diante, o `check` só relata duplicatas.

   Em 2026-09-24, este passo rodou com o npm do Node 24.19.0 chamado pelo caminho completo e removeu o claude errado: o 2.1.281 do Node 24.21.0, que foi reinstalado à mão. O `npm-cli.js` começa com `#!/usr/bin/env node`, então roda no primeiro `node` do PATH (o do 24.21.0) e tira dele o prefixo global. Com o `bin` do 24.19.0 à frente do PATH, o npm roda no Node 24.19.0 e mexe no prefixo dele. Hoje o Node 24.19.0 não tem mais o `@anthropic-ai/claude-code`.
4. **Criar a tarefa agendada** e disparar a primeira execução com "Run now". Ela deve levar o grok de 1.0.5 a 1.0.41 e o codex de 0.155.1 a 0.156.1; o claude está em dia. Confirmar que o modo automático da tarefa deixa passar `node <script> install ...`. Se for barrado, acrescentar uma regra de permissão só para esse comando.
5. **Registros:**
   - `CHANGES.md`: não havia rotina antiga para cancelar, e a skill completa o G-9;
   - memória `grok-cli-update-pin`: aponta a skill como o caminho de atualização.

## Testes

- `update-clis.test.ts`, com CLIs falsas num PATH temporário (o mesmo padrão dos testes do runner, com `fs.writeSync` e fakes aquecidos):
  - `check`: versão, duplicatas, em uso, canal do claude lido do settings;
  - `notes`: os três parsers, com fixtures reais gravadas (seção do `CHANGELOG.md`, corpo de release do codex, JSON do CDN do grok), intervalo aberto à esquerda e fechado à direita, e falha limpa quando a fonte não responde;
  - `install`: conferência de versão e volta do grok pela cópia quando o `grok update` falha;
  - `probe`: montagem dos pares a partir de fichas de exemplo; o comando de embrulho e a limpeza de ambiente de cada lane; julgamento de `write`, `seatbelt`, `sandbox` e `manifest`;
  - a trava de execução simultânea;
  - os testes da lista de pontos de contato.
- Os testes do `setup-pstack` continuam passando depois da extração do `probe-lane.ts`, sem mudança de comportamento.
- Prova real: a primeira execução da implantação, com a pasta da execução e o comentário ou as issues no Linear como evidência.

## Fora do escopo

- O Cursor e as lanes HTTP.
- Os binários embutidos nos apps desktop: só relatados.
- Alfas e betas; troca de canal.
- Editar o plugin: todo ajuste é uma sessão normal com PR.
- Registrar a versão da CLI no recibo do runner.
- Disparo manual a partir de um pai Codex.

## A medir na implementação

- Se o grok mantém um processo líder ocioso (`--leader-socket`, `~/.grok/leader.sock`) que faria a CLI parecer sempre em uso. Em 2026-09-24 nenhum estava rodando. Se aparecer, a regra de uso passa a ignorar o líder quando `~/.grok/active_sessions.json` está vazio.
- Se o `claude -p` aninhado precisa de mais variáveis removidas do que `CLAUDECODE` e `CLAUDE_CODE_*`.
- Se a lane `seatbelt` do claude escreve fora das raízes permitidas (a fase 9 mediu que ela sobe normalmente sob o seatbelt).

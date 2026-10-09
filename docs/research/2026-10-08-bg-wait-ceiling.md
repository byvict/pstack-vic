# Teto de 10 min do `claude -p`: o runner o desliga

Execução de 2026-10-08 (UTC já 2026-10-09), sem poteto-mode, numa sessão do app desktop, sobre a cabeça da PR #127 (`7f658b2d`, que nasceu da main `17436658`). Fecha a primeira lacuna do [relatório residual](2026-10-08-native-slots-residual.md): o runner ainda não definia `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`. É só adaptação de harness: não houve troca de modelo nem mudança de esforço, fallback de swarm, política de Arena ou de trilha, playbook ou pin upstream.

## Decisão

O runner dá `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` a todo filho Claude, lane ou owner, a não ser que o ambiente de quem chama já defina a variável. Nesse caso vale o valor de quem chama. Codex e Grok não recebem a variável. O valor fica no ramo Claude de `invocationCommand` (`commands.ts`), e `child.ts` o aplica no spawn por baixo do ambiente de quem chama. O preflight (`claude auth status`) não o recebe.

## Por quê

- **Medido na 2.1.295 ([relatório residual](2026-10-08-native-slots-residual.md#comando-vivo-no-fim-do-turno-de-um-owner-headless)).** Sem a variável, um comando de 11 min e um helper vivo foram parados aos 10 min ociosos. O CLI não rodou segundo turno e saiu com 0, e o runner gravou `complete` com a resposta do primeiro turno. Só o stderr bruto registra a parada. É um timeout implícito que sai como sucesso.
- **Contrato do runner.** [provider-dispatch.md](../../skills/poteto-mode/references/provider-dispatch.md) diz que o runner e o preflight não têm timeout implícito, e que só um `--timeout` com fonte real limita uma execução.
- **Documentação oficial** ([headless](https://code.claude.com/docs/en/headless), "Background tasks at exit", lida em 2026-10-08). O teto padrão é 10 min de espera ociosa, e a variável o muda. Com `0`, o `claude -p` espera sem teto. A mesma página diz que o teto não corta comando em background da conversa principal e que subagentes são esperados até terminar. Na 2.1.295 os dois foram cortados. Por isso o runner não confia nessa exceção e define a variável.
- **Binário 2.1.295.** O padrão é `600000` ms. A checagem do teto só roda com valor maior que zero (`F>0`), e a linha de stderr nomeia a variável.

## Prova

Um owner rodou pelo runner candidato (`33245b59`) com o prompt do caso "Comando vivo no fim do turno (660 s)" do relatório residual, com nonce novo. O script de lançamento é o `run-bg-ceiling0.sh` de lá sem o `export`. Ele chama o runner por `env -u CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, então quem chamou não tinha a variável. Claude Code 2.1.295, `claude-opus-5-5@xhigh`, `isolated-write`, `agentKind: owner`.

- **Ambiente do filho.** Um vigia a cada 15 s leu do processo `claude` só essa variável. Ela estava em `0` nas 45 amostras com o filho vivo.
- **Comando sobreviveu ao teto.** O primeiro turno terminou às 00:21:56Z, com `sleep 660` em background. O `sleep` ainda estava vivo às 00:31:56Z, 00:32:11Z, 00:32:26Z e 00:32:41Z, depois do ponto em que o teto o teria parado.
- **Segundo turno chegou ao recibo.** O segundo turno rodou às 00:32:58Z e leu `BG_DONE 2a630055b83a21c8`. O stdout tem dois eventos `result`, e o stderr do CLI ficou vazio.
- **Recibo.** `complete`, exit 0, `claude-opus-5-5` por `provider-report`, sessão `e7673433-…`, 675,7 s. O `output.md` traz a resposta do segundo turno. No mesmo caso sem a variável, o recibo saiu `complete` com a resposta do primeiro turno, aos 611,7 s.

**Evidência privada:** `~/Dev/Skills/pstack-vic-runs/2026-10-08-bg-ceiling-default/`. Contém:

- `capture.sh` e `events.log`;
- `00-versions/`, com as versões e o SHA do candidato;
- `01-proof/`, com a captura do runner, o recibo, os streams e `watch.tsv`;
- `lab/`, com prompt, script de lançamento, vigia e fixture.

O vigia não grava o ambiente do processo, só a linha da variável.

## Testes

`run.test.ts`, bloco "Claude background wait", com o fake de CLI do runner gravando o valor que o filho do modelo vê:

- um filho Claude recebe `0` quando quem chama não define a variável;
- o valor de quem chama (`1800000`) chega intacto;
- filhos Codex e Grok não recebem a variável.

Sem a mudança em `child.ts`, o primeiro teste falhou. Com o padrão do runner por cima do valor de quem chama, o segundo falhou.

Um teste de `probe-lane.test.ts` simula um pai Codex e exigia que a única variável `CLAUDE_CODE_*` do filho fosse a credencial. Ele passou a aceitar também a variável do teto, que vem do próprio runner e não do pai. Uma lane de um pai Codex real também a recebe.

## O que muda para quem chama

- Um comando em background que nunca termina, como um servidor de dev ou um `tail -f`, agora mantém a execução aberta até o `--timeout` de quem chama ou um cancelamento pelo handle. Antes ele morria aos 10 min e o recibo saía `complete`.
- O `--tools` que o runner passa não inclui Monitor, CronCreate nem ScheduleWakeup, então as esperas da documentação para Monitor e `/loop` não se aplicam à lane nem ao owner. As ferramentas dos helpers de um owner não foram conferidas.
- Quem quiser um teto define a variável no próprio ambiente, e o runner a respeita.

## Lacunas

- Com um teto finito definido por quem chama, o corte ainda sai como `complete`. O runner não lê a linha `Background tasks still running … stopping them` do stderr.
- Só owners foram medidos. Uma lane comum segue o mesmo caminho do `claude -p`, mas não foi exercitada.
- Não foi medido se um comando em background sobrevive quando o runner para o filho por `--timeout` ou cancelamento. A documentação diz que o SIGTERM encerra a árvore de processos dos comandos Bash vivos, e o runner manda SIGKILL 1 s depois do SIGTERM.

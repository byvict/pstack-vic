# Lacunas residuais da capacidade nativa e do worktree irmão

Execução de 2026-10-08, sem poteto-mode, numa sessão raiz interativa do Claude Code (app desktop) a partir da main `786d8fd1`. Fecha por medição as lacunas B2, B3 e B4 do [relatório da frente B](2026-10-08-native-slots.md) e a drenagem de comandos Bash em background num `claude -p`, que ficou aberta no [relatório da coordenadora](2026-10-08-claude-coordinator.md) (linha 51). Não houve troca de modelo nem mudança de esforço, fallback de swarm, política de Arena ou de trilha, playbook ou pin upstream. Os helpers foram `pstack-opus-xhigh` (`claude:claude-opus-5-5@xhigh`, a linha `feature, refactoring` da planilha), definidos no projeto de cada fixture. Os owners e as lanes headless usaram `claude-opus-5-5@xhigh`, pelo runner candidato ou pelo argv que ele gera.

## Base e versões

- **Raiz:** sessão no app desktop, binário 2.1.293, `CLAUDE_CODE_ENTRYPOINT=claude-desktop`.
- **CLIs no PATH:** `claude` **2.1.295**, usado por todas as sessões headless e de terminal desta frente; Codex 0.162.0; Node 24.21.0.
- **Candidato:** este branch sobre `786d8fd1`.
- **Documentação oficial lida antes de medir:** [permissions](https://code.claude.com/docs/en/permissions) (regras de Bash, `--add-dir`, comandos só de leitura, `cd` com git), [sub-agents](https://code.claude.com/docs/en/sub-agents) (limite simultâneo e retomada) e [headless](https://code.claude.com/docs/en/headless) ("Background tasks at exit").

**Evidência privada:** `~/Dev/Skills/pstack-vic-runs/2026-10-08-native-slots-residual/`. Contém:

- `capture.sh`, `events.log` e `inventory.tsv`;
- `00-versions/`, `01-git-add-dir/`, `02-resume-slot/`, `03-root-no-dev/` e `04-bg-drain/`;
- `lab/`, com fixtures, prompts, scripts de lançamento, o gerador de argv `gen-t1.mjs` e `nonces.json`.

O `capture.sh` grava argv, cwd, início, PID, stdout, stderr e exit antes de qualquer leitura. Nenhum token ou dump de ambiente entra no repositório.

## Matriz

"Comprovado" se limita ao host, à versão e à tarefa exercitados.

| Medição | Condição | Resultado | Lacuna |
| --- | --- | --- | --- |
| B3 controle | lane `claude -p` 2.1.295, argv do runner (`isolated-write`) com `--add-dir` para dois worktrees irmãos, sem regra | Read e Write ok; `git -C <dir>` status, add, commit e log: `This command requires approval`; `cd <dir> && git status`: `This command changes directory before running a version-control command, which can pick up untrusted hooks or repository configuration from the target directory. Approve only if you trust it.`; `chmod`: requires approval | repete o negativo da frente B na 2.1.295 |
| B3 regra larga | mesma lane mais `--allowedTools "Bash(git -C <wt> *)"` | status, add, commit (`a24746d`) e log ok. O segundo diretório, sem regra, continuou negado, assim como o `cd`+git e o `chmod`. Mas `git -C <wt> -c "alias.labx=!touch <wt>/alias-ran-lb" labx` rodou e criou o arquivo | a regra larga deixa o git executar qualquer programa; descartada |
| B3 regra por subcomando | mesma lane mais `Bash(git -C <wt> status *)`, `add`, `commit` e `log` | status, add, commit (`45b04d1`) e log ok; alias, o segundo diretório, `cd`+git e `chmod` negados | nenhuma |
| B3 owner → helper | argv de owner com a regra larga no `--allowedTools`; helper `pstack-opus-xhigh` em background, sem isolamento | o helper fez status, add, commit (`e47a4f3`) e log. O alias também rodou com a regra larga. Segundo diretório, `cd`+git e `chmod`: `Permission to use Bash has been denied.`. O `git -C` do próprio owner passou, e o stdout tem dois eventos `result` | a regra do `--allowedTools` vale para o helper |
| B3 só leitura | lane `read-only` (plan) com a regra larga; repetida com `--verbose` para registrar as chamadas | `git -C <wt> status` e `log`, `git -C <wt2> status` (sem regra) e `cd <wt> && git status` rodaram sem pedido. Write, add, commit, `chmod` e alias foram recusados pelo próprio modelo, sem chamar a ferramenta | o bloqueio do host a escritas em plan não foi exercitado; plan não precisa de regra para o git que só lê |
| B3 prova pelo chamador | runner candidato, `agentKind: owner`, `additionalDirectories: [wt-cp, wt2-cp]` | o argv trouxe um `--add-dir` e sete regras por diretório. O helper fez status, add, `diff --cached --stat`, commit (`1cccd11`), `show --stat`, `rev-parse HEAD`, log e o status do segundo diretório. O alias, `checkout -b lab-extra`, `cd`+git e `chmod` foram negados: não há `alias-ran-cp` nem branch `lab-extra`. O `git -C` do owner passou. Recibo `complete`, `claude-opus-5-5` por `provider-report`, sessão `f8ced7a3-…`, 81,7 s | nenhuma |
| B2 retomada de concluído | owner pelo runner, `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=2`; H1 concluído, H2 e H3 rodando | `SendMessage` a H1: `{"success":true,"message":"Resuming agent aaeaa9e",…}`. `ListAgents` listou H1, H2 e H3 `running`, três sob limite 2. O spawn de H4 foi recusado com o texto de limite | nenhuma |
| B2 parado por `TaskStop` | `TaskStop` em H2 (`killed`), com H1 retomado e H3 rodando | o spawn de H5 foi recusado: o H1 retomado ocupa vaga. `SendMessage` a H2 parado: `Resuming agent ace350c`, e de novo três `running`. O spawn de H6 foi recusado. Com todos concluídos, H7 foi admitido. Recibo `complete`, sessão `b8982cba-…`, 229,4 s | nenhuma |
| B4 raiz sem concessão, `acceptEdits` | raiz de terminal 2.1.295 aberta por `run_in_terminal` (tmux), `--setting-sources project,local`, cwd `lab/root-plain` (sem git, sob `~/Dev`), irmão `wt-t3a` de outro repositório | o `pwd` do helper passou. Read, Write, `ls` e `git -C` viraram, cada um, um pedido de permissão na raiz ("Read file · from the pstack-opus-xhigh agent" …), negados com Esc; nada foi escrito | nenhuma |
| B4 `/add-dir` no meio da sessão | mesma raiz: `/add-dir wt-t3a` → "Yes, for this session" | um helper lançado depois leu, escreveu `proof-a-1.txt` e listou sem pedido; o `git -C` ainda pediu aprovação. Sessão `b84e8210-…` | só o helper lançado depois do `/add-dir` foi medido |
| B4 `--add-dir` na partida | raiz igual com `--add-dir wt-t3b` | Read, Write (`proof-b-1.txt`) e `ls` sem pedido; o `git -C` pediu. Sessão `27823098-…` | nenhuma |
| B4 modo auto, sem concessão | raiz igual em `--permission-mode auto`, sem `--add-dir` | o classificador aprovou os cinco passos, `git -C` incluído, e `proof-c-1.txt` foi escrito. Sessão `4009c884-…` | depende do classificador, não de uma concessão |
| Comando vivo no fim do turno (120 s) | owner pelo runner, `sleep 120; echo BG_DONE …` com `run_in_background` e fim de turno | o processo ficou vivo (vigia de 15 em 15 s). Quando o comando terminou, um segundo turno leu a saída às 23:14:28Z. Dois `result`; recibo `complete` com o segundo, 133,9 s | nenhuma |
| Comando vivo no fim do turno (660 s) | mesmo, `sleep 660` | aos 10 min ociosos: stderr `Background tasks still running 10m after the last turn (shell "Sleep 11 minutes then print marker"); stopping them. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.`, saída da tarefa `[killed]`, sem segundo turno. Exit 0, recibo `complete` com a resposta do primeiro turno, 611,7 s | contraria a documentação, que exclui desse teto os comandos da conversa principal |
| Teto desligado | mesmo, com `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` no ambiente do runner | esperou os 11 min; segundo turno às 23:34:52Z com `BG_DONE`; recibo `complete` com o segundo turno, 676,1 s | nenhuma |
| Helper vivo no fim do turno (> 10 min) | owner pelo runner; helper preso por arquivo, liberado aos 660 s | aos 10 min: `Background tasks still running 10m after the last turn (subagent "long helper", shell "Wait for release file, then record UTC timestamp"); stopping them.`; o runner já tinha saído quando o arquivo foi criado. Recibo `complete` com o primeiro turno, 617,7 s | contraria a documentação, segundo a qual a execução espera os subagentes |

## Git na pasta extra (B3)

A documentação de permissions manda escrever o comando e trocar a parte variável por `*`, com o `*` depois do subcomando. Ela avisa que `Bash(git * main)` também casa com `git -c core.fsmonitor=<script> diff main`. A medição mostrou que o mesmo vale para uma regra por diretório: `Bash(git -C <dir> *)` deixou passar um alias `!touch`. Uma regra por subcomando (`Bash(git -C <dir> status *)` e as demais) libera só aquele subcomando naquele diretório.

Em `acceptEdits`, isso valeu para a lane, para o owner e para o helper em background do owner. O `cd` antes do git, outro subcomando, opções do git antes do subcomando e comandos que não são git continuaram negados.

Em plan, o git que só lê já rodou na pasta extra sem regra nenhuma. Por isso o runner não dá regra a uma sessão `read-only`, e uma lane só de leitura nunca recebe `add` nem `commit`.

## Retomada e vaga (B2)

A documentação diz que retomar um subagente já concluído "takes a fresh slot without checking the limit". Medido na 2.1.295 headless com limite 2:

- A retomada é aceita com as duas vagas ocupadas, tanto de um helper concluído quanto de um parado por `TaskStop`, e o total de helpers rodando passa do limite.
- O helper retomado conta como rodando: enquanto ele rodava, todo spawn novo foi recusado com o texto de limite.
- O spawn voltou a ser admitido só quando todos terminaram.

A frase de [native-lifecycle](../../skills/poteto-mode/references/native-lifecycle.md) que dizia "count resumed handles as running again" agora traz esse resultado e proíbe retomar um helper para contornar uma janela cheia.

## Raiz sem `~/Dev` (B4)

A raiz foi aberta por `run_in_terminal` dentro de uma sessão tmux. O tmux permitiu ler a tela e digitar `/add-dir` e Esc; nenhuma permissão foi aprovada pelo laboratório.

Com `--setting-sources project,local`, as `additionalDirectories` do usuário (`~/Dev` e `~/Dev/clinext`) não entraram. O acesso do helper ao irmão seguiu o da raiz:

- **Sem concessão, em `acceptEdits`:** cada acesso virou um pedido de permissão na raiz.
- **Com `/add-dir` na sessão ou `--add-dir` na partida:** as ferramentas de arquivo e o `ls` passaram, e o `git -C` continuou pedindo aprovação.
- **Em modo auto:** o classificador aprovou tudo.

O fato foi levado a native-lifecycle: adicionar o worktree irmão à raiz antes de lançar o helper, e o git ali passar pela aprovação da raiz ou pelo classificador.

Três condições do laboratório:

- A primeira tentativa, num fixture com git próprio, parou no diálogo de confiança da pasta. Escolhi "No, exit" para não gravar confiança no `~/.claude.json`.
- A pasta sem git `lab/root-plain` herdou a confiança de `~/Dev` e abriu sem diálogo.
- A raiz perguntou se importava `~/.claude/pstack-models.md`, que vem do CLAUDE.md do usuário, e escolhi "No, disable external imports".

Na raiz a, o segundo prompt colado chegou truncado, e a raiz relançou o helper com o prompt original (`a-1`). A medição depois do `/add-dir` é desse relançamento.

## Comando vivo no fim do turno de um owner headless

A documentação de headless diz que um `claude -p` espera, depois do turno, pelos comandos em background da conversa principal "until the command exits", sem o teto de 10 min, e que a execução também fica aberta até os subagentes concluírem.

Na 2.1.295 o processo esperou e acordou quando um comando de 2 min terminou, e o recibo do runner ficou com o resultado final. Mas o teto de 10 min valeu para os dois casos:

- **Comando de 11 min:** foi parado aos 10 min.
- **Helper vivo por mais de 10 min:** também foi parado aos 10 min.

Nos dois casos não houve segundo turno, o exit foi 0 e o runner gravou `complete` com a resposta do primeiro turno. Só o stderr bruto do recibo registra a parada. Com `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`, o comando de 11 min foi esperado e o segundo turno rodou.

O touchpoint `claude.background-drain`, que só cobria helpers e citava a medição de 2.1.281, passou a descrever esse comportamento. A regra do playbook continua: o owner mantém o turno aberto até cada helper e cada comando reportar.

## Adaptação do runner

Para Claude em `isolated-write`, cada entrada de `additionalDirectories` ganha, além do `--add-dir`, sete regras de `--allowedTools`: `Bash(git -C <dir> <subcomando> *)` para `status`, `diff`, `log`, `show`, `rev-parse`, `add` e `commit` ([`capabilities.ts`](../../skills/poteto-mode/scripts/runner/capabilities.ts), `claudeGitRules`).

- **Sessão `read-only`:** não recebe regra.
- **Codex:** não recebe regra, porque o git já passava lá.
- **Grok:** continua recusando o campo.

Como a regra nomeia o caminho literalmente, o runner recusa para Claude uma entrada com caracteres além de letras, dígitos e `/ . _ @ % + = : -`; Codex continua aceitando essa entrada.

Também mudaram:

- os testes, em `capabilities.test.ts`;
- o contrato, em [runner-capabilities](../../skills/poteto-mode/references/runner-capabilities.md);
- os touchpoints `claude.add-dir`, `claude.subagent-capacity` e `claude.background-drain`;
- os fatos de B2 e B4, em [native-lifecycle](../../skills/poteto-mode/references/native-lifecycle.md) e numa linha de [provider-dispatch](../../skills/poteto-mode/references/provider-dispatch.md).

Nada mudou em modelos, esforços, fallback de swarm, políticas de Arena ou trilha, playbooks ou pin upstream.

## Registro sem tarefa

- **B1:** o limite de subagentes simultâneos só aparece no texto da recusa. Nem `ListAgents` nem o schema de `Agent` o anunciam (de novo nesta frente). O touchpoint `claude.subagent-capacity` vigia o texto.
- **Esforço:** o recibo guarda o esforço pedido. Nenhum CLI atesta o esforço servido. É um limite do host, sem mudança.
- **B5:** nenhuma receita ao vivo do verificador cobre estas sessões. As provas são as sessões reais acima e suas capturas privadas.

## Lacunas

- **O teto de 10 min derruba em silêncio o trabalho vivo de um owner headless.** Comandos e helpers ainda rodando 10 min depois do fim do turno são parados, e o recibo do runner sai `complete` com a resposta anterior. O contorno medido é `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`. O runner ainda não o define, porque isso mudaria o comportamento padrão das sessões Claude que ele lança e não foi pedido nesta frente.
- O bloqueio do host a escritas em plan na pasta extra não foi exercitado: o modelo recusou antes de chamar a ferramenta.
- Em B4 só um helper lançado depois do `/add-dir` foi medido. Não foi medido se um helper já vivo ganha o acesso.
- As sessões lançadas pelo runner a partir da raiz do app aparecem no `ListAgents` de outras sessões como "Claude Desktop session". É uma observação do rótulo, sem medição da causa.

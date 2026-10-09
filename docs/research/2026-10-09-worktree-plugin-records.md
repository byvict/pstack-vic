# Registros do plugin por worktree: inertes, e os de pasta apagada saem no release

Execução de 2026-10-09, sem poteto-mode, numa sessão do app desktop na worktree `clever-dewdney-2970c7`, a partir da main `4ccd627a` (0.5.28). Claude Code 2.1.293 no app desktop e 2.1.295 no terminal. É só adaptação de harness: não houve troca de modelo nem mudança de esforço, fallback de swarm, política de Arena ou de trilha, playbook ou pin upstream. Nenhuma versão foi publicada.

## A pergunta

Em 2026-10-09, depois do release da 0.5.28, o `~/.claude/plugins/installed_plugins.json` tinha registros `local` do `pstack@pstack-vic` presos em versões antigas. Eram cinco worktrees em `.claude/worktrees/` na 0.5.26 (uma delas já apagada), `kind-booth-84d54b` na 0.5.27 e a pasta apagada `~/.codex/worktrees/codex-integration-d/pstack-vic` na 0.5.26. A #126 já tinha medido que, de dentro de uma worktree ligada, `claude plugin update --scope local` atualiza o registro do checkout principal, e não o da worktree. Faltava saber se esses registros mudam o que uma sessão carrega e como tirá-los sem mexer no checkout principal.

## Resposta curta

- **Não mudam o que carrega.** Uma sessão numa worktree ligada carrega o registro `local` do checkout principal, depois o `project` dele, e só sem os dois o da própria worktree. As worktrees reais `poteto-t3-code-plugin-d01625` (nos dois binários) e `dreamy-tharp-deb166` (no 2.1.293), com registro na 0.5.26, carregaram `cache/pstack-vic/pstack/0.5.28`.
- **Custam disco e ruído.** O registro preso impede que a versão antiga ganhe a marca `.orphaned_at`, então o cache dela nunca é limpo. Na máquina real, das 50 versões no cache, só 0.5.26, 0.5.27 e 0.5.28 estavam sem a marca: as três que algum registro ainda cita. Cada worktree apagada deixa um registro para sempre, e o `release.ts` nomeava cada um a cada release.
- **A CLI não alcança o registro de uma worktree viva sem efeito colateral.** Ela alcança o de uma pasta apagada, se for chamada de um repositório git vazio recriado no caminho dela. O `release.ts` agora faz isso.

## Medidas

O campo `plugins[].path` do evento `system/init` de `claude -p --output-format stream-json --verbose` mostra o que a sessão carregou. Para variar os registros sem tocar no arquivo real, usei uma cópia da configuração com `CLAUDE_CONFIG_DIR`. Ela tinha um clone do repo como checkout principal (M) e uma worktree ligada dele (W). Também havia um caminho apagado fora de qualquer repo (X) e um apagado dentro de `M/.claude/worktrees/` (Y).

### O que a sessão carrega (2.1.295; os casos marcados também no 2.1.293)

| Registros | Carregou |
| --- | --- |
| M local 0.5.26, M project 0.5.28, W local 0.5.27 (os dois binários) | 0.5.26 |
| M project 0.5.28, W local 0.5.27 (os dois binários) | 0.5.28 |
| só W local 0.5.27 (os dois binários) | 0.5.27 |
| M local 0.5.26, M project 0.5.28, W local 0.5.27, sem `settings.local.json` em W | 0.5.26 |
| em M: M local 0.5.26, M project 0.5.28 | 0.5.26 |

### De onde vêm os registros das worktrees

Uma sessão que começa numa worktree ligada sem registro próprio cria um quando as configurações locais ativam o plugin, sejam as da worktree ou as do checkout principal. O registro novo copia a versão de um registro que já existe. Sem `settings.local.json` em W e com M local na 0.5.27, a sessão criou W local na 0.5.27. Por isso a `recursing-poincare-6c3e18`, aberta logo depois do release, nasceu na 0.5.28, e as mais antigas ficaram na versão do dia em que foram abertas. O app desktop também regrava o `.claude/settings.local.json` da worktree ao abrir a sessão: o desta worktree tem a hora do início desta sessão.

### O que cada comando faz

| Comando, de onde | Efeito |
| --- | --- |
| `plugin update --scope local`, de W, com M local | atualiza M local |
| `plugin update --scope local`, de W, sem M local | atualiza W local |
| `plugin uninstall --scope local`, de W | remove W local, mas também tira o plugin do `settings.local.json` de M e do de W |
| o mesmo, de W, com M sem `settings.local.json` | remove W local e edita só o de W |
| `plugin uninstall --scope local`, de X recriado vazio | remove só X, nenhum arquivo de configuração |
| `plugin uninstall --scope local`, de Y recriado vazio | remove Y, mas tira o plugin do `settings.local.json` de M |
| o mesmo com `GIT_CEILING_DIRECTORIES` | igual: ainda edita o de M |
| `plugin uninstall --scope local` ou `--scope project`, de Y recriado com `git init` | remove só Y, nenhum arquivo de M |
| `plugin enable --scope local`, de M | recusa (`already_in_goal_state`), não serve para restaurar |

Nem o `--help` (2.1.295) nem a documentação oficial (plugins, loading, cli-reference, settings e worktrees, lidas em 2026-10-09) dão opção para escolher um registro pelo caminho. A página de worktrees diz que plugins de escopo `project` do checkout principal valem nas worktrees e que aprovações vão para o `settings.local.json` do checkout principal. A de settings diz que, numa worktree, o Claude Code usa o arquivo da raiz do checkout principal. As duas explicam o efeito do `uninstall` em M.

Editar o `installed_plugins.json` à mão não foi preciso: a CLI tem um caminho que não toca nada além do registro.

## Decisão

- **`scripts/release.ts`.** Depois do Codex, remove cada registro cujo `projectPath` não existe mais e diz quais removeu. Para cada um, cria a pasta apagada, roda `git init --quiet` nela e `claude plugin uninstall pstack@pstack-vic --scope <escopo> --keep-data` de lá, e apaga só as pastas que criou. Se a pasta reapareceu nesse meio-tempo, o `mkdir` falha e o script para sem apagar nada. No fim, lê os registros de volta e falha nomeando o que sobrou. Um registro `local` atrasado de worktree ligada, quando o checkout principal tem registro próprio, fica como está e é nomeado com o motivo certo. Sem registro no checkout principal, o da worktree é atualizado de dentro dela.
- **Faxina.** Não muda. A skill fica fora deste repo (`~/.agents/skills/faxina`), e removê-la antes do `git worktree remove` teria o efeito colateral do `uninstall` em W. Depois que a faxina apaga a pasta, o próximo `node scripts/release.ts` remove o registro.
- **`docs/reference.md`** e o touchpoint `claude.plugin-commands` de `skills/update-clis/references/cli-touchpoints.json` registram o que foi medido (`measuredOn` 2.1.295).

## Prova

- `scripts/release.test.ts`: 28 testes passam. O fake do `claude` passou a ter `plugin uninstall` com chave pelo cwd e anota o repositório cujas configurações a CLI real limparia. O `update` dele, de uma worktree, só cai no registro da própria worktree quando o checkout principal não tem um. Testes novos cobrem: remoção de dentro de um checkout sem alcançar as configurações dele, com a pasta irmã e o `.git` do checkout intactos; caminho apagado com dois níveis faltando; falha do `uninstall`, com os dois pais já na versão; registro que sobra depois da remoção; e worktree sem registro no checkout principal.
- Mutações: sem o `git init`, o teste de dentro do checkout falha. Sem a regra do registro inerte, o teste da worktree falha.
- Ponta a ponta com o `claude` 2.1.295 real na cópia da configuração e o `codex` trocado por um stub já na versão: M local foi de 0.5.26 para 0.5.28, W foi nomeado e ficou, Y e um caminho apagado com dois níveis saíram, os `settings.local.json` de M e de W não mudaram, e o arquivo real não mudou. A segunda execução não mudou nada.
- Máquina real: o `release.ts` recusou rodar porque a `origin/main` andou (#131) e o checkout principal ficou atrás. Isso é a trava dele. Apliquei à mão os mesmos passos aos dois registros de pastas apagadas: `elated-sutherland-74a522` e `codex-integration-d/pstack-vic`. Cada `uninstall` removeu só o seu registro. O `.claude/settings.local.json` e o `.claude/settings.json` do checkout principal ficaram com o mesmo SHA-256.

## Sessões vivas, não tocadas

Processos do Claude com cwd nestas worktrees no início e de novo antes da limpeza real (07:40 e 07:58, -03): `kind-booth-84d54b`, `pstack-vic-user-uninstall-ed3e9a`, `recursing-poincare-6c3e18` e esta, `clever-dewdney-2970c7`. Os registros delas ficaram como estavam. Os de `poteto-t3-code-plugin-d01625` e `dreamy-tharp-deb166`, sem sessão viva, também ficaram, porque são inertes e a CLI não os remove sem mexer no checkout principal. Saem no release seguinte à faxina dessas pastas.

## Lacunas

- A ordem de carga foi medida para registros `local` de worktree. Um registro `project` com chave numa worktree não foi medido.
- Não foi medido em quanto tempo a limpeza apaga uma versão sem registro. A documentação fala em 14 dias depois da marca. Na cópia, a marca apareceu na primeira sessão depois de a versão ficar sem registro.
- O release só limpa registros do `pstack@pstack-vic`.

**Evidência privada:** `~/Dev/Skills/pstack-vic-runs/2026-10-09-worktree-plugin-records/`. Contém `backup/` (o `installed_plugins.json` antes de tudo) e `raw/`, com as cargas reais (`10-*`, `11-*`), os casos do laboratório (`20-*` a `26-*` e `lab/`), as mutações (`30-*`), a ponta a ponta (`e2e-lab/`) e a limpeza real (`real-run/`).

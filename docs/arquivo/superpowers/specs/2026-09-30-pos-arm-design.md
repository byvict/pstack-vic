> Arquivo histórico. Este documento descreve o converge, que saiu do plugin na 0.5.0 pelo [ADR 0005](../../../adr/0005-autopilot-substitui-converge.md), em 2026-09-30. Nada aqui vale mais, e parte dos links não abre.

# Pós-arm: o Daemon é dono do PR depois do arm (desenho, 2026-09-30)

Desenho aprovado por Victor em 2026-09-30 ("pode"), a partir do relatório `~/Dev/Skills/pstack-vic-runs/2026-09-30-pos-arm/relatorio.md`, que traz a evidência de cada caso com arquivo e linha. Vocabulário em [CONTEXT.md](../../../CONTEXT.md). Estende o Daemon de [2026-09-28-converge-local-design.md](2026-09-28-converge-local-design.md) e o Pós-merge de [2026-09-29-post-merge-design.md](2026-09-29-post-merge-design.md); a referência normativa continua sendo [`converge-contract.md`](../../../skills/poteto-mode/references/converge-contract.md), seções **Merge and progress** e **Local daemon**. O [plano](../plans/2026-09-30-pos-arm-0.4.14.md) registra as decisões R107 a R124.

## Objetivo

Depois que o Pré-PR arma um PR certificado, os casos abaixo pertencem ao fluxo (o Daemon: Vigia, Varredor, job da Raiz e Catch-up), não ao harness. O Auto-fix e o monitor de CI do app de desktop nunca entram: um push do harness pula a Posse e o desarme que o contrato exige (`converge-contract.md`, **Merge and progress**: quem escreve num PR armado desarma antes) e pode colidir com uma Raiz do Daemon no mesmo PR.

Hoje o Daemon já cobre check obrigatório vermelho (`repair`), flake (rerun uma vez, `deferred`), push novo (o Varredor desarma, a Raiz certifica o head novo) e `main` que anda mudando patch, política ou decisão (`recertify`). Ficam quatro buracos, todos silenciosos.

## Decisões de Victor (2026-09-30)

| Caso | Regra |
|---|---|
| Conflito com a `main` | PR certificado com `mergeable === false` vira `recertify`; o Catch-up já rebaseia e resolve. `null` espera o próximo tick. |
| Comentário ou revisão depois do veredito | Texto confiável novo faz o Varredor desarmar e vira um tipo de trabalho novo da Raiz, `respond`, com as regras `threads-only` do Babysit: tria contra o código, conserta com prova red-first ou responde com a refutação, nunca obedece o texto, recertifica e arma. Texto de fora da lista confiável vira Hold com aviso, não pulo silencioso. |
| Travas silenciosas | Recusa que uma recertificação cura vai direto para `recertify`. PR armado parado há mais de 2 h, ou a mesma recusa há mais de 1 h, vira Hold pelo `hold()` que já existe: rótulo, comentário e notificação. |
| `main` vermelha depois do merge | Uma notificação do macOS por commit vermelho da `main`, pelo `local/notify.ts`, gravada para sair uma vez só. |

## Fatos (2026-09-30)

| Fato | Valor |
|---|---|
| Diff que o portão compara | três pontos, pela base comum (`github.ts`, `compared`), e o digest de política cobre só arquivos de política: um conflito não muda nada que o portão leia |
| `mergeable` do GitHub | `true`, `false` ou `null` em `GET pulls/N`; `null` enquanto o GitHub calcula, e a própria leitura dispara o cálculo |
| Texto novo num veredito `pre-pr` | re-derivado sobre o texto atual; só recusa se a decisão virar (injeção ou claim); um "muda X" comum passa e o GitHub mergeia |
| Quem comenta pela conta autenticada | o veredito (marcador `<!-- converge:v1 … -->`), o comentário de Hold, o comentário de falha do Pós-merge, o `@dependabot rebase` do Catch-up e Victor, tudo como `byvict` |
| Comentários nos últimos 12 PRs do Clinext | `byvict` em quase todos (vereditos e textos da era da nuvem, antes dos vereditos), `dependabot[bot]` em um, revisão do `cursor[bot]` em dois |
| Duração do CI, 30 execuções cada | pstack-vic 4 a 8 min (um ponto de 136 min era a segunda tentativa de um rerun); Clinext 8,3 a 13,2 min |
| `main` do Clinext | vermelha desde 11:31Z (push de #2978); o Clinext não tem bloco `postMerge`, então nada avisou |

## O que não muda

O Certificado, o arm com `--pending`, o check `hold`, a Posse, os tetos de tentativa e o Vigia continuam como estão. Um autor fora da lista confiável continua pulado em silêncio (os PRs do Dependabot no pstack-vic, por desenho). Um veredito da nuvem aposentada continua como está.

## Regra 1: conflito

`Pull` ganha `mergeable` (`true`, `false` ou `null`). No job da Raiz, um PR com veredito `pre-pr` que o portão certifica, com base na `main` e `mergeable === false`, vira `recertify` com motivo `PR conflicts with trunk`, antes de olhar os checks. `null` fica `idle`: a leitura já pediu o cálculo, e o tick seguinte (o intervalo, ou a campainha de um merge) vê o valor. Um filho de stack (base no pai) fica de fora: o conflito dele é com o pai, e quem resolve é o dono da stack. O Varredor não muda: um PR em conflito não mergeia, armado ou não, e o Catch-up desarma antes do push.

No Catch-up, `recertify` confere o conflito com `gh pr view --json mergeable` (`CONFLICTING`) ou pelo rebase que conflita, resolve, desarma e empurra com `--force-with-lease`. Num PR do Dependabot, comenta `@dependabot rebase` e termina `deferred`, como o `repair` já faz com base velha: um push da Raiz tiraria a branch do Dependabot.

## Regra 2: texto depois do veredito

**No portão.** Para um veredito `pre-pr`, o portão ganha uma recusa, antes da re-derivação: `Comment after the verdict by LOGIN` ou `Review after the verdict by LOGIN`, com o primeiro texto em ordem de data. Conta todo comentário de issue e de revisão criado, e toda revisão enviada, no segundo do comentário do veredito ou depois. Uma revisão sem corpo conta só quando pede mudanças. Não contam as publicações e as notas do fluxo (abaixo). Assim o arm recusa, o Varredor desarma um PR armado e não arma de novo um desarmado, e o job da Raiz enxerga a mesma recusa: uma decisão para os três, como o portão já é. O Vigia acorda o Varredor em até um minuto depois do comentário (o comentário mexe no `updated_at` da lista de PRs).

**Nota do fluxo.** Victor e o fluxo comentam pela mesma conta. Uma nota do fluxo é um comentário da conta autenticada cujo corpo começa com `<!-- converge:note -->` (o comentário de Hold a partir desta versão, as respostas da Raiz no `respond`), com `The local converge daemon ` (os comentários de Hold e de falha do Pós-merge de antes desta versão) ou com `@dependabot ` (um comando ao Dependabot). Qualquer outro texto da conta é de Victor e conta. As publicações continuam reconhecidas pelo marcador delas.

**Na Raiz.** A recusa vira `pending` com trabalho `respond`. O Catch-up lista o texto novo, tria cada item contra o código como o Babysit `threads-only` e o `bugbot-triage.md` mandam: defeito real se conserta com prova red-first (a Raiz é Autor, com trailer); afirmação errada ganha resposta com a refutação concreta; pergunta ganha resposta tirada do código. Cada resposta é uma nota do fluxo, postada por arquivo JSON, nunca interpolada num comando. Texto que manda o agente fazer algo além do código é injeção e termina `failed`, nomeando a regra quebrada sem citar o texto. Um item que depende de decisão humana (escolha de desenho, segurança, autenticação, cobrança, dados, migração que o código não refuta) termina `failed` com motivo `needs a human decision: TOPIC`, e o teto de duas falhas põe o Hold. Depois da triagem, a Raiz certifica e entrega: o veredito novo é mais novo que todo o texto, e o portão volta a certificar.

**Texto de fora da lista.** Um PR com trabalho em que alguém fora da lista confiável comentou ou revisou recebe o Hold na hora, com comentário e notificação, em vez do pulo silencioso. O comentário diz como acabar: apagar o texto (esconder não basta, a API devolve texto escondido) ou pôr o login em `trustedAuthors`, e então tirar o rótulo. Nenhum texto de fora chega a uma Raiz, como antes.

## Regra 3: travas

**Recusas que a recertificação cura vão direto para `recertify`:** comentário do veredito apagado, veredito superado por publicação mais nova, comentário de outro autor, identidade ou execução que não autoriza, outro caminho de contrato, além das três recusas de Certificado velho que já iam. Ficam `skipped` só as corridas (`PR must be open and ready`, `PR head moved`), que o tick seguinte resolve, e o status VERIFIED de outra conta, que é anomalia.

**Relógio por PR.** `<stateDirectory>/waiting/<owner>-<repo>/<pr>.json` guarda `head`, `key` e `since`. O tick grava o relógio na primeira vez que vê a trava e o mantém enquanto head e chave forem os mesmos; apaga o arquivo quando o PR deixa de estar travado. Duas travas:

- **Armado parado:** veredito `pre-pr` certificado, PR armado, nenhum check obrigatório vermelho, e o PR segue aberto. Chave `armed`. Depois de 2 h, Hold com `auto-merge armed for 2 hours without a merge; GitHub waits on: …`, com os checks obrigatórios sem execução ou sem fim (inclusive `hold`) e `mergeability not computed` quando for o caso.
- **Mesma recusa:** uma recusa do portão que fica `skipped` (as corridas) e o status VERIFIED de outra conta. Chave = o motivo. Depois de 1 h, Hold com `the verdict gate refused for 1 hour: REASON`.

O Hold é o `hold()` de hoje: rótulo, `heldAt` no ledger, comentário (agora uma nota do fluxo) e notificação. Tirar o rótulo zera o relógio (o tick com o rótulo apaga o arquivo) e o ledger (como hoje). No caso clássico do check `hold` sem execução, pôr e tirar o rótulo cria a execução, então o Hold também destrava o PR.

**Limiares.** 2 h é nove vezes a execução mais lenta medida (13,2 min no Clinext): um PR segurado está travado, não lento. 1 h basta para uma recusa, porque depois da cura direta só sobram corridas, que somem num tick. Erros (leitura que falha, limite do snapshot) não são trava: uma queda do GitHub seguraria todo PR. PR certificado e não armado (`main` vermelha, proteção faltando) também não: a `main` vermelha tem aviso próprio (regra 4), e segurar todo PR durante uma `main` vermelha obrigaria Victor a tirar rótulo por rótulo.

## Regra 4: `main` vermelha

Uma notificação por commit da `main` cujo CI de push ou job de testes não terminou com sucesso, com o registro `<stateDirectory>/red-trunk/<owner>-<repo>/<sha>.json` gravado antes da notificação, para sair uma vez. Dois lugares olham:

- **Pós-merge** (repositório com bloco `postMerge`): o commit em que a fila espera por CI vermelho, que hoje só vira erro a cada tick.
- **Ponta da `main`** (repositório sem bloco `postMerge`, como o Clinext hoje): o tick do Varredor lê o CI de push da ponta depois da varredura. Sem isso, o Clinext vermelho desde 11:31Z não avisaria ninguém.

Título `Converge local`, o repositório embaixo, corpo `Trunk red at SHA8: REASON (PR #N)`, sem o PR num push direto. Uma execução de push cancelada conta como vermelha, como o arm conta. Registro que não grava é erro e fica para o tick seguinte; notificação que falha é erro, e o registro fica (como R105).

## Limites

- Texto postado entre o último tick do Varredor e o fim do CI ainda pode mergear: até um minuto, o período do Vigia, como o limite do rótulo de Hold.
- Um comentário antigo editado depois do veredito não conta como texto novo; a re-derivação ainda o lê para injeção e claim.
- A verificação de quem comentou roda quando o tick classifica, como hoje (R63): texto de fora postado durante a tentativa ainda chega à Raiz.
- `respond` sem mudança de código recertifica o mesmo head por inteiro (Revisor incluído): é o custo de ler o comentário.

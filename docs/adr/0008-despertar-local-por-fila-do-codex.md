---
status: accepted
---

# Despertar local pela fila do Codex

## Contexto

O Cursor observado encerra o turno e recebe um follow-up de `Shell.notify_on_output`. O Codex CLI 0.161.0 anuncia uma fila nativa, mas aceitar um item para uma sessão descarregada não inicia um turno. Isso é diferente de um processo que apenas dorme ou de uma espera bloqueante da raiz.

## Decisão

Adaptar um evento local à fila nativa de uma sessão persistida e já carregada. O controlador arma um processo finito com identidade estável, payload explícito, cancelamento e evidência própria. A sessão pode encerrar seu turno; o app-server local mantido pelo operador consome o evento e executa o próximo turno. O adaptador não cria nem retoma sessões, não escolhe modelos e não instala serviços.

Conservar o payload e a cadência do contrato upstream. Um novo tick exige nova armação explícita; não há recorrência escondida. Não restaurar Converge, jobs de merge, cloud ou workers remotos. A necessidade de controle local decorre do acesso ao socket, não de uma alteração no workflow de entrega.

## Consequências

O [mapeamento de ferramentas](../../skills/poteto-mode/references/codex-local-wake.md) ganha uma alternativa comprovável ao tick manual referido historicamente no [ADR 0005](0005-autopilot-substitui-converge.md). Isso não conserva processos filhos de um `codex exec` que terminou, nem oferece retomada após reinicialização do computador. Sem sessão carregada e controlador com acesso ao socket, o tick continua explícito do operador.

O recibo distingue aceitação e execução. Repetir a armação não repete o evento; perder a resposta de submissão exige inspeção, sem retry automático. Cancelar não desfaz um turno já iniciado. As [provas e tentativas preservadas](../research/2026-10-07-local-executor-contracts.md) delimitam o comportamento realmente observado.

## Refinamento em 2026-10-08

No desktop que anuncia `automation_update`, preferir um heartbeat nativo vinculado à thread exata da raiz. O app fez a retomada e a recorrência na prova isolada, sem exigir acesso ao socket pelo sandbox. Conservar o payload completo e a cadência do playbook: o pin vigente exige auditoria horária. A alternativa por fila permanece para hosts sem esse agendador ou sem a cadência necessária.

O comando `observe` reconcilia o UUID do evento com a fila e as mensagens de usuário no histórico paginado, preservando o recibo original de transporte. Retorna IDs e estados dos turnos; a execução bem-sucedida exige também conferir o efeito real do payload. Ausência nas duas fontes não autoriza replay. Desconexão do host antes do disparo é falha, não cancelamento do operador.

Rearmação e encerramento seguem o programa: heartbeat conserva o mesmo ID até stop/conclusão; a alternativa finita exige novo evento explicitamente, conservando o próximo horário devido e os handles próprios. Cancelar remove somente eventos pendentes e não interrompe um turno consumido. Nenhuma necessidade concreta do programa nem comportamento upstream exige durabilidade após reboot ou exatamente uma execução através de crashes. O [contrato final](../../skills/poteto-mode/references/codex-local-wake.md) e o [relatório reproduzível](../research/2026-10-08-codex-wake-lifecycle.md) registram a prova e as condições da integração.

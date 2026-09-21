#!/usr/bin/env bash
# Invariantes do pacote de skills. Adaptado de tests/skill-collision-repro.sh do
# open-pstack 1.4.1 (MIT, LICENSE-open-pstack) para o layout deste repo: o plugin
# é a raiz, os modelos por papel vêm de model-matrix.json (cobertos por npm test),
# e os checks que dependiam da reescrita de shipping/autopilot do open (recusada
# na fase 4) ficam de fora; os de manifest voltaram na fase 7. Só a parte estática roda por padrão; a prova de
# invocação no Claude Code roda com PSTACK_BEHAVIORAL=1.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

note() { printf '%s\n' "$*"; }

legacy_command_dir="$repo/commands"
if [ -e "$legacy_command_dir" ]; then
  note "FAIL: legacy command layer still exists: $legacy_command_dir"
  find "$legacy_command_dir" -mindepth 1 -print 2>/dev/null || true
  fail=1
else
  note "ok: native skills are the only user-facing workflow surface"
fi

bad_principle=""
for skill in "$repo"/skills/principle-*/SKILL.md; do
  if [ ! -f "$skill" ]; then
    bad_principle="no principle-* leaves found"$'\n'
    break
  fi
  front="$(sed -n '2,/^---$/p' "$skill")"
  printf '%s\n' "$front" | grep -q '^user-invocable: false$' || bad_principle="$bad_principle$skill (missing user-invocable: false)"$'\n'
  printf '%s\n' "$front" | grep -q '^disable-model-invocation: true$' && bad_principle="$bad_principle$skill (still carries disable-model-invocation)"$'\n'
done
if [ -n "$bad_principle" ]; then
  note "FAIL: principle-* leaves must be user-invocable: false and model-readable:"
  note "$bad_principle"
  fail=1
else
  note "ok: all principle-* leaves request user-hidden and remain model-readable"
fi

# CHANGES.md, decisão 1 da fase 4: poteto-mode invoca as skills de fluxo pelo
# modelo, então nenhuma pode carregar disable-model-invocation.
routed_model_bad=""
for routed_skill in "$repo"/skills/*/SKILL.md; do
  case "$routed_skill" in */skills/principle-*) continue ;; esac
  front="$(sed -n '2,/^---$/p' "$routed_skill")"
  if printf '%s\n' "$front" | grep -q '^disable-model-invocation: true$'; then
    routed_model_bad="${routed_model_bad}${routed_skill}"$'\n'
  fi
done
if [ -n "$routed_model_bad" ]; then
  note "FAIL: skills routed by name must stay model-invocable:"
  note "$routed_model_bad"
  fail=1
else
  note "ok: routed skills stay model-invocable"
fi

# Colisão de nomes: o nome do diretório é o nome da skill nos dois pais, então
# frontmatter e diretório têm de coincidir e nenhum nome pode repetir.
name_bad=""
seen_names=""
for skill in "$repo"/skills/*/SKILL.md; do
  dir="$(basename "$(dirname "$skill")")"
  name="$(sed -n '2,/^---$/p' "$skill" | sed -n 's/^name:[[:space:]]*//p' | head -1)"
  if [ -z "$name" ]; then
    name_bad="${name_bad}${skill}: no name in frontmatter"$'\n'
    continue
  fi
  if [ "$name" != "$dir" ]; then
    name_bad="${name_bad}${skill}: name [$name] != directory [$dir]"$'\n'
  fi
  case " $seen_names " in
    *" $name "*) name_bad="${name_bad}${skill}: duplicate skill name [$name]"$'\n' ;;
  esac
  seen_names="$seen_names $name"
done
if [ -n "$name_bad" ]; then
  note "FAIL: skill names collide with or differ from their directories:"
  note "$name_bad"
  fail=1
else
  note "ok: every skill name equals its directory and is unique"
fi

# Versão única: os dois manifests do plugin, a entrada do marketplace do Claude
# Code (e a tag que ela fixa) e package.json têm de concordar. Instalação é por
# tag, nunca por main.
verof() { { grep -m1 '"version"' "$1" || true; } | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'; }
vc="$(verof "$repo/.claude-plugin/plugin.json")"
vx="$(verof "$repo/.codex-plugin/plugin.json")"
vm="$(verof "$repo/.claude-plugin/marketplace.json")"
vp="$(verof "$repo/package.json")"
ref="$(sed -n 's/^[[:space:]]*"ref":[[:space:]]*"\([^"]*\)".*/\1/p' "$repo/.claude-plugin/marketplace.json" | head -1)"
if [ -n "$vc" ] && [ "$vc" = "$vx" ] && [ "$vc" = "$vm" ] && [ "$vc" = "$vp" ] && [ "$ref" = "v$vc" ]; then
  note "ok: plugin version matches across the manifests, the marketplace tag and package.json ($vc)"
else
  note "FAIL: plugin version differs: claude-plugin=$vc codex-plugin=$vx marketplace=$vm ref=$ref package.json=$vp"
  fail=1
fi

# O logo do manifest do Codex tem de ser um arquivo regular dentro do plugin
# (check do open 1.4.1). O manifest do Claude Code não declara logo: o campo não
# existe no schema e reprova em `claude plugin validate --strict`.
codex_manifest="$repo/.codex-plugin/plugin.json"
logo_path="$(sed -n 's/^[[:space:]]*"logo":[[:space:]]*"\([^"]*\)".*/\1/p' "$codex_manifest")"
logo_bad=""
case "$logo_path" in
  "") logo_bad="interface.logo is missing from $codex_manifest" ;;
  /*) logo_bad="interface.logo must be plugin-relative: $logo_path" ;;
esac
logo_rel="${logo_path#./}"
case "/$logo_rel/" in
  */../*) logo_bad="interface.logo escapes the plugin root: $logo_path" ;;
esac
if [ -z "$logo_bad" ] && { [ ! -f "$repo/$logo_rel" ] || [ -L "$repo/$logo_rel" ]; }; then
  logo_bad="interface.logo does not name a regular file under the plugin root: $logo_path"
fi
if [ -n "$logo_bad" ]; then
  note "FAIL: codex logo path does not resolve"
  note "$logo_bad"
  fail=1
else
  note "ok: codex logo path resolves"
fi
if grep -q '"logo"' "$repo/.claude-plugin/plugin.json"; then
  note "FAIL: the Claude manifest carries a logo field that Claude Code does not know"
  fail=1
else
  note "ok: the Claude manifest has no logo field"
fi

# A configuração ativa usa os aliases móveis de Fable e Opus (a matriz é a fonte;
# npm test cobre os descritores). Aqui só o grep barato por pin de revisão. Testes
# ficam de fora: setup-pstack.test.ts exercita a migração desses pins de propósito.
legacy_model_pins="$(
  grep -REn \
    --include='*.md' --include='*.ts' --include='*.sh' \
    --exclude='*.test.ts' \
    'claude:claude-(fable|opus)-[0-9]|^model: claude-(fable|opus)-[0-9]|--model claude-(fable|opus)-[0-9]' \
    "$repo/skills" "$repo/agents" "$repo/docs" "$repo/tests" "$repo/README.md" \
    2>/dev/null || true
)"
standalone_code_pins="$(
  grep -REn \
    --include='*.ts' --include='*.js' --include='*.mjs' \
    --exclude='*.test.ts' --exclude='*.test.js' \
    "['\"]claude-(fable|opus)-[0-9]" \
    "$repo/skills" "$repo/scripts" \
    2>/dev/null || true
)"
if [ -n "$legacy_model_pins" ] || [ -n "$standalone_code_pins" ]; then
  note "FAIL: active Fable or Opus configuration still pins a model revision:"
  [ -z "$legacy_model_pins" ] || note "$legacy_model_pins"
  [ -z "$standalone_code_pins" ] || note "$standalone_code_pins"
  fail=1
else
  note "ok: active Fable and Opus configuration uses rolling aliases"
fi

canon="$repo/skills/poteto-mode/references/bugbot-triage.md"
skill="$repo/skills/babysit/SKILL.md"
playbook="$repo/skills/poteto-mode/playbooks/babysit.md"
bugbot_skill_rel="../poteto-mode/references/bugbot-triage.md"
bugbot_playbook_rel="../references/bugbot-triage.md"
bugbot_bad=""
if [ ! -f "$canon" ]; then
  bugbot_bad="${bugbot_bad}canonical rubric missing: $canon"$'\n'
fi
skill_op="$(grep -F 'Review-bot comments (Bugbot and similar automation):' "$skill" || true)"
skill_n="$(printf '%s\n' "$skill_op" | awk 'NF { c++ } END { print c+0 }')"
if [ "$skill_n" != "1" ]; then
  bugbot_bad="${bugbot_bad}standalone babysit skill lost bugbot-triage operational line"$'\n'
else
  skill_dest="$(printf '%s\n' "$skill_op" | sed -n 's/.*](\([^)]*\)).*/\1/p')"
  if [ "$skill_dest" != "$bugbot_skill_rel" ]; then
    bugbot_bad="${bugbot_bad}standalone babysit Markdown destination is [$skill_dest], not [$bugbot_skill_rel]"$'\n'
  fi
  if ! printf '%s\n' "$skill_op" | grep -Fq 'classify as fix, dismiss, or ask'; then
    bugbot_bad="${bugbot_bad}standalone babysit lost fix/dismiss/ask classification"$'\n'
  fi
  if ! printf '%s\n' "$skill_op" | grep -Fq "Follow the rubric's Ask by default categories, including security, data, and high-severity findings."; then
    bugbot_bad="${bugbot_bad}standalone babysit lost ask-by-default escalation"$'\n'
  fi
fi
playbook_op="$(grep -E '^8\. \*\*Bugbot is triaged skeptically, always\.\*\*' "$playbook" || true)"
playbook_n="$(printf '%s\n' "$playbook_op" | awk 'NF { c++ } END { print c+0 }')"
if [ "$playbook_n" != "1" ]; then
  bugbot_bad="${bugbot_bad}poteto-mode babysit playbook lost step-8 Bugbot operational line"$'\n'
elif ! printf '%s\n' "$playbook_op" | grep -Fq "$bugbot_playbook_rel"; then
  bugbot_bad="${bugbot_bad}poteto-mode babysit playbook step 8 lost bugbot-triage binding ($bugbot_playbook_rel)"$'\n'
fi
copies="$(find "$repo/skills" "$repo/agents" -name 'bugbot-triage.md' ! -path '*/node_modules/*' -print 2>/dev/null || true)"
n="$(printf '%s\n' "$copies" | awk 'NF { c++ } END { print c+0 }')"
if [ "$n" != "1" ]; then
  bugbot_bad="${bugbot_bad}expected exactly 1 bugbot-triage.md under the plugin, found $n"$'\n'
fi
if [ -n "$bugbot_bad" ]; then
  note "FAIL: babysit Bugbot binding on the packaged plugin"
  note "$bugbot_bad"
  fail=1
else
  note "ok: babysit Bugbot binding on the packaged plugin"
fi

# O playbook e a skill standalone têm de apontar um para o outro, senão um pedido
# de status de PR dentro do poteto-mode pode cair na skill e vice-versa.
supersede_bad=""
grep -Fq 'supersedes the standalone **babysit** skill' "$playbook" || supersede_bad="${supersede_bad}playbook does not claim precedence over the standalone skill"$'\n'
grep -Fq 'not the standalone **babysit** skill' "$repo/skills/poteto-mode/SKILL.md" || supersede_bad="${supersede_bad}poteto-mode trigger does not exclude the standalone skill"$'\n'
grep -Fq 'playbooks/babysit.md' "$skill" || supersede_bad="${supersede_bad}standalone skill does not defer to the playbook inside poteto-mode"$'\n'
if [ -n "$supersede_bad" ]; then
  note "FAIL: babysit skill/playbook precedence is not stated on both sides:"
  note "$supersede_bad"
  fail=1
else
  note "ok: babysit playbook supersedes the standalone skill and both say so"
fi

forge_neutral_files=(
  "$repo/skills/poteto-mode/playbooks/converge.md"
  "$repo/skills/poteto-mode/playbooks/shipping.md"
  "$repo/skills/poteto-mode/playbooks/babysit.md"
  "$repo/skills/poteto-mode/playbooks/autopilot-full.md"
  "$repo/skills/poteto-mode/playbooks/autopilot-stack.md"
  "$repo/skills/poteto-mode/playbooks/opening-a-pr.md"
  "$repo/skills/poteto-mode/playbooks/multi-phase-plan.md"
  "$repo/skills/poteto-mode/references/bugbot-triage.md"
)
graphite_commands="$(grep -En 'gt (submit|track|restack|sync|merge|ls)' "${forge_neutral_files[@]}" || true)"
if [ -n "$graphite_commands" ]; then
  note "FAIL: forge-neutral stack playbooks still name Graphite commands:"
  note "$graphite_commands"
  fail=1
else
  note "ok: forge-neutral stack playbooks name no Graphite command"
fi

excluded_bad=""
for excluded in "$repo/skills/make-bot-ui" "$repo/automations/benny" "$repo/docs/guide"; do
  if [ -e "$excluded" ]; then
    excluded_bad="${excluded_bad}${excluded}"$'\n'
  fi
done
if [ -n "$excluded_bad" ]; then
  note "FAIL: excluded Cursor-only content exists:"
  note "$excluded_bad"
  fail=1
else
  note "ok: excluded Cursor-only content stays absent"
fi

if [ "${PSTACK_BEHAVIORAL:-0}" != "1" ]; then
  exit "$fail"
fi

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/.claude-plugin" "$scratch/skills/foo"
printf '%s\n' '{"name": "testplug", "version": "0.0.1", "description": "native skill repro"}' \
  > "$scratch/.claude-plugin/plugin.json"
cat > "$scratch/skills/foo/SKILL.md" <<'SKILL'
---
name: foo
description: collision test skill
---

Say exactly: SKILL-RAN
Then stop. Do not invoke any skill or tool.
SKILL

model="${PSTACK_TEST_MODEL:-haiku}"
run() {
  claude -p --plugin-dir "$scratch" --model "$model" --max-turns 3 "$1" < /dev/null 2>&1
}

check() { # $1 label, $2 expected marker, $3 output
  if printf '%s' "$3" | grep -q "$2"; then
    note "ok: $1 -> $2"
  else
    note "FAIL: $1 expected $2, got: $3"
    fail=1
  fi
}

invoke='Call the Skill tool with skill "testplug:foo" exactly once and follow what it says.'

check "model-initiated Skill-tool invocation" "SKILL-RAN" "$(run "$invoke")"
check "user /testplug:foo invocation" "SKILL-RAN" "$(run '/testplug:foo')"

exit "$fail"

#!/bin/bash
# Mantém todos os usuários locais com o shell de gravação, menos os de emergência.
# Uso: tlog-record-all enable USUARIO... | sync | status | disable
set -euo pipefail

RECORDER=/usr/bin/tlog-rec-session
CONFIG_DIR=/etc/session-replay
EXCLUDED_FILE="$CONFIG_DIR/excluded-users"
STATE_DIR=/var/lib/session-replay
SAVED_SHELLS="$STATE_DIR/original-shells"
PATH_UNIT=tlog-record-all.path
SERVICE_UNIT=tlog-record-all.service

fail() { printf 'ERRO: %s\n' "$1" >&2; exit 1; }
need_root() { [ "$(id -u)" -eq 0 ] || fail 'Rode com sudo.'; }
login_defs() { awk -v key="$1" -v fallback="$2" '$1 == key { value = $2 } END { print value ? value : fallback }' /etc/login.defs; }
shell_of() { awk -F: -v user="$1" '$1 == user { print $7 }' /etc/passwd; }
is_excluded() { grep -qxF -- "$1" "$EXCLUDED_FILE"; }
can_login() { case "$1" in */nologin|*/false|*/sync|*/shutdown|*/halt) return 1 ;; *) return 0 ;; esac; }
has_saved_shell() { awk -F: -v user="$1" '$1 == user { found = 1 } END { exit !found }' "$SAVED_SHELLS"; }
is_admin() { id -nG "$1" | tr ' ' '\n' | grep -qxE 'sudo|wheel|root'; }

# Usuários comuns de /etc/passwd: nome e shell, um por linha.
regular_users() {
  awk -F: -v min="$(login_defs UID_MIN 1000)" -v max="$(login_defs UID_MAX 60000)" \
    '$3 >= min && $3 <= max { print $1 ":" $7 }' /etc/passwd
}

# useradd e adduser também travam /etc/passwd: uma colisão não pode fazer o usuário ficar sem gravação.
change_shell() {
  local attempt
  for attempt in 1 2 3 4 5; do
    usermod -s "$2" "$1" 2>/dev/null && return 0
    sleep 2
  done
  fail "Não foi possível mudar o shell de $1."
}

sync_users() {
  need_root
  [ -s "$EXCLUDED_FILE" ] || fail 'Nenhum usuário de emergência definido. Nada foi alterado.'
  [ -x "$RECORDER" ] || fail "$RECORDER não encontrado. Nada foi alterado."
  install -d -m 700 "$STATE_DIR"
  touch "$SAVED_SHELLS"
  chmod 600 "$SAVED_SHELLS"
  local user shell
  while IFS=: read -r user shell; do
    is_excluded "$user" && continue
    [ "$shell" = "$RECORDER" ] && continue
    can_login "$shell" || continue
    has_saved_shell "$user" || printf '%s:%s\n' "$user" "${shell:-/bin/sh}" >> "$SAVED_SHELLS"
    change_shell "$user" "$RECORDER"
    logger -t tlog-record-all "Gravação ativada para o usuário $user" 2>/dev/null || true
    printf 'Gravação ativada: %s\n' "$user"
  done < <(regular_users)
}

enable_all() {
  need_root
  [ "$#" -gt 0 ] || fail 'Informe ao menos um usuário de emergência, que continuará sem gravação.'
  local user usable=0
  for user in "$@"; do
    [ -n "$(shell_of "$user")" ] || fail "O usuário de emergência $user não existe nesta máquina. Crie-o antes."
    [ "$(shell_of "$user")" != "$RECORDER" ] || fail "O usuário $user já é gravado. Volte o shell dele antes de usá-lo como emergência."
    if is_admin "$user" && [ "$(passwd -S "$user" | awk '{print $2}')" = 'P' ]; then usable=1; fi
  done
  [ "$usable" -eq 1 ] || fail 'Ao menos um usuário de emergência precisa ter senha e estar no grupo sudo, ou ninguém conseguiria desfazer isto.'
  # A lista diz quais contas não são gravadas: não interessa aos usuários da máquina.
  install -d -m 700 "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"
  printf '%s\n' "$@" > "$EXCLUDED_FILE"
  chmod 600 "$EXCLUDED_FILE"
  sync_users
  systemctl enable --now "$PATH_UNIT" >/dev/null 2>&1
  systemctl enable "$SERVICE_UNIT" >/dev/null 2>&1
  echo 'Pronto. Usuários locais criados daqui em diante também serão gravados.'
}

show_status() {
  need_root
  printf 'Gravar todos: %s\n' "$(systemctl is-active "$PATH_UNIT" 2>/dev/null || true)"
  local user shell
  # Fora da faixa de usuários comuns, mas com shell: o login direto delas não é gravado.
  while IFS=: read -r user shell; do
    if can_login "$shell"; then printf 'FORA DA GRAVAÇÃO (conta de sistema)   %s\n' "$user"; fi
  done < <(awk -F: -v min="$(login_defs UID_MIN 1000)" -v max="$(login_defs UID_MAX 60000)" \
    '$3 < min || $3 > max { print $1 ":" $7 }' /etc/passwd)
  while IFS=: read -r user shell; do
    if [ "$shell" = "$RECORDER" ]; then printf 'gravado        %s\n' "$user"
    elif [ -r "$EXCLUDED_FILE" ] && is_excluded "$user"; then printf 'emergência     %s\n' "$user"
    elif can_login "$shell"; then printf 'SEM GRAVAÇÃO   %s\n' "$user"
    else printf 'sem login      %s\n' "$user"
    fi
  done < <(regular_users)
}

disable_all() {
  need_root
  systemctl disable --now "$PATH_UNIT" >/dev/null 2>&1 || true
  systemctl disable "$SERVICE_UNIT" >/dev/null 2>&1 || true
  local user shell
  if [ -r "$SAVED_SHELLS" ]; then
    while IFS=: read -r user shell; do
      [ "$(shell_of "$user")" = "$RECORDER" ] || continue
      change_shell "$user" "$shell"
      printf 'Shell restaurado: %s (%s)\n' "$user" "$shell"
    done < "$SAVED_SHELLS"
  fi
  rm -f "$SAVED_SHELLS" "$EXCLUDED_FILE"
  echo 'Gravação de todos desligada.'
}

case "${1:-}" in
  enable) shift; enable_all "$@" ;;
  sync) sync_users ;;
  status) show_status ;;
  disable) disable_all ;;
  *) fail 'Uso: tlog-record-all enable USUARIO... | sync | status | disable' ;;
esac

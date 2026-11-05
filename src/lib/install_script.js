'use strict';

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252}[A-Za-z0-9])?$/;
const IP = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$|^(?=.*:)[0-9A-Fa-f:]{2,39}$/;
// Mudar só se o Fluent Bit trocar a chave: confira em docs.fluentbit.io.
const FLUENT_KEY_FINGERPRINT = 'C3C0A28534B9293EAF51FABD9F9DDC083888C1CD';
const USER = /^[A-Za-z0-9._-]{1,64}$/;
const PEM = /^(-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE-----\n?)+$/;
const LOGIN = /^[a-z_][a-z0-9_-]{0,31}$/;
const SHELL_PATH = /^\/[A-Za-z0-9._/-]{1,100}$/;
const END_OF_FILE = 'TLOG_REPLAY_FIM_DO_ARQUIVO';

/** O script roda como root: nada do formulário entra nele sem passar por aqui. */
function validateInstallInput({ indexerName, indexerIp, writerUser, caPem }) {
  const errors = {};
  if (!NAME.test(indexerName ?? '')) errors.indexerName = 'Use o nome que consta no certificado do indexador, como wazuh.indexer.';
  if (indexerIp && !IP.test(indexerIp)) errors.indexerIp = 'Use um endereço IP, ou deixe em branco.';
  if (!USER.test(writerUser ?? '')) errors.writerUser = 'Use só letras, números, ponto, hífen e sublinhado.';
  if (!PEM.test((caPem ?? '').replace(/\r\n/g, '\n').trim())) errors.caPem = 'Cole o certificado da CA, em formato PEM.';
  return errors;
}

const validLogin = (value) => LOGIN.test(value ?? '');
const validShell = (value) => SHELL_PATH.test(value ?? '');

const writeFile = (path, content, mode) =>
  `install -d "$(dirname '${path}')"\ncat > '${path}' <<'${END_OF_FILE}'\n${content.replace(/\n*$/, '')}\n${END_OF_FILE}\nchmod ${mode} '${path}'\n`;

/** Script completo e autossuficiente. Não contém senha: ela é pedida ao rodar. */
function buildInstallScript({ indexerName, indexerIp = '', writerUser, caPem, files, version }) {
  const errors = validateInstallInput({ indexerName, indexerIp, writerUser, caPem });
  if (Object.keys(errors).length > 0) throw new Error(Object.values(errors).join(' '));
  for (const content of [...Object.values(files), caPem]) {
    if (content.includes(END_OF_FILE)) throw new Error('Arquivo inválido.');
  }
  const ca = caPem.replace(/\r\n/g, '\n').trim();
  return `#!/bin/bash
# Session Replay ${version}: instala o tlog e o Fluent Bit nesta máquina.
# Gerado pelo plugin. Não contém senhas e não ativa a gravação de nenhum usuário.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

INDEXER_NAME='${indexerName}'
INDEXER_IP='${indexerIp}'
WRITER_USER='${writerUser}'

step() { printf '\\n== %s\\n' "$1"; }
fail() { printf '\\nERRO: %s\\n' "$1" >&2; exit 1; }
trap 'printf "\\nERRO: falha inesperada na linha %s do script. Corrija a causa e rode de novo.\\n" "$LINENO" >&2' ERR

[ "$(id -u)" -eq 0 ] || fail 'Rode com sudo.'
command -v apt-get >/dev/null || fail 'Este script só atende sistemas com apt. Veja a instalação manual na documentação do projeto.'
command -v systemctl >/dev/null || fail 'Este script precisa do systemd.'
. /etc/os-release
case "\${ID}:\${VERSION_CODENAME:-}" in
  ubuntu:noble|ubuntu:jammy) FLUENT_PATH="ubuntu/\${VERSION_CODENAME}"; FLUENT_CODENAME="\${VERSION_CODENAME}" ;;
  debian:bookworm|debian:trixie) FLUENT_PATH="debian/\${VERSION_CODENAME}"; FLUENT_CODENAME="\${VERSION_CODENAME}" ;;
  # O Kali segue o Debian testing, e o Fluent Bit não publica pacotes para ele.
  kali:*) FLUENT_PATH='debian/trixie'; FLUENT_CODENAME='trixie' ;;
  *) fail "Sistema sem suporte neste script: \${ID} \${VERSION_CODENAME:-}. Veja a instalação manual na documentação do projeto." ;;
esac

printf 'Senha do usuário %s no indexador: ' "$WRITER_USER" >&2
IFS= read -rs WRITER_PASSWORD
printf '\\n' >&2
[ -n "$WRITER_PASSWORD" ] || fail 'Senha vazia.'
case "$WRITER_PASSWORD" in
  *\\'*|*\\\\*) fail 'A senha não pode ter aspas simples nem barra invertida.' ;;
esac

step 'Dependências'
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg logrotate >/dev/null

step 'Conexão com o indexador'
if [ -n "$INDEXER_IP" ]; then
  { grep -v ' # session-replay$' /etc/hosts || true; printf '%s %s # session-replay\\n' "$INDEXER_IP" "$INDEXER_NAME"; } > /etc/hosts.session-replay
  cat /etc/hosts.session-replay > /etc/hosts
  rm -f /etc/hosts.session-replay
fi
${writeFile('/etc/fluent-bit/root-ca.pem', ca, '644')}
# A senha vai pela entrada padrão: na linha de comando, apareceria na lista de processos.
ESCAPED_PASSWORD=$(printf '%s' "$WRITER_PASSWORD" | sed 's/"/\\\\"/g')
STATUS=$(printf 'user = "%s:%s"\\n' "$WRITER_USER" "$ESCAPED_PASSWORD" | curl --config - --silent --output /dev/null --max-time 15 --write-out '%{http_code}' --cacert /etc/fluent-bit/root-ca.pem "https://\${INDEXER_NAME}:9200/" || true)
case "$STATUS" in
  200|403) echo "Indexador respondeu (HTTP $STATUS)." ;;
  401) fail 'Usuário ou senha recusados pelo indexador.' ;;
  *) fail "Não foi possível conectar a https://\${INDEXER_NAME}:9200 (HTTP \${STATUS:-000}). Confira o nome, o IP, a porta 9200 e a CA." ;;
esac

step 'tlog'
apt-get install -y -qq tlog >/dev/null
TLOG_USER=$( { getent passwd _tlog tlog || true; } | head -1 | cut -d: -f1)
if [ -z "$TLOG_USER" ]; then
  useradd --system --no-create-home --shell /usr/sbin/nologin _tlog
  TLOG_USER=_tlog
fi
# Sem o setuid, o usuário gravado conseguiria ler e apagar o próprio log.
chown "$TLOG_USER:$TLOG_USER" /usr/bin/tlog-rec-session
chmod 6755 /usr/bin/tlog-rec-session
# Uma atualização do pacote desfaria isso, e os usuários gravados deixariam de conseguir entrar.
dpkg-statoverride --remove /usr/bin/tlog-rec-session >/dev/null 2>&1 || true
dpkg-statoverride --add "$TLOG_USER" "$TLOG_USER" 6755 /usr/bin/tlog-rec-session
${writeFile('/etc/tlog/tlog-rec-session.conf', files.tlogConf, '644')}
install -d -o "$TLOG_USER" -g "$TLOG_USER" -m 750 /var/log/tlog
[ -e /var/log/tlog/tlog.log ] || install -o "$TLOG_USER" -g "$TLOG_USER" -m 600 /dev/null /var/log/tlog/tlog.log
[ ! -e /usr/lib/tmpfiles.d/tlog.conf ] || systemd-tmpfiles --create /usr/lib/tmpfiles.d/tlog.conf
grep -qx /usr/bin/tlog-rec-session /etc/shells || echo /usr/bin/tlog-rec-session >> /etc/shells

step 'Rotação do log'
${writeFile('/etc/tlog/logrotate.conf', files.logrotateConf, '644')}
sed -i "s/su _tlog _tlog/su $TLOG_USER $TLOG_USER/" /etc/tlog/logrotate.conf
${writeFile('/etc/systemd/system/tlog-logrotate.service', files.logrotateService, '644')}
${writeFile('/etc/systemd/system/tlog-logrotate.timer', files.logrotateTimer, '644')}
install -d /var/lib/logrotate
systemctl daemon-reload
systemctl enable --now tlog-logrotate.timer >/dev/null 2>&1

step 'Opção de gravar todos os usuários (fica desligada)'
${writeFile('/usr/local/sbin/tlog-record-all', files.recordAllScript, '755')}
${writeFile('/etc/systemd/system/tlog-record-all.service', files.recordAllService, '644')}
${writeFile('/etc/systemd/system/tlog-record-all.path', files.recordAllPath, '644')}
systemctl daemon-reload

step 'Fluent Bit'
# A chave define em quais pacotes este sistema confia como root: confere antes de aceitá-la.
FLUENT_KEY=$(mktemp)
curl -fsS https://packages.fluentbit.io/fluentbit.key -o "$FLUENT_KEY"
FLUENT_KEY_FOUND=$(gpg --batch --show-keys --with-colons "$FLUENT_KEY" 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }')
[ "$FLUENT_KEY_FOUND" = '${FLUENT_KEY_FINGERPRINT}' ] || { rm -f "$FLUENT_KEY"; fail "A chave do repositório do Fluent Bit não é a esperada ($FLUENT_KEY_FOUND). Nada foi instalado dele. Confira em docs.fluentbit.io antes de continuar."; }
gpg --batch --yes --dearmor -o /usr/share/keyrings/fluentbit.gpg "$FLUENT_KEY"
rm -f "$FLUENT_KEY"
echo "deb [signed-by=/usr/share/keyrings/fluentbit.gpg] https://packages.fluentbit.io/\${FLUENT_PATH} \${FLUENT_CODENAME} main" > /etc/apt/sources.list.d/fluent-bit.list
apt-get update -qq
apt-get install -y -qq fluent-bit >/dev/null
[ ! -e /etc/fluent-bit/fluent-bit.conf ] || cp -n /etc/fluent-bit/fluent-bit.conf /etc/fluent-bit/fluent-bit.conf.antes-do-session-replay
${writeFile('/etc/fluent-bit/fluent-bit.conf', files.fluentConf, '644')}
install -d -m 750 /var/lib/fluent-bit
# Primeiro a permissão: um arquivo que já existisse aberto continuaria aberto com a senha nova.
install -o root -g root -m 600 /dev/null /etc/fluent-bit/tlog.env
printf "WAZUH_INDEXER_HOST=%s\\nTLOG_WRITER_USER=%s\\nTLOG_WRITER_PASSWORD='%s'\\n" "$INDEXER_NAME" "$WRITER_USER" "$WRITER_PASSWORD" > /etc/fluent-bit/tlog.env
unset WRITER_PASSWORD ESCAPED_PASSWORD
install -d /etc/systemd/system/fluent-bit.service.d
printf '[Service]\\nEnvironmentFile=/etc/fluent-bit/tlog.env\\n' > /etc/systemd/system/fluent-bit.service.d/tlog.conf
systemctl daemon-reload
systemctl enable fluent-bit >/dev/null 2>&1
systemctl restart fluent-bit

step 'Agente do Wazuh'
# As sessões vão só pelo Fluent Bit: pelo agente, o conteúdo delas chegaria também aos alertas.
if grep -qs '/var/log/tlog/tlog.log' /var/ossec/etc/ossec.conf; then
  echo 'ATENÇÃO: o agente lê o log do tlog, o que envia o conteúdo das sessões ao manager. Remova esse <localfile> do /var/ossec/etc/ossec.conf.'
elif [ -f /var/ossec/etc/ossec.conf ]; then
  echo 'Agente encontrado: os alertas de login e sudo continuam ligados às sessões.'
else
  echo 'Agente do Wazuh não encontrado: as sessões serão gravadas, mas sem os alertas de login e sudo.'
fi

step 'Resultado'
sleep 6
systemctl is-active --quiet fluent-bit || { journalctl -u fluent-bit -n 20 --no-pager || true; fail 'O Fluent Bit não ficou ativo.'; }
if journalctl -u fluent-bit -n 50 --no-pager 2>/dev/null | grep -qE 'HTTP status=40[13]|certificate verify failed'; then
  journalctl -u fluent-bit -n 20 --no-pager || true
  fail 'O Fluent Bit não conseguiu enviar ao indexador.'
fi
echo 'Instalação concluída. Nenhum usuário está sendo gravado ainda: siga o próximo passo na página.'
`;
}

module.exports = { END_OF_FILE, FLUENT_KEY_FINGERPRINT, buildInstallScript, validLogin, validShell, validateInstallInput };

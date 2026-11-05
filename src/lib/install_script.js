'use strict';

const { getLocale, t } = require('./i18n');
const recordAllEnglish = require('./messages/record_all_en');

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
  if (!NAME.test(indexerName ?? '')) errors.indexerName = t('script.valid.name');
  if (indexerIp && !IP.test(indexerIp)) errors.indexerIp = t('script.valid.ip');
  if (!USER.test(writerUser ?? '')) errors.writerUser = t('script.valid.user');
  if (!PEM.test((caPem ?? '').replace(/\r\n/g, '\n').trim())) errors.caPem = t('script.valid.ca');
  return errors;
}

const validLogin = (value) => LOGIN.test(value ?? '');
const validShell = (value) => SHELL_PATH.test(value ?? '');

const writeFile = (path, content, mode) =>
  `install -d "$(dirname '${path}')"\ncat > '${path}' <<'${END_OF_FILE}'\n${content.replace(/\n*$/, '')}\n${END_OF_FILE}\nchmod ${mode} '${path}'\n`;

/** O comando instalado responde no idioma de quem gerou o script. */
const localizedRecordAll = (script) =>
  getLocale() === 'en' ? recordAllEnglish.reduce((text, [source, translated]) => text.split(source).join(translated), script) : script;

/** Script completo e autossuficiente. Não contém senha: ela é pedida ao rodar. */
function buildInstallScript({ indexerName, indexerIp = '', writerUser, caPem, files, version }) {
  const errors = validateInstallInput({ indexerName, indexerIp, writerUser, caPem });
  if (Object.keys(errors).length > 0) throw new Error(Object.values(errors).join(' '));
  for (const content of [...Object.values(files), caPem]) {
    if (content.includes(END_OF_FILE)) throw new Error(t('script.invalidFile'));
  }
  const ca = caPem.replace(/\r\n/g, '\n').trim();
  return `#!/bin/bash
# ${t('script.header', { version })}
# ${t('script.header2')}
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

INDEXER_NAME='${indexerName}'
INDEXER_IP='${indexerIp}'
WRITER_USER='${writerUser}'

step() { printf '\\n== %s\\n' "$1"; }
fail() { printf '\\n${t('script.error')}: %s\\n' "$1" >&2; exit 1; }
trap 'printf "\\n${t('script.error')}: ${t('script.unexpected')}\\n" "$LINENO" >&2' ERR

[ "$(id -u)" -eq 0 ] || fail '${t('script.useSudo')}'
command -v apt-get >/dev/null || fail '${t('script.needApt')}'
command -v systemctl >/dev/null || fail '${t('script.needSystemd')}'
. /etc/os-release
case "\${ID}:\${VERSION_CODENAME:-}" in
  ubuntu:noble|ubuntu:jammy) FLUENT_PATH="ubuntu/\${VERSION_CODENAME}"; FLUENT_CODENAME="\${VERSION_CODENAME}" ;;
  debian:bookworm|debian:trixie) FLUENT_PATH="debian/\${VERSION_CODENAME}"; FLUENT_CODENAME="\${VERSION_CODENAME}" ;;
  # ${t('script.comment.kali')}
  kali:*) FLUENT_PATH='debian/trixie'; FLUENT_CODENAME='trixie' ;;
  *) fail "${t('script.unsupported')}" ;;
esac

printf '${t('script.askPassword')}' "$WRITER_USER" >&2
IFS= read -rs WRITER_PASSWORD
printf '\\n' >&2
[ -n "$WRITER_PASSWORD" ] || fail '${t('script.emptyPassword')}'
case "$WRITER_PASSWORD" in
  *\\'*|*\\\\*) fail '${t('script.badPassword')}' ;;
esac

step '${t('script.step.deps')}'
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg logrotate >/dev/null

step '${t('script.step.connection')}'
if [ -n "$INDEXER_IP" ]; then
  { grep -v ' # session-replay$' /etc/hosts || true; printf '%s %s # session-replay\\n' "$INDEXER_IP" "$INDEXER_NAME"; } > /etc/hosts.session-replay
  cat /etc/hosts.session-replay > /etc/hosts
  rm -f /etc/hosts.session-replay
fi
${writeFile('/etc/fluent-bit/root-ca.pem', ca, '644')}
# ${t('script.comment.stdin')}
ESCAPED_PASSWORD=$(printf '%s' "$WRITER_PASSWORD" | sed 's/"/\\\\"/g')
STATUS=$(printf 'user = "%s:%s"\\n' "$WRITER_USER" "$ESCAPED_PASSWORD" | curl --config - --silent --output /dev/null --max-time 15 --write-out '%{http_code}' --cacert /etc/fluent-bit/root-ca.pem "https://\${INDEXER_NAME}:9200/" || true)
case "$STATUS" in
  200|403) echo "${t('script.indexerOk')}" ;;
  401) fail '${t('script.badCredentials')}' ;;
  *) fail "${t('script.noConnection')}" ;;
esac

step 'tlog'
apt-get install -y -qq tlog >/dev/null
TLOG_USER=$( { getent passwd _tlog tlog || true; } | head -1 | cut -d: -f1)
if [ -z "$TLOG_USER" ]; then
  useradd --system --no-create-home --shell /usr/sbin/nologin _tlog
  TLOG_USER=_tlog
fi
# ${t('script.comment.setuid')}
chown "$TLOG_USER:$TLOG_USER" /usr/bin/tlog-rec-session
chmod 6755 /usr/bin/tlog-rec-session
# ${t('script.comment.statoverride')}
dpkg-statoverride --remove /usr/bin/tlog-rec-session >/dev/null 2>&1 || true
dpkg-statoverride --add "$TLOG_USER" "$TLOG_USER" 6755 /usr/bin/tlog-rec-session
${writeFile('/etc/tlog/tlog-rec-session.conf', files.tlogConf, '644')}
install -d -o "$TLOG_USER" -g "$TLOG_USER" -m 750 /var/log/tlog
[ -e /var/log/tlog/tlog.log ] || install -o "$TLOG_USER" -g "$TLOG_USER" -m 600 /dev/null /var/log/tlog/tlog.log
[ ! -e /usr/lib/tmpfiles.d/tlog.conf ] || systemd-tmpfiles --create /usr/lib/tmpfiles.d/tlog.conf
grep -qx /usr/bin/tlog-rec-session /etc/shells || echo /usr/bin/tlog-rec-session >> /etc/shells

step '${t('script.step.rotation')}'
${writeFile('/etc/tlog/logrotate.conf', files.logrotateConf, '644')}
sed -i "s/su _tlog _tlog/su $TLOG_USER $TLOG_USER/" /etc/tlog/logrotate.conf
${writeFile('/etc/systemd/system/tlog-logrotate.service', files.logrotateService, '644')}
${writeFile('/etc/systemd/system/tlog-logrotate.timer', files.logrotateTimer, '644')}
install -d /var/lib/logrotate
systemctl daemon-reload
systemctl enable --now tlog-logrotate.timer >/dev/null 2>&1

step '${t('script.step.recordAll')}'
${writeFile('/usr/local/sbin/tlog-record-all', localizedRecordAll(files.recordAllScript), '755')}
${writeFile('/etc/systemd/system/tlog-record-all.service', files.recordAllService, '644')}
${writeFile('/etc/systemd/system/tlog-record-all.path', files.recordAllPath, '644')}
systemctl daemon-reload

step 'Fluent Bit'
# ${t('script.comment.key')}
FLUENT_KEY=$(mktemp)
curl -fsS https://packages.fluentbit.io/fluentbit.key -o "$FLUENT_KEY"
FLUENT_KEY_FOUND=$(gpg --batch --show-keys --with-colons "$FLUENT_KEY" 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }')
[ "$FLUENT_KEY_FOUND" = '${FLUENT_KEY_FINGERPRINT}' ] || { rm -f "$FLUENT_KEY"; fail "${t('script.badKey')}"; }
gpg --batch --yes --dearmor -o /usr/share/keyrings/fluentbit.gpg "$FLUENT_KEY"
rm -f "$FLUENT_KEY"
echo "deb [signed-by=/usr/share/keyrings/fluentbit.gpg] https://packages.fluentbit.io/\${FLUENT_PATH} \${FLUENT_CODENAME} main" > /etc/apt/sources.list.d/fluent-bit.list
apt-get update -qq
apt-get install -y -qq fluent-bit >/dev/null
[ ! -e /etc/fluent-bit/fluent-bit.conf ] || cp -n /etc/fluent-bit/fluent-bit.conf /etc/fluent-bit/fluent-bit.conf.antes-do-session-replay
${writeFile('/etc/fluent-bit/fluent-bit.conf', files.fluentConf, '644')}
install -d -m 750 /var/lib/fluent-bit
# ${t('script.comment.permission')}
install -o root -g root -m 600 /dev/null /etc/fluent-bit/tlog.env
printf "WAZUH_INDEXER_HOST=%s\\nTLOG_WRITER_USER=%s\\nTLOG_WRITER_PASSWORD='%s'\\n" "$INDEXER_NAME" "$WRITER_USER" "$WRITER_PASSWORD" > /etc/fluent-bit/tlog.env
unset WRITER_PASSWORD ESCAPED_PASSWORD
install -d /etc/systemd/system/fluent-bit.service.d
printf '[Service]\\nEnvironmentFile=/etc/fluent-bit/tlog.env\\n' > /etc/systemd/system/fluent-bit.service.d/tlog.conf
systemctl daemon-reload
systemctl enable fluent-bit >/dev/null 2>&1
systemctl restart fluent-bit

step '${t('script.step.agent')}'
# ${t('script.comment.agent')}
if grep -qs '/var/log/tlog/tlog.log' /var/ossec/etc/ossec.conf; then
  echo '${t('script.agentReadsLog')}'
elif [ -f /var/ossec/etc/ossec.conf ]; then
  echo '${t('script.agentFound')}'
else
  echo '${t('script.agentMissing')}'
fi

step '${t('script.step.result')}'
sleep 6
systemctl is-active --quiet fluent-bit || { journalctl -u fluent-bit -n 20 --no-pager || true; fail '${t('script.fluentInactive')}'; }
if journalctl -u fluent-bit -n 50 --no-pager 2>/dev/null | grep -qE 'HTTP status=40[13]|certificate verify failed'; then
  journalctl -u fluent-bit -n 20 --no-pager || true
  fail '${t('script.fluentCannotSend')}'
fi
echo '${t('script.done')}'
`;
}

module.exports = { END_OF_FILE, localizedRecordAll, FLUENT_KEY_FINGERPRINT, buildInstallScript, validLogin, validShell, validateInstallInput };

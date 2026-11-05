#!/bin/bash
# Prepara a máquina de teste. Roda dentro do contêiner, como root.
# Variáveis: TESTE_PASSWORD, TLOG_WRITER_USER, TLOG_WRITER_PASSWORD, WAZUH_MANAGER, WAZUH_INDEXER_HOST.
# /collector tem as configurações do projeto; /certs/root-ca.pem é a CA do indexador.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "== tlog"
apt-get install -y -qq tlog >/dev/null
# No Ubuntu o usuário se chama _tlog (no Fedora, tlog). É o dono de /run/tlog, usado nos locks.
id _tlog >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin _tlog
# O pacote do Ubuntu não ativa o setuid que protege o log contra o usuário gravado.
chown _tlog:_tlog /usr/bin/tlog-rec-session
chmod 6755 /usr/bin/tlog-rec-session
dpkg-statoverride --remove /usr/bin/tlog-rec-session >/dev/null 2>&1 || true
dpkg-statoverride --add _tlog _tlog 6755 /usr/bin/tlog-rec-session
cp /collector/tlog-rec-session.conf /etc/tlog/tlog-rec-session.conf
install -d -o _tlog -g _tlog -m 750 /var/log/tlog
# Criar o arquivo antes evita erro no agente e a espera de ~60 s do Fluent Bit no primeiro login.
install -o _tlog -g _tlog -m 600 /dev/null /var/log/tlog/tlog.log
systemd-tmpfiles --create /usr/lib/tmpfiles.d/tlog.conf
grep -qx /usr/bin/tlog-rec-session /etc/shells || echo /usr/bin/tlog-rec-session >> /etc/shells

echo "== rotação do log"
apt-get install -y -qq logrotate >/dev/null
cp /collector/tlog-logrotate.conf /etc/tlog/logrotate.conf
cp /collector/tlog-logrotate.service /collector/tlog-logrotate.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now tlog-logrotate.timer >/dev/null 2>&1

echo "== usuário gravado"
id teste >/dev/null 2>&1 || useradd -m -s /usr/bin/tlog-rec-session -G sudo teste
echo "teste:${TESTE_PASSWORD}" | chpasswd
printf 'PasswordAuthentication yes\n' > /etc/ssh/sshd_config.d/50-teste.conf
systemctl restart ssh

echo "== agente Wazuh"
curl -fsS https://packages.wazuh.com/key/GPG-KEY-WAZUH \
  | gpg --batch --yes --no-default-keyring --keyring gnupg-ring:/usr/share/keyrings/wazuh.gpg --import 2>/dev/null
chmod 644 /usr/share/keyrings/wazuh.gpg
echo 'deb [signed-by=/usr/share/keyrings/wazuh.gpg] https://packages.wazuh.com/4.x/apt/ stable main' \
  > /etc/apt/sources.list.d/wazuh.list
apt-get update -qq >/dev/null
WAZUH_MANAGER="$WAZUH_MANAGER" WAZUH_AGENT_NAME=ubuntu-teste apt-get install -y -qq wazuh-agent=4.14.9-1 >/dev/null
systemctl enable --now wazuh-agent >/dev/null 2>&1
systemctl restart wazuh-agent

echo "== Fluent Bit"
curl -fsS https://packages.fluentbit.io/fluentbit.key | gpg --batch --yes --dearmor -o /usr/share/keyrings/fluentbit.gpg
echo 'deb [signed-by=/usr/share/keyrings/fluentbit.gpg] https://packages.fluentbit.io/ubuntu/noble noble main' \
  > /etc/apt/sources.list.d/fluent-bit.list
apt-get update -qq >/dev/null
apt-get install -y -qq fluent-bit >/dev/null
cp /collector/fluent-bit.conf /etc/fluent-bit/fluent-bit.conf
install -m 644 /certs/root-ca.pem /etc/fluent-bit/root-ca.pem
install -d -m 750 /var/lib/fluent-bit
install -m 600 /dev/null /etc/fluent-bit/tlog.env
{
  echo "WAZUH_INDEXER_HOST=$WAZUH_INDEXER_HOST"
  echo "TLOG_WRITER_USER=$TLOG_WRITER_USER"
  echo "TLOG_WRITER_PASSWORD=$TLOG_WRITER_PASSWORD"
} > /etc/fluent-bit/tlog.env
mkdir -p /etc/systemd/system/fluent-bit.service.d
printf '[Service]\nEnvironmentFile=/etc/fluent-bit/tlog.env\n' > /etc/systemd/system/fluent-bit.service.d/tlog.conf
systemctl daemon-reload
systemctl enable --now fluent-bit >/dev/null 2>&1
systemctl restart fluent-bit

echo "== estado"
systemctl is-active ssh wazuh-agent fluent-bit
systemctl show fluent-bit -p User -p ExecStart --value | cut -c1-120
dpkg -l tlog wazuh-agent fluent-bit | awk '/^ii/{print $2, $3}'
ls -l /usr/bin/tlog-rec-session

# Máquina Ubuntu de TESTE, com systemd e SSH. Não use em produção.
FROM ubuntu:24.04
ENV container=docker LANG=C.UTF-8 LC_ALL=C.UTF-8
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends \
      systemd systemd-sysv dbus openssh-server sudo curl ca-certificates gnupg \
      iproute2 procps nano less
RUN printf '[Service]\nExecStartPre=/usr/bin/mkdir -p /run/sshd\n' > /tmp/x \
 && mkdir -p /etc/systemd/system/ssh.service.d && mv /tmp/x /etc/systemd/system/ssh.service.d/run.conf \
 && echo 'LANG=C.UTF-8' > /etc/default/locale \
 && systemctl enable ssh
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]

# Manual installation on a recorded host

[Português](../instalacao-manual.md)

The plugin's **Install** tab does these steps on Ubuntu, Debian and Kali, except for the server preparation described in the [installation](installation.md). The steps below are for other distributions and for checking what the script does.

These steps were tested on Ubuntu 24.04. On other distributions, the names change; see the [official Fluent Bit installation](https://docs.fluentbit.io/manual/installation/getting-started-with-fluent-bit). The [test-env/provision.sh](../../test-env/provision.sh) script brings these steps together.

## Install and prepare tlog

```bash
sudo apt-get install -y tlog
```

The Ubuntu package does not enable setuid, and its user is named `_tlog` (`tlog` on Fedora). Adjust the binary and create the log before the first login, which avoids an agent error and Fluent Bit's wait of about 60 s:

```bash
sudo chown _tlog:_tlog /usr/bin/tlog-rec-session && sudo chmod 6755 /usr/bin/tlog-rec-session
```

Register this change with `dpkg`. Without it, the next package update undoes it, and recorded users can no longer log in:

```bash
sudo dpkg-statoverride --add _tlog _tlog 6755 /usr/bin/tlog-rec-session
```

```bash
sudo install -d -o _tlog -g _tlog -m 750 /var/log/tlog && sudo install -o _tlog -g _tlog -m 600 /dev/null /var/log/tlog/tlog.log
```

Copy `collector/tlog-rec-session.conf` to `/etc/tlog/tlog-rec-session.conf` and choose how to enable recording:
- **By group, with SSSD:** copy `collector/sssd-session-recording.conf` to `/etc/sssd/conf.d/`, with mode `600`. Tested on Fedora.
- **By user:** set the user's login shell to the recorder. Tested on Ubuntu:

```bash
sudo usermod -s /usr/bin/tlog-rec-session USER
```

Keep an unrecorded administrative account until you confirm the login, because a shell error can prevent access.

## Install Fluent Bit

Download the repository key and check that its fingerprint is `C3C0 A285 34B9 293E AF51 FABD 9F9D DC08 3888 C1CD`, the one published in the [Fluent Bit documentation](https://docs.fluentbit.io/manual/installation/downloads/linux). Only continue if it matches:

```bash
curl -fsS https://packages.fluentbit.io/fluentbit.key -o fluentbit.key && gpg --show-keys --fingerprint fluentbit.key
```

```bash
sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/fluentbit.gpg fluentbit.key
```

```bash
echo 'deb [signed-by=/usr/share/keyrings/fluentbit.gpg] https://packages.fluentbit.io/ubuntu/noble noble main' | sudo tee /etc/apt/sources.list.d/fluent-bit.list
```

```bash
sudo apt-get update && sudo apt-get install -y fluent-bit
```

## Configure Fluent Bit

1. Copy `collector/fluent-bit.conf` to `/etc/fluent-bit/fluent-bit.conf`.
2. Copy the indexer CA to `/etc/fluent-bit/root-ca.pem`.
3. Create `/etc/fluent-bit/tlog.env`, owned by root with mode `600`, using the writer user created in [Prepare the indexer](installation.md#2-prepare-the-indexer):

```ini
WAZUH_INDEXER_HOST=indexer-address
TLOG_WRITER_USER=tlog_writer
TLOG_WRITER_PASSWORD=user-password
```

4. Create `/etc/systemd/system/fluent-bit.service.d/tlog.conf` so the service reads that file:

```ini
[Service]
EnvironmentFile=/etc/fluent-bit/tlog.env
```

5. Create the state directory and start the service:

```bash
sudo install -d -m 750 /var/lib/fluent-bit && sudo systemctl daemon-reload && sudo systemctl enable --now fluent-bit
```

The name in `WAZUH_INDEXER_HOST` must be in the indexer certificate, because the configuration validates TLS. The service runs as root, which lets it read `tlog.log`, created with mode `600`.

## Configure the alerts

Copy the rules to the manager, as described in the [installation](installation.md#4-configure-the-manager-rules).

## Limit disk usage

tlog does not delete or rotate its own log. **When the disk is full, it interrupts the recorded session** (`Failed logging terminal data`), so the limit is also needed to keep access to the hosts.

Install logrotate and enable the rotation, which checks the log every 5 minutes:

```bash
sudo apt-get install -y logrotate
```

```bash
sudo cp collector/tlog-logrotate.conf /etc/tlog/logrotate.conf
```

```bash
sudo cp collector/tlog-logrotate.service collector/tlog-logrotate.timer /etc/systemd/system/
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now tlog-logrotate.timer
```

| Limit | Value | Where to change it |
|---|---|---|
| `tlog.log` rotation | Hourly or above 100 MB, with 3 old compressed files | `collector/tlog-logrotate.conf` |
| Recording rate | About 16 KiB/s per session, with `delay` | `limit` in `collector/tlog-rec-session.conf` |
| Fluent Bit buffer | 500 MB | `storage.total_limit_size` in `collector/fluent-bit.conf` |
| Indices on the Wazuh indexer | 90 days | `collector/ism-policy.json` |

How these limits affect usage:
- **Disk needed:** reserve at least 1 GB for `/var/log/tlog` and another 500 MB for `/var/lib/fluent-bit`. A dedicated partition protects the rest of the system, but a partition that is too small ends sessions sooner.
- **Slower terminal:** with `delay`, commands with a lot of output take longer. In the tests, 540 KB took 36 s. The `drop` option causes no delay, but it discards parts, which makes it possible to hide activity behind a lot of output.
- **Lost recordings:** what Fluent Bit has not read is lost after 3 rotations. If it stops for about 3 hours with activity, or less during volume peaks, part of the recordings does not reach the Wazuh indexer. While the indexer is down, the buffer limit discards the oldest data.
- **`copytruncate` window:** what is written between the copy and the truncation can be lost. This did not happen in the tests, but the risk exists.
- **Sessions already open:** the rate limit only applies to sessions started after the change.

## Confirm that it works

Open a session with the recorded user and check the service and the errors on the host:

```bash
systemctl is-active fluent-bit wazuh-agent
```

```bash
sudo journalctl -u fluent-bit -n 30 --no-pager
```

The session should then appear in **Session Replay** within a few seconds.

# Installation

[Português](../instalacao.md)

There are three parts: prepare the server, install the plugin on the dashboard and set up each host to be recorded.

## Requirements

- A Wazuh dashboard based on OpenSearch Dashboards. Tested on the Wazuh platform 4.14.9, with OpenSearch Dashboards 2.19.6.
- Node.js and `npm`, on any computer, to build the package. The tests used Node.js 26.
- Linux hosts to record. The automatic script supports Ubuntu 22.04 and 24.04, Debian 12 and 13, and Kali. For the others, follow the [manual installation](manual-installation.md).

## 1. Build the package

The build version must match the installed OpenSearch Dashboards version, or the installation is refused. Check it on the dashboard server:

```bash
grep -m1 '"version"' /usr/share/wazuh-dashboard/package.json
```

Then build with that number. The Wazuh platform 4.14.9 image uses 2.19.6:

```bash
npm run build -- --osd-version=2.19.6
```

## 2. Prepare the indexer

Apply the template on the Wazuh indexer. The command asks for the password; use a user with permission to manage templates:

```bash
curl -u admin --cacert root-ca.pem -X PUT "https://INDEXER:9200/_index_template/tlog" -H 'Content-Type: application/json' -d @collector/index-template.json
```

Also create two roles in the indexer security module:
- **Write (Fluent Bit):** the cluster permission `indices:data/write/bulk`, plus `indices:admin/create`, `indices:admin/mapping/put`, `indices:data/write/bulk*` and `indices:data/write/index` on `tlog-*`. Do not use `indices:data/write/*`: it allows deleting recordings, and this user's password is stored on every host.
- **Read (analysts):** `read` on `tlog-*`, `wazuh-states-inventory-system-*` and `wazuh-alerts-*`, plus the `kibana_user` role to log in to the dashboard. The plugin queries the indices with the permissions of the logged-in user. The inventory is needed to open sessions from an agent. Without `wazuh-alerts-*`, the list still works, but it only shows what is in the capture and displays **Alerts unavailable**.

Define how long to keep recordings. The [collector/ism-policy.json](../../collector/ism-policy.json) policy deletes each daily `tlog-*` index after 90 days; adjust `min_index_age` to your audit requirements:

```bash
curl -u admin --cacert root-ca.pem -X PUT "https://INDEXER:9200/_plugins/_ism/policies/tlog-retention" -H 'Content-Type: application/json' -d @collector/ism-policy.json
```

The policy applies automatically to new indices. If `tlog-*` indices already exist, attach them to it:

```bash
curl -u admin --cacert root-ca.pem -X POST "https://INDEXER:9200/_plugins/_ism/add/tlog-*" -H 'Content-Type: application/json' -d '{"policy_id":"tlog-retention"}'
```

This policy does not delete alerts in `wazuh-alerts-*`, which carry the first stretch of each session. They follow the retention configured for Wazuh alerts.

## 3. Install the plugin

Run this on the dashboard server and restart the service:

```bash
sudo -u wazuh-dashboard /usr/share/wazuh-dashboard/bin/opensearch-dashboards-plugin install file:///path/to/tlogReplay-VERSION_osd-2.19.6.zip
```

```bash
sudo systemctl restart wazuh-dashboard
```

**When updating the plugin:** reinstall the `.zip` and restart the dashboard. After reloading the page, users get the new version without clearing anything; the version in use appears in the app footer. Changes to the loader are the exception: anyone who used a version before 0.3.0 must clear the data for this site once to see the sidebar icon.

## 4. Configure the manager rules

Copy `collector/wazuh-local_rules.xml` to the manager's `local_rules.xml`. It prevents alerts with session content on hosts where the agent reads the tlog log. The login and sudo alerts used on the timeline already come from the Wazuh manager, and the agent does not need to read that log. If it already does, remove the `/var/log/tlog/tlog.log` `<localfile>` from `ossec.conf`.

## 5. Set up each host

**A collector is required.** The plugin only reads the `tlog-*` index: it collects nothing and does not include Fluent Bit. Without a collector, the dashboard opens normally, but the session list is empty. The Wazuh agent does not replace the collector, because it only generates the alerts.

- **Ubuntu, Debian and Kali:** use the plugin's **Install** tab, which generates the script. See the [usage guide](usage.md#install).
- **Other distributions, or to check what the script does:** follow the [manual installation](manual-installation.md).

If something does not work, see [troubleshooting](troubleshooting.md).

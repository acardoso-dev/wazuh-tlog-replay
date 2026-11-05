# Security policy

[Português](../../SECURITY.md)

## How to report a flaw

**Do not open a public issue.** Use GitHub private reporting, on the [Security](https://github.com/acardoso-dev/wazuh-tlog-replay/security/advisories/new) tab of this repository.

Include:

- The version of the plugin and of the Wazuh platform.
- What an attacker can do, and what access they need.
- The steps to reproduce, preferably with fictional data.

Do not include real recordings, passwords or third-party data. Only test in environments you are authorized to test.

This project is maintained by volunteers, with no guaranteed response time. The goal is to respond within a few days and agree on disclosure after the fix.

## Supported versions

| Version | Status |
|---|---|
| Latest 0.9.x | Receives fixes |
| Before 0.8.3 | Have [known flaws](security-analysis.md). Update |

## What to consider when installing

Recordings can contain sensitive data, because they record what appears in the terminal. Limit who can read `tlog-*`, use the minimal writer role, define retention and enable the indexer audit logs.

The [security analysis](security-analysis.md) describes the findings, the fixes and the remaining risks. It does not replace penetration testing by third parties.

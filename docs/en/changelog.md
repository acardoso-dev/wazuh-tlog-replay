# Changelog

[Português](../../CHANGELOG.md)

The project uses [semantic versioning](https://semver.org/). While it is at 0.x, a minor version can bring incompatible changes.

## Unreleased

- Installation with a coding agent, such as Codex or Claude Code, in `docs/en/agent-installation.md`, with `AGENTS.md` and `CLAUDE.md` at the root.
- `npm run install-script` generates the install script from the command line.
- Writer and reader roles in `collector/role-tlog-writer.json` and `collector/role-tlog-reader.json`.

## 0.9.0

- English interface, with a language selector in the app header. The choice is per user and saved in the browser. On first use, the app follows the browser language, with English as the default.
- API messages, warnings and the generated install script follow the selected language.
- English documentation, in `docs/en` and `README.en.md`.
- Comments and descriptions in the `collector/` files are now in English. This includes the rule descriptions in `wazuh-local_rules.xml` and the retention policy. Files already installed keep working as they are.

## 0.8.4

- Logo in the plugin header.
- The package now includes `LICENSE`, `NOTICE` and the license notices of third-party components.
- Interface and script texts now point to the project documentation.
- Documentation reorganized for publishing the code.

## 0.8.3

- Minimal writer role for Fluent Bit.
- Verification of the Fluent Bit repository key.
- `Replay aberto` record in the dashboard log.
- The start of sessions is no longer copied to alerts.

## 0.8.2

- Fixes for denial of service through terminal sequences, line breaks, a slow regular expression and forged documents.
- The `tlog-rec-session` adjustment survives package updates, which prevents locking out recorded users.
- Limits on simultaneous analyses and response size.

The details are in the [security analysis](security-analysis.md).

## Up to 0.8.1

Prototype and first features, with no version-by-version history: replay, timeline, critical commands, link to alerts, agent tab and menu, sidebar icon, home card, settings, diagnostics, install script and `tlog-record-all`.

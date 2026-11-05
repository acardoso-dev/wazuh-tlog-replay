# Comparison with best practices

[Português](../boas-praticas.md)

Validated on November 5, 2026, on version 0.9.0.

**Wazuh does not publish a guide for third-party plugins.** The [development documentation](https://documentation.wazuh.com/current/development/index.html) does not cover the subject, and the [plugin repository guide](https://github.com/wazuh/wazuh-dashboard-plugins/blob/main/docs/dev/README.md) does not give guidance to external plugins. So this comparison uses the closest rules: the Wazuh trademark policy, the contribution and style guide of its plugins, and the conventions of OpenSearch Dashboards, the base of the Wazuh dashboard. Apart from the trademark policy, these rules apply to their own projects and serve here as a reference.

Legend: ✅ meets · ⚠️ partly meets · ❌ does not meet.

## Trademark

This is the part that applies to any project using the name.

| Rule | Status | Note |
|---|---|---|
| Do not include the Wazuh logo, or part of it, in the product logo | ✅ | The [logo](visual-identity.md) is original and uses other colors |
| Do not imply affiliation, certified integration or endorsement | ✅ | Notice in the README and in the `NOTICE` file |
| Do not register a domain with the name | ✅ | The project has no domain |
| Use the name as an adjective, followed by a generic term, with no possessive | ⚠️ | The documentation uses "Wazuh dashboard" and "Wazuh agent". The Portuguese interface still has texts such as "Com alerta do Wazuh" |
| Do not merge the name with other words, not even with a hyphen | ⚠️ | The repository name, `wazuh-tlog-replay`, conflicts with the rule. The plugin (`tlogReplay`) and the npm package (`tlog-session-replay`) do not use the mark |
| Request approval to use the mark in promotional material | ⚠️ | The banner and the social image do not use the mark. Consult Wazuh before promoting the project in campaigns |

The policy does not cover third-party plugins or compatibility statements. For questions about the repository name, Wazuh points to the legal@wazuh.com contact.

## Plugin

| Rule | Status | Note |
|---|---|---|
| `opensearch_dashboards.json` manifest with `id`, `version`, `opensearchDashboardsVersion`, `server`, `ui` | ✅ | Generated in the build |
| camelCase ID and kebab-case package | ✅ | `tlogReplay` and `tlog-session-replay` |
| Routes under `/api/`, with the plugin in the path and in snake_case | ✅ | `/api/tlog_replay/...` |
| Files in snake_case | ✅ | `src/lib/session_events.js` |
| Own prefix on CSS classes | ✅ | `tlog-` |
| Register the app in `setup` and load the interface on demand | ✅ | The app only loads when opened |
| Use `core.getStartServices()` | ✅ | Used in `mount` |
| A plugin failure does not bring down the dashboard | ✅ | Errors handled, plus [analysis limits](security-analysis.md) |
| Saved objects declared with `hidden`, `namespaceType` and mappings | ✅ | `tlog-replay-settings` is hidden |
| Tests along with changes | ✅ | 133 automated tests |
| No `var`, with `===` and single quotes | ✅ | Checked in the code |
| Declare dependencies and do not access another plugin's DOM | ❌ | The agent menu and the home card are inserted into the page, because the Wazuh dashboard has no extension point for that. If the screen changes, the items disappear, and the app stays in the sidebar. See the [limitations](limitations.md) |
| Texts with `i18n.translate` | ⚠️ | Texts are in catalogs, with stable namespaced IDs, no concatenation and in English and Portuguese. They use the plugin's own function because `i18n.locale` is one per server, and the goal is a choice per user. See the [architecture](architecture.md#language) |
| `public/plugin.ts` and `server/plugin.ts` structure, with the official generator | ⚠️ | Uses JavaScript and its own esbuild build, needed for the [fixed loader](architecture.md#loader-and-updates-without-clearing-the-cache) and to build without the dashboard code |
| Work with and without `server.basePath` | ⚠️ | The code uses `http.basePath`, but this was **not tested** with a configured path |
| Prettier, ESLint and 100 columns | ❌ | The project does not have these tools, and there are longer lines |
| Functions of up to 15 lines | ⚠️ | The logic is in `src/lib`, but screen-building functions are long |

## Repository

| Rule | Status | Note |
|---|---|---|
| License and third-party notices | ✅ | `LICENSE`, `NOTICE` and `THIRD-PARTY-NOTICES.txt` in the package |
| Security flaws outside public issues | ✅ | [Security policy](security-policy.md) |
| Contribution guide and issue templates | ✅ | [Contributing](contributing.md) and `.github/` |
| Commits in English, in the imperative, with up to 50 characters in the title | ✅ | Rule adopted in the contribution guide |
| Repository description without the mark as the project name | ⚠️ | Depends on the text configured on GitHub |

## What to do next

1. Consult Wazuh about the repository name, to settle the conflict with the rule.
2. Test with `server.basePath` and with multi-tenancy.
3. Adopt Prettier and ESLint, with the rules of the Wazuh style guide.
4. Adjust the name in the Portuguese interface texts.

## Sources

- [Wazuh: Trademark and Brand Policy (May 2024)](https://wazuh.com/docs/legal-resources/Trademark_and_Brand_Policy_May_2024.pdf)
- [Wazuh: trademark Overall Guidelines](https://wazuh.com/legal-resources/trademark-overall-guidelines/)
- [wazuh-dashboard-plugins: CONTRIBUTING.md](https://github.com/wazuh/wazuh-dashboard-plugins/blob/main/CONTRIBUTING.md)
- [wazuh-dashboard-plugins: STYLEGUIDE.md](https://github.com/wazuh/wazuh-dashboard-plugins/blob/main/STYLEGUIDE.md)
- [OpenSearch Dashboards: DEVELOPER_GUIDE.md](https://github.com/opensearch-project/OpenSearch-Dashboards/blob/main/DEVELOPER_GUIDE.md)
- [OpenSearch Dashboards: plugin conventions](https://github.com/opensearch-project/OpenSearch-Dashboards/blob/main/src/core/CONVENTIONS.md)
- [OpenSearch Dashboards: plugin principles](https://github.com/opensearch-project/OpenSearch-Dashboards/blob/main/src/core/PRINCIPLES.md)
- [opensearch-plugins: CONVENTIONS.md](https://github.com/opensearch-project/opensearch-plugins/blob/main/CONVENTIONS.md)

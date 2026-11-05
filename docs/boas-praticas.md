# Comparação com as boas práticas

[English](en/best-practices.md)

Validação feita em 05/11/2026, na versão 0.9.0.

**A Wazuh não publica um guia para plugins de terceiros.** A [documentação de desenvolvimento](https://documentation.wazuh.com/current/development/index.html) não trata do assunto, e o [guia do repositório de plugins](https://github.com/wazuh/wazuh-dashboard-plugins/blob/main/docs/dev/README.md) não orienta plugins externos. Por isso, esta comparação usa as regras mais próximas: a política de marca da Wazuh, o guia de contribuição e de estilo dos plugins dela e as convenções do OpenSearch Dashboards, base do Wazuh dashboard. Fora a política de marca, essas regras valem para os projetos deles e servem aqui como referência.

Legenda: ✅ atende · ⚠️ atende em parte · ❌ não atende.

## Marca

Esta é a parte que vale para qualquer projeto que use o nome.

| Regra | Situação | Observação |
|---|---|---|
| Não incluir o logo Wazuh, nem parte dele, no logo do produto | ✅ | O [logo](identidade-visual.md) é original e usa outras cores |
| Não insinuar afiliação, integração certificada ou endosso | ✅ | Aviso no README e no arquivo `NOTICE` |
| Não registrar domínio com o nome | ✅ | O projeto não tem domínio |
| Usar o nome como adjetivo, seguido de um termo genérico, sem posse | ⚠️ | A documentação usa "Wazuh dashboard" e "Wazuh agent". A interface em português ainda tem textos como "Com alerta do Wazuh" |
| Não unir o nome a outras palavras, nem com hífen | ⚠️ | O nome do repositório, `wazuh-tlog-replay`, conflita com a regra. O plugin (`tlogReplay`) e o pacote npm (`tlog-session-replay`) não usam a marca |
| Pedir aprovação para usar a marca em material promocional | ⚠️ | O banner e a imagem social não usam a marca. Consulte a Wazuh antes de divulgar o projeto em campanhas |

A política não trata de plugins de terceiros nem de declarações de compatibilidade. Para dúvidas sobre o nome do repositório, a Wazuh indica o contato legal@wazuh.com.

## Plugin

| Regra | Situação | Observação |
|---|---|---|
| Manifesto `opensearch_dashboards.json` com `id`, `version`, `opensearchDashboardsVersion`, `server`, `ui` | ✅ | Gerado no build |
| ID em camelCase e pacote em kebab-case | ✅ | `tlogReplay` e `tlog-session-replay` |
| Rotas em `/api/`, com o plugin no caminho e em snake_case | ✅ | `/api/tlog_replay/...` |
| Arquivos em snake_case | ✅ | `src/lib/session_events.js` |
| Prefixo próprio nas classes de CSS | ✅ | `tlog-` |
| Registrar o app no `setup` e carregar a interface sob demanda | ✅ | O app só carrega ao abrir |
| Usar `core.getStartServices()` | ✅ | Usado no `mount` |
| Uma falha do plugin não derruba o dashboard | ✅ | Erros tratados e [limites de análise](analise-de-seguranca.md) |
| Saved objects declarados com `hidden`, `namespaceType` e mapeamentos | ✅ | `tlog-replay-settings` é oculto |
| Testes junto com as mudanças | ✅ | 135 testes automatizados |
| Sem `var`, com `===` e aspas simples | ✅ | Conferido no código |
| Declarar dependências e não acessar o DOM de outro plugin | ❌ | O menu do agente e o card da home são inseridos na página, porque o Wazuh dashboard não tem ponto de extensão para isso. Se a tela mudar, os itens somem, e o app continua na sidebar. Veja as [limitações](limitacoes.md) |
| Textos com `i18n.translate` | ⚠️ | Os textos ficam em catálogos, com IDs estáveis e com prefixo, sem concatenação, em inglês e português. Usam uma função própria porque o `i18n.locale` é um por servidor, e o objetivo é a escolha por usuário. Veja a [arquitetura](arquitetura.md#idioma) |
| Estrutura `public/plugin.ts` e `server/plugin.ts`, com o gerador oficial | ⚠️ | Usa JavaScript e um build próprio com esbuild, necessários para o [carregador fixo](arquitetura.md#carregador-e-atualização-sem-limpar-o-cache) e para compilar sem o código do dashboard |
| Funcionar com e sem `server.basePath` | ⚠️ | O código usa `http.basePath`, mas isso **não foi testado** com um caminho configurado |
| Prettier, ESLint e 100 colunas | ❌ | O projeto não tem essas ferramentas, e há linhas mais longas |
| Funções de até 15 linhas | ⚠️ | A lógica fica em `src/lib`, mas funções de montagem de tela são longas |

## Repositório

| Regra | Situação | Observação |
|---|---|---|
| Licença e avisos de terceiros | ✅ | `LICENSE`, `NOTICE` e `THIRD-PARTY-NOTICES.txt` no pacote |
| Falhas de segurança fora de issues públicas | ✅ | [SECURITY.md](../SECURITY.md) |
| Guia de contribuição e modelos de issue | ✅ | [CONTRIBUTING.md](../CONTRIBUTING.md) e `.github/` |
| Commits em inglês, no imperativo, com até 50 caracteres no título | ✅ | Regra adotada no guia de contribuição |
| Descrição do repositório sem a marca como nome do projeto | ⚠️ | Depende do texto configurado no GitHub |

## O que fazer depois

1. Consultar a Wazuh sobre o nome do repositório, para resolver o conflito com a regra.
2. Testar com `server.basePath` e com multi-tenancy.
3. Adotar Prettier e ESLint, com as regras do guia de estilo da Wazuh.
4. Ajustar o nome nos textos da interface em português.

## Fontes

- [Wazuh: Trademark and Brand Policy (maio de 2024)](https://wazuh.com/docs/legal-resources/Trademark_and_Brand_Policy_May_2024.pdf)
- [Wazuh: Overall Guidelines da marca](https://wazuh.com/legal-resources/trademark-overall-guidelines/)
- [wazuh-dashboard-plugins: CONTRIBUTING.md](https://github.com/wazuh/wazuh-dashboard-plugins/blob/main/CONTRIBUTING.md)
- [wazuh-dashboard-plugins: STYLEGUIDE.md](https://github.com/wazuh/wazuh-dashboard-plugins/blob/main/STYLEGUIDE.md)
- [OpenSearch Dashboards: DEVELOPER_GUIDE.md](https://github.com/opensearch-project/OpenSearch-Dashboards/blob/main/DEVELOPER_GUIDE.md)
- [OpenSearch Dashboards: convenções de plugins](https://github.com/opensearch-project/OpenSearch-Dashboards/blob/main/src/core/CONVENTIONS.md)
- [OpenSearch Dashboards: princípios de plugins](https://github.com/opensearch-project/OpenSearch-Dashboards/blob/main/src/core/PRINCIPLES.md)
- [opensearch-plugins: CONVENTIONS.md](https://github.com/opensearch-project/opensearch-plugins/blob/main/CONVENTIONS.md)

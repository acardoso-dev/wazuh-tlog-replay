# Política de segurança

## Como relatar uma falha

**Não abra uma issue pública.** Use o relato privado do GitHub, na aba [Security](https://github.com/acardoso-dev/wazuh-tlog-replay/security/advisories/new) deste repositório.

Informe:

- A versão do plugin e da plataforma Wazuh.
- O que um atacante consegue fazer, e que acesso ele precisa ter.
- Os passos para reproduzir, de preferência com dados fictícios.

Não inclua gravações reais, senhas ou dados de terceiros. Teste somente em ambientes que você tem autorização para testar.

Este é um projeto mantido por voluntários, sem prazo garantido de resposta. O objetivo é responder em alguns dias e combinar a divulgação depois da correção.

## Versões atendidas

| Versão | Situação |
|---|---|
| 0.8.x mais recente | Recebe correções |
| Anteriores à 0.8.3 | Têm [falhas conhecidas](docs/analise-de-seguranca.md). Atualize |

## O que considerar ao instalar

As gravações podem conter dados sensíveis, porque registram o que aparece no terminal. Limite quem lê `tlog-*`, use o papel de escrita mínimo, defina a retenção e ative os logs de auditoria do indexador.

A [análise de segurança](docs/analise-de-seguranca.md) descreve os achados, as correções e os riscos que continuam. Ela não substitui um teste de invasão feito por terceiros.

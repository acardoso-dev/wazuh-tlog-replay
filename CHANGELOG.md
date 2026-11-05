# Histórico de mudanças

[English](docs/en/changelog.md)

O projeto usa [versionamento semântico](https://semver.org/lang/pt-BR/). Enquanto estiver em 0.x, uma versão menor pode trazer mudanças incompatíveis.

## 0.9.0

- Interface em inglês, com seletor de idioma no cabeçalho do app. A escolha é por usuário e fica salva no navegador. No primeiro uso, o app segue o idioma do navegador, com inglês como padrão.
- Mensagens da API, avisos e o script de instalação gerado acompanham o idioma escolhido.
- Documentação em inglês, em `docs/en` e `README.en.md`.
- Comentários e descrições dos arquivos de `collector/` agora estão em inglês. Isso inclui as descrições das regras em `wazuh-local_rules.xml` e a política de retenção. Arquivos já instalados continuam funcionando como estão.

## 0.8.4

- Logo no cabeçalho do plugin.
- O pacote agora inclui `LICENSE`, `NOTICE` e os avisos de licença dos componentes de terceiros.
- Textos da interface e do script agora apontam para a documentação do projeto.
- Documentação reorganizada para a publicação do código.

## 0.8.3

- Papel de escrita mínimo para o Fluent Bit.
- Conferência da chave do repositório do Fluent Bit.
- Registro de `Replay aberto` no log do dashboard.
- O início das sessões deixa de ser copiado para os alertas.

## 0.8.2

- Correções de negação de serviço por sequências de terminal, quebras de linha, expressão regular lenta e documentos forjados.
- O ajuste do `tlog-rec-session` sobrevive à atualização do pacote, o que evita impedir o login dos usuários gravados.
- Limites de análises simultâneas e de tamanho das respostas.

Os detalhes estão na [análise de segurança](docs/analise-de-seguranca.md).

## Até 0.8.1

Protótipo e primeiras funções, sem histórico versão a versão: replay, timeline, comandos críticos, ligação com alertas, aba e menu no agente, ícone na sidebar, card na home, configurações, diagnóstico, script de instalação e `tlog-record-all`.

# Como contribuir

Obrigado pelo interesse. Issues e pull requests podem ser escritos em português ou inglês.

## Antes de começar

- **Falha de segurança:** não abra uma issue pública. Siga a [política de segurança](SECURITY.md).
- **Bug:** confirme que usa a versão mais recente e veja a [solução de problemas](docs/solucao-de-problemas.md) e as [limitações](docs/limitacoes.md). Na issue, informe as versões e os passos para reproduzir.
- **Mudança grande:** abra uma issue antes, para combinar o caminho.

Ao contribuir, você declara ter os direitos sobre o conteúdo enviado e concorda em disponibilizá-lo sob a [licença Apache-2.0](LICENSE).

## Ambiente

Os testes do projeto usam o Node.js 26.

```bash
npm ci
```

```bash
npm test
```

Para compilar, informe a versão do OpenSearch Dashboards de destino. A plataforma Wazuh 4.14.9 usa a 2.19.6:

```bash
npm run build -- --osd-version=2.19.6
```

Para abrir o ambiente simulado em `http://localhost:5687`, depois de compilar:

```bash
npm run harness
```

Ele não precisa de um servidor real, e os dados ficam em memória. Com `HARNESS_READONLY=1`, simula um usuário sem permissão de alterar as configurações.

A pasta [test-env/](test-env/) tem uma máquina Ubuntu de teste, com `systemd` e SSH, que se conecta a uma instalação Wazuh em Docker. Ela roda com `--privileged`, então é só para testes locais.

## Pull requests

- Adicione ou ajuste testes para a mudança, e rode `npm test`.
- Atualize a documentação e o [histórico de mudanças](CHANGELOG.md).
- Confira a tela no ambiente simulado, em larguras de 1280 e 375 px, se ela mudou. Atualize as imagens com `npm run screenshots`.
- Evite alterar `src/public/index.js`. Navegadores guardam esse arquivo por até um ano. Veja a [arquitetura](docs/arquitetura.md#carregador-e-atualização-sem-limpar-o-cache).
- Trate host, usuário e comandos como dados não confiáveis, porque vêm das máquinas gravadas. Não use `innerHTML`.
- Não envie gravações reais, senhas, certificados privados ou nomes internos. Use só dados fictícios em `samples/` e nos testes.

## Commits

Seguimos a regra dos [plugins da Wazuh](https://github.com/wazuh/wazuh-dashboard-plugins/blob/main/CONTRIBUTING.md): em inglês, com título no imperativo de até 50 caracteres, sem ponto final, e corpo separado por uma linha em branco.

## Estilo

Siga o código existente e o [guia de estilo dos plugins da Wazuh](https://github.com/wazuh/wazuh-dashboard-plugins/blob/main/STYLEGUIDE.md) naquilo que se aplica. As diferenças atuais estão em [boas práticas](docs/boas-praticas.md).

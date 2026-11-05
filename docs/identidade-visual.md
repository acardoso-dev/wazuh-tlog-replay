# Identidade visual

[English](en/visual-identity.md)

<img src="../assets/brand/logo.svg" alt="Logo do Session Replay" width="128">

O logo une três ideias: a **seta circular** do replay, o **prompt** do terminal e o **cursor âmbar**, que lembra os pontos críticos marcados na timeline.

## Arquivos

| Arquivo | Uso |
|---|---|
| [`logo.svg`](../assets/brand/logo.svg) | Logo principal, com fundo escuro. Também aparece no cabeçalho do plugin |
| [`logo-transparent.svg`](../assets/brand/logo-transparent.svg) | Sem fundo, para superfícies claras |
| [`logo-512.png`](../assets/brand/logo-512.png) e [`logo-128.png`](../assets/brand/logo-128.png) | Onde SVG não é aceito |
| [`banner.png`](../assets/brand/banner.png) e [`banner-en.png`](../assets/brand/banner-en.png) | Topo dos READMEs em português e em inglês |
| [`social-preview.png`](../assets/brand/social-preview.png) | Imagem de compartilhamento do repositório, em 1280 × 640 |

## Cores

| Nome | Hexadecimal | Uso |
|---|---|---|
| Tinta | `#10202B` | Fundo e texto em superfícies claras |
| Replay | `#1CC8A5` | Seta e trechos com atividade. Em fundo claro, `#12A488` |
| Evento | `#FFB020` | Cursor e pontos críticos. Em fundo claro, `#E08E00` |
| Papel | `#F4F7F6` | Prompt e texto em fundo escuro |
| Neblina | `#A9BDC4` | Texto secundário em fundo escuro |

## Regras

- Mantenha uma margem livre de pelo menos 1/8 da largura ao redor do logo.
- Não use o logo com menos de 16 px.
- Não mude as cores, não distorça e não acrescente efeitos.
- Não combine com o logo Wazuh: a [política de marca](https://wazuh.com/docs/legal-resources/Trademark_and_Brand_Policy_May_2024.pdf) exige licença por escrito para isso.
- Os ícones da sidebar, da home e do menu do agente continuam com o `videoPlayer` do OUI, para acompanhar os demais ícones do painel. O carregador, que define o ícone da sidebar, também fica guardado no navegador por até um ano.

## Imagens das telas

As imagens de `docs/images` são geradas pelo ambiente simulado, com dados fictícios. As em inglês ficam em `docs/images/en`:

```bash
npm run build -- --osd-version=2.19.6
```

```bash
npm run screenshots
```

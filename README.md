# Minerv.AI

**Um estúdio de vídeo que roda no seu computador.** Monte uma sequência, gere clipes entre keyframes e exporte em MP4.

![Símbolo Minerv.AI](public/minerv-athena.png)

## Comece em poucos minutos

1. Instale o [Node.js 24 ou superior](https://nodejs.org/).
2. No Windows, abra **Start-Studio.cmd**. Na primeira execução, o iniciador instala as dependências e prepara o editor.
3. Abra [Minerv.AI](http://127.0.0.1:4310), crie um projeto e importe sua mídia. Para encerrar o servidor, use **Stop-Studio.cmd**.

O modelo **Demo** funciona sem conta externa e usa um clipe local. É a maneira mais rápida de experimentar a timeline e a exportação.

## Configure a geração por IA

Crie uma chave no [painel da fal.ai](https://fal.ai/dashboard/keys). No início da Minerv.AI, abra **Configurações**, cole a chave e salve. O olho alterna entre a chave oculta e visível. Se você tentar gerar ou modificar atores antes de configurar a chave, o editor abre essa janela.

No Windows, a chave salva é protegida pela conta local e fica em `%LOCALAPPDATA%/MinervAI/fal-key.xml`. Em outros sistemas, ela fica no diretório de configuração do usuário, com permissões restritas. Em ambientes automatizados, também é possível fornecer `FAL_KEY` ao iniciar o servidor. A chave nunca deve ser colocada no código nem em um commit.

A geração por IA envia a mídia usada na operação à fal.ai e consome os créditos da conta. O Kling V3 usa a imagem inicial, a imagem final opcional e a descrição. Escolha segmentos entre 3 e 15 segundos. Quando a duração for fracionária, o editor pede o próximo segundo inteiro e ajusta o resultado à timeline.

## Edite e exporte

- **Keyframes e versões.** Posicione imagens no tempo, gere um segmento e compare versões.
- **Texto e enquadramento.** Arraste texto para a timeline, ajuste a duração pelas bordas e mova, redimensione ou gire elementos na prévia.
- **Corte e união.** Use **Cortar na agulha** ou **Desagrupar vídeo**. Selecione dois clipes consecutivos com **Ctrl+clique** e escolha **Unir** para fechar o vão.
- **Exportação.** Exporte em MP4 com áudio. Vãos sem mídia são preenchidos com preto na resolução temporal do vídeo.

Projetos e arquivos importados ficam em `data/`, no computador que executa o servidor. O repositório contém o código e o clipe de demonstração, cuja licença está em [assets/LICENSE.txt](assets/LICENSE.txt).

## Desenvolvimento

Com Node.js 24 e pnpm:

```bash
pnpm install --frozen-lockfile
pnpm demo
pnpm dev
```

`pnpm build` valida os tipos e prepara o frontend. `pnpm test` executa os testes locais, incluindo exportação com FFmpeg. O servidor escuta apenas no endereço local.

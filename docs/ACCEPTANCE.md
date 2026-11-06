# Roteiro de aceite

1. Criar um projeto local e importar quatro imagens. Arrastá-las para a Keyframe Lane em tempos distintos e verificar três segmentos automáticos sem clips estáticos.
2. Configurar prompt em cada segmento, mantendo Continuous em um e Cut em outro. Verificar que a duração deriva dos keyframes.
3. Gerar os três segmentos. Conferir estados de fila e manutenção da responsividade.
4. Regenerar apenas o segundo segmento. Confirmar que os outros dois mantêm suas versões.
5. Voltar para a primeira versão do segundo segmento.
6. Reproduzir o trecho individual e a sequência completa; testar seek no player e na régua da timeline.
7. Arrastar mídia para a Video Track, editar início e duração no Inspector e verificar persistência após reload.
8. Criar overlap com conteúdo gerado, verificar destaque e bloqueio de export e reprodução da Preview por prioridade; corrigir o intervalo e exportar.
9. Fechar e reabrir o projeto, preservando configuração, seleção e versões.
10. Exportar MP4, baixar e confirmar formato, FPS e duração total.
11. Revisar layout em 1280 × 800 e 1920 × 1080, sem sobreposição de painéis. O inspector possui rolagem independente.

Os testes automatizados usam armazenamento temporário separado. Falhas de importação, de salvamento, de geração e ausência de FFmpeg devem mostrar erro recuperável e preservar resultados anteriores. O log de erros durante esses testes é esperado.

## Resultado da validação — 9 de setembro de 2026

- Compilação e verificação de tipos concluídas.
- Seis testes automatizados passaram, incluindo processamento real com FFmpeg e falhas simuladas.
- No navegador: projeto “Mountain study”, importação de quatro imagens, três segmentos, modos Continuous/Cut, prompt e duração, geração, regeneração isolada, retorno à versão 1, reprodução e busca temporal.
- Preview observado com 11 segundos e resolução 1920 × 1080. Exportação iniciada pela interface e download concluído.
- Arquivo exportado inspecionado: MP4, H.264, 1920 × 1080, 30 FPS, 11 segundos, sem áudio.
- Layout revisado em 1280 × 800 e 1920 × 1080.
- Iniciadores testados no Windows PowerShell: iniciar, parar e iniciar novamente. Dados e histórico preservados.
- O projeto de demonstração permanece na biblioteca local para exploração.

## Timeline incompleta e histórico

1. Criar três anchors por Add Keyframe, sem importar imagens. Confirmar No image, Play disponível e Export indisponível.
2. Gerar somente o primeiro intervalo. Reproduzir até o próximo: vídeo seguido de placeholder, sem parar na transição.
3. Adicionar imagem ao anchor final: o segundo intervalo usa essa imagem. Adicionar imagem ao inicial: ela tem prioridade nesse intervalo.
4. Remover imagem de anchor usado numa geração: conferir Outdated âmbar e fallback. Undo restaura imagem e validade.
5. Buscar um frame interior do vídeo válido: Frame to Keyframe deve habilitar somente após seek. Executar e conferir os dois vídeos derivados. Undo/Redo deve conservar os mesmos IDs e arquivos.
6. Copiar/colar anchor e StaticImageClip: novos IDs, mesma mídia/duração; Undo/Redo recupera os IDs da colagem.
7. Digitar em nome, prompt, timestamp e contenteditable: atalhos do editor não devem interceptar edição de texto. Testar Delete/Backspace fora desses campos.
8. Criar sobreposição: Preview segue a prioridade documentada e Export continua bloqueado.
9. Executar Undo após um job terminar: resultado e arquivo continuam presentes. Fechar e reabrir projeto limpa histórico e clipboard.
10. Recarregar um projeto antigo: vídeos continuam válidos; alterações posteriores de imagem tornam a versão Outdated.

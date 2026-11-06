// Labels only: persisted enums and API values remain compatible with existing projects.
const labels: Record<string, string> = {
  Idle: "Pendente",
  Queued: "Na fila",
  Generating: "Gerando",
  Completed: "Concluído",
  Failed: "Falhou",
  Continuous: "Contínua",
  Neutral: "Neutra",
  Cut: "Corte",
};
export const label = (value: string) => labels[value] || value;
const errors: Record<string, string> = {
  "Choose between 1 and 100 unique projects.": "Escolha entre 1 e 100 projetos diferentes.",
  "Invalid timeline structure": "Estrutura da timeline inválida.",
  "Invalid keyframe identity": "Identificador de keyframe inválido.",
  "Duplicate timestamp": "Há keyframes na mesma posição.",
  "Unknown image": "Imagem não encontrada.",
  "Invalid clip": "Clipe inválido.",
  "Active generated segment not found": "Segmento gerado ativo não encontrado.",
  "Timeline delta must be a whole number of milliseconds.": "O deslocamento deve ser um número inteiro de milissegundos.",
  "A generated chain cannot contain an external keyframe.": "Uma sequência gerada não pode conter um keyframe externo.",
  "Choose a timestamp inside the segment.": "Escolha uma posição dentro do segmento.",
  "Regenerate this segment before creating a keyframe from its video.": "Gere uma nova versão antes de extrair um keyframe do vídeo.",
  "Duration must be a positive whole number of milliseconds.": "A duração deve ser um número inteiro positivo de milissegundos.",
  "Time must be a non-negative whole number of milliseconds.": "A posição deve ser um número inteiro de milissegundos maior ou igual a zero.",
  "The server stopped before this job finished. Please retry.": "O servidor foi encerrado antes de concluir o trabalho. Tente novamente.",
  "Operation failed. Please retry.": "Não foi possível concluir a operação. Tente novamente.",
  "Request failed": "Não foi possível concluir a solicitação.",
  "Failed to fetch": "Não foi possível conectar ao servidor.",
  "Project not found": "Projeto não encontrado.",
  "Media item not found": "Mídia não encontrada.",
  "Keyframe not found": "Keyframe não encontrado.",
  "Segment not found": "Segmento não encontrado.",
  "Select a current segment.": "Selecione um segmento da timeline.",
  "Static image clip not found": "Clipe de imagem não encontrado.",
  "A keyframe already exists here": "Já existe um keyframe nesta posição.",
  "A keyframe already exists at this timestamp.":
    "Já existe um keyframe nesta posição.",
  "A keyframe already exists at the target timestamp.":
    "Já existe um keyframe na posição de destino.",
  "Generate this segment first.": "Gere este segmento primeiro.",
  "Generated video file is missing.":
    "O arquivo do vídeo gerado não foi encontrado.",
  "This segment already has a pending generation.":
    "Este segmento já tem uma geração em andamento.",
  "Generate every segment before exporting the sequence.":
    "Gere todos os segmentos antes de exportar a sequência.",
  "Resolve overlapping media before exporting.":
    "Resolva as sobreposições da timeline antes de exportar.",
  "Add timeline content before exporting.":
    "Adicione conteúdo à timeline antes de exportar.",
  "Choose at least one JPG, PNG or WebP image.":
    "Escolha pelo menos uma imagem JPG, PNG ou WebP.",
  "Only JPG, PNG and WebP images are supported.":
    "Use imagens JPG, PNG ou WebP.",
  "Choose a completed version.": "Escolha uma versão concluída.",
  "Export is not ready": "A exportação ainda não está pronta.",
  "Enter a project name of 1–100 characters.":
    "Use um nome de projeto com 1 a 100 caracteres.",
  "Wait for running jobs before deleting this project.":
    "Aguarde os trabalhos em andamento antes de excluir o projeto.",
  "Check prompt, continuity and seed (up to 16 digits).":
    "Confira a descrição, a continuidade e a seed (até 16 dígitos).",
  "Timeline changed in another editor. Refresh and try again.":
    "A timeline mudou em outro editor. Atualize e tente novamente.",
  "The project changed while the keyframe was being created.":
    "O projeto mudou durante a criação do keyframe. Tente novamente.",
  "Invalid project format": "Formato de projeto inválido.",
  "This deletion was already finalized.": "Esta exclusão já foi concluída.",
  "Set FAL_KEY before using AI generation.":
    "A integração de IA ainda precisa ser configurada no servidor (FAL_KEY).",
  "Kling V3 requires an image on the first keyframe.":
    "Adicione uma imagem ao primeiro keyframe para usar Kling V3.",
  "Seedance 2.5 requires an image on the first keyframe.":
    "Adicione uma imagem ao primeiro keyframe para usar Seedance 2.5.",
  "Seedance 2.5 segments must last 4–30 seconds.":
    "No Seedance 2.5, os segmentos devem ter de 4 a 30 segundos.",
  "Kling V3 segments must last 3–15 whole seconds.":
    "Esta tentativa usou a regra antiga de segundos inteiros. Você pode gerar novamente com a duração atual.",
  "Kling V3 segments must last 3–15 seconds.":
    "No Kling V3, os segmentos devem ter de 3 a 15 segundos.",
  "Generate this segment before replacing its actor.":
    "Gere o segmento antes de modificar seus atores.",
  "Wait for the pending generation.": "Aguarde a geração em andamento.",
  "Choose an actor image from Media.":
    "Escolha uma imagem de referência na biblioteca de mídia.",
  "File too large": "O arquivo excede o tamanho permitido.",
};
export function localError(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  const bare = text.replace(/^(Error|TypeError): /, "");
  // Preserve unknown external error details for troubleshooting.
  return errors[bare] || bare;
}

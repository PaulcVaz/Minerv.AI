import { useEffect, useRef } from "react";
import { Sparkles, X } from "lucide-react";
import { CreateProjectButton } from "./CreateProjectButton";

export function CreateProjectDialog({
  open,
  name,
  loading,
  onName,
  onCreate,
  onClose,
}: {
  open: boolean;
  name: string;
  loading: boolean;
  onName: (name: string) => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
      nameInput.current?.focus();
      nameInput.current?.select();
    } else dialog.current?.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="modal create-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!loading) onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current && !loading) onClose();
      }}
      aria-labelledby="create-title"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() && !loading) onCreate();
        }}
      >
        <button
          type="button"
          className="confirm-close"
          aria-label="Fechar"
          disabled={loading}
          onClick={onClose}
        >
          <X size={20} />
        </button>
        <div className="create-dialog-icon">
          <Sparkles size={25} />
        </div>
        <p className="eyebrow">UMA NOVA HISTÓRIA</p>
        <h2 id="create-title">Dê um nome à sua ideia.</h2>
        <p className="help">
          Seu próximo vídeo começa aqui. Você pode mudar o nome depois.
        </p>
        <label>
          Nome do projeto
          <input
            ref={nameInput}
            autoFocus
            value={name}
            maxLength={100}
            disabled={loading}
            onChange={(event) => onName(event.target.value)}
          />
        </label>
        <CreateProjectButton
          loading={loading}
          disabled={!name.trim()}
          onClick={onCreate}
        />
      </form>
    </dialog>
  );
}

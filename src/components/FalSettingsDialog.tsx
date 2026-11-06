import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, KeyRound, X } from "lucide-react";
import { api } from "../store";

export function FalSettingsDialog({ required, onClose }: {
  required: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [configured, setConfigured] = useState(false);
  const [draft, setDraft] = useState("");
  const [revealed, setRevealed] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    void api<{ configured: boolean }>("/settings/fal-key")
      .then((status) => setConfigured(status.configured))
      .catch(() => setMessage("Não foi possível carregar as configurações."));
  }, []);
  const toggle = async () => {
    if (visible) {
      setVisible(false);
      setRevealed("");
      return;
    }
    setBusy(true);
    try {
      if (!draft && configured) {
        const { key } = await api<{ key: string }>("/settings/fal-key/reveal", "POST", {});
        setRevealed(key);
      }
      setVisible(true);
    } catch {
      setMessage("Não foi possível visualizar a chave.");
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    try {
      await api("/settings/fal-key", "PUT", { key: draft });
      setConfigured(true);
      setDraft("");
      setRevealed("");
      setVisible(false);
      setMessage("Chave salva. Você já pode solicitar a geração.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível salvar a chave.");
    } finally {
      setBusy(false);
    }
  };
  return <dialog ref={dialog} className="modal create-dialog" aria-labelledby="fal-settings-title"
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={(event) => { event.preventDefault(); if (draft.trim() && !busy) void save(); }}>
      <button className="confirm-close" type="button" aria-label="Fechar" onClick={onClose} disabled={busy}><X size={20} /></button>
      <div className="create-dialog-icon"><KeyRound size={24} /></div>
      <h2 id="fal-settings-title">Configurações</h2>
      <p className="help">{required ? "Adicione sua chave da fal.ai para gerar com IA." : "Gerencie a chave da fal.ai usada na geração com IA."}</p>
      <label htmlFor="fal-key">Chave da API</label>
      <div className="fal-key-field">
        <input id="fal-key" type={visible ? "text" : "password"} autoComplete="off" spellCheck={false}
          value={draft || revealed} placeholder={configured ? "••••••••••••••••" : "Cole sua chave da fal.ai"}
          onChange={(event) => { setDraft(event.target.value); setRevealed(""); setMessage(""); }}
          onCopy={(event) => event.preventDefault()} onCut={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && ["c", "x"].includes(event.key.toLowerCase()))
              event.preventDefault();
          }} />
        <button type="button" aria-label={visible ? "Ocultar chave" : "Mostrar chave"} disabled={busy}
          onClick={() => void toggle()}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button>
      </div>
      <p className="help" role="status">{message || (configured ? "Chave configurada neste computador." : "Cole uma chave criada na sua conta da fal.ai.")}</p>
      <button className="primary wide" type="submit" disabled={busy || !draft.trim()}>Salvar chave</button>
    </form>
  </dialog>;
}

import { LoaderCircle, Plus } from "lucide-react";
import "./create-project-button.css";

export function CreateProjectButton({
  loading,
  disabled,
  onClick,
}: {
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`primary create-project-button${loading ? " is-loading" : ""}`}
      disabled={disabled || loading}
      aria-busy={loading}
      aria-label={loading ? "Criando seu projeto…" : "Criar projeto"}
      onClick={onClick}
    >
      <span
        className="create-project-button-content"
        role="status"
        aria-live="polite"
      >
        {loading ? (
          <LoaderCircle
            size={17}
            className="create-project-spinner"
            aria-hidden="true"
          />
        ) : (
          <Plus size={17} aria-hidden="true" />
        )}
        <span>{loading ? "Criando seu projeto…" : "Criar projeto"}</span>
      </span>
      {loading && (
        <span className="create-project-loading-track" aria-hidden="true" />
      )}
    </button>
  );
}

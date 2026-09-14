import { useMemo, useState, type FormEvent } from "react";
import { AppProviders } from "./AppProviders";
import { env } from "../lib/config";
import {
  formatQueryError,
  useDeviceAction,
  useVerifyDeviceCode,
} from "../lib/hooks";

function useSearchParams() {
  return useMemo(() => new URLSearchParams(window.location.search), []);
}

function DeviceFormInner() {
  const q = useSearchParams();
  const [code, setCode] = useState(q.get("user_code") || "");
  const verify = useVerifyDeviceCode();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const formatted = code.replace(/-/g, "").toUpperCase();
    const result = await verify.mutateAsync(formatted);
    if (result.needsSignIn) {
      const next = `/device?user_code=${encodeURIComponent(formatted)}`;
      window.location.href = `/sign-in?redirect=${encodeURIComponent(next)}`;
      return;
    }
    window.location.href = `/device/approve?user_code=${encodeURIComponent(formatted)}`;
  }

  return (
    <div className="panel" style={{ maxWidth: 420, margin: "0 auto" }}>
      <h1>Autorizar CLI</h1>
      <p>
        Introduce el código que muestra <code>chavez login</code>. Si no hay
        sesión, te llevaremos a sign-in (password o magic link) y volverás aquí.
      </p>
      <form onSubmit={onSubmit}>
        <label htmlFor="user_code">Código</label>
        <input
          id="user_code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
          placeholder="ABCD-1234"
        />
        <button type="submit" disabled={verify.isPending}>
          {verify.isPending ? "Verificando…" : "Continuar"}
        </button>
        {verify.isError && (
          <p className="error">{formatQueryError(verify.error)}</p>
        )}
      </form>
      <p className="muted" style={{ marginTop: "1rem", fontSize: "0.85rem" }}>
        API: <code>{env.public.apiUrl}</code>
      </p>
    </div>
  );
}

function DeviceApproveInner() {
  const q = useSearchParams();
  const code = (q.get("user_code") || "").replace(/-/g, "").toUpperCase();
  const action = useDeviceAction();
  const [okText, setOkText] = useState<string | null>(null);

  async function run(kind: "approve" | "deny", success: string) {
    setOkText(null);
    await action.mutateAsync({ action: kind, userCode: code });
    setOkText(success);
  }

  if (!code) {
    return (
      <div className="panel">
        <p className="error">Falta user_code</p>
        <a className="btn" href="/device">
          Volver
        </a>
      </div>
    );
  }

  return (
    <div className="panel" style={{ maxWidth: 420, margin: "0 auto" }}>
      <h1>Confirmar dispositivo</h1>
      <p>
        ¿Autorizar el CLI Chavez con el código <code>{code}</code>?
      </p>
      <button
        type="button"
        disabled={action.isPending}
        onClick={() =>
          run(
            "approve",
            "Dispositivo aprobado. Ya puedes volver al CLI.",
          )
        }
      >
        Aprobar
      </button>
      <button
        type="button"
        className="danger"
        style={{ marginTop: "0.5rem", width: "100%" }}
        disabled={action.isPending}
        onClick={() => run("deny", "Acceso denegado.")}
      >
        Denegar
      </button>
      {action.isError && (
        <p className="error">{formatQueryError(action.error)}</p>
      )}
      {okText && <p className="ok">{okText}</p>}
    </div>
  );
}

export function DeviceForm() {
  return (
    <AppProviders>
      <DeviceFormInner />
    </AppProviders>
  );
}

export function DeviceApprove() {
  return (
    <AppProviders>
      <DeviceApproveInner />
    </AppProviders>
  );
}

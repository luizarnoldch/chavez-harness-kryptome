import { useMemo, useState, type FormEvent } from "react";
import { AppProviders } from "./AppProviders";
import { env } from "../lib/config";
import {
  formatQueryError,
  useMagicLink,
  useMe,
  useSetPassword,
  useSignInEmail,
  useSignUpEmail,
} from "../lib/hooks";

type Mode = "signin" | "signup" | "magic";

function useSearchParams() {
  return useMemo(() => new URLSearchParams(window.location.search), []);
}

function redirectTarget(redirect: string): string {
  if (redirect.startsWith("http")) return redirect;
  return redirect.startsWith("/") ? redirect : `/${redirect}`;
}

function callbackUrl(redirect: string): string {
  const path = redirectTarget(redirect);
  if (path.startsWith("http")) return path;
  return `${env.public.webUrl.replace(/\/$/, "")}${path}`;
}

function SignInFormInner() {
  const q = useSearchParams();
  const redirect = q.get("redirect") || "/";
  const sentFromQuery = q.get("sent") === "1";
  const emailFromQuery = q.get("email") || "";
  const initialMode: Mode =
    q.get("mode") === "signup"
      ? "signup"
      : q.get("mode") === "magic" || sentFromQuery
        ? "magic"
        : "signin";

  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState(emailFromQuery);
  const [password, setPassword] = useState("");
  const [sentEmail, setSentEmail] = useState(
    sentFromQuery ? emailFromQuery : "",
  );
  const [setPw, setSetPw] = useState("");
  const [setPwMsg, setSetPwMsg] = useState<string | null>(null);

  const me = useMe();
  const magic = useMagicLink();
  const signIn = useSignInEmail();
  const signUp = useSignUpEmail();
  const setPasswordMut = useSetPassword();

  const pending =
    magic.isPending || signIn.isPending || signUp.isPending;

  function goAfterAuth() {
    window.location.href = redirectTarget(redirect);
  }

  async function onPassword(e: FormEvent) {
    e.preventDefault();
    const normalized = email.trim().toLowerCase();
    if (mode === "signup") {
      await signUp.mutateAsync({
        email: normalized,
        password,
        name: normalized.split("@")[0] || "Chavez user",
      });
    } else {
      await signIn.mutateAsync({ email: normalized, password });
    }
    goAfterAuth();
  }

  async function onMagic(e: FormEvent) {
    e.preventDefault();
    const normalized = email.trim().toLowerCase();
    await magic.mutateAsync({
      email: normalized,
      callbackURL: callbackUrl(redirect),
      name: normalized.split("@")[0] || "Chavez user",
    });
    setSentEmail(normalized);
  }

  async function onSetPassword(e: FormEvent) {
    e.preventDefault();
    setSetPwMsg(null);
    try {
      await setPasswordMut.mutateAsync(setPw);
      setSetPw("");
      setSetPwMsg("Contraseña definida. Ya puedes entrar con email + password.");
    } catch (err) {
      setSetPwMsg(formatQueryError(err));
    }
  }

  const showSent =
    Boolean(sentEmail) || (sentFromQuery && Boolean(emailFromQuery));
  const formError =
    (mode === "magic" ? magic.error : null) ||
    (mode === "signup" ? signUp.error : signIn.error);

  if (me.data && !me.isLoading) {
    return (
      <div className="panel" style={{ maxWidth: 420, margin: "0 auto" }}>
        <h1>Sesión activa</h1>
        <p className="ok">
          {me.data.email || me.data.name || me.data.id}
        </p>
        <p className="muted">
          Misma cuenta que el CLI (mismo email). Puedes definir contraseña si
          entraste solo con magic link.
        </p>
        <form onSubmit={onSetPassword} style={{ marginTop: "1rem" }}>
          <label htmlFor="set-password">Definir / añadir contraseña</label>
          <input
            id="set-password"
            type="password"
            minLength={8}
            required
            value={setPw}
            onChange={(e) => setSetPw(e.target.value)}
            autoComplete="new-password"
            placeholder="mín. 8 caracteres"
          />
          <button type="submit" disabled={setPasswordMut.isPending}>
            {setPasswordMut.isPending ? "Guardando…" : "Guardar contraseña"}
          </button>
          {setPwMsg && (
            <p
              className={
                setPasswordMut.isError || /ya|error|fail/i.test(setPwMsg)
                  ? "error"
                  : "ok"
              }
            >
              {setPwMsg}
            </p>
          )}
        </form>
        <a className="btn" href={redirectTarget(redirect)} style={{ marginTop: "1rem" }}>
          Continuar
        </a>
      </div>
    );
  }

  return (
    <div className="panel" style={{ maxWidth: 420, margin: "0 auto" }}>
      <h1>Entrar</h1>
      <p>
        Email + contraseña en la web, o magic link (CLI y web). El mismo correo
        es la misma cuenta.
      </p>
      <p className="muted">
        API: <code>{env.public.apiUrl}</code>
      </p>

      <div className="auth-tabs" role="tablist">
        <button
          type="button"
          className={mode === "signin" ? "auth-tab active" : "auth-tab"}
          onClick={() => setMode("signin")}
        >
          Password
        </button>
        <button
          type="button"
          className={mode === "signup" ? "auth-tab active" : "auth-tab"}
          onClick={() => setMode("signup")}
        >
          Crear cuenta
        </button>
        <button
          type="button"
          className={mode === "magic" ? "auth-tab active" : "auth-tab"}
          onClick={() => setMode("magic")}
        >
          Magic link
        </button>
      </div>

      {mode === "magic" ? (
        showSent ? (
          <>
            <p className="ok">
              Se envió un enlace a {sentEmail || emailFromQuery}. Ábrelo para
              entrar (crea la cuenta la primera vez).
            </p>
            <a className="btn" href={redirectTarget(redirect)}>
              Continuar
            </a>
          </>
        ) : (
          <form onSubmit={onMagic}>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="tu@email.com"
              autoComplete="email"
            />
            <button type="submit" disabled={pending}>
              {magic.isPending ? "Enviando…" : "Enviar magic link"}
            </button>
          </form>
        )
      ) : (
        <form onSubmit={onPassword}>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="tu@email.com"
            autoComplete="email"
          />
          <label htmlFor="password">Contraseña</label>
          <input
            id="password"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={
              mode === "signup" ? "new-password" : "current-password"
            }
          />
          <button type="submit" disabled={pending}>
            {pending
              ? "…"
              : mode === "signup"
                ? "Crear cuenta"
                : "Iniciar sesión"}
          </button>
          {mode === "signup" && (
            <p className="muted" style={{ fontSize: "0.85rem" }}>
              Si ya entraste con magic link, inicia sesión allí y define
              contraseña; no uses “Crear cuenta” de nuevo.
            </p>
          )}
        </form>
      )}

      {formError && (
        <p className="error">{formatQueryError(formError)}</p>
      )}
    </div>
  );
}

export function SignInForm() {
  return (
    <AppProviders>
      <SignInFormInner />
    </AppProviders>
  );
}

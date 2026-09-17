import { AppProviders } from "./AppProviders";
import { formatQueryError, useMe, useSignOut } from "../lib/hooks";

function NavAuthInner() {
  const me = useMe();
  const signOut = useSignOut();

  if (me.isLoading) {
    return <span className="muted">…</span>;
  }

  if (me.data) {
    return (
      <span className="nav-session">
        <span className="muted" title={me.data.id}>
          {me.data.email || me.data.name || "sesión"}
        </span>
        <button
          type="button"
          className="nav-link-btn"
          disabled={signOut.isPending}
          onClick={() => {
            void signOut.mutateAsync().then(() => {
              window.location.href = "/sign-in";
            });
          }}
        >
          {signOut.isPending ? "…" : "Salir"}
        </button>
        {signOut.isError && (
          <span className="error">{formatQueryError(signOut.error)}</span>
        )}
      </span>
    );
  }

  return <a href="/sign-in">Sign in</a>;
}

export function NavAuth() {
  return (
    <AppProviders notifications={false}>
      <NavAuthInner />
    </AppProviders>
  );
}

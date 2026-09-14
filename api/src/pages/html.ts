function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} · Chavez</title>
  <style>
    :root {
      --bg: #0f1419;
      --fg: #e7ecf1;
      --muted: #9aa7b5;
      --accent: #3d9a78;
      --panel: #1a222c;
      --border: #2a3542;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Segoe UI", system-ui, sans-serif;
      background: radial-gradient(1200px 600px at 10% -10%, #1d3a32, transparent),
                  radial-gradient(900px 500px at 100% 0%, #243044, transparent),
                  var(--bg);
      color: var(--fg);
      display: grid;
      place-items: center;
      padding: 2rem;
    }
    main {
      width: min(420px, 100%);
      background: color-mix(in srgb, var(--panel) 92%, transparent);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 1.75rem;
    }
    h1 { font-size: 1.35rem; margin: 0 0 0.35rem; }
    p { color: var(--muted); line-height: 1.45; }
    label { display: block; margin: 1rem 0 0.35rem; font-size: 0.9rem; }
    input, select, textarea {
      width: 100%;
      padding: 0.7rem 0.8rem;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: #12181f;
      color: var(--fg);
    }
    button, .btn {
      margin-top: 1.1rem;
      width: 100%;
      padding: 0.75rem 1rem;
      border: 0;
      border-radius: 8px;
      background: var(--accent);
      color: white;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      display: inline-block;
      text-align: center;
    }
    .error { color: #ff8f8f; margin-top: 0.75rem; }
    .ok { color: #8fefc0; margin-top: 0.75rem; }
    code { color: #b7d7ff; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    ${body}
  </main>
</body>
</html>`;
}

export function signInPage(redirect = "/device"): string {
  const safeRedirect = encodeURIComponent(redirect);
  return layout(
    "Sign in",
    `<p>Te enviaremos un magic link a tu correo para iniciar sesión.</p>
    <form method="post" action="/sign-in">
      <input type="hidden" name="redirect" value="${redirect.replace(/"/g, "&quot;")}" />
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required placeholder="tu@email.com" />
      <button type="submit">Enviar magic link</button>
    </form>
    <p style="margin-top:1rem;font-size:0.85rem">Tras abrir el link del correo, continúa el flujo del dispositivo si no redirige solo.</p>
    <script>
      // keep redirect available for clientside helpers
      window.__chavezRedirect = decodeURIComponent("${safeRedirect}");
    </script>`
  );
}

export function signInSentPage(email: string, redirect: string): string {
  return layout(
    "Revisa tu email",
    `<p>Se envió un enlace a <strong>${email}</strong>. Ábrelo para completar el inicio de sesión.</p>
     <p><a class="btn" href="${redirect}">Continuar</a></p>`
  );
}

export function devicePage(userCode = ""): string {
  return layout(
    "Autorizar CLI",
    `<p>Introduce el código que muestra <code>chavez login</code>.</p>
    <form id="device-form">
      <label for="user_code">Código</label>
      <input id="user_code" name="user_code" value="${userCode.replace(/"/g, "&quot;")}" required placeholder="ABCD-1234" />
      <button type="submit">Continuar</button>
      <p id="msg" class="error" hidden></p>
    </form>
    <script>
      const form = document.getElementById("device-form");
      const msg = document.getElementById("msg");
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        msg.hidden = true;
        const raw = document.getElementById("user_code").value.trim();
        const formatted = raw.replace(/-/g, "").toUpperCase();
        const sessionRes = await fetch("/api/auth/get-session", { credentials: "include" });
        const session = await sessionRes.json();
        if (!session?.user) {
          const next = "/device?user_code=" + encodeURIComponent(formatted);
          window.location.href = "/sign-in?redirect=" + encodeURIComponent(next);
          return;
        }
        const verify = await fetch("/api/auth/device?user_code=" + encodeURIComponent(formatted), {
          credentials: "include",
        });
        if (!verify.ok) {
          msg.textContent = "Código inválido o expirado";
          msg.hidden = false;
          return;
        }
        window.location.href = "/device/approve?user_code=" + encodeURIComponent(formatted);
      });
    </script>`
  );
}

export function deviceApprovePage(userCode: string): string {
  return layout(
    "Confirmar dispositivo",
    `<p>¿Autorizar el CLI Chavez con el código <code>${userCode}</code>?</p>
     <button id="approve" type="button">Aprobar</button>
     <button id="deny" type="button" style="background:#7a3b3b;margin-top:0.5rem">Denegar</button>
     <p id="msg" hidden></p>
     <script>
       const code = ${JSON.stringify(userCode)};
       const msg = document.getElementById("msg");
       async function act(path, okText) {
         const res = await fetch("/api/auth/" + path, {
           method: "POST",
           credentials: "include",
           headers: { "content-type": "application/json" },
           body: JSON.stringify({ userCode: code }),
         });
         const data = await res.json().catch(() => ({}));
         msg.hidden = false;
         if (!res.ok) {
           msg.className = "error";
           msg.textContent = data.message || data.error || "Error";
           return;
         }
         msg.className = "ok";
         msg.textContent = okText;
       }
       document.getElementById("approve").onclick = () => act("device/approve", "Dispositivo aprobado. Ya puedes volver al CLI.");
       document.getElementById("deny").onclick = () => act("device/deny", "Acceso denegado.");
     </script>`
  );
}

export function linkProviderPage(provider: string): string {
  const title = provider === "cursor" ? "Vincular Cursor" : "Vincular Claude";
  const hint =
    provider === "cursor"
      ? "Pega tu Cursor API key."
      : `Para OAuth de suscripción usa el CLI: <code>chavez provider link claude</code> (ejecuta <code>claude setup-token</code>).<br/>Aquí solo puedes guardar una <strong>API key</strong> de Console.`;
  return layout(
    title,
    `<p>${hint}</p>
     <form id="link-form">
       <input type="hidden" id="authKind" value="api_key" />
       <label for="secret">API key</label>
       <textarea id="secret" rows="4" required placeholder="sk-..."></textarea>
       <button type="submit">Guardar en vault</button>
       <p id="msg" hidden></p>
     </form>
     <script>
       const provider = ${JSON.stringify(provider)};
       const form = document.getElementById("link-form");
       const msg = document.getElementById("msg");
       form.addEventListener("submit", async (e) => {
         e.preventDefault();
         msg.hidden = true;
         const token = new URLSearchParams(location.search).get("token");
         const headers = { "content-type": "application/json" };
         if (token) headers["authorization"] = "Bearer " + token;
         const res = await fetch("/providers/" + provider + "/credentials", {
           method: "PUT",
           credentials: "include",
           headers,
           body: JSON.stringify({
             authKind: "api_key",
             secret: document.getElementById("secret").value,
           }),
         });
         const data = await res.json().catch(() => ({}));
         msg.hidden = false;
         if (!res.ok) {
           msg.className = "error";
           msg.textContent = data.error || "No se pudo guardar";
           if (res.status === 401) {
             msg.textContent += " — inicia sesión con chavez login primero.";
           }
           return;
         }
         msg.className = "ok";
         msg.textContent = "Credenciales guardadas. Ya puedes cerrar esta pestaña.";
       });
     </script>`
  );
}

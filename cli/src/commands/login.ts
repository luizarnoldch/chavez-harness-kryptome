import { createAuthClient } from "better-auth/client";
import { deviceAuthorizationClient } from "better-auth/client/plugins";
import open from "open";
import { loadConfig, saveConfig } from "../config";
import { apiFetch } from "../api-client";
import { formatOnboardingHint } from "../onboarding/print";
import type { OnboardingSnapshot } from "../onboarding/status";

const CLIENT_ID = "chavez-cli";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function loginCommand(): Promise<void> {
  const config = loadConfig();
  const authClient = createAuthClient({
    baseURL: config.apiUrl,
    plugins: [deviceAuthorizationClient()],
  });

  console.log("Solicitando código de dispositivo...");
  console.log(
    "En el navegador: inicia sesión (magic link o email+password) y aprueba el dispositivo.",
  );
  const { data, error } = await authClient.device.code({
    client_id: CLIENT_ID,
    scope: "openid profile email",
  });

  if (error || !data) {
    throw new Error(
      error?.error_description || error?.message || "No se pudo obtener device code"
    );
  }

  const {
    device_code,
    user_code,
    verification_uri,
    verification_uri_complete,
    interval = 5,
    expires_in,
  } = data as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    interval?: number;
    expires_in?: number;
  };

  const url =
    verification_uri_complete ||
    `${verification_uri}${verification_uri.includes("?") ? "&" : "?"}user_code=${encodeURIComponent(user_code)}`;

  console.log("");
  console.log(`Abre: ${url}`);
  console.log(`Código: ${user_code}`);
  console.log(
    "Si no tienes sesión web, usa /sign-in (password o magic link) y vuelve a aprobar.",
  );
  console.log("");

  try {
    await open(url);
  } catch {
    console.log("(No se pudo abrir el navegador automáticamente)");
  }

  const deadline = Date.now() + (expires_in ?? 900) * 1000;
  let pollMs = Math.max(interval, 1) * 1000;

  while (Date.now() < deadline) {
    await sleep(pollMs);
    const tokenRes = await authClient.device.token({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code,
      client_id: CLIENT_ID,
    });

    if (tokenRes.data?.access_token) {
      saveConfig({
        apiUrl: config.apiUrl,
        accessToken: tokenRes.data.access_token,
      });
      console.log("Login correcto. Sesión guardada en ~/.chavez/config.json");
      try {
        const snap = await apiFetch<OnboardingSnapshot>("/me/onboarding");
        const hint = formatOnboardingHint(snap);
        if (hint) {
          console.log("");
          console.log(hint);
        }
      } catch {
        console.log("");
        console.log("Siguiente paso: chavez provider link claude");
        console.log(
          "Luego: chavez tui   (o: chavez headless workspace open)",
        );
      }
      return;
    }

    const err = tokenRes.error as
      | { error?: string; error_description?: string }
      | undefined;
    const code = err?.error;
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      pollMs += 5000;
      continue;
    }
    if (code === "access_denied") {
      throw new Error("Acceso denegado en el navegador");
    }
    if (code === "expired_token") {
      throw new Error("El código expiró; vuelve a ejecutar chavez login");
    }
    if (code) {
      throw new Error(err?.error_description || code);
    }
  }

  throw new Error("Tiempo de espera agotado");
}

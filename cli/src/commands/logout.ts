import { clearConfig, configPath } from "../config";

export async function logoutCommand(): Promise<void> {
  clearConfig();
  console.log(`Sesión eliminada (${configPath()})`);
}

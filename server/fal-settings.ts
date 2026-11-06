import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const windows = process.platform === "win32";
const keyFile = windows
  ? path.join(process.env.LOCALAPPDATA || homedir(), "MinervAI", "fal-key.xml")
  : path.join(homedir(), ".config", "MinervAI", "fal-key");

function powershell(script: string, input: string) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; " + script], {
    input, encoding: "utf8", windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

export class FalSettings {
  private key = process.env.FAL_KEY?.trim() || "";
  constructor(private file = keyFile) {
    if (this.key || !existsSync(file)) return;
    try {
      const stored = readFileSync(file, "utf8").trim();
      this.key = windows
        ? powershell("$secret = [System.Management.Automation.PSSerializer]::Deserialize([Console]::In.ReadToEnd()); [Console]::Write([System.Net.NetworkCredential]::new('', $secret).Password)", stored)
        : stored.trim();
    } catch {
      console.warn("Não foi possível ler a chave local da fal.ai.");
    }
  }
  get value() {
    return this.key;
  }
  save(key: string) {
    const stored = windows
      ? powershell("$secret = [System.Security.SecureString]::new(); foreach ($character in [Console]::In.ReadToEnd().ToCharArray()) { $secret.AppendChar($character) }; [Console]::Write([System.Management.Automation.PSSerializer]::Serialize($secret))", key)
      : key;
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = this.file + ".tmp";
    try {
      writeFileSync(temp, stored, { mode: 0o600 });
      renameSync(temp, this.file);
    } finally {
      rmSync(temp, { force: true });
    }
    this.key = key;
  }
}

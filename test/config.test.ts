import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_BASE_URL, DEFAULT_KEY_FILE, expandHome, loadConfig } from "../src/config.js";

const HOME = "/home/someone";

describe("expandHome", () => {
  it("expands a leading ~ and nothing else", () => {
    expect(expandHome("~/.achromat/key.pem", HOME)).toBe(join(HOME, ".achromat/key.pem"));
    expect(expandHome("~", HOME)).toBe(HOME);
    expect(expandHome("/etc/key.pem", HOME)).toBe("/etc/key.pem");
    expect(expandHome("relative/key.pem", HOME)).toBe("relative/key.pem");
    expect(expandHome("/data/~/key.pem", HOME)).toBe("/data/~/key.pem");
    expect(expandHome("~other/key.pem", HOME)).toBe("~other/key.pem");
  });

  it("uses the real home directory by default", () => {
    expect(expandHome("~/x")).toBe(resolve(homedir(), "x"));
  });
});

describe("loadConfig", () => {
  it("defaults to the production service and ~/.achromat/achromat_agent_key.pem", () => {
    const config = loadConfig({}, HOME);
    expect(config.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(DEFAULT_KEY_FILE).toBe("~/.achromat/achromat_agent_key.pem");
    expect(config.keyFile).toBe(join(HOME, ".achromat", "achromat_agent_key.pem"));
  });

  it("takes the key path from ACHROMAT_AGENT_KEY_FILE, expanding ~ and trimming", () => {
    expect(loadConfig({ ACHROMAT_AGENT_KEY_FILE: "  ~/keys/mine.pem  " }, HOME).keyFile).toBe(join(HOME, "keys/mine.pem"));
    expect(loadConfig({ ACHROMAT_AGENT_KEY_FILE: "/abs/key.pem" }, HOME).keyFile).toBe("/abs/key.pem");
  });

  it("falls back to the default when the variable is empty or blank", () => {
    for (const value of ["", "   "]) expect(loadConfig({ ACHROMAT_AGENT_KEY_FILE: value }, HOME).keyFile).toBe(join(HOME, ".achromat", "achromat_agent_key.pem"));
  });

  it("does not read the old variable name", () => {
    expect(loadConfig({ ACHROMAT_KEY_FILE: "/old/key.pem" }, HOME).keyFile).toBe(join(HOME, ".achromat", "achromat_agent_key.pem"));
  });

  it("accepts an https service, normalised to its origin", () => {
    expect(loadConfig({ ACHROMAT_BASE_URL: "https://mom.example.test/some/path/" }, HOME).baseUrl).toBe("https://mom.example.test");
  });

  it("accepts plain http only for localhost", () => {
    expect(loadConfig({ ACHROMAT_BASE_URL: "http://localhost:8787" }, HOME).baseUrl).toBe("http://localhost:8787");
    expect(loadConfig({ ACHROMAT_BASE_URL: "http://127.0.0.1:8787" }, HOME).baseUrl).toBe("http://127.0.0.1:8787");
    expect(() => loadConfig({ ACHROMAT_BASE_URL: "http://mom.example.test" }, HOME)).toThrow(/https/);
  });

  it("rejects a value that is not a URL, and other schemes", () => {
    expect(() => loadConfig({ ACHROMAT_BASE_URL: "not a url" }, HOME)).toThrow(/not a valid URL/);
    expect(() => loadConfig({ ACHROMAT_BASE_URL: "file:///etc/passwd" }, HOME)).toThrow(/https/);
    expect(() => loadConfig({ ACHROMAT_BASE_URL: "javascript:alert(1)" }, HOME)).toThrow();
  });
});

/**
 * Release metadata. The npm package and the MCP Registry listing are published separately, with their own version
 * numbers, and a listing is only valid while it points at an npm version that exists. These checks catch the drift that
 * would otherwise show up as a rejected publish or a listing that points at the wrong code.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_BASE_URL } from "../src/config.js";

const read = (name: string) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));
const pkg = read("package.json");
const server = read("server.json");
const lock = read("package-lock.json");

describe("package.json", () => {
  it("is 0.1.5, and the lockfile agrees in both places", () => {
    expect(pkg.version).toBe("0.1.5");
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""].version).toBe(pkg.version);
  });

  it("points its homepage at the canonical site, not at the repository readme", () => {
    expect(pkg.homepage).toBe("https://achromat.ai");
    expect(pkg.homepage).toBe(DEFAULT_BASE_URL);
    expect(pkg.repository.url).toContain("github.com/achromat-ai/achromat-mcp-server");
    expect(pkg.bugs.url).toContain("github.com/achromat-ai/achromat-mcp-server");
  });

  it("uses the full product name in its description", () => {
    expect(pkg.description).toContain("Achromat Machine Operational Memory");
    expect(pkg.description).not.toMatch(/Achromat MOM\b/);
  });
});

describe("server.json (the MCP Registry listing)", () => {
  it("is listing 0.1.6, and points at the npm version this repository publishes", () => {
    expect(server.version).toBe("0.1.6");
    expect(server.packages[0].identifier).toBe(pkg.name);
    expect(server.packages[0].version).toBe(pkg.version);
  });

  it("carries the registry's own rules: a matching mcpName, a description of at most 100 characters, the canonical origin", () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.title).toBe("Achromat Machine Operational Memory");
    expect(server.websiteUrl).toBe("https://achromat.ai");
    expect(server.remotes[0].url).toBe("https://achromat.ai/mcp");
    const base = server.packages[0].environmentVariables.find((variable: { name: string }) => variable.name === "ACHROMAT_BASE_URL");
    expect(base.default).toBe(DEFAULT_BASE_URL);
  });

  it("documents every environment variable the package reads, and says where ACHROMAT_REF is sent", () => {
    const names = server.packages[0].environmentVariables.map((variable: { name: string }) => variable.name).sort();
    expect(names).toEqual(["ACHROMAT_AGENT_KEY_FILE", "ACHROMAT_BASE_URL", "ACHROMAT_REF"]);
    const ref = server.packages[0].environmentVariables.find((variable: { name: string }) => variable.name === "ACHROMAT_REF");
    expect(ref.description).toMatch(/without an identity/);
  });
});

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { collectTrustedCertificateAuthorities, installTrustedCertificateAuthorities, TRUSTED_CA_ENV } from "../trusted-ca/index.js";
import { BUNDLED_TRUSTED_CA_CERTIFICATES } from "../trusted-ca/bundled.js";

const fixtures = path.join(import.meta.dirname, "fixtures", "trusted-ca");
const rootCa = readFileSync(path.join(fixtures, "test-root-ca.pem"), "utf8");
const serverCertificate = readFileSync(path.join(fixtures, "localhost.pem"), "utf8");

function connect(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = tls.connect({ host: "127.0.0.1", port, servername: "localhost" });
    socket.once("secureConnect", () => { resolve(socket.authorized); socket.end(); });
    socket.once("error", () => resolve(false));
  });
}

describe("trusted certificate authorities", () => {
  const defaults = tls.getCACertificates("default");
  let server: Server;
  let port: number;
  let dir: string;

  beforeAll(async () => {
    server = createServer({ cert: serverCertificate, key: readFileSync(path.join(fixtures, "localhost.key")) }, (_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  afterEach(() => {
    tls.setDefaultCACertificates(defaults);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("trusts a bundled CA in this process and exports it to Git and child processes", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "paperclip-trusted-ca-"));
    expect(await connect(port)).toBe(false);
    const env: NodeJS.ProcessEnv = {};
    const result = installTrustedCertificateAuthorities({ env, outputDir: dir, bundled: [rootCa] });
    expect(result.authorities).toEqual([expect.objectContaining({ subject: "CN=Paperclip Test Root CA", source: "bundled certificate 1" })]);
    expect(await connect(port)).toBe(true);
    expect(env.NODE_EXTRA_CA_CERTS).toBe(path.join(dir, "extra-ca.pem"));
    expect(env.GIT_SSL_CAINFO).toBe(path.join(dir, "ca-bundle.pem"));
    expect(env.SSL_CERT_FILE).toBe(env.GIT_SSL_CAINFO);
    // The Git bundle still holds the public roots, so other hosts keep working.
    const bundle = readFileSync(env.GIT_SSL_CAINFO!, "utf8");
    expect(bundle).toContain(rootCa.trim().split("\n")[1]);
    expect(bundle.match(/BEGIN CERTIFICATE/g)!.length).toBeGreaterThan(100);
    // A child Node process trusts the CA through the exported environment.
    // Async, so this process keeps serving the TLS handshake.
    const { stdout: child } = await promisify(execFile)(process.execPath, ["-e", `require("tls").connect({host:"127.0.0.1",port:${port},servername:"localhost"}).on("secureConnect",function(){console.log(this.authorized);this.end()}).on("error",e=>console.log(e.code))`], {
      env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: env.NODE_EXTRA_CA_CERTS },
      timeout: 10_000,
    });
    expect(child.trim()).toBe("true");
    // Git completes the TLS handshake with the exported bundle (the test server is not a Git
    // server, so the command still fails, but never on the certificate).
    const gitStderr = async (extra: NodeJS.ProcessEnv) => promisify(execFile)("git", ["ls-remote", `https://localhost:${port}/team/tool.git`], {
      env: { PATH: process.env.PATH, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", HOME: dir, ...extra }, timeout: 10_000,
    }).then(() => "", (error: { stderr?: string }) => error.stderr ?? "");
    expect(await gitStderr({})).toMatch(/certificate|SSL/i);
    expect(await gitStderr({ GIT_SSL_CAINFO: env.GIT_SSL_CAINFO })).not.toMatch(/certificate|SSL/i);
  });

  it("reads extra CA files and directories from the environment and keeps existing child settings", () => {
    dir = mkdtempSync(path.join(tmpdir(), "paperclip-trusted-ca-"));
    const caDir = path.join(dir, "cas");
    mkdirSync(caDir);
    writeFileSync(path.join(caDir, "root.crt"), rootCa);
    writeFileSync(path.join(caDir, "notes.txt"), "ignored");
    const existing = path.join(dir, "existing.pem");
    writeFileSync(existing, rootCa);
    const env: NodeJS.ProcessEnv = { [TRUSTED_CA_ENV]: [caDir, path.join(dir, "missing.pem")].join(path.delimiter), NODE_EXTRA_CA_CERTS: existing };
    const result = installTrustedCertificateAuthorities({ env, outputDir: path.join(dir, "out"), bundled: [] });
    expect(result.authorities).toHaveLength(1);
    expect(result.warnings).toEqual([expect.stringContaining("missing.pem could not be read")]);
    expect(readFileSync(env.NODE_EXTRA_CA_CERTS!, "utf8").match(/BEGIN CERTIFICATE/g)).toHaveLength(1);
  });

  it("ships only valid CA certificates in the build", () => {
    const { authorities, warnings } = collectTrustedCertificateAuthorities(
      BUNDLED_TRUSTED_CA_CERTIFICATES.map((text, index) => ({ source: `bundled certificate ${index + 1}`, text })));
    expect(warnings).toEqual([]);
    expect(authorities).toHaveLength(BUNDLED_TRUSTED_CA_CERTIFICATES.length);
  });

  it("does nothing without extra CAs and skips server certificates and garbage", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(installTrustedCertificateAuthorities({ env, outputDir: "/nonexistent", bundled: [] })).toEqual({ authorities: [], warnings: [] });
    expect(env).toEqual({});
    const { authorities, warnings } = collectTrustedCertificateAuthorities([
      { source: "leaf", text: serverCertificate },
      { source: "garbage", text: "not a certificate" },
      { source: "twice", text: `${rootCa}\n${rootCa}` },
    ]);
    expect(authorities.map((authority) => authority.source)).toEqual(["twice"]);
    expect(warnings).toEqual([
      expect.stringContaining("is a server certificate, not a CA"),
      "garbage: no PEM certificate found",
    ]);
  });
});

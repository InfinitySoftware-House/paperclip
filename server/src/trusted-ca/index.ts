import { X509Certificate } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { BUNDLED_TRUSTED_CA_CERTIFICATES } from "./bundled.js";

/**
 * Extra certificate authorities for outbound TLS: the CAs compiled into the build
 * (`bundled.ts`) plus PEM files or directories listed in `PAPERCLIP_TRUSTED_CA_CERTS`.
 *
 * They are added to Node's default trust store for this process, and written to
 * files that child processes inherit through the environment:
 * - `NODE_EXTRA_CA_CERTS`: the extra CAs, for Node-based agent CLIs;
 * - `SSL_CERT_FILE` and `GIT_SSL_CAINFO`: a full bundle (Node's roots, the OS store,
 *   any bundle already configured, and the extra CAs) for OpenSSL tools and Git, whose
 *   setting replaces rather than extends their default store.
 * Verification stays on everywhere; nothing here trusts an unknown certificate.
 */

export const TRUSTED_CA_ENV = "PAPERCLIP_TRUSTED_CA_CERTS";

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const CERTIFICATE_FILE = /\.(?:pem|crt|cer)$/i;

export type TrustedCertificateAuthority = { subject: string; fingerprint256: string; source: string };

export type TrustedCaInstallResult = {
  authorities: TrustedCertificateAuthority[];
  warnings: string[];
  bundlePath?: string;
};

type Logger = { info(message: string): void; warn(message: string): void };

function pemBlocks(text: string) {
  return text.match(PEM_BLOCK) ?? [];
}

function readFileIfPresent(filePath: string | undefined) {
  if (!filePath) return "";
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function configuredSources(value: string | undefined, warnings: string[]) {
  const sources: Array<{ source: string; text: string }> = [];
  for (const entry of (value ?? "").split(path.delimiter).map((item) => item.trim()).filter(Boolean)) {
    try {
      const files = statSync(entry).isDirectory()
        ? readdirSync(entry).filter((name) => CERTIFICATE_FILE.test(name)).sort().map((name) => path.join(entry, name))
        : [entry];
      for (const file of files) sources.push({ source: file, text: readFileSync(file, "utf8") });
    } catch {
      warnings.push(`${TRUSTED_CA_ENV}: ${entry} could not be read`);
    }
  }
  return sources;
}

/** Valid, unexpired certificates from the given sources, without duplicates. */
export function collectTrustedCertificateAuthorities(
  sources: ReadonlyArray<{ source: string; text: string }>,
  now = new Date(),
) {
  const authorities: Array<TrustedCertificateAuthority & { pem: string }> = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const { source, text } of sources) {
    const blocks = pemBlocks(text);
    if (blocks.length === 0) warnings.push(`${source}: no PEM certificate found`);
    for (const pem of blocks) {
      let certificate: X509Certificate;
      try {
        certificate = new X509Certificate(pem);
      } catch {
        warnings.push(`${source}: a certificate could not be parsed and was skipped`);
        continue;
      }
      const subject = certificate.subject.replace(/\n/g, ", ");
      if (new Date(certificate.validTo) < now) {
        warnings.push(`${source}: ${subject} expired on ${certificate.validTo} and was skipped`);
        continue;
      }
      // Version 1 roots carry no CA flag; a self-signed certificate is accepted as an anchor.
      if (!certificate.ca && !(certificate.subject === certificate.issuer && certificate.verify(certificate.publicKey))) {
        warnings.push(`${source}: ${subject} is a server certificate, not a CA, and was skipped`);
        continue;
      }
      if (seen.has(certificate.fingerprint256)) continue;
      seen.add(certificate.fingerprint256);
      authorities.push({ subject, fingerprint256: certificate.fingerprint256, source, pem: certificate.toString().trim() });
    }
  }
  return { authorities, warnings };
}

function storeCertificates(type: "default" | "system") {
  try {
    return tls.getCACertificates(type);
  } catch {
    return [];
  }
}

/**
 * Trust the extra CAs in this process and export them to child processes. A no-op when
 * none are configured, so default installs keep Node's and the tools' own stores.
 */
export function installTrustedCertificateAuthorities(input: {
  env?: NodeJS.ProcessEnv;
  outputDir: string;
  bundled?: readonly string[];
  log?: Logger;
}): TrustedCaInstallResult {
  const env = input.env ?? process.env;
  const readWarnings: string[] = [];
  const sources = [
    ...(input.bundled ?? BUNDLED_TRUSTED_CA_CERTIFICATES).map((text, index) => ({ source: `bundled certificate ${index + 1}`, text })),
    ...configuredSources(env[TRUSTED_CA_ENV], readWarnings),
  ];
  const { authorities, warnings } = collectTrustedCertificateAuthorities(sources);
  warnings.unshift(...readWarnings);
  for (const warning of warnings) input.log?.warn(`Trusted CA: ${warning}`);
  if (authorities.length === 0) return { authorities: [], warnings };

  const extra = authorities.map((authority) => authority.pem);
  tls.setDefaultCACertificates([...new Set([...storeCertificates("default"), ...extra])]);

  // Keep whatever the operator already configured for child processes, then add ours.
  const nodeExtra = [...pemBlocks(readFileIfPresent(env.NODE_EXTRA_CA_CERTS)), ...extra];
  const bundle = [
    ...storeCertificates("default"),
    ...storeCertificates("system"),
    ...pemBlocks(readFileIfPresent(env.SSL_CERT_FILE)),
    ...pemBlocks(readFileIfPresent(env.GIT_SSL_CAINFO)),
  ];
  mkdirSync(input.outputDir, { recursive: true });
  const extraPath = path.join(input.outputDir, "extra-ca.pem");
  const bundlePath = path.join(input.outputDir, "ca-bundle.pem");
  writeFileSync(extraPath, `${[...new Set(nodeExtra)].join("\n")}\n`, { mode: 0o644 });
  writeFileSync(bundlePath, `${[...new Set(bundle.map((pem) => pem.trim()))].join("\n")}\n`, { mode: 0o644 });
  env.NODE_EXTRA_CA_CERTS = extraPath;
  env.SSL_CERT_FILE = bundlePath;
  env.GIT_SSL_CAINFO = bundlePath;
  for (const authority of authorities) {
    input.log?.info(`Trusted CA: ${authority.subject} (SHA-256 ${authority.fingerprint256}) from ${authority.source}`);
  }
  return { authorities: authorities.map(({ pem: _pem, ...authority }) => authority), warnings, bundlePath };
}

# Trusted certificate authorities

Paperclip verifies the HTTPS certificate of every host it talks to. A
self-hosted service with a certificate from a private CA — for example a Gitea
or GitLab instance reachable over a VPN — fails with
`its HTTPS certificate is not trusted`. Instead of turning verification off,
add the private CA to Paperclip's trusted CAs.

## Compiled into the build (every install)

Add the CA certificate (PEM, public part only) to
`server/src/trusted-ca/bundled.ts`:

```ts
export const BUNDLED_TRUSTED_CA_CERTIFICATES: readonly string[] = [
  `-----BEGIN CERTIFICATE-----
MIID...
-----END CERTIFICATE-----`,
];
```

The certificates are part of the server source, so the dev server, `pnpm
build`, the runtime bundle, the Docker image and every install built from this
source trust them with no setup on the machine.

Only add CAs whose issuance you control. A trusted CA can vouch for any host
name, so a compromised CA key lets its holder impersonate any HTTPS site to
Paperclip and its agents. Never add private keys.

## Per install, without rebuilding

Set `PAPERCLIP_TRUSTED_CA_CERTS` to one or more PEM files or directories of
`.pem`/`.crt`/`.cer` files, separated by `:` (`;` on Windows):

```sh
PAPERCLIP_TRUSTED_CA_CERTS=/etc/paperclip/ca pnpm dev
```

## What trusts the CAs

At startup the server logs each trusted CA with its SHA-256 fingerprint and
skips (with a warning) unreadable files, expired certificates and server
certificates that are not CAs. With at least one CA configured:

- the server process trusts it for every outbound HTTPS request (Apps
  connections, GitLab/Gitea API, OAuth, remote MCP);
- processes the server starts on the same machine inherit
  - `NODE_EXTRA_CA_CERTS`, the extra CAs, for Node-based agent CLIs;
  - `GIT_SSL_CAINFO` and `SSL_CERT_FILE`, a full bundle of Node's public roots,
    the operating system store, any bundle already set in those variables, and
    the extra CAs, for Git, curl and other OpenSSL-based tools.

The files live in `<instance>/runtime/trusted-ca/` and are rewritten at every
start. Without extra CAs nothing changes and each tool keeps its own store.

## Limits

- Remote sandboxes and remote runners do not receive the CAs; configure them
  in the sandbox image.
- Tools with their own certificate store that ignore these variables (for
  example Python `requests`, which reads `REQUESTS_CA_BUNDLE`) need their own
  setting.

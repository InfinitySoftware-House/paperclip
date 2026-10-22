/**
 * Certificate authorities every Paperclip build trusts in addition to Node's
 * bundled roots, for example the CA of a self-hosted Gitea or GitLab reachable
 * over a VPN. They are compiled into the server, so every install, Docker image
 * and runtime bundle built from this source trusts them without setup.
 *
 * Add one PEM block per CA (`-----BEGIN CERTIFICATE----- ... -----END CERTIFICATE-----`).
 * Only public CA certificates belong here, never private keys. A CA added here
 * can vouch for any host name, so add only CAs whose issuance you control.
 * See doc/TRUSTED-CERTIFICATES.md.
 */
export const BUNDLED_TRUSTED_CA_CERTIFICATES: readonly string[] = [
  // C=IT, O=Delta3 Dev, CN=Delta3 Dev Root CA (X.509 v1 self-signed root), valid until 2036-10-11.
  // SHA-256 C5:F0:62:43:0F:D3:EC:27:DB:FC:A8:43:08:98:26:6C:8C:D8:77:F8:FB:E3:EC:BC:65:21:94:54:5F:9B:92:E4
  `-----BEGIN CERTIFICATE-----
MIIE+jCCAuICCQDn8W3EobprtjANBgkqhkiG9w0BAQsFADA/MQswCQYDVQQGEwJJ
VDETMBEGA1UECgwKRGVsdGEzIERldjEbMBkGA1UEAwwSRGVsdGEzIERldiBSb290
IENBMB4XDTI2MTAxNDIxNDcyOFoXDTM2MTAxMTIxNDcyOFowPzELMAkGA1UEBhMC
SVQxEzARBgNVBAoMCkRlbHRhMyBEZXYxGzAZBgNVBAMMEkRlbHRhMyBEZXYgUm9v
dCBDQTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAOvODzmqNTQwYq9p
oDaSzlJLfXOUJYjrcGUCTJTmhIzARIubxXEyOd5kkH36+1EgXWgT2hYjwPvk9rfI
h6eH8sUhnYYsu1XcDGG0YphRnsDn+fMdMQc8Y2vU0WCe7ivuKl3kj6/6+jIT0jOe
GZk2dQ12oXNJclU5Phv6BMTGl0oOiZ0shFXFRmmjokqTE2/wRyWdO0o1Fhjcm4l+
MMkHnFrsovxvZQw47OH++/21EAuR7PfQcwTdGOztDNZb5qRjqLJRuMqU7k/Ly5PS
+TwAOzTfFomhLAd1/f9N9fd9/STDgeC1eb/3c60/yjROLcBoFCgDExDrnIfVQX/G
3etaUEuQi2jNa6eSdi4h4OUTxucb+CC6/zACy/o3+QO48Ew/nZb2HHb6+EWIFafo
C0278TLChgIGyeReocx/Njfi0QsPT32/culd+HNo7Ljshr4tkk21SSA2wRT7Rxmz
BIiqewH6N4gy0/1hasjpd3OF4xoRNNJ3Nn1MGzo1EXQVVjrhWsk2uaKRXmv1M3Ba
BbhSuZ3OojS0nhGXR9Z6WjTj8d3ec2sFyEylfGfWXdC1yYklWDg+5pe62kGUh9kR
EZeqmwN83Cv8LLw5KCffC1odp6fuRnInPWaco1ftUen9f82Zxei0jBNRslr8zTnL
2Wc7ZLQtape0ZEyfjktFgaR6Kx/VAgMBAAEwDQYJKoZIhvcNAQELBQADggIBAML0
yJVnMUsb+uau9YnW/OGT0KhEeJ47N8XA9Zbee9ehsuFTFj6DwwxqmuFPBBiyEOSH
RQQGihXJHF5e0zMkislCTj4M30/1ODa0g9NbDzdex1Oe3Jrcdg+SYS1q23Q5EvUK
GCTQ1g+onb2ilDx1gxRbEPZ+ieYkiCzxtW76F2mb4x8sdA8n6sQc4wlbMWiiLcBP
g8JvIMBu5nk86GUKW6T26EF7vs++MR76w4aJYUOjmQrXhdKdPlnWlCjIUYm0fwHJ
UvhZoZMsQmpFABeqfowdNTK5KiL/8J0Mbt1AI/SPN7fKAUfNddDUMCVVsPHoCjqx
2s0ifd8+kvWVIfRLdVHT3fiNve9vn7/9VYdojIsm418sT9ESHq1Cl3FxPbpND624
JOoRrSLRGtOo8G0HAbkVS7Eul5wmtfRPLylaTH7+uFMY2p7rTXS9vUTNlBFzv5Qd
vfuJ+H6V80OJk3ngn5PzM+m1G7ECXOHa16r3WjG1cL+w/cKQ2ybip+l6UNvYGqoL
Ps2WErzyJELi4gVIpY+o/bf3oLYKp86rNwzYeWUndh51+A0mRsxNMBNf5KiAhRm1
G+W037HodFX1FZoQEcfqwUXL1FtZKhCuTlZMq/7uhrnwiB0tYTu/kAkItPSuR2TT
vpLlQoNlcUX4bCLUz93/d2aXNtOJA7pzVmyLa1Xq
-----END CERTIFICATE-----`,
];

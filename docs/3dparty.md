# Third-party services

Core standalone operation needs no paid SaaS. Optional integrations are enabled
only when their environment variables/settings are configured.

| Service | Purpose | Data boundary |
|---|---|---|
| Google Identity Services | Optional account login | Google ID token claims are verified by the relay; no client secret is used |
| GitHub OAuth/App | Optional repository integration | Access tokens are held by the trusted server |
| ElevenLabs | Optional voice assistant | Voice/session context selected by the feature may leave your relay |
| Web Push provider | Optional browser notification delivery | Push endpoint and notification payload metadata are sent to the browser push service |
| User-configured HTTPS webhook | Optional completion/permission notifications | Title/message/session identifiers are sent to the configured public endpoint |
| S3-compatible storage | Optional blob storage | Encrypted-format blobs are stored there; the relay remains able to recover account keys |

RevenueCat and upstream mobile subscription paths remain in legacy code but are
not required for the supported Web V2 + server + CLI product. This project does
not enable product analytics or telemetry by default; operators who add any must
document it to their users.

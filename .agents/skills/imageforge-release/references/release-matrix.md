# Release matrix

| Target | Artifact | Native verification |
| --- | --- | --- |
| macOS Apple silicon | `.app`, `.dmg` | Launch, onboarding, fake batch, folder reveal |
| Windows x64 | NSIS `Setup.exe` | Install, launch, WebView2, fake batch, folder reveal |

Every artifact requires SHA-256, version/commit metadata, and an explicit
signed/unsigned label.

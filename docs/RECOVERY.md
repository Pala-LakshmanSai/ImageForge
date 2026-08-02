# ImageForge recovery

The source of truth is the private GitHub repository:
`https://github.com/Pala-LakshmanSai/ImageForge`

## macOS

```sh
git clone https://github.com/Pala-LakshmanSai/ImageForge.git
cd ImageForge
npm ci
python3.11 -m venv worker/.venv
worker/.venv/bin/pip install -e 'worker[test]'
npm run typecheck
npm test -- --run --pool=forks --maxWorkers=1
```

Build caches can live on an external disk by sourcing
`scripts/use-usb-toolchain.sh`; the app itself does not depend on that disk.

## Windows

```powershell
git clone https://github.com/Pala-LakshmanSai/ImageForge.git
cd ImageForge
npm ci
npm run typecheck
npm test -- --run --pool=forks --maxWorkers=1
```

Use the latest GitHub Release installer for a normal user install. The native
app stores RunPod credentials in the operating-system vault; credentials are
never committed to this repository. Re-enter the RunPod API key and worker
token on a replacement computer, then use the fixed studio profile shown in
the app's setup screen.

The worker image is published as an immutable GHCR digest by the `publish-
worker` workflow. The RunPod network volume contains model weights and is a
separate service-side copy; it is not stored on the removable disk.

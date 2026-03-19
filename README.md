# ReplayVR

A browser-based Rocket League replay viewer with full WebXR support. Load a `.replay` file directly in the browser — no backend required. Watch your replays on desktop or inside a VR headset (Meta Quest, etc.).

**Live demo:** https://wesselwessels.github.io/replayvr/

---

## Features

- **Fully frontend** — replays are parsed in the browser via a WebAssembly Rust parser; nothing is uploaded to any server
- **WebXR** — works in a Meta Quest browser for an immersive in-arena experience
- **3D arena** — Rocket League field geometry with boost pads, goals, and scoreboards
- **Replay playback** — smooth interpolated ball and car movement, boost flames, positional audio (engine + boost sounds, ball hit sounds)
- **Timeline controls** — scrub, play/pause, skip ±5 s, jump to prev/next goal
- **Speed control** — 0.25×, 0.5×, 1×, 1.25×, 1.5×, 2×
- **Camera modes** (VR):
  - **Free** — fly anywhere with left thumbstick (move) + right thumbstick (rotate)
  - **Car cam** — 3rd-person follow cam behind a selected car
  - **Ball cam** — ride above the ball; ball becomes translucent
- **Desktop controls** — WASD to pan, Space/Shift to go up/down, click to capture mouse for look control (scroll to zoom)
- **Player labels** — name and boost percentage shown above each car
- **Live score** — scoreboard updates in real time as goals are scored, with kickoff countdown
- **VR control panel** — heads-up panel toggled with the Y button; mirrors all 2D timeline controls plus camera mode and player selection

---

## Getting started

### Prerequisites

| Tool | Minimum version | Install |
|------|----------------|---------|
| Node.js | 18 | https://nodejs.org |
| Rust | stable | https://rustup.rs |
| wasm-pack | latest | `curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf \| sh` |

### 1. Clone the repo

```bash
git clone git@github.com:WesselWessels/replayvr.git
cd replayvr
```

### 2. Build the WebAssembly parser

```bash
wasm-pack build parser --target bundler --out-dir ../src/wasm
```

This compiles the Rust replay parser (`parser/`) to WASM and writes the JS/WASM bindings into `src/wasm/`.

### 3. Install JS dependencies

```bash
npm install
```

### 4. Start the dev server

```bash
npm run dev
```

The dev server starts with HTTPS (required for WebXR). Open `https://localhost:5173` in your browser and accept the self-signed certificate warning.

---

## VR / headset access (local network)

WebXR requires HTTPS. To connect a Meta Quest (or other headset) on your local network, you need to forward the Vite dev server port from WSL2 to your Windows LAN IP.

Run the following in an **Administrator PowerShell on Windows**, replacing `<WSL_IP>` with the output of `ip addr show eth0` inside WSL:

```powershell
netsh interface portproxy add v4tov4 listenport=5173 listenaddress=0.0.0.0 connectport=5173 connectaddress=<WSL_IP>
netsh advfirewall firewall add rule name="WSL Vite 5173" dir=in action=allow protocol=TCP localport=5173
```

Then open `https://<your-windows-LAN-IP>:5173` in the Quest browser and accept the certificate.

To remove the rule when done:

```powershell
netsh interface portproxy delete v4tov4 listenport=5173 listenaddress=0.0.0.0
netsh advfirewall firewall delete rule name="WSL Vite 5173"
```

> The WSL2 internal IP can change on restart. If the headset can no longer connect, re-run the `portproxy add` command with the updated IP.

---

## Production build

```bash
npm run build
```

The output is written to `dist/`. It is a fully static site — serve it from any static host.

---

## Deployment (GitHub Pages)

Pushes to `main` automatically build and deploy via GitHub Actions (`.github/workflows/deploy.yml`). The workflow:

1. Checks out the code
2. Installs Rust (stable) with the `wasm32-unknown-unknown` target
3. Installs `wasm-pack` and builds the WASM parser
4. Runs `npm ci` and `npm run build`
5. Deploys `dist/` to GitHub Pages

No pre-built WASM artifacts are committed to the repository — everything is built fresh in CI.

---

## Project structure

```
replayvr/
├── parser/                 # Rust replay parser
│   └── src/
│       ├── lib.rs          # wasm-bindgen entry: parse_replay(&[u8]) -> String (JSON)
│       ├── main.rs         # CLI binary (reads file, prints JSON)
│       └── parse.rs        # Shared parsing logic (wraps the boxcars crate)
├── src/
│   ├── wasm/               # Generated wasm-pack output (not committed; built in CI)
│   ├── arena.js            # 3D arena geometry (field, walls, goals, boost pads)
│   ├── main.js             # App entry: UI wiring, timeline, file upload, render loop
│   ├── replayPlayer.js     # ReplayPlayer class: playback, camera modes, VR panel, audio
│   ├── scene.js            # Babylon.js scene setup, desktop camera + WASD controls, WebXR
│   └── style.css           # UI styles
├── .github/workflows/
│   └── deploy.yml          # GitHub Pages CI/CD
├── vite.config.js
└── package.json
```

---

## How it works

### Replay parsing

`.replay` files are Rocket League's proprietary binary format. The Rust [`boxcars`](https://crates.io/crates/boxcars) crate handles low-level decoding. The `parser/src/parse.rs` module extracts ball/car positions, rotations, boost values, boost pad states, and goal metadata, then serialises them to JSON. This is exposed to the browser via `wasm-bindgen` as `parse_replay(bytes: Uint8Array): string`.

### Coordinate system

Rocket League uses a right-handed coordinate system (X = right, Y = forward along field, Z = up). Babylon.js uses a left-handed system (X = right, Y = up, Z = forward). The conversion applied:

- Position: swap Y ↔ Z, then scale by `UU_SCALE` (Unreal units → metres)
- Rotation quaternion: swap `qy` ↔ `qz`, negate all imaginary components (handedness flip)

### Interpolation

The parser carries forward the last known actor state for every network frame, so consecutive frames are often identical. A keyframe index is built at load time containing only frames where the ball or car position actually changed. Playback interpolates (`lerp` / `slerp`) between the two keyframes bracketing the current time.

### Audio

All audio is synthesised via the Web Audio API — no audio files are needed.

- **Engine**: sawtooth oscillator → bandpass filter → gain → HRTF panner. Pitch scales with car speed (60 Hz idle → ~220 Hz at max speed).
- **Boost**: looped white noise → bandpass filter → gain → panner. Triggered whenever boost value decreases.
- **Ball hits**: classified as floor / wall / car bounce by velocity reversal analysis. Each type has a tuned bandpass-filtered noise burst.

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `@babylonjs/core` | 3D engine, WebXR |
| `@babylonjs/gui` | 2D/3D UI (labels, VR panel) |
| `boxcars` (Rust) | Rocket League replay decoding |
| `wasm-bindgen` (Rust) | Rust → WASM JS bindings |
| `vite-plugin-wasm` | Vite WASM bundling support |
| `@vitejs/plugin-basic-ssl` | Self-signed HTTPS for local WebXR dev |

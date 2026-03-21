# RL Viewer - Claude Notes

## Network / VR Headset Access

The local LAN is 192.168.1.x. WSL2 gets a 172.25.82.x internal IP which is
not directly reachable from the LAN (e.g. Meta Quest headset).

To expose the Vite dev server (port 5173) on the Windows 192.168.1.x interface,
run this in an **Administrator PowerShell on Windows**:

```powershell
netsh interface portproxy add v4tov4 listenport=5173 listenaddress=0.0.0.0 connectport=5173 connectaddress=172.25.82.244
netsh advfirewall firewall add rule name="WSL Vite 5173" dir=in action=allow protocol=TCP localport=5173
```

Then access the app on the headset at:
  https://<windows-192.168.1.x-ip>:5173

The Windows 192.168.1.x IP can be found with `ipconfig` in a Windows terminal
(look for the Wi-Fi adapter's IPv4 address).

To remove the rule when no longer needed:
```powershell
netsh interface portproxy delete v4tov4 listenport=5173 listenaddress=0.0.0.0
netsh advfirewall firewall delete rule name="WSL Vite 5173"
```

The WSL2 internal IP (172.25.82.244) can change on restart. If the headset
can no longer connect, re-run the portproxy add command with the new IP from
`ip addr show eth0` inside WSL.

---

## Source File Map

| File | Responsibility |
|------|----------------|
| `src/main.js` | Timeline UI, file upload, AR/VR button handlers, XR controller button wiring (Y/X/A/B), `player.onExitXR` callback |
| `src/scene.js` | Babylon.js scene + camera setup, WebXR init, thumbstick/grip input each frame, AR grip gesture logic, car-cam offset state |
| `src/arena.js` | Builds the full RL arena mesh hierarchy; exports `buildArena(scene)` returning `arenaRoot` TransformNode |
| `src/replayPlayer.js` | Replay playback, car/ball interpolation, VR panel GUI, AR miniature mode, scoring, kickoff countdown, audio |
| `src/wasm/rl_parser.js` | WASM module: `parse_replay(Uint8Array) → string` (JSON) |

---

## Coordinate System & Scale

- **RL native**: X=right, Y=goal-to-goal, Z=up
- **Babylon**: X=right, Y=up, Z=goal-to-goal (RL Y↔Z swapped; quaternion handedness also flipped)
- **Scale**: `UU_SCALE = 0.02` (1 Unreal Unit = 0.02 Babylon units = 2 cm); 1 Babylon unit = 1 m in XR

### Arena Dimensions (Babylon units after scale)
```
halfX      =  81.92  side wall X position
halfY      = 102.40  end wall Z position (goal line)
ceilingZ   =  40.88  ceiling height (Y)
goalWidth  =  35.72
goalHeight =  12.84
goalDepth  =  17.60  (recessed behind end wall)
cornerCut  =  20.48  length of each 45° diagonal corner section
```

---

## Arena Construction (`arena.js`)

`buildArena(scene)` creates all arena meshes and parents them all to a single
`arenaRoot` TransformNode (returned). All meshes have `isPickable = false`.

### Mesh Layers

| Component | Notes |
|-----------|-------|
| Floor | Two `CreateGround` halves (blue team: -Z half, orange: +Z half), alpha=1 (opaque) |
| Centre line | Thin `CreateGround` strip, white, alpha=0.45 |
| Ceiling | **None** — fully transparent |
| Side walls (L/R) | Single box per side spanning full length. Outer face alpha≈0.008, inner face alpha=0.72 via `addInnerFace()` |
| End walls (B/O) | 3 boxes per team (left flank, right flank, above goal). Same per-face opacity system |
| Corner walls | 4 diagonal 45° walls, team-coloured. Same per-face opacity |
| Floor/ceiling trim | Sloped strip boxes at wall bases (side and end) |
| Corner ramps | Sloped boxes at each corner (floor + ceiling, 8 total) |
| Goals | 5 boxes per goal: back wall, 2 side walls, top rim, floor |

### Per-Face Opacity System (`addInnerFace`)
Each wall has two meshes at the same position:
1. **Outer mesh**: `backFaceCulling = true`, very low alpha (~0.008) → barely visible from outside
2. **Inner mesh**: clone of outer, `mesh.flipFaces(false)` (winding reversed, not normals) + `backFaceCulling = true`, alpha≈0.72 → opaque from inside

### Team Colours
```js
BLUE_CLR        = Color3(0.10, 0.30, 0.90)   // goal interior
ORANGE_CLR      = Color3(0.90, 0.45, 0.10)
BLUE_WALL_CLR   = Color3(0.22, 0.40, 0.88)   // walls/corners
ORANGE_WALL_CLR = Color3(0.88, 0.44, 0.16)
BLUE_EMI        = Color3(0.03, 0.06, 0.22)   // emissive
ORANGE_EMI      = Color3(0.22, 0.06, 0.01)
```
Blue team occupies the **-Z half** (negative Z), orange the **+Z half**.

---

## Scene Properties (Cross-File Communication)

These properties are set on the `scene` object and read across files:

| Property | Set by | Read by | Purpose |
|----------|--------|---------|---------|
| `scene._playerArMode` | `main.js` | `scene.js` | True before enterXRAsync for AR; skips VR fly-in offset |
| `scene._arenaRoot` | `replayPlayer.js` | `scene.js` | Non-null while in AR; triggers grip gesture logic instead of locomotion |
| `scene._playerCamMode` | `replayPlayer.js` | `scene.js` | `'free'`/`'car'`/`'ball'`; gates left-stick locomotion |
| `scene._carCamOff` | `scene.js` | `replayPlayer.js` | `{fwd, side, up}` offset from car; default `{fwd:-4, side:0, up:1}` |
| `scene._carCamYaw` | `scene.js` | `replayPlayer.js` | Extra orbit yaw around followed car (radians) |
| `scene._carCamReset` | `scene.js` (button) | `scene.js` | Flag: right-stick-click resets car cam offset to defaults |
| `scene._gripRef` | `scene.js` | `scene.js` | Active AR grip state (`{mode, dist, angle, scale, rotY, pos}`) |
| `scene._aHeld` | `main.js` | `main.js` | Right A-button held → rewind 4× per frame |
| `scene._bHeld` | `main.js` | `main.js` | Right B-button held → fast-forward 4× per frame |

---

## VR/AR Mode

### Entering AR (`main.js → replayPlayer.enterAR()`)
1. `scene._playerArMode = true`
2. `xrHelper.baseExperience.enterXRAsync('immersive-ar', 'local-floor')`
3. `player.enterAR()`:
   - Scales `_arenaRoot` to `1/204.8` (full arena ≈ 1 m)
   - Positions arena at `(0, 0.9, 1.0)` (table height, 1 m in front)
   - Transparent background (`clearColor.a = 0`)
   - Parents ball, cars, pads, score boards to `_arenaRoot` so they scale with miniature
   - Dims camera mode buttons in VR panel
4. `scene._arenaRoot` is set → grip gestures activate, joystick locomotion disabled

### Exiting AR
1. `player.exitAR()`: unparents objects, restores scale/position/rotation to zero, opaque background, calls `resetToFreeCam()`
2. `scene._arenaRoot = null`, `scene._gripRef = null`

### AR Grip Gestures (`scene.js`, runs each frame when `scene._arenaRoot` is set)
- **Both grips**: Scale (hand distance ratio) + rotate arena (hand angle delta)
- **Left grip only**: Translate arena by grip delta
- **Right grip only**: Translate arena by grip delta
- State machine in `scene._gripRef` with `mode: 'two'|'left'|'right'`

### VR Mode
- `xrHelper.baseExperience.enterXRAsync('immersive-vr', 'local-floor')`
- Initial camera position: `(110, 110, 0)` (above arena, looking down)
- Locomotion: left stick (horizontal plane only, no Y drift), right stick rotates
- Grips: left = move down, right = move up (or adjust car-cam offset if in car cam)

---

## XR Controller Button Map

### Left Controller
| Button | Action |
|--------|--------|
| Y | Toggle VR replay panel |
| X | Toggle play / pause |
| Left grip | Move camera down (free cam) OR lower car-cam offset |

### Right Controller
| Button | Action |
|--------|--------|
| A (held) | Rewind 4× real-time |
| B (held) | Fast-forward 4× real-time |
| Right stick click | Reset car-cam offset to default |
| Right grip | Move camera up (free cam) OR raise car-cam offset |

### Thumbstick Axes (free cam mode)
| Stick | Axis | Action |
|-------|------|--------|
| Left | Y | Move forward/back (horizontal plane) |
| Left | X | Strafe left/right |
| Right | X | Rotate camera yaw |

### Thumbstick Axes (car cam mode)
| Stick | Axis | Action |
|-------|------|--------|
| Left | Y | Move camera closer/further from car |
| Left | X | Strafe camera left/right relative to car |
| Right | X | Orbit camera around car |

---

## Camera Modes (`replayPlayer.js`)

Three modes stored in `_camMode` and exposed as `scene._playerCamMode`:

- **`'free'`**: Default XR fly cam; locomotion fully controlled by thumbstick/grips
- **`'ball'`**: Camera snaps to ball position each frame; ball rendered semi-transparent
- **`'car'`**: 3rd-person follow using `scene._carCamOff` and `scene._carCamYaw`
  - Resolves followed car by `_followCarId` (preferred) → same name (ID-change fallback) → any active car
  - Tracks `_carNames` map (built from all frames at load time, survives actor ID changes after goals)
  - Switched via VR panel buttons or `resetToFreeCam()` on XR exit

### Car Cam Positioning
```
rearVec = car's world -X direction (flattened to XZ), rotated by _carCamYaw
sideVec = rearVec rotated 90° right in XZ plane
cam.position = car.position
            + rearVec * (-_carCamOff.fwd)   // negative fwd = behind car
            + sideVec * _carCamOff.side
            + (0, _carCamOff.up, 0)
```
Default: `fwd=-4, side=0, up=1` (4 m behind, 1 m above, no strafe, no orbit)

---

## VR Replay Panel (`replayPlayer._setupVRPanel()`)

A 2.1 m × 0.6 m plane mesh with a 1024×260 px GUI texture. Toggled by Y button.
Positioned 1.5 m in front of camera each frame, facing the player.

### Layout (row Y positions in texture pixels)
| Row | Y | Content |
|-----|---|---------|
| Title | 8 | "REPLAY" |
| Controls | 46–102 | Play/pause · Time · Dur · Speed · ±5s · Prev/Next event |
| Goal dots | 112 | Coloured circles at proportional timeline positions |
| Scrubber | 143 | Rail + fill + draggable handle |
| Cam buttons | 174 | Free · Car cam · Ball cam + Exit XR button |
| Player select | 218 | ◀ [Player name] ▶ |

### Key Refs
- `_vrFreeCamRect`, `_vrCarCamRect`, `_vrBallCamRect` — cam buttons (dimmed in AR)
- `_syncVRCamBtns` — call to sync button highlight states
- `_syncVRPlayerName` — call after replay load to update name display
- `_vrPlayerNameText` — TextBlock showing current followed player
- `toggleVRPanel()` — shows/hides the panel plane

---

## Replay Loading Flow

1. Binary `.replay` → WASM `parse_replay()` → JSON string
2. `_processReplayData(json)`:
   - Transforms all frame positions: RL coords → Babylon coords (Y↔Z swap, `* UU_SCALE`)
   - Flips quaternion components for handedness: `qx=-qx, qy=-qz, qz=-qy, qw=qw`
   - Normalises frame times to start at 0; adjusts goal times to match
3. `loadReplay(frames)`:
   - Disposes old label GUI controls (`_labels = {}`)
   - Builds `_carNames: {id → name}` by scanning **all** frames (not just frame 0)
   - Disposes old car meshes; creates new from first frame's car list
   - Calls `_buildKeyframes()` to index frames where positions actually changed
4. `_makePads()`, `_computeKickoffTimes()`, `play()`, `onMetaLoad()` callback

### Keyframes
Only frames where position changed by >0.0001 are indexed as keyframes.
Used for smooth interpolation, skipping redundant carry-forward frames.

---

## Scoring & Goals

```js
_liveScore = { 0: blueGoals, 1: orangeGoals }
_processedGoals = Set<goalIndex>
```

On goal: score incremented → `seekTo(kickoffShowTime)` → kickoff countdown activates.

**Kickoff detection** (two-pass):
1. Find `showTime`: ball at centre + all cars slow (<2 m/s) for ≥0.5 s
2. Find `goTime`: first car fast (>8 m/s) after showTime

**Score boards**: 3D planes above each goal, `DynamicTexture` updated on each goal.
- Blue board at `z = -(halfY + 4)`, rotation Y = π (faces into arena)
- Orange board at `z = +(halfY + 4)`, rotation Y = 0 (faces into arena)
- Parented to `_arenaRoot` in AR mode so they scale with miniature

---

## Misc Implementation Notes

- **`resetToFreeCam()`**: Sets `_camMode = 'free'` and calls `_syncVRCamBtns()`. Called on VR and AR exit.
- **`player.onExitXR`**: Callback (set in `main.js`) fired by in-headset Exit XR button; handles both AR and VR exit paths.
- **`player.onMetaLoad`**: Callback fired after replay loads; main.js uses it to update timeline duration and render goal icons.
- **Label cleanup**: Old player name labels (GUI StackPanels) are disposed in `loadReplay()` to prevent stale names carrying over between replays.
- **Inner face meshes** created by `addInnerFace()` are automatically caught by the `scene.meshes.forEach` at the end of `buildArena()` and parented to `arenaRoot`.
- **Mesh picking disabled**: All arena meshes have `isPickable = false` (set in `buildArena`) to avoid expensive per-frame ray-cast overhead.

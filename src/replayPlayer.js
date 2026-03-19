import {
  MeshBuilder,
  StandardMaterial,
  DynamicTexture,
  Color3,
  Vector3,
  Quaternion,
} from '@babylonjs/core'
import { AdvancedDynamicTexture, TextBlock, Rectangle, StackPanel, Ellipse } from '@babylonjs/gui'
import { buildArena, UU_SCALE, ARENA } from './arena.js'

function _fmtTime(s) {
  const m = Math.floor(Math.abs(s) / 60)
  const ss = Math.floor(Math.abs(s) % 60).toString().padStart(2, '0')
  return `${m}:${ss}`
}

const TEAM_COLORS = {
  0: new Color3(0.1, 0.3, 1.0),   // blue
  1: new Color3(1.0, 0.4, 0.05),  // orange
}

export class ReplayPlayer {
  constructor(scene) {
    this.scene = scene
    this.frames = []
    this.currentTime = 0
    this.playing = false
    this._frameIndex = 0

    buildArena(scene)

    this._gui = AdvancedDynamicTexture.CreateFullscreenUI('ui', true, scene)
    this._labels = {}  // car id -> { rect, label }
    this._padMeshes = []
    this._padPickedUpUntil = []  // per-pad: playback time until which grey state is shown
    this._prevBoost = {}         // car id -> last observed boost value
    this._boostingUntil = {}     // car id -> playback time until flame is shown

    // Goal-skip state
    this._prevTime = 0
    this.speed = 1.0
    this._processedGoals = new Set()
    this._goalKickoffTimes = []
    this._countdown = { active: false, goTime: 0 }
    this._setupCountdown()
    this._liveScore = { 0: 0, 1: 0 }
    this._setupScoreBoards()

    // Positional audio
    this._audioCtx = null
    this._carAudio = {}
    this._prevCarPos = {}
    this._setupAudio()

    // Camera mode: 'free' = default XR fly cam, 'car' = 3rd-person follow
    this._camMode = 'free'
    this._followCarIdx = 0

    // VR replay control panel (hidden; toggled by Y button)
    this._vrScrubbing = false
    this._setupVRPanel()

    // Placeholder meshes -- replaced when a replay is loaded
    this._ball = this._makeBall()
    this._carMeshes = {}

    // Load real replay, fall back to demo if unavailable
    this._loadReplayJson('/replay.json').catch(() => this._loadDemoFrames())
  }

  async _loadReplayJson(url) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Failed to fetch ${url}`)
    this._processReplayData(await res.json())
  }

  _processReplayData(data) {
    this.meta = data.meta

    const rawFrames = data.frames
      .map(f => ({
        time: f.time,
        ball: f.ball ? { x: f.ball.x * UU_SCALE, y: f.ball.z * UU_SCALE, z: f.ball.y * UU_SCALE } : null,
        cars: f.cars.map(c => ({
          id: String(c.id),
          name: c.name,
          team: c.team,
          x: c.x * UU_SCALE,
          y: c.z * UU_SCALE,
          z: c.y * UU_SCALE,
          // RL right-handed (X=right, Y=field, Z=up) -> Babylon left-handed (X=right, Y=up, Z=field).
          // Conversion: swap Y<->Z AND negate all imaginary components (handedness flip).
          qx: -c.qx,
          qy: -c.qz,
          qz: -c.qy,
          qw: c.qw,
          boost: c.boost,
        })),
      }))
      .filter(f => f.ball !== null)

    // Normalise times to start at 0.
    // Parser normalises goal times relative to the first network frame (netT0).
    // JS normalises frame times relative to the first ball frame (t0). Align both.
    const netT0 = data.frames[0]?.time ?? 0
    const t0 = rawFrames[0]?.time ?? 0
    rawFrames.forEach(f => { f.time -= t0 })
    if (this.meta.goals) {
      const delta = t0 - netT0
      this.meta.goals.forEach(g => { g.time -= delta })
    }

    this.loadReplay(rawFrames)
    if (data.meta.pads) this._makePads(data.meta.pads.length)
    this._goalKickoffTimes = this._computeKickoffTimes()
    this.play()
    this.onMetaLoad?.()
    this._buildVRGoalDots()
    this._syncVRPlayerName?.()
  }

  _getLabel(id, name, team) {
    if (this._labels[id]) return this._labels[id]

    const boostHigh = team === 0 ? '#4488ff' : '#ffcc00'
    const boostMid  = team === 0 ? '#2255dd' : '#ff8800'
    const teamBg    = team === 0 ? 'rgba(20,55,190,0.85)' : 'rgba(190,75,10,0.85)'

    // 2D screen-space label — renders at native screen resolution so text stays
    // sharp at any viewing distance, in both desktop and VR.
    const PW = 110

    const stack = new StackPanel(`label_${id}`)
    stack.isVertical = true
    stack.widthInPixels = PW
    stack.adaptHeightToChildren = true
    this._gui.addControl(stack)

    // Boost pill
    const boostPill = new Rectangle(`boostPill_${id}`)
    boostPill.widthInPixels = PW
    boostPill.heightInPixels = 24
    boostPill.cornerRadius = 12
    boostPill.thickness = 0
    boostPill.background = 'rgba(18,18,28,0.88)'
    stack.addControl(boostPill)

    const boostRing = new Ellipse(`boostRing_${id}`)
    boostRing.widthInPixels = 18; boostRing.heightInPixels = 18
    boostRing.thickness = 2; boostRing.color = boostMid
    boostRing.background = 'rgba(20,20,30,0.95)'
    boostRing.horizontalAlignment = 0; boostRing.left = '5px'
    boostPill.addControl(boostRing)

    const boostFill = new Ellipse(`boostFill_${id}`)
    boostFill.widthInPixels = 14; boostFill.heightInPixels = 14
    boostFill.thickness = 0; boostFill.background = boostMid
    boostRing.addControl(boostFill)

    const boostNum = new TextBlock(`boostNum_${id}`, '100')
    boostNum.color = '#ffffff'; boostNum.fontSize = 12
    boostNum.fontWeight = 'bold'; boostNum.fontFamily = 'system-ui, sans-serif'
    boostPill.addControl(boostNum)

    // Name pill
    const namePill = new Rectangle(`namePill_${id}`)
    namePill.widthInPixels = PW; namePill.heightInPixels = 20
    namePill.cornerRadius = 10; namePill.thickness = 0
    namePill.background = teamBg; namePill.paddingTopInPixels = 2
    stack.addControl(namePill)

    const nameText = new TextBlock(`nameText_${id}`, name || String(id))
    nameText.color = '#ffffff'; nameText.fontSize = 11
    nameText.fontFamily = 'system-ui, sans-serif'
    namePill.addControl(nameText)

    this._labels[id] = { stack, boostNum, boostFill, boostHigh, boostMid }
    return this._labels[id]
  }

  _makePads(padCount) {
    for (const m of this._padMeshes) m.dispose()
    this._padMeshes = []
    this._padPickedUpUntil = []

    // Standard RL boost pad positions (Unreal units).
    // Positions near the large corner pads (+/-3072, +/-3904) are omitted -- they
    // sit directly beside the large pads and look like duplicates visually.
    const LARGE = [
      [ 3584,    0], [-3584,    0],
      [ 3072, 4096], [-3072, 4096],
      [ 3072,-4096], [-3072,-4096],
    ]
    const SMALL = [
      [    0,-4240], [-1792,-4184], [ 1792,-4184],
      [ -940,-3308], [  940,-3308],
      [    0,-2816],
      [-3584,-2484], [ 3584,-2484],
      [-1788,-2300], [ 1788,-2300],
      [-2048,-1036], [ 2048,-1036],
      [-2048, 1036], [ 2048, 1036],
      [-1788, 2300], [ 1788, 2300],
      [-3584, 2484], [ 3584, 2484],
      [    0, 2816],
      [ -940, 3308], [  940, 3308],
      [-1792, 4184], [ 1792, 4184],
      [    0, 4240],
    ]
    const ALL = [
      ...LARGE.map(([x, y]) => ({ x, y, large: true })),
      ...SMALL.map(([x, y]) => ({ x, y, large: false })),
    ]

    const largeMat = new StandardMaterial('padLargeActiveMat', this.scene)
    largeMat.diffuseColor = new Color3(1, 0.85, 0)
    largeMat.emissiveColor = new Color3(0.5, 0.35, 0)
    largeMat.alpha = 0.75

    const smallMat = new StandardMaterial('padSmallActiveMat', this.scene)
    smallMat.diffuseColor = new Color3(1, 1, 0.5)
    smallMat.emissiveColor = new Color3(0.25, 0.25, 0)
    smallMat.alpha = 0.75

    // Shared grey material for picked-up state
    const goneMat = new StandardMaterial('padGoneMat', this.scene)
    goneMat.diffuseColor = new Color3(0.25, 0.25, 0.25)
    goneMat.emissiveColor = new Color3(0, 0, 0)
    goneMat.alpha = 0.2

    const n = Math.min(padCount, ALL.length)
    for (let i = 0; i < n; i++) {
      const { x, y, large } = ALL[i]
      const mesh = MeshBuilder.CreateCylinder(`pad_${i}`, {
        diameter: large ? 3.6 : 1.8,
        height: large ? 0.5 : 0.3,
        tessellation: 24,
      }, this.scene)
      mesh.position.x = x * UU_SCALE
      mesh.position.y = large ? 0.25 : 0.15
      mesh.position.z = y * UU_SCALE
      mesh.material = large ? largeMat : smallMat
      mesh.metadata = { activeMat: large ? largeMat : smallMat, goneMat }
      this._padMeshes.push(mesh)
      this._padPickedUpUntil[i] = -1
    }
  }

  _makeBall() {
    const ball = MeshBuilder.CreateSphere('ball', { diameter: 185.5 * UU_SCALE }, this.scene)
    const mat = new StandardMaterial('ballMat', this.scene)
    mat.diffuseColor = new Color3(1, 1, 1)
    ball.material = mat
    return ball
  }

  _makeCar(id, team) {
    const teamColor = TEAM_COLORS[team] ?? new Color3(0.5, 0.5, 0.5)
    // Car forward = local +X. L=length, H=height, W=width(Z)
    const L = 2.0, H = 0.42, W = 1.18

    // -- Body
    const car = MeshBuilder.CreateBox(`car_${id}`, { width: L, height: H, depth: W }, this.scene)
    const bodyMat = new StandardMaterial(`carBody_${id}`, this.scene)
    bodyMat.diffuseColor = teamColor
    car.material = bodyMat

    // -- Cabin / roof (center-rear, darker team colour) ------
    const cabinL = L * 0.46, cabinH = 0.28, cabinW = W * 0.78
    const cabin = MeshBuilder.CreateBox(`carCabin_${id}`, { width: cabinL, height: cabinH, depth: cabinW }, this.scene)
    cabin.position.x = -L * 0.06   // slightly toward rear
    cabin.position.y = H / 2 + cabinH / 2
    const cabinMat = new StandardMaterial(`carCabin_${id}`, this.scene)
    cabinMat.diffuseColor = teamColor.scale(0.6)
    cabin.material = cabinMat
    cabin.parent = car

    // -- Nose cap (+X face, light grey) ---------------------
    const nose = MeshBuilder.CreateBox(`carNose_${id}`, { width: 0.1, height: H * 0.72, depth: W * 0.9 }, this.scene)
    nose.position.x = L / 2 + 0.05
    nose.position.y = -H * 0.07
    const noseMat = new StandardMaterial(`carNoseMat_${id}`, this.scene)
    noseMat.diffuseColor = new Color3(0.88, 0.88, 0.88)
    nose.material = noseMat
    nose.parent = car

    // -- Rear spoiler (-X face) ------------------------------
    const spoiler = MeshBuilder.CreateBox(`carSpoiler_${id}`, { width: 0.06, height: 0.24, depth: W * 0.65 }, this.scene)
    spoiler.position.x = -(L / 2 + 0.03)
    spoiler.position.y = H / 2 + 0.06
    const spoilerMat = new StandardMaterial(`carSpoilerMat_${id}`, this.scene)
    spoilerMat.diffuseColor = new Color3(0.18, 0.18, 0.18)
    spoiler.material = spoilerMat
    spoiler.parent = car

    // -- Wheels
    const wheelR = 0.23, wheelW = 0.16
    const wheelMat = new StandardMaterial(`wheelMat_${id}`, this.scene)
    wheelMat.diffuseColor = new Color3(0.12, 0.12, 0.12)
    const rimMat = new StandardMaterial(`rimMat_${id}`, this.scene)
    rimMat.diffuseColor = new Color3(0.72, 0.72, 0.76)

    const corners = [
      { x:  L * 0.31, z:  W / 2 + wheelW / 2 },
      { x:  L * 0.31, z: -(W / 2 + wheelW / 2) },
      { x: -L * 0.31, z:  W / 2 + wheelW / 2 },
      { x: -L * 0.31, z: -(W / 2 + wheelW / 2) },
    ]
    corners.forEach((c, i) => {
      const wheel = MeshBuilder.CreateCylinder(`wheel_${id}_${i}`,
        { diameter: wheelR * 2, height: wheelW, tessellation: 16 }, this.scene)
      wheel.rotation.x = Math.PI / 2
      wheel.position.set(c.x, -H / 4, c.z)
      wheel.material = wheelMat
      wheel.parent = car

      const rim = MeshBuilder.CreateDisc(`rim_${id}_${i}`,
        { radius: wheelR * 0.55, tessellation: 16 }, this.scene)
      rim.rotation.x = Math.PI / 2
      rim.position.set(c.x, -H / 4, c.z + Math.sign(c.z) * (wheelW / 2 + 0.01))
      rim.material = rimMat
      rim.parent = car
    })

    // -- Boost flame (rear exhaust, -X direction) ------------
    // Cylinder with diameterTop=0 gives a cone. With rotation.z=PI/2, local +Y -> -X (tip points backward).
    const flameH = 1.6
    const flameOuterMat = new StandardMaterial(`flameOuter_${id}`, this.scene)
    flameOuterMat.diffuseColor  = new Color3(1.0, 0.55, 0.05)
    flameOuterMat.emissiveColor = new Color3(0.8, 0.35, 0.0)
    flameOuterMat.alpha = 0.75
    flameOuterMat.backFaceCulling = false

    const flameInnerMat = new StandardMaterial(`flameInner_${id}`, this.scene)
    flameInnerMat.diffuseColor  = new Color3(1.0, 0.95, 0.5)
    flameInnerMat.emissiveColor = new Color3(1.0, 0.7, 0.2)
    flameInnerMat.alpha = 0.9
    flameInnerMat.backFaceCulling = false

    const flameOuter = MeshBuilder.CreateCylinder(`flameOuter_${id}`,
      { diameterTop: 0, diameterBottom: 0.55, height: flameH, tessellation: 12 }, this.scene)
    flameOuter.rotation.z = Math.PI / 2
    flameOuter.position.x = -(L / 2 + flameH / 2)
    flameOuter.material = flameOuterMat
    flameOuter.parent = car
    flameOuter.setEnabled(false)

    const flameInner = MeshBuilder.CreateCylinder(`flameInner_${id}`,
      { diameterTop: 0, diameterBottom: 0.28, height: flameH * 0.75, tessellation: 12 }, this.scene)
    flameInner.rotation.z = Math.PI / 2
    flameInner.position.x = -(L / 2 + flameH * 0.75 / 2)
    flameInner.material = flameInnerMat
    flameInner.parent = car
    flameInner.setEnabled(false)

    car.metadata = { flameOuter, flameInner }
    return car
  }

  // Load a parsed replay (array of frame objects)
  // Each frame: { time, ball: {x,y,z}, cars: [{id, team, x,y,z,yaw}] }
  loadReplay(frames) {
    this.frames = frames
    this.currentTime = 0
    this._frameIndex = 0
    this.playing = false

    // Rebuild car meshes to match player count in replay
    for (const mesh of Object.values(this._carMeshes)) mesh.dispose()
    this._carMeshes = {}
    for (const audio of Object.values(this._carAudio)) {
      try { audio.engOsc.stop() } catch {}
      audio.engGain.disconnect()
      audio.boostGain.disconnect()
    }
    this._carAudio = {}

    const firstFrame = frames[0]
    if (firstFrame) {
      for (const car of firstFrame.cars) {
        this._carMeshes[car.id] = this._makeCar(car.id, car.team)
      }
    }

    this._buildKeyframes()
    this._computeBallHitEvents()
  }

  // Build per-entity keyframe index arrays -- only frames where position actually
  // changed. The parser carries forward the last known state, so most consecutive
  // frames are identical; we only want the real physics update frames for interp.
  // Scan ball keyframes for velocity reversals -> collision events
  _computeBallHitEvents() {
    this._ballHitEvents = []
    const kfs = this._ballKeyframes
    if (!kfs || kfs.length < 3) return

    for (let i = 1; i < kfs.length - 1; i++) {
      const f0 = this.frames[kfs[i - 1]]
      const f1 = this.frames[kfs[i]]
      const f2 = this.frames[kfs[i + 1]]
      const dt1 = f1.time - f0.time
      const dt2 = f2.time - f1.time
      if (dt1 <= 0 || dt2 <= 0) continue

      const v1x = (f1.ball.x - f0.ball.x) / dt1
      const v1y = (f1.ball.y - f0.ball.y) / dt1
      const v1z = (f1.ball.z - f0.ball.z) / dt1
      const v2x = (f2.ball.x - f1.ball.x) / dt2
      const v2y = (f2.ball.y - f1.ball.y) / dt2
      const v2z = (f2.ball.z - f1.ball.z) / dt2

      const speed1 = Math.sqrt(v1x*v1x + v1y*v1y + v1z*v1z)
      const speed2 = Math.sqrt(v2x*v2x + v2y*v2y + v2z*v2z)
      if (speed1 < 1 || speed2 < 1) continue  // ball barely moving

      // Angle between velocity vectors via dot product of normalised dirs
      // dirChange: 0 = same direction, 2 = full reversal
      const dot = (v1x*v2x + v1y*v2y + v1z*v2z) / (speed1 * speed2)
      const dirChange = 1 - Math.max(-1, Math.min(1, dot))
      if (dirChange < 0.2) continue  // less than ~37° change, ignore

      // Use dv for volume scaling
      const dvx = v2x - v1x, dvy = v2y - v1y, dvz = v2z - v1z
      const dv = Math.sqrt(dvx*dvx + dvy*dvy + dvz*dvz)

      // Classify by which velocity component changed most, + floor proximity
      let type
      if (v1y < -1 && v2y > 0 && f1.ball.y < 5) {
        type = 'floor'
      } else if (Math.abs(dvx) >= Math.abs(dvy) && Math.abs(dvx) >= Math.abs(dvz)) {
        type = 'wall'
      } else if (Math.abs(dvz) >= Math.abs(dvy) && Math.abs(dvz) >= Math.abs(dvx)) {
        type = 'wall'
      } else {
        type = 'car'
      }

      // Suppress events within 0.15s of the previous one (same bounce, multiple frames)
      const last = this._ballHitEvents[this._ballHitEvents.length - 1]
      if (last && f1.time - last.time < 0.15) continue

      this._ballHitEvents.push({ time: f1.time, type, dv, dirChange, pos: { ...f1.ball } })
    }
  }

  // One-shot percussive hit sound at a 3D position
  _playBallHit(type, pos, dv) {
    const ctx = this._audioCtx
    if (!ctx || ctx.state === 'suspended') { ctx?.resume(); return }
    const now = ctx.currentTime
    if (now - (this._lastBallHitTime ?? -1) < 0.15) return  // debounce 150 ms
    this._lastBallHitTime = now

    const cfg = {
      floor: { freq: 120, q: 1.2, dur: 0.20, vol: 0.55 },
      wall:  { freq: 280, q: 2.0, dur: 0.15, vol: 0.45 },
      car:   { freq: 520, q: 3.5, dur: 0.12, vol: 0.65 },
    }[type]

    const intensity = Math.min(dv / 60, 1)

    const gain = ctx.createGain()
    gain.gain.setValueAtTime(cfg.vol * (0.4 + 0.6 * intensity), now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + cfg.dur)
    gain.connect(ctx.destination)

    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = cfg.freq
    filter.Q.value = cfg.q
    filter.connect(gain)

    const bufLen = Math.ceil(ctx.sampleRate * cfg.dur)
    const buf  = ctx.createBuffer(1, bufLen, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1

    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(filter)
    src.start(now)
    src.stop(now + cfg.dur)
  }

  _buildKeyframes() {
    const EPS = 1e-4
    this._ballKeyframes = []
    this._carKeyframes = {}

    for (let i = 0; i < this.frames.length; i++) {
      const f    = this.frames[i]
      const prev = i > 0 ? this.frames[i - 1] : null

      if (f.ball) {
        const p = prev?.ball
        if (!p || i === 0 ||
            Math.abs(f.ball.x - p.x) + Math.abs(f.ball.y - p.y) + Math.abs(f.ball.z - p.z) > EPS) {
          this._ballKeyframes.push(i)
        }
      }

      for (const car of f.cars) {
        if (!this._carKeyframes[car.id]) { this._carKeyframes[car.id] = [i]; continue }
        const prevCar = prev?.cars.find(c => c.id === car.id)
        if (!prevCar ||
            Math.abs(car.x - prevCar.x) + Math.abs(car.y - prevCar.y) + Math.abs(car.z - prevCar.z) > EPS) {
          this._carKeyframes[car.id].push(i)
        }
      }
    }
  }

  // Binary-search keyframes for the pair bracketing currentTime.
  // Returns [frameIndexA, frameIndexB] into this.frames.
  _surroundingKFs(keyframes) {
    const t = this.currentTime
    let lo = 0, hi = keyframes.length - 1, a = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (this.frames[keyframes[mid]].time <= t) { a = mid; lo = mid + 1 }
      else hi = mid - 1
    }
    return [keyframes[a], keyframes[Math.min(a + 1, keyframes.length - 1)]]
  }

  _loadDemoFrames() {
    // Two cars doing laps + ball bouncing -- just to prove the scene works
    const frames = []
    const duration = 10
    const fps = 30
    for (let i = 0; i <= duration * fps; i++) {
      const t = i / fps
      const angle = t * 0.8
      frames.push({
        time: t,
        ball: {
          x: Math.sin(t * 1.5) * ARENA.halfX * 0.5,
          y: Math.abs(Math.sin(t * 2.5)) * 8 + 1,
          z: Math.cos(t * 1.2) * ARENA.halfY * 0.5,
        },
        cars: [
          {
            id: 'blue1', team: 0,
            x: Math.cos(angle) * ARENA.halfX * 0.6,
            y: 0.3,
            z: Math.sin(angle) * ARENA.halfY * 0.6,
            qx: 0, qy: Math.sin((angle + Math.PI / 2) / 2), qz: 0, qw: Math.cos((angle + Math.PI / 2) / 2),
          },
          {
            id: 'orange1', team: 1,
            x: Math.cos(angle + Math.PI) * ARENA.halfX * 0.6,
            y: 0.3,
            z: Math.sin(angle + Math.PI) * ARENA.halfY * 0.6,
            qx: 0, qy: Math.sin((angle + Math.PI * 1.5) / 2), qz: 0, qw: Math.cos((angle + Math.PI * 1.5) / 2),
          },
        ],
      })
    }

    this.loadReplay(frames)
    this.play()
  }

  // -- Positional audio (Web Audio API, synthesised — no audio files needed)
  _setupAudio() {
    try {
      this._audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    } catch (e) {
      console.warn('Web Audio not available:', e.message)
      return
    }
    // Contexts start suspended; resume on first user interaction
    const resume = () => this._audioCtx?.state === 'suspended' && this._audioCtx.resume()
    document.addEventListener('click',   resume, { once: true })
    document.addEventListener('keydown', resume, { once: true })
  }

  _getOrCreateCarAudio(id) {
    if (this._carAudio[id]) return this._carAudio[id]
    const ctx = this._audioCtx
    if (!ctx) return null

    // Shared master gain for this car (distance roll-off handled per panner)
    const master = ctx.createGain()
    master.gain.value = 1.0
    master.connect(ctx.destination)

    const makePanner = () => {
      const p = ctx.createPanner()
      p.panningModel   = 'HRTF'
      p.distanceModel  = 'inverse'
      p.refDistance    = 10
      p.maxDistance    = 400
      p.rolloffFactor  = 1.5
      p.connect(master)
      return p
    }

    // -- Engine: sawtooth -> bandpass -> gain -> panner
    const engPanner = makePanner()
    const engGain   = ctx.createGain();  engGain.gain.value = 0.25;  engGain.connect(engPanner)
    const engFilter = ctx.createBiquadFilter()
    engFilter.type = 'bandpass'; engFilter.frequency.value = 120; engFilter.Q.value = 2
    engFilter.connect(engGain)
    const engOsc = ctx.createOscillator()
    engOsc.type = 'sawtooth'; engOsc.frequency.value = 60
    engOsc.connect(engFilter); engOsc.start()

    // -- Boost: white noise -> bandpass -> gain -> panner
    const boostPanner = makePanner()
    const boostGain   = ctx.createGain(); boostGain.gain.value = 0; boostGain.connect(boostPanner)
    const boostFilter = ctx.createBiquadFilter()
    boostFilter.type = 'bandpass'; boostFilter.frequency.value = 700; boostFilter.Q.value = 0.8
    boostFilter.connect(boostGain)
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
    const nd = noiseBuf.getChannelData(0)
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1
    const noiseNode = ctx.createBufferSource()
    noiseNode.buffer = noiseBuf; noiseNode.loop = true
    noiseNode.connect(boostFilter); noiseNode.start()

    return (this._carAudio[id] = { engOsc, engGain, engPanner, boostGain, boostPanner })
  }

  // -- 3D score boards above each goal
  _setupScoreBoards() {
    const { halfY, ceilingZ } = ARENA
    const DEPTH = 4   // distance outside the end wall

    const makeBoard = (name, zPos, faceAngle, hexColor) => {
      const plane = MeshBuilder.CreatePlane(name, { width: 10, height: 8 }, this.scene)
      plane.position.set(0, ceilingZ + 4, zPos)
      plane.rotation.y = faceAngle

      const tex = new DynamicTexture(`${name}Tex`, { width: 256, height: 200 }, this.scene)
      tex.hasAlpha = true

      const mat = new StandardMaterial(`${name}Mat`, this.scene)
      mat.diffuseTexture = tex
      mat.emissiveTexture = tex
      mat.backFaceCulling = false
      mat.emissiveColor = new Color3(1, 1, 1)
      plane.material = mat

      return { plane, tex, hexColor }
    }

    this._blueBoard   = makeBoard('scoreBoardBlue',   -(halfY + DEPTH), 0,        '#5599ff')
    this._orangeBoard = makeBoard('scoreBoardOrange',   halfY + DEPTH,  Math.PI,  '#ff8833')
    this._updateScoreBoards()
  }

  _updateScoreBoards() {
    const draw = ({ tex, hexColor }, score) => {
      tex.clear()
      tex.drawText(String(score), null, 170, `bold 180px system-ui`, hexColor, 'transparent', true)
    }
    draw(this._blueBoard,   this._liveScore[0])
    draw(this._orangeBoard, this._liveScore[1])
  }

  // -- Kickoff countdown GUI
  _setupCountdown() {
    const outer = new Rectangle('cdRect')
    outer.widthInPixels = 260
    outer.heightInPixels = 180
    outer.thickness = 0
    outer.background = 'transparent'
    outer.isVisible = false
    outer.linkOffsetYInPixels = -120
    this._gui.addControl(outer)
    this._cdRect = outer

    // Shadow text (offset for depth effect)
    const shadow = new TextBlock('cdShadow', '3')
    shadow.color = 'rgba(0,0,0,0.6)'
    shadow.fontSize = 130
    shadow.fontWeight = '900'
    shadow.fontFamily = 'system-ui, sans-serif'
    shadow.left = '4px'
    shadow.top = '4px'
    outer.addControl(shadow)
    this._cdShadow = shadow

    const label = new TextBlock('cdLabel', '3')
    label.fontSize = 130
    label.fontWeight = '900'
    label.fontFamily = 'system-ui, sans-serif'
    outer.addControl(label)
    this._cdLabel = label
  }

  // For each goal, find:
  //   showTime = freeze start: ball near centre AND all cars slow (< 2 m/s)
  //   goTime   = kickoff:      first frame after showTime where any car is fast (> 8 m/s)
  // We jump to showTime and count down to goTime.
  _computeKickoffTimes() {
    if (!this.meta?.goals) return []
    return this.meta.goals.map(goal => {
      const scanFrom = goal.time + 3

      // Pass 1 -- find showTime: first moment where ball is at centre AND all
      // cars have been continuously slow (< 2 m/s) for at least 0.5 s.
      let showIdx = -1
      let slowSince = -1   // time when continuous-slow window started
      for (let i = 1; i < this.frames.length; i++) {
        const f    = this.frames[i]
        const prev = this.frames[i - 1]
        if (f.time < scanFrom) continue
        if (!f.ball) { slowSince = -1; continue }
        if (Math.abs(f.ball.x) > 5 || Math.abs(f.ball.z) > 5) { slowSince = -1; continue }

        const dt = f.time - prev.time
        if (dt <= 0) continue
        const allSlow = f.cars.every(car => {
          const p = prev.cars.find(c => c.id === car.id)
          if (!p) return true
          const dx = car.x - p.x, dy = car.y - p.y, dz = car.z - p.z
          return Math.sqrt(dx * dx + dy * dy + dz * dz) / dt < 2
        })
        if (!allSlow) { slowSince = -1; continue }
        if (slowSince < 0) slowSince = f.time
        if (f.time - slowSince >= 0.5) { showIdx = i; break }
      }
      if (showIdx < 0) return null

      // Pass 2 -- find goTime (first fast car after freeze begins)
      for (let i = showIdx + 1; i < this.frames.length; i++) {
        const f    = this.frames[i]
        const prev = this.frames[i - 1]
        if (!f.ball) continue
        if (Math.abs(f.ball.x) > 5 || Math.abs(f.ball.z) > 5) continue

        const dt = f.time - prev.time
        if (dt <= 0) continue
        const anyFast = f.cars.some(car => {
          const p = prev.cars.find(c => c.id === car.id)
          if (!p) return false
          const dx = car.x - p.x, dy = car.y - p.y, dz = car.z - p.z
          return Math.sqrt(dx * dx + dy * dy + dz * dz) / dt > 8
        })
        if (anyFast) return { showTime: this.frames[showIdx].time, goTime: f.time }
      }
      return null
    })
  }

  play()  { this.playing = true }
  pause() { this.playing = false }

  seekTo(t) {
    const last = this.frames[this.frames.length - 1]?.time ?? 0
    this.currentTime = Math.max(0, Math.min(t, last))
    this._frameIndex = 0
    while (
      this._frameIndex < this.frames.length - 2 &&
      this.frames[this._frameIndex + 1].time <= this.currentTime
    ) {
      this._frameIndex++
    }
    // Reset per-frame tracking so flames/audio don't spike on seek
    this._prevBoost = {}
    this._boostingUntil = {}
    this._prevCarPos = {}
    if (this._audioCtx) {
      const now = this._audioCtx.currentTime
      for (const audio of Object.values(this._carAudio)) {
        audio.engGain.gain.setTargetAtTime(0, now, 0.05)
        audio.boostGain.gain.setTargetAtTime(0, now, 0.05)
      }
    }

    // Align _prevTime so the next update() doesn't see a huge time gap and
    // fire every ball-hit event between the old and new position.
    this._prevTime = this.currentTime

    // Recompute which goals have already happened and rebuild the live score.
    this._processedGoals.clear()
    this._liveScore = { 0: 0, 1: 0 }
    if (this.meta?.goals) {
      for (let i = 0; i < this.meta.goals.length; i++) {
        if (this.meta.goals[i].time < this.currentTime) {
          this._processedGoals.add(i)
          this._liveScore[this.meta.goals[i].team] = (this._liveScore[this.meta.goals[i].team] ?? 0) + 1
        }
      }
    }
    this._updateScoreBoards()

    // Recalculate countdown: active only if we land inside a showTime→goTime+0.8 window.
    this._countdown.active = false
    this._cdRect.isVisible = false
    if (this._goalKickoffTimes?.length) {
      for (let i = 0; i < this._goalKickoffTimes.length; i++) {
        const kt = this._goalKickoffTimes[i]
        if (!kt) continue
        if (this.currentTime >= kt.showTime && this.currentTime < kt.goTime + 0.8) {
          this._countdown.active = true
          this._countdown.goTime = kt.goTime
          break
        }
      }
    }
  }

  update(dt) {
    if (this.frames.length === 0) return

    // Countdown runs even while paused
    if (this._countdown.active) this._tickCountdown()

    if (this.playing) {
      const prevTime = this._prevTime

      // Clear processed-goal tracking when replay loops back to start
      if (this.currentTime < 5 && prevTime > 10) {
        this._processedGoals.clear()
        this._liveScore = { 0: 0, 1: 0 }
        this._updateScoreBoards()
        this._countdown.active = false
        this._cdRect.isVisible = false
      }

      this.currentTime += dt * this.speed

      // Loop replay
      const last = this.frames[this.frames.length - 1].time
      if (this.currentTime > last) this.currentTime = 0

      // -- Goal skip: jump to kickoff and show countdown -------------------
      if (this.meta?.goals) {
        for (let i = 0; i < this.meta.goals.length; i++) {
          const gt = this.meta.goals[i].time
          const kt = this._goalKickoffTimes[i]
          if (!kt || this._processedGoals.has(i)) continue
          if (prevTime <= gt && this.currentTime > gt) {
            this._processedGoals.add(i)
            // Update live score
            const team = this.meta.goals[i].team
            this._liveScore[team] = (this._liveScore[team] ?? 0) + 1
            this._updateScoreBoards()
            this.seekTo(kt.showTime)
            this._countdown.active = true
            this._countdown.goTime = kt.goTime
            if (!this.playing) this.play()
            break
          }
        }
      }

      // Ball collision sounds
      for (const ev of (this._ballHitEvents ?? [])) {
        if (prevTime <= ev.time && this.currentTime > ev.time) {
          this._playBallHit(ev.type, ev.pos, ev.dv)
        }
      }

      this._prevTime = this.currentTime
    }

    // Advance frame index to match currentTime (needed after seek or time advance)
    while (
      this._frameIndex < this.frames.length - 2 &&
      this.frames[this._frameIndex + 1].time <= this.currentTime
    ) {
      this._frameIndex++
    }

    // frameA: current frame for active-entity lists, boost values, pad states
    const frameA = this.frames[this._frameIndex]

    // Ball -- interpolate between actual physics keyframes (not carry-forward frames)
    if (this._ballKeyframes?.length) {
      const [kiA, kiB] = this._surroundingKFs(this._ballKeyframes)
      const bfA = this.frames[kiA], bfB = this.frames[kiB]
      const bSpan = bfB.time - bfA.time
      const bAlpha = bSpan > 0 ? (this.currentTime - bfA.time) / bSpan : 0
      this._ball.position = Vector3.Lerp(
        new Vector3(bfA.ball.x, bfA.ball.y, bfA.ball.z),
        new Vector3(bfB.ball.x, bfB.ball.y, bfB.ball.z),
        bAlpha,
      )
    }

    // Hide all car meshes + labels, then show only active ones
    for (const mesh of Object.values(this._carMeshes)) mesh.setEnabled(false)
    for (const { stack } of Object.values(this._labels)) stack.isVisible = false

    for (const carA of frameA.cars) {
      if (!this._carMeshes[carA.id]) {
        this._carMeshes[carA.id] = this._makeCar(carA.id, carA.team)
      }
      const mesh = this._carMeshes[carA.id]
      mesh.setEnabled(true)

      // Position/rotation: interpolate between actual car keyframes
      const kfs = this._carKeyframes?.[carA.id]
      if (kfs?.length >= 2) {
        const [kiA, kiB] = this._surroundingKFs(kfs)
        const cfA = this.frames[kiA].cars.find(c => c.id === carA.id) ?? carA
        const cfB = this.frames[kiB].cars.find(c => c.id === carA.id) ?? cfA
        const cSpan = this.frames[kiB].time - this.frames[kiA].time
        const cAlpha = cSpan > 0 ? (this.currentTime - this.frames[kiA].time) / cSpan : 0
        mesh.position = Vector3.Lerp(
          new Vector3(cfA.x, cfA.y, cfA.z),
          new Vector3(cfB.x, cfB.y, cfB.z),
          cAlpha,
        )
        mesh.rotationQuaternion = Quaternion.Slerp(
          new Quaternion(cfA.qx, cfA.qy, cfA.qz, cfA.qw),
          new Quaternion(cfB.qx, cfB.qy, cfB.qz, cfB.qw),
          cAlpha,
        )
      } else {
        mesh.position = new Vector3(carA.x, carA.y, carA.z)
        mesh.rotationQuaternion = new Quaternion(carA.qx, carA.qy, carA.qz, carA.qw)
      }

      // Name tag + boost bar — 3D plane hovering above the car, always faces camera
      const label = this._getLabel(carA.id, carA.name, carA.team)
      label.stack.isVisible = true
      label.stack.linkWithMesh(mesh)
      label.stack.linkOffsetYInPixels = -55
      // Boost number: 0-255 -> 0-100 display
      const boostPct = Math.round(((carA.boost ?? 0) / 255) * 100)
      label.boostNum.text = String(boostPct)
      // Scale inner fill circle (0→14px) and shift colour by level
      const fillD = Math.round((boostPct / 100) * 14)
      label.boostFill.widthInPixels = fillD
      label.boostFill.heightInPixels = fillD
      label.boostFill.background = boostPct > 60 ? label.boostHigh : boostPct > 30 ? label.boostMid : '#ff3300'

      // Boost flame -- boost is only replicated occasionally, so we extend the
      // flame window for 0.3 s whenever we detect a decrease in boost value.
      const currBoost = carA.boost ?? 0
      const prevBoost = this._prevBoost[carA.id] ?? currBoost
      if (currBoost < prevBoost) {
        this._boostingUntil[carA.id] = this.currentTime + 0.3
      }
      this._prevBoost[carA.id] = currBoost

      const isBoosting = this.currentTime < (this._boostingUntil[carA.id] ?? -1)
      if (mesh.metadata) {
        const { flameOuter, flameInner } = mesh.metadata
        flameOuter.setEnabled(isBoosting)
        flameInner.setEnabled(isBoosting)
        if (isBoosting) {
          const flicker = 0.88 + 0.12 * Math.sin(this.currentTime * 25 + carA.id.charCodeAt(0))
          flameOuter.scaling.x = flicker
          flameInner.scaling.x = flicker * 0.95
        }
      }

      // -- Positional audio --------------------------------------------------
      const audio = this._getOrCreateCarAudio(carA.id)
      if (audio && this._audioCtx) {
        const now = this._audioCtx.currentTime
        const pos = mesh.position
        // Web Audio is right-handed; Babylon is left-handed — negate Z
        const setPos = (panner) => {
          panner.positionX.value = pos.x
          panner.positionY.value = pos.y
          panner.positionZ.value = -pos.z
        }
        setPos(audio.engPanner)
        setPos(audio.boostPanner)

        // Engine pitch: idle 60 Hz -> max ~220 Hz based on car speed
        const prev = this._prevCarPos[carA.id]
        const spd = prev && dt > 0
          ? Math.sqrt((pos.x-prev.x)**2 + (pos.y-prev.y)**2 + (pos.z-prev.z)**2) / dt
          : 0
        this._prevCarPos[carA.id] = { x: pos.x, y: pos.y, z: pos.z }
        const ratio = Math.min(spd / 46, 1)  // 46 Babylon units/s ~ RL max speed
        audio.engOsc.frequency.setTargetAtTime(60 + ratio * 160, now, 0.08)
        audio.engGain.gain.setTargetAtTime(this.playing ? 0.2 + ratio * 0.2 : 0, now, 0.08)

        // Boost whoosh — silence when paused
        audio.boostGain.gain.setTargetAtTime(this.playing && isBoosting ? 0.45 : 0, now, 0.05)
      }
    }

    // Silence audio for cars not present in this frame (demolished / not yet spawned)
    if (this._audioCtx) {
      const activeIds = new Set(frameA.cars.map(c => c.id))
      const now = this._audioCtx.currentTime
      for (const [id, audio] of Object.entries(this._carAudio)) {
        if (!activeIds.has(id)) {
          audio.engGain.gain.setTargetAtTime(0, now, 0.05)
          audio.boostGain.gain.setTargetAtTime(0, now, 0.05)
        }
      }
    }

    // Update listener position to match camera (Web Audio is right-handed)
    if (this._audioCtx && this.scene.activeCamera) {
      const cam = this.scene.activeCamera
      const l = this._audioCtx.listener
      l.positionX.value = cam.position.x
      l.positionY.value = cam.position.y
      l.positionZ.value = -cam.position.z
    }

    // Update boost pad appearance -- grey out when picked up, glow when available.
    // Extend visibility of the picked-up state for at least 2 s of playback time
    // because the actor deletion/creation can span just a single frame.
    if (frameA.pad_states) {
      frameA.pad_states.forEach((pickedUp, i) => {
        const mesh = this._padMeshes[i]
        if (!mesh) return
        if (pickedUp) this._padPickedUpUntil[i] = this.currentTime + 2
        const showGone = this.currentTime < (this._padPickedUpUntil[i] ?? -1)
        mesh.material = showGone ? mesh.metadata.goneMat : mesh.metadata.activeMat
      })
    }

    // Sync VR panel readouts + anchor to focused car every frame
    if (this._vrPanelMesh?.isEnabled()) {
      const dur = this.frames[this.frames.length - 1]?.time ?? 1
      const pct = dur > 0 ? this.currentTime / dur : 0
      if (this._vrTimeText) this._vrTimeText.text = _fmtTime(this.currentTime)
      if (this._vrDurText)  this._vrDurText.text  = _fmtTime(dur)
      if (this._vrPlayLbl)  this._vrPlayLbl.text   = this.playing ? '\u23F8' : '\u25B6'
      if (this._vrSpeedLbl) this._vrSpeedLbl.text  = this.speed + '\xD7'
      if (!this._vrScrubbing) {
        const fillW = Math.round(pct * 636)
        if (this._vrTrackFill) this._vrTrackFill.widthInPixels = fillW
        if (this._vrScrubber)  this._vrScrubber.left = (194 + fillW - 10) + 'px'
      }

      // Keep panel fixed in front of the viewer (camera-space HUD)
      const cam = this.scene.activeCamera
      if (cam) {
        const fwd = cam.getDirection ? cam.getDirection(new Vector3(0, 0, 1)) : new Vector3(0, 0, 1)
        this._vrPanelMesh.position = cam.position.add(fwd.scale(1.5))
        this._vrPanelMesh.position.y = cam.position.y - 0.05
        this._vrPanelMesh.lookAt(cam.position)
      }
    }

    // Ball cam: sit on top of the ball, rotation-only (position override kills thumbstick translation)
    this._ball.material.alpha = this._camMode === 'ball' ? 0.01 : 1
    if (this._camMode === 'ball') {
      const cam = this.scene.activeCamera
      if (cam && cam.getClassName?.() !== 'ArcRotateCamera') {
        cam.position = this._ball.position.add(new Vector3(0, 2.5, 0))
      }
    }

    // 3rd-person car follow (XR only — ArcRotateCamera is skipped)
    if (this._camMode === 'car') {
      const cam = this.scene.activeCamera
      if (cam && cam.getClassName?.() !== 'ArcRotateCamera') {
        const ids = Object.keys(this._carMeshes).sort()
        const id  = ids[this._followCarIdx % Math.max(ids.length, 1)]
        const mesh = id ? this._carMeshes[id] : null
        if (mesh?.isEnabled()) {
          // Chase cam: 6 m behind (local -X = car rear), 2.5 m above, looking at the car
          const back = mesh.getDirection(new Vector3(-1, 0, 0)).scaleInPlace(6)
          cam.position = mesh.position.add(back).addInPlaceFromFloats(0, 2.5, 0)
          if (cam.setTarget) cam.setTarget(mesh.position.add(new Vector3(0, 1, 0)))
        }
      }
    }

  }

  // -- VR replay control panel ---------------------------------------------------
  // Plane (2.1 x 0.41 m) with mesh-bound GUI. Toggled by the Y button.
  // Layout inside 1024 x 200 texture:
  //   Title bar:  y=8, h=30
  //   Buttons row: y=46, h=56  [Play | Time | ... | Dur | Speed]
  //   Events strip: y=112, h=22  (goal dots aligned to timeline)
  //   Track:       y=143, h=12
  _setupVRPanel() {
    const TL_X = 194, TL_W = 636   // timeline x-start and width in texture px

    const plane = MeshBuilder.CreatePlane('vrPanel', { width: 2.1, height: 0.60 }, this.scene)
    plane.setEnabled(false)
    // scaling.x = -1 counters the horizontal UV mirror that lookAt(camera) introduces
    // (lookAt rotates ~180° around Y, which flips local +X, inverting the texture)
    plane.scaling.x = -1
    this._vrPanelMesh = plane

    // supportPointerMove=true so drag-scrubbing works
    const tex = AdvancedDynamicTexture.CreateForMesh(plane, 1024, 260, true)

    const bg = new Rectangle('vrBg')
    bg.width = '100%'; bg.height = '100%'
    bg.background = 'rgba(6, 10, 28, 0.86)'
    bg.cornerRadius = 14; bg.thickness = 2; bg.color = 'rgba(80,140,230,0.45)'
    tex.addControl(bg)

    // Left/Top absolute positioning helper (all in texture pixels)
    const at = (c, x, y, w, h) => {
      c.horizontalAlignment = 0; c.verticalAlignment = 0
      c.left = x + 'px'; c.top = y + 'px'
      if (w != null) c.widthInPixels = w
      if (h != null) c.heightInPixels = h
    }

    // Title
    const title = new TextBlock('vrTitle', 'REPLAY')
    title.color = 'rgba(150,185,255,0.7)'; title.fontSize = 18
    title.fontWeight = 'bold'; title.fontFamily = 'system-ui, sans-serif'
    title.width = '100%'; title.heightInPixels = 30; title.verticalAlignment = 0; title.top = '8px'
    bg.addControl(title)

    // Reusable button factory: dark-blue pill with centred label
    const mkBtn = (id, text, x, w) => {
      const rect = new Rectangle(id)
      rect.background = 'rgba(30,55,150,0.6)'; rect.cornerRadius = 8
      rect.thickness = 1; rect.color = 'rgba(100,150,255,0.5)'
      at(rect, x, 46, w, 56)
      const lbl = new TextBlock(id + 'Lbl', text)
      lbl.color = 'white'; lbl.fontSize = 24; lbl.fontFamily = 'system-ui, sans-serif'
      rect.addControl(lbl)
      return { rect, lbl }
    }

    // Play / Pause
    const { rect: playRect, lbl: playLbl } = mkBtn('vrPlay', '\u23F8', 16, 72)
    playRect.onPointerUpObservable.add(() => {
      if (this.playing) { this.pause(); playLbl.text = '\u25B6' }
      else              { this.play();  playLbl.text = '\u23F8' }
      const d = document.getElementById('play-btn')
      if (d) d.textContent = this.playing ? '\u23F8' : '\u25B6'
    })
    this._vrPlayLbl = playLbl
    bg.addControl(playRect)

    // Current time
    const timeText = new TextBlock('vrTime', '0:00')
    timeText.color = '#cce0ff'; timeText.fontSize = 26; timeText.fontFamily = 'monospace'
    at(timeText, 96, 46, 90, 56)
    bg.addControl(timeText)
    this._vrTimeText = timeText

    // Duration
    const durText = new TextBlock('vrDur', '0:00')
    durText.color = '#cce0ff'; durText.fontSize = 26; durText.fontFamily = 'monospace'
    at(durText, 836, 46, 90, 56)
    bg.addControl(durText)
    this._vrDurText = durText

    // Speed
    const { rect: speedRect, lbl: speedLbl } = mkBtn('vrSpeed', '1\xD7', 934, 74)
    speedRect.onPointerUpObservable.add(() => {
      const SPEEDS = [0.25, 0.5, 1, 1.25, 1.5, 2]
      let idx = SPEEDS.indexOf(this.speed)
      if (idx < 0) idx = 2
      this.speed = SPEEDS[(idx + 1) % SPEEDS.length]
      speedLbl.text = this.speed + '\xD7'
      const d = document.getElementById('speed-btn')
      if (d) d.textContent = this.speed + '\xD7'
    })
    this._vrSpeedLbl = speedLbl
    bg.addControl(speedRect)

    // Goal event dots container (sits just above the track)
    const eventsStrip = new Rectangle('vrEvents')
    eventsStrip.thickness = 0; eventsStrip.background = 'transparent'
    at(eventsStrip, TL_X, 112, TL_W, 22)
    bg.addControl(eventsStrip)
    this._vrEventsStrip = eventsStrip

    // Track rail background
    const trackBg = new Rectangle('vrTrackBg')
    trackBg.background = 'rgba(255,255,255,0.2)'; trackBg.cornerRadius = 4; trackBg.thickness = 0
    at(trackBg, TL_X, 143, TL_W, 12)
    bg.addControl(trackBg)

    // Track fill (width driven by currentTime each frame)
    const trackFill = new Rectangle('vrTrackFill')
    trackFill.background = '#4499ff'; trackFill.cornerRadius = 4; trackFill.thickness = 0
    at(trackFill, TL_X, 143, 0, 12)
    bg.addControl(trackFill)
    this._vrTrackFill = trackFill

    // Scrubber handle (circle centered on the track)
    const scrubber = new Ellipse('vrScrubber')
    scrubber.widthInPixels = 20; scrubber.heightInPixels = 20
    scrubber.background = 'white'; scrubber.thickness = 2; scrubber.color = '#4499ff'
    at(scrubber, TL_X - 10, 139)
    bg.addControl(scrubber)
    this._vrScrubber = scrubber

    // Transparent overlay covering the track + scrubber zone.
    // Added last so it sits on top of trackFill and the scrubber handle, meaning
    // it intercepts ALL pointer events in the track area regardless of which
    // sub-element the ray is hovering (fixes "can't click in the past").
    const trackHit = new Rectangle('vrTrackHit')
    trackHit.background = 'transparent'; trackHit.thickness = 0
    at(trackHit, TL_X, 130, TL_W, 36)  // tall enough to cover scrubber (y=139-159) + rail
    bg.addControl(trackHit)

    const seek = (x) => {
      const pct = Math.max(0, Math.min(1, (x - TL_X) / TL_W))
      const dur = this.frames[this.frames.length - 1]?.time ?? 1
      this.seekTo(pct * dur)
    }

    // Pointer down on the hit overlay starts scrubbing
    trackHit.onPointerDownObservable.add(info => { this._vrScrubbing = true; seek(info.x) })
    // Move handled on both overlay and full bg so drag keeps working if ray drifts off track
    trackHit.onPointerMoveObservable.add(info => { if (this._vrScrubbing) seek(info.x) })
    bg.onPointerMoveObservable.add(info => { if (this._vrScrubbing) seek(info.x) })
    // Up anywhere on the panel ends scrubbing
    trackHit.onPointerUpObservable.add(() => { this._vrScrubbing = false })
    bg.onPointerUpObservable.add(() => { this._vrScrubbing = false })

    // ── Row 1: camera mode + nav buttons (y=174, h=36) ───────────────────────
    const BTN_BG     = 'rgba(30,55,150,0.6)'
    const BTN_BG_ACT = 'rgba(20,130,60,0.75)'

    const mkRow1Btn = (id, text, x) => {
      const rect = new Rectangle(id)
      rect.background = BTN_BG; rect.cornerRadius = 8
      rect.thickness = 1; rect.color = 'rgba(100,150,255,0.5)'
      at(rect, x, 174, 72, 36)
      const lbl = new TextBlock(id + 'Lbl', text)
      lbl.color = 'white'; lbl.fontSize = 19; lbl.fontFamily = 'system-ui, sans-serif'
      rect.addControl(lbl); bg.addControl(rect)
      return rect
    }

    const freeCamRect  = mkRow1Btn('vrFreeCam',  'Free',    276)
    const carCamRect   = mkRow1Btn('vrCarCam',   'Car cam', 356)
    const ballCamRect  = mkRow1Btn('vrBallCam',  'Ball',    436)
    freeCamRect.background = BTN_BG_ACT  // starts active

    const syncCamBtns = () => {
      freeCamRect.background = this._camMode === 'free' ? BTN_BG_ACT : BTN_BG
      carCamRect.background  = this._camMode === 'car'  ? BTN_BG_ACT : BTN_BG
      ballCamRect.background = this._camMode === 'ball' ? BTN_BG_ACT : BTN_BG
    }
    freeCamRect.onPointerUpObservable.add(()  => { this._camMode = 'free'; syncCamBtns() })
    carCamRect.onPointerUpObservable.add(()   => { this._camMode = 'car';  syncCamBtns() })
    ballCamRect.onPointerUpObservable.add(()  => { this._camMode = 'ball'; syncCamBtns() })

    mkRow1Btn('vrPrevEvent', '\u23EE', 516).onPointerUpObservable.add(() => this.seekPrevEvent())
    mkRow1Btn('vrBack5',    '\u22125s', 596).onPointerUpObservable.add(() => this.seekTo(this.currentTime - 5))
    mkRow1Btn('vrFwd5',     '+5s',      676).onPointerUpObservable.add(() => this.seekTo(this.currentTime + 5))
    mkRow1Btn('vrNextEvent', '\u23ED',  756).onPointerUpObservable.add(() => this.seekNextEvent())

    // ── Row 2: player selector  ◀  [Name]  ▶  (y=218, h=30) ─────────────────
    const mkSmBtn = (id, text, x) => {
      const rect = new Rectangle(id)
      rect.background = BTN_BG; rect.cornerRadius = 8
      rect.thickness = 1; rect.color = 'rgba(100,150,255,0.5)'
      at(rect, x, 218, 44, 30)
      const lbl = new TextBlock(id + 'Lbl', text)
      lbl.color = 'white'; lbl.fontSize = 18; lbl.fontFamily = 'system-ui, sans-serif'
      rect.addControl(lbl); bg.addControl(rect)
      return rect
    }

    const playerNameText = new TextBlock('vrPlayerName', '\u2014')
    playerNameText.color = '#cce0ff'; playerNameText.fontSize = 16
    playerNameText.fontFamily = 'system-ui, sans-serif'
    at(playerNameText, 242, 218, 544, 30)
    bg.addControl(playerNameText)
    this._vrPlayerNameText = playerNameText

    const syncPlayerName = () => {
      const ids = Object.keys(this._carMeshes).sort()
      const id  = ids.length ? ids[this._followCarIdx % ids.length] : null
      const name = id ? (this.frames[0]?.cars.find(c => String(c.id) === id)?.name ?? id) : '\u2014'
      if (this._vrPlayerNameText) this._vrPlayerNameText.text = name
    }
    this._syncVRPlayerName = syncPlayerName  // called from _buildVRGoalDots after load

    mkSmBtn('vrPrevPlayer', '\u25C4', 194).onPointerUpObservable.add(() => {
      const ids = Object.keys(this._carMeshes).sort()
      if (!ids.length) return
      this._followCarIdx = (this._followCarIdx - 1 + ids.length) % ids.length
      syncPlayerName()
    })
    mkSmBtn('vrNextPlayer', '\u25BA', 790).onPointerUpObservable.add(() => {
      const ids = Object.keys(this._carMeshes).sort()
      if (!ids.length) return
      this._followCarIdx = (this._followCarIdx + 1) % ids.length
      syncPlayerName()
    })
  }

  _eventTimes() {
    return (this.meta?.goals ?? []).map(g => g.time).sort((a, b) => a - b)
  }

  seekPrevEvent() {
    const prev = [...this._eventTimes()].reverse().find(t => t < this.currentTime - 0.5)
    if (prev != null) this.seekTo(prev)
  }

  seekNextEvent() {
    const next = this._eventTimes().find(t => t > this.currentTime + 0.5)
    if (next != null) this.seekTo(next)
  }

  // Show or hide the VR panel. Position is driven every frame by update().
  toggleVRPanel() {
    if (!this._vrPanelMesh) return
    this._vrPanelMesh.setEnabled(!this._vrPanelMesh.isEnabled())
  }

  // Populate goal event dots on the VR timeline. Called after replay meta is loaded.
  _buildVRGoalDots() {
    if (!this._vrEventsStrip || !this.meta?.goals) return

    const old = [...this._vrEventsStrip.children]
    old.forEach(c => { this._vrEventsStrip.removeControl(c); c.dispose() })

    const TL_W = 636
    const dur = this.frames[this.frames.length - 1]?.time ?? 1
    for (const g of this.meta.goals) {
      const pct = dur > 0 ? g.time / dur : 0
      const dot = new Ellipse('vrGoal' + g.time)
      dot.widthInPixels = 9; dot.heightInPixels = 9
      dot.background = g.team === 0 ? '#4488ff' : '#ff8833'
      dot.thickness = 1; dot.color = 'rgba(255,255,255,0.6)'
      dot.horizontalAlignment = 0; dot.verticalAlignment = 1
      dot.left = Math.round(pct * TL_W - 4) + 'px'
      this._vrEventsStrip.addControl(dot)
    }
  }

  _tickCountdown() {
    // Drive countdown from replay time, not wall clock.
    // remaining = how many seconds until the actual kickoff frame.
    const remaining = this._countdown.goTime - this.currentTime
    this._cdRect.isVisible = true
    this._cdRect.linkWithMesh(this._ball)

    if (remaining > 2) {
      this._cdLabel.text = '3'; this._cdShadow.text = '3'
      this._cdLabel.color = '#ffffff'
    } else if (remaining > 1) {
      this._cdLabel.text = '2'; this._cdShadow.text = '2'
      this._cdLabel.color = '#ffcc44'
    } else if (remaining > 0) {
      this._cdLabel.text = '1'; this._cdShadow.text = '1'
      this._cdLabel.color = '#ff6633'
    } else if (remaining > -0.8) {
      this._cdLabel.text = 'GO!'; this._cdShadow.text = 'GO!'
      this._cdLabel.color = '#44ff88'
    } else {
      this._countdown.active = false
      this._cdRect.isVisible = false
    }
  }
}

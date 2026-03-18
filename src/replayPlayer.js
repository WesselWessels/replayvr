import {
  MeshBuilder,
  StandardMaterial,
  Color3,
  Vector3,
  Quaternion,
} from '@babylonjs/core'
import { AdvancedDynamicTexture, TextBlock, Rectangle, StackPanel, Ellipse } from '@babylonjs/gui'
import { buildArena, UU_SCALE, ARENA } from './arena.js'

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
    this._labels = {}  // car id → { rect, label }
    this._padMeshes = []
    this._padPickedUpUntil = []  // per-pad: playback time until which grey state is shown
    this._prevBoost = {}         // car id → last observed boost value
    this._boostingUntil = {}     // car id → playback time until flame is shown

    // Goal-skip state
    this._prevTime = 0
    this._processedGoals = new Set()
    this._goalKickoffTimes = []
    this._countdown = { active: false, goTime: 0 }
    this._setupCountdown()

    // Placeholder meshes — replaced when a replay is loaded
    this._ball = this._makeBall()
    this._carMeshes = {}

    // Load real replay, fall back to demo if unavailable
    this._loadReplayJson('/replay.json').catch(() => this._loadDemoFrames())
  }

  async _loadReplayJson(url) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Failed to fetch ${url}`)
    const data = await res.json()
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
          // RL is right-handed (X=forward for actor, Y=field-length, Z=up).
          // Babylon is left-handed (X=right, Y=up, Z=forward).
          // Conversion: swap Y↔Z AND negate all imaginary components (handedness flip).
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
      const delta = t0 - netT0   // extra offset to subtract from parser-normalised times
      this.meta.goals.forEach(g => { g.time -= delta })
    }

    this.loadReplay(rawFrames)
    if (data.meta.pads) this._makePads(data.meta.pads.length)
    this._goalKickoffTimes = this._computeKickoffTimes()
    this.play()
    this.onMetaLoad?.()
  }

  _getLabel(id, name, team) {
    if (this._labels[id]) return this._labels[id]

    const teamColor = team === 0 ? 'rgba(30,80,220,0.92)' : 'rgba(210,90,10,0.92)'
    const PW = 110

    // Outer vertical stack
    const stack = new StackPanel(`label_${id}`)
    stack.isVertical = true
    stack.widthInPixels = PW
    stack.adaptHeightToChildren = true
    this._gui.addControl(stack)

    // ── Boost pill ─────────────────────────────────────────
    const boostPill = new Rectangle(`boostPill_${id}`)
    boostPill.widthInPixels = PW
    boostPill.heightInPixels = 22
    boostPill.cornerRadius = 11
    boostPill.thickness = 0
    boostPill.background = 'rgba(18,18,28,0.88)'
    stack.addControl(boostPill)

    // Orange circle icon (left side)
    const boostIcon = new Ellipse(`boostIcon_${id}`)
    boostIcon.widthInPixels = 14
    boostIcon.heightInPixels = 14
    boostIcon.thickness = 0
    boostIcon.background = '#ff8800'
    boostIcon.horizontalAlignment = 0   // LEFT
    boostIcon.left = '6px'
    boostPill.addControl(boostIcon)

    // Boost number (centred in pill)
    const boostNum = new TextBlock(`boostNum_${id}`, '100')
    boostNum.color = '#ffffff'
    boostNum.fontSize = 12
    boostNum.fontWeight = 'bold'
    boostNum.fontFamily = 'system-ui, sans-serif'
    boostPill.addControl(boostNum)

    // ── Name pill ──────────────────────────────────────────
    const namePill = new Rectangle(`namePill_${id}`)
    namePill.widthInPixels = PW
    namePill.heightInPixels = 20
    namePill.cornerRadius = 10
    namePill.thickness = 0
    namePill.background = teamColor
    namePill.paddingTopInPixels = 2
    stack.addControl(namePill)

    const nameText = new TextBlock(`nameText_${id}`, name || String(id))
    nameText.color = '#ffffff'
    nameText.fontSize = 11
    nameText.fontFamily = 'system-ui, sans-serif'
    namePill.addControl(nameText)

    this._labels[id] = { stack, boostNum }
    return this._labels[id]
  }

  _makePads(padCount) {
    for (const m of this._padMeshes) m.dispose()
    this._padMeshes = []
    this._padPickedUpUntil = []

    // Standard RL boost pad positions (Unreal units).
    // Positions near the large corner pads (±3072, ±3904) are omitted — they
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

    // ── Body ────────────────────────────────────────────────
    const car = MeshBuilder.CreateBox(`car_${id}`, { width: L, height: H, depth: W }, this.scene)
    const bodyMat = new StandardMaterial(`carBody_${id}`, this.scene)
    bodyMat.diffuseColor = teamColor
    car.material = bodyMat

    // ── Cabin / roof (center-rear, darker team colour) ──────
    const cabinL = L * 0.46, cabinH = 0.28, cabinW = W * 0.78
    const cabin = MeshBuilder.CreateBox(`carCabin_${id}`, { width: cabinL, height: cabinH, depth: cabinW }, this.scene)
    cabin.position.x = -L * 0.06   // slightly toward rear
    cabin.position.y = H / 2 + cabinH / 2
    const cabinMat = new StandardMaterial(`carCabin_${id}`, this.scene)
    cabinMat.diffuseColor = teamColor.scale(0.6)
    cabin.material = cabinMat
    cabin.parent = car

    // ── Nose cap (+X face, light grey) ─────────────────────
    const nose = MeshBuilder.CreateBox(`carNose_${id}`, { width: 0.1, height: H * 0.72, depth: W * 0.9 }, this.scene)
    nose.position.x = L / 2 + 0.05
    nose.position.y = -H * 0.07
    const noseMat = new StandardMaterial(`carNoseMat_${id}`, this.scene)
    noseMat.diffuseColor = new Color3(0.88, 0.88, 0.88)
    nose.material = noseMat
    nose.parent = car

    // ── Rear spoiler (-X face) ──────────────────────────────
    const spoiler = MeshBuilder.CreateBox(`carSpoiler_${id}`, { width: 0.06, height: 0.24, depth: W * 0.65 }, this.scene)
    spoiler.position.x = -(L / 2 + 0.03)
    spoiler.position.y = H / 2 + 0.06
    const spoilerMat = new StandardMaterial(`carSpoilerMat_${id}`, this.scene)
    spoilerMat.diffuseColor = new Color3(0.18, 0.18, 0.18)
    spoiler.material = spoilerMat
    spoiler.parent = car

    // ── Wheels ──────────────────────────────────────────────
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

    // ── Boost flame (rear exhaust, -X direction) ────────────
    // Cylinder with diameterTop=0 gives a cone. With rotation.z=PI/2, local +Y → -X (tip points backward).
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

    const firstFrame = frames[0]
    if (firstFrame) {
      for (const car of firstFrame.cars) {
        this._carMeshes[car.id] = this._makeCar(car.id, car.team)
      }
    }
  }

  _loadDemoFrames() {
    // Two cars doing laps + ball bouncing — just to prove the scene works
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

  // ── Kickoff countdown GUI ──────────────────────────────────────────────────
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

      // Pass 1 — find showTime: first moment where ball is at centre AND all
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

      // Pass 2 — find goTime (first fast car after freeze begins)
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
    // Reset boost tracking so flame doesn't flicker on seek
    this._prevBoost = {}
    this._boostingUntil = {}
  }

  update(dt) {
    // Countdown runs even while paused (uses real time)
    if (this._countdown.active) this._tickCountdown()

    if (!this.playing || this.frames.length === 0) return

    const prevTime = this._prevTime

    // Clear processed-goal tracking when replay loops back to start
    if (this.currentTime < 5 && prevTime > 10) this._processedGoals.clear()

    this.currentTime += dt

    // Loop replay
    const last = this.frames[this.frames.length - 1].time
    if (this.currentTime > last) this.currentTime = 0

    // ── Goal skip: jump to kickoff and show countdown ─────────────────────
    if (this.meta?.goals) {
      for (let i = 0; i < this.meta.goals.length; i++) {
        const gt = this.meta.goals[i].time
        const kt = this._goalKickoffTimes[i]
        if (!kt || this._processedGoals.has(i)) continue
        // Did we just cross a goal time?
        if (prevTime <= gt && this.currentTime > gt) {
          this._processedGoals.add(i)
          // Jump to freeze start; count down to the actual kickoff
          this.seekTo(kt.showTime)
          this._countdown.active = true
          this._countdown.goTime = kt.goTime
          if (!this.playing) this.play()
          break
        }
      }
    }

    this._prevTime = this.currentTime

    // Advance frame index
    while (
      this._frameIndex < this.frames.length - 2 &&
      this.frames[this._frameIndex + 1].time <= this.currentTime
    ) {
      this._frameIndex++
    }

    const frameA = this.frames[this._frameIndex]
    const frameB = this.frames[Math.min(this._frameIndex + 1, this.frames.length - 1)]
    const span = frameB.time - frameA.time
    const alpha = span > 0 ? (this.currentTime - frameA.time) / span : 0

    // Interpolate ball
    this._ball.position = Vector3.Lerp(
      new Vector3(frameA.ball.x, frameA.ball.y, frameA.ball.z),
      new Vector3(frameB.ball.x, frameB.ball.y, frameB.ball.z),
      alpha,
    )

    // Hide all car meshes + labels, then show only active ones
    for (const mesh of Object.values(this._carMeshes)) mesh.setEnabled(false)
    for (const { stack } of Object.values(this._labels)) stack.isVisible = false

    for (const carA of frameA.cars) {
      if (!this._carMeshes[carA.id]) {
        this._carMeshes[carA.id] = this._makeCar(carA.id, carA.team)
      }
      const mesh = this._carMeshes[carA.id]
      mesh.setEnabled(true)

      const carB = frameB.cars.find(c => c.id === carA.id) ?? carA
      const pos = Vector3.Lerp(
        new Vector3(carA.x, carA.y, carA.z),
        new Vector3(carB.x, carB.y, carB.z),
        alpha,
      )
      mesh.position = pos
      mesh.rotationQuaternion = Quaternion.Slerp(
        new Quaternion(carA.qx, carA.qy, carA.qz, carA.qw),
        new Quaternion(carB.qx, carB.qy, carB.qz, carB.qw),
        alpha,
      )

      // Name tag + boost bar
      const label = this._getLabel(carA.id, carA.name, carA.team)
      label.stack.isVisible = true
      label.stack.linkWithMesh(mesh)
      label.stack.linkOffsetYInPixels = -55
      // Boost number: 0-255 → 0-100 display
      label.boostNum.text = String(Math.round(((carA.boost ?? 0) / 255) * 100))

      // Boost flame — boost is only replicated occasionally, so we extend the
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
    }

    // Update boost pad appearance — grey out when picked up, glow when available.
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

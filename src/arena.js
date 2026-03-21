import {
  MeshBuilder,
  StandardMaterial,
  Color3,
  Quaternion,
  TransformNode,
} from '@babylonjs/core'

// Rocket League arena — all positions in Babylon units (1 UU = UU_SCALE metres)
// RL coordinate system: X=right, Y=goal-to-goal, Z=up
// Babylon coordinate system: X=right, Y=up, Z=goal-to-goal  (same after coord swap)
export const UU_SCALE = 0.02

export const ARENA = {
  halfX:      4096 * UU_SCALE,  // side wall X position
  halfY:      5120 * UU_SCALE,  // end wall Z position (goal line)
  ceilingZ:   2044 * UU_SCALE,  // ceiling height (Babylon Y)
  goalWidth:  1786 * UU_SCALE,
  goalHeight:  642 * UU_SCALE,
  goalDepth:   880 * UU_SCALE,
  cornerCut:  1024 * UU_SCALE,  // length of each 45° diagonal corner section
}

// ── Shared material helper ────────────────────────────────────────────────────
function mat(scene, name, color, alpha = 1.0, emissive = null) {
  const m = new StandardMaterial(name, scene)
  m.diffuseColor = color
  if (emissive) m.emissiveColor = emissive
  m.alpha = alpha
  m.backFaceCulling = false
  return m
}

// Team colour palette
const BLUE_CLR        = new Color3(0.10, 0.30, 0.90)
const ORANGE_CLR      = new Color3(0.90, 0.45, 0.10)
const BLUE_WALL_CLR   = new Color3(0.22, 0.40, 0.88)
const ORANGE_WALL_CLR = new Color3(0.88, 0.44, 0.16)
const BLUE_EMI        = new Color3(0.03, 0.06, 0.22)
const ORANGE_EMI      = new Color3(0.22, 0.06, 0.01)

// Returns a wall/trim material tinted for the given team half
function teamMat(scene, name, isBlue, alpha = 0.12) {
  return mat(scene, name,
    isBlue ? BLUE_WALL_CLR : ORANGE_WALL_CLR,
    alpha,
    isBlue ? BLUE_EMI : ORANGE_EMI)
}

export function buildArena(scene) {
  const { halfX, halfY, ceilingZ, goalWidth, goalHeight, goalDepth, cornerCut: cc } = ARENA

  const T    = 0.25   // wall panel thickness
  const TR   = 4.0    // transition ramp width (suggests quarter-pipe curve)
  const rOff = TR / (2 * Math.SQRT2)  // half-width projected onto each axis

  // Width of the straight section on each side/end wall (between corner cuts)
  const sideHalf = halfY - cc          // length of each team's half of a side wall
  const endLen   = (halfX - cc) * 2
  const endFlankW = (endLen - goalWidth) / 2

  // Team iterators: [suffix, isBlue, zCenter]
  // Floor/ceiling halves are each halfY deep, centred at ±halfY/2
  // Side wall halves are each sideHalf deep, centred at ±sideHalf/2
  const TEAMS      = [['B', true, -halfY    / 2], ['O', false, halfY    / 2]]
  const SIDE_TEAMS = [['B', true, -sideHalf / 2], ['O', false, sideHalf / 2]]

  // ── Floor (two team-coloured halves) ──────────────────────────────────────
  // CreateGround has zero thickness → no vertical seam face at Z=0
  for (const [sfx, isBlue, zCenter] of TEAMS) {
    const fl = MeshBuilder.CreateGround(`floor${sfx}`, { width: halfX * 2, height: halfY }, scene)
    fl.position.set(0, 0, zCenter)
    fl.material = teamMat(scene, `floor${sfx}M`, isBlue, 0.55)
  }

  // Centre line
  const cl = MeshBuilder.CreateBox('centreLine', { width: halfX * 2, depth: 0.06, height: 0.02 }, scene)
  cl.position.y = 0.06
  cl.material = mat(scene, 'clMat', new Color3(1, 1, 1), 0.45)

  // ── Ceiling (two team-coloured halves) ────────────────────────────────────
  // CreateGround avoids a seam face at Z=0; rotated 180° to face downward
  for (const [sfx, isBlue, zCenter] of TEAMS) {
    const c = MeshBuilder.CreateGround(`ceil${sfx}`, { width: halfX * 2, height: halfY }, scene)
    c.position.set(0, ceilingZ, zCenter)
    c.rotation.x = Math.PI   // face inward (downward)
    c.material = teamMat(scene, `ceil${sfx}M`, isBlue, 0.08)
  }

  // ── Side walls — each split into blue and orange halves ───────────────────
  for (const [side, xPos] of [['L', -halfX], ['R', halfX]]) {
    for (const [sfx, isBlue, zCenter] of SIDE_TEAMS) {
      const w = MeshBuilder.CreateBox(`wall${side}${sfx}`, { width: T, height: ceilingZ, depth: sideHalf }, scene)
      w.position.set(xPos, ceilingZ / 2, zCenter)
      w.material = teamMat(scene, `wall${side}${sfx}M`, isBlue)
    }
  }

  // ── End walls (blue / orange — flanking + above goal opening) ─────────────
  for (const [sfx, isBlue, , zPos] of [['B', true, null, -halfY], ['O', false, null, halfY]]) {
    const wallMat = teamMat(scene, `ew${sfx}M`, isBlue)

    const lf = MeshBuilder.CreateBox(`ewL${sfx}`, { width: endFlankW, height: ceilingZ, depth: T }, scene)
    lf.position.set(-(goalWidth / 2 + endFlankW / 2), ceilingZ / 2, zPos)
    lf.material = wallMat

    const rf = MeshBuilder.CreateBox(`ewR${sfx}`, { width: endFlankW, height: ceilingZ, depth: T }, scene)
    rf.position.set(goalWidth / 2 + endFlankW / 2, ceilingZ / 2, zPos)
    rf.material = wallMat

    const aboveH = ceilingZ - goalHeight
    const ag = MeshBuilder.CreateBox(`ewA${sfx}`, { width: goalWidth, height: aboveH, depth: T }, scene)
    ag.position.set(0, goalHeight + aboveH / 2, zPos)
    ag.material = wallMat
  }

  // ── 4 diagonal corner walls (45°) ─────────────────────────────────────────
  const diagLen = cc * Math.SQRT2
  const cornerWalls = [
    { name: 'cBL', x: -(halfX - cc / 2), z: -(halfY - cc / 2), ry:     Math.PI / 4, isBlue: true  },
    { name: 'cBR', x:  (halfX - cc / 2), z: -(halfY - cc / 2), ry: 3 * Math.PI / 4, isBlue: true  },
    { name: 'cOL', x: -(halfX - cc / 2), z:  (halfY - cc / 2), ry: 3 * Math.PI / 4, isBlue: false },
    { name: 'cOR', x:  (halfX - cc / 2), z:  (halfY - cc / 2), ry:     Math.PI / 4, isBlue: false },
  ]
  for (const { name, x, z, ry, isBlue } of cornerWalls) {
    const cw = MeshBuilder.CreateBox(name, { width: diagLen, height: ceilingZ, depth: T }, scene)
    cw.position.set(x, ceilingZ / 2, z)
    cw.rotation.y = ry
    cw.material = teamMat(scene, name + 'M', isBlue)
  }

  // ── Floor ↔ wall transition strips — split per team half ──────────────────
  for (const [side, xPos] of [['L', -halfX], ['R', halfX]]) {
    const rz = side === 'L' ? Math.PI / 4 : -Math.PI / 4
    for (const [sfx, isBlue, zCenter] of SIDE_TEAMS) {
      const xOff = xPos + Math.sign(-xPos) * rOff

      const ft = MeshBuilder.CreateBox(`ftS${side}${sfx}`, { width: 0.15, height: TR, depth: sideHalf }, scene)
      ft.position.set(xOff, rOff, zCenter)
      ft.rotation.z = rz
      ft.material = teamMat(scene, `ftS${side}${sfx}M`, isBlue)

      const ct = MeshBuilder.CreateBox(`ctS${side}${sfx}`, { width: 0.15, height: TR, depth: sideHalf }, scene)
      ct.position.set(xOff, ceilingZ - rOff, zCenter)
      ct.rotation.z = -rz
      ct.material = teamMat(scene, `ctS${side}${sfx}M`, isBlue)
    }
  }

  // ── Corner floor + ceiling ramp strips ────────────────────────────────────
  const slopeDiag = TR * Math.SQRT2
  const cornerRamps = [
    { n: 'cRampBLf', x: -(halfX - cc / 2) + rOff, y: TR / 2,            z: -(halfY - cc / 2) + rOff, ry:     Math.PI / 4, pitch:  Math.PI / 4, isBlue: true  },
    { n: 'cRampBRf', x:  (halfX - cc / 2) - rOff, y: TR / 2,            z: -(halfY - cc / 2) + rOff, ry: 3 * Math.PI / 4, pitch: -Math.PI / 4, isBlue: true  },
    { n: 'cRampOLf', x: -(halfX - cc / 2) + rOff, y: TR / 2,            z:  (halfY - cc / 2) - rOff, ry: 3 * Math.PI / 4, pitch:  Math.PI / 4, isBlue: false },
    { n: 'cRampORf', x:  (halfX - cc / 2) - rOff, y: TR / 2,            z:  (halfY - cc / 2) - rOff, ry:     Math.PI / 4, pitch: -Math.PI / 4, isBlue: false },
    { n: 'cRampBLc', x: -(halfX - cc / 2) + rOff, y: ceilingZ - TR / 2, z: -(halfY - cc / 2) + rOff, ry:     Math.PI / 4, pitch: -Math.PI / 4, isBlue: true  },
    { n: 'cRampBRc', x:  (halfX - cc / 2) - rOff, y: ceilingZ - TR / 2, z: -(halfY - cc / 2) + rOff, ry: 3 * Math.PI / 4, pitch:  Math.PI / 4, isBlue: true  },
    { n: 'cRampOLc', x: -(halfX - cc / 2) + rOff, y: ceilingZ - TR / 2, z:  (halfY - cc / 2) - rOff, ry: 3 * Math.PI / 4, pitch: -Math.PI / 4, isBlue: false },
    { n: 'cRampORc', x:  (halfX - cc / 2) - rOff, y: ceilingZ - TR / 2, z:  (halfY - cc / 2) - rOff, ry:     Math.PI / 4, pitch:  Math.PI / 4, isBlue: false },
  ]
  for (const { n, x, y, z, ry, pitch, isBlue } of cornerRamps) {
    const ramp = MeshBuilder.CreateBox(n, { width: diagLen, height: 0.15, depth: slopeDiag }, scene)
    ramp.position.set(x, y, z)
    ramp.rotationQuaternion = Quaternion.RotationYawPitchRoll(ry, pitch, 0)
    ramp.material = teamMat(scene, n + 'M', isBlue)
  }

  // ── End wall trim strips ───────────────────────────────────────────────────
  for (const [sfx, isBlue, zPos, rx] of [['B', true, -halfY, -Math.PI / 4], ['O', false, halfY, Math.PI / 4]]) {
    const zOff   = Math.sign(-zPos) * rOff
    const flankXL = -(goalWidth / 2 + endFlankW / 2)
    const flankXR =  (goalWidth / 2 + endFlankW / 2)
    const tMat   = teamMat(scene, `trim${sfx}M`, isBlue)

    for (const [s, xPos] of [['L', flankXL], ['R', flankXR]]) {
      const ft = MeshBuilder.CreateBox(`ftE${sfx}${s}`, { width: endFlankW, height: TR, depth: 0.15 }, scene)
      ft.position.set(xPos, rOff, zPos + zOff)
      ft.rotation.x = rx
      ft.material = tMat
    }

    const ct = MeshBuilder.CreateBox(`ctE${sfx}`, { width: endLen, height: TR, depth: 0.15 }, scene)
    ct.position.set(0, ceilingZ - rOff, zPos + zOff)
    ct.rotation.x = -rx
    ct.material = tMat
  }

  // ── Recessed goals ─────────────────────────────────────────────────────────
  for (const [sfx, zPos, zDir, goalColor] of [
    ['B', -halfY, -1, BLUE_CLR],
    ['O',  halfY,  1, ORANGE_CLR],
  ]) {
    const gInnerMat = mat(scene, `gIn${sfx}`, goalColor, 0.18, null)
    const gBackMat  = mat(scene, `gBk${sfx}`, goalColor, 0.55, null)

    const bk = MeshBuilder.CreateBox(`gBk${sfx}`, { width: goalWidth, height: goalHeight, depth: T }, scene)
    bk.position.set(0, goalHeight / 2, zPos + zDir * goalDepth)
    bk.material = gBackMat

    for (const [xOff, s] of [
      [-(goalWidth / 2 + T / 2), 'L'],
      [ (goalWidth / 2 + T / 2), 'R'],
    ]) {
      const sw = MeshBuilder.CreateBox(`gSW${sfx}${s}`, { width: T, height: goalHeight, depth: goalDepth }, scene)
      sw.position.set(xOff, goalHeight / 2, zPos + zDir * goalDepth / 2)
      sw.material = gInnerMat
    }

    const gr = MeshBuilder.CreateBox(`gR${sfx}`, { width: goalWidth, height: T, depth: goalDepth }, scene)
    gr.position.set(0, goalHeight + T / 2, zPos + zDir * goalDepth / 2)
    gr.material = gInnerMat

    const gfl = MeshBuilder.CreateBox(`gF${sfx}`, { width: goalWidth, height: 0.05, depth: goalDepth }, scene)
    gfl.position.set(0, 0.025, zPos + zDir * goalDepth / 2)
    gfl.material = mat(scene, `gFl${sfx}M`, goalColor, 0.25)
  }

  // Group all arena meshes under a single root so the whole arena can be
  // scaled / repositioned as a unit (used for AR miniature mode).
  const root = new TransformNode('arenaRoot', scene)
  scene.meshes.forEach(m => { m.parent = root; m.isPickable = false })

  return root
}

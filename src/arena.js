import {
  MeshBuilder,
  StandardMaterial,
  Color3,
  Quaternion,
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

const WALL_CLR  = new Color3(0.45, 0.60, 0.90)
const TRIM_CLR  = new Color3(0.80, 0.88, 1.00)
const BLUE_CLR  = new Color3(0.10, 0.30, 0.90)
const ORANGE_CLR = new Color3(0.90, 0.45, 0.10)

export function buildArena(scene) {
  const { halfX, halfY, ceilingZ, goalWidth, goalHeight, goalDepth, cornerCut: cc } = ARENA

  const T    = 0.25   // wall panel thickness
  const TR   = 4.0    // transition ramp width (suggests quarter-pipe curve)
  const rOff = TR / (2 * Math.SQRT2)  // half-width projected onto each axis

  // Width of the straight section on each side/end wall (between corner cuts)
  const sideLen = (halfY - cc) * 2
  const endLen  = (halfX - cc) * 2
  // End wall: portion flanking each side of the goal
  const endFlankW = (endLen - goalWidth) / 2   // width of wall left/right of goal opening

  // ── Floor ─────────────────────────────────────────────────────────────────
  const floor = MeshBuilder.CreateBox('floor', { width: halfX * 2, depth: halfY * 2, height: 0.1 }, scene)
  floor.position.y = -0.05
  floor.material = mat(scene, 'floorMat', new Color3(0.07, 0.28, 0.07))

  // Centre line
  const cl = MeshBuilder.CreateBox('centreLine', { width: halfX * 2, depth: 0.06, height: 0.02 }, scene)
  cl.position.y = 0.06
  cl.material = mat(scene, 'clMat', new Color3(1, 1, 1), 0.45)

  // ── Ceiling ───────────────────────────────────────────────────────────────
  const ceil = MeshBuilder.CreateBox('ceiling', { width: halfX * 2, depth: halfY * 2, height: T }, scene)
  ceil.position.y = ceilingZ + T / 2
  ceil.material = mat(scene, 'ceilMat', WALL_CLR, 0.07, new Color3(0.05, 0.08, 0.18))

  // ── Side walls (left / right — span the straight Z section) ───────────────
  for (const [name, xPos] of [['wallL', -halfX], ['wallR', halfX]]) {
    const w = MeshBuilder.CreateBox(name, { width: T, height: ceilingZ, depth: sideLen }, scene)
    w.position.set(xPos, ceilingZ / 2, 0)
    w.material = mat(scene, name + 'M', WALL_CLR, 0.09, new Color3(0.05, 0.08, 0.18))
  }

  // ── End walls (blue / orange — flanking + above goal opening) ─────────────
  for (const [sfx, zPos] of [['B', -halfY], ['O', halfY]]) {
    const wallMat = mat(scene, `ew${sfx}M`, WALL_CLR, 0.09, new Color3(0.05, 0.08, 0.18))

    // Left flank
    const lf = MeshBuilder.CreateBox(`ewL${sfx}`, { width: endFlankW, height: ceilingZ, depth: T }, scene)
    lf.position.set(-(goalWidth / 2 + endFlankW / 2), ceilingZ / 2, zPos)
    lf.material = wallMat

    // Right flank
    const rf = MeshBuilder.CreateBox(`ewR${sfx}`, { width: endFlankW, height: ceilingZ, depth: T }, scene)
    rf.position.set(goalWidth / 2 + endFlankW / 2, ceilingZ / 2, zPos)
    rf.material = wallMat

    // Above goal
    const aboveH = ceilingZ - goalHeight
    const ag = MeshBuilder.CreateBox(`ewA${sfx}`, { width: goalWidth, height: aboveH, depth: T }, scene)
    ag.position.set(0, goalHeight + aboveH / 2, zPos)
    ag.material = wallMat
  }

  // ── 4 diagonal corner walls (45°) ─────────────────────────────────────────
  // Each connects a side wall end to an end wall end, at 45°.
  // Width of box = cc * √2 (diagonal span), rotated ry around Y.
  const diagLen = cc * Math.SQRT2
  const cornerWalls = [
    { name: 'cBL', x: -(halfX - cc / 2), z: -(halfY - cc / 2), ry:  Math.PI / 4 },
    { name: 'cBR', x:  (halfX - cc / 2), z: -(halfY - cc / 2), ry:  3 * Math.PI / 4 },
    { name: 'cOL', x: -(halfX - cc / 2), z:  (halfY - cc / 2), ry:  3 * Math.PI / 4 },
    { name: 'cOR', x:  (halfX - cc / 2), z:  (halfY - cc / 2), ry:  Math.PI / 4 },
  ]
  for (const { name, x, z, ry } of cornerWalls) {
    const cw = MeshBuilder.CreateBox(name, { width: diagLen, height: ceilingZ, depth: T }, scene)
    cw.position.set(x, ceilingZ / 2, z)
    cw.rotation.y = ry
    cw.material = mat(scene, name + 'M', WALL_CLR, 0.09, new Color3(0.05, 0.08, 0.18))
  }

  // ── Floor ↔ wall transition strips (suggest the quarter-pipe curve) ────────
  // Side walls: thin box rotated 45° around Z, placed at the wall base
  const trimMat = mat(scene, 'trimM', WALL_CLR, 0.09, new Color3(0.05, 0.08, 0.18))
  for (const [xPos, rz] of [[-halfX, Math.PI / 4], [halfX, -Math.PI / 4]]) {
    // floor trim
    const ft = MeshBuilder.CreateBox(`ftS${xPos > 0 ? 'R' : 'L'}`, { width: 0.15, height: TR, depth: sideLen }, scene)
    ft.position.set(xPos + Math.sign(-xPos) * rOff, rOff, 0)
    ft.rotation.z = rz
    ft.material = trimMat

    // ceiling trim
    const ct = MeshBuilder.CreateBox(`ctS${xPos > 0 ? 'R' : 'L'}`, { width: 0.15, height: TR, depth: sideLen }, scene)
    ct.position.set(xPos + Math.sign(-xPos) * rOff, ceilingZ - rOff, 0)
    ct.rotation.z = -rz
    ct.material = trimMat
  }

  // ── Corner floor + ceiling ramp strips ────────────────────────────────────
  const slopeDiag = TR * Math.SQRT2
  const cornerRamps = [
    // Floor ramps — center_y = TR/2, low (field) edge at y=0
    { n: 'cRampBLf', x: -(halfX - cc / 2) + rOff, y: TR / 2,            z: -(halfY - cc / 2) + rOff, ry: Math.PI / 4,     pitch:  Math.PI / 4 },
    { n: 'cRampBRf', x:  (halfX - cc / 2) - rOff, y: TR / 2,            z: -(halfY - cc / 2) + rOff, ry: 3 * Math.PI / 4, pitch: -Math.PI / 4 },
    { n: 'cRampOLf', x: -(halfX - cc / 2) + rOff, y: TR / 2,            z:  (halfY - cc / 2) - rOff, ry: 3 * Math.PI / 4, pitch:  Math.PI / 4 },
    { n: 'cRampORf', x:  (halfX - cc / 2) - rOff, y: TR / 2,            z:  (halfY - cc / 2) - rOff, ry: Math.PI / 4,     pitch: -Math.PI / 4 },
    // Ceiling ramps — center_y = ceilingZ-TR/2, high (field) edge at y=ceilingZ
    { n: 'cRampBLc', x: -(halfX - cc / 2) + rOff, y: ceilingZ - TR / 2, z: -(halfY - cc / 2) + rOff, ry: Math.PI / 4,     pitch: -Math.PI / 4 },
    { n: 'cRampBRc', x:  (halfX - cc / 2) - rOff, y: ceilingZ - TR / 2, z: -(halfY - cc / 2) + rOff, ry: 3 * Math.PI / 4, pitch:  Math.PI / 4 },
    { n: 'cRampOLc', x: -(halfX - cc / 2) + rOff, y: ceilingZ - TR / 2, z:  (halfY - cc / 2) - rOff, ry: 3 * Math.PI / 4, pitch: -Math.PI / 4 },
    { n: 'cRampORc', x:  (halfX - cc / 2) - rOff, y: ceilingZ - TR / 2, z:  (halfY - cc / 2) - rOff, ry: Math.PI / 4,     pitch:  Math.PI / 4 },
  ]
  for (const { n, x, y, z, ry, pitch } of cornerRamps) {
    const ramp = MeshBuilder.CreateBox(n, { width: diagLen, height: 0.15, depth: slopeDiag }, scene)
    ramp.position.set(x, y, z)
    ramp.rotationQuaternion = Quaternion.RotationYawPitchRoll(ry, pitch, 0)
    ramp.material = trimMat
  }

  // End walls (blue/orange): trim strips left and right of goal opening
  for (const [zPos, rx] of [[-halfY, -Math.PI / 4], [halfY, Math.PI / 4]]) {
    const sfx = zPos > 0 ? 'O' : 'B'
    const zOff = Math.sign(-zPos) * rOff
    const flankXL = -(goalWidth / 2 + endFlankW / 2)
    const flankXR =  (goalWidth / 2 + endFlankW / 2)

    // Floor trim: two strips flanking the goal opening
    for (const [s, xPos] of [['L', flankXL], ['R', flankXR]]) {
      const ft = MeshBuilder.CreateBox(`ftE${sfx}${s}`, { width: endFlankW, height: TR, depth: 0.15 }, scene)
      ft.position.set(xPos, rOff, zPos + zOff)
      ft.rotation.x = rx
      ft.material = trimMat
    }

    // Ceiling trim: single strip spanning the full end width
    const ct = MeshBuilder.CreateBox(`ctE${sfx}`, { width: endLen, height: TR, depth: 0.15 }, scene)
    ct.position.set(0, ceilingZ - rOff, zPos + zOff)
    ct.rotation.x = -rx
    ct.material = trimMat
  }

  // ── Recessed goals ─────────────────────────────────────────────────────────
  // Each goal is a box behind the end wall: open face toward the field,
  // back wall + two side walls + roof form the pocket.
  for (const [sfx, zPos, zDir, goalColor] of [
    ['B', -halfY, -1, BLUE_CLR],
    ['O',  halfY,  1, ORANGE_CLR],
  ]) {
    const gInnerMat = mat(scene, `gIn${sfx}`, goalColor, 0.18, null)
    const gBackMat  = mat(scene, `gBk${sfx}`, goalColor, 0.55, null)

    // Back wall (deepest point of goal, behind the end wall)
    const bk = MeshBuilder.CreateBox(`gBk${sfx}`, { width: goalWidth, height: goalHeight, depth: T }, scene)
    bk.position.set(0, goalHeight / 2, zPos + zDir * goalDepth)
    bk.material = gBackMat

    // Side walls
    for (const [xOff, s] of [
      [-(goalWidth / 2 + T / 2), 'L'],
      [ (goalWidth / 2 + T / 2), 'R'],
    ]) {
      const sw = MeshBuilder.CreateBox(`gSW${sfx}${s}`, { width: T, height: goalHeight, depth: goalDepth }, scene)
      sw.position.set(xOff, goalHeight / 2, zPos + zDir * goalDepth / 2)
      sw.material = gInnerMat
    }

    // Roof
    const gr = MeshBuilder.CreateBox(`gR${sfx}`, { width: goalWidth, height: T, depth: goalDepth }, scene)
    gr.position.set(0, goalHeight + T / 2, zPos + zDir * goalDepth / 2)
    gr.material = gInnerMat

    // Floor inside goal (visual only — slightly coloured)
    const gfl = MeshBuilder.CreateBox(`gF${sfx}`, { width: goalWidth, height: 0.05, depth: goalDepth }, scene)
    gfl.position.set(0, 0.025, zPos + zDir * goalDepth / 2)
    gfl.material = mat(scene, `gFl${sfx}M`, goalColor, 0.25)
  }

  // Arena meshes are never interactive — disable picking to skip per-frame raycasts
  scene.meshes.forEach(m => { m.isPickable = false })

  return floor
}

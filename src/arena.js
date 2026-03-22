import {
  MeshBuilder,
  StandardMaterial,
  Color3,
  Quaternion,
  TransformNode,
  Mesh,
  Vector3,
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
function mat(scene, name, color, alpha = 1.0, emissive = null, bfc = false) {
  const m = new StandardMaterial(name, scene)
  m.diffuseColor = color
  if (emissive) m.emissiveColor = emissive
  m.alpha = alpha
  m.backFaceCulling = bfc
  return m
}

// Clone a mesh with flipped normals and a separate material for the inner face.
function addInnerFace(mesh, innerMat) {
  innerMat.backFaceCulling = true
  const inner = mesh.clone(mesh.name + 'In')
  inner.makeGeometryUnique()
  inner.flipFaces(false)
  inner.material = innerMat
}

// Team colour palette
const BLUE_CLR        = new Color3(0.10, 0.30, 0.90)
const ORANGE_CLR      = new Color3(0.90, 0.45, 0.10)
const BLUE_WALL_CLR   = new Color3(0.22, 0.40, 0.88)
const ORANGE_WALL_CLR = new Color3(0.88, 0.44, 0.16)
const BLUE_EMI        = new Color3(0.03, 0.06, 0.22)
const ORANGE_EMI      = new Color3(0.22, 0.06, 0.01)
const BLUE_FLOOR_CLR   = new Color3(0.12, 0.18, 0.38)   // muted, desaturated blue
const ORANGE_FLOOR_CLR = new Color3(0.38, 0.20, 0.08)   // muted, desaturated orange

// Returns a wall/trim material tinted for the given team half
function teamMat(scene, name, isBlue, alpha = 0.12, bfc = false) {
  return mat(scene, name,
    isBlue ? BLUE_WALL_CLR : ORANGE_WALL_CLR,
    alpha,
    isBlue ? BLUE_EMI : ORANGE_EMI,
    bfc)
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
  const TEAMS = [['B', true, -halfY / 2], ['O', false, halfY / 2]]

  // ── Floor (two team-coloured halves, shaped to match octagonal arena) ────────
  // Built as ribbons so the 45° corner cuts are exact without earcut.
  // 4 paths at the key X positions give the correct diagonal edges.
  for (const [sfx, isBlue] of [['B', true], ['O', false]]) {
    const zNear = isBlue ? 0        : 0        // Z toward midfield
    const zFar  = isBlue ? -halfY   : halfY    // Z toward end wall
    const zCornerFar = isBlue ? -halfY + cc : halfY - cc  // where corner cut meets side wall

    // Both halves must have path points going in +Z so normals face up consistently.
    // Blue:   zCornerFar(-halfY+cc) < zNear(0)  → already +Z
    // Orange: zCornerFar(halfY-cc)  > zNear(0)  → swap so it also goes +Z
    const [pA, pB]   = isBlue ? [zCornerFar, zNear] : [zNear, zCornerFar]
    const [pAm, pBm] = isBlue ? [zFar, zNear]       : [zNear, zFar]
    const paths = [
      [new Vector3(-halfX,      0, pA),  new Vector3(-halfX,      0, pB)],
      [new Vector3(-halfX + cc, 0, pAm), new Vector3(-halfX + cc, 0, pBm)],
      [new Vector3( halfX - cc, 0, pAm), new Vector3( halfX - cc, 0, pBm)],
      [new Vector3( halfX,      0, pA),  new Vector3( halfX,      0, pB)],
    ]
    const fl = MeshBuilder.CreateRibbon(`floor${sfx}`, { pathArray: paths }, scene)
    fl.material = mat(scene, `floor${sfx}M`, isBlue ? BLUE_FLOOR_CLR : ORANGE_FLOOR_CLR, 1.0)
  }

  // Centre line — CreateGround so it has no Z-facing side faces
  const cl = MeshBuilder.CreateGround('centreLine', { width: halfX * 2, height: 0.06 }, scene)
  cl.position.y = 0.002
  cl.material = mat(scene, 'clMat', new Color3(1, 1, 1), 0.45)

  // ── Floor markings ────────────────────────────────────────────────────────
  const lMat  = mat(scene, 'lineMat', new Color3(1, 1, 1), 0.55)
  const lW    = 0.14   // line strip width (Babylon units)
  const Y     = 0.003  // float just above floor

  // Centre circle
  const centreCircle = MeshBuilder.CreateTorus('centreCircle',
    { diameter: 2 * 1024 * UU_SCALE, thickness: lW, tessellation: 64 }, scene)
  centreCircle.position.y = Y
  centreCircle.material = lMat

  // Goal boxes — front line + two side lines per team
  const boxDepth = 1100 * UU_SCALE   // depth of box into field (~22 BU)
  const boxHalfW = goalWidth / 2
  for (const [sfx, zSign, zWall] of [['B', -1, -halfY], ['O', 1, halfY]]) {
    const frontZ = zWall - zSign * boxDepth
    const sideZ  = zWall - zSign * boxDepth / 2

    const bf = MeshBuilder.CreateGround(`boxFront${sfx}`, { width: goalWidth + lW * 2, height: lW }, scene)
    bf.position.set(0, Y, frontZ)
    bf.material = lMat

    const bl = MeshBuilder.CreateGround(`boxLeft${sfx}`,  { width: lW, height: boxDepth }, scene)
    bl.position.set(-boxHalfW, Y, sideZ)
    bl.material = lMat

    const br = MeshBuilder.CreateGround(`boxRight${sfx}`, { width: lW, height: boxDepth }, scene)
    br.position.set(boxHalfW, Y, sideZ)
    br.material = lMat
  }

  // ── Ceiling (two team-coloured halves) ────────────────────────────────────
  // Ceiling removed — fully transparent, no mesh needed

  // ── Side walls — single mesh per side to avoid a seam face at Z=0 ──────────
  const sideLen = sideHalf * 2
  const WALL_CLR = new Color3(0.45, 0.60, 0.90)
  // Walls stop where fillets begin: R from floor, R from ceiling.
  const wallH   = ceilingZ - 2 * TR   // trimmed wall height
  const wallMidY = ceilingZ / 2       // centre Y unchanged (R + wallH/2 = ceilingZ/2)
  for (const [side, xPos] of [['L', -halfX], ['R', halfX]]) {
    for (const [sfx, isBlue, zCenter] of [['B', true, -sideHalf / 2], ['O', false, sideHalf / 2]]) {
      const w = MeshBuilder.CreateBox(`wall${side}${sfx}`, { width: T, height: wallH, depth: sideHalf }, scene)
      w.position.set(xPos, wallMidY, zCenter)
      w.material = teamMat(scene, `wall${side}${sfx}M`, isBlue, 0.008, true)
      addInnerFace(w, teamMat(scene, `wall${side}${sfx}InM`, isBlue, 0.72))
    }
  }

  // ── End walls (blue / orange — flanking + above goal opening) ─────────────
  for (const [sfx, isBlue, , zPos] of [['B', true, null, -halfY], ['O', false, null, halfY]]) {
    const wallMat    = teamMat(scene, `ew${sfx}M`,   isBlue, 0.008, true)
    const innerWallM = teamMat(scene, `ew${sfx}InM`, isBlue, 0.72)

    const lf = MeshBuilder.CreateBox(`ewL${sfx}`, { width: endFlankW, height: wallH, depth: T }, scene)
    lf.position.set(-(goalWidth / 2 + endFlankW / 2), wallMidY, zPos)
    lf.material = wallMat
    addInnerFace(lf, innerWallM)

    const rf = MeshBuilder.CreateBox(`ewR${sfx}`, { width: endFlankW, height: wallH, depth: T }, scene)
    rf.position.set(goalWidth / 2 + endFlankW / 2, wallMidY, zPos)
    rf.material = wallMat
    addInnerFace(rf, innerWallM)

    // Above-goal: floor is the goal opening (no floor fillet here), only trim at ceiling.
    const aboveH = ceilingZ - TR - goalHeight
    const ag = MeshBuilder.CreateBox(`ewA${sfx}`, { width: goalWidth, height: aboveH, depth: T }, scene)
    ag.position.set(0, goalHeight + aboveH / 2, zPos)
    ag.material = wallMat
    addInnerFace(ag, innerWallM)
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
    const cw = MeshBuilder.CreateBox(name, { width: diagLen, height: wallH, depth: T }, scene)
    cw.position.set(x, wallMidY, z)
    cw.rotation.y = ry
    cw.material = teamMat(scene, name + 'M', isBlue, 0.008, true)
    addInnerFace(cw, teamMat(scene, name + 'InM', isBlue, 0.72))
  }

  // ── Quarter-circle fillets (floor↔wall and ceiling↔wall transitions) ────────
  // Each fillet is a ribbon swept along a straight or diagonal path.
  // R = fillet radius; N = arc tessellation steps.
  const R = TR
  const N = 14

  // Build a ribbon from positionFn(arcT: 0..1, pathT: 0..1) → Vector3.
  const ribbon = (name, nA, nP, posFn, material) => {
    const pa = []
    for (let i = 0; i <= nA; i++) {
      const strip = []
      for (let j = 0; j <= nP; j++) strip.push(posFn(i / nA, j / nP))
      pa.push(strip)
    }
    const m = MeshBuilder.CreateRibbon(name, { pathArray: pa, sideOrientation: Mesh.DOUBLESIDE }, scene)
    m.material = material
    return m
  }

  // ─ Side wall fillets (left & right, floor + ceiling, split blue/orange) ────
  for (const [s, wallX] of [['L', -halfX], ['R', halfX]]) {
    const cx = wallX + (wallX < 0 ? R : -R)  // arc centre X

    const flA0 = wallX < 0 ? Math.PI : 0
    const flDA = wallX < 0 ? +Math.PI / 2 : -Math.PI / 2
    const clA0 = wallX < 0 ? Math.PI : 0
    const clDA = wallX < 0 ? -Math.PI / 2 : +Math.PI / 2
    const cy   = ceilingZ - R

    for (const [sfx, isBlue, zFrom, zTo] of [
      ['B', true,  -sideHalf, 0],
      ['O', false,  0,  sideHalf],
    ]) {
      const zSpan = zTo - zFrom
      const fM = teamMat(scene, `sfF${s}${sfx}M`, isBlue, 0.45)
      const cM = teamMat(scene, `sfC${s}${sfx}M`, isBlue, 0.45)

      ribbon(`flS${s}${sfx}`, N, 1, (a, p) => {
        const angle = flA0 + a * flDA
        return new Vector3(cx + R * Math.cos(angle), R + R * Math.sin(angle), zFrom + p * zSpan)
      }, fM)

      ribbon(`clS${s}${sfx}`, N, 1, (a, p) => {
        const angle = clA0 + a * clDA
        return new Vector3(cx + R * Math.cos(angle), cy + R * Math.sin(angle), zFrom + p * zSpan)
      }, cM)
    }
  }

  // ─ End wall fillets (per team, per flank, floor + ceiling) ────────────────
  for (const [sfx, isBlue, zWall] of [['B', true, -halfY], ['O', false, halfY]]) {
    const zIn = zWall < 0 ? +1 : -1   // inward Z direction
    const cz  = zWall + zIn * R        // arc centre Z
    const eM  = teamMat(scene, `ef${sfx}M`, isBlue, 0.45)

    // Same angle convention as side walls, with Z playing the role of X:
    // Blue  (wall at −Z, inward +Z): wall-contact angle π,  floor sweep +π/2
    // Orange(wall at +Z, inward −Z): wall-contact angle 0,  floor sweep −π/2
    const flA0 = isBlue ? Math.PI : 0
    const flDA = isBlue ? +Math.PI / 2 : -Math.PI / 2
    const clA0 = isBlue ? Math.PI : 0
    const clDA = isBlue ? -Math.PI / 2 : +Math.PI / 2

    for (const [fs, xFrom, xTo, hasFloor] of [
      ['L',  -(halfX - cc),  -goalWidth / 2, true ],
      ['G',  -goalWidth / 2,  goalWidth / 2, false],  // goal opening — ceiling only
      ['R',   goalWidth / 2,  halfX - cc,    true ],
    ]) {
      const xSpan = xTo - xFrom
      if (hasFloor) {
        ribbon(`flE${sfx}${fs}`, N, 1, (a, p) => {
          const angle = flA0 + a * flDA
          return new Vector3(xFrom + p * xSpan, R + R * Math.sin(angle), cz + R * Math.cos(angle))
        }, eM)
      }
      ribbon(`clE${sfx}${fs}`, N, 1, (a, p) => {
        const angle = clA0 + a * clDA
        return new Vector3(xFrom + p * xSpan, (ceilingZ - R) + R * Math.sin(angle), cz + R * Math.cos(angle))
      }, eM)
    }
  }

  // ─ Corner fillets (4 corners × floor + ceiling) ───────────────────────────
  // nx, nz = inward XZ normal of corner wall; A→B = wall bottom edge endpoints.
  const SQ2 = Math.SQRT2
  const cornerDefs = [
    { n: 'BL', nx:  1/SQ2, nz:  1/SQ2, isBlue: true,
      Ax: -halfX,      Az: -(halfY - cc), Bx: -(halfX - cc), Bz: -halfY       },
    { n: 'BR', nx: -1/SQ2, nz:  1/SQ2, isBlue: true,
      Ax:  halfX - cc, Az: -halfY,        Bx:  halfX,        Bz: -(halfY - cc) },
    { n: 'OL', nx:  1/SQ2, nz: -1/SQ2, isBlue: false,
      Ax: -halfX,      Az:  halfY - cc,   Bx: -(halfX - cc), Bz:  halfY        },
    { n: 'OR', nx: -1/SQ2, nz: -1/SQ2, isBlue: false,
      Ax:  halfX - cc, Az:  halfY,        Bx:  halfX,        Bz:  halfY - cc   },
  ]
  for (const { n: cn, nx, nz, isBlue, Ax, Az, Bx, Bz } of cornerDefs) {
    const cM  = teamMat(scene, `fc${cn}M`, isBlue, 0.45)
    const dpx = Bx - Ax, dpz = Bz - Az
    // Floor fillet: arc from wall contact (α=0) to floor contact (α=π/2)
    //   point = arcCentre − R·cos(α)·(nx,0,nz) − R·sin(α)·(0,1,0)
    ribbon(`fl${cn}`, N, N, (a, p) => {
      const alpha = a * Math.PI / 2
      const px = Ax + p * dpx, pz = Az + p * dpz
      return new Vector3(
        px + R * nx - R * Math.cos(alpha) * nx,
        R            - R * Math.sin(alpha),
        pz + R * nz - R * Math.cos(alpha) * nz,
      )
    }, cM)
    // Ceiling fillet: arc from wall contact (α=0) to ceiling contact (α=π/2, +Y)
    ribbon(`cl${cn}`, N, N, (a, p) => {
      const alpha = a * Math.PI / 2
      const px = Ax + p * dpx, pz = Az + p * dpz
      return new Vector3(
        px + R * nx - R * Math.cos(alpha) * nx,
        (ceilingZ - R) + R * Math.sin(alpha),
        pz + R * nz - R * Math.cos(alpha) * nz,
      )
    }, cM)
  }

  // ── Recessed goals ─────────────────────────────────────────────────────────
  const GR  = TR       // fillet radius inside goal (same as arena walls)
  const GN  = 8        // arc steps
  for (const [sfx, zPos, zDir, goalColor] of [
    ['B', -halfY, -1, BLUE_CLR],
    ['O',  halfY,  1, ORANGE_CLR],
  ]) {
    const gInnerMat = mat(scene, `gIn${sfx}`, goalColor, 0.18, null)
    const gBackMat  = mat(scene, `gBk${sfx}`, goalColor, 0.55, null)
    const gFiltMat  = mat(scene, `gFilt${sfx}M`, goalColor, 0.45)

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

    // ── Inside goal fillets ──────────────────────────────────────────────────
    const zOpen = zPos
    const zBack = zPos + zDir * goalDepth
    const zSpan = zBack - zOpen

    // Left side wall (inner face at x = -goalWidth/2, inward = +X)
    // Floor: π → 3π/2   Ceiling: π → π/2
    const lCx = -goalWidth / 2 + GR
    ribbon(`gFlL${sfx}`, GN, 1, (a, p) => {
      const angle = Math.PI + a * Math.PI / 2
      return new Vector3(lCx + GR * Math.cos(angle), GR + GR * Math.sin(angle), zOpen + p * zSpan)
    }, gFiltMat)
    ribbon(`gClL${sfx}`, GN, 1, (a, p) => {
      const angle = Math.PI - a * Math.PI / 2
      return new Vector3(lCx + GR * Math.cos(angle), (goalHeight - GR) + GR * Math.sin(angle), zOpen + p * zSpan)
    }, gFiltMat)

    // Right side wall (inner face at x = +goalWidth/2, inward = -X)
    // Floor: 0 → -π/2   Ceiling: 0 → π/2
    const rCx = goalWidth / 2 - GR
    ribbon(`gFlR${sfx}`, GN, 1, (a, p) => {
      const angle = -a * Math.PI / 2
      return new Vector3(rCx + GR * Math.cos(angle), GR + GR * Math.sin(angle), zOpen + p * zSpan)
    }, gFiltMat)
    ribbon(`gClR${sfx}`, GN, 1, (a, p) => {
      const angle = a * Math.PI / 2
      return new Vector3(rCx + GR * Math.cos(angle), (goalHeight - GR) + GR * Math.sin(angle), zOpen + p * zSpan)
    }, gFiltMat)

    // Back wall (inward = toward goal opening = -zDir)
    const bwIn = -zDir   // +1 for blue, -1 for orange
    const bcz  = zBack + bwIn * GR
    const bA0  = bwIn > 0 ? Math.PI : 0
    const bFlDA = bwIn > 0 ? +Math.PI / 2 : -Math.PI / 2
    const bClDA = bwIn > 0 ? -Math.PI / 2 : +Math.PI / 2
    ribbon(`gFlBk${sfx}`, GN, 1, (a, p) => {
      const angle = bA0 + a * bFlDA
      return new Vector3(-goalWidth / 2 + p * goalWidth, GR + GR * Math.sin(angle), bcz + GR * Math.cos(angle))
    }, gFiltMat)
    ribbon(`gClBk${sfx}`, GN, 1, (a, p) => {
      const angle = bA0 + a * bClDA
      return new Vector3(-goalWidth / 2 + p * goalWidth, (goalHeight - GR) + GR * Math.sin(angle), bcz + GR * Math.cos(angle))
    }, gFiltMat)
  }

  // Group all arena meshes under a single root so the whole arena can be
  // scaled / repositioned as a unit (used for AR miniature mode).
  const root = new TransformNode('arenaRoot', scene)
  scene.meshes.forEach(m => { m.parent = root; m.isPickable = false })

  return root
}

import {
  MeshBuilder,
  StandardMaterial,
  Color3,
  Vector3,
  Mesh,
} from '@babylonjs/core'

// Rocket League arena dimensions in Unreal units (divided by 100 → metres)
// Field: 8192 x 10240 uu → ~82 x 102 m, but we'll scale to something comfortable
// We use a 1:50 scale: 1 uu = 0.02 m
export const UU_SCALE = 0.02

export const ARENA = {
  halfX: 4096 * UU_SCALE,  // ~82m wide total → 41m half
  halfY: 5120 * UU_SCALE,  // ~102m long total → 51m half
  ceilingZ: 2048 * UU_SCALE,
  goalWidth: 1786 * UU_SCALE,
  goalHeight: 642 * UU_SCALE,
  goalDepth: 880 * UU_SCALE,
}

export function buildArena(scene) {
  const { halfX, halfY, ceilingZ, goalWidth, goalHeight, goalDepth } = ARENA

  // Floor
  const floor = MeshBuilder.CreateBox('floor', {
    width: halfX * 2,
    depth: halfY * 2,
    height: 0.1,
  }, scene)
  floor.position.y = -0.05
  const floorMat = new StandardMaterial('floorMat', scene)
  floorMat.diffuseColor = new Color3(0.1, 0.4, 0.1)
  floor.material = floorMat

  // Field lines (centre line + circle approximation)
  _addFieldLine(scene, 'centreLine', halfX * 2, 0.05, new Vector3(0, 0.06, 0))

  // Goals
  _addGoal(scene, 'blueGoal', new Vector3(0, 0, -halfY), goalWidth, goalHeight, goalDepth, new Color3(0.1, 0.2, 0.9))
  _addGoal(scene, 'orangeGoal', new Vector3(0, 0, halfY), goalWidth, goalHeight, goalDepth, new Color3(0.9, 0.4, 0.1))

  // Side walls (invisible collision guides, visible as thin panels)
  _addWall(scene, 'wallLeft',  new Vector3(-halfX, ceilingZ / 2, 0), 0.2, ceilingZ, halfY * 2)
  _addWall(scene, 'wallRight', new Vector3(halfX,  ceilingZ / 2, 0), 0.2, ceilingZ, halfY * 2)

  // Stadium stands (simple tiered boxes for visual context)
  _addStands(scene, halfX, halfY)

  return floor
}

function _addFieldLine(scene, name, width, depth, position) {
  const line = MeshBuilder.CreateBox(name, { width, depth, height: 0.02 }, scene)
  line.position = position
  const mat = new StandardMaterial(name + 'Mat', scene)
  mat.diffuseColor = new Color3(1, 1, 1)
  line.material = mat
}

function _addGoal(scene, name, position, width, height, depth, color) {
  const goal = MeshBuilder.CreateBox(name, { width, height, depth }, scene)
  goal.position = new Vector3(position.x, height / 2, position.z)
  const mat = new StandardMaterial(name + 'Mat', scene)
  mat.diffuseColor = color
  mat.wireframe = true
  goal.material = mat
}

function _addWall(scene, name, position, width, height, depth) {
  const wall = MeshBuilder.CreateBox(name, { width, height, depth }, scene)
  wall.position = position
  const mat = new StandardMaterial(name + 'Mat', scene)
  mat.diffuseColor = new Color3(0.3, 0.3, 0.5)
  mat.alpha = 0.15
  wall.material = mat
}

function _addStands(scene, halfX, halfY) {
  const standColor = new Color3(0.2, 0.2, 0.3)
  const configs = [
    { name: 'standN', pos: new Vector3(0, 3, -(halfY + 8)), size: [(halfX + 16) * 2, 6, 8] },
    { name: 'standS', pos: new Vector3(0, 3,  (halfY + 8)), size: [(halfX + 16) * 2, 6, 8] },
    { name: 'standE', pos: new Vector3(-(halfX + 8), 3, 0), size: [8, 6, (halfY + 16) * 2] },
    { name: 'standW', pos: new Vector3( (halfX + 8), 3, 0), size: [8, 6, (halfY + 16) * 2] },
  ]
  for (const { name, pos, size } of configs) {
    const stand = MeshBuilder.CreateBox(name, { width: size[0], height: size[1], depth: size[2] }, scene)
    stand.position = pos
    const mat = new StandardMaterial(name + 'Mat', scene)
    mat.diffuseColor = standColor
    stand.material = mat
  }
}

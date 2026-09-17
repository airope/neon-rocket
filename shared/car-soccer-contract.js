export const CAR_SOCCER_VERSION = 'neon-hyperdome-v3';

export const CAR_SOCCER_FIELD = Object.freeze({
  halfLength: 51.2,
  halfWidth: 40.96,
  ceiling: 20.44,
  ballRadius: 0.9125,
  goalHalfWidth: 8.928,
  goalHeight: 6.42,
  goalDepth: 8.8,
  floorCurveRadius: 4.0,
  roofCurveRadius: 3.6,
  cornerRadius: 10.5
});

export const OCTANE_CLASS_CAR = Object.freeze({
  mass: 180,
  hitboxSize: Object.freeze({ x: 1.20507, y: 0.386591, z: 0.866994 }),
  hitboxOffset: Object.freeze({ x: 0.138757, y: 0.20755, z: 0 }),
  dodgeDeadzone: 0.5,
  wheels: Object.freeze([
    Object.freeze({ axle: 'front', side: 'left', x: 0.5125, y: 0.20755, z: -0.259, radius: 0.125, suspensionRest: 0.38755 }),
    Object.freeze({ axle: 'front', side: 'right', x: 0.5125, y: 0.20755, z: 0.259, radius: 0.125, suspensionRest: 0.38755 }),
    Object.freeze({ axle: 'rear', side: 'left', x: -0.3375, y: 0.20755, z: -0.295, radius: 0.15, suspensionRest: 0.37055 }),
    Object.freeze({ axle: 'rear', side: 'right', x: -0.3375, y: 0.20755, z: 0.295, radius: 0.15, suspensionRest: 0.37055 })
  ])
});

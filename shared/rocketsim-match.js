export function goalTeamForBall(ball, field) {
  const position = ball.position;
  if (Math.abs(position.z) >= field.goalHalfWidth || position.y >= field.goalHeight) return null;
  const fullCrossing = field.halfLength + field.ballRadius;
  if (position.x > fullCrossing) return 0;
  if (position.x < -fullCrossing) return 1;
  return null;
}

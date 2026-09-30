// Generated. Graph membership is NOT authority or safe replay.
export const actionTransitions = {
  "PROPOSED": [
    "AUTHORIZED",
    "REJECTED"
  ],
  "AUTHORIZED": [
    "PREPARED",
    "REJECTED"
  ],
  "PREPARED": [
    "DISPATCHING",
    "REJECTED"
  ],
  "DISPATCHING": [
    "ACKNOWLEDGED",
    "UNCERTAIN"
  ],
  "ACKNOWLEDGED": [
    "VERIFIED",
    "FAILED",
    "UNCERTAIN",
    "COMPENSATED"
  ],
  "VERIFIED": [
    "COMPENSATED"
  ],
  "REJECTED": [],
  "FAILED": [
    "AUTHORIZED"
  ],
  "UNCERTAIN": [
    "ACKNOWLEDGED",
    "VERIFIED",
    "FAILED"
  ],
  "COMPENSATED": []
};
export function isActionTransitionAllowed(from, to) {
  return Object.hasOwn(actionTransitions, from) && actionTransitions[from].includes(to);
}

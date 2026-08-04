export const DFU_ENTRY_RESULT = Object.freeze({
  CONFIRMED: 'confirmed',
  UNCERTAIN: 'uncertain',
  FAILED: 'failed',
});

export function classifyDfuEntry(outcome = {}) {
  if (outcome.commandAccepted === true || outcome.writeSucceeded === true) {
    return DFU_ENTRY_RESULT.CONFIRMED;
  }
  if (outcome.disconnected === true) {
    return DFU_ENTRY_RESULT.UNCERTAIN;
  }
  return DFU_ENTRY_RESULT.FAILED;
}

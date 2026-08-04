export class AutomaticDfuHandoffState {
  constructor() {
    this.reset();
  }

  reset() {
    this.autoAttemptStarted = false;
  }

  evaluate({ visible, enabled, hasTarget }) {
    if (!visible) {
      this.reset();
      return 'idle';
    }

    if (!enabled) {
      return this.autoAttemptStarted ? 'auto-running' : 'waiting';
    }

    if (hasTarget && !this.autoAttemptStarted) {
      this.autoAttemptStarted = true;
      return 'start-auto';
    }

    return this.autoAttemptStarted ? 'manual-fallback' : 'manual-only';
  }
}

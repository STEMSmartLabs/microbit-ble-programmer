function normaliseHash(value) {
  return String(value || '').trim().toUpperCase();
}

export function classifyBluetoothCompatibility({ markerCandidates, deviceRuntimeHash, deviceProgramStart }) {
  if (!Array.isArray(markerCandidates) || markerCandidates.length === 0) {
    return { supported: false, reason: 'file', candidate: null };
  }

  const matchingLayout = markerCandidates.filter(candidate => (
    Number.isInteger(candidate?.offset) && candidate.offset === deviceProgramStart
  ));

  if (matchingLayout.length === 0) {
    return { supported: false, reason: 'layout', candidate: null };
  }

  const wantedHash = normaliseHash(deviceRuntimeHash);
  const candidate = matchingLayout.find(item => normaliseHash(item.runtimeHash) === wantedHash) || null;

  if (!candidate) {
    return { supported: false, reason: 'software', candidate: null };
  }

  return { supported: true, reason: 'ready', candidate };
}

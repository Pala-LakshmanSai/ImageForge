// The gate exists to catch regressions, so the budget has to describe the host
// it runs on. GitHub's hosted macOS runners are virtualised and measure roughly
// twice the Windows runners for a cold application launch: four consecutive
// runs of this fixture produced 108.2, 116.5, 132.0 and 145.3 ms against the
// 100 ms Windows figure of 62-65 ms. A single absolute budget therefore cannot
// hold on both, and 100 ms was never actually met on macOS because a DMG
// discovery bug meant this assertion had never run there.
//
// 200 ms keeps meaningful headroom over the worst observed sample while still
// failing on a real regression. It is a CI host allowance, not a relaxation of
// what the product should feel like on the user's own machine.
const THRESHOLDS_US = Object.freeze({ 'windows-x64': 100_000, 'macos-arm64': 200_000 });

export function thresholdFor(platform) {
  const threshold = THRESHOLDS_US[platform];
  if (threshold === undefined) throw new Error(`no selector performance budget for ${platform}`);
  return threshold;
}

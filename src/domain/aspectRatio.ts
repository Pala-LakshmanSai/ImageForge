export type AspectRatio = '16:9' | '1:1' | '9:16' | '4:3' | '3:4';

export interface AspectRatioOption {
  value: AspectRatio;
  label: string;
  width: number;
  height: number;
  use: string;
}

export const ASPECT_RATIOS: readonly AspectRatioOption[] = [
  { value: '16:9', label: '16:9', width: 1280, height: 720, use: 'YouTube landscape' },
  { value: '1:1', label: '1:1', width: 1024, height: 1024, use: 'Square posts' },
  { value: '9:16', label: '9:16', width: 720, height: 1280, use: 'Shorts and Reels' },
  { value: '4:3', label: '4:3', width: 1152, height: 864, use: 'Classic landscape' },
  { value: '3:4', label: '3:4', width: 864, height: 1152, use: 'Classic portrait' },
] as const;

export const DEFAULT_ASPECT_RATIO: AspectRatio = '16:9';

export function aspectRatioOption(value: AspectRatio): AspectRatioOption {
  return ASPECT_RATIOS.find((option) => option.value === value) ?? ASPECT_RATIOS[0];
}

/**
 * The one user-supplied file that drives a video.
 *
 * Deliberately flat: the user (or the upload form) produces this, GitHub
 * Actions renders it. No research agents, no source discovery - the data,
 * the facts and the colors all live in the file.
 */

export interface VideoInputEntity {
  id: string;
  name: string;
  color?: string;
  flagCode?: string | null;
  logoUrl?: string | null;
  group?: string | null;
}

export interface VideoInputObservation {
  entity: string;
  date: string;
  value: number;
}

export interface VideoInputFact {
  atDate: string;
  heading: string;
  body?: string;
  tiles?: string[];
}

export interface VideoInputGroup {
  id: string;
  label: string;
  color?: string;
}

export interface VideoInputSeriesPoint {
  date: string;
  value: number;
}

export interface VideoInputSettings {
  topN?: number;
  secondsPerYear?: number;
  scalePower?: number;
  minIntervalSeconds?: number;
  introSeconds?: number;
  outroSeconds?: number;
  backgroundColor?: string;
  dateDisplay?: 'auto' | 'year' | 'bC';
  finalHoldSeconds?: number;
  /** Presentation density. auto lets the renderer choose from the data. */
  layout?: 'auto' | 'standard' | 'dense' | 'focus';
}

export interface VideoInput {
  version: '1.0';
  title: string;
  metric: string;
  unit: string;
  valueFormat?: 'comma' | 'compact';
  canvas?: { width?: number; height?: number; fps?: number };
  settings?: VideoInputSettings;
  entities?: VideoInputEntity[];
  observations: VideoInputObservation[];
  facts?: VideoInputFact[];
  groups?: VideoInputGroup[];
  worldTotal?: VideoInputSeriesPoint[];
  sources?: string;
  endingTitle?: string;
}

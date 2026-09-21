/** Mirror of the Rust frame-tape contract (see crates/datarace-core/src/frames.rs). */

export interface FrameTapeEntity {
  id: string;
  name: string;
  flag?: string;
  flagCode?: string;
  color: string;
  logo?: string;
  image?: string;
  group?: string;
}

export interface FrameTapeBar {
  entityId: string;
  value: number;
  rank: number;
  previousRank?: number;
  width: number;
  held: boolean;
  rankDelta?: number;
  isMover: boolean;
}

export interface FrameTapeFrame {
  index: number;
  label: string;
  fromLabel: string;
  toLabel: string;
  t: number;
  isPeriodBoundary: boolean;
  maxValue: number;
  bars: FrameTapeBar[];
}

export interface FrameTape {
  fps: number;
  width: number;
  height: number;
  topN: number;
  framesPerTransition: number;
  durationInFrames: number;
  periodLabels: string[];
  entities: FrameTapeEntity[];
  frames: FrameTapeFrame[];
  notes: string[];
}
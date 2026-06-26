export interface VideoElement {
  id: string;
  name?: string;
  type: string;
  elements?: VideoElement[];
  track?: number;
  time?: number;
  duration?: number;
  x?: string | number;
  y?: string | number;
  width?: string | number;
  height?: string | number;
  fill_color?: string;
  text?: string;
  source?: string; // For images/videos/audio
  [key: string]: any;
}

export type VideoMediaElementType = 'image' | 'video' | 'audio';

export interface VideoFont {
  family: string;
  weight?: string | number;
  style?: string;
  source?: string;
}

export interface VideoSource {
  output_format?: string;
  width?: number;
  height?: number;
  duration?: number;
  elements: VideoElement[];
  fonts?: VideoFont[];
  [key: string]: any;
}


/** Shared types for the Avlija HTTP API. */

export type PtzMove =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'leftUp'
  | 'leftDown'
  | 'rightUp'
  | 'rightDown';

export interface DeviceInfo {
  model: string;
  hardware: string;
  hardwareVersion: string;
  serial: string;
  firmware: string;
  buildTime: string;
  uptimeTicks: number;
  videoInChannels: number;
  audioInChannels: number;
  talkInChannels: number;
}

export interface Capabilities {
  panTilt: boolean;
  opticalZoom: boolean;
  presets: boolean;
  talkBack: boolean;
}

export interface CameraInfo {
  id: string;
  name: string;
  host: string;
  online: boolean;
  error: string | null;
  device: DeviceInfo | null;
  capabilities: Capabilities;
  streams: {
    /** go2rtc stream names for the camera's native DVRIP transport. */
    dvrip: { main: string; sub: string };
    /** go2rtc stream names for the camera's RTSP transport. */
    rtsp: { main: string; sub: string };
  };
}

export interface CamerasResponse {
  cameras: CameraInfo[];
}

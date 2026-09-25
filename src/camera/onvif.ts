/**
 * Minimal ONVIF client for the camera's port 8899 service.
 *
 * Useful for two things DVRIP cannot do: obtaining the canonical RTSP URL
 * straight from the device, and reading encoder configuration.
 *
 * Security note: this firmware answers these calls with no authentication
 * (CVE-2025-65856/65857). Do not expose port 8899 beyond the LAN.
 */

const SOAP_ENVELOPE = (body: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" ` +
  `xmlns:tt="http://www.onvif.org/ver10/schema">` +
  `<s:Body>${body}</s:Body></s:Envelope>`;

export interface OnvifDeviceInformation {
  manufacturer: string;
  model: string;
  firmware: string;
  serialNumber: string;
  hardwareId: string;
}

export interface OnvifStreamProfile {
  token: string;
  name: string;
  encoding: string;
  width: number;
  height: number;
  frameRate: number;
  bitrateKbps: number;
}

export interface OnvifPtzConfig {
  hasPtzNode: boolean;
  defaultPanTiltSpeed?: { x: number; y: number };
  defaultZoomSpeed?: number;
  moveRamp: number;
  presetRamp: number;
}

export class OnvifClient {
  constructor(
    private readonly host: string,
    private readonly port = 8899,
    private readonly timeoutMs = 6000,
  ) {}

  private async soap(path: string, body: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`http://${this.host}:${this.port}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
        body: SOAP_ENVELOPE(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`ONVIF ${path} returned HTTP ${res.status}`);
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  private static tag(xml: string, name: string): string | undefined {
    const m = xml.match(new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`));
    return m?.[1];
  }

  async getDeviceInformation(): Promise<OnvifDeviceInformation> {
    const xml = await this.soap(
      '/onvif/device_service',
      '<GetDeviceInformation xmlns="http://www.onvif.org/ver10/device/wsdl"/>',
    );
    return {
      manufacturer: OnvifClient.tag(xml, 'Manufacturer') ?? '',
      model: OnvifClient.tag(xml, 'Model') ?? '',
      firmware: OnvifClient.tag(xml, 'FirmwareVersion') ?? '',
      serialNumber: OnvifClient.tag(xml, 'SerialNumber') ?? '',
      hardwareId: OnvifClient.tag(xml, 'HardwareId') ?? '',
    };
  }

  /**
   * Ask the device for its own RTSP URL. Authoritative, and avoids guessing
   * the channel-numbering base or the password encoding the RTSP server wants.
   */
  async getStreamUri(profileToken: string): Promise<string | null> {
    const xml = await this.soap(
      '/onvif/media_service',
      '<GetStreamUri xmlns="http://www.onvif.org/ver10/media/wsdl">' +
        '<StreamSetup><Stream xmlns="http://www.onvif.org/ver10/schema">RTP-Unicast</Stream>' +
        '<Transport xmlns="http://www.onvif.org/ver10/schema"><Protocol>RTSP</Protocol>' +
        '</Transport></StreamSetup>' +
        `<ProfileToken>${profileToken}</ProfileToken></GetStreamUri>`,
    );
    return OnvifClient.tag(xml, 'Uri') ?? null;
  }

  /** Video profiles, in the order the device lists them (main, sub, snap). */
  async getVideoProfiles(): Promise<OnvifStreamProfile[]> {
    const xml = await this.soap(
      '/onvif/media_service',
      '<GetVideoEncoderConfigurations xmlns="http://www.onvif.org/ver10/media/wsdl"/>',
    );
    const blocks = xml.match(/<(?:\w+:)?Configurations\b[\s\S]*?<\/(?:\w+:)?Configurations>/g) ?? [];
    return blocks.map((block) => {
      const width = Number(OnvifClient.tag(block, 'Width') ?? 0);
      const height = Number(OnvifClient.tag(block, 'Height') ?? 0);
      return {
        token: block.match(/token="([^"]*)"/)?.[1] ?? '',
        name: OnvifClient.tag(block, 'Name') ?? '',
        encoding: OnvifClient.tag(block, 'Encoding') ?? '',
        width,
        height,
        frameRate: Number(OnvifClient.tag(block, 'FrameRateLimit') ?? 0),
        bitrateKbps: Number(OnvifClient.tag(block, 'BitrateLimit') ?? 0),
      };
    });
  }

  /**
   * PTZ configuration. The PTZ node is present in the profile templates on
   * every build, so its presence does not imply a motor — check the
   * `SupportPTZDirectionControl` capability flag for that.
   */
  async getPtzConfiguration(): Promise<OnvifPtzConfig> {
    const xml = await this.soap(
      '/onvif/ptz_service',
      '<GetConfigurations xmlns="http://www.onvif.org/ver20/ptz/wsdl"/>',
    );
    const block = xml.match(/<(?:\w+:)?PTZConfiguration\b[\s\S]*?<\/(?:\w+:)?PTZConfiguration>/)?.[0] ?? '';
    return {
      hasPtzNode: block.length > 0,
      moveRamp: Number(block.match(/MoveRamp="([^"]*)"/)?.[1] ?? 0),
      presetRamp: Number(block.match(/PresetRamp="([^"]*)"/)?.[1] ?? 0),
      defaultPanTiltSpeed: {
        x: Number(block.match(/<tt:DefaultPTZSpeed><tt:PanTilt x="([^"]*)"/)?.[1] ?? NaN),
        y: Number(block.match(/<tt:DefaultPTZSpeed><tt:PanTilt [^>]*y="([^"]*)"/)?.[1] ?? NaN),
      },
      defaultZoomSpeed: Number(
        block.match(/<tt:DefaultPTZSpeed><tt:Zoom x="([^"]*)"/)?.[1] ?? NaN,
      ),
    };
  }
}

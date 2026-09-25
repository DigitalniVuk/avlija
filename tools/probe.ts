/**
 * Capability probe.
 *
 * Enumerates everything this camera exposes across its three protocols and
 * prints it as a report. Useful when adding a new camera: run it first to see
 * what it actually supports rather than what the model name suggests.
 *
 *   npm run probe -- --camera cam1
 *   npm run probe -- --camera cam1 --json > report.json
 */

import { execFile } from 'node:child_process';
import { Socket } from 'node:net';
import { promisify } from 'node:util';
import { loadConfig } from '../src/server/config.js';
import { Camera } from '../src/camera/camera.js';
import { sofiaHash } from '../src/camera/dvrip.js';

const run = promisify(execFile);

function parseArgs(argv: string[]): { camera: string; json: boolean } {
  const i = argv.indexOf('--camera');
  const j = argv.indexOf('--json');
  return {
    camera: i >= 0 ? (argv[i + 1] ?? 'cam1') : 'cam1',
    json: j >= 0,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig();
  const camConfig = config.cameras.find((c) => c.id === args.camera);
  if (!camConfig) throw new Error(`camera "${args.camera}" not in config`);

  const camera = new Camera(camConfig);
  const report: Record<string, unknown> = {
    config: { ...camConfig, password: '(redacted)' },
  };

  // ---- open TCP ports --------------------------------------------------
  report.ports = await scanPorts(camConfig.host);

  // ---- DVRIP -----------------------------------------------------------
  const dvrip: Record<string, unknown> = {};
  try {
    await camera.dvrip.open();
    const login = camera.dvrip.info;
    dvrip.login = { ret: 100, sessionId: `0x${login?.sessionId.toString(16)}`, ...login };
    dvrip.passwordHash = sofiaHash(camConfig.password);
    dvrip.device = await camera.deviceInfo();
    dvrip.systemFunction = await camera.dvrip.getSystemFunction();
    dvrip.encoder = await camera.dvrip.getConfig('Simplify.Encode');
    dvrip.network = await camera.dvrip.getConfig('NetWork.NetCommon');
    dvrip.ptzConfigBlock = await camera.dvrip.getConfig('OPPTZControl');
    dvrip.general = await camera.dvrip.getConfig('General.General');
    report.dvrip = dvrip;
  } catch (err) {
    report.dvrip = { error: err instanceof Error ? err.message : String(err) };
  }

  // ---- RTSP ------------------------------------------------------------
  const rtsp: Record<string, unknown> = { url: camera.rtspUrl(0) };
  try {
    const { stdout } = await run(
      'ffprobe',
      [
        '-v', 'error',
        '-rtsp_transport', 'tcp',
        '-show_entries', 'stream=codec_name,profile,width,height,avg_frame_rate,level',
        '-of', 'json',
        camera.rtspUrl(0),
      ],
      { timeout: 25_000 },
    );
    rtsp.probe = JSON.parse(stdout);
  } catch (err) {
    rtsp.probe = { error: (err as Error).message.split('\n')[0] };
  }

  report.rtsp = rtsp;

  // ---- ONVIF -----------------------------------------------------------
  const onvif: Record<string, unknown> = {};
  try {
    onvif.device = await camera.onvif.getDeviceInformation();
    onvif.profiles = await camera.onvif.getVideoProfiles();
    onvif.streamUri = await camera.onvif.getStreamUri('PROFILE_000');
    onvif.ptz = await camera.onvif.getPtzConfiguration();
    report.onvif = onvif;
  } catch (err) {
    report.onvif = { error: err instanceof Error ? err.message : String(err) };
  }

  // ---- capabilities ----------------------------------------------------
  report.capabilities = await camera.describeCapabilities();
  report.capabilityNotes = {
    note:
      'panTilt/zoom reflect verified physical movement, not firmware flags. ' +
      'Run "npm run ptz:verify" to measure against this specific camera.',
    firmwareFlagSupportPTZDirectionControl:
      ((dvrip.systemFunction as { OtherFunction?: Record<string, boolean> } | undefined)
        ?.OtherFunction?.SupportPTZDirectionControl ?? null),
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
  camera.close();
}

/** Scan the ports this firmware family is known to use. */
async function scanPorts(host: string): Promise<unknown> {
  const ports = [80, 554, 8899, 12901, 34567, 9527];
  const out: Record<string, string> = {};
  for (const port of ports) {
    out[String(port)] = await probeTcp(host, port);
  }
  return out;
}

function probeTcp(host: string, port: number, timeoutMs = 1500): Promise<string> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const done = (result: string): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done('open'));
    socket.once('timeout', () => done('timeout'));
    socket.once('error', (err: NodeJS.ErrnoException) => done(err.code ?? 'error'));
    socket.connect(port, host);
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

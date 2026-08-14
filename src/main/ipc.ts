import { BrowserWindow, ipcMain } from 'electron';
import type { SerialManager } from './serialManager';
import type {
  ConnectionStatus,
  DeviceRole,
  FsrData,
  ImuData,
  LogEntry,
  Mlx90614Data,
  MotorEncoderData,
  PcbTempData,
  RtdData,
  SensorStatusData,
  SerialPortInfo,
  TofData
} from '../renderer/types/imu';

type SerialManagers = Record<DeviceRole, SerialManager>;
type DevicePayload<T> = {
  role: DeviceRole;
  data: T;
};

const sendToRenderers = <T>(channel: string, payload: T): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
};

const withRole = <T>(role: DeviceRole, data: T): DevicePayload<T> => ({ role, data });

export const registerSerialIpc = (serialManagers: SerialManagers): void => {
  for (const [role, serialManager] of Object.entries(serialManagers) as Array<[DeviceRole, SerialManager]>) {
    serialManager.on('data', (data: ImuData) => sendToRenderers('serial:imu-data', withRole(role, data)));
    serialManager.on('tof-data', (data: TofData) => sendToRenderers('serial:tof-data', withRole(role, data)));
    serialManager.on('pcb-temp-data', (data: PcbTempData) => sendToRenderers('serial:pcb-temp-data', withRole(role, data)));
    serialManager.on('rtd-data', (data: RtdData) => sendToRenderers('serial:rtd-data', withRole(role, data)));
    serialManager.on('mlx90614-data', (data: Mlx90614Data) =>
      sendToRenderers('serial:mlx90614-data', withRole(role, data))
    );
    serialManager.on('fsr-data', (data: FsrData) => sendToRenderers('serial:fsr-data', withRole(role, data)));
    serialManager.on('motor-encoder-data', (data: MotorEncoderData) =>
      sendToRenderers('serial:motor-encoder-data', withRole(role, data))
    );
    serialManager.on('sensor-status', (data: SensorStatusData) =>
      sendToRenderers('serial:sensor-status', withRole(role, data))
    );
    serialManager.on('status', (status: ConnectionStatus) => sendToRenderers('serial:status', withRole(role, status)));
    serialManager.on('log', (entry: LogEntry) => sendToRenderers('serial:log', withRole(role, entry)));
    serialManager.on('packet-count', (count: number) => sendToRenderers('serial:packet-count', withRole(role, count)));
    serialManager.on('ports', (ports: SerialPortInfo[]) => sendToRenderers('serial:ports', ports));
  }

  ipcMain.handle('serial:list-ports', async () => serialManagers.gripper.listPorts());
  ipcMain.handle('serial:connect', async (_event, role: DeviceRole, path: string) => serialManagers[role].connect(path));
  ipcMain.handle('serial:disconnect', async (_event, role: DeviceRole) => serialManagers[role].disconnect());
  ipcMain.handle('serial:send-command', async (_event, role: DeviceRole, command: string) =>
    serialManagers[role].sendCommand(command)
  );
  ipcMain.handle('serial:snapshot', () => ({
    gripper: serialManagers.gripper.getSnapshot(),
    testJig: serialManagers.testJig.getSnapshot()
  }));
};

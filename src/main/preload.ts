import { contextBridge, ipcRenderer } from 'electron';
import type {
  ConnectionStatus,
  BleDeviceInfo,
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
  SerialSnapshots,
  TofData
} from '../renderer/types/imu';

type SerialEvent =
  | 'imu-data'
  | 'tof-data'
  | 'pcb-temp-data'
  | 'rtd-data'
  | 'mlx90614-data'
  | 'fsr-data'
  | 'motor-encoder-data'
  | 'sensor-status'
  | 'status'
  | 'log'
  | 'packet-count'
  | 'ports';
type BleEvent = 'devices';
type Unsubscribe = () => void;
type DevicePayload<T> = {
  role: DeviceRole;
  data: T;
};

const onSerial = <T>(channel: SerialEvent, listener: (payload: T, role: DeviceRole) => void): Unsubscribe => {
  const subscription = (_event: Electron.IpcRendererEvent, payload: DevicePayload<T>): void => {
    listener(payload.data, payload.role);
  };
  ipcRenderer.on(`serial:${channel}`, subscription);
  return () => ipcRenderer.removeListener(`serial:${channel}`, subscription);
};

const onSerialPorts = (listener: (ports: SerialPortInfo[]) => void): Unsubscribe => {
  const subscription = (_event: Electron.IpcRendererEvent, ports: SerialPortInfo[]): void => listener(ports);
  ipcRenderer.on('serial:ports', subscription);
  return () => ipcRenderer.removeListener('serial:ports', subscription);
};

const onBle = <T>(channel: BleEvent, listener: (payload: T) => void): Unsubscribe => {
  const subscription = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(`ble:${channel}`, subscription);
  return () => ipcRenderer.removeListener(`ble:${channel}`, subscription);
};

const serialApi = {
  listPorts: (): Promise<SerialPortInfo[]> => ipcRenderer.invoke('serial:list-ports'),
  connect: (role: DeviceRole, path: string): Promise<void> => ipcRenderer.invoke('serial:connect', role, path),
  disconnect: (role: DeviceRole): Promise<void> => ipcRenderer.invoke('serial:disconnect', role),
  sendCommand: (role: DeviceRole, command: string): Promise<void> => ipcRenderer.invoke('serial:send-command', role, command),
  getSnapshot: (): Promise<SerialSnapshots> => ipcRenderer.invoke('serial:snapshot'),
  onImuData: (listener: (data: ImuData, role: DeviceRole) => void): Unsubscribe => onSerial('imu-data', listener),
  onTofData: (listener: (data: TofData, role: DeviceRole) => void): Unsubscribe => onSerial('tof-data', listener),
  onPcbTempData: (listener: (data: PcbTempData, role: DeviceRole) => void): Unsubscribe =>
    onSerial('pcb-temp-data', listener),
  onRtdData: (listener: (data: RtdData, role: DeviceRole) => void): Unsubscribe => onSerial('rtd-data', listener),
  onMlx90614Data: (listener: (data: Mlx90614Data, role: DeviceRole) => void): Unsubscribe =>
    onSerial('mlx90614-data', listener),
  onFsrData: (listener: (data: FsrData, role: DeviceRole) => void): Unsubscribe => onSerial('fsr-data', listener),
  onMotorEncoderData: (listener: (data: MotorEncoderData, role: DeviceRole) => void): Unsubscribe =>
    onSerial('motor-encoder-data', listener),
  onSensorStatus: (listener: (data: SensorStatusData, role: DeviceRole) => void): Unsubscribe =>
    onSerial('sensor-status', listener),
  onStatus: (listener: (status: ConnectionStatus, role: DeviceRole) => void): Unsubscribe => onSerial('status', listener),
  onLog: (listener: (entry: LogEntry, role: DeviceRole) => void): Unsubscribe => onSerial('log', listener),
  onPacketCount: (listener: (count: number, role: DeviceRole) => void): Unsubscribe =>
    onSerial('packet-count', listener),
  onPorts: (listener: (ports: SerialPortInfo[]) => void): Unsubscribe => onSerialPorts(listener)
};

const bleApi = {
  selectDevice: (deviceId: string): Promise<boolean> => ipcRenderer.invoke('ble:select-device', deviceId),
  cancelDeviceSelection: (): Promise<boolean> => ipcRenderer.invoke('ble:cancel-selection'),
  onDevices: (listener: (devices: BleDeviceInfo[]) => void): Unsubscribe => onBle('devices', listener)
};

const fileApi = {
  selectExportFolder: (): Promise<string | null> => ipcRenderer.invoke('file:select-export-folder'),
  writeExportFile: (folderPath: string, fileName: string, bytes: Uint8Array): Promise<string> =>
    ipcRenderer.invoke('file:write-export-file', folderPath, fileName, bytes)
};

contextBridge.exposeInMainWorld('serialApi', serialApi);
contextBridge.exposeInMainWorld('bleApi', bleApi);
contextBridge.exposeInMainWorld('fileApi', fileApi);

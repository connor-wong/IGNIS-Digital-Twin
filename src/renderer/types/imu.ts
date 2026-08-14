export interface ImuData {
  roll: number;
  pitch: number;
  yaw: number;

  ax: number;
  ay: number;
  az: number;

  gx: number;
  gy: number;
  gz: number;
}

export interface TofData {
  resolution: number;
  frequency: number;
  sequence: number;
  distances: number[];
  statuses: number[];
}

export interface PcbTempData {
  sequence: number;
  tempC: number;
  present: boolean;
  valid: boolean;
}

export interface RtdData {
  sequence: number;
  leftPresent: boolean;
  rightPresent: boolean;
  leftValid: boolean;
  rightValid: boolean;
  leftTempC: number | null;
  rightTempC: number | null;
  leftFault: number;
  rightFault: number;
}

export interface Mlx90614Data {
  sequence: number;
  present: boolean;
  ambientValid: boolean;
  objectValid: boolean;
  ambientTempC: number | null;
  objectTempC: number | null;
}

export interface FsrData {
  sequence: number;
  leftPresent: boolean;
  rightPresent: boolean;
  leftTriggered: boolean;
  rightTriggered: boolean;
  leftRaw: number | null;
  rightRaw: number | null;
  leftMillivolts: number | null;
  rightMillivolts: number | null;
  leftPressure: number | null;
  rightPressure: number | null;
  leftResistanceKohm: number | null;
  rightResistanceKohm: number | null;
  leftForceGrams: number | null;
  rightForceGrams: number | null;
}

export interface FsrSteadySideStatus {
  steady: boolean;
  seconds: number;
  forceGrams: number | null;
  valid: boolean;
}

export interface FsrSteadyStatus {
  left: FsrSteadySideStatus;
  right: FsrSteadySideStatus;
  updatedAt: number | null;
}

export interface MotorEncoderData {
  sequence: number;
  encoderPresent: boolean;
  motorActive: boolean;
  motorEnabled: boolean;
  motorFault: boolean;
  motorSpeed: number;
  encoderTicks: number | null;
  angleDeg: number | null;
  rpm: number | null;
}

export interface TemperatureLogSample {
  index: number;
  sequence: number;
  timestampIso: string;
  timestampMs: number;
  elapsedSeconds: number;
  pcbTempC: number | null;
  leftTempC: number | null;
  rightTempC: number | null;
  irAmbientTempC: number | null;
  irObjectTempC: number | null;
  leftForceGrams: number | null;
  rightForceGrams: number | null;
  encoderTicks: number | null;
  encoderAngleDeg: number | null;
  encoderVelocityRpm: number | null;
  transport: ConnectionTransport;
  connectionStatus: ConnectionStatus;
}

export interface SensorProbeStatus {
  detected?: boolean;
  available?: boolean;
  valid?: boolean;
  fault?: boolean;
}

export interface SensorStatusData {
  imu?: SensorProbeStatus;
  tof?: SensorProbeStatus;
  pcbTemp?: SensorProbeStatus;
  leftPt1000?: SensorProbeStatus;
  rightPt1000?: SensorProbeStatus;
  encoder?: SensorProbeStatus;
  irTemp?: SensorProbeStatus;
  leftFsr?: SensorProbeStatus;
  rightFsr?: SensorProbeStatus;
}

export type SensorKey =
  | 'encoder'
  | 'leftPt1000'
  | 'rightPt1000'
  | 'pcbTemp'
  | 'imu'
  | 'tof'
  | 'irTemp'
  | 'leftFsr'
  | 'rightFsr';

export type SensorEnableState = Record<SensorKey, boolean>;

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';
export type ConnectionTransport = 'serial' | 'ble';
export type AcquisitionState = 'idle' | 'running' | 'paused';
export type DeviceRole = 'gripper' | 'testJig';
export type TestJigMotion = 'up' | 'down' | 'stopped';
export type TestMilestoneId = 'close' | 'steady' | 'jigUp' | 'hold' | 'jigDown' | 'open' | 'complete';
export type TestRunStatus = 'idle' | 'running' | 'complete' | 'aborted' | 'failed';

export interface DeviceConnectionState {
  status: ConnectionStatus;
  transport: ConnectionTransport;
  selectedPort: string | null;
  selectedBleDevice: string | null;
  packetCount: number;
  packetFrequency: number;
}

export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
}

export interface BleDeviceInfo {
  id: string;
  name: string;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

export interface SerialSnapshot {
  status: ConnectionStatus;
  selectedPort: string | null;
  packetCount: number;
  logs: LogEntry[];
}

export type SerialSnapshots = Record<DeviceRole, SerialSnapshot>;

export interface SerialApi {
  listPorts: () => Promise<SerialPortInfo[]>;
  connect: (role: DeviceRole, path: string) => Promise<void>;
  disconnect: (role: DeviceRole) => Promise<void>;
  sendCommand: (role: DeviceRole, command: string) => Promise<void>;
  getSnapshot: () => Promise<SerialSnapshots>;
  onImuData: (listener: (data: ImuData, role: DeviceRole) => void) => () => void;
  onTofData: (listener: (data: TofData, role: DeviceRole) => void) => () => void;
  onPcbTempData: (listener: (data: PcbTempData, role: DeviceRole) => void) => () => void;
  onRtdData: (listener: (data: RtdData, role: DeviceRole) => void) => () => void;
  onMlx90614Data: (listener: (data: Mlx90614Data, role: DeviceRole) => void) => () => void;
  onFsrData: (listener: (data: FsrData, role: DeviceRole) => void) => () => void;
  onMotorEncoderData: (listener: (data: MotorEncoderData, role: DeviceRole) => void) => () => void;
  onSensorStatus: (listener: (data: SensorStatusData, role: DeviceRole) => void) => () => void;
  onStatus: (listener: (status: ConnectionStatus, role: DeviceRole) => void) => () => void;
  onLog: (listener: (entry: LogEntry, role: DeviceRole) => void) => () => void;
  onPacketCount: (listener: (count: number, role: DeviceRole) => void) => () => void;
  onPorts: (listener: (ports: SerialPortInfo[]) => void) => () => void;
}

export interface BleApi {
  selectDevice: (deviceId: string) => Promise<boolean>;
  cancelDeviceSelection: () => Promise<boolean>;
  onDevices: (listener: (devices: BleDeviceInfo[]) => void) => () => void;
}

export interface FileApi {
  selectExportFolder: () => Promise<string | null>;
  writeExportFile: (folderPath: string, fileName: string, bytes: Uint8Array) => Promise<string>;
}

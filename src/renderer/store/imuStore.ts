import { create } from 'zustand';
import type {
  AcquisitionState,
  BleDeviceInfo,
  ConnectionStatus,
  ConnectionTransport,
  DeviceConnectionState,
  DeviceRole,
  FsrData,
  FsrSteadyStatus,
  ImuData,
  LogEntry,
  Mlx90614Data,
  MotorEncoderData,
  PcbTempData,
  RtdData,
  SensorEnableState,
  SensorKey,
  SensorStatusData,
  SerialPortInfo,
  SerialSnapshot,
  SerialSnapshots,
  TemperatureLogSample,
  TestMilestoneId,
  TestJigMotion,
  TestRunStatus,
  TofData
} from '../types/imu';

const emptyImuData: ImuData = {
  roll: 0,
  pitch: 0,
  yaw: 0,
  ax: 0,
  ay: 0,
  az: 0,
  gx: 0,
  gy: 0,
  gz: 0
};

const MAX_LOGS = 500;
const DEFAULT_SERIAL_PORT = 'COM6';
const PACKET_FREQUENCY_WINDOW_MS = 1000;
const MAX_REASONABLE_PACKET_FREQUENCY_HZ = 1000;
const PCB_TEMP_WARNING_C = 60;
const FINGER_TEMP_WARNING_C = 280;
const TEMPERATURE_WARNING_COOLDOWN_MS = 30000;
let lastPacketCountForFrequency = 0;
let lastPacketFrequencyAt: number | null = null;
const lastDevicePacketCountForFrequency: Record<DeviceRole, number> = {
  gripper: 0,
  testJig: 0
};
const lastDevicePacketFrequencyAt: Record<DeviceRole, number | null> = {
  gripper: null,
  testJig: null
};
let lastPcbTempWarningAt = 0;
let lastLeftFingerTempWarningAt = 0;
let lastRightFingerTempWarningAt = 0;
const emptyTofData: TofData = {
  resolution: 64,
  frequency: 0,
  sequence: 0,
  distances: Array.from({ length: 64 }, () => -1),
  statuses: Array.from({ length: 64 }, () => 255)
};

const emptyPcbTempData: PcbTempData = {
  sequence: 0,
  tempC: 0,
  present: false,
  valid: false
};

const emptyRtdData: RtdData = {
  sequence: 0,
  leftPresent: false,
  rightPresent: false,
  leftValid: false,
  rightValid: false,
  leftTempC: null,
  rightTempC: null,
  leftFault: 0,
  rightFault: 0
};

const emptyMlx90614Data: Mlx90614Data = {
  sequence: 0,
  present: false,
  ambientValid: false,
  objectValid: false,
  ambientTempC: null,
  objectTempC: null
};

const emptyFsrSteadyStatus: FsrSteadyStatus = {
  left: {
    steady: false,
    seconds: 0,
    forceGrams: null,
    valid: false
  },
  right: {
    steady: false,
    seconds: 0,
    forceGrams: null,
    valid: false
  },
  updatedAt: null
};

const emptyFsrData: FsrData = {
  sequence: 0,
  leftPresent: false,
  rightPresent: false,
  leftTriggered: false,
  rightTriggered: false,
  leftRaw: null,
  rightRaw: null,
  leftMillivolts: null,
  rightMillivolts: null,
  leftPressure: null,
  rightPressure: null,
  leftResistanceKohm: null,
  rightResistanceKohm: null,
  leftForceGrams: null,
  rightForceGrams: null
};

const emptyMotorEncoderData: MotorEncoderData = {
  sequence: 0,
  encoderPresent: false,
  motorActive: false,
  motorEnabled: false,
  motorFault: false,
  motorSpeed: 0,
  encoderTicks: null,
  angleDeg: null,
  rpm: null
};

const emptySensorStatus: SensorStatusData = {};

const defaultSensorEnabled: SensorEnableState = {
  encoder: true,
  leftPt1000: true,
  rightPt1000: true,
  pcbTemp: true,
  imu: true,
  tof: true,
  irTemp: true,
  leftFsr: true,
  rightFsr: true
};

const createDeviceConnection = (transport: ConnectionTransport, selectedPort: string | null, selectedBleDevice: string | null): DeviceConnectionState => ({
  status: 'disconnected',
  transport,
  selectedPort,
  selectedBleDevice,
  packetCount: 0,
  packetFrequency: 0
});

const createDeviceConnections = (): Record<DeviceRole, DeviceConnectionState> => ({
  gripper: createDeviceConnection('ble', DEFAULT_SERIAL_PORT, 'IGNIS-Gripper'),
  testJig: createDeviceConnection('serial', DEFAULT_SERIAL_PORT, 'IGNIS-Jig')
});

const createMotorEncoderByRole = (): Record<DeviceRole, MotorEncoderData> => ({
  gripper: emptyMotorEncoderData,
  testJig: emptyMotorEncoderData
});

const createLastMotorEncoderAtByRole = (): Record<DeviceRole, number | null> => ({
  gripper: null,
  testJig: null
});

const summarizeConnectionStatus = (connections: Record<DeviceRole, DeviceConnectionState>): ConnectionStatus => {
  const statuses = Object.values(connections).map((connection) => connection.status);
  if (statuses.includes('connected')) return 'connected';
  if (statuses.includes('connecting')) return 'connecting';
  if (statuses.includes('reconnecting')) return 'reconnecting';
  if (statuses.includes('error')) return 'error';
  return 'disconnected';
};

const summarizePacketCount = (connections: Record<DeviceRole, DeviceConnectionState>): number =>
  Object.values(connections).reduce((total, connection) => total + connection.packetCount, 0);

const summarizePacketFrequency = (connections: Record<DeviceRole, DeviceConnectionState>): number =>
  Object.values(connections).reduce((total, connection) => total + connection.packetFrequency, 0);

const appendLogs = (logs: LogEntry[], entries: LogEntry[]): LogEntry[] =>
  entries.length === 0 ? logs : [...logs, ...entries].slice(-MAX_LOGS);

const createTemperatureWarning = (
  sensorName: string,
  tempC: number,
  thresholdC: number,
  timestampMs: number,
  lastWarningAt: number
): LogEntry | null => {
  if (timestampMs - lastWarningAt < TEMPERATURE_WARNING_COOLDOWN_MS) {
    return null;
  }

  return {
    id: `${timestampMs}-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date(timestampMs).toISOString(),
    level: 'warning',
    message: `${sensorName} high: ${tempC.toFixed(1)} C exceeds ${thresholdC} C.`
  };
};

const resetTemperatureWarningTimers = (): void => {
  lastPcbTempWarningAt = 0;
  lastLeftFingerTempWarningAt = 0;
  lastRightFingerTempWarningAt = 0;
};

interface ImuState {
  imu: ImuData;
  tof: TofData;
  pcbTemp: PcbTempData;
  rtd: RtdData;
  mlx90614: Mlx90614Data;
  fsr: FsrData;
  fsrSteadyStatus: FsrSteadyStatus;
  motorEncoder: MotorEncoderData;
  motorEncoderByRole: Record<DeviceRole, MotorEncoderData>;
  status: ConnectionStatus;
  transport: ConnectionTransport;
  ports: SerialPortInfo[];
  selectedPort: string | null;
  activeDeviceRole: DeviceRole | null;
  deviceConnections: Record<DeviceRole, DeviceConnectionState>;
  bleDevices: BleDeviceInfo[];
  selectedBleDevice: string | null;
  sensorStatus: SensorStatusData;
  sensorEnabled: SensorEnableState;
  acquisitionState: AcquisitionState;
  acquisitionRunId: number;
  acquisitionStartedAt: number | null;
  acquisitionElapsedBeforePauseMs: number;
  temperatureLogging: boolean;
  temperatureLogStartedAt: number | null;
  temperatureLogElapsedBeforePauseMs: number;
  temperatureLogSamples: TemperatureLogSample[];
  importedTemperatureLogSamples: TemperatureLogSample[];
  importedTemperatureLogName: string | null;
  exportFolderPath: string | null;
  lastLoggedPcbTempSequence: number | null;
  logs: LogEntry[];
  packetCount: number;
  packetFrequency: number;
  lastPacketAt: number | null;
  lastImuAt: number | null;
  lastTofAt: number | null;
  lastPcbTempAt: number | null;
  lastRtdAt: number | null;
  lastMlx90614At: number | null;
  lastFsrAt: number | null;
  lastMotorEncoderAt: number | null;
  lastMotorEncoderAtByRole: Record<DeviceRole, number | null>;
  gripperSpeedTarget: number;
  testJigUpSpeedTarget: number;
  testJigDownSpeedTarget: number;
  testJigMotion: TestJigMotion;
  testRunStatus: TestRunStatus;
  activeTestMilestone: TestMilestoneId | null;
  testStatusMessage: string | null;
  testAbortRequestId: number;
  testObjectType: string;
  testLoadWeightKg: number | null;
  testRepeatCount: number;
  testContinuousMode: boolean;
  testRecordingEnabled: boolean;
  setImuData: (data: ImuData) => void;
  setTofData: (data: TofData) => void;
  setPcbTempData: (data: PcbTempData) => void;
  setRtdData: (data: RtdData) => void;
  setMlx90614Data: (data: Mlx90614Data) => void;
  setFsrData: (data: FsrData) => void;
  setFsrSteadyStatus: (status: FsrSteadyStatus) => void;
  resetFsrSteadyStatus: () => void;
  setMotorEncoderData: (data: MotorEncoderData, role?: DeviceRole) => void;
  setGripperSpeedTarget: (speed: number) => void;
  setTestJigUpSpeedTarget: (speed: number) => void;
  setTestJigDownSpeedTarget: (speed: number) => void;
  setTestJigMotion: (motion: TestJigMotion) => void;
  setTestRunState: (status: TestRunStatus, activeMilestone?: TestMilestoneId | null, message?: string | null) => void;
  requestTestAbort: () => void;
  setTestMetadata: (
    metadata: Partial<Pick<ImuState, 'testObjectType' | 'testLoadWeightKg' | 'testRepeatCount' | 'testContinuousMode'>>
  ) => void;
  setTestRecordingEnabled: (enabled: boolean) => void;
  setStatus: (status: ConnectionStatus, role?: DeviceRole) => void;
  setTransport: (transport: ConnectionTransport) => void;
  setPorts: (ports: SerialPortInfo[]) => void;
  setSelectedPort: (path: string | null) => void;
  setActiveDeviceRole: (role: DeviceRole | null) => void;
  setDeviceTransport: (role: DeviceRole, transport: ConnectionTransport) => void;
  setDeviceSelectedPort: (role: DeviceRole, path: string | null) => void;
  setDeviceSelectedBleDevice: (role: DeviceRole, deviceName: string | null) => void;
  setBleDevices: (devices: BleDeviceInfo[]) => void;
  setSelectedBleDevice: (deviceName: string | null) => void;
  setSensorStatus: (status: SensorStatusData) => void;
  setSensorEnabled: (sensor: SensorKey, enabled: boolean) => void;
  resetSensorStatus: () => void;
  startAcquisition: () => void;
  pauseAcquisition: () => void;
  continueAcquisition: () => void;
  stopAcquisition: () => void;
  startTemperatureLogging: () => void;
  stopTemperatureLogging: () => void;
  resetTemperatureLog: () => void;
  setImportedTemperatureLog: (samples: TemperatureLogSample[], fileName: string) => void;
  setExportFolderPath: (folderPath: string | null) => void;
  addLog: (entry: LogEntry) => void;
  setPacketCount: (count: number, role?: DeviceRole) => void;
  resetPacketStats: (role?: DeviceRole) => void;
  hydrateSnapshot: (snapshot: SerialSnapshot | SerialSnapshots) => void;
}

export const useImuStore = create<ImuState>((set, get) => ({
  imu: emptyImuData,
  tof: emptyTofData,
  pcbTemp: emptyPcbTempData,
  rtd: emptyRtdData,
  mlx90614: emptyMlx90614Data,
  fsr: emptyFsrData,
  fsrSteadyStatus: emptyFsrSteadyStatus,
  motorEncoder: emptyMotorEncoderData,
  motorEncoderByRole: createMotorEncoderByRole(),
  status: 'disconnected',
  transport: 'serial',
  ports: [],
  selectedPort: DEFAULT_SERIAL_PORT,
  activeDeviceRole: null,
  deviceConnections: createDeviceConnections(),
  bleDevices: [],
  selectedBleDevice: null,
  sensorStatus: emptySensorStatus,
  sensorEnabled: defaultSensorEnabled,
  acquisitionState: 'idle',
  acquisitionRunId: 0,
  acquisitionStartedAt: null,
  acquisitionElapsedBeforePauseMs: 0,
  temperatureLogging: false,
  temperatureLogStartedAt: null,
  temperatureLogElapsedBeforePauseMs: 0,
  temperatureLogSamples: [],
  importedTemperatureLogSamples: [],
  importedTemperatureLogName: null,
  exportFolderPath: window.localStorage.getItem('ignisExportFolderPath'),
  lastLoggedPcbTempSequence: null,
  logs: [],
  packetCount: 0,
  packetFrequency: 0,
  lastPacketAt: null,
  lastImuAt: null,
  lastTofAt: null,
  lastPcbTempAt: null,
  lastRtdAt: null,
  lastMlx90614At: null,
  lastFsrAt: null,
  lastMotorEncoderAt: null,
  lastMotorEncoderAtByRole: createLastMotorEncoderAtByRole(),
  gripperSpeedTarget: 160,
  testJigUpSpeedTarget: 120,
  testJigDownSpeedTarget: 120,
  testJigMotion: 'stopped',
  testRunStatus: 'idle',
  activeTestMilestone: null,
  testStatusMessage: null,
  testAbortRequestId: 0,
  testObjectType: '',
  testLoadWeightKg: null,
  testRepeatCount: 1,
  testContinuousMode: false,
  testRecordingEnabled: true,
  setImuData: (data) => {
    const now = performance.now();
    set({ imu: data, lastPacketAt: now, lastImuAt: Date.now() });
  },
  setTofData: (data) => {
    const now = performance.now();
    set({ tof: data, lastPacketAt: now, lastTofAt: Date.now() });
  },
  setPcbTempData: (data) => {
    const now = performance.now();
    const timestampMs = Date.now();
    const state = get();
    const warning =
      data.present && data.valid && data.tempC > PCB_TEMP_WARNING_C
        ? createTemperatureWarning('PCB temperature', data.tempC, PCB_TEMP_WARNING_C, timestampMs, lastPcbTempWarningAt)
        : null;

    if (warning) {
      lastPcbTempWarningAt = timestampMs;
    }

    const shouldLog =
      state.temperatureLogging &&
      data.present &&
      data.valid &&
      state.lastLoggedPcbTempSequence !== data.sequence;
    const gripperEncoder = state.motorEncoderByRole.gripper;

    set({
      pcbTemp: data,
      lastPacketAt: now,
      lastPcbTempAt: timestampMs,
      logs: warning ? appendLogs(state.logs, [warning]) : state.logs,
      ...(shouldLog
        ? {
            temperatureLogSamples: [
              ...state.temperatureLogSamples,
              {
                index: state.temperatureLogSamples.length + 1,
                sequence: data.sequence,
                timestampIso: new Date(timestampMs).toISOString(),
                timestampMs,
                elapsedSeconds:
                  (state.temperatureLogElapsedBeforePauseMs +
                    Math.max(timestampMs - (state.temperatureLogStartedAt ?? timestampMs), 0)) /
                  1000,
                pcbTempC: data.tempC,
                leftTempC: state.rtd.leftPresent && state.rtd.leftValid ? state.rtd.leftTempC : null,
                rightTempC: state.rtd.rightPresent && state.rtd.rightValid ? state.rtd.rightTempC : null,
                irAmbientTempC:
                  state.mlx90614.present && state.mlx90614.ambientValid ? state.mlx90614.ambientTempC : null,
                irObjectTempC:
                  state.mlx90614.present && state.mlx90614.objectValid ? state.mlx90614.objectTempC : null,
                leftForceGrams: state.fsr.leftPresent ? state.fsr.leftForceGrams : null,
                rightForceGrams: state.fsr.rightPresent ? state.fsr.rightForceGrams : null,
                encoderTicks: gripperEncoder.encoderPresent ? gripperEncoder.encoderTicks : null,
                encoderAngleDeg: gripperEncoder.encoderPresent ? gripperEncoder.angleDeg : null,
                encoderVelocityRpm: gripperEncoder.encoderPresent ? gripperEncoder.rpm : null,
                transport: state.transport,
                connectionStatus: state.status
              }
            ],
            importedTemperatureLogSamples: [],
            importedTemperatureLogName: null,
            lastLoggedPcbTempSequence: data.sequence
          }
        : {})
    });
  },
  setRtdData: (data) => {
    const now = performance.now();
    const timestampMs = Date.now();
    const warnings: LogEntry[] = [];

    if (data.leftPresent && data.leftValid && data.leftTempC !== null && data.leftTempC > FINGER_TEMP_WARNING_C) {
      const warning = createTemperatureWarning(
        'Left finger temperature',
        data.leftTempC,
        FINGER_TEMP_WARNING_C,
        timestampMs,
        lastLeftFingerTempWarningAt
      );
      if (warning) {
        lastLeftFingerTempWarningAt = timestampMs;
        warnings.push(warning);
      }
    }

    if (data.rightPresent && data.rightValid && data.rightTempC !== null && data.rightTempC > FINGER_TEMP_WARNING_C) {
      const warning = createTemperatureWarning(
        'Right finger temperature',
        data.rightTempC,
        FINGER_TEMP_WARNING_C,
        timestampMs,
        lastRightFingerTempWarningAt
      );
      if (warning) {
        lastRightFingerTempWarningAt = timestampMs;
        warnings.push(warning);
      }
    }

    set((state) => ({ rtd: data, lastPacketAt: now, lastRtdAt: timestampMs, logs: appendLogs(state.logs, warnings) }));
  },
  setMlx90614Data: (data) => {
    const now = performance.now();
    set({ mlx90614: data, lastPacketAt: now, lastMlx90614At: Date.now() });
  },
  setFsrData: (data) => {
    const now = performance.now();
    set((state) => ({
      fsr: data,
      lastPacketAt: now,
      lastFsrAt: Date.now(),
      sensorStatus: {
        ...state.sensorStatus,
        leftFsr: {
          ...state.sensorStatus.leftFsr,
          detected: data.leftPresent,
          available: data.leftPresent,
          valid: data.leftRaw !== null
        },
        rightFsr: {
          ...state.sensorStatus.rightFsr,
          detected: data.rightPresent,
          available: data.rightPresent,
          valid: data.rightRaw !== null
        }
      }
    }));
  },
  setFsrSteadyStatus: (fsrSteadyStatus) => set({ fsrSteadyStatus }),
  resetFsrSteadyStatus: () => set({ fsrSteadyStatus: emptyFsrSteadyStatus }),
  setMotorEncoderData: (data, role = 'gripper') =>
    set((state) => ({
      motorEncoder: state.activeDeviceRole === role || role === 'gripper' ? data : state.motorEncoder,
      motorEncoderByRole: { ...state.motorEncoderByRole, [role]: data },
      lastMotorEncoderAt: state.activeDeviceRole === role || role === 'gripper' ? Date.now() : state.lastMotorEncoderAt,
      lastMotorEncoderAtByRole: { ...state.lastMotorEncoderAtByRole, [role]: Date.now() }
    })),
  setGripperSpeedTarget: (gripperSpeedTarget) => set({ gripperSpeedTarget }),
  setTestJigUpSpeedTarget: (testJigUpSpeedTarget) => set({ testJigUpSpeedTarget }),
  setTestJigDownSpeedTarget: (testJigDownSpeedTarget) => set({ testJigDownSpeedTarget }),
  setTestJigMotion: (testJigMotion) => set({ testJigMotion }),
  setTestRunState: (testRunStatus, activeTestMilestone = null, testStatusMessage = null) =>
    set({ testRunStatus, activeTestMilestone, testStatusMessage }),
  requestTestAbort: () => set((state) => ({ testAbortRequestId: state.testAbortRequestId + 1 })),
  setTestMetadata: (metadata) => set(metadata),
  setTestRecordingEnabled: (testRecordingEnabled) => set({ testRecordingEnabled }),
  setStatus: (status, role) =>
    set((state) => {
      if (!role) {
        return status === 'disconnected'
          ? {
              status,
              activeDeviceRole: null,
              sensorStatus: emptySensorStatus,
              acquisitionState: 'idle',
              acquisitionStartedAt: null,
              acquisitionElapsedBeforePauseMs: 0,
              temperatureLogging: false,
              temperatureLogStartedAt: null
            }
          : { status };
      }

      const deviceConnections = {
        ...state.deviceConnections,
        [role]: {
          ...state.deviceConnections[role],
          status
        }
      };
      const nextStatus = summarizeConnectionStatus(deviceConnections);
      const anyConnected = Object.values(deviceConnections).some((connection) => connection.status === 'connected' || connection.status === 'reconnecting');
      const fallbackActiveRole =
        (Object.entries(deviceConnections) as Array<[DeviceRole, DeviceConnectionState]>).find(
          ([candidateRole, connection]) =>
            candidateRole !== role && (connection.status === 'connected' || connection.status === 'reconnecting')
        )?.[0] ?? null;

      return {
        deviceConnections,
        status: nextStatus,
        activeDeviceRole:
          status === 'connected'
            ? role
            : state.activeDeviceRole === role && !anyConnected
              ? null
              : state.activeDeviceRole === role
                ? fallbackActiveRole
                : state.activeDeviceRole,
        ...(role === 'gripper' && status === 'disconnected'
          ? {
              sensorStatus: emptySensorStatus,
              acquisitionState: 'idle' as AcquisitionState,
              acquisitionStartedAt: null,
              acquisitionElapsedBeforePauseMs: 0,
              temperatureLogging: false,
              temperatureLogStartedAt: null
            }
          : {})
      };
    }),
  setTransport: (transport) => set({ transport }),
  setPorts: (ports) => set({ ports }),
  setSelectedPort: (selectedPort) => set({ selectedPort }),
  setActiveDeviceRole: (activeDeviceRole) => set({ activeDeviceRole }),
  setDeviceTransport: (role, transport) =>
    set((state) => ({
      deviceConnections: {
        ...state.deviceConnections,
        [role]: { ...state.deviceConnections[role], transport }
      },
      ...(role === state.activeDeviceRole ? { transport } : {})
    })),
  setDeviceSelectedPort: (role, selectedPort) =>
    set((state) => ({
      deviceConnections: {
        ...state.deviceConnections,
        [role]: { ...state.deviceConnections[role], selectedPort }
      },
      ...(role === state.activeDeviceRole || role === 'gripper' ? { selectedPort } : {})
    })),
  setDeviceSelectedBleDevice: (role, selectedBleDevice) =>
    set((state) => ({
      deviceConnections: {
        ...state.deviceConnections,
        [role]: { ...state.deviceConnections[role], selectedBleDevice }
      },
      ...(role === state.activeDeviceRole || role === 'gripper' ? { selectedBleDevice } : {})
    })),
  setBleDevices: (bleDevices) => set({ bleDevices }),
  setSelectedBleDevice: (selectedBleDevice) => set({ selectedBleDevice }),
  setSensorStatus: (sensorStatus) => set({ sensorStatus }),
  setSensorEnabled: (sensor, enabled) =>
    set((state) => ({
      sensorEnabled: {
        ...state.sensorEnabled,
        [sensor]: enabled
      }
    })),
  resetSensorStatus: () => set({ sensorStatus: emptySensorStatus }),
  startAcquisition: () =>
    set((state) => ({
      acquisitionState: 'running',
      acquisitionRunId: state.acquisitionRunId + 1,
      acquisitionStartedAt: Date.now(),
      acquisitionElapsedBeforePauseMs: 0
    })),
  pauseAcquisition: () =>
    set((state) => {
      if (state.acquisitionState !== 'running' || !state.acquisitionStartedAt) {
        return { acquisitionState: 'paused' };
      }

      return {
        acquisitionState: 'paused',
        acquisitionStartedAt: null,
        acquisitionElapsedBeforePauseMs:
          state.acquisitionElapsedBeforePauseMs + Math.max(Date.now() - state.acquisitionStartedAt, 0)
      };
    }),
  continueAcquisition: () =>
    set((state) => ({
      acquisitionState: 'running',
      acquisitionStartedAt: Date.now(),
      acquisitionElapsedBeforePauseMs: state.acquisitionElapsedBeforePauseMs
    })),
  stopAcquisition: () =>
    set((state) => ({
      acquisitionState: 'idle',
      acquisitionRunId: state.acquisitionRunId + 1,
      acquisitionStartedAt: null,
      acquisitionElapsedBeforePauseMs: 0
    })),
  startTemperatureLogging: () =>
    set((state) => ({
      temperatureLogging: true,
      temperatureLogStartedAt: Date.now(),
      temperatureLogElapsedBeforePauseMs: state.temperatureLogElapsedBeforePauseMs,
      importedTemperatureLogSamples: [],
      importedTemperatureLogName: null
    })),
  stopTemperatureLogging: () =>
    set((state) => {
      if (!state.temperatureLogging) {
        return {};
      }

      return {
        temperatureLogging: false,
        temperatureLogStartedAt: null,
        temperatureLogElapsedBeforePauseMs:
          state.temperatureLogElapsedBeforePauseMs +
          Math.max(Date.now() - (state.temperatureLogStartedAt ?? Date.now()), 0)
      };
    }),
  resetTemperatureLog: () =>
    set({
      temperatureLogging: false,
      temperatureLogStartedAt: null,
      temperatureLogElapsedBeforePauseMs: 0,
      temperatureLogSamples: [],
      importedTemperatureLogSamples: [],
      importedTemperatureLogName: null,
      lastLoggedPcbTempSequence: null
    }),
  setImportedTemperatureLog: (importedTemperatureLogSamples, importedTemperatureLogName) =>
    set({
      temperatureLogging: false,
      temperatureLogStartedAt: null,
      temperatureLogElapsedBeforePauseMs: 0,
      temperatureLogSamples: [],
      lastLoggedPcbTempSequence: null,
      importedTemperatureLogSamples,
      importedTemperatureLogName
    }),
  setExportFolderPath: (exportFolderPath) => {
    if (exportFolderPath) {
      window.localStorage.setItem('ignisExportFolderPath', exportFolderPath);
    } else {
      window.localStorage.removeItem('ignisExportFolderPath');
    }
    set({ exportFolderPath });
  },
  addLog: (entry) => set((state) => ({ logs: [...state.logs.slice(-(MAX_LOGS - 1)), entry] })),
  setPacketCount: (packetCount, role) => {
    const now = performance.now();
    const state = get();
    if (role) {
      let devicePacketFrequency = state.deviceConnections[role].packetFrequency;

      if (lastDevicePacketFrequencyAt[role] === null || packetCount < lastDevicePacketCountForFrequency[role]) {
        lastDevicePacketFrequencyAt[role] = now;
        lastDevicePacketCountForFrequency[role] = packetCount;
      } else if (now - (lastDevicePacketFrequencyAt[role] ?? now) >= PACKET_FREQUENCY_WINDOW_MS) {
        const nextPacketFrequency =
          ((packetCount - lastDevicePacketCountForFrequency[role]) * 1000) /
          Math.max(now - (lastDevicePacketFrequencyAt[role] ?? now), 1);
        devicePacketFrequency =
          nextPacketFrequency <= MAX_REASONABLE_PACKET_FREQUENCY_HZ ? nextPacketFrequency : devicePacketFrequency;
        lastDevicePacketFrequencyAt[role] = now;
        lastDevicePacketCountForFrequency[role] = packetCount;
      }

      const deviceConnections = {
        ...state.deviceConnections,
        [role]: {
          ...state.deviceConnections[role],
          packetCount,
          packetFrequency: devicePacketFrequency
        }
      };

      set({
        deviceConnections,
        packetCount: summarizePacketCount(deviceConnections),
        packetFrequency: summarizePacketFrequency(deviceConnections)
      });
      return;
    }

    let packetFrequency = state.packetFrequency;

    if (lastPacketFrequencyAt === null || packetCount < lastPacketCountForFrequency) {
      lastPacketFrequencyAt = now;
      lastPacketCountForFrequency = packetCount;
    } else if (now - lastPacketFrequencyAt >= PACKET_FREQUENCY_WINDOW_MS) {
      const nextPacketFrequency = ((packetCount - lastPacketCountForFrequency) * 1000) / Math.max(now - lastPacketFrequencyAt, 1);
      packetFrequency = nextPacketFrequency <= MAX_REASONABLE_PACKET_FREQUENCY_HZ ? nextPacketFrequency : packetFrequency;
      lastPacketFrequencyAt = now;
      lastPacketCountForFrequency = packetCount;
    }

    set({ packetCount, packetFrequency });
  },
  resetPacketStats: (role) => {
    if (role) {
      lastDevicePacketCountForFrequency[role] = 0;
      lastDevicePacketFrequencyAt[role] = null;
    } else {
      lastPacketCountForFrequency = 0;
      lastPacketFrequencyAt = null;
      lastDevicePacketCountForFrequency.gripper = 0;
      lastDevicePacketCountForFrequency.testJig = 0;
      lastDevicePacketFrequencyAt.gripper = null;
      lastDevicePacketFrequencyAt.testJig = null;
    }
    resetTemperatureWarningTimers();

    if (role) {
      set((state) => {
        const deviceConnections = {
          ...state.deviceConnections,
          [role]: {
            ...state.deviceConnections[role],
            packetCount: 0,
            packetFrequency: 0
          }
        };

        return {
          deviceConnections,
          packetCount: summarizePacketCount(deviceConnections),
          packetFrequency: summarizePacketFrequency(deviceConnections),
          ...(role === 'gripper'
            ? {
                pcbTemp: emptyPcbTempData,
                rtd: emptyRtdData,
                mlx90614: emptyMlx90614Data,
                fsr: emptyFsrData,
                fsrSteadyStatus: emptyFsrSteadyStatus,
                sensorStatus: emptySensorStatus,
                lastPacketAt: null,
                lastImuAt: null,
                lastTofAt: null,
                lastPcbTempAt: null,
                lastRtdAt: null,
                lastMlx90614At: null,
                lastFsrAt: null
              }
            : {}),
          motorEncoderByRole: { ...state.motorEncoderByRole, [role]: emptyMotorEncoderData },
          lastMotorEncoderAtByRole: { ...state.lastMotorEncoderAtByRole, [role]: null },
          ...(state.activeDeviceRole === role ? { motorEncoder: emptyMotorEncoderData, lastMotorEncoderAt: null } : {})
        };
      });
      return;
    }

    set({
      pcbTemp: emptyPcbTempData,
      rtd: emptyRtdData,
      mlx90614: emptyMlx90614Data,
      fsr: emptyFsrData,
      fsrSteadyStatus: emptyFsrSteadyStatus,
      motorEncoder: emptyMotorEncoderData,
      motorEncoderByRole: createMotorEncoderByRole(),
      sensorStatus: emptySensorStatus,
      deviceConnections: createDeviceConnections(),
      packetCount: 0,
      packetFrequency: 0,
      lastPacketAt: null,
      lastImuAt: null,
      lastTofAt: null,
      lastPcbTempAt: null,
      lastRtdAt: null,
      lastMlx90614At: null,
      lastFsrAt: null,
      lastMotorEncoderAt: null,
      lastMotorEncoderAtByRole: createLastMotorEncoderAtByRole()
    });
  },
  hydrateSnapshot: (snapshot) =>
    set((state) => {
      const isSnapshotMap = 'gripper' in snapshot && 'testJig' in snapshot;
      if (!isSnapshotMap) {
        return {
          status: snapshot.status,
          selectedPort: snapshot.selectedPort,
          packetCount: snapshot.packetCount,
          logs: snapshot.logs
        };
      }

      const deviceConnections = {
        ...state.deviceConnections,
        gripper: {
          ...state.deviceConnections.gripper,
          status: snapshot.gripper.status,
          selectedPort: snapshot.gripper.selectedPort,
          packetCount: snapshot.gripper.packetCount
        },
        testJig: {
          ...state.deviceConnections.testJig,
          status: snapshot.testJig.status,
          selectedPort: snapshot.testJig.selectedPort,
          packetCount: snapshot.testJig.packetCount
        }
      };

      return {
        deviceConnections,
        status: summarizeConnectionStatus(deviceConnections),
        selectedPort: snapshot.gripper.selectedPort,
        packetCount: summarizePacketCount(deviceConnections),
        logs: [...snapshot.gripper.logs, ...snapshot.testJig.logs].slice(-MAX_LOGS)
      };
    })
}));

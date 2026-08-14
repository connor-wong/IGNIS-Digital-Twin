import { useImuStore } from '../store/imuStore';
import type {
  DeviceRole,
  FsrData,
  ImuData,
  LogEntry,
  Mlx90614Data,
  MotorEncoderData,
  PcbTempData,
  RtdData,
  SensorStatusData,
  TofData
} from '../types/imu';

const DEFAULT_BLE_DEVICE_NAME = 'IGNIS-Gripper';
const BLE_SERVICE_UUID = '12345678-1234-5678-1234-56789abcdef0';
const BLE_CHARACTERISTIC_UUID = '12345678-1234-5678-1234-56789abcdef1';
const MAX_INTEGRATION_DT_SECONDS = 0.1;
const COMPACT_IMU_PACKET_SIZE = 18;
const COMPACT_TOF_V1_PACKET_SIZE = 200;
const COMPACT_TOF_V2_PACKET_SIZE = 144;
const COMPACT_PCB_TEMP_PACKET_SIZE = 8;
const COMPACT_RTD_PACKET_SIZE = 12;
const COMPACT_MLX90614_PACKET_SIZE = 10;
const COMPACT_SENSOR_STATUS_PACKET_SIZE = 8;
const COMPACT_FSR_PACKET_SIZE = 26;
const COMPACT_MOTOR_ENCODER_PACKET_SIZE = 16;
const COMPACT_IMU_MAGIC_0 = 0x49; // I
const COMPACT_IMU_MAGIC_1 = 0x4d; // M
const COMPACT_TOF_MAGIC_0 = 0x54; // T
const COMPACT_TOF_MAGIC_1 = 0x46; // F
const COMPACT_PCB_TEMP_MAGIC_0 = 0x50; // P
const COMPACT_PCB_TEMP_MAGIC_1 = 0x42; // B
const COMPACT_RTD_MAGIC_0 = 0x52; // R
const COMPACT_RTD_MAGIC_1 = 0x44; // D
const COMPACT_MLX90614_MAGIC_0 = 0x49; // I
const COMPACT_MLX90614_MAGIC_1 = 0x52; // R
const COMPACT_SENSOR_STATUS_MAGIC_0 = 0x53; // S
const COMPACT_SENSOR_STATUS_MAGIC_1 = 0x54; // T
const COMPACT_FSR_MAGIC_0 = 0x46; // F
const COMPACT_FSR_MAGIC_1 = 0x53; // S
const COMPACT_MOTOR_ENCODER_MAGIC_0 = 0x4d; // M
const COMPACT_MOTOR_ENCODER_MAGIC_1 = 0x45; // E
const COMPACT_IMU_VERSION = 1;
const COMPACT_TOF_VERSION = 2;
const COMPACT_FSR_VERSION = 2;
const UNKNOWN_BLE_PACKET_LOG_INTERVAL_MS = 3000;
const BLE_COMMAND_GAP_MS = 120;
const BLE_WRITE_RETRY_DELAYS_MS = [150, 300, 600, 1000];

type BleSession = {
  role: DeviceRole;
  device: BluetoothDevice | null;
  server: BluetoothRemoteGATTServer | null;
  characteristic: BluetoothRemoteGATTCharacteristic | null;
  packetCount: number;
  lastUnknownBlePacketLogAt: number;
  lastCommandWriteAt: number;
  commandQueue: Promise<void>;
  handler: ((event: Event) => void) | null;
};

const createSession = (role: DeviceRole): BleSession => ({
  role,
  device: null,
  server: null,
  characteristic: null,
  packetCount: 0,
  lastUnknownBlePacketLogAt: 0,
  lastCommandWriteAt: 0,
  commandQueue: Promise.resolve(),
  handler: null
});

const sessions: Record<DeviceRole, BleSession> = {
  gripper: createSession('gripper'),
  testJig: createSession('testJig')
};

let lastImuData: ImuData | null = null;
let lastPacketAt: number | null = null;
let warnedAboutEstimatedOrientation = false;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const addLog = (level: LogEntry['level'], message: string): void => {
  useImuStore.getState().addLog({
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    level,
    message
  });
};

const mergeSensorStatus = (patch: SensorStatusData): void => {
  const current = useImuStore.getState().sensorStatus;
  useImuStore.getState().setSensorStatus({
    ...current,
    imu: patch.imu ? { ...current.imu, ...patch.imu } : current.imu,
    tof: patch.tof ? { ...current.tof, ...patch.tof } : current.tof,
    pcbTemp: patch.pcbTemp ? { ...current.pcbTemp, ...patch.pcbTemp } : current.pcbTemp,
    leftPt1000: patch.leftPt1000 ? { ...current.leftPt1000, ...patch.leftPt1000 } : current.leftPt1000,
    rightPt1000: patch.rightPt1000 ? { ...current.rightPt1000, ...patch.rightPt1000 } : current.rightPt1000,
    encoder: patch.encoder ? { ...current.encoder, ...patch.encoder } : current.encoder,
    irTemp: patch.irTemp ? { ...current.irTemp, ...patch.irTemp } : current.irTemp,
    leftFsr: patch.leftFsr ? { ...current.leftFsr, ...patch.leftFsr } : current.leftFsr,
    rightFsr: patch.rightFsr ? { ...current.rightFsr, ...patch.rightFsr } : current.rightFsr
  });
};

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const radiansToDegrees = (value: number): number => (value * 180) / Math.PI;

const normalizeDegrees = (value: number): number => ((((value + 180) % 360) + 360) % 360) - 180;

const hasSensorData = (
  payload: Partial<ImuData>
): payload is Partial<ImuData> & Pick<ImuData, 'ax' | 'ay' | 'az' | 'gx' | 'gy' | 'gz'> =>
  isFiniteNumber(payload.ax) &&
  isFiniteNumber(payload.ay) &&
  isFiniteNumber(payload.az) &&
  isFiniteNumber(payload.gx) &&
  isFiniteNumber(payload.gy) &&
  isFiniteNumber(payload.gz);

const normalizeImuData = (payload: Partial<ImuData>): ImuData | null => {
  if (!hasSensorData(payload)) {
    return null;
  }

  const now = performance.now();
  const dt = lastPacketAt ? Math.min((now - lastPacketAt) / 1000, MAX_INTEGRATION_DT_SECONDS) : 0;
  lastPacketAt = now;

  const hasOrientation =
    isFiniteNumber(payload.roll) && isFiniteNumber(payload.pitch) && isFiniteNumber(payload.yaw);

  if (!hasOrientation && !warnedAboutEstimatedOrientation) {
    warnedAboutEstimatedOrientation = true;
    addLog(
      'info',
      'BLE packets do not include roll/pitch/yaw; estimating roll and pitch from accelerometer and yaw from gyro Z.'
    );
  }

  const estimatedRoll = radiansToDegrees(Math.atan2(payload.ay, payload.az));
  const estimatedPitch = radiansToDegrees(
    Math.atan2(-payload.ax, Math.sqrt(payload.ay * payload.ay + payload.az * payload.az))
  );
  const estimatedYaw = normalizeDegrees((lastImuData?.yaw ?? 0) + payload.gz * dt);

  return {
    roll: isFiniteNumber(payload.roll) ? payload.roll : estimatedRoll,
    pitch: isFiniteNumber(payload.pitch) ? payload.pitch : estimatedPitch,
    yaw: isFiniteNumber(payload.yaw) ? normalizeDegrees(payload.yaw) : estimatedYaw,
    ax: payload.ax,
    ay: payload.ay,
    az: payload.az,
    gx: payload.gx,
    gy: payload.gy,
    gz: payload.gz
  };
};

const parseCompactImuPacket = (value: DataView): Partial<ImuData> | null => {
  if (
    value.byteLength !== COMPACT_IMU_PACKET_SIZE ||
    value.getUint8(0) !== COMPACT_IMU_MAGIC_0 ||
    value.getUint8(1) !== COMPACT_IMU_MAGIC_1 ||
    value.getUint8(2) !== COMPACT_IMU_VERSION
  ) {
    return null;
  }

  return {
    ax: value.getInt16(6, true) / 1000,
    ay: value.getInt16(8, true) / 1000,
    az: value.getInt16(10, true) / 1000,
    gx: value.getInt16(12, true) / 10,
    gy: value.getInt16(14, true) / 10,
    gz: value.getInt16(16, true) / 10
  };
};

const parseCompactTofPacket = (value: DataView): TofData | null => {
  const version = value.byteLength >= 3 ? value.getUint8(2) : 0;
  const expectedSize = version === COMPACT_TOF_VERSION ? COMPACT_TOF_V2_PACKET_SIZE : COMPACT_TOF_V1_PACKET_SIZE;

  if (
    value.byteLength !== expectedSize ||
    value.getUint8(0) !== COMPACT_TOF_MAGIC_0 ||
    value.getUint8(1) !== COMPACT_TOF_MAGIC_1 ||
    (version !== COMPACT_IMU_VERSION && version !== COMPACT_TOF_VERSION)
  ) {
    return null;
  }

  const distances: number[] = [];
  const statuses: number[] = [];
  for (let i = 0; i < 64; i += 1) {
    distances.push(value.getInt16(8 + i * 2, true));
    if (version === COMPACT_TOF_VERSION) {
      const valid = Boolean(value.getUint8(136 + Math.floor(i / 8)) & (1 << (i % 8)));
      statuses.push(valid ? 5 : 255);
    } else {
      statuses.push(value.getUint8(136 + i));
    }
  }

  return {
    resolution: value.getUint8(6),
    frequency: value.getUint8(7),
    sequence: value.getUint16(4, true),
    distances,
    statuses
  };
};

const parseCompactPcbTempPacket = (value: DataView): PcbTempData | null => {
  if (
    value.byteLength !== COMPACT_PCB_TEMP_PACKET_SIZE ||
    value.getUint8(0) !== COMPACT_PCB_TEMP_MAGIC_0 ||
    value.getUint8(1) !== COMPACT_PCB_TEMP_MAGIC_1 ||
    value.getUint8(2) !== COMPACT_IMU_VERSION
  ) {
    return null;
  }

  const flags = value.getUint8(3);
  return {
    sequence: value.getUint16(4, true),
    tempC: value.getInt16(6, true) / 100,
    present: Boolean(flags & 0x01),
    valid: Boolean(flags & 0x02)
  };
};

const parseCompactRtdPacket = (value: DataView): RtdData | null => {
  if (
    value.byteLength !== COMPACT_RTD_PACKET_SIZE ||
    value.getUint8(0) !== COMPACT_RTD_MAGIC_0 ||
    value.getUint8(1) !== COMPACT_RTD_MAGIC_1 ||
    value.getUint8(2) !== COMPACT_IMU_VERSION
  ) {
    return null;
  }

  const flags = value.getUint8(3);
  const leftC100 = value.getInt16(6, true);
  const rightC100 = value.getInt16(8, true);

  return {
    sequence: value.getUint16(4, true),
    leftPresent: Boolean(flags & 0x01),
    rightPresent: Boolean(flags & 0x02),
    leftValid: Boolean(flags & 0x04),
    rightValid: Boolean(flags & 0x08),
    leftTempC: leftC100 === -32768 ? null : leftC100 / 100,
    rightTempC: rightC100 === -32768 ? null : rightC100 / 100,
    leftFault: value.getUint8(10),
    rightFault: value.getUint8(11)
  };
};

const parseCompactMlx90614Packet = (value: DataView): Mlx90614Data | null => {
  const hasStandardMagic =
    value.byteLength === COMPACT_MLX90614_PACKET_SIZE &&
    value.getUint8(0) === COMPACT_MLX90614_MAGIC_0 &&
    value.getUint8(1) === COMPACT_MLX90614_MAGIC_1;
  const hasNullPrefixedMagic =
    value.byteLength === COMPACT_MLX90614_PACKET_SIZE &&
    value.getUint8(0) === 0x00 &&
    value.getUint8(1) === COMPACT_MLX90614_MAGIC_1;

  if (
    value.byteLength !== COMPACT_MLX90614_PACKET_SIZE ||
    (!hasStandardMagic && !hasNullPrefixedMagic) ||
    value.getUint8(2) !== COMPACT_IMU_VERSION
  ) {
    return null;
  }

  const flags = value.getUint8(3);
  const ambientC100 = value.getInt16(6, true);
  const objectC100 = value.getInt16(8, true);

  return {
    sequence: value.getUint16(4, true),
    present: Boolean(flags & 0x01),
    ambientValid: Boolean(flags & 0x02),
    objectValid: Boolean(flags & 0x04) || Boolean(flags & 0x02),
    ambientTempC: ambientC100 === -32768 ? null : ambientC100 / 100,
    objectTempC: objectC100 === -32768 ? null : objectC100 / 100
  };
};

const parseCompactSensorStatusPacket = (value: DataView): SensorStatusData | null => {
  if (
    value.byteLength !== COMPACT_SENSOR_STATUS_PACKET_SIZE ||
    value.getUint8(0) !== COMPACT_SENSOR_STATUS_MAGIC_0 ||
    value.getUint8(1) !== COMPACT_SENSOR_STATUS_MAGIC_1 ||
    value.getUint8(2) !== COMPACT_IMU_VERSION
  ) {
    return null;
  }

  const detectedMask = value.getUint8(3);
  const availableMask = value.getUint8(4);
  const validMask = value.getUint8(5);
  const faultMask = value.getUint8(6);
  const readProbe = (bit: number) => {
    const mask = 1 << bit;
    const detected = Boolean(detectedMask & mask);
    const available = Boolean(availableMask & mask);
    return {
      detected,
      available,
      valid: detected || available ? Boolean(validMask & mask) : undefined,
      fault: Boolean(faultMask & mask)
    };
  };

  return {
    imu: readProbe(0),
    tof: readProbe(1),
    pcbTemp: readProbe(2),
    leftPt1000: readProbe(3),
    rightPt1000: readProbe(4),
    encoder: readProbe(5),
    irTemp: readProbe(6)
  };
};

const parseCompactFsrPacket = (value: DataView): FsrData | null => {
  const hasStandardMagic =
    value.byteLength === COMPACT_FSR_PACKET_SIZE &&
    value.getUint8(0) === COMPACT_FSR_MAGIC_0 &&
    value.getUint8(1) === COMPACT_FSR_MAGIC_1;
  const hasNullPrefixedMagic =
    value.byteLength === COMPACT_FSR_PACKET_SIZE &&
    value.getUint8(0) === 0x00 &&
    value.getUint8(1) === COMPACT_FSR_MAGIC_1 &&
    value.getUint8(2) === COMPACT_FSR_VERSION;

  if (
    value.byteLength !== COMPACT_FSR_PACKET_SIZE ||
    (!hasStandardMagic && !hasNullPrefixedMagic) ||
    (value.getUint8(2) !== COMPACT_IMU_VERSION && value.getUint8(2) !== COMPACT_FSR_VERSION)
  ) {
    return null;
  }

  const readOptionalUInt16 = (offset: number): number | null => {
    const packetValue = value.getUint16(offset, true);
    return packetValue === 0xffff ? null : packetValue;
  };
  const leftPressure1000 = readOptionalUInt16(14);
  const rightPressure1000 = readOptionalUInt16(16);
  const flags = value.getUint8(3);

  return {
    sequence: value.getUint16(4, true),
    leftPresent: Boolean(flags & 0x01),
    rightPresent: Boolean(flags & 0x02),
    leftTriggered: Boolean(flags & 0x04),
    rightTriggered: Boolean(flags & 0x08),
    leftRaw: readOptionalUInt16(6),
    rightRaw: readOptionalUInt16(8),
    leftMillivolts: readOptionalUInt16(10),
    rightMillivolts: readOptionalUInt16(12),
    leftPressure: leftPressure1000 === null ? null : leftPressure1000 / 1000,
    rightPressure: rightPressure1000 === null ? null : rightPressure1000 / 1000,
    leftResistanceKohm: readOptionalUInt16(18),
    rightResistanceKohm: readOptionalUInt16(20),
    leftForceGrams: readOptionalUInt16(22),
    rightForceGrams: readOptionalUInt16(24)
  };
};

const parseCompactMotorEncoderPacket = (value: DataView): MotorEncoderData | null => {
  if (
    value.byteLength !== COMPACT_MOTOR_ENCODER_PACKET_SIZE ||
    value.getUint8(0) !== COMPACT_MOTOR_ENCODER_MAGIC_0 ||
    value.getUint8(1) !== COMPACT_MOTOR_ENCODER_MAGIC_1 ||
    value.getUint8(2) !== COMPACT_IMU_VERSION
  ) {
    return null;
  }

  const encoderTicks = value.getInt32(8, true);
  const angleDeg10 = value.getInt16(12, true);
  const rpm10 = value.getInt16(14, true);
  const flags = value.getUint8(3);

  return {
    sequence: value.getUint16(4, true),
    encoderPresent: Boolean(flags & 0x01),
    motorActive: Boolean(flags & 0x02),
    motorEnabled: Boolean(flags & 0x04),
    motorFault: Boolean(flags & 0x08),
    motorSpeed: value.getInt16(6, true),
    encoderTicks: encoderTicks === -2147483648 ? null : encoderTicks,
    angleDeg: angleDeg10 === -32768 ? null : angleDeg10 / 10,
    rpm: rpm10 === -32768 ? null : rpm10 / 10
  };
};

const normalizeTofData = (payload: { d?: unknown; s?: unknown }): TofData | null => {
  if (!Array.isArray(payload.d) || !Array.isArray(payload.s)) {
    return null;
  }

  const distances = payload.d
    .slice(0, 64)
    .map((value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : -1));
  const statuses = payload.s
    .slice(0, 64)
    .map((value) =>
      typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(255, Math.round(value))) : 255
    );

  while (distances.length < 64) distances.push(-1);
  while (statuses.length < 64) statuses.push(255);

  return {
    resolution: 64,
    frequency: 0,
    sequence: 0,
    distances,
    statuses
  };
};

const normalizePcbTempData = (payload: { pcb?: unknown }): PcbTempData | null => {
  if (!isFiniteNumber(payload.pcb)) {
    return null;
  }

  return {
    sequence: 0,
    tempC: payload.pcb,
    present: true,
    valid: true
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readNumberFromRecord = (source: Record<string, unknown>, ...keys: string[]): number | undefined => {
  for (const key of keys) {
    const value = source[key];
    if (isFiniteNumber(value)) {
      return value;
    }
  }

  return undefined;
};

const readBooleanFromRecord = (source: Record<string, unknown>, ...keys: string[]): boolean | undefined => {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'boolean') {
      return value;
    }
  }

  return undefined;
};

const normalizeMlx90614Data = (payload: {
  mlx?: unknown;
  mlx90614?: unknown;
  ir?: unknown;
  ir_temp?: unknown;
}): Mlx90614Data | null => {
  const source = isRecord(payload.mlx90614)
    ? payload.mlx90614
    : isRecord(payload.ir_temp)
      ? payload.ir_temp
      : isRecord(payload.mlx)
        ? payload.mlx
        : isRecord(payload.ir)
          ? payload.ir
          : null;

  if (!source) {
    return null;
  }

  const ambient = readNumberFromRecord(
    source,
    'ambient',
    'ambientC',
    'ambientTempC',
    'ambientTemp',
    'ambient_c',
    'ambient_temp',
    'ambient_temp_c',
    'ta'
  );
  const object = readNumberFromRecord(
    source,
    'object',
    'objectC',
    'objectTempC',
    'objectTemp',
    'object_c',
    'object_temp',
    'object_temp_c',
    'to'
  );

  if (!isFiniteNumber(ambient) && !isFiniteNumber(object)) {
    return null;
  }

  return {
    sequence: readNumberFromRecord(source, 'sequence', 'seq') ?? 0,
    present: true,
    ambientValid: isFiniteNumber(ambient),
    objectValid: isFiniteNumber(object),
    ambientTempC: isFiniteNumber(ambient) ? ambient : null,
    objectTempC: isFiniteNumber(object) ? object : null
  };
};

const normalizeRtdData = (payload: {
  rtd?: unknown;
  pt1000?: unknown;
  pt1000a?: unknown;
  rtd_temp?: unknown;
}): RtdData | null => {
  const payloadRecord = payload as Record<string, unknown>;
  const source = isRecord(payload.rtd)
    ? payload.rtd
    : isRecord(payload.pt1000)
      ? payload.pt1000
      : isRecord(payload.pt1000a)
        ? payload.pt1000a
        : isRecord(payload.rtd_temp)
          ? payload.rtd_temp
          : payloadRecord;

  const leftTempC = readNumberFromRecord(
    source,
    'leftTempC',
    'leftTemp',
    'leftC',
    'left',
    'left_temp_c',
    'left_temp',
    'left_pt1000',
    'left_pt1000_c',
    'leftPt1000',
    'leftPt1000C',
    'leftFingerTempC',
    'left_finger_temp_c'
  );
  const rightTempC = readNumberFromRecord(
    source,
    'rightTempC',
    'rightTemp',
    'rightC',
    'right',
    'right_temp_c',
    'right_temp',
    'right_pt1000',
    'right_pt1000_c',
    'rightPt1000',
    'rightPt1000C',
    'rightFingerTempC',
    'right_finger_temp_c'
  );

  if (!isFiniteNumber(leftTempC) && !isFiniteNumber(rightTempC)) {
    return null;
  }

  const leftFault = readNumberFromRecord(source, 'leftFault', 'left_fault') ?? 0;
  const rightFault = readNumberFromRecord(source, 'rightFault', 'right_fault') ?? 0;
  const leftPresent =
    readBooleanFromRecord(source, 'leftPresent', 'left_present', 'leftDetected', 'left_detected') ??
    isFiniteNumber(leftTempC);
  const rightPresent =
    readBooleanFromRecord(source, 'rightPresent', 'right_present', 'rightDetected', 'right_detected') ??
    isFiniteNumber(rightTempC);

  return {
    sequence: readNumberFromRecord(source, 'sequence', 'seq') ?? 0,
    leftPresent,
    rightPresent,
    leftValid:
      readBooleanFromRecord(source, 'leftValid', 'left_valid') ??
      (leftPresent && isFiniteNumber(leftTempC) && leftFault === 0),
    rightValid:
      readBooleanFromRecord(source, 'rightValid', 'right_valid') ??
      (rightPresent && isFiniteNumber(rightTempC) && rightFault === 0),
    leftTempC: isFiniteNumber(leftTempC) ? leftTempC : null,
    rightTempC: isFiniteNumber(rightTempC) ? rightTempC : null,
    leftFault,
    rightFault
  };
};

const normalizeFsrData = (payload: {
  fsr?: unknown;
  force?: unknown;
  forces?: unknown;
  fsr_force?: unknown;
}): FsrData | null => {
  const payloadRecord = payload as Record<string, unknown>;
  const source = isRecord(payload.fsr)
    ? payload.fsr
    : isRecord(payload.fsr_force)
      ? payload.fsr_force
      : isRecord(payload.force)
        ? payload.force
        : isRecord(payload.forces)
          ? payload.forces
          : payloadRecord;

  const leftForceGrams = readNumberFromRecord(
    source,
    'leftForceGrams',
    'leftForceGram',
    'leftForceG',
    'left_force_g',
    'left_force_grams',
    'leftGrams',
    'left_g',
    'leftForce',
    'left_fsr_g',
    'leftFsrGrams',
    'left'
  );
  const rightForceGrams = readNumberFromRecord(
    source,
    'rightForceGrams',
    'rightForceGram',
    'rightForceG',
    'right_force_g',
    'right_force_grams',
    'rightGrams',
    'right_g',
    'rightForce',
    'right_fsr_g',
    'rightFsrGrams',
    'right'
  );
  const leftRaw = readNumberFromRecord(source, 'leftRaw', 'left_raw', 'leftAdc', 'left_adc');
  const rightRaw = readNumberFromRecord(source, 'rightRaw', 'right_raw', 'rightAdc', 'right_adc');

  if (!isFiniteNumber(leftForceGrams) && !isFiniteNumber(rightForceGrams) && !isFiniteNumber(leftRaw) && !isFiniteNumber(rightRaw)) {
    return null;
  }

  const leftPresent =
    readBooleanFromRecord(source, 'leftPresent', 'left_present', 'leftDetected', 'left_detected') ??
    (isFiniteNumber(leftForceGrams) || isFiniteNumber(leftRaw));
  const rightPresent =
    readBooleanFromRecord(source, 'rightPresent', 'right_present', 'rightDetected', 'right_detected') ??
    (isFiniteNumber(rightForceGrams) || isFiniteNumber(rightRaw));

  return {
    sequence: readNumberFromRecord(source, 'sequence', 'seq') ?? 0,
    leftPresent,
    rightPresent,
    leftTriggered:
      readBooleanFromRecord(source, 'leftTriggered', 'left_triggered', 'leftContact', 'left_contact') ??
      (isFiniteNumber(leftForceGrams) && leftForceGrams > 0),
    rightTriggered:
      readBooleanFromRecord(source, 'rightTriggered', 'right_triggered', 'rightContact', 'right_contact') ??
      (isFiniteNumber(rightForceGrams) && rightForceGrams > 0),
    leftRaw: isFiniteNumber(leftRaw) ? leftRaw : null,
    rightRaw: isFiniteNumber(rightRaw) ? rightRaw : null,
    leftMillivolts: readNumberFromRecord(source, 'leftMillivolts', 'leftMv', 'left_mV', 'left_mv') ?? null,
    rightMillivolts: readNumberFromRecord(source, 'rightMillivolts', 'rightMv', 'right_mV', 'right_mv') ?? null,
    leftPressure: readNumberFromRecord(source, 'leftPressure', 'left_pressure') ?? null,
    rightPressure: readNumberFromRecord(source, 'rightPressure', 'right_pressure') ?? null,
    leftResistanceKohm: readNumberFromRecord(source, 'leftResistanceKohm', 'leftResistance', 'left_resistance_kohm') ?? null,
    rightResistanceKohm: readNumberFromRecord(source, 'rightResistanceKohm', 'rightResistance', 'right_resistance_kohm') ?? null,
    leftForceGrams: isFiniteNumber(leftForceGrams) ? leftForceGrams : null,
    rightForceGrams: isFiniteNumber(rightForceGrams) ? rightForceGrams : null
  };
};

const normalizeSensorStatusData = (payload: { sensor_status?: unknown; sensors?: unknown }): SensorStatusData | null => {
  const source = isRecord(payload.sensor_status) ? payload.sensor_status : isRecord(payload.sensors) ? payload.sensors : null;
  if (!source) {
    return null;
  }

  const readProbe = (...keys: string[]) => {
    for (const key of keys) {
      const value = source[key];
      if (isRecord(value)) {
        return {
          detected: typeof value.detected === 'boolean' ? value.detected : undefined,
          available: typeof value.available === 'boolean' ? value.available : undefined,
          valid: typeof value.valid === 'boolean' ? value.valid : undefined,
          fault: typeof value.fault === 'boolean' ? value.fault : undefined
        };
      }
      if (typeof value === 'boolean') {
        return { detected: value, available: value };
      }
    }

    return undefined;
  };

  return {
    imu: readProbe('imu', 'mpu9250'),
    tof: readProbe('tof', 'vl53l5cx'),
    pcbTemp: readProbe('pcbTemp', 'pcb_temp', 'mcp9808'),
    leftPt1000: readProbe('leftPt1000', 'left_pt1000', 'rtd_left'),
    rightPt1000: readProbe('rightPt1000', 'right_pt1000', 'rtd_right'),
    encoder: readProbe('encoder'),
    irTemp: readProbe('irTemp', 'ir_temp', 'mlx90614', 'mlx'),
    leftFsr: readProbe('leftFsr', 'left_fsr', 'fsr_left'),
    rightFsr: readProbe('rightFsr', 'right_fsr', 'fsr_right')
  };
};

const logCommandResponse = (payload: Partial<ImuData> & {
  command?: unknown;
  ok?: unknown;
  error?: unknown;
  state?: unknown;
}): boolean => {
  if (typeof payload.command !== 'string') {
    return false;
  }

  const suffix =
    typeof payload.error === 'string'
      ? `: ${payload.error}`
      : typeof payload.state === 'string'
        ? ` (${payload.state})`
        : '';
  addLog(payload.ok === false ? 'error' : 'info', `Device command response: ${payload.command}${suffix}.`);
  return true;
};

const byteToHex = (value: number): string => value.toString(16).toUpperCase().padStart(2, '0');

const packetHeadHex = (value: DataView, maxBytes = 8): string =>
  Array.from({ length: Math.min(value.byteLength, maxBytes) }, (_, index) => byteToHex(value.getUint8(index))).join(' ');

const printableMagic = (value: DataView): string => {
  if (value.byteLength < 2) {
    return '--';
  }

  const chars = [value.getUint8(0), value.getUint8(1)].map((byte) =>
    byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.'
  );
  return chars.join('');
};

const isLikelyTextPacket = (value: DataView): boolean => {
  for (let index = 0; index < value.byteLength; index += 1) {
    const byte = value.getUint8(index);
    if (byte <= 0x20) {
      continue;
    }
    return byte === 0x7b || byte === 0x5b;
  }

  return false;
};

const logPlainTextResponse = (value: DataView, session: BleSession): boolean => {
  if (session.role !== 'testJig' || value.byteLength === 0) {
    return false;
  }

  for (let index = 0; index < value.byteLength; index += 1) {
    const byte = value.getUint8(index);
    const isWhitespace = byte === 0x09 || byte === 0x0a || byte === 0x0d;
    if (!isWhitespace && (byte < 0x20 || byte > 0x7e)) {
      return false;
    }
  }

  const text = decoder.decode(value).trim();
  if (!/^(OK|ERR|WARN)\b/i.test(text)) {
    return false;
  }

  const level: LogEntry['level'] = /^ERR\b/i.test(text) ? 'error' : /^WARN\b/i.test(text) ? 'warning' : 'info';
  addLog(level, `Test Jig response: ${text}.`);
  return true;
};

const logUnknownBinaryPacket = (value: DataView, session: BleSession): void => {
  if (value.byteLength === 0) {
    return;
  }

  const now = Date.now();
  if (now - session.lastUnknownBlePacketLogAt < UNKNOWN_BLE_PACKET_LOG_INTERVAL_MS) {
    return;
  }

  session.lastUnknownBlePacketLogAt = now;
  addLog(
    'warning',
    `Unsupported BLE binary packet ignored: len=${value.byteLength}, magic=${printableMagic(value)}, head=${packetHeadHex(value)}.`
  );
};

const handleDisconnected = (session: BleSession): void => {
  session.characteristic = null;
  session.server = null;
  session.commandQueue = Promise.resolve();
  session.lastCommandWriteAt = 0;
  useImuStore.getState().setStatus('disconnected', session.role);
  addLog('warning', `${session.role === 'gripper' ? 'Gripper' : 'Test Jig'} BLE device disconnected.`);
};

const writeCommandPayload = async (session: BleSession, payload: ArrayBuffer): Promise<void> => {
  if (!session.characteristic || !session.server?.connected) {
    throw new Error(`${session.role === 'gripper' ? 'Gripper' : 'Test Jig'} BLE device is not connected.`);
  }

  const elapsedSinceLastWrite = performance.now() - session.lastCommandWriteAt;
  if (elapsedSinceLastWrite < BLE_COMMAND_GAP_MS) {
    await delay(BLE_COMMAND_GAP_MS - elapsedSinceLastWrite);
  }

  if (session.characteristic.writeValueWithResponse) {
    await session.characteristic.writeValueWithResponse(payload);
  } else if (session.characteristic.writeValueWithoutResponse) {
    await session.characteristic.writeValueWithoutResponse(payload);
  } else {
    await session.characteristic.writeValue(payload);
  }

  session.lastCommandWriteAt = performance.now();
};

const writeCommandPayloadWithRetry = async (session: BleSession, payload: ArrayBuffer): Promise<void> => {
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= BLE_WRITE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await writeCommandPayload(session, payload);
      return;
    } catch (error) {
      lastError = error;
      const retryDelay = BLE_WRITE_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined || !session.server?.connected) {
        break;
      }
      await delay(retryDelay);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('BLE GATT write failed.');
};

const handleCharacteristicValueChanged = (event: Event, session: BleSession): void => {
  const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
  if (!value) {
    return;
  }

  try {
    const compactPayload = parseCompactImuPacket(value);
    const compactTofPayload = compactPayload ? null : parseCompactTofPacket(value);
    const compactPcbTempPayload = compactPayload || compactTofPayload ? null : parseCompactPcbTempPacket(value);
    const compactMlx90614Payload =
      compactPayload || compactTofPayload || compactPcbTempPayload ? null : parseCompactMlx90614Packet(value);
    const compactRtdPayload =
      compactPayload || compactTofPayload || compactPcbTempPayload || compactMlx90614Payload
        ? null
        : parseCompactRtdPacket(value);
    const compactFsrPayload =
      compactPayload || compactTofPayload || compactPcbTempPayload || compactMlx90614Payload || compactRtdPayload
        ? null
        : parseCompactFsrPacket(value);
    const compactMotorEncoderPayload =
      compactPayload ||
      compactTofPayload ||
      compactPcbTempPayload ||
      compactMlx90614Payload ||
      compactRtdPayload ||
      compactFsrPayload
        ? null
        : parseCompactMotorEncoderPacket(value);
    const compactSensorStatusPayload =
      compactPayload ||
      compactTofPayload ||
      compactPcbTempPayload ||
      compactMlx90614Payload ||
      compactRtdPayload ||
      compactFsrPayload ||
      compactMotorEncoderPayload
        ? null
        : parseCompactSensorStatusPacket(value);

    if (compactTofPayload) {
      session.packetCount += 1;
      if (session.role === 'gripper') {
        useImuStore.getState().setTofData(compactTofPayload);
        mergeSensorStatus({ tof: { detected: true, available: true, valid: compactTofPayload.distances.some((distance) => distance > 0) } });
      }
      useImuStore.getState().setPacketCount(session.packetCount, session.role);

      return;
    }

    if (compactPcbTempPayload) {
      session.packetCount += 1;
      if (session.role === 'gripper') {
        useImuStore.getState().setPcbTempData(compactPcbTempPayload);
        mergeSensorStatus({
          pcbTemp: {
            detected: compactPcbTempPayload.present,
            available: compactPcbTempPayload.present,
            valid: compactPcbTempPayload.valid
          }
        });
      }
      useImuStore.getState().setPacketCount(session.packetCount, session.role);

      return;
    }

    if (compactMlx90614Payload) {
      session.packetCount += 1;
      if (session.role === 'gripper') {
        useImuStore.getState().setMlx90614Data(compactMlx90614Payload);
        mergeSensorStatus({
          irTemp: {
            detected: compactMlx90614Payload.present,
            available: compactMlx90614Payload.present,
            valid: compactMlx90614Payload.ambientValid || compactMlx90614Payload.objectValid
          }
        });
      }
      useImuStore.getState().setPacketCount(session.packetCount, session.role);

      return;
    }

    if (compactRtdPayload) {
      session.packetCount += 1;
      if (session.role === 'gripper') {
        useImuStore.getState().setRtdData(compactRtdPayload);
        mergeSensorStatus({
          leftPt1000: {
            detected: compactRtdPayload.leftPresent,
            available: compactRtdPayload.leftPresent,
            valid: compactRtdPayload.leftValid,
            fault: compactRtdPayload.leftFault !== 0
          },
          rightPt1000: {
            detected: compactRtdPayload.rightPresent,
            available: compactRtdPayload.rightPresent,
            valid: compactRtdPayload.rightValid,
            fault: compactRtdPayload.rightFault !== 0
          }
        });
      }
      useImuStore.getState().setPacketCount(session.packetCount, session.role);

      return;
    }

    if (compactFsrPayload) {
      session.packetCount += 1;
      if (session.role === 'gripper') {
        useImuStore.getState().setFsrData(compactFsrPayload);
        mergeSensorStatus({
          leftFsr: {
            detected: compactFsrPayload.leftPresent,
            available: compactFsrPayload.leftPresent,
            valid: compactFsrPayload.leftRaw !== null
          },
          rightFsr: {
            detected: compactFsrPayload.rightPresent,
            available: compactFsrPayload.rightPresent,
            valid: compactFsrPayload.rightRaw !== null
          }
        });
      }
      useImuStore.getState().setPacketCount(session.packetCount, session.role);

      return;
    }

    if (compactMotorEncoderPayload) {
      session.packetCount += 1;
      useImuStore.getState().setMotorEncoderData(compactMotorEncoderPayload, session.role);
      if (session.role === 'gripper') {
        mergeSensorStatus({
          encoder: {
            detected: compactMotorEncoderPayload.encoderPresent,
            available: compactMotorEncoderPayload.encoderPresent,
            valid: compactMotorEncoderPayload.encoderPresent
          }
        });
      }
      useImuStore.getState().setPacketCount(session.packetCount, session.role);

      return;
    }

    if (compactSensorStatusPayload) {
      if (session.role === 'gripper') {
        mergeSensorStatus(compactSensorStatusPayload);
      }
      return;
    }

    if (!compactPayload && logPlainTextResponse(value, session)) {
      return;
    }

    if (!compactPayload && !isLikelyTextPacket(value)) {
      logUnknownBinaryPacket(value, session);
      return;
    }

    const text = compactPayload ? '' : decoder.decode(value).trim();
    if (!compactPayload && !text) {
      return;
    }

    const payload: Partial<ImuData> & {
      d?: unknown;
      s?: unknown;
      pcb?: unknown;
      mlx?: unknown;
      mlx90614?: unknown;
      ir?: unknown;
      ir_temp?: unknown;
      rtd?: unknown;
      pt1000?: unknown;
      pt1000a?: unknown;
      rtd_temp?: unknown;
      fsr?: unknown;
      force?: unknown;
      forces?: unknown;
      fsr_force?: unknown;
      sensor_status?: unknown;
      sensors?: unknown;
    } =
      compactPayload ??
      (JSON.parse(text) as Partial<ImuData> & {
        d?: unknown;
        s?: unknown;
        pcb?: unknown;
        mlx?: unknown;
        mlx90614?: unknown;
        ir?: unknown;
        ir_temp?: unknown;
        rtd?: unknown;
        pt1000?: unknown;
        pt1000a?: unknown;
        rtd_temp?: unknown;
        fsr?: unknown;
        force?: unknown;
        forces?: unknown;
        fsr_force?: unknown;
        sensor_status?: unknown;
        sensors?: unknown;
      });

    const sensorStatus = !compactPayload ? normalizeSensorStatusData(payload) : null;
    if (sensorStatus) {
      mergeSensorStatus(sensorStatus);
      return;
    }

    if (!compactPayload && logCommandResponse(payload)) {
      return;
    }

    const pcbTempData = !compactPayload ? normalizePcbTempData(payload) : null;
    if (pcbTempData) {
      session.packetCount += 1;
      if (session.role === 'gripper') {
        useImuStore.getState().setPcbTempData(pcbTempData);
        mergeSensorStatus({ pcbTemp: { detected: pcbTempData.present, available: pcbTempData.present, valid: pcbTempData.valid } });
      }
      useImuStore.getState().setPacketCount(session.packetCount, session.role);
      return;
    }

    const mlx90614Data = !compactPayload ? normalizeMlx90614Data(payload) : null;
    if (mlx90614Data) {
      session.packetCount += 1;
      if (session.role === 'gripper') {
        useImuStore.getState().setMlx90614Data(mlx90614Data);
        mergeSensorStatus({
          irTemp: {
            detected: mlx90614Data.present,
            available: mlx90614Data.present,
            valid: mlx90614Data.ambientValid || mlx90614Data.objectValid
          }
        });
      }
      useImuStore.getState().setPacketCount(session.packetCount, session.role);
      return;
    }

    const rtdData = !compactPayload ? normalizeRtdData(payload) : null;
    if (rtdData) {
      session.packetCount += 1;
      if (session.role === 'gripper') {
        useImuStore.getState().setRtdData(rtdData);
        mergeSensorStatus({
          leftPt1000: {
            detected: rtdData.leftPresent,
            available: rtdData.leftPresent,
            valid: rtdData.leftValid,
            fault: rtdData.leftFault !== 0
          },
          rightPt1000: {
            detected: rtdData.rightPresent,
            available: rtdData.rightPresent,
            valid: rtdData.rightValid,
            fault: rtdData.rightFault !== 0
          }
        });
      }
      useImuStore.getState().setPacketCount(session.packetCount, session.role);
      return;
    }

    const fsrData = !compactPayload ? normalizeFsrData(payload) : null;
    if (fsrData) {
      session.packetCount += 1;
      if (session.role === 'gripper') {
        useImuStore.getState().setFsrData(fsrData);
      }
      useImuStore.getState().setPacketCount(session.packetCount, session.role);
      return;
    }

    const tofData = !compactPayload ? normalizeTofData(payload) : null;
    if (tofData) {
      session.packetCount += 1;
      if (session.role === 'gripper') {
        useImuStore.getState().setTofData(tofData);
        mergeSensorStatus({ tof: { detected: true, available: true, valid: tofData.distances.some((distance) => distance > 0) } });
      }
      useImuStore.getState().setPacketCount(session.packetCount, session.role);
      return;
    }

    const imuData = normalizeImuData(payload);
    if (!imuData) {
      addLog('warning', `Ignored malformed BLE IMU packet: ${compactPayload ? 'compact packet' : text.slice(0, 180)}`);
      return;
    }

    session.packetCount += 1;
    if (session.role === 'gripper') {
      lastImuData = imuData;
      useImuStore.getState().setImuData(imuData);
      mergeSensorStatus({ imu: { detected: true, available: true, valid: true } });
    }
    useImuStore.getState().setPacketCount(session.packetCount, session.role);

  } catch (error) {
    if (!isLikelyTextPacket(value)) {
      logUnknownBinaryPacket(value, session);
      return;
    }

    const text = decoder.decode(value).trim();
    addLog('warning', `Corrupted BLE text packet ignored: ${text.slice(0, 180)}`);
  }
};

export const bleImuClient = {
  isSupported: (): boolean => typeof navigator !== 'undefined' && Boolean(navigator.bluetooth),

  connect: async (role: DeviceRole = 'gripper', deviceNamePrefix = DEFAULT_BLE_DEVICE_NAME): Promise<void> => {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth is not available in this Electron renderer.');
    }

    const store = useImuStore.getState();
    const session = sessions[role];
    store.setDeviceTransport(role, 'ble');
    store.setTransport('ble');
    store.setStatus('connecting', role);
    store.setBleDevices([]);
    store.resetPacketStats(role);
    session.packetCount = 0;
    session.lastUnknownBlePacketLogAt = 0;
    session.lastCommandWriteAt = 0;
    session.commandQueue = Promise.resolve();
    if (role === 'gripper') {
      lastImuData = null;
      lastPacketAt = null;
      warnedAboutEstimatedOrientation = false;
    }

    addLog('info', `Scanning for nearby BLE devices. Select ${deviceNamePrefix} from the list if it appears.`);

    try {
      if (session.characteristic && session.handler) {
        session.characteristic.removeEventListener('characteristicvaluechanged', session.handler);
      }
      if (session.server?.connected) {
        session.server.disconnect();
      }

      session.device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: deviceNamePrefix }],
        optionalServices: [BLE_SERVICE_UUID]
      });

      session.device.addEventListener('gattserverdisconnected', () => handleDisconnected(session));
      store.setDeviceSelectedBleDevice(role, session.device.name ?? session.device.id);
      store.setSelectedBleDevice(session.device.name ?? session.device.id);
      store.setBleDevices([]);
      addLog('info', `Connecting ${role === 'gripper' ? 'gripper' : 'test jig'} to BLE device ${session.device.name ?? session.device.id}.`);

      session.server = await session.device.gatt?.connect() ?? null;
      if (!session.server) {
        throw new Error('BLE device did not expose a GATT server.');
      }

      const service = await session.server.getPrimaryService(BLE_SERVICE_UUID);
      session.characteristic = await service.getCharacteristic(BLE_CHARACTERISTIC_UUID);
      session.handler = (event: Event): void => handleCharacteristicValueChanged(event, session);
      session.characteristic.addEventListener('characteristicvaluechanged', session.handler);
      await session.characteristic.startNotifications();

      store.setStatus('connected', role);
      store.setActiveDeviceRole(role);
      addLog('success', `BLE notifications enabled for ${role === 'gripper' ? 'gripper' : 'test jig'} (${session.device.name ?? session.device.id}).`);
    } catch (error) {
      store.setStatus('disconnected', role);
      store.setBleDevices([]);
      addLog('error', error instanceof Error ? `BLE connection failed: ${error.message}` : 'BLE connection failed.');
      throw error;
    }
  },

  disconnect: async (role: DeviceRole = 'gripper'): Promise<void> => {
    const session = sessions[role];
    try {
      if (session.characteristic) {
        if (session.handler) {
          session.characteristic.removeEventListener('characteristicvaluechanged', session.handler);
        }
        await session.characteristic.stopNotifications().catch(() => undefined);
      }
      if (session.server?.connected) {
        session.server.disconnect();
      }
    } finally {
      session.characteristic = null;
      session.server = null;
      session.device = null;
      session.handler = null;
      session.packetCount = 0;
      session.lastCommandWriteAt = 0;
      session.commandQueue = Promise.resolve();
      useImuStore.getState().setStatus('disconnected', role);
      addLog('info', `${role === 'gripper' ? 'Gripper' : 'Test Jig'} BLE connection closed.`);
    }
  },

  sendCommand: async (role: DeviceRole = 'gripper', command: string): Promise<void> => {
    const session = sessions[role];
    const normalizedCommand = command.trim().toUpperCase();
    if (!normalizedCommand) {
      throw new Error('Cannot send an empty BLE command.');
    }

    if (!session.characteristic || !session.server?.connected) {
      throw new Error(`${role === 'gripper' ? 'Gripper' : 'Test Jig'} BLE device is not connected.`);
    }

    const encodedPayload = encoder.encode(normalizedCommand);
    const payload = encodedPayload.buffer.slice(
      encodedPayload.byteOffset,
      encodedPayload.byteOffset + encodedPayload.byteLength
    );
    const previousCommand = session.commandQueue.catch(() => undefined);
    const queuedCommand = previousCommand.then(async () => {
      await writeCommandPayloadWithRetry(session, payload);
      addLog('info', `Sent ${role === 'gripper' ? 'gripper' : 'test jig'} BLE command: ${normalizedCommand}.`);
    });

    session.commandQueue = queuedCommand.catch(() => undefined);
    await queuedCommand;
  }
};

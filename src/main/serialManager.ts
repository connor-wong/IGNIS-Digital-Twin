import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { SerialPort } from 'serialport';
import type {
  ConnectionStatus,
  FsrData,
  ImuData,
  LogEntry,
  Mlx90614Data,
  MotorEncoderData,
  PcbTempData,
  RtdData,
  SensorStatusData,
  SerialPortInfo,
  SerialSnapshot,
  TofData
} from '../renderer/types/imu';

type SerialManagerEvents = {
  data: [ImuData];
  'tof-data': [TofData];
  'pcb-temp-data': [PcbTempData];
  'rtd-data': [RtdData];
  'mlx90614-data': [Mlx90614Data];
  'fsr-data': [FsrData];
  'motor-encoder-data': [MotorEncoderData];
  'sensor-status': [SensorStatusData];
  status: [ConnectionStatus];
  log: [LogEntry];
  'packet-count': [number];
  ports: [SerialPortInfo[]];
};

const BAUD_RATE = 115200;
const RECONNECT_DELAY_MS = 2000;
const PACKET_TIMEOUT_MS = 5000;
const MAX_LOGS = 500;
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
const COMPACT_VERSION = 1;
const COMPACT_TOF_VERSION = 2;
const COMPACT_FSR_VERSION = 2;
const IMU_MAGIC_0 = 0x49; // I
const IMU_MAGIC_1 = 0x4d; // M
const TOF_MAGIC_0 = 0x54; // T
const TOF_MAGIC_1 = 0x46; // F
const PCB_TEMP_MAGIC_0 = 0x50; // P
const PCB_TEMP_MAGIC_1 = 0x42; // B
const RTD_MAGIC_0 = 0x52; // R
const RTD_MAGIC_1 = 0x44; // D
const MLX90614_MAGIC_0 = 0x49; // I
const MLX90614_MAGIC_1 = 0x52; // R
const SENSOR_STATUS_MAGIC_0 = 0x53; // S
const SENSOR_STATUS_MAGIC_1 = 0x54; // T
const FSR_MAGIC_0 = 0x46; // F
const FSR_MAGIC_1 = 0x53; // S
const MOTOR_ENCODER_MAGIC_0 = 0x4d; // M
const MOTOR_ENCODER_MAGIC_1 = 0x45; // E

export declare interface SerialManager {
  on<K extends keyof SerialManagerEvents>(event: K, listener: (...args: SerialManagerEvents[K]) => void): this;
  emit<K extends keyof SerialManagerEvents>(event: K, ...args: SerialManagerEvents[K]): boolean;
}

export class SerialManager extends EventEmitter {
  private port: SerialPort | null = null;
  private rxBuffer = Buffer.alloc(0);
  private status: ConnectionStatus = 'disconnected';
  private selectedPort: string | null = null;
  private packetCount = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private packetTimeoutTimer: NodeJS.Timeout | null = null;
  private intentionalDisconnect = false;
  private logs: LogEntry[] = [];
  private lastImuData: ImuData | null = null;
  private lastPacketAt: number | null = null;
  private warnedAboutEstimatedOrientation = false;

  async listPorts(): Promise<SerialPortInfo[]> {
    try {
      const ports = await SerialPort.list();
      const normalized = ports.map((port) => ({
        path: port.path,
        manufacturer: port.manufacturer,
        serialNumber: port.serialNumber,
        vendorId: port.vendorId,
        productId: port.productId
      }));
      this.emit('ports', normalized);
      return normalized;
    } catch (error) {
      this.addLog('error', `Failed to list serial ports: ${this.errorMessage(error)}`);
      return [];
    }
  }

  async connect(path: string): Promise<void> {
    if (!path) {
      throw new Error('A COM port must be selected before connecting.');
    }

    this.intentionalDisconnect = false;
    this.selectedPort = path;
    this.packetCount = 0;
    this.rxBuffer = Buffer.alloc(0);
    this.lastImuData = null;
    this.lastPacketAt = null;
    this.warnedAboutEstimatedOrientation = false;
    this.emit('packet-count', this.packetCount);
    this.clearReconnectTimer();

    if (this.port?.isOpen) {
      await this.disconnect(false);
    }

    this.setStatus('connecting');
    this.addLog('info', `Opening ${path} at ${BAUD_RATE} baud.`);

    await new Promise<void>((resolve, reject) => {
      const nextPort = new SerialPort({
        path,
        baudRate: BAUD_RATE,
        autoOpen: false
      });

      nextPort.open((error) => {
        if (error) {
          this.port = null;
          this.setStatus('error');
          this.addLog('error', `Could not open ${path}: ${this.errorMessage(error)}`);
          this.scheduleReconnect();
          reject(error);
          return;
        }

        this.port = nextPort;
        this.attachPortHandlers(nextPort);
        this.setStatus('connected');
        this.addLog('success', `Connected to ${path}.`);
        this.resetPacketTimeout();
        resolve();
      });
    });
  }

  async disconnect(markIntentional = true): Promise<void> {
    this.intentionalDisconnect = markIntentional;
    this.clearReconnectTimer();
    this.clearPacketTimeout();

    const activePort = this.port;
    this.port = null;
    this.rxBuffer = Buffer.alloc(0);

    if (!activePort) {
      this.setStatus('disconnected');
      return;
    }

    await new Promise<void>((resolve) => {
      const close = (): void => {
        activePort.close((error) => {
          if (error) {
            this.addLog('error', `Error while closing port: ${this.errorMessage(error)}`);
          }
          this.setStatus('disconnected');
          this.addLog('info', 'Serial connection closed.');
          resolve();
        });
      };

      if (activePort.isOpen) {
        close();
      } else {
        this.setStatus('disconnected');
        resolve();
      }
    });
  }

  async sendCommand(command: string): Promise<void> {
    const normalizedCommand = command.trim().toUpperCase();
    if (!normalizedCommand) {
      throw new Error('Cannot send an empty serial command.');
    }

    if (!this.port?.isOpen) {
      throw new Error('Serial port is not connected.');
    }

    await new Promise<void>((resolve, reject) => {
      this.port?.write(`${normalizedCommand}\n`, (error) => {
        if (error) {
          reject(error);
          return;
        }

        this.port?.drain((drainError) => {
          if (drainError) {
            reject(drainError);
            return;
          }
          resolve();
        });
      });
    });

    if (normalizedCommand === 'START') {
      this.resetPacketTimeout();
    }

    if (normalizedCommand === 'STOP' || normalizedCommand === 'CALIBRATE') {
      this.clearPacketTimeout();
    }

    this.addLog('info', `Sent serial command: ${normalizedCommand}.`);
  }

  getSnapshot(): SerialSnapshot {
    return {
      status: this.status,
      selectedPort: this.selectedPort,
      packetCount: this.packetCount,
      logs: this.logs
    };
  }

  destroy(): void {
    this.intentionalDisconnect = true;
    this.clearReconnectTimer();
    this.clearPacketTimeout();
    if (this.port?.isOpen) {
      this.port.close();
    }
  }

  private attachPortHandlers(port: SerialPort): void {
    port.on('data', (chunk: Buffer) => this.handleSerialBytes(chunk));

    port.on('error', (error) => {
      this.setStatus('error');
      this.addLog('error', `Serial error: ${this.errorMessage(error)}`);
      this.scheduleReconnect();
    });

    port.on('close', () => {
      this.clearPacketTimeout();
      if (this.intentionalDisconnect) {
        this.setStatus('disconnected');
        return;
      }

      this.setStatus('reconnecting');
      this.addLog('warning', `Device disconnected from ${this.selectedPort ?? 'serial port'}.`);
      this.scheduleReconnect();
    });
  }

  private handleSerialBytes(chunk: Buffer): void {
    this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);

    while (this.rxBuffer.length > 0) {
      if (this.isCompactImuFrame(this.rxBuffer)) {
        if (this.rxBuffer.length < COMPACT_IMU_PACKET_SIZE) return;
        this.handleCompactImuPacket(this.rxBuffer.subarray(0, COMPACT_IMU_PACKET_SIZE));
        this.rxBuffer = this.rxBuffer.subarray(COMPACT_IMU_PACKET_SIZE);
        continue;
      }

      if (this.isCompactTofFrame(this.rxBuffer)) {
        const packetSize = this.getCompactTofPacketSize(this.rxBuffer);
        if (packetSize === 0 || this.rxBuffer.length < packetSize) return;
        this.handleCompactTofPacket(this.rxBuffer.subarray(0, packetSize));
        this.rxBuffer = this.rxBuffer.subarray(packetSize);
        continue;
      }

      if (this.isCompactPcbTempFrame(this.rxBuffer)) {
        if (this.rxBuffer.length < COMPACT_PCB_TEMP_PACKET_SIZE) return;
        this.handleCompactPcbTempPacket(this.rxBuffer.subarray(0, COMPACT_PCB_TEMP_PACKET_SIZE));
        this.rxBuffer = this.rxBuffer.subarray(COMPACT_PCB_TEMP_PACKET_SIZE);
        continue;
      }

      if (this.isCompactRtdFrame(this.rxBuffer)) {
        if (this.rxBuffer.length < COMPACT_RTD_PACKET_SIZE) return;
        this.handleCompactRtdPacket(this.rxBuffer.subarray(0, COMPACT_RTD_PACKET_SIZE));
        this.rxBuffer = this.rxBuffer.subarray(COMPACT_RTD_PACKET_SIZE);
        continue;
      }

      if (this.isCompactMlx90614Frame(this.rxBuffer)) {
        if (this.rxBuffer.length < COMPACT_MLX90614_PACKET_SIZE) return;
        this.handleCompactMlx90614Packet(this.rxBuffer.subarray(0, COMPACT_MLX90614_PACKET_SIZE));
        this.rxBuffer = this.rxBuffer.subarray(COMPACT_MLX90614_PACKET_SIZE);
        continue;
      }

      if (this.isCompactFsrFrame(this.rxBuffer)) {
        if (this.rxBuffer.length < COMPACT_FSR_PACKET_SIZE) return;
        this.handleCompactFsrPacket(this.rxBuffer.subarray(0, COMPACT_FSR_PACKET_SIZE));
        this.rxBuffer = this.rxBuffer.subarray(COMPACT_FSR_PACKET_SIZE);
        continue;
      }

      if (this.isCompactMotorEncoderFrame(this.rxBuffer)) {
        if (this.rxBuffer.length < COMPACT_MOTOR_ENCODER_PACKET_SIZE) return;
        this.handleCompactMotorEncoderPacket(this.rxBuffer.subarray(0, COMPACT_MOTOR_ENCODER_PACKET_SIZE));
        this.rxBuffer = this.rxBuffer.subarray(COMPACT_MOTOR_ENCODER_PACKET_SIZE);
        continue;
      }

      if (this.isCompactSensorStatusFrame(this.rxBuffer)) {
        if (this.rxBuffer.length < COMPACT_SENSOR_STATUS_PACKET_SIZE) return;
        this.handleCompactSensorStatusPacket(this.rxBuffer.subarray(0, COMPACT_SENSOR_STATUS_PACKET_SIZE));
        this.rxBuffer = this.rxBuffer.subarray(COMPACT_SENSOR_STATUS_PACKET_SIZE);
        continue;
      }

      const newlineIndex = this.rxBuffer.indexOf(0x0a);
      const startsAsText = this.rxBuffer[0] === 0x7b || this.rxBuffer[0] === 0x5b || this.rxBuffer[0] < 0x20;
      if (startsAsText && newlineIndex >= 0) {
        const line = this.rxBuffer.subarray(0, newlineIndex).toString('utf8');
        this.rxBuffer = this.rxBuffer.subarray(newlineIndex + 1);
        this.handleTextPacket(line);
        continue;
      }

      if (this.rxBuffer.length < Math.max(COMPACT_IMU_PACKET_SIZE, COMPACT_TOF_V1_PACKET_SIZE) && newlineIndex < 0) {
        return;
      }

      this.rxBuffer = this.rxBuffer.subarray(1);
    }
  }

  private handleTextPacket(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    try {
      const payload = JSON.parse(trimmed) as Partial<ImuData> & {
        command?: string;
        ok?: boolean;
        error?: string;
        state?: string;
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
      };
      const sensorStatus = this.normalizeSensorStatusData(payload);
      if (sensorStatus) {
        this.emit('sensor-status', sensorStatus);
        return;
      }

      const pcbTempData = this.normalizePcbTempData(payload);
      if (pcbTempData) {
        this.recordPcbTempPacket(pcbTempData);
        return;
      }

      const mlx90614Data = this.normalizeMlx90614Data(payload);
      if (mlx90614Data) {
        this.recordMlx90614Packet(mlx90614Data);
        return;
      }

      const rtdData = this.normalizeRtdData(payload);
      if (rtdData) {
        this.recordRtdPacket(rtdData);
        return;
      }

      const fsrData = this.normalizeFsrData(payload);
      if (fsrData) {
        this.recordFsrPacket(fsrData);
        return;
      }

      const tofData = this.normalizeTofData(payload);
      if (tofData) {
        this.recordTofPacket(tofData);
        return;
      }

      const imuData = this.normalizeImuData(payload);
      if (!imuData) {
        if (payload.command) {
          const status = payload.ok === false ? 'error' : 'info';
          const suffix = payload.error ? `: ${payload.error}` : payload.state ? ` (${payload.state})` : '';
          this.addLog(status, `Device command response: ${payload.command}${suffix}.`);
        } else {
          this.addLog('warning', `Ignored malformed IMU packet: ${trimmed.slice(0, 180)}`);
        }
        return;
      }

      this.recordImuPacket(imuData);
    } catch (error) {
      this.addLog('info', `Device message: ${trimmed.slice(0, 180)}`);
    }
  }

  private handleCompactImuPacket(frame: Buffer): void {
    const payload = {
      ax: frame.readInt16LE(6) / 1000,
      ay: frame.readInt16LE(8) / 1000,
      az: frame.readInt16LE(10) / 1000,
      gx: frame.readInt16LE(12) / 10,
      gy: frame.readInt16LE(14) / 10,
      gz: frame.readInt16LE(16) / 10
    };

    const imuData = this.normalizeImuData(payload);
    if (imuData) {
      this.recordImuPacket(imuData);
    }
  }

  private handleCompactTofPacket(frame: Buffer): void {
    const distances: number[] = [];
    const statuses: number[] = [];
    const resolution = frame.readUInt8(6);
    const version = frame.readUInt8(2);

    for (let i = 0; i < 64; i++) {
      distances.push(frame.readInt16LE(8 + i * 2));
      if (version === COMPACT_TOF_VERSION) {
        const valid = Boolean(frame.readUInt8(136 + Math.floor(i / 8)) & (1 << (i % 8)));
        statuses.push(valid ? 5 : 255);
      } else {
        statuses.push(frame.readUInt8(136 + i));
      }
    }

    this.recordTofPacket({
      resolution,
      frequency: frame.readUInt8(7),
      sequence: frame.readUInt16LE(4),
      distances,
      statuses
    });
  }

  private handleCompactPcbTempPacket(frame: Buffer): void {
    this.recordPcbTempPacket({
      sequence: frame.readUInt16LE(4),
      tempC: frame.readInt16LE(6) / 100,
      present: Boolean(frame.readUInt8(3) & 0x01),
      valid: Boolean(frame.readUInt8(3) & 0x02)
    });
  }

  private handleCompactRtdPacket(frame: Buffer): void {
    const leftC100 = frame.readInt16LE(6);
    const rightC100 = frame.readInt16LE(8);
    const flags = frame.readUInt8(3);

    this.recordRtdPacket({
      sequence: frame.readUInt16LE(4),
      leftPresent: Boolean(flags & 0x01),
      rightPresent: Boolean(flags & 0x02),
      leftValid: Boolean(flags & 0x04),
      rightValid: Boolean(flags & 0x08),
      leftTempC: leftC100 === -32768 ? null : leftC100 / 100,
      rightTempC: rightC100 === -32768 ? null : rightC100 / 100,
      leftFault: frame.readUInt8(10),
      rightFault: frame.readUInt8(11)
    });
  }

  private handleCompactMlx90614Packet(frame: Buffer): void {
    const ambientC100 = frame.readInt16LE(6);
    const objectC100 = frame.readInt16LE(8);
    const flags = frame.readUInt8(3);

    this.recordMlx90614Packet({
      sequence: frame.readUInt16LE(4),
      present: Boolean(flags & 0x01),
      ambientValid: Boolean(flags & 0x02),
      objectValid: Boolean(flags & 0x04),
      ambientTempC: ambientC100 === -32768 ? null : ambientC100 / 100,
      objectTempC: objectC100 === -32768 ? null : objectC100 / 100
    });
  }

  private handleCompactFsrPacket(frame: Buffer): void {
    const readOptionalUInt16 = (offset: number): number | null => {
      const value = frame.readUInt16LE(offset);
      return value === 0xffff ? null : value;
    };
    const leftPressure1000 = readOptionalUInt16(14);
    const rightPressure1000 = readOptionalUInt16(16);

    this.recordFsrPacket({
      sequence: frame.readUInt16LE(4),
      leftPresent: Boolean(frame.readUInt8(3) & 0x01),
      rightPresent: Boolean(frame.readUInt8(3) & 0x02),
      leftTriggered: Boolean(frame.readUInt8(3) & 0x04),
      rightTriggered: Boolean(frame.readUInt8(3) & 0x08),
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
    });
  }

  private handleCompactMotorEncoderPacket(frame: Buffer): void {
    const encoderTicks = frame.readInt32LE(8);
    const angleDeg10 = frame.readInt16LE(12);
    const rpm10 = frame.readInt16LE(14);

    this.recordMotorEncoderPacket({
      sequence: frame.readUInt16LE(4),
      encoderPresent: Boolean(frame.readUInt8(3) & 0x01),
      motorActive: Boolean(frame.readUInt8(3) & 0x02),
      motorEnabled: Boolean(frame.readUInt8(3) & 0x04),
      motorFault: Boolean(frame.readUInt8(3) & 0x08),
      motorSpeed: frame.readInt16LE(6),
      encoderTicks: encoderTicks === -2147483648 ? null : encoderTicks,
      angleDeg: angleDeg10 === -32768 ? null : angleDeg10 / 10,
      rpm: rpm10 === -32768 ? null : rpm10 / 10
    });
  }

  private handleCompactSensorStatusPacket(frame: Buffer): void {
    this.emit('sensor-status', this.decodeSensorStatusMasks(frame[3], frame[4], frame[5], frame[6]));
  }

  private recordImuPacket(imuData: ImuData): void {
    this.packetCount += 1;
    this.lastImuData = imuData;
    this.emit('data', imuData);
    this.emit('packet-count', this.packetCount);

    this.resetPacketTimeout();
  }

  private recordTofPacket(tofData: TofData): void {
    this.packetCount += 1;
    this.emit('tof-data', tofData);
    this.emit('packet-count', this.packetCount);

    this.resetPacketTimeout();
  }

  private recordPcbTempPacket(pcbTempData: PcbTempData): void {
    this.packetCount += 1;
    this.emit('pcb-temp-data', pcbTempData);
    this.emit('packet-count', this.packetCount);

    this.resetPacketTimeout();
  }

  private recordRtdPacket(rtdData: RtdData): void {
    this.packetCount += 1;
    this.emit('rtd-data', rtdData);
    this.emit('packet-count', this.packetCount);

    this.resetPacketTimeout();
  }

  private recordMlx90614Packet(mlx90614Data: Mlx90614Data): void {
    this.packetCount += 1;
    this.emit('mlx90614-data', mlx90614Data);
    this.emit('packet-count', this.packetCount);

    this.resetPacketTimeout();
  }

  private recordFsrPacket(fsrData: FsrData): void {
    this.packetCount += 1;
    this.emit('fsr-data', fsrData);
    this.emit('packet-count', this.packetCount);

    this.resetPacketTimeout();
  }

  private recordMotorEncoderPacket(motorEncoderData: MotorEncoderData): void {
    this.packetCount += 1;
    this.emit('motor-encoder-data', motorEncoderData);
    this.emit('packet-count', this.packetCount);

    this.resetPacketTimeout();
  }

  private isCompactImuFrame(buffer: Buffer): boolean {
    return (
      buffer.length >= 3 &&
      buffer[0] === IMU_MAGIC_0 &&
      buffer[1] === IMU_MAGIC_1 &&
      buffer[2] === COMPACT_VERSION
    );
  }

  private isCompactTofFrame(buffer: Buffer): boolean {
    return (
      buffer.length >= 3 &&
      buffer[0] === TOF_MAGIC_0 &&
      buffer[1] === TOF_MAGIC_1 &&
      (buffer[2] === COMPACT_VERSION || buffer[2] === COMPACT_TOF_VERSION)
    );
  }

  private getCompactTofPacketSize(buffer: Buffer): number {
    if (!this.isCompactTofFrame(buffer)) {
      return 0;
    }

    return buffer[2] === COMPACT_TOF_VERSION ? COMPACT_TOF_V2_PACKET_SIZE : COMPACT_TOF_V1_PACKET_SIZE;
  }

  private isCompactPcbTempFrame(buffer: Buffer): boolean {
    return (
      buffer.length >= 3 &&
      buffer[0] === PCB_TEMP_MAGIC_0 &&
      buffer[1] === PCB_TEMP_MAGIC_1 &&
      buffer[2] === COMPACT_VERSION
    );
  }

  private isCompactRtdFrame(buffer: Buffer): boolean {
    return (
      buffer.length >= 3 &&
      buffer[0] === RTD_MAGIC_0 &&
      buffer[1] === RTD_MAGIC_1 &&
      buffer[2] === COMPACT_VERSION
    );
  }

  private isCompactMlx90614Frame(buffer: Buffer): boolean {
    const hasStandardMagic = buffer[0] === MLX90614_MAGIC_0 && buffer[1] === MLX90614_MAGIC_1;
    const hasNullPrefixedMagic = buffer[0] === 0x00 && buffer[1] === MLX90614_MAGIC_1 && buffer[2] === COMPACT_VERSION;

    return (
      buffer.length >= 3 &&
      (hasStandardMagic || hasNullPrefixedMagic) &&
      buffer[2] === COMPACT_VERSION
    );
  }

  private isCompactFsrFrame(buffer: Buffer): boolean {
    const hasStandardMagic = buffer[0] === FSR_MAGIC_0 && buffer[1] === FSR_MAGIC_1;
    const hasNullPrefixedMagic = buffer[0] === 0x00 && buffer[1] === FSR_MAGIC_1 && buffer[2] === COMPACT_FSR_VERSION;

    return (
      buffer.length >= 3 &&
      (hasStandardMagic || hasNullPrefixedMagic) &&
      (buffer[2] === COMPACT_VERSION || buffer[2] === COMPACT_FSR_VERSION)
    );
  }

  private isCompactMotorEncoderFrame(buffer: Buffer): boolean {
    return (
      buffer.length >= 3 &&
      buffer[0] === MOTOR_ENCODER_MAGIC_0 &&
      buffer[1] === MOTOR_ENCODER_MAGIC_1 &&
      buffer[2] === COMPACT_VERSION
    );
  }

  private isCompactSensorStatusFrame(buffer: Buffer): boolean {
    return (
      buffer.length >= 3 &&
      buffer[0] === SENSOR_STATUS_MAGIC_0 &&
      buffer[1] === SENSOR_STATUS_MAGIC_1 &&
      buffer[2] === COMPACT_VERSION
    );
  }

  private decodeSensorStatusMasks(
    detectedMask: number,
    availableMask: number,
    validMask: number,
    faultMask: number
  ): SensorStatusData {
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
  }

  private normalizeImuData(payload: Partial<ImuData>): ImuData | null {
    if (!this.hasSensorData(payload)) {
      return null;
    }

    const now = Date.now();
    const dt = this.lastPacketAt
      ? Math.min((now - this.lastPacketAt) / 1000, MAX_INTEGRATION_DT_SECONDS)
      : 0;
    this.lastPacketAt = now;

    const hasOrientation =
      this.isFiniteNumber(payload.roll) &&
      this.isFiniteNumber(payload.pitch) &&
      this.isFiniteNumber(payload.yaw);

    if (!hasOrientation && !this.warnedAboutEstimatedOrientation) {
      this.warnedAboutEstimatedOrientation = true;
      this.addLog(
        'info',
        'Incoming packets do not include roll/pitch/yaw; estimating roll and pitch from accelerometer and yaw from gyro Z.'
      );
    }

    const estimatedRoll = this.radiansToDegrees(Math.atan2(payload.ay, payload.az));
    const estimatedPitch = this.radiansToDegrees(
      Math.atan2(-payload.ax, Math.sqrt(payload.ay * payload.ay + payload.az * payload.az))
    );
    const estimatedYaw = this.normalizeDegrees((this.lastImuData?.yaw ?? 0) + payload.gz * dt);

    return {
      roll: this.isFiniteNumber(payload.roll) ? payload.roll : estimatedRoll,
      pitch: this.isFiniteNumber(payload.pitch) ? payload.pitch : estimatedPitch,
      yaw: this.isFiniteNumber(payload.yaw) ? this.normalizeDegrees(payload.yaw) : estimatedYaw,
      ax: payload.ax,
      ay: payload.ay,
      az: payload.az,
      gx: payload.gx,
      gy: payload.gy,
      gz: payload.gz
    };
  }

  private normalizeTofData(payload: { d?: unknown; s?: unknown }): TofData | null {
    if (!Array.isArray(payload.d) || !Array.isArray(payload.s)) {
      return null;
    }

    const distances = payload.d
      .slice(0, 64)
      .map((value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : -1));
    const statuses = payload.s
      .slice(0, 64)
      .map((value) => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(255, Math.round(value))) : 255));

    while (distances.length < 64) distances.push(-1);
    while (statuses.length < 64) statuses.push(255);

    return {
      resolution: Math.min(distances.length, 64),
      frequency: 0,
      sequence: 0,
      distances,
      statuses
    };
  }

  private normalizePcbTempData(payload: { pcb?: unknown }): PcbTempData | null {
    if (!this.isFiniteNumber(payload.pcb)) {
      return null;
    }

    return {
      sequence: 0,
      tempC: payload.pcb,
      present: true,
      valid: true
    };
  }

  private normalizeMlx90614Data(payload: {
    mlx?: unknown;
    mlx90614?: unknown;
    ir?: unknown;
    ir_temp?: unknown;
  }): Mlx90614Data | null {
    const source = this.isRecord(payload.mlx90614)
      ? payload.mlx90614
      : this.isRecord(payload.ir_temp)
        ? payload.ir_temp
        : this.isRecord(payload.mlx)
          ? payload.mlx
          : this.isRecord(payload.ir)
            ? payload.ir
            : null;

    if (!source) {
      return null;
    }

    const ambient = this.readNumberFromRecord(
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
    const object = this.readNumberFromRecord(
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

    if (!this.isFiniteNumber(ambient) && !this.isFiniteNumber(object)) {
      return null;
    }

    return {
      sequence: this.readNumberFromRecord(source, 'sequence', 'seq') ?? 0,
      present: true,
      ambientValid: this.isFiniteNumber(ambient),
      objectValid: this.isFiniteNumber(object),
      ambientTempC: this.isFiniteNumber(ambient) ? ambient : null,
      objectTempC: this.isFiniteNumber(object) ? object : null
    };
  }

  private normalizeRtdData(payload: {
    rtd?: unknown;
    pt1000?: unknown;
    pt1000a?: unknown;
    rtd_temp?: unknown;
  }): RtdData | null {
    const payloadRecord = payload as Record<string, unknown>;
    const source = this.isRecord(payload.rtd)
      ? payload.rtd
      : this.isRecord(payload.pt1000)
        ? payload.pt1000
        : this.isRecord(payload.pt1000a)
          ? payload.pt1000a
          : this.isRecord(payload.rtd_temp)
            ? payload.rtd_temp
            : payloadRecord;
    const leftTempC = this.readNumberFromRecord(
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
    const rightTempC = this.readNumberFromRecord(
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

    if (!this.isFiniteNumber(leftTempC) && !this.isFiniteNumber(rightTempC)) {
      return null;
    }

    const leftFault = this.readNumberFromRecord(source, 'leftFault', 'left_fault') ?? 0;
    const rightFault = this.readNumberFromRecord(source, 'rightFault', 'right_fault') ?? 0;
    const leftPresent = this.readBooleanFromRecord(source, 'leftPresent', 'left_present', 'leftDetected', 'left_detected') ?? this.isFiniteNumber(leftTempC);
    const rightPresent =
      this.readBooleanFromRecord(source, 'rightPresent', 'right_present', 'rightDetected', 'right_detected') ?? this.isFiniteNumber(rightTempC);

    return {
      sequence: this.readNumberFromRecord(source, 'sequence', 'seq') ?? 0,
      leftPresent,
      rightPresent,
      leftValid:
        this.readBooleanFromRecord(source, 'leftValid', 'left_valid') ??
        (leftPresent && this.isFiniteNumber(leftTempC) && leftFault === 0),
      rightValid:
        this.readBooleanFromRecord(source, 'rightValid', 'right_valid') ??
        (rightPresent && this.isFiniteNumber(rightTempC) && rightFault === 0),
      leftTempC: this.isFiniteNumber(leftTempC) ? leftTempC : null,
      rightTempC: this.isFiniteNumber(rightTempC) ? rightTempC : null,
      leftFault,
      rightFault
    };
  }

  private normalizeFsrData(payload: {
    fsr?: unknown;
    force?: unknown;
    forces?: unknown;
    fsr_force?: unknown;
  }): FsrData | null {
    const payloadRecord = payload as Record<string, unknown>;
    const source = this.isRecord(payload.fsr)
      ? payload.fsr
      : this.isRecord(payload.fsr_force)
        ? payload.fsr_force
        : this.isRecord(payload.force)
          ? payload.force
          : this.isRecord(payload.forces)
            ? payload.forces
            : payloadRecord;
    const leftForceGrams = this.readNumberFromRecord(
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
    const rightForceGrams = this.readNumberFromRecord(
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
    const leftRaw = this.readNumberFromRecord(source, 'leftRaw', 'left_raw', 'leftAdc', 'left_adc');
    const rightRaw = this.readNumberFromRecord(source, 'rightRaw', 'right_raw', 'rightAdc', 'right_adc');

    if (
      !this.isFiniteNumber(leftForceGrams) &&
      !this.isFiniteNumber(rightForceGrams) &&
      !this.isFiniteNumber(leftRaw) &&
      !this.isFiniteNumber(rightRaw)
    ) {
      return null;
    }

    const leftPresent =
      this.readBooleanFromRecord(source, 'leftPresent', 'left_present', 'leftDetected', 'left_detected') ??
      (this.isFiniteNumber(leftForceGrams) || this.isFiniteNumber(leftRaw));
    const rightPresent =
      this.readBooleanFromRecord(source, 'rightPresent', 'right_present', 'rightDetected', 'right_detected') ??
      (this.isFiniteNumber(rightForceGrams) || this.isFiniteNumber(rightRaw));

    return {
      sequence: this.readNumberFromRecord(source, 'sequence', 'seq') ?? 0,
      leftPresent,
      rightPresent,
      leftTriggered:
        this.readBooleanFromRecord(source, 'leftTriggered', 'left_triggered', 'leftContact', 'left_contact') ??
        (this.isFiniteNumber(leftForceGrams) && leftForceGrams > 0),
      rightTriggered:
        this.readBooleanFromRecord(source, 'rightTriggered', 'right_triggered', 'rightContact', 'right_contact') ??
        (this.isFiniteNumber(rightForceGrams) && rightForceGrams > 0),
      leftRaw: this.isFiniteNumber(leftRaw) ? leftRaw : null,
      rightRaw: this.isFiniteNumber(rightRaw) ? rightRaw : null,
      leftMillivolts: this.readNumberFromRecord(source, 'leftMillivolts', 'leftMv', 'left_mV', 'left_mv') ?? null,
      rightMillivolts: this.readNumberFromRecord(source, 'rightMillivolts', 'rightMv', 'right_mV', 'right_mv') ?? null,
      leftPressure: this.readNumberFromRecord(source, 'leftPressure', 'left_pressure') ?? null,
      rightPressure: this.readNumberFromRecord(source, 'rightPressure', 'right_pressure') ?? null,
      leftResistanceKohm: this.readNumberFromRecord(source, 'leftResistanceKohm', 'leftResistance', 'left_resistance_kohm') ?? null,
      rightResistanceKohm: this.readNumberFromRecord(source, 'rightResistanceKohm', 'rightResistance', 'right_resistance_kohm') ?? null,
      leftForceGrams: this.isFiniteNumber(leftForceGrams) ? leftForceGrams : null,
      rightForceGrams: this.isFiniteNumber(rightForceGrams) ? rightForceGrams : null
    };
  }

  private normalizeSensorStatusData(payload: { sensor_status?: unknown; sensors?: unknown }): SensorStatusData | null {
    const source = this.isRecord(payload.sensor_status)
      ? payload.sensor_status
      : this.isRecord(payload.sensors)
        ? payload.sensors
        : null;

    if (!source) {
      return null;
    }

    const readProbe = (...keys: string[]) => {
      for (const key of keys) {
        const value = source[key];
        if (this.isRecord(value)) {
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
  }

  private readNumberFromRecord(source: Record<string, unknown>, ...keys: string[]): number | undefined {
    for (const key of keys) {
      const value = source[key];
      if (this.isFiniteNumber(value)) {
        return value;
      }
    }

    return undefined;
  }

  private readBooleanFromRecord(source: Record<string, unknown>, ...keys: string[]): boolean | undefined {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'boolean') {
        return value;
      }
    }

    return undefined;
  }

  private hasSensorData(
    payload: Partial<ImuData>
  ): payload is Partial<ImuData> & Pick<ImuData, 'ax' | 'ay' | 'az' | 'gx' | 'gy' | 'gz'> {
    return (
      this.isFiniteNumber(payload.ax) &&
      this.isFiniteNumber(payload.ay) &&
      this.isFiniteNumber(payload.az) &&
      this.isFiniteNumber(payload.gx) &&
      this.isFiniteNumber(payload.gy) &&
      this.isFiniteNumber(payload.gz)
    );
  }

  private isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private radiansToDegrees(value: number): number {
    return (value * 180) / Math.PI;
  }

  private normalizeDegrees(value: number): number {
    return ((((value + 180) % 360) + 360) % 360) - 180;
  }

  private scheduleReconnect(): void {
    if (this.intentionalDisconnect || this.reconnectTimer || !this.selectedPort) {
      return;
    }

    this.setStatus('reconnecting');
    this.addLog('warning', `Reconnection attempt scheduled in ${RECONNECT_DELAY_MS / 1000}s.`);

    this.reconnectTimer = setTimeout(() => {
      const portPath = this.selectedPort;
      this.reconnectTimer = null;
      if (!portPath || this.intentionalDisconnect) {
        return;
      }

      this.addLog('info', `Attempting to reconnect to ${portPath}.`);
      void this.connect(portPath).catch(async () => {
        await delay(250);
        this.scheduleReconnect();
      });
    }, RECONNECT_DELAY_MS);
  }

  private resetPacketTimeout(): void {
    this.clearPacketTimeout();
    this.packetTimeoutTimer = setTimeout(() => {
      if (this.status === 'connected') {
        this.addLog('warning', `Serial timeout: no IMU packet received for ${PACKET_TIMEOUT_MS / 1000}s.`);
      }
    }, PACKET_TIMEOUT_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearPacketTimeout(): void {
    if (this.packetTimeoutTimer) {
      clearTimeout(this.packetTimeoutTimer);
      this.packetTimeoutTimer = null;
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.emit('status', status);
    }
  }

  private addLog(level: LogEntry['level'], message: string): void {
    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: new Date().toISOString(),
      level,
      message
    };

    this.logs = [...this.logs.slice(-(MAX_LOGS - 1)), entry];
    this.emit('log', entry);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

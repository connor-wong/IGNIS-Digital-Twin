import { useEffect, useRef, useState } from 'react';
import { buildTemperatureLogFileName, saveTemperatureLogWorkbook } from './DashboardPanels';
import { bleImuClient } from '../services/bleImuClient';
import { useTheme } from '../hooks/useTheme';
import { useImuStore } from '../store/imuStore';
import type { ConnectionStatus, ConnectionTransport, DeviceRole, FsrSteadySideStatus } from '../types/imu';

const DEFAULT_SERIAL_PORT = 'COM10';
const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
const TEST_STEADY_WINDOW_MS = 3000;
const TEST_STEADY_TOLERANCE = 0.2;
const TEST_STEADY_TIMEOUT_MS = 60000;
const TEST_POLL_MS = 100;
const TEST_JIG_UP_MS = 5000;
const TEST_JIG_DOWN_MS = 5000;
const TEST_HOLD_MS = 10000;
const TEST_ENCODER_STEADY_WINDOW_MS = 2000;
const TEST_ENCODER_STEADY_TIMEOUT_MS = 30000;
const FSR_CONTACT_MIN_GRAMS = 20;
const FSR_STEADY_MIN_ABSOLUTE_TOLERANCE_GRAMS = 50;
const TEST_STOP_COMMAND_GAP_MS = 180;

type ForceSteadySideTracker = {
  startedAt: number | null;
  samples: Array<{ time: number; value: number }>;
  confirmed: boolean;
};

type EncoderSteadyTracker = {
  lastTicks: number | null;
  firstObservedAt: number | null;
  lastTickChangedAt: number | null;
  confirmed: boolean;
};

type DeviceConfig = {
  transport: ConnectionTransport;
  serialPort: string;
  bleName: string;
};

const DEVICE_COPY: Record<DeviceRole, { label: string; icon: string; defaultBleName: string }> = {
  gripper: {
    label: 'Gripper',
    icon: 'G',
    defaultBleName: 'IGNIS-Gripper'
  },
  testJig: {
    label: 'Test Jig',
    icon: 'J',
    defaultBleName: 'IGNIS-Jig'
  }
};

export const ConnectionPanel = (): JSX.Element => {
  const { theme, toggleTheme } = useTheme();
  const ports = useImuStore((state) => state.ports);
  const selectedPort = useImuStore((state) => state.selectedPort);
  const bleDevices = useImuStore((state) => state.bleDevices);
  const deviceConnections = useImuStore((state) => state.deviceConnections);
  const acquisitionState = useImuStore((state) => state.acquisitionState);
  const setTransport = useImuStore((state) => state.setTransport);
  const setSelectedPort = useImuStore((state) => state.setSelectedPort);
  const setBleDevices = useImuStore((state) => state.setBleDevices);
  const setPorts = useImuStore((state) => state.setPorts);
  const setActiveDeviceRole = useImuStore((state) => state.setActiveDeviceRole);
  const setDeviceTransport = useImuStore((state) => state.setDeviceTransport);
  const setDeviceSelectedPort = useImuStore((state) => state.setDeviceSelectedPort);
  const setDeviceSelectedBleDevice = useImuStore((state) => state.setDeviceSelectedBleDevice);
  const resetPacketStats = useImuStore((state) => state.resetPacketStats);
  const resetSensorStatus = useImuStore((state) => state.resetSensorStatus);
  const startAcquisition = useImuStore((state) => state.startAcquisition);
  const pauseAcquisition = useImuStore((state) => state.pauseAcquisition);
  const continueAcquisition = useImuStore((state) => state.continueAcquisition);
  const stopAcquisition = useImuStore((state) => state.stopAcquisition);
  const startTemperatureLogging = useImuStore((state) => state.startTemperatureLogging);
  const stopTemperatureLogging = useImuStore((state) => state.stopTemperatureLogging);
  const resetTemperatureLog = useImuStore((state) => state.resetTemperatureLog);
  const testRecordingEnabled = useImuStore((state) => state.testRecordingEnabled);
  const setFsrSteadyStatus = useImuStore((state) => state.setFsrSteadyStatus);
  const resetFsrSteadyStatus = useImuStore((state) => state.resetFsrSteadyStatus);
  const gripperSpeedTarget = useImuStore((state) => state.gripperSpeedTarget);
  const testJigUpSpeedTarget = useImuStore((state) => state.testJigUpSpeedTarget);
  const testJigDownSpeedTarget = useImuStore((state) => state.testJigDownSpeedTarget);
  const setTestJigMotion = useImuStore((state) => state.setTestJigMotion);
  const setTestRunState = useImuStore((state) => state.setTestRunState);
  const testAbortRequestId = useImuStore((state) => state.testAbortRequestId);
  const testObjectType = useImuStore((state) => state.testObjectType);
  const testLoadWeightKg = useImuStore((state) => state.testLoadWeightKg);
  const testRepeatCount = useImuStore((state) => state.testRepeatCount);
  const testContinuousMode = useImuStore((state) => state.testContinuousMode);
  const exportFolderPath = useImuStore((state) => state.exportFolderPath);
  const setTestMetadata = useImuStore((state) => state.setTestMetadata);
  const addLog = useImuStore((state) => state.addLog);
  const [busy, setBusy] = useState(false);
  const [commandBusy, setCommandBusy] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [selectedDeviceRole, setSelectedDeviceRole] = useState<DeviceRole>('gripper');
  const [testMode, setTestMode] = useState(false);
  const [testRunning, setTestRunning] = useState(false);
  const testAbortRef = useRef<AbortController | null>(null);
  const [deviceConfigs, setDeviceConfigs] = useState<Record<DeviceRole, DeviceConfig>>({
    gripper: {
      transport: 'ble',
      serialPort: selectedPort ?? DEFAULT_SERIAL_PORT,
      bleName: DEVICE_COPY.gripper.defaultBleName
    },
    testJig: {
      transport: 'serial',
      serialPort: DEFAULT_SERIAL_PORT,
      bleName: DEVICE_COPY.testJig.defaultBleName
    }
  });

  const selectedConnection = deviceConnections[selectedDeviceRole];
  const gripperConnection = deviceConnections.gripper;
  const testJigConnection = deviceConnections.testJig;
  const canSendCommand = gripperConnection.status === 'connected' && !busy && !commandBusy && !testRunning;
  const canStartTest =
    gripperConnection.status === 'connected' &&
    testJigConnection.status === 'connected' &&
    !busy &&
    !commandBusy &&
    !testRunning;
  const selectedDeviceConfig = deviceConfigs[selectedDeviceRole];
  const isBle = selectedDeviceConfig.transport === 'ble';
  const bleSupported = bleImuClient.isSupported();
  const selectedConnected = selectedConnection.status === 'connected' || selectedConnection.status === 'reconnecting';
  const selectedConnecting = selectedConnection.status === 'connecting';
  const canConnectSelected =
    !busy && !selectedConnecting && !selectedConnected && (isBle ? bleSupported : Boolean(selectedDeviceConfig.serialPort));
  const connectedDeviceCount = (Object.values(deviceConnections) as Array<{ status: ConnectionStatus }>).filter(
    (connection) => connection.status === 'connected' || connection.status === 'reconnecting'
  ).length;
  const selectedDeviceLabel = DEVICE_COPY[selectedDeviceRole].label;
  const clampedTestRepeatCount = Math.max(1, Math.min(99, Math.trunc(testRepeatCount) || 1));

  useEffect(() => {
    if (!selectedPort) {
      const preferredPort = ports.find((port) => port.path.toUpperCase() === DEFAULT_SERIAL_PORT)?.path;
      setSelectedPort(preferredPort ?? DEFAULT_SERIAL_PORT);
    }
  }, [ports, selectedPort, setSelectedPort]);

  useEffect(() => {
    if (!window.bleApi) {
      return undefined;
    }

    return window.bleApi.onDevices(setBleDevices);
  }, [setBleDevices]);

  useEffect(() => {
    testAbortRef.current?.abort();
  }, [testAbortRequestId]);

  const bleLabel = selectedConnection.selectedBleDevice ?? selectedDeviceConfig.bleName;

  const updateDeviceConfig = (role: DeviceRole, patch: Partial<DeviceConfig>): void => {
    setDeviceConfigs((current) => ({
      ...current,
      [role]: {
        ...current[role],
        ...patch
      }
    }));
    if (patch.transport) {
      setDeviceTransport(role, patch.transport);
    }
    if (patch.serialPort !== undefined) {
      setDeviceSelectedPort(role, patch.serialPort);
    }
    if (patch.bleName !== undefined) {
      setDeviceSelectedBleDevice(role, patch.bleName);
    }
  };

  const refreshPorts = async (): Promise<void> => {
    setBusy(true);
    try {
      setPorts(await window.serialApi.listPorts());
    } finally {
      setBusy(false);
    }
  };

  const connect = async (): Promise<void> => {
    const targetConfig = deviceConfigs[selectedDeviceRole];
    const portPath = targetConfig.serialPort;

    if (targetConfig.transport === 'serial' && !portPath) {
      return;
    }

    setBusy(true);
    try {
      resetPacketStats(selectedDeviceRole);
      if (selectedDeviceRole === 'gripper') {
        resetSensorStatus();
      }
      setTransport(targetConfig.transport);
      setDeviceTransport(selectedDeviceRole, targetConfig.transport);
      if (targetConfig.transport === 'ble') {
        await bleImuClient.connect(selectedDeviceRole, targetConfig.bleName);
        setActiveDeviceRole(selectedDeviceRole);
        await requestSensorStatus(selectedDeviceRole, 'ble');
      } else if (portPath) {
        setSelectedPort(portPath);
        setDeviceSelectedPort(selectedDeviceRole, portPath);
        await window.serialApi.connect(selectedDeviceRole, portPath);
        setActiveDeviceRole(selectedDeviceRole);
        await requestSensorStatus(selectedDeviceRole, 'serial');
      }
    } finally {
      setBusy(false);
    }
  };

  const requestSensorStatus = async (role: DeviceRole, targetTransport: ConnectionTransport): Promise<void> => {
    const waits = targetTransport === 'serial' ? [1600, 600, 900] : [250, 500, 800];

    for (const waitMs of waits) {
      await delay(waitMs);
      if (targetTransport === 'ble') {
        await bleImuClient.sendCommand(role, 'STATUS');
      } else {
        await window.serialApi.sendCommand(role, 'STATUS');
      }
    }
  };

  const disconnect = async (): Promise<void> => {
    const targetConfig = deviceConfigs[selectedDeviceRole];
    setBusy(true);
    try {
      if (selectedConnection.status === 'connected') {
        try {
          if (targetConfig.transport === 'ble') {
            await bleImuClient.sendCommand(selectedDeviceRole, 'STOP');
          } else {
            await window.serialApi.sendCommand(selectedDeviceRole, 'STOP');
          }
        } catch {
          // The transport may already be gone; continue closing the connection.
        }
      }

      if (targetConfig.transport === 'ble') {
        await bleImuClient.disconnect(selectedDeviceRole);
      } else {
        await window.serialApi.disconnect(selectedDeviceRole);
      }
    } finally {
      if (selectedDeviceRole === 'testJig') {
        setTestJigMotion('stopped');
      }
      setBusy(false);
    }
  };

  const selectBleDevice = async (deviceId: string, deviceName: string): Promise<void> => {
    updateDeviceConfig(selectedDeviceRole, { bleName: deviceName });
    setDeviceSelectedBleDevice(selectedDeviceRole, deviceName);
    await window.bleApi.selectDevice(deviceId);
  };

  const cancelBleScan = async (): Promise<void> => {
    await window.bleApi.cancelDeviceSelection();
  };

  const writeLog = (level: 'info' | 'success' | 'warning' | 'error', message: string): void => {
    addLog({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: new Date().toISOString(),
      level,
      message
    });
  };

  const sendCommand = async (role: DeviceRole, command: string): Promise<void> => {
    const connection = useImuStore.getState().deviceConnections[role];
    if (connection.status !== 'connected') {
      throw new Error(`${DEVICE_COPY[role].label} is not connected.`);
    }

    if (connection.transport === 'ble') {
      await bleImuClient.sendCommand(role, command);
    } else {
      await window.serialApi.sendCommand(role, command);
    }

    if (role === 'testJig') {
      if (command.startsWith('JIG:UP:')) {
        setTestJigMotion('up');
      } else if (command.startsWith('JIG:DOWN:')) {
        setTestJigMotion('down');
      } else if (command === 'JIG:STOP' || command === 'STOP') {
        setTestJigMotion('stopped');
      }
    }
  };

  const sendDeviceCommand = async (command: 'START' | 'STOP' | 'CALIBRATE'): Promise<void> => {
    setCommandBusy(true);
    try {
      await sendCommand('gripper', command);
    } finally {
      setCommandBusy(false);
    }
  };

  const waitForTest = async (milliseconds: number, signal: AbortSignal): Promise<void> => {
    const startedAt = Date.now();

    while (Date.now() - startedAt < milliseconds) {
      ensureTestHealthy(signal);
      const remaining = milliseconds - (Date.now() - startedAt);
      const waitMs = Math.min(TEST_POLL_MS, Math.max(remaining, 0));

      await new Promise<void>((resolve, reject) => {
        let timeout: number | null = null;
        const abort = (): void => {
          if (timeout !== null) {
            window.clearTimeout(timeout);
          }
          signal.removeEventListener('abort', abort);
          reject(new Error('Test aborted by user.'));
        };

        const finish = (): void => {
          signal.removeEventListener('abort', abort);
          resolve();
        };

        if (signal.aborted) {
          abort();
          return;
        }

        signal.addEventListener('abort', abort, { once: true });
        timeout = window.setTimeout(finish, waitMs);
      });
    }
  };

  const ensureTestHealthy = (signal: AbortSignal): void => {
    if (signal.aborted) {
      throw new Error('Test aborted by user.');
    }

    const state = useImuStore.getState();
    if (state.deviceConnections.gripper.status !== 'connected') {
      throw new Error('Gripper disconnected.');
    }
    if (state.deviceConnections.testJig.status !== 'connected') {
      throw new Error('Test jig disconnected.');
    }
    if (state.motorEncoderByRole.gripper.motorFault) {
      throw new Error('Gripper motor fault detected.');
    }
    if (state.acquisitionState === 'paused') {
      throw new Error('Test paused by safety warning.');
    }
  };

  const createForceSteadySideTracker = (): ForceSteadySideTracker => ({
    startedAt: null,
    samples: [],
    confirmed: false
  });

  const resetForceSteadySideTracker = (tracker: ForceSteadySideTracker): void => {
    tracker.startedAt = null;
    tracker.samples = [];
    tracker.confirmed = false;
  };

  const updateForceSteadySideStatus = (
    tracker: ForceSteadySideTracker,
    forceGrams: number | null,
    now: number
  ): FsrSteadySideStatus => {
    if (forceGrams === null || forceGrams < FSR_CONTACT_MIN_GRAMS) {
      resetForceSteadySideTracker(tracker);
      return {
        steady: false,
        seconds: 0,
        forceGrams,
        valid: false
      };
    }

    if (tracker.startedAt === null) {
      tracker.startedAt = now;
      tracker.samples = [];
      tracker.confirmed = false;
    }

    tracker.samples.push({ time: now, value: forceGrams });

    const values = tracker.samples.map((sample) => sample.value);
    const mean = values.reduce((total, value) => total + value, 0) / values.length;
    const spread = Math.max(...values) - Math.min(...values);
    const tolerance = Math.max(mean * TEST_STEADY_TOLERANCE, FSR_STEADY_MIN_ABSOLUTE_TOLERANCE_GRAMS);

    if (spread > tolerance) {
      tracker.startedAt = now;
      tracker.samples = [{ time: now, value: forceGrams }];
      tracker.confirmed = false;
      return {
        steady: false,
        seconds: 0,
        forceGrams,
        valid: true
      };
    }

    const seconds = Math.max((now - tracker.startedAt) / 1000, 0);
    const steady = tracker.confirmed || seconds >= TEST_STEADY_WINDOW_MS / 1000;
    tracker.confirmed = steady;

    return {
      steady,
      seconds: steady ? TEST_STEADY_WINDOW_MS / 1000 : seconds,
      forceGrams,
      valid: true
    };
  };

  const createEncoderSteadyTracker = (): EncoderSteadyTracker => ({
    lastTicks: null,
    firstObservedAt: null,
    lastTickChangedAt: null,
    confirmed: false
  });

  const updateEncoderSteadyTracker = (
    tracker: EncoderSteadyTracker,
    encoderTicks: number | null,
    now: number,
    steadyWindowMs = TEST_STEADY_WINDOW_MS
  ): { steady: boolean; seconds: number; ticks: number | null; valid: boolean } => {
    if (encoderTicks === null) {
      return {
        steady: false,
        seconds: 0,
        ticks: null,
        valid: false
      };
    }

    if (tracker.lastTicks === null) {
      tracker.lastTicks = encoderTicks;
      tracker.firstObservedAt = now;
      tracker.lastTickChangedAt = now;
      tracker.confirmed = false;
    } else if (encoderTicks !== tracker.lastTicks) {
      tracker.lastTicks = encoderTicks;
      tracker.lastTickChangedAt = now;
      tracker.confirmed = false;
    }

    const seconds = Math.max((now - (tracker.lastTickChangedAt ?? now)) / 1000, 0);
    const hasObservedLongEnough = tracker.firstObservedAt !== null && now - tracker.firstObservedAt >= 500;
    const steady = tracker.confirmed || (hasObservedLongEnough && seconds >= steadyWindowMs / 1000);
    tracker.confirmed = steady;

    return {
      steady,
      seconds: steady ? steadyWindowMs / 1000 : seconds,
      ticks: tracker.lastTicks,
      valid: true
    };
  };

  const waitForSteadyFsr = async (signal: AbortSignal): Promise<'force' | 'encoder-fallback'> => {
    const start = Date.now();
    const leftTracker = createForceSteadySideTracker();
    const rightTracker = createForceSteadySideTracker();
    const encoderTracker = createEncoderSteadyTracker();

    while (Date.now() - start < TEST_STEADY_TIMEOUT_MS) {
      ensureTestHealthy(signal);

      const time = Date.now();
      const state = useImuStore.getState();
      const left = state.fsr.leftForceGrams;
      const right = state.fsr.rightForceGrams;
      const encoder = state.motorEncoderByRole.gripper;
      const lastEncoderAt = state.lastMotorEncoderAtByRole.gripper;
      const fsrStale = !state.lastFsrAt || time - state.lastFsrAt > 2500;
      const encoderStale = !lastEncoderAt || time - lastEncoderAt > 2500;
      const encoderTicks =
        encoder.encoderPresent && !encoderStale && typeof encoder.encoderTicks === 'number' ? encoder.encoderTicks : null;

      const steadyStatus = {
        left: updateForceSteadySideStatus(leftTracker, typeof left === 'number' ? left : null, time),
        right: updateForceSteadySideStatus(rightTracker, typeof right === 'number' ? right : null, time),
        updatedAt: time
      };
      const encoderSteadyStatus = updateEncoderSteadyTracker(encoderTracker, encoderTicks, time);
      setFsrSteadyStatus(steadyStatus);

      const leftCovered = steadyStatus.left.valid ? steadyStatus.left.steady : encoderSteadyStatus.steady;
      const rightCovered = steadyStatus.right.valid ? steadyStatus.right.steady : encoderSteadyStatus.steady;

      if (leftCovered && rightCovered) {
        return !steadyStatus.left.valid || !steadyStatus.right.valid ? 'encoder-fallback' : 'force';
      }

      if (fsrStale && encoderStale && time - start > 5000) {
        throw new Error('FSR and encoder data timeout.');
      }

      await waitForTest(TEST_POLL_MS, signal);
    }

    throw new Error('Force/encoder steady state was not reached within 60 seconds.');
  };

  const waitForSteadyEncoder = async (signal: AbortSignal): Promise<void> => {
    const start = Date.now();
    let lastTicks: number | null = null;
    let firstObservedAt: number | null = null;
    let lastTickChangedAt: number | null = null;

    while (Date.now() - start < TEST_ENCODER_STEADY_TIMEOUT_MS) {
      ensureTestHealthy(signal);

      const now = Date.now();
      const state = useImuStore.getState();
      const encoder = state.motorEncoderByRole.gripper;
      const lastEncoderAt = state.lastMotorEncoderAtByRole.gripper;
      const encoderStale = !lastEncoderAt || now - lastEncoderAt > 2500;

      if (!encoder.encoderPresent) {
        throw new Error('Gripper encoder is not detected.');
      }

      if (encoderStale && !firstObservedAt && now - start > 5000) {
        throw new Error('Encoder data timeout.');
      }

      if (typeof encoder.encoderTicks === 'number') {
        if (lastTicks === null) {
          lastTicks = encoder.encoderTicks;
          firstObservedAt = now;
          lastTickChangedAt = now;
        } else if (encoder.encoderTicks !== lastTicks) {
          lastTicks = encoder.encoderTicks;
          lastTickChangedAt = now;
        }

        if (
          firstObservedAt !== null &&
          lastTickChangedAt !== null &&
          now - firstObservedAt >= 500 &&
          now - lastTickChangedAt >= TEST_ENCODER_STEADY_WINDOW_MS
        ) {
          writeLog('success', `Encoder steady at ${lastTicks} ticks. Stopping gripper.`);
          return;
        }
      }

      await waitForTest(TEST_POLL_MS, signal);
    }

    throw new Error('Encoder did not reach steady state within 30 seconds.');
  };

  const stopTestHardware = async (): Promise<void> => {
    const stopGripper = async (): Promise<void> => {
      await sendCommand('gripper', 'MOTOR:STOP');
      await delay(TEST_STOP_COMMAND_GAP_MS);
      await sendCommand('gripper', 'STOP');
    };

    await Promise.allSettled([
      stopGripper(),
      sendCommand('testJig', 'JIG:STOP')
    ]);
  };

  const runAutomatedTestCycle = async (controller: AbortController, repeatIndex: number, repeatTotal: number | null): Promise<void> => {
    const repeatLabel = repeatTotal === null ? ` run ${repeatIndex}` : repeatTotal > 1 ? ` ${repeatIndex}/${repeatTotal}` : '';

    resetFsrSteadyStatus();
    setTestRunState('running', 'close', `Preparing gripper${repeatLabel}`);
    writeLog('info', `Test sequence${repeatLabel} started.`);
    await sendCommand('gripper', 'START');
    await sendCommand('gripper', 'MOTOR:WAKE');
    await sendCommand('gripper', 'ENCODER:RESET');
    ensureTestHealthy(controller.signal);

    setTestRunState('running', 'close', `Closing gripper${repeatLabel}`);
    await sendCommand('gripper', `MOTOR:${-gripperSpeedTarget}`);
    writeLog('info', `Closing gripper at speed ${gripperSpeedTarget}.`);

    setTestRunState('running', 'steady', `Waiting for steady force/encoder${repeatLabel}`);
    const steadyMethod = await waitForSteadyFsr(controller.signal);

    ensureTestHealthy(controller.signal);
    setTestRunState('running', 'jigUp', `Moving test jig up${repeatLabel}`);
    resetFsrSteadyStatus();
    writeLog(
      'success',
      steadyMethod === 'force'
        ? 'FSR steady state reached. Moving test jig up.'
        : 'Steady state confirmed using encoder ticks for missing FSR data. Moving test jig up.'
    );
    await sendCommand('testJig', `JIG:UP:${testJigUpSpeedTarget}`);
    await waitForTest(TEST_JIG_UP_MS, controller.signal);

    await sendCommand('testJig', 'JIG:STOP');
    setTestRunState('running', 'hold', `Holding test position${repeatLabel}`);
    writeLog('info', 'Test jig stopped. Holding state for 10 seconds.');
    await waitForTest(TEST_HOLD_MS, controller.signal);

    ensureTestHealthy(controller.signal);
    setTestRunState('running', 'jigDown', `Returning test jig down${repeatLabel}`);
    writeLog('info', 'Hold complete. Moving test jig down.');
    await sendCommand('testJig', `JIG:DOWN:${testJigDownSpeedTarget}`);
    await waitForTest(TEST_JIG_DOWN_MS, controller.signal);
    await sendCommand('testJig', 'JIG:STOP');

    ensureTestHealthy(controller.signal);
    setTestRunState('running', 'open', `Opening gripper${repeatLabel}`);
    writeLog('info', 'Test jig returned down. Opening gripper until encoder is steady.');
    await sendCommand('gripper', `MOTOR:${gripperSpeedTarget}`);
    try {
      await waitForSteadyEncoder(controller.signal);
    } finally {
      await sendCommand('gripper', 'MOTOR:STOP');
    }
  };

  const exportCurrentTestRun = async (repeatIndex: number): Promise<void> => {
    const samples = useImuStore.getState().temperatureLogSamples;

    if (samples.length === 0) {
      writeLog('warning', `No logging samples captured for test run ${repeatIndex}.`);
      return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = buildTemperatureLogFileName(
      {
        objectType: testObjectType,
        loadWeightKg: testLoadWeightKg,
        gripperSpeedTarget,
        testNumber: repeatIndex
      },
      timestamp
    );

    const savedPath = await saveTemperatureLogWorkbook(samples, fileName, exportFolderPath);
    writeLog('success', `Auto-exported ${samples.length.toLocaleString()} samples to ${savedPath}.`);
  };

  const runAutomatedTest = async (): Promise<void> => {
    if (!canStartTest || testRunning) {
      writeLog('warning', 'Test mode requires both Gripper and Test Jig to be connected.');
      return;
    }

    const controller = new AbortController();
    const repeatTotal = testContinuousMode ? null : clampedTestRepeatCount;
    testAbortRef.current = controller;
    setCommandBusy(true);
    setTestRunning(true);
    resetFsrSteadyStatus();
    startAcquisition();

    try {
      let completedRuns = 0;
      for (let repeatIndex = 1; repeatTotal === null || repeatIndex <= repeatTotal; repeatIndex += 1) {
        if (testRecordingEnabled) {
          resetTemperatureLog();
          startTemperatureLogging();
        }
        await runAutomatedTestCycle(controller, repeatIndex, repeatTotal);
        completedRuns = repeatIndex;
        if (testRecordingEnabled) {
          stopTemperatureLogging();
          await exportCurrentTestRun(repeatIndex);
        }
      }

      stopAcquisition();
      await stopTestHardware();
      setTestRunState('complete', 'complete', 'Test complete');
      writeLog(
        'success',
        testRecordingEnabled
          ? `Test sequence complete after ${completedRuns} ${completedRuns === 1 ? 'run' : 'runs'}. Each run was exported automatically.`
          : `Test sequence complete after ${completedRuns} ${completedRuns === 1 ? 'run' : 'runs'}. Recording was disabled.`
      );
    } catch (error) {
      await stopTestHardware();
      stopTemperatureLogging();
      stopAcquisition();
      setTestRunState(
        controller.signal.aborted ? 'aborted' : 'failed',
        useImuStore.getState().activeTestMilestone,
        error instanceof Error ? error.message : 'Test failed'
      );
      writeLog(
        controller.signal.aborted ? 'warning' : 'error',
        error instanceof Error ? `Test ${controller.signal.aborted ? 'aborted' : 'failed'}: ${error.message}` : 'Test failed.'
      );
    } finally {
      resetFsrSteadyStatus();
      testAbortRef.current = null;
      setTestRunning(false);
      setCommandBusy(false);
    }
  };

  const startStream = async (): Promise<void> => {
    if (testMode) {
      await runAutomatedTest();
      return;
    }

    await sendDeviceCommand('START');
    startAcquisition();
  };

  const pauseStream = async (): Promise<void> => {
    await sendDeviceCommand('STOP');
    pauseAcquisition();
  };

  const continueStream = async (): Promise<void> => {
    await sendDeviceCommand('START');
    continueAcquisition();
  };

  const stopStream = async (): Promise<void> => {
    await sendDeviceCommand('STOP');
    stopAcquisition();
  };

  const updateTestRepeatCount = (value: string): void => {
    const parsed = Number.parseInt(value, 10);
    setTestMetadata({ testRepeatCount: Number.isFinite(parsed) ? Math.max(1, Math.min(99, parsed)) : 1 });
  };

  const updateTestLoadWeight = (value: string): void => {
    const parsed = Number.parseFloat(value);
    setTestMetadata({ testLoadWeightKg: Number.isFinite(parsed) ? Math.max(0, parsed) : null });
  };

  return (
    <section className="top-control">
      <div className="device-menu">
        <button className="device-menu-trigger" type="button" onClick={() => setDevicesOpen((open) => !open)}>
          <span>Devices</span>
          <strong>
            <i />
            {connectedDeviceCount} Connected
          </strong>
          <b>v</b>
        </button>

        {devicesOpen ? (
          <div className="device-popover">
            <div className="device-popover-heading">
              <strong>Devices (2)</strong>
            </div>

            {(['gripper', 'testJig'] as const).map((role) => {
              const config = deviceConfigs[role];
              const connection = deviceConnections[role];
              const selected = selectedDeviceRole === role;
              const online = connection.status === 'connected' || connection.status === 'reconnecting';
              const connecting = connection.status === 'connecting';
              return (
                <article
                  className={['device-card', selected ? 'selected' : '', online ? 'online' : ''].filter(Boolean).join(' ')}
                  key={role}
                >
                  <button className="device-card-main" type="button" onClick={() => setSelectedDeviceRole(role)}>
                    <div className="device-icon">{DEVICE_COPY[role].icon}</div>
                    <div>
                      <strong>{DEVICE_COPY[role].label}</strong>
                      <p>
                        <i />
                        {config.transport === 'serial' ? 'USB Serial' : 'Bluetooth LE'}
                        <span>{config.transport === 'serial' ? connection.selectedPort ?? config.serialPort : connection.selectedBleDevice ?? config.bleName}</span>
                      </p>
                      <small>{online ? 'Connected' : connecting ? 'Connecting' : selected ? 'Selected for setup' : 'Disconnected'}</small>
                    </div>
                  </button>
                </article>
              );
            })}

            <div className="device-config">
              <div className="compact-field">
                <label htmlFor="transport-select">Transport</label>
                <select
                  id="transport-select"
                  value={selectedDeviceConfig.transport}
                  disabled={busy || selectedConnected || selectedConnecting}
                  onChange={(event) =>
                    updateDeviceConfig(selectedDeviceRole, {
                      transport: event.target.value === 'ble' ? 'ble' : 'serial'
                    })
                  }
                >
                  <option value="serial">USB serial</option>
                  <option value="ble">BLE</option>
                </select>
              </div>

              {isBle ? (
                <div className="compact-field ble-compact-field">
                  <label>BLE device</label>
                  <div className="ble-target">
                    <strong>{bleLabel}</strong>
                    <span>
                      {bleSupported
                        ? selectedConnected
                          ? 'Connected'
                          : selectedConnecting
                            ? 'Scanning nearby devices'
                            : 'Use Connect below to scan'
                        : 'Web Bluetooth unavailable'}
                    </span>
                  </div>
                  {!selectedConnected && (
                    <div className="ble-device-list">
                      {bleDevices.length === 0 ? (
                        <p>{selectedConnecting ? 'Waiting for nearby BLE advertisements...' : 'No scan results yet.'}</p>
                      ) : (
                        bleDevices.map((device) => (
                          <button
                            className="ble-device-button"
                            key={device.id}
                            type="button"
                            onClick={() => void selectBleDevice(device.id, device.name)}
                          >
                            <strong>{device.name}</strong>
                            <span>{device.id}</span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="compact-field port-compact-field">
                  <label htmlFor="port-select">COM port</label>
                  <div className="select-row">
                    <select
                      id="port-select"
                      value={selectedDeviceConfig.serialPort}
                      disabled={busy || selectedConnected || selectedConnecting}
                      onChange={(event) => updateDeviceConfig(selectedDeviceRole, { serialPort: event.target.value || DEFAULT_SERIAL_PORT })}
                    >
                      {ports.length === 0 && <option value={selectedDeviceConfig.serialPort}>{selectedDeviceConfig.serialPort}</option>}
                      {selectedDeviceConfig.serialPort && !ports.some((port) => port.path === selectedDeviceConfig.serialPort) && ports.length > 0 && (
                        <option value={selectedDeviceConfig.serialPort}>{selectedDeviceConfig.serialPort} / not detected</option>
                      )}
                      {ports.map((port) => (
                        <option key={port.path} value={port.path}>
                          {port.manufacturer ? `${port.path} / ${port.manufacturer}` : port.path}
                        </option>
                      ))}
                    </select>
                    <button type="button" className="secondary-button" disabled={busy} onClick={refreshPorts}>
                      Refresh
                    </button>
                  </div>
                </div>
              )}
            </div>

            {isBle && selectedConnecting ? (
              <button type="button" className="device-popover-action" onClick={cancelBleScan}>
                Cancel scan
              </button>
            ) : selectedConnected ? (
              <button type="button" className="device-popover-action danger" disabled={busy} onClick={disconnect}>
                Disconnect {selectedDeviceLabel}
              </button>
            ) : (
              <button type="button" className="device-popover-action primary" disabled={!canConnectSelected} onClick={() => void connect()}>
                Connect {selectedDeviceLabel}
              </button>
            )}
          </div>
        ) : null}
      </div>

      <div className="top-command-row">
        {testRunning ? (
          null
        ) : acquisitionState === 'running' ? (
          <>
            <button type="button" className="command-pause" disabled={!canSendCommand} onClick={() => void pauseStream()}>
              Pause
            </button>
            <button type="button" className="command-stop" disabled={!canSendCommand} onClick={() => void stopStream()}>
              Stop
            </button>
          </>
        ) : acquisitionState === 'paused' ? (
          <>
            <button type="button" className="command-continue" disabled={!canSendCommand} onClick={() => void continueStream()}>
              Continue
            </button>
            <button type="button" className="command-start" disabled={!canSendCommand} onClick={() => void startStream()}>
              Reset
            </button>
            <button type="button" className="command-stop" disabled={!canSendCommand} onClick={() => void stopStream()}>
              Stop
            </button>
          </>
        ) : (
          <button type="button" className="command-start" disabled={testMode ? !canStartTest : !canSendCommand} onClick={() => void startStream()}>
            Start
          </button>
        )}
        <button type="button" disabled={!canSendCommand} onClick={() => void sendDeviceCommand('CALIBRATE')}>
          Calibrate
        </button>
        <label className={`test-mode-toggle ${testMode ? 'active' : ''}`}>
          <input
            type="checkbox"
            checked={testMode}
            disabled={testRunning || acquisitionState === 'running'}
            onChange={(event) => setTestMode(event.target.checked)}
          />
          Test
        </label>
        <label className="test-repeat-control">
          <span>Runs</span>
          <input
            type="number"
            min={1}
            max={99}
            step={1}
            value={clampedTestRepeatCount}
            disabled={!testMode || testContinuousMode || testRunning || acquisitionState === 'running'}
            onChange={(event) => updateTestRepeatCount(event.target.value)}
          />
        </label>
        <label className={`test-continuous-control ${testContinuousMode ? 'active' : ''}`}>
          <input
            type="checkbox"
            checked={testContinuousMode}
            disabled={!testMode || testRunning || acquisitionState === 'running'}
            onChange={(event) => setTestMetadata({ testContinuousMode: event.target.checked })}
          />
          Continuous
        </label>
        <label className="test-metadata-control object-type-control">
          <span>Object</span>
          <input
            type="text"
            value={testObjectType}
            placeholder="small sphere"
            disabled={testRunning || acquisitionState === 'running'}
            onChange={(event) => setTestMetadata({ testObjectType: event.target.value })}
          />
        </label>
        <label className="test-metadata-control load-weight-control">
          <span>Load</span>
          <input
            type="number"
            min={0}
            step={0.01}
            value={testLoadWeightKg ?? ''}
            placeholder="0.5"
            disabled={testRunning || acquisitionState === 'running'}
            onChange={(event) => updateTestLoadWeight(event.target.value)}
          />
          <b>kg</b>
        </label>
        <button
          type="button"
          className="theme-toggle-button"
          aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
          aria-pressed={theme === 'dark'}
          title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
          onClick={toggleTheme}
        >
          <span className="theme-toggle-icon" aria-hidden="true" />
          {theme === 'light' ? 'Dark' : 'Light'}
        </button>
      </div>
    </section>
  );
};

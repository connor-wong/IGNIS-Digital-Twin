import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useImuStore } from '../store/imuStore';
import { bleImuClient } from '../services/bleImuClient';
import type { DeviceRole } from '../types/imu';

const formatOptional = (value: number | null, unit = '', digits = 1): string =>
  value === null ? '--' : `${value.toFixed(digits)}${unit}`;
const clampSpeed = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));

export const MotorControlPanel = (): JSX.Element => {
  const [mode, setMode] = useState<'gripper' | 'test-jig'>('gripper');
  const [busy, setBusy] = useState(false);
  const activeDeviceRole = useImuStore((state) => state.activeDeviceRole);
  const deviceConnections = useImuStore((state) => state.deviceConnections);
  const motorEncoderByRole = useImuStore((state) => state.motorEncoderByRole);
  const lastMotorEncoderAtByRole = useImuStore((state) => state.lastMotorEncoderAtByRole);
  const speed = useImuStore((state) => state.gripperSpeedTarget);
  const jigUpSpeed = useImuStore((state) => state.testJigUpSpeedTarget);
  const jigDownSpeed = useImuStore((state) => state.testJigDownSpeedTarget);
  const setSpeed = useImuStore((state) => state.setGripperSpeedTarget);
  const setJigUpSpeed = useImuStore((state) => state.setTestJigUpSpeedTarget);
  const setJigDownSpeed = useImuStore((state) => state.setTestJigDownSpeedTarget);
  const setTestJigMotion = useImuStore((state) => state.setTestJigMotion);
  const addLog = useImuStore((state) => state.addLog);
  const isGripperMode = mode === 'gripper';
  const targetRole: DeviceRole = isGripperMode ? 'gripper' : 'testJig';
  const targetConnection = deviceConnections[targetRole];
  const motorEncoder = motorEncoderByRole[targetRole];
  const lastMotorEncoderAt = lastMotorEncoderAtByRole[targetRole];
  const canControlActiveDevice = targetConnection.status === 'connected';
  const isLive = Boolean(canControlActiveDevice && lastMotorEncoderAt && Date.now() - lastMotorEncoderAt < 3000);
  const speedFillStyle = (value: number): CSSProperties =>
    ({ '--speed-fill': `${(value / 255) * 100}%` }) as CSSProperties;
  const motorStateLabel = !isLive
    ? 'Pending'
    : motorEncoder.motorFault
      ? 'Fault'
      : motorEncoder.motorEnabled
        ? 'Awake'
        : 'Sleep';

  useEffect(() => {
    if (activeDeviceRole === 'testJig') {
      setMode('test-jig');
    } else if (activeDeviceRole === 'gripper') {
      setMode('gripper');
    }
  }, [activeDeviceRole]);

  const sendMotorCommand = async (command: string): Promise<void> => {
    if (!canControlActiveDevice) {
      addLog({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        timestamp: new Date().toISOString(),
        level: 'warning',
        message: `${isGripperMode ? 'Gripper' : 'Test Jig'} is not connected. Open Devices and connect it before sending control commands.`
      });
      return;
    }

    setBusy(true);
    try {
      const shouldWakeMotor = isGripperMode && /^MOTOR:-?\d+$/.test(command) && !motorEncoder.motorEnabled;
      if (targetConnection.transport === 'ble') {
        if (shouldWakeMotor) {
          await bleImuClient.sendCommand(targetRole, 'MOTOR:WAKE');
        }
        await bleImuClient.sendCommand(targetRole, command);
      } else {
        if (shouldWakeMotor) {
          await window.serialApi.sendCommand(targetRole, 'MOTOR:WAKE');
        }
        await window.serialApi.sendCommand(targetRole, command);
      }

      if (targetRole === 'testJig') {
        if (command.startsWith('JIG:UP:')) {
          setTestJigMotion('up');
        } else if (command.startsWith('JIG:DOWN:')) {
          setTestJigMotion('down');
        } else if (command === 'JIG:STOP') {
          setTestJigMotion('stopped');
        }
      }
    } catch (error) {
      addLog({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        timestamp: new Date().toISOString(),
        level: 'error',
        message: error instanceof Error ? `Motor command failed: ${error.message}` : 'Motor command failed.'
      });
    } finally {
      setBusy(false);
    }
  };

  const updateGripperSpeed = (value: number): void => setSpeed(clampSpeed(value));
  const updateJigUpSpeed = (value: number): void => setJigUpSpeed(clampSpeed(value));
  const updateJigDownSpeed = (value: number): void => setJigDownSpeed(clampSpeed(value));

  return (
    <section className="panel motor-control-panel">
      <div className="motor-panel-heading">
        <div className="motor-heading-title">
          <h2>Control</h2>
          <div className="control-tabs" role="tablist" aria-label="Control target">
            <button
              type="button"
              className={isGripperMode ? 'active' : ''}
              role="tab"
              aria-selected={isGripperMode}
              onClick={() => setMode('gripper')}
            >
              Gripper
            </button>
            <button
              type="button"
              className={!isGripperMode ? 'active' : ''}
              role="tab"
              aria-selected={!isGripperMode}
              onClick={() => setMode('test-jig')}
            >
              Test Jig
            </button>
          </div>
        </div>
        {isGripperMode ? (
          <span className={['motor-live-state', isLive && !motorEncoder.motorFault ? 'live' : '', motorEncoder.motorFault ? 'fault' : ''].filter(Boolean).join(' ')}>
            Motor: {motorStateLabel} / Encoder: {isLive && motorEncoder.encoderPresent ? 'OK' : activeDeviceRole === 'testJig' ? 'Test Jig Active' : 'Pending'}
          </span>
        ) : (
          <span className={canControlActiveDevice ? 'motor-live-state live' : 'motor-live-state'}>
            Jig: {canControlActiveDevice ? 'Ready' : activeDeviceRole === 'gripper' ? 'Gripper Active' : 'Offline'}
          </span>
        )}
      </div>

      <div className={`motor-control-body ${isGripperMode ? '' : 'test-jig-mode'}`}>
        <div className="motor-command-group">
          {isGripperMode ? (
            <>
              <button type="button" disabled={!canControlActiveDevice || busy} onClick={() => void sendMotorCommand(`MOTOR:${speed}`)}>
                Open
              </button>
              <button type="button" disabled={!canControlActiveDevice || busy} onClick={() => void sendMotorCommand(`MOTOR:${-speed}`)}>
                Close
              </button>
              <button type="button" disabled={!canControlActiveDevice || busy} onClick={() => void sendMotorCommand('MOTOR:STOP')}>
                Stop
              </button>
              <button type="button" disabled={!canControlActiveDevice || busy} onClick={() => void sendMotorCommand('ENCODER:RESET')}>
                Reset
              </button>
            </>
          ) : (
            <>
              <button type="button" disabled={!canControlActiveDevice || busy} onClick={() => void sendMotorCommand(`JIG:UP:${jigUpSpeed}`)}>
                Up
              </button>
              <button type="button" disabled={!canControlActiveDevice || busy} onClick={() => void sendMotorCommand(`JIG:DOWN:${jigDownSpeed}`)}>
                Down
              </button>
              <button type="button" disabled={!canControlActiveDevice || busy} onClick={() => void sendMotorCommand('JIG:STOP')}>
                Stop
              </button>
            </>
          )}
        </div>

        {isGripperMode ? (
          <div className="motor-speed-control">
            <span>Speed Target</span>
            <input
              aria-label="Gripper speed"
              max="255"
              min="0"
              step="1"
              style={speedFillStyle(speed)}
              type="range"
              value={speed}
              onChange={(event) => updateGripperSpeed(Number(event.target.value))}
            />
            <input
              aria-label="Gripper speed target value"
              className="motor-speed-number"
              inputMode="numeric"
              max="255"
              min="0"
              step="1"
              type="number"
              value={speed}
              onChange={(event) => updateGripperSpeed(Number(event.target.value))}
              onBlur={(event) => updateGripperSpeed(Number(event.target.value))}
            />
          </div>
        ) : (
          <div className="test-jig-speed-controls">
            <div className="motor-speed-control">
              <span>Up Speed</span>
              <input
                aria-label="Test jig up speed"
                max="255"
                min="0"
                step="1"
                style={speedFillStyle(jigUpSpeed)}
                type="range"
                value={jigUpSpeed}
                onChange={(event) => updateJigUpSpeed(Number(event.target.value))}
              />
              <input
                aria-label="Test jig up speed value"
                className="motor-speed-number"
                inputMode="numeric"
                max="255"
                min="0"
                step="1"
                type="number"
                value={jigUpSpeed}
                onChange={(event) => updateJigUpSpeed(Number(event.target.value))}
                onBlur={(event) => updateJigUpSpeed(Number(event.target.value))}
              />
            </div>
            <div className="motor-speed-control">
              <span>Down Speed</span>
              <input
                aria-label="Test jig down speed"
                max="255"
                min="0"
                step="1"
                style={speedFillStyle(jigDownSpeed)}
                type="range"
                value={jigDownSpeed}
                onChange={(event) => updateJigDownSpeed(Number(event.target.value))}
              />
              <input
                aria-label="Test jig down speed value"
                className="motor-speed-number"
                inputMode="numeric"
                max="255"
                min="0"
                step="1"
                type="number"
                value={jigDownSpeed}
                onChange={(event) => updateJigDownSpeed(Number(event.target.value))}
                onBlur={(event) => updateJigDownSpeed(Number(event.target.value))}
              />
            </div>
          </div>
        )}

        {isGripperMode ? (
          <div className="motor-readouts">
            <article>
              <span>Command PWM</span>
              <strong>{isLive ? motorEncoder.motorSpeed : '--'}</strong>
              <small>-255 to 255</small>
            </article>
            <article className="encoder-readout">
              <span>Encoder Ticks</span>
              <strong>{isLive && motorEncoder.encoderPresent ? (motorEncoder.encoderTicks ?? '--') : '--'}</strong>
              <small>Raw count</small>
            </article>
            <article>
              <span>Angle</span>
              <strong>{isLive ? formatOptional(motorEncoder.angleDeg, ' deg') : '--'}</strong>
              <small>Position</small>
            </article>
            <article>
              <span>Velocity</span>
              <strong>{isLive ? formatOptional(motorEncoder.rpm, ' rpm', 1) : '--'}</strong>
              <small>Encoder RPM</small>
            </article>
            <article>
              <span>Sleep</span>
              <strong>{isLive ? (motorEncoder.motorEnabled ? 'Awake' : 'Sleep') : '--'}</strong>
              <small>nSLEEP state</small>
            </article>
            <article className={isLive && motorEncoder.motorFault ? 'motor-readout-fault' : ''}>
              <span>Fault</span>
              <strong>{isLive ? (motorEncoder.motorFault ? 'Fault' : 'OK') : '--'}</strong>
              <small>DRV8833 nFAULT</small>
            </article>
          </div>
        ) : null}
      </div>
    </section>
  );
};

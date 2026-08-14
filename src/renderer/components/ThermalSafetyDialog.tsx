import { useEffect, useMemo, useRef, useState } from 'react';
import { bleImuClient } from '../services/bleImuClient';
import { useImuStore } from '../store/imuStore';
import type { DeviceRole } from '../types/imu';

const PCB_TEMP_PAUSE_C = 60;
const FINGER_TEMP_PAUSE_C = 280;

type ThermalBreach = {
  label: string;
  tempC: number;
  thresholdC: number;
};

type ThermalAlert = {
  id: string;
  triggeredAt: string;
  breaches: ThermalBreach[];
};

const roleLabel = (role: DeviceRole): string => (role === 'gripper' ? 'gripper' : 'test jig');

export const ThermalSafetyDialog = (): JSX.Element | null => {
  const pcbTemp = useImuStore((state) => state.pcbTemp);
  const rtd = useImuStore((state) => state.rtd);
  const deviceConnections = useImuStore((state) => state.deviceConnections);
  const addLog = useImuStore((state) => state.addLog);
  const pauseAcquisition = useImuStore((state) => state.pauseAcquisition);
  const continueAcquisition = useImuStore((state) => state.continueAcquisition);
  const stopAcquisition = useImuStore((state) => state.stopAcquisition);
  const [alert, setAlert] = useState<ThermalAlert | null>(null);
  const [busy, setBusy] = useState(false);
  const pauseIssuedRef = useRef(false);
  const suppressUntilSafeRef = useRef(false);

  const breaches = useMemo<ThermalBreach[]>(() => {
    const nextBreaches: ThermalBreach[] = [];

    if (pcbTemp.present && pcbTemp.valid && pcbTemp.tempC >= PCB_TEMP_PAUSE_C) {
      nextBreaches.push({
        label: 'PCB temperature',
        tempC: pcbTemp.tempC,
        thresholdC: PCB_TEMP_PAUSE_C
      });
    }

    if (rtd.leftPresent && rtd.leftValid && rtd.leftTempC !== null && rtd.leftTempC >= FINGER_TEMP_PAUSE_C) {
      nextBreaches.push({
        label: 'Left finger temperature',
        tempC: rtd.leftTempC,
        thresholdC: FINGER_TEMP_PAUSE_C
      });
    }

    if (rtd.rightPresent && rtd.rightValid && rtd.rightTempC !== null && rtd.rightTempC >= FINGER_TEMP_PAUSE_C) {
      nextBreaches.push({
        label: 'Right finger temperature',
        tempC: rtd.rightTempC,
        thresholdC: FINGER_TEMP_PAUSE_C
      });
    }

    return nextBreaches;
  }, [
    pcbTemp.present,
    pcbTemp.sequence,
    pcbTemp.tempC,
    pcbTemp.valid,
    rtd.leftPresent,
    rtd.leftTempC,
    rtd.leftValid,
    rtd.rightPresent,
    rtd.rightTempC,
    rtd.rightValid,
    rtd.sequence
  ]);

  const sendCommand = async (role: DeviceRole, command: string): Promise<void> => {
    const connection = deviceConnections[role];
    if (connection.status !== 'connected') {
      return;
    }

    if (connection.transport === 'ble') {
      await bleImuClient.sendCommand(role, command);
    } else {
      await window.serialApi.sendCommand(role, command);
    }
  };

  const sendSafetyPause = async (): Promise<void> => {
    const commandSets: Record<DeviceRole, string[]> = {
      gripper: ['MOTOR:STOP', 'STOP'],
      testJig: ['JIG:STOP', 'STOP']
    };

    await Promise.all(
      (Object.keys(commandSets) as DeviceRole[]).flatMap((role) =>
        commandSets[role].map(async (command) => {
          try {
            await sendCommand(role, command);
          } catch (error) {
            addLog({
              id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
              timestamp: new Date().toISOString(),
              level: 'error',
              message:
                error instanceof Error
                  ? `Thermal safety could not send ${command} to ${roleLabel(role)}: ${error.message}`
                  : `Thermal safety could not send ${command} to ${roleLabel(role)}.`
            });
          }
        })
      )
    );
  };

  const sendContinue = async (): Promise<void> => {
    await Promise.all(
      (['gripper', 'testJig'] as DeviceRole[]).map(async (role) => {
        try {
          await sendCommand(role, 'START');
        } catch (error) {
          addLog({
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            timestamp: new Date().toISOString(),
            level: 'error',
            message:
              error instanceof Error
                ? `Thermal safety could not resume ${roleLabel(role)}: ${error.message}`
                : `Thermal safety could not resume ${roleLabel(role)}.`
          });
        }
      })
    );
  };

  useEffect(() => {
    if (breaches.length === 0) {
      pauseIssuedRef.current = false;
      suppressUntilSafeRef.current = false;
      return;
    }

    if (pauseIssuedRef.current || suppressUntilSafeRef.current || alert) {
      return;
    }

    const triggeredAt = new Date().toISOString();
    const nextAlert: ThermalAlert = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      triggeredAt,
      breaches
    };

    pauseIssuedRef.current = true;
    setAlert(nextAlert);
    pauseAcquisition();
    addLog({
      id: nextAlert.id,
      timestamp: triggeredAt,
      level: 'warning',
      message: `Thermal safety pause triggered: ${breaches
        .map((breach) => `${breach.label} ${breach.tempC.toFixed(1)} C`)
        .join(', ')}.`
    });
    void sendSafetyPause();
  }, [addLog, alert, breaches, pauseAcquisition]);

  const handleContinue = async (): Promise<void> => {
    setBusy(true);
    try {
      suppressUntilSafeRef.current = true;
      pauseIssuedRef.current = false;
      await sendContinue();
      continueAcquisition();
      setAlert(null);
      addLog({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        timestamp: new Date().toISOString(),
        level: 'info',
        message: 'Thermal safety override: user selected Continue.'
      });
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async (): Promise<void> => {
    setBusy(true);
    try {
      suppressUntilSafeRef.current = true;
      pauseIssuedRef.current = false;
      await sendSafetyPause();
      stopAcquisition();
      setAlert(null);
      addLog({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        timestamp: new Date().toISOString(),
        level: 'warning',
        message: 'Thermal safety stop confirmed by user.'
      });
    } finally {
      setBusy(false);
    }
  };

  if (!alert) {
    return null;
  }

  return (
    <div className="thermal-safety-overlay" role="alertdialog" aria-modal="true" aria-labelledby="thermal-safety-title">
      <section className="thermal-safety-dialog">
        <span className="thermal-safety-kicker">Thermal safety pause</span>
        <h2 id="thermal-safety-title">Temperature threshold reached</h2>
        <p>The Digital Twin has paused the gripper and test jig. Select Continue to resume, or Stop to keep the system stopped.</p>

        <div className="thermal-safety-readouts">
          {alert.breaches.map((breach) => (
            <article key={breach.label}>
              <span>{breach.label}</span>
              <strong>{breach.tempC.toFixed(1)} C</strong>
              <small>Limit {breach.thresholdC.toFixed(0)} C</small>
            </article>
          ))}
        </div>

        <div className="thermal-safety-actions">
          <button type="button" className="thermal-continue" disabled={busy} onClick={() => void handleContinue()}>
            Continue
          </button>
          <button type="button" className="thermal-stop" disabled={busy} onClick={() => void handleStop()}>
            Stop
          </button>
        </div>
      </section>
    </div>
  );
};

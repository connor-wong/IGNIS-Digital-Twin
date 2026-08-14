import { useEffect } from 'react';
import { useImuStore } from '../store/imuStore';
import type { DeviceRole, FsrData, ImuData, Mlx90614Data, MotorEncoderData, PcbTempData, RtdData, TofData } from '../types/imu';

const UI_FLUSH_INTERVAL_MS = 33;

export const useSerial = (): void => {
  const setImuData = useImuStore((state) => state.setImuData);
  const setTofData = useImuStore((state) => state.setTofData);
  const setPcbTempData = useImuStore((state) => state.setPcbTempData);
  const setRtdData = useImuStore((state) => state.setRtdData);
  const setMlx90614Data = useImuStore((state) => state.setMlx90614Data);
  const setFsrData = useImuStore((state) => state.setFsrData);
  const setMotorEncoderData = useImuStore((state) => state.setMotorEncoderData);
  const setSensorStatus = useImuStore((state) => state.setSensorStatus);
  const setStatus = useImuStore((state) => state.setStatus);
  const setPorts = useImuStore((state) => state.setPorts);
  const addLog = useImuStore((state) => state.addLog);
  const setPacketCount = useImuStore((state) => state.setPacketCount);
  const hydrateSnapshot = useImuStore((state) => state.hydrateSnapshot);

  useEffect(() => {
    let mounted = true;
    let flushTimer: number | null = null;
    let latestImuData: ImuData | null = null;
    let latestTofData: TofData | null = null;
    let latestPcbTempData: PcbTempData | null = null;
    let latestRtdData: RtdData | null = null;
    let latestMlx90614Data: Mlx90614Data | null = null;
    let latestFsrData: FsrData | null = null;
    let latestMotorEncoderDataByRole: Partial<Record<DeviceRole, MotorEncoderData>> = {};
    const serialApi = window.serialApi;

    const flushSensorData = (): void => {
      flushTimer = null;

      if (!mounted) {
        return;
      }

      if (latestImuData) {
        setImuData(latestImuData);
        latestImuData = null;
      }
      if (latestTofData) {
        setTofData(latestTofData);
        latestTofData = null;
      }
      if (latestPcbTempData) {
        setPcbTempData(latestPcbTempData);
        latestPcbTempData = null;
      }
      if (latestRtdData) {
        setRtdData(latestRtdData);
        latestRtdData = null;
      }
      if (latestMlx90614Data) {
        setMlx90614Data(latestMlx90614Data);
        latestMlx90614Data = null;
      }
      if (latestFsrData) {
        setFsrData(latestFsrData);
        latestFsrData = null;
      }
      for (const [role, data] of Object.entries(latestMotorEncoderDataByRole) as Array<[DeviceRole, MotorEncoderData]>) {
        setMotorEncoderData(data, role);
      }
      latestMotorEncoderDataByRole = {};
    };

    const scheduleSensorFlush = (): void => {
      if (flushTimer !== null) {
        return;
      }

      flushTimer = window.setTimeout(flushSensorData, UI_FLUSH_INTERVAL_MS);
    };

    if (!serialApi) {
      addLog({
        id: `preload-missing-${Date.now()}`,
        timestamp: new Date().toISOString(),
        level: 'error',
        message: 'Electron preload bridge is unavailable. Restart the app with npm run dev from the project folder.'
      });
      return () => {
        mounted = false;
      };
    }

    const unsubscribers = [
      serialApi.onImuData((data, role) => {
        if (role !== 'gripper') return;
        latestImuData = data;
        scheduleSensorFlush();
      }),
      serialApi.onTofData((data, role) => {
        if (role !== 'gripper') return;
        latestTofData = data;
        scheduleSensorFlush();
      }),
      serialApi.onPcbTempData((data, role) => {
        if (role !== 'gripper') return;
        latestPcbTempData = data;
        scheduleSensorFlush();
      }),
      serialApi.onRtdData((data, role) => {
        if (role !== 'gripper') return;
        latestRtdData = data;
        scheduleSensorFlush();
      }),
      serialApi.onMlx90614Data((data, role) => {
        if (role !== 'gripper') return;
        latestMlx90614Data = data;
        scheduleSensorFlush();
      }),
      serialApi.onFsrData((data, role) => {
        if (role !== 'gripper') return;
        latestFsrData = data;
        scheduleSensorFlush();
      }),
      serialApi.onMotorEncoderData((data, role) => {
        latestMotorEncoderDataByRole[role] = data;
        scheduleSensorFlush();
      }),
      serialApi.onSensorStatus((data, role) => {
        if (role === 'gripper') {
          setSensorStatus(data);
        }
      }),
      serialApi.onStatus((nextStatus, role) => setStatus(nextStatus, role)),
      serialApi.onPorts(setPorts),
      serialApi.onLog(addLog),
      serialApi.onPacketCount((count, role) => setPacketCount(count, role))
    ];

    void serialApi.getSnapshot().then((snapshot) => {
      if (mounted) {
        hydrateSnapshot(snapshot);
      }
    });

    void serialApi.listPorts().then((ports) => {
      if (mounted) {
        setPorts(ports);
      }
    });

    return () => {
      mounted = false;
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer);
      }
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }, [
    addLog,
    hydrateSnapshot,
    setImuData,
    setFsrData,
    setMotorEncoderData,
    setMlx90614Data,
    setPacketCount,
    setPcbTempData,
    setPorts,
    setRtdData,
    setSensorStatus,
    setStatus,
    setTofData
  ]);
};

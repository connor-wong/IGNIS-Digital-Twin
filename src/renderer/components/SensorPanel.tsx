import { useImuStore } from '../store/imuStore';

const format = (value: number, digits = 2): string => value.toFixed(digits);

export const SensorPanel = (): JSX.Element => {
  const imu = useImuStore((state) => state.imu);

  const accelerometer = [
    ['Accel X', imu.ax, 'g'],
    ['Accel Y', imu.ay, 'g'],
    ['Accel Z', imu.az, 'g']
  ] as const;

  const gyroscope = [
    ['Gyro X', imu.gx, 'deg/s'],
    ['Gyro Y', imu.gy, 'deg/s'],
    ['Gyro Z', imu.gz, 'deg/s']
  ] as const;

  return (
    <section className="panel sensor-panel">
      <div className="panel-heading bordered">
        <h2>Orientation (IMU)</h2>
        <span className="panel-note">MPU-9250</span>
      </div>

      <div className="imu-live-values">
        <p className="roll-value">
          <span>Roll</span>
          <strong>{format(imu.roll, 1)} deg</strong>
        </p>
        <p className="pitch-value">
          <span>Pitch</span>
          <strong>{format(imu.pitch, 1)} deg</strong>
        </p>
        <p className="yaw-value">
          <span>Yaw</span>
          <strong>{format(imu.yaw, 1)} deg</strong>
        </p>
      </div>

      <div className="imu-aux-grid">
        <div className="metric-section">
          <h3>Accelerometer</h3>
          {accelerometer.map(([label, value, unit]) => (
            <article className="metric-card" key={label}>
              <span>{label}</span>
              <strong>{format(value, 2)}</strong>
              <small>{unit}</small>
            </article>
          ))}
        </div>

        <div className="metric-section">
          <h3>Gyroscope</h3>
          {gyroscope.map(([label, value, unit]) => (
            <article className="metric-card" key={label}>
              <span>{label}</span>
              <strong>{format(value, 2)}</strong>
              <small>{unit}</small>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
};

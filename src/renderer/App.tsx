import { ConnectionPanel } from './components/ConnectionPanel';
import {
  FingerStatusPanel,
  ImuSummaryPanel,
  ObjectPerceptionPanel,
  RecordingPanel,
  SensorStatusPanel,
  TelemetrySummaryPanel
} from './components/DashboardPanels';
import { LogsPanel } from './components/LogsPanel';
import { MotorControlPanel } from './components/MotorControlPanel';
import { FsrPanel, TemperaturePanel } from './components/PlaceholderPanels';
import { ThermalSafetyDialog } from './components/ThermalSafetyDialog';
import { ThreeViewer } from './components/ThreeViewer';
import { TestMilestonesPanel } from './components/TestMilestonesPanel';
import { useSerial } from './hooks/useSerial';

export default function App(): JSX.Element {
  useSerial();

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <TelemetrySummaryPanel />
        <ConnectionPanel />
      </header>

      <section className="dashboard-grid">
        <div className="left-column">
          <ThreeViewer />
          <TestMilestonesPanel />
          <MotorControlPanel />
        </div>

        <div className="center-column">
          <FsrPanel />
          <TemperaturePanel />
          <div className="mini-grid center-mini-grid">
            <ImuSummaryPanel />
            <FingerStatusPanel />
          </div>
        </div>

        <div className="right-column">
          <ObjectPerceptionPanel />
          <SensorStatusPanel />
          <LogsPanel />
        </div>

        <RecordingPanel />
      </section>
      <ThermalSafetyDialog />
    </main>
  );
}

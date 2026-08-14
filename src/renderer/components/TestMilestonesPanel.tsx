import { useImuStore } from '../store/imuStore';
import type { TestMilestoneId } from '../types/imu';

const MILESTONES: Array<{ id: TestMilestoneId; label: string }> = [
  { id: 'close', label: 'Close' },
  { id: 'steady', label: 'Steady' },
  { id: 'jigUp', label: 'Up' },
  { id: 'hold', label: 'Hold' },
  { id: 'jigDown', label: 'Down' },
  { id: 'open', label: 'Open' },
  { id: 'complete', label: 'Done' }
];

export const TestMilestonesPanel = (): JSX.Element => {
  const testRunStatus = useImuStore((state) => state.testRunStatus);
  const activeTestMilestone = useImuStore((state) => state.activeTestMilestone);
  const testStatusMessage = useImuStore((state) => state.testStatusMessage);
  const requestTestAbort = useImuStore((state) => state.requestTestAbort);
  const activeIndex = activeTestMilestone ? MILESTONES.findIndex((milestone) => milestone.id === activeTestMilestone) : -1;

  const milestoneStatus = (index: number): string => {
    if (testRunStatus === 'complete') return 'complete';
    if (testRunStatus === 'failed' || testRunStatus === 'aborted') {
      if (index < activeIndex) return 'complete';
      if (index === activeIndex) return testRunStatus;
      return 'pending';
    }
    if (testRunStatus === 'running') {
      if (index < activeIndex) return 'complete';
      if (index === activeIndex) return 'active';
    }
    return 'pending';
  };

  const statusLabel =
    testRunStatus === 'running'
      ? testStatusMessage ?? 'Test running'
      : testRunStatus === 'complete'
        ? 'Test complete'
        : testRunStatus === 'aborted'
          ? `Aborted${testStatusMessage ? `: ${testStatusMessage}` : ''}`
          : testRunStatus === 'failed'
            ? `Failed${testStatusMessage ? `: ${testStatusMessage}` : ''}`
            : 'Ready for test mode';

  return (
    <section className={`panel test-milestones-panel test-${testRunStatus}`}>
      <div className="test-milestones-heading">
        <div className="test-milestones-title">
          <h2>Test Milestones</h2>
          <span>{statusLabel}</span>
        </div>
        <button type="button" className="test-abort-button" disabled={testRunStatus !== 'running'} onClick={requestTestAbort}>
          Abort
        </button>
      </div>
      <div className="test-milestones-track" aria-label="Test sequence milestones">
        {MILESTONES.map((milestone, index) => (
          <div className={`test-milestone ${milestoneStatus(index)}`} key={milestone.id}>
            <i>{index + 1}</i>
            <span>{milestone.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
};

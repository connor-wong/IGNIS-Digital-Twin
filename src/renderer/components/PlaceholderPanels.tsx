import { useEffect, useMemo, useState } from 'react';
import type { MouseEvent } from 'react';
import { useImuStore } from '../store/imuStore';
import type { FsrSteadySideStatus } from '../types/imu';

const MAX_TEMPERATURE_SAMPLES = 900;
const DEFAULT_VISIBLE_TEMPERATURE_SAMPLES = 90;
const MIN_VISIBLE_TEMPERATURE_SAMPLES = 20;
const MAX_VISIBLE_TEMPERATURE_SAMPLES = 600;
const TEMPERATURE_CHART_WIDTH = 100;
const TEMPERATURE_CHART_HEIGHT = 100;
const TEMPERATURE_PLOT_LEFT = 0;
const TEMPERATURE_PLOT_RIGHT = 100;
const TEMPERATURE_PLOT_TOP = 0;
const TEMPERATURE_PLOT_BOTTOM = 100;
const FSR_MIN_FORCE_GRAMS = 20;
const FSR_MAX_FORCE_GRAMS = 10000;
const FSR_STEADY_WINDOW_SECONDS = 3;

interface TemperatureSample {
  sequence: number;
  pcbTempC: number | null;
  leftTempC: number | null;
  rightTempC: number | null;
  irAmbientTempC: number | null;
  irObjectTempC: number | null;
  elapsedSeconds: number;
}

interface FsrSample {
  sequence: number;
  leftForceGrams: number | null;
  rightForceGrams: number | null;
  elapsedSeconds: number;
}

interface ChartHoverState {
  index: number;
  x: number;
  align: 'left' | 'right';
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

const formatElapsedSeconds = (seconds?: number): string => {
  if (seconds === undefined) {
    return '-- s';
  }

  return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
};

const getChartHoverState = (event: MouseEvent<HTMLDivElement>, sampleCount: number): ChartHoverState | null => {
  if (sampleCount <= 0) {
    return null;
  }

  const bounds = event.currentTarget.getBoundingClientRect();
  const ratio = clamp((event.clientX - bounds.left) / Math.max(bounds.width, 1), 0, 1);
  const index = sampleCount <= 1 ? 0 : Math.round(ratio * (sampleCount - 1));
  const x = sampleCount <= 1 ? TEMPERATURE_PLOT_RIGHT : (index / (sampleCount - 1)) * TEMPERATURE_PLOT_RIGHT;

  return {
    index,
    x,
    align: ratio > 0.72 ? 'right' : 'left'
  };
};

const valueToChartY = (value: number, min: number, max: number): number => {
  const span = Math.max(max - min, 1);
  return TEMPERATURE_PLOT_TOP + (1 - clamp((value - min) / span, 0, 1)) * (TEMPERATURE_PLOT_BOTTOM - TEMPERATURE_PLOT_TOP);
};

const buildTemperaturePath = (samples: TemperatureSample[]): {
  pcbPath: string;
  leftPath: string;
  rightPath: string;
  irAmbientPath: string;
  irObjectPath: string;
  pcbLatestPoint: { x: number; y: number } | null;
  leftLatestPoint: { x: number; y: number } | null;
  rightLatestPoint: { x: number; y: number } | null;
  irAmbientLatestPoint: { x: number; y: number } | null;
  irObjectLatestPoint: { x: number; y: number } | null;
  min: number;
  max: number;
  mid: number;
} => {
  const values = samples.flatMap((sample) =>
    [sample.pcbTempC, sample.leftTempC, sample.rightTempC, sample.irAmbientTempC, sample.irObjectTempC].filter(
      (value): value is number => value !== null
    )
  );
  const rawMin = values.length > 0 ? Math.min(...values) : 20;
  const rawMax = values.length > 0 ? Math.max(...values) : 40;
  const center = (rawMin + rawMax) / 2;
  const halfSpan = Math.max((rawMax - rawMin) / 2, 0.35);
  const min = center - halfSpan * 1.25;
  const max = center + halfSpan * 1.25;
  const mid = (min + max) / 2;
  const span = Math.max(max - min, 1);
  const innerWidth = TEMPERATURE_PLOT_RIGHT - TEMPERATURE_PLOT_LEFT;
  const innerHeight = TEMPERATURE_PLOT_BOTTOM - TEMPERATURE_PLOT_TOP;

  const buildSeriesPath = (key: 'pcbTempC' | 'leftTempC' | 'rightTempC' | 'irAmbientTempC' | 'irObjectTempC') => {
    const points = samples
      .map((sample, index) => {
        const value = sample[key];
        if (value === null) {
          return null;
        }

        const x =
          TEMPERATURE_PLOT_LEFT +
          (samples.length <= 1 ? innerWidth : (index / (samples.length - 1)) * innerWidth);
        const y = TEMPERATURE_PLOT_TOP + (1 - (value - min) / span) * innerHeight;
        return { x, y };
      })
      .filter((point): point is { x: number; y: number } => point !== null);

    return {
      path: points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' '),
      latestPoint: points.at(-1) ?? null
    };
  };

  const pcb = buildSeriesPath('pcbTempC');
  const left = buildSeriesPath('leftTempC');
  const right = buildSeriesPath('rightTempC');
  const irAmbient = buildSeriesPath('irAmbientTempC');
  const irObject = buildSeriesPath('irObjectTempC');

  return {
    pcbPath: pcb.path,
    leftPath: left.path,
    rightPath: right.path,
    irAmbientPath: irAmbient.path,
    irObjectPath: irObject.path,
    pcbLatestPoint: pcb.latestPoint,
    leftLatestPoint: left.latestPoint,
    rightLatestPoint: right.latestPoint,
    irAmbientLatestPoint: irAmbient.latestPoint,
    irObjectLatestPoint: irObject.latestPoint,
    min,
    max,
    mid
  };
};

const buildFsrPaths = (samples: FsrSample[]): {
  leftPath: string;
  rightPath: string;
  leftLatestPoint: { x: number; y: number } | null;
  rightLatestPoint: { x: number; y: number } | null;
  min: number;
  max: number;
  mid: number;
} => {
  const values = samples.flatMap((sample) =>
    [sample.leftForceGrams, sample.rightForceGrams].filter((value): value is number => value !== null)
  );
  const max = Math.max(values.length > 0 ? Math.max(...values) * 1.15 : 100, 100);
  const min = 0;
  const mid = (min + max) / 2;
  const span = Math.max(max - min, 1);

  const buildSidePath = (side: 'leftForceGrams' | 'rightForceGrams') => {
    const points = samples
      .map((sample, index) => {
        const value = sample[side];
        if (value === null) {
          return null;
        }

        const x =
          TEMPERATURE_PLOT_LEFT +
          (samples.length <= 1
            ? TEMPERATURE_PLOT_RIGHT - TEMPERATURE_PLOT_LEFT
            : (index / (samples.length - 1)) * (TEMPERATURE_PLOT_RIGHT - TEMPERATURE_PLOT_LEFT));
        const y = TEMPERATURE_PLOT_TOP + (1 - clamp((value - min) / span, 0, 1)) * (TEMPERATURE_PLOT_BOTTOM - TEMPERATURE_PLOT_TOP);
        return { x, y };
      })
      .filter((point): point is { x: number; y: number } => point !== null);

    return {
      path: points
        .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
        .join(' '),
      latestPoint: points.at(-1) ?? null
    };
  };

  const left = buildSidePath('leftForceGrams');
  const right = buildSidePath('rightForceGrams');

  return {
    leftPath: left.path,
    rightPath: right.path,
    leftLatestPoint: left.latestPoint,
    rightLatestPoint: right.latestPoint,
    min,
    max,
    mid
  };
};

const formatForceGrams = (value: number | null): string => {
  if (value === null) {
    return '-- g';
  }

  if (Math.abs(value) >= 1000) {
    return `${(value / 1000).toFixed(value >= FSR_MAX_FORCE_GRAMS ? 1 : 2)} kg`;
  }

  return `${value.toFixed(0)} g`;
};

const formatFsrSteadyStatus = (
  status: FsrSteadySideStatus
): { label: 'No Data' | 'Waiting' | 'Steady'; seconds: number; steady: boolean } => ({
  label: status.forceGrams === null || !status.valid ? 'No Data' : status.steady ? 'Steady' : 'Waiting',
  seconds: status.seconds,
  steady: status.steady
});

export const FsrPanel = (): JSX.Element => {
  const fsr = useImuStore((state) => state.fsr);
  const fsrSteadyStatus = useImuStore((state) => state.fsrSteadyStatus);
  const testRunStatus = useImuStore((state) => state.testRunStatus);
  const activeTestMilestone = useImuStore((state) => state.activeTestMilestone);
  const lastFsrAt = useImuStore((state) => state.lastFsrAt);
  const acquisitionState = useImuStore((state) => state.acquisitionState);
  const acquisitionRunId = useImuStore((state) => state.acquisitionRunId);
  const acquisitionStartedAt = useImuStore((state) => state.acquisitionStartedAt);
  const acquisitionElapsedBeforePauseMs = useImuStore((state) => state.acquisitionElapsedBeforePauseMs);
  const importedTemperatureLogSamples = useImuStore((state) => state.importedTemperatureLogSamples);
  const [samples, setSamples] = useState<FsrSample[]>([]);
  const [visibleSampleCount, setVisibleSampleCount] = useState(DEFAULT_VISIBLE_TEMPERATURE_SAMPLES);
  const [panOffset, setPanOffset] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hover, setHover] = useState<ChartHoverState | null>(null);
  const importedSamples = useMemo<FsrSample[]>(
    () =>
      importedTemperatureLogSamples.map((sample) => ({
        sequence: sample.sequence,
        leftForceGrams: sample.leftForceGrams,
        rightForceGrams: sample.rightForceGrams,
        elapsedSeconds: sample.elapsedSeconds
      })),
    [importedTemperatureLogSamples]
  );
  const plotSamples = importedSamples.length > 0 ? importedSamples : samples;
  const isImported = importedSamples.length > 0;
  const isLive = Boolean(
    !isImported && lastFsrAt && Date.now() - lastFsrAt < 3000 && (fsr.leftPresent || fsr.rightPresent)
  );
  const visibleWindow = useMemo(() => {
    const clampedVisibleCount = clamp(visibleSampleCount, MIN_VISIBLE_TEMPERATURE_SAMPLES, MAX_VISIBLE_TEMPERATURE_SAMPLES);
    const maxOffset = Math.max(plotSamples.length - Math.min(clampedVisibleCount, plotSamples.length), 0);
    const clampedPanOffset = clamp(panOffset, 0, maxOffset);
    const end = Math.max(0, plotSamples.length - clampedPanOffset);
    const start = Math.max(0, end - clampedVisibleCount);

    return {
      samples: plotSamples.slice(start, end),
      maxOffset,
      clampedPanOffset
    };
  }, [panOffset, plotSamples, visibleSampleCount]);
  const chart = useMemo(() => buildFsrPaths(visibleWindow.samples), [visibleWindow.samples]);
  const useTestSteadyStatus =
    testRunStatus === 'running' &&
    activeTestMilestone === 'steady' &&
    Boolean(fsrSteadyStatus.updatedAt && Date.now() - fsrSteadyStatus.updatedAt < 5000);
  const leftSteadyStatus = useMemo(
    () => (useTestSteadyStatus ? formatFsrSteadyStatus(fsrSteadyStatus.left) : null),
    [fsrSteadyStatus.left, useTestSteadyStatus]
  );
  const rightSteadyStatus = useMemo(
    () => (useTestSteadyStatus ? formatFsrSteadyStatus(fsrSteadyStatus.right) : null),
    [fsrSteadyStatus.right, useTestSteadyStatus]
  );
  const scrollStep = Math.max(1, Math.round(visibleSampleCount * 0.35));
  const canScrollLeft = visibleWindow.clampedPanOffset < visibleWindow.maxOffset;
  const canScrollRight = visibleWindow.clampedPanOffset > 0;
  const canZoomIn = visibleSampleCount > MIN_VISIBLE_TEMPERATURE_SAMPLES;
  const canZoomOut = visibleSampleCount < Math.min(MAX_VISIBLE_TEMPERATURE_SAMPLES, MAX_TEMPERATURE_SAMPLES);
  const windowStartSeconds = visibleWindow.samples.at(0)?.elapsedSeconds;
  const windowEndSeconds = visibleWindow.samples.at(-1)?.elapsedSeconds;
  const latestImportedFsrSample = importedSamples.at(-1);
  const displayLeftForceGrams = isImported ? latestImportedFsrSample?.leftForceGrams ?? null : fsr.leftForceGrams;
  const displayRightForceGrams = isImported ? latestImportedFsrSample?.rightForceGrams ?? null : fsr.rightForceGrams;
  const hoveredSample = hover ? visibleWindow.samples[hover.index] : null;
  const fsrHoverMarkers = hoveredSample
    ? [
        { label: 'Left FSR', value: hoveredSample.leftForceGrams, className: 'fsr-left-dot' },
        { label: 'Right FSR', value: hoveredSample.rightForceGrams, className: 'fsr-right-dot' }
      ].filter((marker): marker is { label: string; value: number; className: string } => marker.value !== null)
    : [];

  const zoomFsrChart = (direction: 'in' | 'out'): void => {
    setVisibleSampleCount((current) => {
      const next = direction === 'in' ? Math.round(current / 1.5) : Math.round(current * 1.5);
      return clamp(next, MIN_VISIBLE_TEMPERATURE_SAMPLES, MAX_VISIBLE_TEMPERATURE_SAMPLES);
    });
  };

  const scrollFsrChart = (direction: 'left' | 'right'): void => {
    setPanOffset((current) => {
      const next = direction === 'left' ? current + scrollStep : current - scrollStep;
      return clamp(next, 0, visibleWindow.maxOffset);
    });
  };

  const updateFsrHover = (event: MouseEvent<HTMLDivElement>): void => {
    setHover(getChartHoverState(event, visibleWindow.samples.length));
  };

  useEffect(() => {
    if (!isFullscreen) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setIsFullscreen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen]);

  useEffect(() => {
    if (!lastFsrAt) {
      setSamples([]);
      return;
    }

    if (acquisitionState !== 'running') {
      return;
    }

    if (acquisitionStartedAt && lastFsrAt < acquisitionStartedAt) {
      return;
    }

    if (fsr.leftForceGrams === null && fsr.rightForceGrams === null) {
      return;
    }

    const elapsedMs = acquisitionStartedAt
      ? acquisitionElapsedBeforePauseMs + Math.max(lastFsrAt - acquisitionStartedAt, 0)
      : acquisitionElapsedBeforePauseMs;

    setSamples((current) => {
      if (current.at(-1)?.sequence === fsr.sequence) {
        return current;
      }

      return [
        ...current,
        {
          sequence: fsr.sequence,
          leftForceGrams: fsr.leftForceGrams,
          rightForceGrams: fsr.rightForceGrams,
          elapsedSeconds: elapsedMs / 1000
        }
      ].slice(-MAX_TEMPERATURE_SAMPLES);
    });
  }, [
    acquisitionElapsedBeforePauseMs,
    acquisitionStartedAt,
    acquisitionState,
    fsr.leftForceGrams,
    fsr.rightForceGrams,
    fsr.sequence,
    lastFsrAt
  ]);

  useEffect(() => {
    setSamples([]);
    setPanOffset(0);
  }, [acquisitionRunId]);

  useEffect(() => {
    if (panOffset !== visibleWindow.clampedPanOffset) {
      setPanOffset(visibleWindow.clampedPanOffset);
    }
  }, [panOffset, visibleWindow.clampedPanOffset]);

  return (
    <section className={`panel placeholder-panel temperature-panel fsr-panel ${isFullscreen ? 'panel-fullscreen' : ''}`}>
      <div className="panel-heading bordered">
        <h2>FSR Force</h2>
        <div className="panel-heading-actions">
          <div className="temperature-plot-controls" aria-label="FSR plot controls">
            <button type="button" onClick={() => scrollFsrChart('left')} disabled={!canScrollLeft}>
              {'<'}
            </button>
            <button type="button" onClick={() => zoomFsrChart('out')} disabled={!canZoomOut}>
              -
            </button>
            <button type="button" onClick={() => zoomFsrChart('in')} disabled={!canZoomIn}>
              +
            </button>
            <button type="button" onClick={() => scrollFsrChart('right')} disabled={!canScrollRight}>
              {'>'}
            </button>
            <button type="button" onClick={() => setPanOffset(0)} disabled={!canScrollRight}>
              Live
            </button>
          </div>
          <span className="panel-note">{isImported ? 'Imported' : isLive ? `${FSR_MIN_FORCE_GRAMS} g-10 kg` : 'Pending'}</span>
          <button className="panel-action-button" type="button" onClick={() => setIsFullscreen((value) => !value)}>
            {isFullscreen ? 'Exit' : 'Full'}
          </button>
        </div>
      </div>
      <div className="panel-subline temperature-legend temperature-legend-with-values fsr-legend-with-values">
        <span className="temperature-legend-item">
          <span><i className="line-key line-orange" />Left FSR</span>
          <strong className="temperature-readout-left">{formatForceGrams(displayLeftForceGrams)}</strong>
          {leftSteadyStatus && (
            <small className={`fsr-steady-inline left ${leftSteadyStatus.steady ? 'steady' : ''}`}>
              {leftSteadyStatus.label} {Math.min(leftSteadyStatus.seconds, FSR_STEADY_WINDOW_SECONDS).toFixed(1)}s
            </small>
          )}
        </span>
        <span className="temperature-legend-item">
          <span><i className="line-key line-blue" />Right FSR</span>
          <strong className="temperature-readout-right">{formatForceGrams(displayRightForceGrams)}</strong>
          {rightSteadyStatus && (
            <small className={`fsr-steady-inline right ${rightSteadyStatus.steady ? 'steady' : ''}`}>
              {rightSteadyStatus.label} {Math.min(rightSteadyStatus.seconds, FSR_STEADY_WINDOW_SECONDS).toFixed(1)}s
            </small>
          )}
        </span>
      </div>
      <div className="temperature-live-chart fsr-live-chart" onMouseMove={updateFsrHover} onMouseLeave={() => setHover(null)}>
        <svg
          viewBox={`0 0 ${TEMPERATURE_CHART_WIDTH} ${TEMPERATURE_CHART_HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Left and right FSR force history in grams"
        >
          <line className="temperature-grid-line" x1={TEMPERATURE_PLOT_LEFT} y1={TEMPERATURE_PLOT_TOP} x2={TEMPERATURE_PLOT_RIGHT} y2={TEMPERATURE_PLOT_TOP} />
          <line className="temperature-grid-line" x1={TEMPERATURE_PLOT_LEFT} y1={(TEMPERATURE_PLOT_TOP + TEMPERATURE_PLOT_BOTTOM) / 2} x2={TEMPERATURE_PLOT_RIGHT} y2={(TEMPERATURE_PLOT_TOP + TEMPERATURE_PLOT_BOTTOM) / 2} />
          <line className="temperature-grid-line" x1={TEMPERATURE_PLOT_LEFT} y1={TEMPERATURE_PLOT_BOTTOM} x2={TEMPERATURE_PLOT_RIGHT} y2={TEMPERATURE_PLOT_BOTTOM} />
          <line className="temperature-axis-line" x1={TEMPERATURE_PLOT_LEFT} y1={TEMPERATURE_PLOT_TOP} x2={TEMPERATURE_PLOT_LEFT} y2={TEMPERATURE_PLOT_BOTTOM} />
          <line className="temperature-axis-line" x1={TEMPERATURE_PLOT_LEFT} y1={TEMPERATURE_PLOT_BOTTOM} x2={TEMPERATURE_PLOT_RIGHT} y2={TEMPERATURE_PLOT_BOTTOM} />
          {hoveredSample ? (
            <line
              className="chart-hover-line"
              x1={hover?.x ?? 0}
              y1={TEMPERATURE_PLOT_TOP}
              x2={hover?.x ?? 0}
              y2={TEMPERATURE_PLOT_BOTTOM}
            />
          ) : null}
          {chart.leftPath ? <path className="fsr-left-line" d={chart.leftPath} /> : null}
          {chart.rightPath ? <path className="fsr-right-line" d={chart.rightPath} /> : null}
          {chart.leftLatestPoint ? <circle className="fsr-left-dot" cx={chart.leftLatestPoint.x} cy={chart.leftLatestPoint.y} r="1.8" /> : null}
          {chart.rightLatestPoint ? <circle className="fsr-right-dot" cx={chart.rightLatestPoint.x} cy={chart.rightLatestPoint.y} r="1.8" /> : null}
          {fsrHoverMarkers.map((marker) => (
            <circle
              className={`chart-hover-dot ${marker.className}`}
              cx={hover?.x ?? 0}
              cy={valueToChartY(marker.value, chart.min, chart.max)}
              key={marker.label}
              r="0.95"
            />
          ))}
        </svg>
        <div className="temperature-axis-overlay" aria-hidden="true">
          <span className="temperature-y-max">{formatForceGrams(chart.max)}</span>
          <span className="temperature-y-mid">{formatForceGrams(chart.mid)}</span>
          <span className="temperature-y-min">{formatForceGrams(chart.min)}</span>
          <span className="temperature-time-start">{formatElapsedSeconds(windowStartSeconds)}</span>
          <span className="temperature-time-end">{formatElapsedSeconds(windowEndSeconds)}</span>
        </div>
        {hoveredSample ? (
          <div className={`chart-hover-tooltip ${hover?.align === 'right' ? 'align-right' : ''}`} style={{ left: `${hover?.x ?? 0}%` }}>
            <strong>{formatElapsedSeconds(hoveredSample.elapsedSeconds)}</strong>
            {fsrHoverMarkers.map((marker) => (
              <span key={marker.label}>
                <i className={`line-key ${marker.className === 'fsr-left-dot' ? 'line-orange' : 'line-blue'}`} />
                {marker.label} {formatForceGrams(marker.value)}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
};

export const TemperaturePanel = (): JSX.Element => {
  const pcbTemp = useImuStore((state) => state.pcbTemp);
  const rtd = useImuStore((state) => state.rtd);
  const mlx90614 = useImuStore((state) => state.mlx90614);
  const lastPcbTempAt = useImuStore((state) => state.lastPcbTempAt);
  const lastRtdAt = useImuStore((state) => state.lastRtdAt);
  const lastMlx90614At = useImuStore((state) => state.lastMlx90614At);
  const acquisitionState = useImuStore((state) => state.acquisitionState);
  const acquisitionRunId = useImuStore((state) => state.acquisitionRunId);
  const acquisitionStartedAt = useImuStore((state) => state.acquisitionStartedAt);
  const acquisitionElapsedBeforePauseMs = useImuStore((state) => state.acquisitionElapsedBeforePauseMs);
  const importedTemperatureLogSamples = useImuStore((state) => state.importedTemperatureLogSamples);
  const [samples, setSamples] = useState<TemperatureSample[]>([]);
  const [visibleSampleCount, setVisibleSampleCount] = useState(DEFAULT_VISIBLE_TEMPERATURE_SAMPLES);
  const [panOffset, setPanOffset] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hover, setHover] = useState<ChartHoverState | null>(null);
  const importedSamples = useMemo<TemperatureSample[]>(
    () =>
      importedTemperatureLogSamples.map((sample) => ({
        sequence: sample.sequence,
        pcbTempC: sample.pcbTempC,
        leftTempC: sample.leftTempC,
        rightTempC: sample.rightTempC,
        irAmbientTempC: sample.irAmbientTempC,
        irObjectTempC: sample.irObjectTempC,
        elapsedSeconds: sample.elapsedSeconds
      })),
    [importedTemperatureLogSamples]
  );
  const plotSamples = importedSamples.length > 0 ? importedSamples : samples;
  const latestImportedSample = importedSamples.at(-1);
  const isImported = importedSamples.length > 0;
  const isPcbLive = Boolean(!isImported && lastPcbTempAt && Date.now() - lastPcbTempAt < 3000 && pcbTemp.present && pcbTemp.valid);
  const isRtdLive = Boolean(
    !isImported &&
    lastRtdAt &&
      Date.now() - lastRtdAt < 3000 &&
      ((rtd.leftPresent && rtd.leftValid) || (rtd.rightPresent && rtd.rightValid))
  );
  const isMlxLive = Boolean(
    !isImported &&
    lastMlx90614At &&
      Date.now() - lastMlx90614At < 3000 &&
      mlx90614.present &&
      (mlx90614.ambientValid || mlx90614.objectValid)
  );
  const isLive = isPcbLive || isRtdLive || isMlxLive;
  const displayLeftTempC =
    isImported
      ? latestImportedSample?.leftTempC ?? null
      : rtd.leftPresent && rtd.leftValid
        ? rtd.leftTempC
        : null;
  const displayRightTempC =
    isImported
      ? latestImportedSample?.rightTempC ?? null
      : rtd.rightPresent && rtd.rightValid
        ? rtd.rightTempC
        : null;
  const displayPcbTempC =
    isImported ? latestImportedSample?.pcbTempC ?? null : pcbTemp.present && pcbTemp.valid ? pcbTemp.tempC : null;
  const displayAmbientTempC =
    isImported
      ? latestImportedSample?.irAmbientTempC ?? null
      : mlx90614.present && mlx90614.ambientValid
        ? mlx90614.ambientTempC
        : null;
  const displayObjectTempC =
    isImported
      ? latestImportedSample?.irObjectTempC ?? null
      : mlx90614.present && mlx90614.objectValid
        ? mlx90614.objectTempC
        : null;
  const visibleWindow = useMemo(() => {
    const clampedVisibleCount = clamp(visibleSampleCount, MIN_VISIBLE_TEMPERATURE_SAMPLES, MAX_VISIBLE_TEMPERATURE_SAMPLES);
    const maxOffset = Math.max(plotSamples.length - Math.min(clampedVisibleCount, plotSamples.length), 0);
    const clampedPanOffset = clamp(panOffset, 0, maxOffset);
    const end = Math.max(0, plotSamples.length - clampedPanOffset);
    const start = Math.max(0, end - clampedVisibleCount);

    return {
      samples: plotSamples.slice(start, end),
      maxOffset,
      clampedPanOffset
    };
  }, [panOffset, plotSamples, visibleSampleCount]);
  const chart = useMemo(() => buildTemperaturePath(visibleWindow.samples), [visibleWindow.samples]);
  const scrollStep = Math.max(1, Math.round(visibleSampleCount * 0.35));
  const canScrollLeft = visibleWindow.clampedPanOffset < visibleWindow.maxOffset;
  const canScrollRight = visibleWindow.clampedPanOffset > 0;
  const canZoomIn = visibleSampleCount > MIN_VISIBLE_TEMPERATURE_SAMPLES;
  const canZoomOut = visibleSampleCount < Math.min(MAX_VISIBLE_TEMPERATURE_SAMPLES, MAX_TEMPERATURE_SAMPLES);
  const windowStartSeconds = visibleWindow.samples.at(0)?.elapsedSeconds;
  const windowEndSeconds = visibleWindow.samples.at(-1)?.elapsedSeconds;
  const hoveredSample = hover ? visibleWindow.samples[hover.index] : null;
  const temperatureHoverMarkers = hoveredSample
    ? [
        { label: 'Left Finger', value: hoveredSample.leftTempC, className: 'temperature-point-left', lineClassName: 'line-orange' },
        { label: 'Right Finger', value: hoveredSample.rightTempC, className: 'temperature-point-right', lineClassName: 'line-blue' },
        { label: 'PCB', value: hoveredSample.pcbTempC, className: 'temperature-point-pcb', lineClassName: 'line-green' },
        { label: 'Ambient', value: hoveredSample.irAmbientTempC, className: 'temperature-point-ir-ambient', lineClassName: 'line-purple' },
        { label: 'Object', value: hoveredSample.irObjectTempC, className: 'temperature-point-ir-object', lineClassName: 'line-red' }
      ].filter(
        (marker): marker is { label: string; value: number; className: string; lineClassName: string } => marker.value !== null
      )
    : [];

  const zoomTemperatureChart = (direction: 'in' | 'out'): void => {
    setVisibleSampleCount((current) => {
      const next =
        direction === 'in'
          ? Math.round(current / 1.5)
          : Math.round(current * 1.5);
      return clamp(next, MIN_VISIBLE_TEMPERATURE_SAMPLES, MAX_VISIBLE_TEMPERATURE_SAMPLES);
    });
  };

  const scrollTemperatureChart = (direction: 'left' | 'right'): void => {
    setPanOffset((current) => {
      const next = direction === 'left' ? current + scrollStep : current - scrollStep;
      return clamp(next, 0, visibleWindow.maxOffset);
    });
  };

  const updateTemperatureHover = (event: MouseEvent<HTMLDivElement>): void => {
    setHover(getChartHoverState(event, visibleWindow.samples.length));
  };

  useEffect(() => {
    if (!isFullscreen) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setIsFullscreen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen]);

  useEffect(() => {
    const latestAt = Math.max(lastPcbTempAt ?? 0, lastRtdAt ?? 0, lastMlx90614At ?? 0);

    if (!latestAt) {
      setSamples([]);
      return;
    }

    if (acquisitionState !== 'running') {
      return;
    }

    if (acquisitionStartedAt && latestAt < acquisitionStartedAt) {
      return;
    }

    const leftTempC = rtd.leftPresent && rtd.leftValid ? rtd.leftTempC : null;
    const rightTempC = rtd.rightPresent && rtd.rightValid ? rtd.rightTempC : null;
    const pcbTempC = pcbTemp.present && pcbTemp.valid ? pcbTemp.tempC : null;
    const irAmbientTempC = mlx90614.present && mlx90614.ambientValid ? mlx90614.ambientTempC : null;
    const irObjectTempC = mlx90614.present && mlx90614.objectValid ? mlx90614.objectTempC : null;

    if (pcbTempC === null && leftTempC === null && rightTempC === null && irAmbientTempC === null && irObjectTempC === null) {
      return;
    }

    const elapsedMs = acquisitionStartedAt
      ? acquisitionElapsedBeforePauseMs + Math.max(latestAt - acquisitionStartedAt, 0)
      : acquisitionElapsedBeforePauseMs;

    setSamples((current) => {
      const sequence = latestAt;
      if (current.at(-1)?.sequence === sequence) {
        return current;
      }

      return [
        ...current,
        {
          sequence,
          pcbTempC,
          leftTempC,
          rightTempC,
          irAmbientTempC,
          irObjectTempC,
          elapsedSeconds: elapsedMs / 1000
        }
      ].slice(-MAX_TEMPERATURE_SAMPLES);
    });
  }, [
    acquisitionElapsedBeforePauseMs,
    acquisitionStartedAt,
    acquisitionState,
    lastMlx90614At,
    lastPcbTempAt,
    lastRtdAt,
    mlx90614.ambientTempC,
    mlx90614.ambientValid,
    mlx90614.objectTempC,
    mlx90614.objectValid,
    mlx90614.present,
    mlx90614.sequence,
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

  useEffect(() => {
    setSamples([]);
    setPanOffset(0);
  }, [acquisitionRunId]);

  useEffect(() => {
    if (panOffset !== visibleWindow.clampedPanOffset) {
      setPanOffset(visibleWindow.clampedPanOffset);
    }
  }, [panOffset, visibleWindow.clampedPanOffset]);

  return (
    <section className={`panel placeholder-panel temperature-panel ${isFullscreen ? 'panel-fullscreen' : ''}`}>
      <div className="panel-heading bordered">
        <h2>Temperature</h2>
        <div className="panel-heading-actions">
          <div className="temperature-plot-controls" aria-label="Temperature plot controls">
            <button type="button" onClick={() => scrollTemperatureChart('left')} disabled={!canScrollLeft}>
              {'<'}
            </button>
            <button type="button" onClick={() => zoomTemperatureChart('out')} disabled={!canZoomOut}>
              -
            </button>
            <button type="button" onClick={() => zoomTemperatureChart('in')} disabled={!canZoomIn}>
              +
            </button>
            <button type="button" onClick={() => scrollTemperatureChart('right')} disabled={!canScrollRight}>
              {'>'}
            </button>
            <button type="button" onClick={() => setPanOffset(0)} disabled={!canScrollRight}>
              Live
            </button>
          </div>
          <span className="panel-note">{isImported ? 'Imported' : isLive ? 'Live' : 'Pending'}</span>
          <button className="panel-action-button" type="button" onClick={() => setIsFullscreen((value) => !value)}>
            {isFullscreen ? 'Exit' : 'Full'}
          </button>
        </div>
      </div>
      <div className="panel-subline temperature-legend temperature-legend-with-values">
        <span className="temperature-legend-item">
          <span><i className="line-key line-orange" />Left Finger</span>
          <strong className="temperature-readout-left">{displayLeftTempC === null ? '-- C' : `${displayLeftTempC.toFixed(1)} C`}</strong>
        </span>
        <span className="temperature-legend-item">
          <span><i className="line-key line-blue" />Right Finger</span>
          <strong className="temperature-readout-right">{displayRightTempC === null ? '-- C' : `${displayRightTempC.toFixed(1)} C`}</strong>
        </span>
        <span className="temperature-legend-item">
          <span><i className="line-key line-green" />PCB</span>
          <strong className="temperature-readout-pcb">{displayPcbTempC === null ? '-- C' : `${displayPcbTempC.toFixed(1)} C`}</strong>
        </span>
        <span className="temperature-legend-item">
          <span><i className="line-key line-purple" />Ambient</span>
          <strong className="temperature-readout-ir-ambient">{displayAmbientTempC === null ? '-- C' : `${displayAmbientTempC.toFixed(1)} C`}</strong>
        </span>
        <span className="temperature-legend-item">
          <span><i className="line-key line-red" />Object</span>
          <strong className="temperature-readout-ir-object">{displayObjectTempC === null ? '-- C' : `${displayObjectTempC.toFixed(1)} C`}</strong>
        </span>
      </div>
      <div className="temperature-live-chart" onMouseMove={updateTemperatureHover} onMouseLeave={() => setHover(null)}>
        <svg
          viewBox={`0 0 ${TEMPERATURE_CHART_WIDTH} ${TEMPERATURE_CHART_HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Finger and PCB temperature history"
        >
          <line className="temperature-grid-line" x1={TEMPERATURE_PLOT_LEFT} y1={TEMPERATURE_PLOT_TOP} x2={TEMPERATURE_PLOT_RIGHT} y2={TEMPERATURE_PLOT_TOP} />
          <line className="temperature-grid-line" x1={TEMPERATURE_PLOT_LEFT} y1={(TEMPERATURE_PLOT_TOP + TEMPERATURE_PLOT_BOTTOM) / 2} x2={TEMPERATURE_PLOT_RIGHT} y2={(TEMPERATURE_PLOT_TOP + TEMPERATURE_PLOT_BOTTOM) / 2} />
          <line className="temperature-grid-line" x1={TEMPERATURE_PLOT_LEFT} y1={TEMPERATURE_PLOT_BOTTOM} x2={TEMPERATURE_PLOT_RIGHT} y2={TEMPERATURE_PLOT_BOTTOM} />
          <line className="temperature-axis-line" x1={TEMPERATURE_PLOT_LEFT} y1={TEMPERATURE_PLOT_TOP} x2={TEMPERATURE_PLOT_LEFT} y2={TEMPERATURE_PLOT_BOTTOM} />
          <line className="temperature-axis-line" x1={TEMPERATURE_PLOT_LEFT} y1={TEMPERATURE_PLOT_BOTTOM} x2={TEMPERATURE_PLOT_RIGHT} y2={TEMPERATURE_PLOT_BOTTOM} />
          {hoveredSample ? (
            <line
              className="chart-hover-line"
              x1={hover?.x ?? 0}
              y1={TEMPERATURE_PLOT_TOP}
              x2={hover?.x ?? 0}
              y2={TEMPERATURE_PLOT_BOTTOM}
            />
          ) : null}
          {chart.leftPath ? <path className="temperature-line-left" d={chart.leftPath} /> : null}
          {chart.rightPath ? <path className="temperature-line-right" d={chart.rightPath} /> : null}
          {chart.pcbPath ? <path className="temperature-line-pcb" d={chart.pcbPath} /> : null}
          {chart.irAmbientPath ? <path className="temperature-line-ir-ambient" d={chart.irAmbientPath} /> : null}
          {chart.irObjectPath ? <path className="temperature-line-ir-object" d={chart.irObjectPath} /> : null}
          {chart.leftLatestPoint ? <circle className="temperature-point-left" cx={chart.leftLatestPoint.x} cy={chart.leftLatestPoint.y} r="1.8" /> : null}
          {chart.rightLatestPoint ? <circle className="temperature-point-right" cx={chart.rightLatestPoint.x} cy={chart.rightLatestPoint.y} r="1.8" /> : null}
          {chart.pcbLatestPoint ? <circle className="temperature-point-pcb" cx={chart.pcbLatestPoint.x} cy={chart.pcbLatestPoint.y} r="1.8" /> : null}
          {chart.irAmbientLatestPoint ? (
            <circle className="temperature-point-ir-ambient" cx={chart.irAmbientLatestPoint.x} cy={chart.irAmbientLatestPoint.y} r="1.8" />
          ) : null}
          {chart.irObjectLatestPoint ? (
            <circle className="temperature-point-ir-object" cx={chart.irObjectLatestPoint.x} cy={chart.irObjectLatestPoint.y} r="1.8" />
          ) : null}
          {temperatureHoverMarkers.map((marker) => (
            <circle
              className={`chart-hover-dot ${marker.className}`}
              cx={hover?.x ?? 0}
              cy={valueToChartY(marker.value, chart.min, chart.max)}
              key={marker.label}
              r="0.95"
            />
          ))}
        </svg>
        <div className="temperature-axis-overlay" aria-hidden="true">
          <span className="temperature-y-max">{visibleWindow.samples.length > 0 ? `${chart.max.toFixed(1)} C` : '-- C'}</span>
          <span className="temperature-y-mid">{visibleWindow.samples.length > 0 ? `${chart.mid.toFixed(1)} C` : '-- C'}</span>
          <span className="temperature-y-min">{visibleWindow.samples.length > 0 ? `${chart.min.toFixed(1)} C` : '-- C'}</span>
          <span className="temperature-time-start">{formatElapsedSeconds(windowStartSeconds)}</span>
          <span className="temperature-time-end">{formatElapsedSeconds(windowEndSeconds)}</span>
        </div>
        {hoveredSample ? (
          <div className={`chart-hover-tooltip ${hover?.align === 'right' ? 'align-right' : ''}`} style={{ left: `${hover?.x ?? 0}%` }}>
            <strong>{formatElapsedSeconds(hoveredSample.elapsedSeconds)}</strong>
            {temperatureHoverMarkers.map((marker) => (
              <span key={marker.label}>
                <i className={`line-key ${marker.lineClassName}`} />
                {marker.label} {marker.value.toFixed(1)} C
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
};

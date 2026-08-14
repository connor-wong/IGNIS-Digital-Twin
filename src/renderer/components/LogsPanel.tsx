import { useEffect, useRef } from 'react';
import { useImuStore } from '../store/imuStore';

const formatTime = (timestamp: string): string =>
  new Intl.DateTimeFormat(undefined, {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(timestamp));

export const LogsPanel = (): JSX.Element => {
  const logs = useImuStore((state) => state.logs);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [logs]);

  return (
    <section className="panel logs-panel">
      <div className="panel-heading bordered">
        <h2>Event Log</h2>
        <span className="log-count">{logs.length}</span>
      </div>

      <div className="log-list" ref={listRef}>
        {logs.length === 0 ? (
          <p className="empty-state">Serial events will appear here.</p>
        ) : (
          logs.map((log) => (
            <article className={`log-entry log-${log.level}`} key={log.id}>
              <time>{formatTime(log.timestamp)}</time>
              <span>[{log.level}]</span>
              <p>{log.message}</p>
            </article>
          ))
        )}
      </div>
    </section>
  );
};

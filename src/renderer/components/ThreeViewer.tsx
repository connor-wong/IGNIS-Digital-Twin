import { OrbitControls, PerspectiveCamera } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { useEffect, useState } from 'react';
import { DeviceModel } from './DeviceModel';
import { useTheme } from '../hooks/useTheme';
import { useImuStore } from '../store/imuStore';

export const ThreeViewer = (): JSX.Element => {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const { theme } = useTheme();
  const acquisitionState = useImuStore((state) => state.acquisitionState);
  const isLive = acquisitionState === 'running';

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

  return (
    <section className={`panel viewer-panel ${isFullscreen ? 'panel-fullscreen' : ''}`}>
      <div className="panel-heading viewer-heading">
        <h2>
          Digital Twin
          {isLive ? <span className="viewer-live-badge">Live</span> : null}
        </h2>
        <button className="panel-action-button" type="button" onClick={() => setIsFullscreen((value) => !value)}>
          {isFullscreen ? 'Exit' : 'Full Screen'}
        </button>
      </div>

      <div className="viewer-shell">
        <Canvas shadows dpr={[1, 2]} gl={{ antialias: true }} camera={{ position: [4, 3, 5], fov: 42 }}>
          <color attach="background" args={[theme === 'dark' ? '#111827' : '#fbfbfa']} />
          <PerspectiveCamera makeDefault position={[4, 3, 5]} fov={42} />
          <ambientLight intensity={0.85} />
          <directionalLight position={[5, 7, 4]} intensity={1.2} castShadow shadow-mapSize={[2048, 2048]} />
          <gridHelper
            args={[7, 14, theme === 'dark' ? '#475569' : '#d4d4d8', theme === 'dark' ? '#253247' : '#eceff3']}
            position={[0, -1, 0]}
          />
          <DeviceModel />
          <OrbitControls enableDamping enablePan={true} enableZoom={true} dampingFactor={0.08} target={[0, 0, 0]} />
        </Canvas>
      </div>
    </section>
  );
};

import { Box, Edges } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import * as THREE from 'three';
import { useImuStore } from '../store/imuStore';

const LERP_ALPHA = 0.16;

export const DeviceCube = (): JSX.Element => {
  const groupRef = useRef<THREE.Group>(null);

  useFrame(() => {
    if (!groupRef.current) {
      return;
    }

    const { roll, pitch, yaw } = useImuStore.getState().imu;

    const targetX = THREE.MathUtils.degToRad(pitch);
    const targetY = THREE.MathUtils.degToRad(yaw);
    const targetZ = THREE.MathUtils.degToRad(roll);

    groupRef.current.rotation.x = THREE.MathUtils.lerp(groupRef.current.rotation.x, targetX, LERP_ALPHA);
    groupRef.current.rotation.y = THREE.MathUtils.lerp(groupRef.current.rotation.y, targetY, LERP_ALPHA);
    groupRef.current.rotation.z = THREE.MathUtils.lerp(groupRef.current.rotation.z, targetZ, LERP_ALPHA);
  });

  return (
    <group ref={groupRef}>
      <Box args={[1.35, 1.35, 1.35]} castShadow receiveShadow>
        <meshStandardMaterial color="#f8fafc" metalness={0.05} roughness={0.38} />
        <Edges color="#111111" />
      </Box>

      <group position={[0, 1, 0]}>
        <mesh rotation={[Math.PI / 1, 0, 0]} position={[0, 0, 0]} castShadow>
          <cylinderGeometry args={[0.035, 0.035, 0.5, 24]} />
          <meshStandardMaterial color="#111111" />
        </mesh>
        {/* <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, 0.78]} castShadow>
          <coneGeometry args={[0.13, 0.28, 32]} />
          <meshStandardMaterial color="#111111" />
        </mesh> */}
      </group>
    </group>
  );
};

import { useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import * as THREE from 'three';
import { useImuStore } from '../store/imuStore';

const LERP_ALPHA = 0.16;
const MODEL_SCALE = 12;
const MODEL_POSITION: [number, number, number] = [0, 1.5, 0];
const MODEL_BASE_ROTATION: [number, number, number] = [0, 0, 0];
const JIG_MIN_MODEL_Y = 0.5;
const JIG_MAX_MODEL_Y = 2.5;
const JIG_MAX_TRAVEL_SPEED = 0.36;

export const DeviceModel = (): JSX.Element => {
  const modelRef = useRef<THREE.Group>(null);
  const { scene } = useGLTF('/models/Final_Gripper_Model.glb');

  useFrame((_, delta) => {
    if (!modelRef.current) return;

    const state = useImuStore.getState();
    const { roll, pitch, yaw } = state.imu;

    modelRef.current.rotation.x = THREE.MathUtils.lerp(
      modelRef.current.rotation.x,
      THREE.MathUtils.degToRad(pitch),
      LERP_ALPHA
    );
    modelRef.current.rotation.y = THREE.MathUtils.lerp(
      modelRef.current.rotation.y,
      THREE.MathUtils.degToRad(yaw),
      LERP_ALPHA
    );
    modelRef.current.rotation.z = THREE.MathUtils.lerp(
      modelRef.current.rotation.z,
      THREE.MathUtils.degToRad(roll),
      LERP_ALPHA
    );

    const jigConnected = state.deviceConnections.testJig.status === 'connected';
    const direction = !jigConnected || state.testJigMotion === 'stopped' ? 0 : state.testJigMotion === 'up' ? 1 : -1;
    const speedTarget = state.testJigMotion === 'down' ? state.testJigDownSpeedTarget : state.testJigUpSpeedTarget;
    const normalizedSpeed = THREE.MathUtils.clamp(speedTarget / 255, 0, 1);
    const nextY = modelRef.current.position.y + direction * normalizedSpeed * JIG_MAX_TRAVEL_SPEED * delta;
    modelRef.current.position.y = THREE.MathUtils.clamp(nextY, JIG_MIN_MODEL_Y, JIG_MAX_MODEL_Y);
  });

  return (
    <group ref={modelRef} position={MODEL_POSITION} scale={MODEL_SCALE}>
      <primitive object={scene} rotation={MODEL_BASE_ROTATION} />
    </group>
  );
};

useGLTF.preload('/models/model.glb');

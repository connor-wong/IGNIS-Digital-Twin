import type { BleApi, FileApi, SerialApi } from './imu';

declare global {
  interface Window {
    serialApi: SerialApi;
    bleApi: BleApi;
    fileApi: FileApi;
  }
}

export {};

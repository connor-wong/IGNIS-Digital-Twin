import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { SerialManager } from './serialManager';
import { registerSerialIpc } from './ipc';
import type { DeviceRole } from '../renderer/types/imu';

let mainWindow: BrowserWindow | null = null;
const serialManagers: Record<DeviceRole, SerialManager> = {
  gripper: new SerialManager(),
  testJig: new SerialManager()
};
let pendingBluetoothSelection: ((deviceId: string) => void) | null = null;
const BLE_DEVICE_NAME_FILTER = 'IGNIS';

app.commandLine.appendSwitch('enable-experimental-web-platform-features');

const getAppIconPath = (): string => {
  const developmentIconPath = join(process.cwd(), 'public/image/ignis_logo.png');
  const productionIconPath = join(__dirname, '../renderer/image/ignis_logo.png');
  return existsSync(developmentIconPath) ? developmentIconPath : productionIconPath;
};

const configureBluetoothPermissions = (): void => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const permissionName = String(permission);
    callback(permissionName === 'bluetooth' || permissionName === 'bluetoothScanning');
  });
};

const registerBluetoothIpc = (): void => {
  ipcMain.handle('ble:select-device', (_event, deviceId: string) => {
    if (!pendingBluetoothSelection) {
      return false;
    }

    pendingBluetoothSelection(deviceId);
    pendingBluetoothSelection = null;
    BrowserWindow.getAllWindows().forEach((window) => window.webContents.send('ble:devices', []));
    return true;
  });

  ipcMain.handle('ble:cancel-selection', () => {
    if (!pendingBluetoothSelection) {
      return false;
    }

    pendingBluetoothSelection('');
    pendingBluetoothSelection = null;
    BrowserWindow.getAllWindows().forEach((window) => window.webContents.send('ble:devices', []));
    return true;
  });
};

const registerFileIpc = (): void => {
  ipcMain.handle('file:select-export-folder', async () => {
    const options: Electron.OpenDialogOptions = {
      title: 'Select data log export folder',
      properties: ['openDirectory', 'createDirectory']
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);

    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('file:write-export-file', async (_event, folderPath: string, fileName: string, bytes: Uint8Array) => {
    const safeFileName = basename(fileName).replace(/[<>:"/\\|?*]+/g, '_');
    const targetPath = join(folderPath, safeFileName);
    await writeFile(targetPath, Buffer.from(bytes));
    return targetPath;
  });
};

const configureBluetoothSelection = (window: BrowserWindow): void => {
  window.webContents.on('select-bluetooth-device', (event, deviceList, callback) => {
    event.preventDefault();

    pendingBluetoothSelection = callback;
    const matchingDevices = deviceList.filter((device) =>
      device.deviceName.toUpperCase().includes(BLE_DEVICE_NAME_FILTER)
    );

    window.webContents.send(
      'ble:devices',
      matchingDevices.map((device) => ({
        id: device.deviceId,
        name: device.deviceName || 'Unnamed BLE device'
      }))
    );
  });
};

const createWindow = (): void => {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1040,
    minHeight: 720,
    backgroundColor: '#0f172a',
    icon: getAppIconPath(),
    show: false,
    title: 'ESP32 IMU Digital Twin',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  configureBluetoothSelection(mainWindow);

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

app.whenReady().then(() => {
  registerSerialIpc(serialManagers);
  registerBluetoothIpc();
  registerFileIpc();
  configureBluetoothPermissions();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  for (const serialManager of Object.values(serialManagers)) {
    serialManager.destroy();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

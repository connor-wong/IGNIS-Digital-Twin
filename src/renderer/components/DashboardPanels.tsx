import { OrbitControls, PerspectiveCamera } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import * as THREE from 'three';
import { bleImuClient } from '../services/bleImuClient';
import { useImuStore } from '../store/imuStore';
import type { SensorKey, TemperatureLogSample } from '../types/imu';

const format = (value: number, digits = 1): string => value.toFixed(digits);

const formatDuration = (seconds: number): string => {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
};

const TOF_GRID_SIZE = 8;
const VALID_TOF_STATUS = 5;
const VL53L5CX_HORIZONTAL_FOV_DEG = 45;
const VL53L5CX_VERTICAL_FOV_DEG = 45;
const OBJECT_SHAPE_DEPTH_RANGE_MM = 2200;
const OBJECT_SHAPE_SCALE = 0.0012;
const SENSOR_FRESHNESS_MS = 3000;

const formatOptional = (value: number | null, unit: string, digits = 0): string =>
  value === null ? `-- ${unit}` : `${value.toFixed(digits)} ${unit}`;

const escapeExcelCell = (value: string | number | boolean): string =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const sanitizeFilenameSegment = (value: string, fallback: string): string => {
  const cleaned = value
    .trim()
    .replace(/[<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ');

  return cleaned || fallback;
};

const formatFilenameNumber = (value: number, digits = 2): string =>
  Number.isInteger(value) ? value.toString() : value.toFixed(digits).replace(/0+$/g, '').replace(/\.$/g, '');

export interface TemperatureLogFileMetadata {
  objectType: string;
  loadWeightKg: number | null;
  gripperSpeedTarget: number;
  testNumber: number;
}

export const buildTemperatureLogFileName = (metadata: TemperatureLogFileMetadata, fallbackTimestamp: string): string => {
  const objectType = sanitizeFilenameSegment(metadata.objectType, 'object');
  const loadWeight = formatFilenameNumber(metadata.loadWeightKg ?? 0);
  const speed = Math.trunc(metadata.gripperSpeedTarget);
  const testNumber = Math.max(1, Math.trunc(metadata.testNumber) || 1);

  return metadata.objectType.trim() || metadata.loadWeightKg !== null
    ? `ignis_${objectType}_${loadWeight}kg_${speed}_speed_test_${testNumber}.xlsx`
    : `ignis_log_${fallbackTimestamp}.xlsx`;
};

const downloadWorkbookInBrowser = (blob: Blob, fileName: string): void => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

export const saveTemperatureLogWorkbook = async (
  samples: TemperatureLogSample[],
  fileName: string,
  exportFolderPath: string | null
): Promise<string> => {
  const blob = buildTemperatureLogWorkbook(samples);

  if (exportFolderPath && window.fileApi) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return window.fileApi.writeExportFile(exportFolderPath, fileName, bytes);
  }

  downloadWorkbookInBrowser(blob, fileName);
  return fileName;
};

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const crcTable = new Uint32Array(256);
for (let i = 0; i < crcTable.length; i += 1) {
  let value = i;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[i] = value >>> 0;
}

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const writeUint16 = (target: number[], value: number): void => {
  target.push(value & 0xff, (value >>> 8) & 0xff);
};

const writeUint32 = (target: number[], value: number): void => {
  target.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
};

const zipDosTime = (date: Date): number =>
  (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);

const zipDosDate = (date: Date): number =>
  ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();

const createZipBlob = (files: Array<{ path: string; content: string }>): Blob => {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  const now = new Date();
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.path);
    const contentBytes = encoder.encode(file.content);
    const checksum = crc32(contentBytes);
    const localHeader: number[] = [];

    writeUint32(localHeader, 0x04034b50);
    writeUint16(localHeader, 20);
    writeUint16(localHeader, 0x0800);
    writeUint16(localHeader, 0);
    writeUint16(localHeader, zipDosTime(now));
    writeUint16(localHeader, zipDosDate(now));
    writeUint32(localHeader, checksum);
    writeUint32(localHeader, contentBytes.length);
    writeUint32(localHeader, contentBytes.length);
    writeUint16(localHeader, nameBytes.length);
    writeUint16(localHeader, 0);

    localParts.push(new Uint8Array([...localHeader, ...nameBytes]), contentBytes);

    const centralHeader: number[] = [];
    writeUint32(centralHeader, 0x02014b50);
    writeUint16(centralHeader, 20);
    writeUint16(centralHeader, 20);
    writeUint16(centralHeader, 0x0800);
    writeUint16(centralHeader, 0);
    writeUint16(centralHeader, zipDosTime(now));
    writeUint16(centralHeader, zipDosDate(now));
    writeUint32(centralHeader, checksum);
    writeUint32(centralHeader, contentBytes.length);
    writeUint32(centralHeader, contentBytes.length);
    writeUint16(centralHeader, nameBytes.length);
    writeUint16(centralHeader, 0);
    writeUint16(centralHeader, 0);
    writeUint16(centralHeader, 0);
    writeUint16(centralHeader, 0);
    writeUint32(centralHeader, 0);
    writeUint32(centralHeader, offset);

    centralParts.push(new Uint8Array([...centralHeader, ...nameBytes]));
    offset += localHeader.length + nameBytes.length + contentBytes.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const endHeader: number[] = [];
  writeUint32(endHeader, 0x06054b50);
  writeUint16(endHeader, 0);
  writeUint16(endHeader, 0);
  writeUint16(endHeader, files.length);
  writeUint16(endHeader, files.length);
  writeUint32(endHeader, centralSize);
  writeUint32(endHeader, offset);
  writeUint16(endHeader, 0);

  const zipParts = [...localParts, ...centralParts, new Uint8Array(endHeader)];
  const zipBuffer = new ArrayBuffer(zipParts.reduce((total, part) => total + part.length, 0));
  const zipBytes = new Uint8Array(zipBuffer);
  let writeOffset = 0;

  for (const part of zipParts) {
    zipBytes.set(part, writeOffset);
    writeOffset += part.length;
  }

  return new Blob([zipBuffer], { type: XLSX_MIME });
};

const columnName = (column: number): string => {
  let name = '';
  let value = column;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
};

const cellRef = (row: number, column: number): string => `${columnName(column)}${row}`;

const buildCellXml = (row: number, column: number, value: string | number | null): string => {
  if (value === null || value === '') {
    return '';
  }

  const ref = cellRef(row, column);
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}" s="2"><v>${value}</v></c>`;
  }

  return `<c r="${ref}" t="inlineStr" s="${row === TEMPERATURE_LOG_HEADER_ROW ? 1 : 0}"><is><t>${escapeExcelCell(
    value
  )}</t></is></c>`;
};

const TEMPERATURE_LOG_HEADER_ROW = 21;
const IMPORTED_LOG_TRANSPORT = 'serial';
const IMPORTED_LOG_STATUS = 'disconnected';

const parseOptionalNumber = (value: string | undefined): number | null => {
  if (value === undefined || value.trim() === '') {
    return null;
  }

  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeHeader = (header: string): string => header.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');

const buildImportedSamples = (rows: string[][]): TemperatureLogSample[] => {
  if (rows.length < 2) {
    return [];
  }

  const headerIndex = rows.findIndex((row) => row.some((cell) => normalizeHeader(cell) === 'timestamp'));
  if (headerIndex < 0) {
    return [];
  }

  const headerMap = new Map(rows[headerIndex].map((header, index) => [normalizeHeader(header), index]));
  const read = (row: string[], ...headers: string[]): string | undefined => {
    for (const header of headers) {
      const index = headerMap.get(normalizeHeader(header));
      if (index !== undefined) {
        return row[index];
      }
    }

    return undefined;
  };

  return rows
    .slice(headerIndex + 1)
    .map((row, index): TemperatureLogSample | null => {
      const elapsedSeconds = parseOptionalNumber(read(row, 'Timestamp', 'Elapsed Seconds'));
      if (elapsedSeconds === null) {
        return null;
      }

      const timestampMs = Math.round(elapsedSeconds * 1000);
      return {
        index: index + 1,
        sequence: index + 1,
        timestampIso: new Date(timestampMs).toISOString(),
        timestampMs,
        elapsedSeconds,
        pcbTempC: parseOptionalNumber(read(row, 'PCB Temp C')),
        leftTempC: parseOptionalNumber(read(row, 'Left Temp C')),
        rightTempC: parseOptionalNumber(read(row, 'Right Temp C')),
        irAmbientTempC: parseOptionalNumber(read(row, 'IR Ambient Temp C')),
        irObjectTempC: parseOptionalNumber(read(row, 'IR Object Temp C')),
        leftForceGrams: parseOptionalNumber(read(row, 'Left Force g')),
        rightForceGrams: parseOptionalNumber(read(row, 'Right Force g')),
        encoderTicks: parseOptionalNumber(read(row, 'Encoder Ticks')),
        encoderAngleDeg: parseOptionalNumber(read(row, 'Encoder Angle deg')),
        encoderVelocityRpm: parseOptionalNumber(read(row, 'Encoder Velocity rpm')),
        transport: IMPORTED_LOG_TRANSPORT,
        connectionStatus: IMPORTED_LOG_STATUS
      };
    })
    .filter((sample): sample is TemperatureLogSample => sample !== null);
};

const parseCsvRows = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (char === '"' && quoted && nextChar === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && nextChar === '\n') {
        index += 1;
      }
      row.push(cell);
      if (row.some((value) => value.trim() !== '')) {
        rows.push(row);
      }
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some((value) => value.trim() !== '')) {
    rows.push(row);
  }

  return rows;
};

const columnIndexFromRef = (ref: string): number => {
  const letters = ref.match(/[A-Z]+/i)?.[0].toUpperCase() ?? '';
  return letters.split('').reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1;
};

const extractStoredZipFile = (buffer: ArrayBuffer, filePath: string): string | null => {
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder();
  let offset = 0;

  while (offset + 30 <= bytes.length) {
    const signature = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
    if (signature !== 0x04034b50) {
      offset += 1;
      continue;
    }

    const compressionMethod = bytes[offset + 8] | (bytes[offset + 9] << 8);
    const compressedSize =
      bytes[offset + 18] | (bytes[offset + 19] << 8) | (bytes[offset + 20] << 16) | (bytes[offset + 21] << 24);
    const nameLength = bytes[offset + 26] | (bytes[offset + 27] << 8);
    const extraLength = bytes[offset + 28] | (bytes[offset + 29] << 8);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));

    if (name === filePath) {
      if (compressionMethod !== 0) {
        throw new Error('Compressed XLSX imports are not supported yet. Export from this app or import CSV.');
      }

      return decoder.decode(bytes.slice(dataStart, dataStart + compressedSize));
    }

    offset = dataStart + compressedSize;
  }

  return null;
};

const parseXlsxRows = async (file: File): Promise<string[][]> => {
  const sheetXml = extractStoredZipFile(await file.arrayBuffer(), 'xl/worksheets/sheet1.xml');
  if (!sheetXml) {
    throw new Error('Could not find worksheet data in the XLSX file.');
  }

  const documentXml = new DOMParser().parseFromString(sheetXml, 'application/xml');
  const rows = Array.from(documentXml.getElementsByTagName('row'));
  return rows.map((rowElement) => {
    const row: string[] = [];
    Array.from(rowElement.getElementsByTagName('c')).forEach((cellElement) => {
      const ref = cellElement.getAttribute('r') ?? '';
      const columnIndex = columnIndexFromRef(ref);
      const inlineText = cellElement.getElementsByTagName('t')[0]?.textContent;
      const valueText = cellElement.getElementsByTagName('v')[0]?.textContent;
      row[columnIndex] = inlineText ?? valueText ?? '';
    });

    return row.map((value) => value ?? '');
  });
};

const parseImportedLogFile = async (file: File): Promise<TemperatureLogSample[]> => {
  const rows = file.name.toLowerCase().endsWith('.xlsx')
    ? await parseXlsxRows(file)
    : parseCsvRows(await file.text());
  return buildImportedSamples(rows);
};

const buildTemperatureLogWorkbook = (samples: TemperatureLogSample[]): Blob => {
  const headers = [
    'Timestamp',
    'PCB Temp C',
    'Left Temp C',
    'Right Temp C',
    'IR Ambient Temp C',
    'IR Object Temp C',
    'Left Force g',
    'Right Force g',
    'Encoder Ticks',
    'Encoder Angle deg',
    'Encoder Velocity rpm'
  ];
  const headerXml = headers.map((header, index) => buildCellXml(TEMPERATURE_LOG_HEADER_ROW, index + 1, header)).join('');
  const rowsXml = samples
    .map((sample, index) => {
      const row = TEMPERATURE_LOG_HEADER_ROW + index + 1;
      const values: Array<string | number | null> = [
        Number(sample.elapsedSeconds.toFixed(3)),
        sample.pcbTempC === null ? null : Number(sample.pcbTempC.toFixed(3)),
        sample.leftTempC === null ? null : Number(sample.leftTempC.toFixed(3)),
        sample.rightTempC === null ? null : Number(sample.rightTempC.toFixed(3)),
        sample.irAmbientTempC === null ? null : Number(sample.irAmbientTempC.toFixed(3)),
        sample.irObjectTempC === null ? null : Number(sample.irObjectTempC.toFixed(3)),
        sample.leftForceGrams === null ? null : Math.round(sample.leftForceGrams),
        sample.rightForceGrams === null ? null : Math.round(sample.rightForceGrams),
        sample.encoderTicks,
        sample.encoderAngleDeg === null ? null : Number(sample.encoderAngleDeg.toFixed(3)),
        sample.encoderVelocityRpm === null ? null : Number(sample.encoderVelocityRpm.toFixed(3))
      ];

      return `<row r="${row}">${values.map((value, valueIndex) => buildCellXml(row, valueIndex + 1, value)).join('')}</row>`;
    })
    .join('');
  const lastRow = TEMPERATURE_LOG_HEADER_ROW + samples.length;
  const sheetName = "'Temperature Log'";
  const categoryRange = `${sheetName}!$A$${TEMPERATURE_LOG_HEADER_ROW + 1}:$A$${lastRow}`;
  const makeSeries = (index: number, labelColumn: number, valueColumn: number, color: string): string => `
    <c:ser>
      <c:idx val="${index}" />
      <c:order val="${index}" />
      <c:tx><c:strRef><c:f>${sheetName}!$${columnName(labelColumn)}$${TEMPERATURE_LOG_HEADER_ROW}</c:f></c:strRef></c:tx>
      <c:spPr><a:ln w="25400"><a:solidFill><a:srgbClr val="${color}" /></a:solidFill></a:ln></c:spPr>
      <c:cat><c:numRef><c:f>${categoryRange}</c:f></c:numRef></c:cat>
      <c:val><c:numRef><c:f>${sheetName}!$${columnName(valueColumn)}$${TEMPERATURE_LOG_HEADER_ROW + 1}:$${columnName(
        valueColumn
      )}$${lastRow}</c:f></c:numRef></c:val>
    </c:ser>`;

  const chartXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"
      xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <c:chart>
        <c:title><c:tx><c:rich><a:bodyPr /><a:lstStyle /><a:p><a:r><a:t>Temperature Graph</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0" /></c:title>
        <c:plotArea>
          <c:layout />
          <c:lineChart>
            <c:grouping val="standard" />
            ${makeSeries(0, 3, 3, 'F15A24')}
            ${makeSeries(1, 4, 4, '4361EE')}
            ${makeSeries(2, 2, 2, '16A34A')}
            ${makeSeries(3, 5, 5, '7C3AED')}
            ${makeSeries(4, 6, 6, 'DC2626')}
            <c:axId val="1001" />
            <c:axId val="1002" />
          </c:lineChart>
          <c:catAx>
            <c:axId val="1001" /><c:scaling><c:orientation val="minMax" /></c:scaling>
            <c:title><c:tx><c:rich><a:bodyPr /><a:lstStyle /><a:p><a:r><a:t>Timestamp (s)</a:t></a:r></a:p></c:rich></c:tx></c:title>
            <c:delete val="0" /><c:axPos val="b" /><c:numFmt formatCode="0.0" sourceLinked="0" />
            <c:majorTickMark val="out" /><c:minorTickMark val="none" /><c:tickLblPos val="nextTo" />
            <c:crossAx val="1002" /><c:crosses val="autoZero" /><c:auto val="1" /><c:lblAlgn val="ctr" /><c:lblOffset val="100" />
          </c:catAx>
          <c:valAx>
            <c:axId val="1002" /><c:scaling><c:orientation val="minMax" /></c:scaling>
            <c:title><c:tx><c:rich><a:bodyPr /><a:lstStyle /><a:p><a:r><a:t>Temperature (C)</a:t></a:r></a:p></c:rich></c:tx></c:title>
            <c:delete val="0" /><c:axPos val="l" /><c:majorGridlines /><c:numFmt formatCode="0.0" sourceLinked="0" />
            <c:majorTickMark val="out" /><c:minorTickMark val="none" /><c:tickLblPos val="nextTo" />
            <c:crossAx val="1001" /><c:crosses val="autoZero" /><c:crossBetween val="between" />
          </c:valAx>
        </c:plotArea>
        <c:legend><c:legendPos val="b" /><c:overlay val="0" /></c:legend>
        <c:plotVisOnly val="1" />
      </c:chart>
    </c:chartSpace>`;

  const files = [
    {
      path: '[Content_Types].xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
          <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
          <Default Extension="xml" ContentType="application/xml" />
          <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml" />
          <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml" />
          <Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml" />
          <Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml" />
          <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml" />
          <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml" />
          <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml" />
        </Types>`
    },
    {
      path: '_rels/.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml" />
          <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml" />
          <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml" />
        </Relationships>`
    },
    {
      path: 'docProps/core.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
          xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
          xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
          <dc:title>IGNIS Temperature Log</dc:title><dc:creator>IGNIS Digital Twin</dc:creator>
          <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
        </cp:coreProperties>`
    },
    {
      path: 'docProps/app.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
          xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
          <Application>IGNIS Digital Twin</Application>
        </Properties>`
    },
    {
      path: 'xl/workbook.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
          <sheets><sheet name="Temperature Log" sheetId="1" r:id="rId1" /></sheets>
        </workbook>`
    },
    {
      path: 'xl/_rels/workbook.xml.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml" />
          <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml" />
        </Relationships>`
    },
    {
      path: 'xl/styles.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
          <fonts count="2"><font><sz val="11" /><name val="Arial" /></font><font><b /><sz val="11" /><name val="Arial" /></font></fonts>
          <fills count="2"><fill><patternFill patternType="none" /></fill><fill><patternFill patternType="gray125" /></fill></fills>
          <borders count="1"><border><left /><right /><top /><bottom /><diagonal /></border></borders>
          <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" /></cellStyleXfs>
          <cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" /><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" /><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" /></cellXfs>
          <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0" /></cellStyles>
        </styleSheet>`
    },
    {
      path: 'xl/worksheets/sheet1.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
          <dimension ref="A1:H${lastRow}" />
          <sheetViews><sheetView workbookViewId="0" /></sheetViews>
          <sheetFormatPr defaultRowHeight="15" />
          <cols>
            <col min="1" max="1" width="14" customWidth="1" />
            <col min="2" max="8" width="17" customWidth="1" />
          </cols>
          <sheetData>
            <row r="${TEMPERATURE_LOG_HEADER_ROW}">${headerXml}</row>
            ${rowsXml}
          </sheetData>
          <drawing r:id="rId1" />
        </worksheet>`
    },
    {
      path: 'xl/worksheets/_rels/sheet1.xml.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml" />
        </Relationships>`
    },
    {
      path: 'xl/drawings/drawing1.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
          xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
          <xdr:twoCellAnchor>
            <xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
            <xdr:to><xdr:col>8</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>18</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
            <xdr:graphicFrame>
              <xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Temperature Graph" /><xdr:cNvGraphicFramePr /></xdr:nvGraphicFramePr>
              <xdr:xfrm><a:off x="0" y="0" /><a:ext cx="0" cy="0" /></xdr:xfrm>
              <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId1" /></a:graphicData></a:graphic>
            </xdr:graphicFrame>
            <xdr:clientData />
          </xdr:twoCellAnchor>
        </xdr:wsDr>`
    },
    {
      path: 'xl/drawings/_rels/drawing1.xml.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml" />
        </Relationships>`
    },
    { path: 'xl/charts/chart1.xml', content: chartXml }
  ];

  return createZipBlob(files);
};

const heatColor = (distance: number, status: number, minDistance: number, maxDistance: number): string => {
  if (status !== VALID_TOF_STATUS || distance <= 0) {
    return '#e6edf5';
  }

  const span = Math.max(maxDistance - minDistance, 1);
  const normalized = Math.max(0, Math.min(1, (distance - minDistance) / span));
  const hue = 14 + normalized * 215;
  return `hsl(${hue}, 82%, 56%)`;
};

const degreesToRadians = (degrees: number): number => (degrees * Math.PI) / 180;

const projectTofZone = (row: number, col: number, distance: number): { x: number; y: number; z: number } => {
  const normalizedX = (col + 0.5) / TOF_GRID_SIZE - 0.5;
  const normalizedY = 0.5 - (row + 0.5) / TOF_GRID_SIZE;
  const angleX = normalizedX * degreesToRadians(VL53L5CX_HORIZONTAL_FOV_DEG);
  const angleY = normalizedY * degreesToRadians(VL53L5CX_VERTICAL_FOV_DEG);

  return {
    x: Math.tan(angleX) * distance,
    y: Math.tan(angleY) * distance,
    z: distance
  };
};

interface TofPoint3D {
  id: string;
  index: number;
  row: number;
  col: number;
  distance: number;
  position: [number, number, number];
  color: string;
  age: number;
}

interface TofSceneData {
  points: TofPoint3D[];
  positions: Float32Array;
  colors: Float32Array;
  surfacePositions: Float32Array;
  surfaceColors: Float32Array;
}

interface TofCell {
  distance: number;
  status: number;
  row: number;
  col: number;
}

const buildTofFramePoints = (
  distances: number[],
  statuses: number[],
  sequence: number,
  capturedAt: number
): TofPoint3D[] => {
  const valid = Array.from({ length: 64 }, (_, index) => ({
    distance: distances[index] ?? -1,
    status: statuses[index] ?? 255,
    row: Math.floor(index / TOF_GRID_SIZE),
    col: index % TOF_GRID_SIZE
  })).filter((point) => point.status === VALID_TOF_STATUS && point.distance > 0);
  const nearestDistance = valid.length > 0 ? Math.min(...valid.map((point) => point.distance)) : 0;

  return valid.map((point): TofPoint3D => {
    const projected = projectTofZone(point.row, point.col, point.distance);
    const normalizedDepth = Math.max(0, Math.min(1, (point.distance - nearestDistance) / OBJECT_SHAPE_DEPTH_RANGE_MM));
    const x = projected.x * OBJECT_SHAPE_SCALE;
    const y = projected.y * OBJECT_SHAPE_SCALE;
    const z = -(point.distance - nearestDistance) * OBJECT_SHAPE_SCALE;

    return {
      id: `${sequence}-${point.row}-${point.col}-${capturedAt}`,
      index: point.row * TOF_GRID_SIZE + point.col,
      row: point.row,
      col: point.col,
      distance: point.distance,
      position: [x, y, z],
      color: `hsl(${14 + normalizedDepth * 215}, 82%, 56%)`,
      age: 0
    };
  });
};

const buildTofSceneData = (points: TofPoint3D[], latestPoints: TofPoint3D[]): TofSceneData => {
  const positions = new Float32Array(points.flatMap((point) => point.position));
  const colors = new Float32Array(
    points.flatMap((point) => {
      const color = new THREE.Color(point.color);
      const fade = Math.max(0.25, 1 - point.age * 0.08);
      return [color.r * fade, color.g * fade, color.b * fade];
    })
  );
  const surfaceVertices: number[] = [];
  const surfaceColorValues: number[] = [];

  const pushTriangle = (a: TofPoint3D, b: TofPoint3D, c: TofPoint3D): void => {
    const maxGap = Math.max(
      Math.abs(a.distance - b.distance),
      Math.abs(b.distance - c.distance),
      Math.abs(c.distance - a.distance)
    );
    if (maxGap > 220) {
      return;
    }

    for (const point of [a, b, c]) {
      surfaceVertices.push(...point.position);
      const color = new THREE.Color(point.color);
      surfaceColorValues.push(color.r, color.g, color.b);
    }
  };

  const latestPointByIndex = new Map(latestPoints.map((point) => [point.index, point]));
  for (let row = 0; row < TOF_GRID_SIZE - 1; row += 1) {
    for (let col = 0; col < TOF_GRID_SIZE - 1; col += 1) {
      const a = latestPointByIndex.get(row * TOF_GRID_SIZE + col);
      const b = latestPointByIndex.get(row * TOF_GRID_SIZE + col + 1);
      const c = latestPointByIndex.get((row + 1) * TOF_GRID_SIZE + col);
      const d = latestPointByIndex.get((row + 1) * TOF_GRID_SIZE + col + 1);

      if (a && b && c) pushTriangle(a, b, c);
      if (b && c && d) pushTriangle(b, d, c);
    }
  }

  return {
    points,
    positions,
    colors,
    surfacePositions: new Float32Array(surfaceVertices),
    surfaceColors: new Float32Array(surfaceColorValues)
  };
};

const ObjectShapeScene = ({ sceneData }: { sceneData: TofSceneData }): JSX.Element => {
  const surfaceVertexCount = sceneData.surfacePositions.length / 3;

  return (
    <Canvas shadows dpr={[1, 2]} gl={{ antialias: true }} camera={{ position: [0, 0.2, 4.6], fov: 42 }}>
      <color attach="background" args={['#fbfcfe']} />
      <PerspectiveCamera makeDefault position={[0, 0.2, 4.6]} fov={42} />
      <ambientLight intensity={0.85} />
      <directionalLight position={[3, 4, 5]} intensity={1.1} />
      <gridHelper args={[4.8, 8, '#dbe3ee', '#eef2f7']} rotation={[Math.PI / 2, 0, 0]} position={[0, 0, -0.95]} />

      {surfaceVertexCount > 0 && (
        <mesh>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              array={sceneData.surfacePositions}
              count={surfaceVertexCount}
              itemSize={3}
            />
            <bufferAttribute
              attach="attributes-color"
              array={sceneData.surfaceColors}
              count={surfaceVertexCount}
              itemSize={3}
            />
          </bufferGeometry>
          <meshStandardMaterial
            transparent
            opacity={0.32}
            vertexColors
            roughness={0.68}
            metalness={0}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {sceneData.points.length > 0 && (
        <points>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              array={sceneData.positions}
              count={sceneData.points.length}
              itemSize={3}
            />
            <bufferAttribute
              attach="attributes-color"
              array={sceneData.colors}
              count={sceneData.points.length}
              itemSize={3}
            />
          </bufferGeometry>
          <pointsMaterial size={0.075} sizeAttenuation vertexColors />
        </points>
      )}

      <lineSegments>
        <edgesGeometry args={[new THREE.BoxGeometry(2.7, 2.7, 1.9)]} />
        <lineBasicMaterial color="#cbd5e1" transparent opacity={0.28} />
      </lineSegments>

      <OrbitControls enableDamping dampingFactor={0.08} target={[0, 0, -0.65]} />
    </Canvas>
  );
};

const ObjectDepthBarsScene = ({
  cells,
  minDistance,
  maxDistance
}: {
  cells: TofCell[];
  minDistance: number;
  maxDistance: number;
}): JSX.Element => {
  const span = Math.max(maxDistance - minDistance, 1);
  const cellGap = 0.1;
  const cellSize = 0.34;
  const gridOffset = ((TOF_GRID_SIZE - 1) * (cellSize + cellGap)) / 2;

  return (
    <Canvas shadows dpr={[1, 2]} gl={{ antialias: true }} camera={{ position: [3.8, 3.25, 4.6], fov: 38 }}>
      <color attach="background" args={['#fbfcfe']} />
      <PerspectiveCamera makeDefault position={[3.8, 3.25, 4.6]} fov={38} />
      <ambientLight intensity={0.85} />
      <directionalLight castShadow position={[3, 5, 4]} intensity={1.2} />
      <gridHelper args={[3.65, 8, '#cbd5e1', '#e6edf5']} position={[0, -0.01, 0]} />

      {cells.map((cell, index) => {
        const isValid = cell.status === VALID_TOF_STATUS && cell.distance > 0;
        const normalized = isValid ? Math.max(0, Math.min(1, (cell.distance - minDistance) / span)) : 1;
        const height = isValid ? 0.12 + (1 - normalized) * 1.55 : 0.025;
        const x = cell.col * (cellSize + cellGap) - gridOffset;
        const z = cell.row * (cellSize + cellGap) - gridOffset;
        const color = isValid ? heatColor(cell.distance, cell.status, minDistance, maxDistance) : '#dbe3ee';

        return (
          <mesh key={`tof-bar-${index}`} castShadow receiveShadow position={[x, height / 2, z]}>
            <boxGeometry args={[cellSize, height, cellSize]} />
            <meshStandardMaterial color={color} roughness={0.62} metalness={0.02} />
          </mesh>
        );
      })}

      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
        <planeGeometry args={[3.65, 3.65]} />
        <meshStandardMaterial color="#f8fafc" roughness={0.9} />
      </mesh>

      <OrbitControls enableDamping dampingFactor={0.08} target={[0, 0.65, 0]} />
    </Canvas>
  );
};

export const ObjectPerceptionPanel = (): JSX.Element => {
  const [viewMode, setViewMode] = useState<'2d' | '3d'>('2d');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const tof = useImuStore((state) => state.tof);
  const lastTofAt = useImuStore((state) => state.lastTofAt);
  const isLive = Boolean(lastTofAt && Date.now() - lastTofAt < 3000);
  const cells = Array.from({ length: 64 }, (_, index) => ({
    distance: tof.distances[index] ?? -1,
    status: tof.statuses[index] ?? 255,
    row: Math.floor(index / TOF_GRID_SIZE),
    col: index % TOF_GRID_SIZE
  }));
  const validCells = cells.filter((cell) => cell.status === VALID_TOF_STATUS && cell.distance > 0);
  const validDistances = validCells.map((cell) => cell.distance);
  const nearest = validDistances.length > 0 ? Math.min(...validDistances) : null;
  const average =
    validDistances.length > 0
      ? validDistances.reduce((total, distance) => total + distance, 0) / validDistances.length
      : null;
  const minDistance = validDistances.length > 0 ? Math.min(...validDistances) : 0;
  const maxDistance = validDistances.length > 0 ? Math.max(...validDistances) : 300;
  const projectedCells = validCells.map((cell) => projectTofZone(cell.row, cell.col, cell.distance));
  const projectedXs = projectedCells.map((cell) => cell.x);
  const projectedYs = projectedCells.map((cell) => cell.y);
  const minX = projectedXs.length > 0 ? Math.min(...projectedXs) : null;
  const maxX = projectedXs.length > 0 ? Math.max(...projectedXs) : null;
  const minY = projectedYs.length > 0 ? Math.min(...projectedYs) : null;
  const maxY = projectedYs.length > 0 ? Math.max(...projectedYs) : null;
  const objectWidth = minX !== null && maxX !== null ? maxX - minX : null;
  const objectHeight = minY !== null && maxY !== null ? maxY - minY : null;
  const centerOffset = minX !== null && maxX !== null ? (minX + maxX) / 2 : null;
  const confidence = validCells.length > 0 ? (validCells.length / Math.max(tof.resolution, 1)) * 100 : null;

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
    <section className={`panel object-panel ${isFullscreen ? 'panel-fullscreen object-panel-fullscreen' : ''}`}>
      <div className="panel-heading bordered">
        <h2>Object Perception (VL53L5CX) <span className="info-mark">i</span></h2>
        <div className="panel-heading-actions">
          <div className="object-view-toggle" aria-label="Object perception view mode">
            <button
              className={viewMode === '2d' ? 'active' : ''}
              type="button"
              onClick={() => setViewMode('2d')}
            >
              2D
            </button>
            <button
              className={viewMode === '3d' ? 'active' : ''}
              type="button"
              onClick={() => setViewMode('3d')}
            >
              3D
            </button>
          </div>
          <span className="panel-note">{isLive ? `${tof.frequency || 15} Hz` : 'Pending'}</span>
          <button className="panel-action-button" type="button" onClick={() => setIsFullscreen((value) => !value)}>
            {isFullscreen ? 'Exit' : 'Full'}
          </button>
        </div>
      </div>

      <div className="object-content">
        <div className="depth-block">
          {viewMode === '2d' ? (
            <div className="heatmap" aria-label="VL53L5CX 8 by 8 depth map">
              {cells.map((cell, index) => (
                <span
                  key={`${tof.sequence}-${index}`}
                  style={{ background: heatColor(cell.distance, cell.status, minDistance, maxDistance) }}
                  title={`Zone ${index}: ${cell.status === VALID_TOF_STATUS ? `${cell.distance} mm` : 'invalid'}`}
                />
              ))}
            </div>
          ) : (
            <div className="object-bars-stage" aria-label="VL53L5CX 3D depth bar visualization">
              <ObjectDepthBarsScene cells={cells} minDistance={minDistance} maxDistance={maxDistance} />
            </div>
          )}
        </div>

        <div className="perception-stats">
          <article>
            <span>Nearest Point</span>
            <strong>{formatOptional(nearest, 'mm')}</strong>
          </article>
          <article>
            <span>Avg Depth</span>
            <strong>{formatOptional(average, 'mm')}</strong>
          </article>
          <article>
            <span>Object Width</span>
            <strong>{formatOptional(objectWidth, 'mm')}</strong>
          </article>
          <article>
            <span>Object Height</span>
            <strong>{formatOptional(objectHeight, 'mm')}</strong>
          </article>
          <article>
            <span>Center Offset</span>
            <strong>{formatOptional(centerOffset, 'mm')}</strong>
          </article>
          <article>
            <span>Confidence</span>
            <strong>{formatOptional(confidence, '%')}</strong>
          </article>
        </div>
      </div>

      <div className="object-spectrum">
        <span>{nearest === null ? 'Near' : `${nearest.toFixed(0)} mm`}</span>
        <i />
        <span>{maxDistance <= 0 ? 'Far' : `${maxDistance.toFixed(0)} mm`}</span>
      </div>
    </section>
  );
};

export const PointCloudPanel = (): JSX.Element => {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isCollecting, setIsCollecting] = useState(false);
  const [collectedPoints, setCollectedPoints] = useState<TofPoint3D[]>([]);
  const [latestPoints, setLatestPoints] = useState<TofPoint3D[]>([]);
  const tof = useImuStore((state) => state.tof);
  const lastTofAt = useImuStore((state) => state.lastTofAt);
  const isLive = Boolean(lastTofAt && Date.now() - lastTofAt < 3000);

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
    const framePoints = buildTofFramePoints(tof.distances, tof.statuses, tof.sequence, Date.now());
    if (framePoints.length === 0) {
      return;
    }

    setLatestPoints(framePoints);
    if (isCollecting) {
      setCollectedPoints((current) => {
        const aged = current.map((point) => ({ ...point, age: point.age + 1 }));
        return [...aged, ...framePoints];
      });
    }
  }, [isCollecting, tof.distances, tof.sequence, tof.statuses]);

  const sceneData = useMemo(
    () => buildTofSceneData(collectedPoints, latestPoints),
    [collectedPoints, latestPoints]
  );

  return (
    <section className={`panel point-cloud-panel ${isFullscreen ? 'panel-fullscreen object-shape-fullscreen' : ''}`}>
      <div className="panel-heading bordered">
        <h2>Object Shape</h2>
        <div className="panel-heading-actions">
          <span className="panel-note">{isLive ? 'Live ToF' : 'Pending'}</span>
          <span className="panel-note">{sceneData.points.length.toLocaleString()} pts</span>
          <button className="panel-action-button" type="button" onClick={() => setIsCollecting((value) => !value)}>
            {isCollecting ? 'Pause' : 'Collect'}
          </button>
          <button
            className="panel-action-button"
            type="button"
            onClick={() => {
              setCollectedPoints([]);
            }}
          >
            Reset
          </button>
          <button className="panel-action-button" type="button" onClick={() => setIsFullscreen((value) => !value)}>
            {isFullscreen ? 'Exit' : 'Full'}
          </button>
        </div>
      </div>
      <div className="point-cloud-stage">
        {sceneData.points.length === 0 && latestPoints.length === 0 ? (
          <p className="shape-empty">Waiting for valid ToF zones</p>
        ) : null}
        <ObjectShapeScene sceneData={sceneData} />
      </div>
    </section>
  );
};

export const ImuSummaryPanel = (): JSX.Element => {
  const imu = useImuStore((state) => state.imu);
  const accelMagnitude = Math.sqrt(imu.ax * imu.ax + imu.ay * imu.ay + imu.az * imu.az);

  return (
    <section className="panel imu-summary-panel">
      <div className="panel-heading bordered">
        <h2>IMU Summary</h2>
      </div>
      <div className="imu-summary-body">
        <div className="axis-cube" aria-hidden="true">
          <span className="axis-y">Y</span>
          <span className="axis-x">X</span>
          <span className="axis-z">Z</span>
          <i />
        </div>
        <div className="summary-table">
          <p>
            <span>Roll</span>
            <strong>{format(imu.roll)} deg</strong>
          </p>
          <p>
            <span>Pitch</span>
            <strong>{format(imu.pitch)} deg</strong>
          </p>
          <p>
            <span>Yaw</span>
            <strong>{format(imu.yaw)} deg</strong>
          </p>
          <p>
            <span>Acceleration</span>
            <strong>{format(accelMagnitude, 2)} g</strong>
          </p>
        </div>
      </div>
    </section>
  );
};

export const FingerStatusPanel = (): JSX.Element => {
  const rtd = useImuStore((state) => state.rtd);
  const fsr = useImuStore((state) => state.fsr);
  const lastRtdAt = useImuStore((state) => state.lastRtdAt);
  const minFingerTempC = 0;
  const maxFingerTempC = 500;
  const isLive = Boolean(lastRtdAt && Date.now() - lastRtdAt < 3000 && (rtd.leftValid || rtd.rightValid));
  const fingers = [
    {
      label: 'Left Finger',
      tempC: rtd.leftPresent && rtd.leftValid ? rtd.leftTempC : null,
      contact: fsr.leftTriggered,
      forceGrams: fsr.leftForceGrams
    },
    {
      label: 'Right Finger',
      tempC: rtd.rightPresent && rtd.rightValid ? rtd.rightTempC : null,
      contact: fsr.rightTriggered,
      forceGrams: fsr.rightForceGrams
    }
  ];

  return (
    <section className="panel finger-status-panel">
      <div className="panel-heading bordered">
        <h2>Finger Status</h2>
        <span className="panel-note">{isLive ? 'PT1000' : 'Pending'}</span>
      </div>
      <div className="finger-status-grid">
        {fingers.map((finger) => {
          const tempRatio =
            finger.tempC === null
              ? null
              : Math.min(Math.max((finger.tempC - minFingerTempC) / (maxFingerTempC - minFingerTempC), 0), 1);

          return (
            <article key={finger.label}>
              <span>{finger.label}</span>
              <strong>{finger.tempC === null ? '-- C' : `${finger.tempC.toFixed(1)} C`}</strong>
              <div className="finger-spectrum" aria-label={`${finger.label} temperature spectrum`}>
                <i />
                {tempRatio === null ? null : <em style={{ left: `${tempRatio * 100}%` }} />}
                <span>{minFingerTempC} C</span>
                <span>{maxFingerTempC} C</span>
              </div>
              <p>Contact</p>
              <b className={finger.contact ? 'contact-active' : undefined}>{finger.contact ? 'Yes' : 'No'}</b>
            </article>
          );
        })}
      </div>
    </section>
  );
};

export const SystemHealthPanel = (): JSX.Element => {
  const packetFrequency = useImuStore((state) => state.packetFrequency);
  const status = useImuStore((state) => state.status);
  const pcbTemp = useImuStore((state) => state.pcbTemp);
  const lastPcbTempAt = useImuStore((state) => state.lastPcbTempAt);
  const pcbTempOnline = Boolean(lastPcbTempAt && Date.now() - lastPcbTempAt < 3000 && pcbTemp.present && pcbTemp.valid);
  const rows = [
    ['PCB Temperature', pcbTempOnline ? `${format(pcbTemp.tempC)} C` : '-- C'],
    ['Input Voltage', '-- V'],
    ['Packet Rate', `${format(packetFrequency)} Hz`],
    ['Connection', status],
    ['Firmware', 'v1.1.3']
  ];

  return (
    <section className="panel system-health-panel">
      <div className="panel-heading bordered">
        <h2>System Health</h2>
      </div>
      <div className="health-list">
        {rows.map(([label, value]) => (
          <p key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <i />
          </p>
        ))}
      </div>
    </section>
  );
};

export const TelemetrySummaryPanel = (): JSX.Element => {
  const packetCount = useImuStore((state) => state.packetCount);
  const packetFrequency = useImuStore((state) => state.packetFrequency);
  const status = useImuStore((state) => state.status);
  const acquisitionState = useImuStore((state) => state.acquisitionState);
  const connected = status === 'connected' || status === 'reconnecting';

  return (
    <section className="telemetry-summary-strip" aria-label="Telemetry summary">
      <article className={connected ? 'status-metric connected' : 'status-metric'}>
        <span>Status</span>
        <strong>{connected ? 'Connected' : 'Disconnected'}</strong>
        <small>{acquisitionState === 'running' ? 'Streaming Live' : acquisitionState === 'paused' ? 'Paused' : 'Idle'}</small>
      </article>
      <article>
        <span>Packets</span>
        <strong>{packetCount.toLocaleString()}</strong>
      </article>
      <article>
        <span>Latency</span>
        <strong>-- ms</strong>
      </article>
      <article>
        <span>Update Rate</span>
        <strong>{format(packetFrequency)} Hz</strong>
      </article>
    </section>
  );
};

export const SensorStatusPanel = (): JSX.Element => {
  const gripperConnection = useImuStore((state) => state.deviceConnections.gripper);
  const sensorStatus = useImuStore((state) => state.sensorStatus);
  const sensorEnabled = useImuStore((state) => state.sensorEnabled);
  const setSensorEnabled = useImuStore((state) => state.setSensorEnabled);
  const lastImuAt = useImuStore((state) => state.lastImuAt);
  const lastTofAt = useImuStore((state) => state.lastTofAt);
  const pcbTemp = useImuStore((state) => state.pcbTemp);
  const lastPcbTempAt = useImuStore((state) => state.lastPcbTempAt);
  const mlx90614 = useImuStore((state) => state.mlx90614);
  const lastMlx90614At = useImuStore((state) => state.lastMlx90614At);
  const fsr = useImuStore((state) => state.fsr);
  const lastFsrAt = useImuStore((state) => state.lastFsrAt);
  const resetSensorStatus = useImuStore((state) => state.resetSensorStatus);
  const addLog = useImuStore((state) => state.addLog);
  const [reinitializing, setReinitializing] = useState(false);
  const [updatingSensor, setUpdatingSensor] = useState<SensorKey | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const isConnected = gripperConnection.status === 'connected' || gripperConnection.status === 'reconnecting';
  const gripperConnected = gripperConnection.status === 'connected';
  const canReinitialize = gripperConnected && !reinitializing;
  const imuOnline = Boolean(isConnected && lastImuAt && now - lastImuAt < SENSOR_FRESHNESS_MS);
  const tofOnline = Boolean(isConnected && lastTofAt && now - lastTofAt < SENSOR_FRESHNESS_MS);
  const pcbTempOnline = Boolean(
    isConnected && lastPcbTempAt && now - lastPcbTempAt < SENSOR_FRESHNESS_MS && pcbTemp.present && pcbTemp.valid
  );
  const irTempOnline = Boolean(
    isConnected &&
      lastMlx90614At &&
      now - lastMlx90614At < SENSOR_FRESHNESS_MS &&
      mlx90614.present &&
      (mlx90614.ambientValid || mlx90614.objectValid)
  );
  const fsrFresh = Boolean(isConnected && lastFsrAt && now - lastFsrAt < SENSOR_FRESHNESS_MS);
  const leftFsrOnline = Boolean(fsrFresh && fsr.leftPresent);
  const rightFsrOnline = Boolean(fsrFresh && fsr.rightPresent);
  const preflightState = useCallback((probe: { detected?: boolean; available?: boolean; valid?: boolean; fault?: boolean } | undefined) => {
    if (probe?.fault) return 'Fault';
    if ((probe?.available || probe?.detected) && probe.valid === false) return 'No Data';
    if (probe?.available || probe?.detected) return 'Detected';
    return 'Pending';
  }, []);
  const sensors = useMemo(
    () =>
      [
    { key: 'encoder', label: 'Encoder', state: preflightState(sensorStatus.encoder), commandName: 'ENCODER' },
    { key: 'leftPt1000', label: 'Left PT1000', state: preflightState(sensorStatus.leftPt1000), commandName: 'LEFT_PT1000' },
    { key: 'rightPt1000', label: 'Right PT1000', state: preflightState(sensorStatus.rightPt1000), commandName: 'RIGHT_PT1000' },
    { key: 'pcbTemp', label: 'PCB Temp', state: pcbTempOnline ? 'Online' : preflightState(sensorStatus.pcbTemp), commandName: 'PCB_TEMP' },
    { key: 'imu', label: 'IMU', state: imuOnline ? 'Online' : isConnected ? preflightState(sensorStatus.imu) : 'Offline', commandName: 'IMU' },
    { key: 'tof', label: 'VL53L5CX', state: tofOnline ? 'Online' : preflightState(sensorStatus.tof), commandName: 'VL53L5CX' },
    { key: 'irTemp', label: 'MLX90614', state: irTempOnline ? 'Online' : preflightState(sensorStatus.irTemp), commandName: 'MLX90614' },
    { key: 'leftFsr', label: 'Left FSR', state: leftFsrOnline ? 'Online' : preflightState(sensorStatus.leftFsr), commandName: 'LEFT_FSR' },
    { key: 'rightFsr', label: 'Right FSR', state: rightFsrOnline ? 'Online' : preflightState(sensorStatus.rightFsr), commandName: 'RIGHT_FSR' }
      ] as const,
    [
      isConnected,
      imuOnline,
      irTempOnline,
      leftFsrOnline,
      pcbTempOnline,
      preflightState,
      rightFsrOnline,
      sensorStatus.encoder,
      sensorStatus.imu,
      sensorStatus.irTemp,
      sensorStatus.leftFsr,
      sensorStatus.leftPt1000,
      sensorStatus.pcbTemp,
      sensorStatus.rightFsr,
      sensorStatus.rightPt1000,
      sensorStatus.tof,
      tofOnline
    ]
  );

  const setFirmwareSensorEnabled = async (sensor: SensorKey, commandName: string, enabled: boolean): Promise<void> => {
    if (!gripperConnected || updatingSensor) {
      return;
    }

    setUpdatingSensor(sensor);
    setSensorEnabled(sensor, enabled);
    try {
      const command = `SENSOR:${commandName}:${enabled ? 'ON' : 'OFF'}`;
      if (gripperConnection.transport === 'ble') {
        await bleImuClient.sendCommand('gripper', command);
      } else {
        await window.serialApi.sendCommand('gripper', command);
      }
      resetSensorStatus();
      addLog({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        timestamp: new Date().toISOString(),
        level: 'info',
        message: `${enabled ? 'Enabled' : 'Disabled'} ${commandName.replace(/_/g, ' ')}.`
      });
    } catch (error) {
      setSensorEnabled(sensor, !enabled);
      addLog({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        timestamp: new Date().toISOString(),
        level: 'error',
        message: error instanceof Error ? `Sensor toggle failed: ${error.message}` : 'Sensor toggle failed.'
      });
    } finally {
      setUpdatingSensor(null);
    }
  };

  useEffect(() => {
    if (!gripperConnected || updatingSensor) {
      return;
    }

    const missingSensors = sensors.filter(({ key }) => {
      const probe = sensorStatus[key];
      return sensorEnabled[key] && probe !== undefined && probe.detected === false && probe.available === false;
    });

    if (missingSensors.length === 0) {
      return;
    }

    let cancelled = false;
    void (async () => {
      for (const sensor of missingSensors) {
        if (cancelled) {
          return;
        }
        await setFirmwareSensorEnabled(sensor.key, sensor.commandName, false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [gripperConnected, sensorEnabled, sensorStatus, sensors, updatingSensor]);

  const reinitializeSensors = async (): Promise<void> => {
    if (!canReinitialize) {
      return;
    }

    setReinitializing(true);
    resetSensorStatus();
    try {
      if (gripperConnection.transport === 'ble') {
        await bleImuClient.sendCommand('gripper', 'REINITIALIZE');
      } else {
        await window.serialApi.sendCommand('gripper', 'REINITIALIZE');
      }
      addLog({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        timestamp: new Date().toISOString(),
        level: 'info',
        message: 'Requested sensor reinitialization.'
      });
    } catch (error) {
      addLog({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        timestamp: new Date().toISOString(),
        level: 'error',
        message: error instanceof Error ? `Sensor reinitialization failed: ${error.message}` : 'Sensor reinitialization failed.'
      });
    } finally {
      window.setTimeout(() => setReinitializing(false), 900);
    }
  };

  return (
    <section className="panel sensor-status-panel">
      <div className="panel-heading bordered">
        <h2>Sensor Status</h2>
        <button className="panel-action-button" type="button" disabled={!canReinitialize} onClick={() => void reinitializeSensors()}>
          {reinitializing ? 'Reinitializing' : 'Reinitialize'}
        </button>
      </div>
      <div className="sensor-status-row">
        {sensors.map(({ key, label, state, commandName }) => {
          const enabled = sensorEnabled[key];
          const displayState = enabled ? state : 'Disabled';
          const active = displayState === 'Online';
          const detected = displayState === 'Detected';
          const fault = displayState === 'Fault';
          const noData = displayState === 'No Data';
          const disabled = displayState === 'Disabled';
          return (
            <article
              className={[
                active ? 'sensor-online' : '',
                detected ? 'sensor-detected' : '',
                fault ? 'sensor-fault' : '',
                noData ? 'sensor-no-data' : '',
                disabled ? 'sensor-disabled' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              key={key}
            >
              <label className="sensor-enable-toggle">
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={!gripperConnected || updatingSensor !== null}
                  onChange={(event) => void setFirmwareSensorEnabled(key, commandName, event.target.checked)}
                />
                <span>{label}</span>
              </label>
              <small>
                <b />
                {displayState}
              </small>
            </article>
          );
        })}
      </div>
    </section>
  );
};

export const RecordingPanel = (): JSX.Element => {
  const temperatureLogging = useImuStore((state) => state.temperatureLogging);
  const temperatureLogSamples = useImuStore((state) => state.temperatureLogSamples);
  const importedTemperatureLogSamples = useImuStore((state) => state.importedTemperatureLogSamples);
  const importedTemperatureLogName = useImuStore((state) => state.importedTemperatureLogName);
  const temperatureLogStartedAt = useImuStore((state) => state.temperatureLogStartedAt);
  const temperatureLogElapsedBeforePauseMs = useImuStore((state) => state.temperatureLogElapsedBeforePauseMs);
  const startTemperatureLogging = useImuStore((state) => state.startTemperatureLogging);
  const stopTemperatureLogging = useImuStore((state) => state.stopTemperatureLogging);
  const resetTemperatureLog = useImuStore((state) => state.resetTemperatureLog);
  const setImportedTemperatureLog = useImuStore((state) => state.setImportedTemperatureLog);
  const gripperSpeedTarget = useImuStore((state) => state.gripperSpeedTarget);
  const testObjectType = useImuStore((state) => state.testObjectType);
  const testLoadWeightKg = useImuStore((state) => state.testLoadWeightKg);
  const testRepeatCount = useImuStore((state) => state.testRepeatCount);
  const testRecordingEnabled = useImuStore((state) => state.testRecordingEnabled);
  const setTestRecordingEnabled = useImuStore((state) => state.setTestRecordingEnabled);
  const exportFolderPath = useImuStore((state) => state.exportFolderPath);
  const setExportFolderPath = useImuStore((state) => state.setExportFolderPath);
  const addLog = useImuStore((state) => state.addLog);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (!temperatureLogging) {
      return undefined;
    }

    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [temperatureLogging]);

  const elapsedMs =
    temperatureLogElapsedBeforePauseMs +
    (temperatureLogging ? Math.max(now - (temperatureLogStartedAt ?? now), 0) : 0);
  const displayedSamples = importedTemperatureLogSamples.length > 0 ? importedTemperatureLogSamples : temperatureLogSamples;
  const displayedDurationSeconds =
    importedTemperatureLogSamples.length > 0
      ? importedTemperatureLogSamples.at(-1)?.elapsedSeconds ?? 0
      : elapsedMs / 1000;
  const canExport = displayedSamples.length > 0;
  const statusLabel = importedTemperatureLogSamples.length > 0 ? 'Imported' : temperatureLogging ? 'Recording' : 'Stopped';

  const chooseExportFolder = async (): Promise<void> => {
    const folderPath = await window.fileApi.selectExportFolder();

    if (!folderPath) {
      return;
    }

    setExportFolderPath(folderPath);
    addLog({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: new Date().toISOString(),
      level: 'success',
      message: `Data log export folder set to ${folderPath}.`
    });
  };

  const exportTemperatureLog = async (): Promise<void> => {
    if (!canExport) {
      return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const exportName = buildTemperatureLogFileName(
      {
        objectType: testObjectType,
        loadWeightKg: testLoadWeightKg,
        gripperSpeedTarget,
        testNumber: testRepeatCount
      },
      timestamp
    );
    try {
      const savedPath = await saveTemperatureLogWorkbook(displayedSamples, exportName, exportFolderPath);

      addLog({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        timestamp: new Date().toISOString(),
        level: 'success',
        message: `Exported ${displayedSamples.length.toLocaleString()} temperature samples to ${savedPath}.`
      });
    } catch (error) {
      addLog({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        timestamp: new Date().toISOString(),
        level: 'error',
        message: error instanceof Error ? `Export failed: ${error.message}` : 'Export failed.'
      });
    }
  };

  const importTemperatureLog = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file) {
      return;
    }

    setImporting(true);
    try {
      const samples = await parseImportedLogFile(file);
      if (samples.length === 0) {
        throw new Error('No valid log rows were found.');
      }

      setImportedTemperatureLog(samples, file.name);
      addLog({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        timestamp: new Date().toISOString(),
        level: 'success',
        message: `Imported ${samples.length.toLocaleString()} samples from ${file.name}.`
      });
    } catch (error) {
      addLog({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        timestamp: new Date().toISOString(),
        level: 'error',
        message: error instanceof Error ? `Import failed: ${error.message}` : 'Import failed.'
      });
    } finally {
      setImporting(false);
    }
  };

  return (
    <section
      className={`panel recording-panel ${temperatureLogging ? 'recording-active' : ''} ${
        importedTemperatureLogSamples.length > 0 ? 'recording-imported' : ''
      }`}
    >
      <div className="panel-heading bordered">
        <div className="recording-title-group">
          <h2>Recording / Logging</h2>
          <label className={`recording-test-toggle ${testRecordingEnabled ? 'active' : ''}`} title="Record and auto-export data during automated tests">
            <input
              type="checkbox"
              checked={testRecordingEnabled}
              onChange={(event) => setTestRecordingEnabled(event.target.checked)}
            />
            <span>Record</span>
          </label>
        </div>
        <div className="recording-heading-metrics">
          <div className="recording-heading-status">
            <strong>{statusLabel}</strong>
            <i />
          </div>
          <div className="recording-heading-sample">
            <span>Samples</span>
            <strong>{displayedSamples.length.toLocaleString()}</strong>
          </div>
          <button
            type="button"
            className={`recording-folder-button ${exportFolderPath ? 'has-folder' : ''}`}
            title={exportFolderPath ?? 'No export folder selected'}
            onClick={() => void chooseExportFolder()}
          >
            {exportFolderPath ? 'Folder Set' : 'Folder'}
          </button>
        </div>
      </div>
      <input
        ref={importInputRef}
        className="file-import-input"
        type="file"
        accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={(event) => void importTemperatureLog(event)}
      />
      <div className="recording-body">
        <article>
          <span>Duration</span>
          <strong>{formatDuration(displayedDurationSeconds)}</strong>
        </article>
        <article>
          <span>Source</span>
          <strong title={importedTemperatureLogName ?? 'Live'}>{importedTemperatureLogSamples.length > 0 ? 'Imported' : 'Live'}</strong>
        </article>
        <div className="recording-actions">
          <button type="button" onClick={temperatureLogging ? stopTemperatureLogging : startTemperatureLogging}>
            {temperatureLogging ? 'Stop' : 'Record'}
          </button>
          <button type="button" onClick={resetTemperatureLog} disabled={displayedSamples.length === 0 && !temperatureLogging}>
            Reset
          </button>
          <button type="button" onClick={() => void exportTemperatureLog()} disabled={!canExport}>
            Export
          </button>
          <button type="button" onClick={() => importInputRef.current?.click()} disabled={temperatureLogging || importing}>
            {importing ? 'Importing' : 'Import'}
          </button>
        </div>
      </div>
    </section>
  );
};

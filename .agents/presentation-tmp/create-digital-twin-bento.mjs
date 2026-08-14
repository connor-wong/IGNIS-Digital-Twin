import fs from "node:fs/promises";
import path from "node:path";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const OUT_DIR = "C:/Users/wongz/OneDrive/Documents/Gripper Digital Twin/artifacts";
const FINAL_PPTX = path.join(OUT_DIR, "digital-twin-software-iterations-bento-v2.pptx");
const PREVIEW_PNG = path.join(OUT_DIR, "digital-twin-software-iterations-bento-v2.png");
const SCREENSHOT = path.join(OUT_DIR, "digital-twin-current-interface.png");

const asset = (name) => path.join(OUT_DIR, name);
const W = 1280;
const H = 720;
const C = {
  bg: "#050505",
  tile: "#111111",
  line: "#303030",
  text: "#f5f5f7",
  soft: "#b6b6b6",
  muted: "#777777",
  orange: "#f47a2f",
  teal: "#7ff0e2",
  green: "#35d07f",
  blue: "#54a7ff",
  red: "#d64a3a",
};

async function writeBlob(filePath, blob) {
  await fs.writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
}

async function imageBytes(filePath) {
  const bytes = await fs.readFile(filePath);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function addText(slide, value, x, y, w, h, opts = {}) {
  const shape = slide.shapes.add({
    geometry: "textbox",
    name: opts.name || value.slice(0, 24),
    position: { left: x, top: y, width: w, height: h },
    fill: "none",
    line: { style: "solid", fill: "none", width: 0 },
  });
  shape.text = value;
  shape.text.style = {
    fontSize: opts.size || 18,
    bold: opts.bold ?? false,
    color: opts.color || C.text,
    fontFace: "Aptos Display",
    alignment: opts.align || "left",
  };
  return shape;
}

function addTile(slide, name, x, y, w, h, fill = C.tile, line = C.line) {
  return slide.shapes.add({
    geometry: "roundRect",
    name,
    position: { left: x, top: y, width: w, height: h },
    fill,
    line: { style: "solid", fill: line, width: 1 },
    borderRadius: "rounded-3xl",
    shadow: "shadow-lg",
  });
}

async function addImageTile(slide, name, imagePath, x, y, w, h, fit = "cover") {
  addTile(slide, `${name}-frame`, x, y, w, h, "#0d0d0d", "#303030");
  slide.images.add({
    blob: await imageBytes(imagePath),
    contentType: "image/png",
    alt: name,
    fit,
    geometry: "roundRect",
    borderRadius: "rounded-3xl",
    position: { left: x, top: y, width: w, height: h },
  });
  slide.shapes.add({
    geometry: "roundRect",
    name: `${name}-shade`,
    position: { left: x, top: y, width: w, height: h },
    fill: "#00000055",
    line: { style: "solid", fill: "#ffffff14", width: 1 },
    borderRadius: "rounded-3xl",
  });
}

function label(slide, eyebrow, title, x, y, w, accent = C.orange, titleSize = 26) {
  addText(slide, eyebrow.toUpperCase(), x, y, w, 18, { size: 12, bold: true, color: accent });
  addText(slide, title, x, y + 22, w, 34, { size: titleSize, bold: true, color: C.text });
}

function metric(slide, value, caption, x, y, w, h, accent) {
  addTile(slide, `metric-${caption}`, x, y, w, h, "#111111", "#303030");
  addText(slide, value, x + 20, y + 21, w - 40, 48, { size: 44, bold: true });
  addText(slide, caption.toUpperCase(), x + 22, y + h - 43, w - 44, 28, { size: 13, bold: true, color: accent });
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const presentation = Presentation.create({ slideSize: { width: W, height: H } });
  const slide = presentation.slides.add();
  slide.background.fill = C.bg;

  // Soft top glow and header.
  slide.shapes.add({
    geometry: "rect",
    name: "top-glow",
    position: { left: 0, top: 0, width: W, height: 160 },
    fill: { type: "gradient", stops: [
      { color: "#2a130a", offset: 0 },
      { color: "#050505", offset: 100000 },
    ] },
    line: { style: "solid", fill: "none", width: 0 },
  });

  addText(slide, "DIGITAL TWIN", 42, 28, 290, 38, { size: 28, bold: true });
  addText(slide, "Software iterations", 42, 64, 250, 24, { size: 18, color: C.muted });
  addText(slide, "Five iterations. One test-ready twin.", 324, 32, 620, 52, {
    size: 38,
    bold: true,
  });
  addText(slide, "Live sensing, connected control, automated runs, and exportable evidence.", 326, 79, 620, 24, {
    size: 17,
    color: C.soft,
  });

  addTile(slide, "status-pill", 990, 34, 236, 52, "#0d0d0d", "#3a3a3a");
  slide.shapes.add({
    geometry: "ellipse",
    position: { left: 1013, top: 55, width: 10, height: 10 },
    fill: C.orange,
    line: { style: "solid", fill: C.orange, width: 0 },
  });
  addText(slide, "IGNIS GRIPPER", 1034, 47, 160, 20, { size: 15, bold: true });

  // Bento grid.
  const y0 = 126;
  addTile(slide, "current-interface-frame", 42, y0, 520, 372, "#0d0d0d", "#303030");
  slide.images.add({
    blob: await imageBytes(SCREENSHOT),
    contentType: "image/png",
    alt: "Current Digital Twin interface",
    fit: "contain",
    geometry: "roundRect",
    borderRadius: "rounded-3xl",
    position: { left: 42, top: y0, width: 520, height: 372 },
  });
  slide.shapes.add({
    geometry: "roundRect",
    name: "hero-bottom-fade",
    position: { left: 42, top: y0 + 262, width: 520, height: 110 },
    fill: "#00000088",
    line: { style: "solid", fill: "none", width: 0 },
    borderRadius: "rounded-3xl",
  });
  label(slide, "NOW", "Current interface", 76, y0 + 284, 300, C.orange, 24);
  addText(slide, "One dashboard for the gripper, test jig, sensors, and test logs.", 76, y0 + 344, 405, 24, {
    size: 15,
    color: C.soft,
  });

  await addImageTile(slide, "live-mirror", asset("bg-gripper.png"), 582, y0, 304, 174);
  label(slide, "01", "Live mirror", 612, y0 + 104, 200, C.teal, 24);

  await addImageTile(slide, "sensor-intelligence", asset("bg-waveform.png"), 902, y0, 336, 174);
  label(slide, "02", "Live sensing", 932, y0 + 104, 220, C.orange, 24);

  await addImageTile(slide, "production-pcb", asset("bg-pcb.png"), 582, y0 + 190, 304, 148);
  label(slide, "03", "Production PCB", 612, y0 + 190 + 79, 220, C.orange, 23);

  await addImageTile(slide, "connected-control", asset("bg-connectivity.png"), 902, y0 + 190, 158, 148);
  label(slide, "04", "BLE + USB", 922, y0 + 190 + 78, 120, C.blue, 22);

  metric(slide, "2", "devices", 1080, y0 + 190, 158, 148, C.teal);

  await addImageTile(slide, "auto-test", asset("bg-timeline.png"), 42, y0 + 392, 250, 174);
  label(slide, "05", "Test mode", 72, y0 + 392 + 104, 150, C.green, 24);

  await addImageTile(slide, "data-export", asset("bg-data-grid.png"), 308, y0 + 392, 254, 174);
  label(slide, "06", "Excel evidence", 338, y0 + 392 + 104, 190, C.orange, 24);

  await addImageTile(slide, "thermal-safety", asset("bg-thermal.png"), 582, y0 + 354, 304, 212);
  label(slide, "07", "Safety pause", 612, y0 + 354 + 132, 190, C.red, 24);

  addTile(slide, "final-tile", 902, y0 + 354, 336, 212, "#111111", "#303030");
  addText(slide, "Repeatable experiments.", 932, y0 + 392, 260, 82, { size: 32, bold: true });
  addText(slide, "Object. Load. Speed. Runs. Export.", 932, y0 + 506, 248, 42, {
    size: 17,
    color: C.soft,
  });
  slide.shapes.add({
    geometry: "rect",
    position: { left: 932, top: y0 + 560, width: 250, height: 4 },
    fill: { type: "gradient", stops: [
      { color: C.orange, offset: 0 },
      { color: C.green, offset: 60000 },
      { color: C.teal, offset: 100000 },
    ] },
    line: { style: "solid", fill: "none", width: 0 },
  });

  slide.speakerNotes.textFrame.setText(
    "[Sources]\nContent synthesized from the user's Digital Twin project progress in this Codex conversation. The current interface screenshot was captured locally from the running Electron app. Visual bento backgrounds were generated with the built-in image generation tool for this slide, using the user's attached bento references as visual direction. No external web sources were used."
  );

  const png = await presentation.export({ slide, format: "png", scale: 2 });
  await writeBlob(PREVIEW_PNG, png);

  const layout = await slide.export({ format: "layout" });
  await fs.writeFile(path.join(OUT_DIR, "digital-twin-software-iterations-bento.layout.json"), await layout.text(), "utf8");

  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(FINAL_PPTX);

  console.log(JSON.stringify({ FINAL_PPTX, PREVIEW_PNG }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

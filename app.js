import * as pdfjsLib from "./pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./pdf.worker.min.mjs", import.meta.url).href;

const elements = {
  dropZone: document.querySelector("#dropZone"),
  folderButton: document.querySelector("#folderButton"),
  filesButton: document.querySelector("#filesButton"),
  folderInput: document.querySelector("#folderInput"),
  filesInput: document.querySelector("#filesInput"),
  selectionBar: document.querySelector("#selectionBar"),
  selectedCount: document.querySelector("#selectedCount"),
  selectedSize: document.querySelector("#selectedSize"),
  clearButton: document.querySelector("#clearButton"),
  progressPanel: document.querySelector("#progressPanel"),
  progressText: document.querySelector("#progressText"),
  progressPercent: document.querySelector("#progressPercent"),
  progressFill: document.querySelector("#progressFill"),
  currentFile: document.querySelector("#currentFile"),
  resultPanel: document.querySelector("#resultPanel"),
  resultTitle: document.querySelector("#resultTitle"),
  resultMeta: document.querySelector("#resultMeta"),
  resultBadge: document.querySelector("#resultBadge"),
  missingSection: document.querySelector("#missingSection"),
  missingCountLabel: document.querySelector("#missingCountLabel"),
  missingList: document.querySelector("#missingList"),
  copyButton: document.querySelector("#copyButton"),
  csvButton: document.querySelector("#csvButton"),
  warningSection: document.querySelector("#warningSection"),
  warningText: document.querySelector("#warningText"),
};

let currentFiles = [];
let missingFileNames = [];
let latestSummary = null;
let runId = 0;

const isPdf = (file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

function formatBytes(bytes) {
  if (!bytes) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** index);
  return `${value.toLocaleString("vi-VN", { maximumFractionDigits: index ? 1 : 0 })} ${units[index]}`;
}

function uniqueFiles(files) {
  const seen = new Set();
  return [...files].filter((file) => {
    if (!isPdf(file)) return false;
    const key = `${file.webkitRelativePath || file.name}|${file.size}|${file.lastModified}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function lineText(items) {
  const rows = [];
  for (const item of items) {
    const text = String(item.str || "").trim();
    if (!text) continue;
    const x = Number(item.transform?.[4] || 0);
    const y = Number(item.transform?.[5] || 0);
    let row = rows.find((entry) => Math.abs(entry.y - y) <= 2.2);
    if (!row) {
      row = { y, parts: [] };
      rows.push(row);
    }
    row.parts.push({ x, text });
  }
  return rows
    .sort((a, b) => b.y - a.y)
    .map((row) => row.parts.sort((a, b) => a.x - b.x).map((part) => part.text).join(" ").replace(/\s+/g, " ").trim());
}

function inspectLines(lines) {
  const labelPattern = /last\s*[-_]?\s*mile\s+tracking\s*(?:number|no\.?|#)?/i;
  const valuePattern = /[A-Z0-9][A-Z0-9._/-]{4,}/i;
  let labelSeen = false;

  for (const line of lines) {
    const match = labelPattern.exec(line);
    if (!match) continue;
    labelSeen = true;
    const remainder = line.slice(match.index + match[0].length).replace(/^\s*[:：-]?\s*/, "").trim();
    const candidate = remainder.match(valuePattern)?.[0] || "";
    if (candidate && !/^(consignee|delivered|provider|tracking)$/i.test(candidate)) {
      return { state: "present", value: candidate };
    }
  }

  return { state: labelSeen ? "missing" : "not-found" };
}

async function inspectPdf(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjsLib.getDocument({ data, isEvalSupported: false });
  const document = await loadingTask.promise;
  let totalCharacters = 0;
  let sawLabelWithoutValue = false;

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines = lineText(content.items);
      totalCharacters += lines.join(" ").length;
      const result = inspectLines(lines);
      if (result.state === "present") return result;
      if (result.state === "missing") sawLabelWithoutValue = true;
      page.cleanup();
    }
  } finally {
    await document.destroy();
  }

  if (sawLabelWithoutValue) return { state: "missing" };
  if (totalCharacters < 30) return { state: "unreadable" };
  return { state: "missing" };
}

function setProgress(done, total, fileName) {
  const percent = total ? Math.round((done / total) * 100) : 0;
  elements.progressText.textContent = done === total ? "Đã kiểm tra xong" : `Đang kiểm tra ${done + 1}/${total}`;
  elements.progressPercent.textContent = `${percent}%`;
  elements.progressFill.style.width = `${percent}%`;
  elements.currentFile.textContent = done === total ? "" : fileName;
}

function resetResults() {
  elements.resultPanel.hidden = true;
  elements.resultPanel.classList.remove("has-missing");
  elements.missingSection.hidden = true;
  elements.warningSection.hidden = true;
  elements.missingList.replaceChildren();
  missingFileNames = [];
  latestSummary = null;
}

function renderResults(results) {
  const missing = results.filter((item) => item.state === "missing");
  const warnings = results.filter((item) => item.state === "unreadable" || item.state === "error");
  const passed = results.length - missing.length - warnings.length;
  missingFileNames = missing.map((item) => item.name).sort((a, b) => a.localeCompare(b, "vi", { numeric: true }));
  latestSummary = {
    totalFiles: results.length,
    filesWithLastMile: passed,
    missingCount: missing.length,
    missingFileNames: [...missingFileNames],
    manualReviewCount: warnings.length,
    manualReviewFileNames: warnings.map((item) => item.name),
  };

  elements.resultPanel.hidden = false;
  elements.resultPanel.classList.toggle("has-missing", missing.length > 0);
  elements.resultBadge.textContent = String(missing.length);
  elements.resultTitle.textContent = missing.length ? `${missing.length} file bị thiếu Last Mile` : "Không có file bị thiếu Last Mile";
  elements.resultMeta.textContent = `Đã kiểm tra ${results.length} file · ${passed} file có dữ liệu${warnings.length ? ` · ${warnings.length} file cần xem lại` : ""}`;

  if (missing.length) {
    elements.missingSection.hidden = false;
    elements.missingCountLabel.textContent = `${missing.length} file`;
    const fragment = document.createDocumentFragment();
    for (const name of missingFileNames) {
      const item = document.createElement("li");
      item.textContent = name;
      fragment.append(item);
    }
    elements.missingList.append(fragment);
  } else {
    elements.missingSection.hidden = true;
  }

  if (warnings.length) {
    elements.warningSection.hidden = false;
    const unreadableNames = warnings.map((item) => item.name).join(", ");
    elements.warningText.textContent = `${warnings.length} file không đọc được văn bản hoặc bị lỗi: ${unreadableNames}.`;
  }
}

async function processFiles(files) {
  const thisRun = ++runId;
  const results = new Array(files.length);
  let nextIndex = 0;
  let done = 0;
  const workerCount = Math.min(3, files.length);

  elements.progressPanel.hidden = false;
  resetResults();
  setProgress(0, files.length, files[0]?.name || "");

  async function worker() {
    while (nextIndex < files.length && thisRun === runId) {
      const index = nextIndex;
      nextIndex += 1;
      const file = files[index];
      elements.currentFile.textContent = file.webkitRelativePath || file.name;
      try {
        const result = await inspectPdf(file);
        results[index] = { name: file.name, ...result };
      } catch (error) {
        console.warn(`Không thể đọc ${file.name}`, error);
        results[index] = { name: file.name, state: "error" };
      }
      done += 1;
      setProgress(done, files.length, files[Math.min(nextIndex, files.length - 1)]?.name || "");
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  if (thisRun !== runId) return;
  elements.progressPanel.hidden = true;
  renderResults(results);
}

function selectFiles(fileList) {
  const files = uniqueFiles(fileList);
  if (!files.length) return;
  currentFiles = files;
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  elements.selectionBar.hidden = false;
  elements.selectedCount.textContent = `${files.length} file PDF đã chọn`;
  elements.selectedSize.textContent = formatBytes(totalBytes);
  processFiles(files);
}

function clearAll() {
  runId += 1;
  currentFiles = [];
  missingFileNames = [];
  elements.folderInput.value = "";
  elements.filesInput.value = "";
  elements.selectionBar.hidden = true;
  elements.progressPanel.hidden = true;
  resetResults();
}

elements.folderButton.addEventListener("click", (event) => { event.stopPropagation(); elements.folderInput.click(); });
elements.filesButton.addEventListener("click", (event) => { event.stopPropagation(); elements.filesInput.click(); });
elements.folderInput.addEventListener("change", () => selectFiles(elements.folderInput.files));
elements.filesInput.addEventListener("change", () => selectFiles(elements.filesInput.files));
elements.clearButton.addEventListener("click", clearAll);

elements.dropZone.addEventListener("click", (event) => {
  if (event.target.closest("button")) return;
  elements.filesInput.click();
});
elements.dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    elements.filesInput.click();
  }
});

for (const eventName of ["dragenter", "dragover"]) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("is-dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("is-dragging");
  });
}
elements.dropZone.addEventListener("drop", (event) => selectFiles(event.dataTransfer.files));

elements.copyButton.addEventListener("click", async () => {
  if (!missingFileNames.length) return;
  await navigator.clipboard.writeText(missingFileNames.join("\n"));
  const oldLabel = elements.copyButton.textContent;
  elements.copyButton.textContent = "Đã sao chép";
  setTimeout(() => { elements.copyButton.textContent = oldLabel; }, 1600);
});

elements.csvButton.addEventListener("click", () => {
  if (!missingFileNames.length) return;
  const rows = ["Tên file thiếu Last Mile", ...missingFileNames].map((value) => `"${value.replaceAll('"', '""')}"`);
  const blob = new Blob(["\ufeff", rows.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `file-thieu-last-mile-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
});

function registerWebMcpTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  try {
    void Promise.resolve(context.registerTool({
      name: "get_last_mile_check_results",
      title: "Đọc kết quả kiểm tra Last Mile",
      description: "Đọc kết quả đang hiển thị sau khi người dùng đã chọn và kiểm tra các file PDF.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute() {
        if (!latestSummary) {
          return { status: "waiting_for_files", message: "Chưa có kết quả. Người dùng cần chọn các file PDF trước." };
        }
        return { status: "complete", ...latestSummary };
      },
    })).catch((error) => console.warn("Không thể đăng ký công cụ đọc kết quả", error));
  } catch (error) {
    console.warn("Không thể đăng ký công cụ đọc kết quả", error);
  }
}

registerWebMcpTools();
